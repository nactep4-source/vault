import { NextResponse } from 'next/server';

// Direct stream links.
//
// Resolves a TMDB id to the actual playable video file behind one of two
// independent sources. Both speak the same player API, but their catalogs are
// separate — which is the point: a title one of them does not carry is usually
// on the other.
//
//   server 1 (default) — moviesapi.to, upstream "vidora"
//     GET https://moviesapi.to/api/vidora/v1/movie/<tmdb id>
//     GET https://moviesapi.to/api/vidora/v1/tv/<tmdb id>/<season>/<episode>
//
//   server 2 — vidsrc.pm, upstream "scrapify"
//     GET https://vidsrc.pm/api/vidora/v1/movie/<tmdb id>
//     GET https://vidsrc.pm/api/vidora/v1/tv/<tmdb id>/<season>/<episode>
//
// Each needs an `x-player-key` header. That key is a constant baked into the
// site's own player bundle (moviesapi `/assets/index-*.js`, vidsrc.pm
// `/assets/main-*.js`) — re-extract it there if one ever starts answering 401.
//
// The response carries `sources[0].url`, an HLS master playlist. That CDN only
// answers when the request carries its own site's `Referer` (403 without it),
// which a browser on another origin cannot send, so every link is also returned
// through /api/stream/proxy: that proxy re-sends the referer server-side and
// rewrites the playlist so its segments keep working. Give the proxy URL to a
// player (hls.js, Safari's native HLS, …).
//
// `server` picks one explicitly (1 | 2). Without it server 1 is tried first and
// server 2 is used when the first has nothing for the title, so the default
// covers both catalogs.
//
// CORS is open, so an external page/iframe can call this directly.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type StreamSource = {
  id: 1 | 2;
  name: string;
  host: string;
  playerKey: string;
};

const SOURCES: StreamSource[] = [
  {
    id: 1,
    name: 'moviesapi',
    host: 'https://moviesapi.to',
    playerKey: '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13',
  },
  {
    id: 2,
    name: 'vidsrc',
    host: 'https://vidsrc.pm',
    playerKey: 'f3b72e73c80c9a996574379798703796a1936efa3516a7105cb0e43048b46b5a',
  },
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

type PlayerPayload = {
  title?: string;
  sources?: {
    url?: string;
    source?: string;
    tracks?: { label?: string; file?: string }[];
  }[];
  tracks?: { label?: string; file?: string }[];
};

// One resolve attempt against one source. `noStream` distinguishes "this source
// does not carry the title" (safe to fall back to the other one) from "the
// source itself broke" (also worth trying the other one, but reported
// differently when neither works).
async function resolveWithSource(
  source: StreamSource,
  playerPath: string
): Promise<{ payload: PlayerPayload; status: number; noStream: boolean }> {
  const res = await fetch(`${source.host}/api/vidora${playerPath}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: `${source.host}/`,
      Origin: source.host,
      Accept: 'application/json',
      'x-player-key': source.playerKey,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    return { payload: {}, status: res.status, noStream: true };
  }

  const payload = (await res.json().catch(() => null)) as PlayerPayload | null;
  const url = payload?.sources?.[0]?.url;
  return { payload: payload ?? {}, status: url ? 200 : 404, noStream: !url };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tmdb_id = searchParams.get('tmdb_id');
  const type = searchParams.get('type');
  const season = Number(searchParams.get('season') ?? 1);
  const episode = Number(searchParams.get('episode') ?? 1);
  const serverParam = searchParams.get('server');

  if (!tmdb_id || !type || !['movie', 'tv'].includes(type)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Missing or invalid parameters. Required: tmdb_id, type (movie|tv). For TV: season, episode.',
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const playerPath = type === 'tv' ? `/v1/tv/${tmdb_id}/${season}/${episode}` : `/v1/movie/${tmdb_id}`;

  // Proxy links come back relative (they work for anything served from this
  // app). A caller on another origin passes `base=https://its-own-app.example`
  // to get absolute ones — the request itself can't be used for that: behind a
  // dev/preview proxy it carries the server's internal bind address.
  const baseParam = searchParams.get('base');
  let base = '';
  if (baseParam) {
    try {
      const parsed = new URL(baseParam);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        base = parsed.origin;
      }
    } catch {
      base = '';
    }
  }

  const proxiedUrl = (referer: string, url: string) =>
    `${base}/api/stream/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(
      referer
    )}`;

  // An explicit `server` pins one source; without it the second one covers the
  // gaps in the first.
  const pinned = SOURCES.find((source) => String(source.id) === serverParam);
  const candidates = pinned ? [pinned] : SOURCES;

  let chosen: StreamSource | null = null;
  let payload: PlayerPayload = {};
  let lastStatus = 502;

  for (const source of candidates) {
    try {
      const attempt = await resolveWithSource(source, playerPath);
      lastStatus = attempt.status;
      if (!attempt.noStream) {
        chosen = source;
        payload = attempt.payload;
        break;
      }
    } catch (err) {
      console.error(`[Direct Stream] ${source.name} resolve failed:`, err);
      lastStatus = 502;
    }
  }

  if (!chosen) {
    return NextResponse.json(
      {
        success: false,
        error:
          lastStatus === 404
            ? 'No stream available for this title.'
            : 'Could not reach the source.',
      },
      { status: lastStatus === 404 ? 404 : 502, headers: CORS_HEADERS }
    );
  }

  const streamUrl = payload.sources?.[0]?.url as string;
  const referer = `${chosen.host}/`;

  const tracks = (payload.sources?.[0]?.tracks ?? payload.tracks ?? [])
    .filter((track) => track?.file)
    .map((track) => ({
      label: track.label ?? null,
      url: track.file as string,
      proxy: proxiedUrl(referer, track.file as string),
    }));

  return NextResponse.json(
    {
      success: true,
      tmdb_id,
      type,
      title: payload.title ?? null,
      server: chosen.id,
      provider: payload.sources?.[0]?.source ?? chosen.name,
      season: type === 'tv' ? season : undefined,
      episode: type === 'tv' ? episode : undefined,
      stream: {
        url: streamUrl,
        type: streamUrl.includes('.m3u8') ? 'hls' : 'file',
        // The CDN checks this referer; a player on another origin must use
        // `proxy` (or send the header itself, which browsers won't).
        referer,
        proxy: proxiedUrl(referer, streamUrl),
      },
      tracks,
    },
    { status: 200, headers: CORS_HEADERS }
  );
}

import { NextResponse } from 'next/server';
import { resolveVidCore } from '@/lib/server/directSources/vidcore';
import { resolveVidSrc } from '@/lib/server/directSources/vidsrc';
import { rememberStreamHosts } from '@/lib/server/streamProxyHosts';
import type { DirectSourceContext, DirectSourceStream } from '@/lib/server/directSources/types';

// Direct stream links.
//
// Resolves a TMDB id to the actual playable video file behind one of four
// independent sources, so playback happens in our own player instead of a
// third-party embed (and therefore without their ad scripts and popups).
//
//   server 1 (default) — moviesapi.to, upstream "vidora"
//     GET https://moviesapi.to/api/vidora/v1/movie/<tmdb id>
//     GET https://moviesapi.to/api/vidora/v1/tv/<tmdb id>/<season>/<episode>
//
//   server 2 — vidsrc.pm, upstream "scrapify"
//     GET https://vidsrc.pm/api/vidora/v1/movie/<tmdb id>
//     GET https://vidsrc.pm/api/vidora/v1/tv/<tmdb id>/<season>/<episode>
//
//   server 3 — VidCore (vidcore.org)
//   server 4 — VidSrc (vidsrc.sh)
//     Both resolve through their own chain; see src/lib/server/directSources/.
//
// Servers 1 and 2 speak the same player API with a different catalogue each,
// which is the point: a title one of them does not carry is usually on the
// other — so without `server` the first is tried and the second covers its
// gaps. Servers 3 and 4 are opt-in (`server=3|4`): each walks a multi-request
// chain, so folding them into the default path would slow down every play on
// the off chance one of them has the title. They are the tabs to switch to when
// the default pair has nothing, and between them they carry titles neither
// vidora catalogue does (e.g. TV 1402, The Walking Dead).
//
// Each needs an `x-player-key` header for the vidora family. That key is a
// constant baked into the site's own player bundle (moviesapi `/assets/index-*.js`,
// vidsrc.pm `/assets/main-*.js`) — re-extract it there if one ever starts
// answering 401.
//
// The response carries `sources[0].url`, an HLS master playlist. That CDN only
// answers when the request carries its own site's `Referer` (403 without it),
// which a browser on another origin cannot send, so every link is also returned
// through /api/stream/proxy: that proxy re-sends the referer server-side and
// rewrites the playlist so its segments keep working. Give the proxy URL to a
// player (hls.js, Safari's native HLS, …).
//
// `server` picks one explicitly (1 | 2 | 3 | 4).
//
// CORS is open, so an external page/iframe can call this directly.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type VidoraSource = {
  id: 1 | 2;
  name: string;
  host: string;
  playerKey: string;
};

const VIDORA_SOURCES: VidoraSource[] = [
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

type Source = {
  id: 1 | 2 | 3 | 4;
  name: string;
  fallback: boolean;
  resolve: (ctx: DirectSourceContext) => Promise<DirectSourceStream | null>;
};

const SOURCES: Source[] = [
  ...VIDORA_SOURCES.map((source) => ({
    id: source.id,
    name: source.name,
    fallback: true,
    resolve: (ctx: DirectSourceContext) => resolveWithVidora(source, ctx),
  })),
  { id: 3, name: 'vidcore', fallback: false, resolve: resolveVidCore },
  { id: 4, name: 'vidsrc.sh', fallback: false, resolve: resolveVidSrc },
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

// One resolve attempt against one vidora source. A source that answers without
// a stream (`null`) simply does not carry the title — safe to fall back from.
async function resolveWithVidora(
  source: VidoraSource,
  ctx: DirectSourceContext
): Promise<DirectSourceStream | null> {
  const playerPath =
    ctx.type === 'tv'
      ? `/v1/tv/${ctx.tmdbId}/${ctx.season}/${ctx.episode}`
      : `/v1/movie/${ctx.tmdbId}`;

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

  if (!res.ok) return null;

  const payload = (await res.json().catch(() => null)) as PlayerPayload | null;
  const url = payload?.sources?.[0]?.url;
  if (!url) return null;

  return {
    provider: payload?.sources?.[0]?.source ?? source.name,
    title: payload?.title ?? null,
    url,
    referer: `${source.host}/`,
    tracks: payload?.sources?.[0]?.tracks ?? payload?.tracks,
  };
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

  const ctx: DirectSourceContext = {
    type: type as 'movie' | 'tv',
    tmdbId: tmdb_id,
    season,
    episode,
  };

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

  // An explicit `server` pins one source; without it only the sources that
  // carry a fallback are tried (see SOURCES).
  const pinned = SOURCES.find((source) => String(source.id) === serverParam);
  const candidates = pinned ? [pinned] : SOURCES.filter((source) => source.fallback);

  let chosen: Source | null = null;
  let stream: DirectSourceStream | null = null;
  let sourceAnswered = false;

  for (const source of candidates) {
    try {
      const resolved = await source.resolve(ctx);
      if (resolved) {
        chosen = source;
        stream = resolved;
        sourceAnswered = true;
        break;
      }
      // A vidora source that answers 200/404 without a stream proves it is
      // reachable and simply does not carry the title (see the `reason` below).
      sourceAnswered = true;
    } catch (err) {
      console.error(`[Direct Stream] ${source.name} resolve failed:`, err);
    }
  }

  if (!chosen || !stream) {
    // Always answer 404, never a 5xx. A 5xx from this route is swallowed by the
    // preview's own proxy, which substitutes its "Preview starting…" placeholder
    // page for it — the player's `res.json()` then throws on that HTML and
    // reports a bogus network failure ("Could not reach the stream service.")
    // instead of the real reason. `reason` still separates "no source carries
    // the title" from "the source itself did not answer", for callers that care.
    const unreachable = !sourceAnswered;
    return NextResponse.json(
      {
        success: false,
        reason: unreachable ? 'upstream-error' : 'unavailable',
        error: unreachable ? 'Could not reach the source.' : 'No stream available for this title.',
      },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const { url: streamUrl, referer } = stream;
  const tracks = (stream.tracks ?? [])
    .filter((track) => track?.file)
    .map((track) => ({
      label: track.label ?? null,
      url: track.file as string,
      proxy: proxiedUrl(referer, track.file as string),
    }));

  // The proxy only fetches hosts it already knows (a static list plus everything
  // this app has resolved or served) — the link we are about to hand out is one
  // of them.
  rememberStreamHosts([streamUrl, ...tracks.map((track) => track.url)]);

  return NextResponse.json(
    {
      success: true,
      tmdb_id,
      type,
      title: stream.title,
      server: chosen.id,
      provider: stream.provider,
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

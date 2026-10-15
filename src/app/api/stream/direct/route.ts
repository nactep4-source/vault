import { NextResponse } from 'next/server';

// Direct stream links.
//
// Resolves a TMDB id to the actual playable video file behind our default
// source. MoviesAPI serves the VidSpark player, which loads its media from its
// own API:  GET https://moviesapi.to/api/vidora/v1/movie/<tmdb id>
//           GET https://moviesapi.to/api/vidora/v1/tv/<tmdb id>/<season>/<episode>
// with an `x-player-key` header (that key is the `fz` constant baked into
// moviesapi.to's player bundle — re-extract it there if this ever 401s).
// The response carries `sources[0].url` — an HLS master playlist — plus
// subtitle tracks.
//
// That playlist CDN only answers when the request carries
// `Referer: https://moviesapi.to/` (403 without it), so the raw link is
// useless to a browser on another origin. Every link is therefore also
// returned through /api/stream/proxy, which re-sends the referer server-side
// and rewrites the playlist so its segments keep working. Give that proxy URL
// to a player (hls.js, Safari's native HLS, …).
//
// CORS is open, so an external page/iframe can call this directly.

const SOURCE_HOST = 'https://moviesapi.to';
const REFERER = `${SOURCE_HOST}/`;
const PLAYER_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function proxiedUrl(base: string, url: string) {
  return `${base}/api/stream/proxy?url=${encodeURIComponent(
    url
  )}&referer=${encodeURIComponent(REFERER)}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tmdb_id = searchParams.get('tmdb_id');
  const type = searchParams.get('type');
  const season = Number(searchParams.get('season') ?? 1);
  const episode = Number(searchParams.get('episode') ?? 1);

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

  let payload: {
    title?: string;
    sources?: { url?: string; tracks?: { label?: string; file?: string }[] }[];
    tracks?: { label?: string; file?: string }[];
  } | null = null;

  try {
    const res = await fetch(`${SOURCE_HOST}/api/vidora${playerPath}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: REFERER,
        Origin: SOURCE_HOST,
        Accept: 'application/json',
        'x-player-key': PLAYER_KEY,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      // The source answers 404 for a title it does not carry; anything else is
      // its problem, not ours.
      return NextResponse.json(
        {
          success: false,
          error:
            res.status === 404
              ? 'No stream available for this title.'
              : `Source answered ${res.status} for this title.`,
        },
        { status: res.status === 404 ? 404 : 502, headers: CORS_HEADERS }
      );
    }

    payload = await res.json();
  } catch (err) {
    console.error('[Direct Stream] Resolve failed:', err);
    return NextResponse.json(
      { success: false, error: 'Could not reach the source.' },
      { status: 502, headers: CORS_HEADERS }
    );
  }

  const streamUrl = payload?.sources?.[0]?.url;
  if (!streamUrl) {
    return NextResponse.json(
      { success: false, error: 'No stream available for this title.' },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const tracks = (payload?.sources?.[0]?.tracks ?? payload?.tracks ?? [])
    .filter((track) => track?.file)
    .map((track) => ({
      label: track.label ?? null,
      url: track.file as string,
      proxy: proxiedUrl(base, track.file as string),
    }));

  return NextResponse.json(
    {
      success: true,
      tmdb_id,
      type,
      title: payload?.title ?? null,
      season: type === 'tv' ? season : undefined,
      episode: type === 'tv' ? episode : undefined,
      stream: {
        url: streamUrl,
        type: streamUrl.includes('.m3u8') ? 'hls' : 'file',
        // The CDN checks this referer; a player on another origin must use
        // `proxy` (or send the header itself, which browsers won't).
        referer: REFERER,
        proxy: proxiedUrl(base, streamUrl),
      },
      tracks,
    },
    { status: 200, headers: CORS_HEADERS }
  );
}

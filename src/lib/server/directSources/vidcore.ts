import { rememberStreamHosts } from '@/lib/server/streamProxyHosts';
import type { DirectSourceContext, DirectSourceStream } from '@/lib/server/directSources/types';

// VidCore — the player behind vidcore.org (a wrapper page whose body is one
// iframe pointing at `*.edgeone.dev`, where the real player lives).
//
// Its own API (`/backend/servers/<server>?…` on the player origin) answers a
// link list whose every `link` is AES-encrypted with a key baked into the
// player bundle, and the player's same-origin/cookie expectations are what made
// a proxied copy of that player unplayable. None of that is needed here: the
// bundle resolves four of its five servers through a third-party aggregator
// instead —
//
//   GET https://vidrack.created.app/api/sources/<provider>?id=<tmdb>&type=…
//   providers: atlas→videasy, centaurus→vidora, orion→cinextream
//
// — which answers plain JSON with ready HLS links (`sources[]`, each with its
// own `headers`), no key and no encryption. That is what this reads.
//
// The fifth server ("Ursa" / `meow`) has no aggregator provider and is left
// out, as is the "Andromeda" provider (`vidzee`): its links answer 403 to
// anything but the vendor's own proxy front, so a resolve through it would only
// hand the player a link that cannot play.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const AGGREGATOR = 'https://vidrack.created.app/api/sources';
const REFERER = 'https://vidcore.io/';

// Tried in order: the player's own server order, minus the providers above.
// "Videasy" (Atlas) is the player's first server and carries the widest
// catalogue; the other two cover the titles it misses.
const PROVIDERS = ['videasy', 'vidora', 'cinextream'] as const;

type AggregatedSource = {
  url?: string;
  quality?: string;
  label?: string;
  provider?: string;
  headers?: Record<string, string>;
};

export async function resolveVidCore(ctx: DirectSourceContext): Promise<DirectSourceStream | null> {
  const query =
    ctx.type === 'tv'
      ? `id=${ctx.tmdbId}&type=tv&season=${ctx.season}&episode=${ctx.episode}`
      : `id=${ctx.tmdbId}&type=movie`;

  for (const provider of PROVIDERS) {
    let payload: { sources?: AggregatedSource[] } | null = null;
    try {
      const res = await fetch(`${AGGREGATOR}/${provider}?${query}`, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Referer: REFERER,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      payload = (await res.json().catch(() => null)) as { sources?: AggregatedSource[] } | null;
    } catch {
      continue; // this provider did not answer — try the next one
    }

    const best = pickSource(payload?.sources);
    if (!best?.url) continue;

    // The CDN behind these links answers 403 unless the request carries the
    // referer the aggregator lists for it (movy.bz for the paleoak/zenoak
    // shards), and a browser cannot send that header from another origin — so
    // the link goes back through /api/stream/proxy, which can.
    const referer = best.headers?.Referer || REFERER;
    rememberStreamHosts([best.url]);

    return {
      provider: best.label || best.provider || `vidcore:${provider}`,
      title: null,
      url: best.url,
      referer,
    };
  }

  return null;
}

// The player's own ranking, reproduced: a shard it knows to be dead
// (`cheaptruckrepairs.cc`, which answers 502) sorts last, then the highest
// resolution wins, and the "Miami" shard (zenoak.top) is the last resort.
function pickSource(sources: AggregatedSource[] | undefined): AggregatedSource | null {
  const rank = (source: AggregatedSource) => {
    const match = /(\d{3,4})\s*p/i.exec(source.quality ?? '');
    const quality = match ? Number(match[1]) : 0;
    const label = (source.label ?? '').toLowerCase();
    return {
      penalised: source.url?.includes('cheaptruckrepairs.cc') ? 0 : 1,
      // 1080p outranks everything below it but is not outranked by a 4K label.
      resolution: quality === 1080 ? 3000 : quality,
      lastResort: label.includes('miami') || source.url?.includes('zenoak.top') ? 0 : 1,
    };
  };

  return (
    (sources ?? [])
      .filter((source) => !!source.url)
      .map((source) => ({ source, ...rank(source) }))
      .sort(
        (a, b) =>
          a.penalised - b.penalised ||
          b.resolution - a.resolution ||
          a.lastResort - b.lastResort
      )[0]?.source ?? null
  );
}

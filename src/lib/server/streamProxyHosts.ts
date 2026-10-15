// Extra hosts that /api/stream/proxy is allowed to fetch.
//
// The proxy carries a static allowlist for the hosts behind its long-standing
// sources (moviesapi.to / vidsrc.pm). The sources added later rotate their media
// across freshly minted domains — `paleoak.top`, `zenoak.top`, `ultramoss.top`,
// `comityofcognomen.site`, `resonanceofruin.space`, … — and publish segment
// paths with no media extension at all (`/r6/s/<base64>`,
// `/content/<hex>/<hex>/page-0.html`), so neither a fixed list nor a URL-shape
// rule can recognise them.
//
// So a host becomes fetchable the moment *we* learn about it, and only that way:
//
//   - a resolver registers the host of the stream it just handed out (the very
//     link the player is about to request);
//   - the proxy registers every host it meets while rewriting a playlist it is
//     already serving — those lines are that playlist's own segments, i.e. the
//     next URLs the player will ask for.
//
// Nothing a caller sends can widen this: the client only ever passes back URLs
// this app handed it. Deliberately in-memory and bounded — these links are
// short-lived (minutes to hours) and the grant dies with the process.
const MAX_HOSTS = 300;

const hosts = new Set<string>();

export function rememberStreamHosts(urls: (string | null | undefined)[]): void {
  for (const url of urls) {
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue; // not an absolute URL — nothing to remember
    }
    if (hosts.has(host)) continue;
    // FIFO eviction: the oldest grants are the ones least likely to still be
    // requested, and this keeps a long-running process from growing forever.
    if (hosts.size >= MAX_HOSTS) {
      const oldest = hosts.values().next().value;
      if (oldest) hosts.delete(oldest);
    }
    hosts.add(host);
  }
}

export function isRememberedStreamHost(hostname: string): boolean {
  return hosts.has(hostname);
}

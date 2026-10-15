import { NextResponse } from 'next/server';
import { isRememberedStreamHost, rememberStreamHosts } from '@/lib/server/streamProxyHosts';

// Upstream budgets — see the fetch below for why they are split this way.
// Measured on `bx.netrocdn.site`: headers after 3.3 s, body then arrives over
// ~48 s with silences of 12 s and 33 s in the middle, so the idle budget has to
// clear that stall or a working playlist gets cut off.
const FIRST_BYTE_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 60000;

// A stalled shard is transient — the same host served the same playlist in
// 1.2 s seconds after stalling past the idle budget — so one retry turns the
// old "upstream stalled mid-body" 502 into a slow-but-working response. Kept
// at two attempts so a genuinely dead shard still fails fast.
const MAX_ATTEMPTS = 2;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const referer = searchParams.get('referer') ?? 'https://vidsrc.net/';

  if (!url) {
    return new NextResponse('Missing url parameter', { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return new NextResponse('Invalid URL', { status: 400 });
  }

  const allowedDomains = [
    'vidsrc.net',
    'vidsrc.me',
    'vidsrc.xyz',
    'vidsrc.in',
    'vidsrc.io',
    'whisperingauroras.com',
    'vidplay.online',
    'vidplay.site',
  ];

  // Hosts behind /api/stream/direct: they serve playlists and segments under
  // disguised paths (`…/cdn/<base64>.js`, `…/file2/<base64>==`) with no media
  // extension, so the extension rule below can't catch them. `hd4u.sbs` is the
  // second source's (vidsrc.pm) front: `/proxy?url=…` for the playlist and
  // `/segment?url=…` for each part, both referer-locked to vidsrc.pm.
  const streamHosts = [
    'netrocdn.site',
    'kurututujohn.workers.dev',
    'vidspark.to',
    'hd4u.sbs',
  ];

  // The VidCore/VidSrc sources rotate their media hosts per resolve and publish
  // segment paths with no extension, so they can't be listed here — a host
  // becomes fetchable once this app has resolved or served it (see
  // streamProxyHosts.ts). Everything else still has to match the rules below.
  const domainAllowed =
    isRememberedStreamHost(parsedUrl.hostname) ||
    streamHosts.some(
      (d) => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d)
    ) ||
    allowedDomains.some(
      (d) => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d)
    ) ||
    parsedUrl.pathname.endsWith('.m3u8') ||
    parsedUrl.pathname.endsWith('.ts') ||
    parsedUrl.pathname.endsWith('.vtt') ||
    parsedUrl.pathname.endsWith('.srt') ||
    ['m3u8', 'ts', 'vtt', 'srt', 'key'].includes(
      parsedUrl.pathname.split('.').pop()?.toLowerCase() ?? ''
    );

  if (!domainAllowed) {
    return new NextResponse('Domain not allowed', { status: 403 });
  }

  // The second source wraps every media URL in its own front
  // (`p1.hd4u.sbs/proxy?url=…&data=…`, `p1.hd4u.sbs/segment?url=…&data=…`), and
  // that front intermittently answers `503 Service Temporarily Unavailable`
  // while the CDN it points at is fine — so talk to the real host instead. The
  // access grant is only needed by that front; the CDN hands the same bytes to
  // a plain request.
  let fetchUrl = url;
  try {
    if (/(^|\.)hd4u\.sbs$/.test(parsedUrl.hostname)) {
      const inner = parsedUrl.searchParams.get('url');
      if (inner) fetchUrl = inner;
    }
  } catch {
    /* the outer URL was already validated above */
  }

  // One complete upstream attempt. Resolves to the response the player gets,
  // and *throws* only when the upstream itself failed (fetch error, timeout,
  // mid-body stall) — which is exactly what the retry loop below catches. An
  // upstream HTTP status is a real answer, not a throw, so it is passed through.
  const serveOnce = async (): Promise<NextResponse> => {
    // The CDN drip-feeds its responses: headers usually land within a second,
    // but the body can crawl — a large VOD playlist (150–350 KB) has taken
    // ~45 s to drain here, and shards that are throttled go slower still. A
    // whole-transfer timeout therefore aborted perfectly good downloads
    // ("TimeoutError: The operation was aborted due to timeout", 502 to the
    // player). Bound the time to *first byte* instead, and let `readChunk`
    // below cut loose an upstream that genuinely stops sending mid-body.
    const abortController = new AbortController();
    const firstByteTimer = setTimeout(
      () => abortController.abort(new Error('upstream timed out before first byte')),
      FIRST_BYTE_TIMEOUT_MS
    );

    const res = await fetch(fetchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: abortController.signal,
    }).finally(() => clearTimeout(firstByteTimer));

    if (!res.ok) {
      return new NextResponse(`Upstream error: ${res.status}`, { status: res.status });
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';

    // Playlist or media has to be decided from the body: the CDN hides media
    // extensions behind base64 paths (`…/cdn/<base64>.js`, `…/file2/<base64>==`),
    // so neither the URL nor the content type is reliable. Read the first chunk
    // to check the `#EXTM3U` signature, then either buffer the (small) playlist
    // or stream the segment straight through — buffering every ~1 MB segment
    // here delayed playback and was what hit the timeout above.
    const reader = res.body?.getReader();

    // Reads the next chunk, giving up only when the upstream stays silent for
    // IDLE_TIMEOUT_MS: a slow-but-progressing body is fine, a stalled one is
    // not — and aborting also tears down the upstream request behind `source`.
    const readChunk = async (
      source: ReadableStreamDefaultReader<Uint8Array>
    ): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          source.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              abortController.abort(new Error('upstream stalled mid-body'));
              reject(new Error('upstream stalled mid-body'));
            }, IDLE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    let head: Uint8Array = new Uint8Array(0);
    if (reader) {
      const first = await readChunk(reader);
      head = first.value ?? new Uint8Array(0);
    }

    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl') ||
      /\.m3u8(\?|$)/.test(url) ||
      new TextDecoder().decode(head.slice(0, 7)) === '#EXTM3U';

    if (isPlaylist) {
      const chunks: Uint8Array[] = head.length ? [head] : [];
      if (reader) {
        for (;;) {
          const { done, value } = await readChunk(reader);
          if (done) break;
          if (value) chunks.push(value);
        }
      }
      let text = new TextDecoder().decode(Buffer.concat(chunks));
      // Every link rewritten below is a segment of this playlist, i.e. a URL the
      // player is about to ask this proxy for. Remembering those hosts is what
      // lets a playlist point at a shard we had never seen (VidCore's zenoak
      // playlists live on `moon.zenoak.top` but their segments sit on
      // `ultramoss.top`).
      const segments: string[] = [];
      const toProxy = (target: string) => {
        segments.push(target);
        return `/api/stream/proxy?url=${encodeURIComponent(target)}&referer=${encodeURIComponent(
          referer
        )}`;
      };
      // Resolve against the playlist URL the way a player would: the second
      // source's parts are root-relative (`/segment?url=…`) and carry their
      // access grant in the query, so joining naively would produce `//segment`
      // and lose it.
      const absolute = (target: string) => {
        try {
          return new URL(target, fetchUrl).toString();
        } catch {
          return target;
        }
      };

      // Playlists come in more than one shape: some CDNs hide the media
      // extension (`…/cdn/<base64>.js`, `…/file2/<base64>==`), so rewrite every
      // non-tag line rather than only .ts/.m3u8/.key ones…
      text = text.replace(/^(?!#)(\S+)$/gm, (line) => toProxy(absolute(line)));
      // …and the URIs carried inside tags (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA).
      text = text.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${toProxy(absolute(uri))}"`);
      rememberStreamHosts(segments);

      return new NextResponse(text, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }

    // Media (segments, keys): pass the bytes through as they arrive, starting
    // with the chunk already read for the signature check. Nothing is retried
    // from here on — these bytes are already on their way to the player.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head.length) controller.enqueue(head);
        if (!reader) {
          controller.close();
          return;
        }
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await readChunk(reader);
              if (done) break;
              if (value) controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        })();
      },
      cancel() {
        void reader?.cancel().catch(() => {});
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  };

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await serveOnce();
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        // Warn, not error: this attempt is expected to happen on these shards
        // and the retry below usually succeeds, so it is not a failed request.
        console.warn(
          '[Stream Proxy] upstream attempt failed, retrying:',
          err instanceof Error ? err.message : String(err),
          fetchUrl
        );
      }
    }
  } catch (err) {
    // An aborted fetch rejects with a DOMException whose printed form is a huge
    // table of error-code constants (it filled the logs); the message is enough.
    console.error(
      '[Stream Proxy] Error:',
      err instanceof Error ? err.message : String(err),
      fetchUrl
    );
    return new NextResponse('Proxy error', { status: 502 });
  }
}

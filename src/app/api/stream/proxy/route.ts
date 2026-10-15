import { NextResponse } from 'next/server';

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
  // extension, so the extension rule below can't catch them.
  const streamHosts = ['netrocdn.site', 'kurututujohn.workers.dev', 'vidspark.to'];

  const domainAllowed =
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

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // The media host rotates and occasionally answers slowly; 15 s was tight
      // enough that a late segment aborted mid-download ("TimeoutError: The
      // operation was aborted due to timeout") and broke playback. Segments are
      // streamed below, so this only bounds the whole transfer, not the
      // time-to-first-byte.
      signal: AbortSignal.timeout(30000),
    });

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
    let head = new Uint8Array(0);
    if (reader) {
      const first = await reader.read();
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
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      }
      let text = new TextDecoder().decode(Buffer.concat(chunks));
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const toProxy = (target: string) =>
        `/api/stream/proxy?url=${encodeURIComponent(target)}&referer=${encodeURIComponent(
          referer
        )}`;
      const absolute = (target: string) =>
        target.startsWith('http') ? target : baseUrl + target;

      // Playlists come in more than one shape: some CDNs hide the media
      // extension (`…/cdn/<base64>.js`, `…/file2/<base64>==`), so rewrite every
      // non-tag line rather than only .ts/.m3u8/.key ones…
      text = text.replace(/^(?!#)(\S+)$/gm, (line) => toProxy(absolute(line)));
      // …and the URIs carried inside tags (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA).
      text = text.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${toProxy(absolute(uri))}"`);

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
    // with the chunk already read for the signature check.
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
              const { done, value } = await reader.read();
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
  } catch (err) {
    console.error('[Stream Proxy] Error:', err);
    return new NextResponse('Proxy error', { status: 502 });
  }
}

import { NextResponse } from 'next/server';
import {
  guardScript,
  isAllowedHost,
  proxyNestedFrames,
  stripAdScripts,
} from '@/lib/server/embedSanitizer';

// "Clean mode" embed proxy.
// Fetches an embed page server-side, strips ad scripts, injects the popup /
// redirect guard, then serves it. It also routes the embed's own player frame
// back through this proxy (proxyNestedFrames): VidCore.org serves a thin
// wrapper that loads its real player page from a rotating player/CDN host, and
// the ad payload lives in *that* page, so sanitizing the wrapper alone is not
// enough.
//
// SECURITY: the response is served with a CSP `sandbox` header WITHOUT
// allow-same-origin, so third-party code runs in an opaque origin and can
// never touch this site's cookies / localStorage / Supabase session.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');
  if (!target) return new NextResponse('Missing url', { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new NextResponse('Invalid url', { status: 400 });
  }
  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    return new NextResponse('Host not allowed', { status: 403 });
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': request.headers.get('user-agent') ?? 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': request.headers.get('accept-language') ?? 'en-US,en;q=0.9',
        Referer: new URL(request.url).origin + '/',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    // Don't follow redirects blindly — only allow redirects to allowed hosts.
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (loc) {
        const next = new URL(loc, parsed);
        if (isAllowedHost(next.hostname)) {
          return NextResponse.redirect(
            new URL(`/api/embed?url=${encodeURIComponent(next.toString())}`, request.url)
          );
        }
      }
      return new NextResponse('Blocked redirect', { status: 403 });
    }

    const ct = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !ct.includes('text/html')) {
      return new NextResponse('Upstream not HTML', { status: 502 });
    }

    let html = await upstream.text();

    html = stripAdScripts(html, parsed.hostname.toLowerCase());
    html = proxyNestedFrames(html);

    // <base> so relative assets still load from the embed's origin, plus guard.
    const inject = `<base href="${parsed.origin}/">` + guardScript(parsed.origin);
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + inject)
      : inject + html;

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          'sandbox allow-scripts allow-forms allow-presentation',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (err) {
    console.error('[Embed proxy] Error:', err);
    return new NextResponse('Proxy error', { status: 502 });
  }
}

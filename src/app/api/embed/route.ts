import { NextResponse } from 'next/server';

// "Clean mode" embed proxy.
// Fetches an embed page server-side, strips known ad scripts, injects a guard
// script (blocks window.open, cross-site link clicks and — in browsers that
// support the Navigation API — script-driven redirects), then serves it.
//
// Some sources (vidcore.org) only serve a wrapper page whose whole body is an
// <iframe> to the real player, and the ad code lives on that inner page — so a
// wrapper is followed into and the player page itself gets cleaned.
//
// SECURITY: the response is served with a CSP `sandbox` header WITHOUT
// allow-same-origin, so third-party code runs in an opaque origin and can
// never touch this site's cookies / localStorage / Supabase session.

const ALLOWED_HOSTS = ['moviesapi.to', 'vidcore.org', 'vidcore.net', 'vidsrc.sh'];

// Hosts a wrapper page may point at — the actual player behind it.
const PLAYER_HOSTS = ['edgeone.dev'];

const AD_HOSTS = [
  'exoclick.com', 'exosrv.com', 'trafficjunky.net', 'adnxs.com',
  'doubleclick.net', 'googlesyndication.com', 'popads.net', 'popcash.net',
  'propellerads.com', 'hilltopads.net', 'adsterra.com', 'juicyads.com',
  'plugrush.com', 'revcontent.com', 'outbrain.com', 'taboola.com', 'mgid.com',
  'zedo.com', 'clickadu.com', 'adcash.com', 'adskeeper.co.uk',
  'bidvertiser.com', 'yllix.com', 'popunder.net', 'pop.cash',
  'popuptraffic.com', 'clkmon.com', 'clkrev.com', 'go2speed.org',
];

// Ad loaders served from the player's OWN origin, so a host match can't catch
// them — this is the popup/overlay SDK vidcore's players ship
// (/tc/ff-tag.php + /tc/ff-prime.php).
const AD_PATHS = ['/tc/ff-', 'ff-tag.php', 'ff-prime.php', 'popunder'];

// Wrapper hops (wrapper -> player -> ...) we follow before serving what we have.
const MAX_HOPS = 4;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AD_PATTERN = [...AD_HOSTS, ...AD_PATHS].map(escapeRegExp).join('|');

function isAllowedHost(host: string) {
  host = host.toLowerCase();
  return [...ALLOWED_HOSTS, ...PLAYER_HOSTS].some((d) => host === d || host.endsWith('.' + d));
}

// A followed wrapper target, i.e. the real player page rather than the embed
// site's own page.
function isPlayerHost(host: string) {
  host = host.toLowerCase();
  return PLAYER_HOSTS.some((d) => host === d || host.endsWith('.' + d));
}

// The player is a Next.js app that resolves its own asset URLs from the document
// URL, and our `<base>` (which exists so its root-relative assets reach its
// origin instead of ours) makes it crash into its own "This page couldn't load"
// error page. So a followed player page gets its root-relative URLs rewritten
// here, plus the runtime shim below, and no <base> at all.
function absolutize(html: string, origin: string) {
  return html.replace(
    /\b(src|href|poster|action)=(["'])\/(?!\/)/gi,
    (_match, attr: string, quote: string) => `${attr}=${quote}${origin}/`
  );
}

// Bootstrap for a followed player page, in place of a <base>:
// - root-relative fetch/XHR URLs go to the player's origin, not ours;
// - clean mode serves the page in an opaque origin (the iframe `sandbox` has no
//   allow-same-origin), where touching storage throws. Storage is not usable
//   there, so the player gets an in-memory fallback instead of a SecurityError
//   that would take its whole app down.
function playerBootstrap(origin: string) {
  return `<script>(function(){
var B=${JSON.stringify(origin)};
function fx(u){return typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'?B+u:u;}
try{if(window.fetch){var f=window.fetch;window.fetch=function(i,o){try{if(typeof i==='string')i=fx(i);}catch(e){}return f.call(this,i,o);};}}catch(e){}
try{var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){try{arguments[1]=fx(arguments[1]);}catch(e){}return x.apply(this,arguments);};}catch(e){}
try{window.localStorage.getItem('x');}catch(e){
  try{
    function mk(){var m={};return{
      getItem:function(k){return k in m?m[k]:null;},
      setItem:function(k,v){m[k]=String(v);},
      removeItem:function(k){delete m[k];},
      clear:function(){m={};},
      key:function(i){var ks=Object.keys(m);return i<ks.length?ks[i]:null;},
      get length(){return Object.keys(m).length;}
    };}
    Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});
    Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true});
  }catch(e2){}
}
})();</script>`;
}

// Player pages served through this proxy live in an opaque origin (see the
// sandbox CSP below). Their own scripts/assets are marked `crossorigin`, which
// from an opaque origin turns into a CORS request (Origin: null) that their
// CDN doesn't answer — the player app then never boots. Dropping the attribute
// makes those subresources load as ordinary no-CORS requests.
function stripCrossOrigin(html: string) {
  return html.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
}

function stripAdScripts(html: string) {
  const script = new RegExp(
    `<script\\b[^>]*\\bsrc=["'][^"']*(?:${AD_PATTERN})[^"']*["'][^>]*>\\s*</script>`,
    'gi'
  );
  const preload = new RegExp(
    `<link\\b[^>]*\\bhref=["'][^"']*(?:${AD_PATTERN})[^"']*["'][^>]*>`,
    'gi'
  );
  return html.replace(script, '').replace(preload, '');
}

// A "wrapper" is a document that does nothing but frame the real player: no
// scripts of its own, exactly one iframe, pointing at a known player host.
function wrapperTarget(html: string, base: URL): URL | null {
  if (/<script\b/i.test(html)) return null;
  const srcs = Array.from(html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi), (m) => m[1]);
  if (srcs.length !== 1) return null;
  try {
    const target = new URL(srcs[0], base);
    if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) return null;
    return target;
  } catch {
    return null;
  }
}

function guardScript(allowedOrigin: string) {
  return `<script>(function(){
var ALLOWED=${JSON.stringify(allowedOrigin)};
try{window.open=function(){return null;};}catch(e){}
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('a[href]');
  if(!a)return;
  try{var u=new URL(a.href,location.href);
    if(u.origin!==ALLOWED&&(a.target==='_blank'||a.target==='_top'||a.target==='_parent')){
      e.preventDefault();e.stopImmediatePropagation();}
  }catch(_){
  }
},true);
try{if(window.navigation&&navigation.addEventListener){
  navigation.addEventListener('navigate',function(e){
    try{var u=new URL(e.destination.url);
      if(e.cancelable&&u.origin!==ALLOWED&&u.protocol.indexOf('http')===0&&u.origin!==location.origin){e.preventDefault();}
    }catch(_){
    }
  });
}}catch(_){
}
})();</script>`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');
  if (!target) return new NextResponse('Missing url', { status: 400 });

  let current: URL;
  try {
    current = new URL(target);
  } catch {
    return new NextResponse('Invalid url', { status: 400 });
  }
  if (current.protocol !== 'https:' || !isAllowedHost(current.hostname)) {
    return new NextResponse('Host not allowed', { status: 403 });
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let upstream: Response;
    try {
      upstream = await fetch(current.toString(), {
        headers: {
          'User-Agent': request.headers.get('user-agent') ?? 'Mozilla/5.0',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': request.headers.get('accept-language') ?? 'en-US,en;q=0.9',
          Referer: new URL(request.url).origin + '/',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      console.error('[Embed proxy] Error:', err);
      return new NextResponse('Proxy error', { status: 502 });
    }

    // Follow redirects ourselves, only to allowed hosts.
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      let next: URL | null = null;
      try {
        next = loc ? new URL(loc, current) : null;
      } catch {
        next = null;
      }
      if (!next || next.protocol !== 'https:' || !isAllowedHost(next.hostname)) {
        return new NextResponse('Blocked redirect', { status: 403 });
      }
      current = next;
      continue;
    }

    const ct = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !ct.includes('text/html')) {
      return new NextResponse('Upstream not HTML', { status: 502 });
    }

    const html = stripCrossOrigin(stripAdScripts(await upstream.text()));

    // Bare wrapper around the real player: clean the player page instead.
    const inner = hop < MAX_HOPS - 1 ? wrapperTarget(html, current) : null;
    if (inner) {
      current = inner;
      continue;
    }

    // Relative assets must load from the embed's origin, not ours. A followed
    // player page gets URL rewriting plus a runtime shim instead of a <base>,
    // which its Next.js router cannot survive (see playerBootstrap).
    const playerPage = isPlayerHost(current.hostname);
    const inject = playerPage
      ? playerBootstrap(current.origin) + guardScript(current.origin)
      : `<base href="${current.origin}/">` + guardScript(current.origin);
    const withUrls = playerPage ? absolutize(html, current.origin) : html;
    const served = /<head[^>]*>/i.test(withUrls)
      ? withUrls.replace(/<head[^>]*>/i, (m) => m + inject)
      : inject + withUrls;

    return new NextResponse(served, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          'sandbox allow-scripts allow-forms allow-presentation',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  return new NextResponse('Too many redirects', { status: 508 });
}

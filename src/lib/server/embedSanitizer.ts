// Sanitizing helpers for the /api/embed "clean mode" proxy.
//
// These third-party embeds run in an opaque-origin sandboxed frame, so a
// client-side hook can never see inside them: whatever they pull from their own
// player page (a casino popup on every click, an anti-devtools redirect) has to
// be removed from the HTML we serve.
//
// IMPORTANT: the /api/embed route must NOT add `allow-same-origin` to its CSP
// sandbox when serving pages built from these helpers, or third-party code
// would run same-origin with this app.

/** Embeds this proxy is allowed to fetch. */
export const ALLOWED_HOSTS = [
  'moviesapi.to',
  'vidcore.org',
  'vidcore.net',
  'vidcore.io',
  'vidsrc.sh',
];

/** Hosts an allowed embed may pull its *player* frame from. */
export const PLAYER_HOSTS = ['edgeone.dev'];

const AD_HOSTS = [
  'exoclick.com', 'exosrv.com', 'trafficjunky.net', 'adnxs.com',
  'doubleclick.net', 'googlesyndication.com', 'popads.net', 'popcash.net',
  'propellerads.com', 'hilltopads.net', 'adsterra.com', 'juicyads.com',
  'plugrush.com', 'revcontent.com', 'outbrain.com', 'taboola.com', 'mgid.com',
  'zedo.com', 'clickadu.com', 'adcash.com', 'adskeeper.co.uk',
  'bidvertiser.com', 'yllix.com', 'popunder.net', 'pop.cash',
  'popuptraffic.com', 'clkmon.com', 'clkrev.com', 'go2speed.org',
];

// Payload signatures observed in these players, neither of which references a
// host from AD_HOSTS: VidCore's anti-devtools redirect (it navigates the frame
// to an ad page whenever it believes DevTools are open — which misfires
// whenever the player is small) and its click-popup casino script.
const AD_SCRIPT_SIGNATURES = [/blockDevTools/i, /checkDebugger/i, /casino/i, /\?open=register/i];

function sameHost(host: string, domain: string) {
  return host === domain || host.endsWith('.' + domain);
}

export function isAllowedHost(host: string) {
  host = host.toLowerCase();
  return ALLOWED_HOSTS.some((d) => sameHost(host, d)) || PLAYER_HOSTS.some((d) => sameHost(host, d));
}

function isAdUrl(url: string) {
  try {
    const host = new URL(url, 'https://localhost').hostname.toLowerCase();
    return AD_HOSTS.some((d) => sameHost(host, d));
  } catch {
    return false;
  }
}

// A script that opens a window to a host that is neither the page's own site
// nor a known player host is an ad popup (VidCore's casino script is exactly
// that: window.open on every click, pointing at an unrelated casino domain).
function opensForeignWindow(body: string, pageHost: string) {
  if (!/window\.open\s*\(/.test(body)) return false;
  const urls = body.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  return urls.some((raw) => {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return !sameHost(host, pageHost) && !isAllowedHost(host);
    } catch {
      return false;
    }
  });
}

/** Drops ad scripts (external and inline) from a fetched embed page. */
export function stripAdScripts(html: string, pageHost: string) {
  return html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (match: string, attrs: string, body: string) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (src) return isAdUrl(src) ? '' : match;
      if (!body) return match;
      if (AD_SCRIPT_SIGNATURES.some((re) => re.test(body))) return '';
      return opensForeignWindow(body, pageHost) ? '' : match;
    }
  );
}

/** Blocks window.open, cross-site link clicks and script-driven redirects. */
export function guardScript(allowedOrigin: string) {
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

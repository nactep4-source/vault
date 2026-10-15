import { rememberStreamHosts } from '@/lib/server/streamProxyHosts';
import type { DirectSourceContext, DirectSourceStream } from '@/lib/server/directSources/types';

// VidSrc (vidsrc.sh) — the player family that refuses to run inside any sandbox
// and whose ad redirects therefore could not be blocked while it was embedded.
// Resolving its stream instead makes it play in our own player, ads included
// nowhere.
//
// The chain is the player's own, walked server-side in one request:
//
//   1. GET  https://vidsrc.sh/vs_src.php?type=movie|tv&id=<tmdb>[&season=&episode=]
//            → {"src": "https://<rotating host>/embed/movie/<id>?vs=<token>"}
//   2. GET  that src page → its inline CONFIG carries `playerUrl`, the real
//            player on the same host.
//   3. GET  the player page → CONFIG carries a **single-use** `apiToken`.
//   4. GET  https://data.vidsrc.sh/api.php?…&stream_urls&api_token=<token>
//            → `data.stream_urls`: either the URL list, or (when the vendor has
//            protection on) one ChaCha20 string that the response's own
//            WebAssembly blob (`vs.wasm_url`) decrypts back into that list.
//   5. GET  <stream host>/generate.php → a per-host, IP-bound access token,
//            appended to the playlist URL as `?token=…`. The variant and
//            segment URLs inside the playlist carry their own grants already.
//
// Both the resolve (here) and the playback (/api/stream/proxy) run from this
// server, so the IP the token is bound to is the IP that plays it.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SRC_ENDPOINT = 'https://vidsrc.sh/vs_src.php';
const API_ENDPOINT = 'https://data.vidsrc.sh/api.php';
const SITE_REFERER = 'https://vidsrc.sh/';

async function get(url: string, referer: string, accept = 'text/html,application/xhtml+xml'): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: referer,
        // Step 1 only answers this endpoint for an XHR-shaped request.
        'X-Requested-With': 'XMLHttpRequest',
        Accept: accept,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function resolveVidSrc(ctx: DirectSourceContext): Promise<DirectSourceStream | null> {
  const media =
    ctx.type === 'tv'
      ? `type=tv&tmdb=${ctx.tmdbId}&season=${ctx.season}&episode=${ctx.episode}`
      : `type=movie&tmdb=${ctx.tmdbId}`;
  const lookup =
    ctx.type === 'tv'
      ? `type=tv&id=${ctx.tmdbId}&season=${ctx.season}&episode=${ctx.episode}`
      : `type=movie&id=${ctx.tmdbId}`;

  // 1. The player URL for this title.
  const lookupBody = await get(`${SRC_ENDPOINT}?${lookup}`, SITE_REFERER, 'application/json');
  let src: string | undefined;
  try {
    src = lookupBody ? (JSON.parse(lookupBody) as { src?: string }).src : undefined;
  } catch {
    src = undefined;
  }
  if (!src) return null;

  // 2. The wrapper page that names the real player, on the same rotating host.
  const embedHtml = await get(src, SITE_REFERER);
  const playerPath = embedHtml?.match(/"playerUrl":"([^"]+)"/)?.[1];
  if (!playerPath) return null;
  const playerUrl = new URL(playerPath.replace(/\\u0026/g, '&'), src).toString();

  // 3. The single-use API token minted with the player page.
  const playerHtml = await get(playerUrl, src);
  const apiToken = playerHtml?.match(/"apiToken":"([^"]+)"/)?.[1];
  if (!apiToken) return null;

  // 4. The stream list, decrypted when the vendor wraps it.
  let payload: {
    status_code?: string;
    data?: { title?: string; stream_urls?: string | string[] };
    vs?: { w?: number; wasm_url?: string; wasm?: string };
  } | null = null;
  try {
    const res = await fetch(`${API_ENDPOINT}?${media}&stream_urls&api_token=${encodeURIComponent(apiToken)}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: playerUrl,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    });
    payload = res.ok ? ((await res.json().catch(() => null)) as typeof payload) : null;
  } catch {
    return null;
  }

  if (payload?.status_code !== '200') return null;
  const urls = await readStreamUrls(payload.data?.stream_urls, payload.vs, playerUrl);
  if (!urls.length) return null;

  // 5. The playlist's own access grant, minted for this server's IP.
  const streamUrl = urls[0];
  const streamOrigin = new URL(streamUrl).origin;
  const token = (await get(`${streamOrigin}/generate.php`, playerUrl, 'text/plain'))?.trim().replace(/^"|"$/g, '');

  rememberStreamHosts([streamUrl]);
  return {
    provider: 'vidsrc.sh',
    title: payload.data?.title ?? null,
    url: token ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : streamUrl,
    referer: playerUrl,
  };
}

// `stream_urls` is an array on a plain response, or — with the vendor's
// protection on — one base64 ChaCha20 string that only the response's own
// WebAssembly chunk can turn back into it. The blob is small (a bump allocator
// over the ciphertext: `alloc`, `decrypt`, output at `ptr + 12`), so it is
// compiled and run inline instead of shipping a copy of the vendor's wasm.
async function readStreamUrls(
  streamUrls: string | string[] | undefined,
  vs: { wasm_url?: string; wasm?: string } | undefined,
  referer: string
): Promise<string[]> {
  if (Array.isArray(streamUrls)) return streamUrls.filter(Boolean);
  if (typeof streamUrls !== 'string' || !vs) return [];

  const bytes = vs.wasm_url ? await fetchWasm(vs.wasm_url, referer) : vs.wasm ? base64ToArrayBuffer(vs.wasm) : null;
  if (!bytes) return [];

  try {
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      alloc: (length: number) => number;
      decrypt: (pointer: number, length: number) => number;
    };
    const ciphertext = Buffer.from(streamUrls, 'base64');
    const pointer = exports.alloc(ciphertext.length);
    new Uint8Array(exports.memory.buffer, pointer, ciphertext.length).set(ciphertext);
    const length = exports.decrypt(pointer, ciphertext.length);
    const plain = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, pointer + 12, length));
    return plain.split('\n').filter(Boolean);
  } catch (err) {
    console.error('[VidSrc] stream list could not be decrypted:', err instanceof Error ? err.message : err);
    return [];
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, 'base64');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function fetchWasm(url: string, referer: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Referer: referer } });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

# Base44 sandbox notes

This repository runs in the Base44 sandbox through `docker-compose.base44.yml`
(Next.js 15 dev server on host port 3000, source bind-mounted, live reload).

```bash
docker compose -f docker-compose.base44.yml up -d --build
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login   # 200
```

## Non-obvious setup facts

- **No local database or infrastructure.** There is no Postgres/Redis to run. Supabase is a
  *hosted, external* service, so `supabase/migrations/*.sql` never run in the sandbox — they are
  applied against a real Supabase project (via the Supabase CLI/dashboard) only when you point the
  app at one.
- **The app boots with zero credentials and still works.** Two intentional fallbacks make this so:
  - `src/lib/services/tmdbService.ts` has a built-in TMDB API key, so catalog data (home, /movies,
    /series, /search) renders without `NEXT_PUBLIC_TMDB_API_KEY`.
  - `src/lib/supabase/client.tsx` returns a localStorage-backed mock client when
    `NEXT_PUBLIC_SUPABASE_URL`/key are empty. Auth therefore "works" with any email/password and
    lists/history persist in the browser rather than in Postgres. This is expected, not a bug — real
    accounts and cross-device sync need a hosted Supabase project.
- `src/middleware.ts` redirects signed-out visitors to `/login`; the browser-side `AuthGate` does the
  same on the client. `/login` is the cheapest health endpoint (it is public and renders a 200).
- **First hit to a route is slow** (webpack compiles it, e.g. ~1s for `/movies`) — do not read a slow
  first response as a failure.
- Dependencies are installed on container startup (`npm ci`) from the repo's own `package-lock.json`
  into a named volume, so `package.json`/lockfile changes only need a container restart
  (`docker compose -f docker-compose.base44.yml restart web`), not an image rebuild.
- Environment: placeholders live in the committed `.env.base44-defaults`; real values are delivered by
  the platform to `/run/base44/app.env`, which compose lists **after** the defaults so it wins. Never
  put user-supplied credentials in the repo.
- The dev server is reachable through the preview proxy because `next dev` binds `0.0.0.0`
  (`npm run dev`) and Next 15.1 does not gate dev assets by origin. If `next` is ever upgraded to a
  version that supports `allowedDevOrigins`, that option must be extended for the preview origin.
- `WATCHPACK_POLLING=true` is set in compose because bind mounts do not always deliver inotify events;
  hot reload depends on it.

## Third-party players and ad blocking

- `/api/embed` is the "Clean mode" proxy: it fetches an embed page server-side, strips ad
  scripts, injects a popup/redirect guard, and serves it under a CSP `sandbox` (no
  `allow-same-origin`, no `allow-popups`).
- **vidcore.org serves a bare wrapper page** whose whole body is one `<iframe>` pointing at
  `*.edgeone.dev`, where the real player (and its ads) live. The proxy detects that shape
  (no `<script>` + exactly one allowed iframe) and follows into it, cleaning the player page
  itself. Add new wrapper targets to `PLAYER_HOSTS` in the route.
- **The vidcore player ships a popup/overlay ad SDK** as `<script src="/tc/ff-tag.php">` plus
  `<script src="/tc/ff-prime.php">`. They come from the player's *own* origin, so they can
  only be matched by path (`AD_PATHS`), not by host. No JS chunk injects them — they are
  plain script tags in the player HTML, so stripping the tags is enough.
- **Clean mode breaks this player**, which is why no source sets `cleanByDefault`: through the
  proxy the player area stays empty (its Next.js app never boots — likely because the proxied
  document lives in an opaque origin), while the direct embed plays fine (poster, controls,
  duration). Popups therefore stay blocked by the iframe `sandbox` attribute ("Popup blocker"
  on the media page) and a viewer can opt into clean mode manually. The proxy's strip of
  `crossorigin` attributes targets exactly that boot failure but is not proven to fix it.
- Ad *popup windows* and redirects are blocked by that iframe `sandbox` — the embeds are
  cross-origin, so page-level hooks (window.open, click handlers) can never see inside them.
  Ads rendered *inside* the player frame cannot be removed without proxying.
- **The VidSrc family can be neither sandboxed nor proxied, so its ad redirects are NOT
  blockable** — it is therefore marked `sandbox: false` in the media page (it plays
  unprotected; the "Popup blocker" toggle has no effect on it). Verified in the preview:
  `vidsrc.sh`'s own `/assets/sbx.js` refuses ANY sandboxed frame — `allow-popups`,
  `allow-top-navigation-by-user-activation`, an opaque-origin sandbox and a *nested*
  sandboxed same-origin wrapper all still end on its "This content can't be embedded in a
  sandboxed frame" page — and so do mirrors (vidsrc.to → vsembed.ru, vidsrc.me, vidsrc.su).
  Proxying a copy is no alternative either: the real player
  (`stellarconductornexus.com/embed/movie/<id>?vs=…`, URL resolved by
  `vidsrc.sh/vs_src.php?type=movie&id=<tmdb id>`) is **referrer-locked** and answers
  `403 "Expired"` to any referrer other than `vidsrc.sh`, and its flow includes a Cloudflare
  Turnstile. The player only renders when it is the direct, unsandboxed child of our page.

- **Direct stream links (moviesapi)** — `GET /api/stream/direct?tmdb_id=…&type=movie|tv[&season=&episode=]`
  resolves the real video file behind the default source. moviesapi.to serves the VidSpark player, whose
  media comes from `https://moviesapi.to/api/vidora/v1/movie/<tmdb id>` (or `/v1/tv/<id>/<season>/<episode>`)
  with an `x-player-key` header; the key is the `fz` constant baked into that site's player bundle
  (`/assets/index-*.js`) if it ever needs re-extracting. The returned `.m3u8` sits on a rotating CDN host
  (`*.netrocdn.site`, `*.workers.dev`, …) that **403s without `Referer: https://moviesapi.to/`**, so the
  route also returns the same link through `/api/stream/proxy`, which re-sends that referer and rewrites
  playlist lines. Links are time-limited (~12 h). Verified: resolves + plays through the proxy for a movie
  and for a TV episode.
  - **There are two sources, and `server=1|2` pins one.** Server 1 (default) is moviesapi.to; server 2 is
    vidsrc.pm, the same player API with its own key (`/assets/main-*.js` in that site's bundle), for titles
    server 1 does not carry. Without `server`, server 1 is tried first and server 2 is the fallback, and the
    response says which one answered (`server`, `provider`, `referer`). Server 2's media URLs are wrapped in
    its own front (`p1.hd4u.sbs/proxy?url=…`, `…/segment?url=…`) that intermittently answers 503 while the
    CDN behind it is healthy, so the proxy unwraps `hd4u.sbs` to the `url=` it carries. The media page
    exposes both as its "Direct" and "Server 2" tabs (both `own: true`, i.e. our player, `server=2` on the
    embed URL for the second). **Server 2 was temporarily unreachable on 2026-10-15** — every call to
    `vidsrc.pm/api/vidora/v1/...` answered `502` while its plain site pages still answered 200. It recovered
    later that day: `server=2` resolves "Fight Club" (provider `scrapify`) and its proxy playlist (284 KB)
    plus a 442 KB segment both answer 200, and it carries series server 1 does not (94605, 82856, 94997,
    71446, 63174, …). Titles in *neither* catalogue still fail with "Could not reach the source." — TV 65733
    and 76479; **TV 1402 (The Walking Dead) is only *partly* carried**: moviesapi has no episode link for it
    at all (`404 "No Vidora link found for this episode"`, view_id 21748) and vidsrc.pm's backend answers
    `502 "error code: 502"` for its early seasons, but season 11 resolves (`tv/1402/11/24` → 200). So the
    show plays on the *Server 2* tab for the episodes that backend still serves and nowhere in the vidora
    family for the others — moviesapi.to's own site fails S1E1 the same way, so it is the upstream
    catalogue, not our code.
  - **Never answer a 5xx from `/api/stream/direct` (or any route a browser parses as JSON) — the preview
    proxy swaps 5xx responses for its own page.** The route used to return `502` when no source produced a
    stream; through the preview that comes back as the platform's "Preview starting…" placeholder **HTML**,
    so `DirectStreamPlayer`'s `res.json()` threw and it showed "Could not reach the stream service." — a
    false network error that hid the real reason (the exact 2026-10-15 "The Walking Dead won't play"
    report). Verified by `curl` against `https://3000-$BASE44_PUBLIC_HOST_SUFFIX/api/stream/direct…`: 200,
    400 and 404 pass through untouched, 502 does not. Both failure modes now answer
    `404 {"success":false,"reason":"unavailable"|"upstream-error","error":…}`.
  - **Upstream refusals that are NOT our code (state as of 2026-10-15).** Shards rotate per resolve, and
    most were unhealthy while testing: `bx.netrocdn.site` served `.m3u8` but redirected **every media
    request** (`/file2/<base64>`) to `https://www.cloudflare-terms-of-service-abuse.com/stream.mp4` (a
    Cloudflare abuse-mitigation page, so no video bytes at all), and throttled playlists to ~3.5 KB/s;
    `north-man.kurututujohn.workers.dev` answered empty; `p1.hd4u.sbs` (server 2's CDN) returned nothing.
    Playback of titles on those shards fails regardless of the proxy — re-test a title before treating a
    playback failure as ours. Re-checked later on 2026-10-15: `bx.netrocdn.site` now answers a media request
    with a **12 275-byte `ftypisom` placeholder mp4** (byte-identical for movie 550 and TV 1399) instead of
    the requested segment, while TV 66732's segment came back as 424 KB of real TS — so one title can look
    "resolved but unplayable" entirely upstream of the proxy.
  - **`/api/stream/proxy` streams media instead of buffering it.** It reads one chunk to tell a playlist
    from media by the `#EXTM3U` signature (necessary: that CDN hides extensions behind base64 paths like
    `…/cdn/<base64>.js`), buffers playlists for rewriting, and passes segments/keys through byte-for-byte.
    **Its upstream budget is split in two** — `FIRST_BYTE_TIMEOUT_MS` (20 s) bounds the wait for response
    headers, `IDLE_TIMEOUT_MS` (60 s) bounds silence *between* body chunks (`readChunk`). One end-to-end
    timeout is wrong for this CDN: measured on `bx.netrocdn.site`, headers arrived after 3.3 s and a 178 KB
    VOD playlist then drained over ~48 s with silences of 12 s and 33 s in the middle, so any whole-transfer
    budget killed working playlists (`TimeoutError: The operation was aborted due to timeout` in the web
    logs, 502 to the player). An aborted fetch also used to log its whole DOMException error-code table —
    the catch now logs the message and URL only. Verified after the change: that same slow playlist returns
    200 with `#EXT-X-ENDLIST` (48 s, nothing logged); master + variant playlists still rewrite to
    `/api/stream/proxy` links; and a 1.9 MB segment proxied from a public HLS test stream
    (`test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`) is **byte-identical (md5) to the origin's own bytes**.
    Note a playlist that slow also outlasts hls.js's own defaults (10 s to first byte, 20 s per load), which
    is why the bundled player raises its load budgets — see the player bullet below. Measured TTFB through the
    proxy on 2026-10-15: series 66732's variant playlist 15.6 s, movie 550's 81 s, series 60625's 0.7 s.
  - **Ready-made player page: `/embed/[type]/[id]`** (`?season=&episode=` for TV) — a chrome-free page
    that calls `/api/stream/direct` itself and plays `stream.proxy` with the bundled `hls.js`, so this app
    can be iframed from anywhere instead of a third-party player. It is **deliberately public**: it is
    listed in `PUBLIC_PATHS` in both `src/components/AuthGate.tsx` and
    `src/utils/supabase/middleware.ts`, and `Navigation` renders nothing under `/embed`. Without those
    three, a session-less embed gets redirected to `/login` and disappears inside the iframe. No `base=`
    needed — the player and `/api/stream/proxy` share an origin. Verified in the preview: `/embed/movie/1148365`
    resolves, attaches and plays without a session.
  - **The player is `src/components/DirectStreamPlayer.tsx`**, shared by that route and by the media page's
    `Direct` source tab (first entry in `EMBED_SOURCES`, so "Watch now" plays it by default). `own: true`
    on that entry makes the media page mount the component instead of an iframe, hides the "Clean
    mode"/"Popup blocker" toggles (they only mean something for a third-party embed), and keeps
    `/api/embed` — an HTML-stripping proxy for other people's pages — off our own route. A failed
    resolve/playback calls `onError`, so the existing "Try next source" banner offers the embeds.
    Verified in the preview on `/media/movie/1148365`: Direct active, `readyState 4`, playing and
    advancing, 150 s buffered, no iframe rendered, both toggles hidden, no console errors; switching to
    `MoviesAPI` still renders its embed with both toggles back. The TV page's own path through this
    player was not automatically verified (the preview navigate helper did not switch routes in that
    session), but the TV resolve it depends on is: `?tmdb_id=1399&type=tv&season=1&episode=1` returns
    `success: true` for "Game of Thrones" and its proxy playlist answers 200.
  - **The player raises hls.js's load budgets (2026-10-15).** `DirectStreamPlayer.tsx` passes `HLS_CONFIG`
    to `new Hls(...)`: manifests and playlists get 90 s to first byte / 150 s total, fragments 30 s / 150 s,
    with retries. Reason: hls.js's own playlist defaults (10 s / 20 s) are shorter than the proxy's own
    tolerance, so a throttled shard made playback fail client-side ("Playback failed — this title may no
    longer be available") *after* the proxy had delivered the playlist correctly — the "series don't play"
    report. Series playlists are the big ones (15.6 s measured vs 0.7 s for another series and 81 s for a
    movie, same day), which is why it looked like a series-only bug. `/api/stream/direct` also says
    "Could not reach the source." for titles in neither catalogue (TV 1402/65733/76479), which is a separate,
    upstream limit — "Try next source" is the way out for those.
  - **Don't size a full-bleed route with `fixed inset-0`.** Every route is wrapped in `.page-enter`
    (`src/app/template.tsx`), whose animation leaves a `transform` on that wrapper
    (`animation-fill-mode: forwards`), and a transformed ancestor becomes the containing block for
    `position: fixed` descendants. The embed page's content is out of flow, so the wrapper measured
    **0px tall** and `inset-0` resolved to a 0-height box — the player loaded and played but rendered
    invisibly (black). It uses an in-flow `h-dvh` instead (`-mb-20 md:mb-0` cancels the mobile padding
    the root layout puts on `<main>`). Verified: inside a 640×360 iframe the player is 632×356,
    `readyState 4`, native controls show the real duration, and no app nav renders in the frame.

## Optional external integrations

- Streamtape downloads: `STREAMTAPE_LOGIN` + `STREAMTAPE_KEY`, and the mapping endpoints additionally
  need a hosted Supabase (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`).
  Without those, `GET /api/streamtape/mappings` answers `200 {success: true, mapping: null,
  configured: false}` (never a 500) so the download button on the media page just renders disabled,
  and `POST`/`GET /api/streamtape/download` answer `503 "… is not configured."` — expected, not a bug.
- `MIXDROP_*` appears in the old `.env.example` but is not referenced anywhere in `src/`.

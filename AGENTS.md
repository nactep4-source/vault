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

## Optional external integrations

- Streamtape downloads: `STREAMTAPE_LOGIN` + `STREAMTAPE_KEY`, and the mapping endpoints additionally
  need a hosted Supabase (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`).
  Without those, `GET /api/streamtape/mappings` answers `200 {success: true, mapping: null,
  configured: false}` (never a 500) so the download button on the media page just renders disabled,
  and `POST`/`GET /api/streamtape/download` answer `503 "… is not configured."` — expected, not a bug.
- `MIXDROP_*` appears in the old `.env.example` but is not referenced anywhere in `src/`.

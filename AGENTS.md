# Working in this repo (Base44 sandbox notes)

## Run it

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

- Web entry point: `http://localhost:3000` (preview proxy maps host port 3000).
- **Next.js 15.1.11 dev server from the cloned source** (`npm run dev`, `distDir=.next-dev`).
  There is no live-reload problem: edits to files under `src/` recompile automatically.
- `node_modules` lives in the named volume `node_modules`, not in the working tree. The
  container installs from `package-lock.json` (`npm ci`) on start whenever the lockfile hash
  changes, so editing `package.json`/`package-lock.json` and restarting the service is enough.
- `WATCHPACK_POLLING=true` is set because the source is bind-mounted.

## No database is required to boot

`src/lib/supabase/client.tsx` falls back to a built-in local-storage client (mock auth +
mock table storage) when `NEXT_PUBLIC_SUPABASE_URL`/key are unset. That is the mode the
sandbox runs in:

- Any email/password signs in through `/login`; favourites, watchlist and history persist in
  the browser's localStorage, not in Postgres.
- `src/utils/supabase/{client,server,middleware}.ts` have **no** such fallback; they only
  matter for the middleware session check (which passes through when no credentials are set)
  and the stray `/todos` demo page.
- `supabase/migrations/*.sql` are only relevant if you point the app at a real project.

## Optional external credentials

Delivered by the platform to `/run/base44/app.env` (already wired as the service's `env_file`).
They are truly optional — the app boots and renders without them:

| Feature | Variables |
| --- | --- |
| Real Supabase project (auth + lists persisted server-side) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), `SUPABASE_SERVICE_ROLE_KEY` |
| Streamtape download endpoints (`/api/streamtape/*`) | `STREAMTAPE_LOGIN`, `STREAMTAPE_KEY`, `STREAMTAPE_ADMIN_TOKEN` |
| TMDB catalogue | `NEXT_PUBLIC_TMDB_API_KEY` — optional, the app ships a working fallback key in `tmdbService.ts` and the page components |

If you set real Supabase credentials, an admin token (`STREAMTAPE_ADMIN_TOKEN`) is required
before `/api/streamtape/mappings` accepts writes.

While they are unset, `/api/streamtape/mappings` answers `503` with
`{"success":false,"error":"Supabase service role is not configured."}` (and `/api/streamtape/download`
answers `503` too) instead of failing with a 500 plus a stack trace — the media pages render a
disabled download button in that state. The client only enables the download button when the app is
wired to a Supabase project that has the `streamtape_files` table (`supabase/migrations/20260930120000_*.sql`).

## How to verify it works

1. `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login` → `200`.
2. In the preview, sign in with any email/password (fallback auth).
3. The home page pulls live data from `api.themoviedb.org`; posters/backdrops come from
   `image.tmdb.org` (both are in `next.config.mjs`'s image allowlist).

## Quirks

- Next 15.1.11 has no `allowedDevOrigins` option or cross-origin dev-request check, so no
  host/origin overrides were needed for the preview proxy. `next.config.mjs` is untouched.
- `next dev` writes to `.next-dev` (gitignored); a production build would use `.next`.
- `tsconfig.tsbuildinfo` and two `*.zip` archives sit in the repo root — harmless leftovers.
- The **VidCore** player source always loads through `/api/embed` (its own player page opens a
  casino popup on every click and redirects the frame to an ad page). The sanitizing rules live in
  `src/lib/server/embedSanitizer.ts`, and the proxy also re-points VidCore's nested player frame at
  itself. On `localhost` that upstream host answers with its own "404: NOT_FOUND" page for both the
  proxied and the direct embed, so VidCore cannot be seen playing in the sandbox — that comes from
  the third-party host, not from the proxy.

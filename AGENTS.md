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

## Optional external integrations

- Streamtape downloads: `STREAMTAPE_LOGIN` + `STREAMTAPE_KEY`, and the mapping endpoints additionally
  need a hosted Supabase (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`).
- `MIXDROP_*` appears in the old `.env.example` but is not referenced anywhere in `src/`.

<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/9418e0e4-8f42-4f6f-9569-3aecbba3bb08

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Streamtape Downloads

Add the Streamtape API credentials to `.env.local` (server-only variables):

```env
STREAMTAPE_LOGIN=your-api-login
STREAMTAPE_KEY=your-api-key
STREAMTAPE_ADMIN_TOKEN=long-random-admin-token
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

Request a download link with a Streamtape file ID:

```text
/api/streamtape/download?file=STREAMTAPE_FILE_ID
```

The endpoint requests the download ticket, waits for the provider's required delay, and returns the final download URL. Streamtape file IDs must be mapped to your media records separately; they are not TMDB IDs.

Once a mapping exists, downloads can use the media identity directly:

```text
/api/streamtape/download?tmdb_id=550&type=movie
```

For TV, add `season` and `episode`. A direct `file=STREAMTAPE_FILE_ID` request is also supported.

Create a verified mapping for a movie:

```bash
curl -X POST https://your-app.example/api/streamtape/mappings \
   -H "Authorization: Bearer $STREAMTAPE_ADMIN_TOKEN" \
   -H "Content-Type: application/json" \
   -d '{"tmdb_id":"550","type":"movie","file":"wg8ad12d3QiJRXG"}'
```

For a TV episode, include `season` and `episode`. Look up a mapping with `/api/streamtape/mappings?tmdb_id=550&type=movie`, or verify up to 100 provider files with `/api/streamtape/info?file=FILE_ID_1,FILE_ID_2`.

## Direct Stream Links

`GET /api/stream/direct` resolves a TMDB id to the actual playable video file
(HLS) behind the default source, plus its subtitle tracks, so your own player or
iframe can use it instead of embedding a third-party player:

```text
/api/stream/direct?tmdb_id=550&type=movie
/api/stream/direct?tmdb_id=1399&type=tv&season=1&episode=1
/api/stream/direct?tmdb_id=550&type=movie&base=https://your-app.example
```

```json
{
  "success": true,
  "title": "Fight Club",
  "stream": {
    "url": "https://…/master.m3u8",
    "type": "hls",
    "referer": "https://moviesapi.to/",
    "proxy": "/api/stream/proxy?url=…"
  },
  "tracks": [{ "label": "English", "url": "https://…/eng.vtt", "proxy": "/api/stream/proxy?url=…" }]
}
```

`proxy` links are relative so they work from anything served by this app. A
player on **another origin** should send `base=https://your-app.example` — the
links then come back absolute, pointing at that app — or join the relative path
with the app's own URL itself.

Give your player `stream.proxy` (and each `tracks[].proxy`), not `stream.url`:
the media CDN only answers requests that carry `Referer: https://moviesapi.to/`,
which a browser on another origin will not send. The proxy adds that referer
server-side and rewrites the playlist so its segments keep working through it.
`stream.url` plus `referer` is for server-side use only.

The response allows cross-origin reads (`Access-Control-Allow-Origin: *`), and
links are time-limited — resolve them per playback, don't store them.

### Ready-made player (iframe)

If you'd rather not write a player, this app serves one:

```text
/embed/movie/550
/embed/tv/1399?season=1&episode=1
```

It resolves the stream itself and plays it with hls.js — no third-party embed,
no ad scripts — so it can be iframed from anywhere:

```html
<iframe
  src="https://your-app.example/embed/movie/550"
  allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
  allowfullscreen
  style="width:100%;aspect-ratio:16/9;border:0"
></iframe>
```

The page is public (no login) on purpose, since an embed on another site has no
session here. Its `/api/stream/proxy` links are relative, so the player and the
proxy share one origin — no CORS, no `base=` needed.

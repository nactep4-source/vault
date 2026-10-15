'use client';

import React, { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import DirectStreamPlayer from '@/components/DirectStreamPlayer';

// ── Embeddable player page ───────────────────────────────────────────────────
//
// A chrome-free, public page that plays the stream resolved by
// GET /api/stream/direct, so this app can be dropped into anyone's iframe
// instead of a third-party player:
//
//   <iframe src="https://your-app.example/embed/movie/550"
//           allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
//           allowfullscreen
//           style="width:100%;aspect-ratio:16/9;border:0"></iframe>
//
// TV: /embed/tv/1399?season=1&episode=1
//
// The player itself lives in src/components/DirectStreamPlayer.tsx, shared with
// the media page's "Direct" source tab.
//
// This route is public on purpose (see PUBLIC_PATHS in AuthGate and the
// Supabase session middleware) — an embed on someone else's site has no session.

function EmbedPlayer() {
  const params = useParams();
  const searchParams = useSearchParams();

  const rawType = params?.type;
  const rawId = params?.id;
  const mediaType = ((Array.isArray(rawType) ? rawType[0] : rawType) || 'movie') as
    | 'movie'
    | 'tv';
  const mediaId = (Array.isArray(rawId) ? rawId[0] : rawId) || '';
  const season = searchParams?.get('season') ?? '1';
  const episode = searchParams?.get('episode') ?? '1';

  // NOT `fixed inset-0`: every route is wrapped in `.page-enter`
  // (src/app/template.tsx), whose animation leaves a `transform` on the wrapper
  // — and a transformed ancestor becomes the containing block for fixed
  // descendants. The player would then be out of flow inside a wrapper that
  // measured 0px tall and render invisibly. An in-flow viewport height is
  // immune to that; `-mb-20 md:mb-0` cancels the mobile bottom-nav padding the
  // root layout puts on `<main>`.
  return (
    <div className="relative h-dvh w-full -mb-20 md:mb-0 bg-black">
      <DirectStreamPlayer
        mediaType={mediaType}
        mediaId={mediaId}
        season={season}
        episode={episode}
      />
    </div>
  );
}

export default function EmbedPlayerPage() {
  return (
    <Suspense fallback={<div className="h-dvh w-full bg-black" />}>
      <EmbedPlayer />
    </Suspense>
  );
}

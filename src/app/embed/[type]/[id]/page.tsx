'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Hls from 'hls.js';

// ── Embeddable player for the direct-stream API ───────────────────────────────
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
// The resolved playlist only plays through /api/stream/proxy (the media CDN
// requires a Referer the browser cannot send), and that proxy link is relative,
// which is exactly what we want here: the player page and the proxy share an
// origin, so no CORS or absolute-URL handling is involved.
//
// hls.js is imported from the app's own dependencies (no CDN): the playlist is
// HLS, which only Safari can play natively.
//
// This route is public on purpose (see PUBLIC_PATHS in AuthGate and the
// Supabase session middleware) — an embed on someone else's site has no session.

type StreamInfo = {
  url: string;
  type: string;
  referer: string;
  proxy: string;
};

type DirectStreamResponse = {
  success: boolean;
  error?: string;
  title?: string | null;
  stream?: StreamInfo;
};

function EmbedPlayer() {
  const params = useParams();
  const searchParams = useSearchParams();

  const rawType = params?.type;
  const rawId = params?.id;
  const mediaType = ((Array.isArray(rawType) ? rawType[0] : rawType) || 'movie') as
    | 'movie'
    | 'tv';
  const mediaId = (Array.isArray(rawId) ? rawId[0] : rawId) || '';
  const season = searchParams?.get('season') ?? '';
  const episode = searchParams?.get('episode') ?? '';

  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 1. Resolve the playable link for this title.
  useEffect(() => {
    if (!mediaId || !['movie', 'tv'].includes(mediaType)) {
      setError('Invalid embed URL — use /embed/movie/<tmdb id> or /embed/tv/<tmdb id>.');
      return;
    }

    let cancelled = false;
    setStream(null);
    setError(null);

    const query = new URLSearchParams({ tmdb_id: mediaId, type: mediaType });
    if (mediaType === 'tv') {
      query.set('season', season || '1');
      query.set('episode', episode || '1');
    }

    fetch(`/api/stream/direct?${query.toString()}`)
      .then(async (res) => (await res.json()) as DirectStreamResponse)
      .then((body) => {
        if (cancelled) return;
        if (!body.success || !body.stream) {
          setError(body.error || 'No stream available for this title.');
          return;
        }
        setTitle(body.title ?? null);
        setStream(body.stream);
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach the stream service.');
      });

    return () => {
      cancelled = true;
    };
  }, [mediaId, mediaType, season, episode]);

  // 2. Play it. hls.js where supported, native HLS (Safari) otherwise.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(stream.proxy);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError('Playback failed — this title may no longer be available.');
        }
      });
      return () => hls.destroy();
    }

    video.src = stream.proxy;
  }, [stream]);

  // NOT `fixed inset-0`: every route is wrapped in `.page-enter`
  // (src/app/template.tsx), whose animation leaves a `transform` on the wrapper
  // — and a transformed ancestor becomes the containing block for fixed
  // descendants. Since this page's content is out of flow, that ancestor
  // measured 0px tall and the player rendered 0px high (invisible). An in-flow
  // viewport height is immune to that; `-mb-20 md:mb-0` cancels the mobile
  // bottom-nav padding the root layout puts on `<main>`.
  return (
    <div className="relative h-dvh w-full -mb-20 md:mb-0 bg-black">
      <video
        ref={videoRef}
        className="w-full h-full bg-black"
        controls
        autoPlay
        playsInline
        title={title ? `${title} — player` : 'Stream player'}
      />

      {!stream && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-void">
          <div className="w-8 h-8 rounded-full border-2 border-t-transparent border-violet animate-spin" />
          <p className="text-[11px] text-muted font-medium tracking-wider uppercase">
            Loading stream…
          </p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-void px-6 text-center">
          <p className="font-display text-sm font-semibold text-foreground">
            {title ?? 'Playback unavailable'}
          </p>
          <p className="text-xs text-muted max-w-sm">{error}</p>
        </div>
      )}
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

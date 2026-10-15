'use client';

import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

// ── Our own player for the direct-stream API ─────────────────────────────────
//
// Plays what GET /api/stream/direct resolves for a TMDB id: the real HLS file
// behind one of our two sources, handed back through /api/stream/proxy because
// those CDNs only answer requests carrying the source's own referer — a header
// a browser cannot send. No third-party embed, so no injected ad scripts and no
// popups. `server` pins a source (see the media page's "Server 2" tab); without
// it the route uses whichever source carries the title.
//
// Used in two places: the public /embed/[type]/[id] page (iframe that from
// anywhere) and the media page's "Direct" source tab. The proxy link is
// relative and both the player and the proxy are served from this origin, so
// there is no CORS or absolute-URL handling involved.
//
// hls.js comes from the app's own dependencies (no CDN): the playlist is HLS,
// which only Safari plays natively.

export type DirectStreamInfo = {
  url: string;
  type: string;
  referer: string;
  proxy: string;
};

type DirectStreamResponse = {
  success: boolean;
  error?: string;
  title?: string | null;
  stream?: DirectStreamInfo;
};

type DirectStreamPlayerProps = {
  mediaType: 'movie' | 'tv';
  mediaId: string;
  season?: number | string;
  episode?: number | string;
  // Which of /api/stream/direct's sources to pin (1 = moviesapi, 2 = vidsrc.pm).
  // Omitted = the route's default, i.e. the first source with a fallback to the
  // second for titles it does not carry.
  server?: number;
  // Resolving or playing failed — the media page uses this to surface its
  // "try another source" banner instead of having to read this component's state.
  onError?: () => void;
  className?: string;
};

export default function DirectStreamPlayer({
  mediaType,
  mediaId,
  season = 1,
  episode = 1,
  server,
  onError,
  className = 'w-full h-full bg-black',
}: DirectStreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<DirectStreamInfo | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 1. Resolve the playable link for this title.
  useEffect(() => {
    if (!mediaId || !['movie', 'tv'].includes(mediaType)) {
      setError('Nothing to play — a movie or TV id is required.');
      return;
    }

    let cancelled = false;
    setStream(null);
    setError(null);

    const query = new URLSearchParams({ tmdb_id: mediaId, type: mediaType });
    if (mediaType === 'tv') {
      query.set('season', String(season || 1));
      query.set('episode', String(episode || 1));
    }
    if (server) query.set('server', String(server));

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
  }, [mediaId, mediaType, season, episode, server]);

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

  useEffect(() => {
    if (error) onError?.();
  }, [error, onError]);

  // In flow, never `fixed inset-0`: the host decides the box (the embed page
  // gives it h-dvh, the media page its 16:9 container), and a `fixed` child
  // would collapse to 0px inside the transformed `.page-enter` wrapper.
  return (
    <div className={`relative ${className}`}>
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

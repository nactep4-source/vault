'use client';

import React, { useEffect, useRef, useState } from 'react';
import Hls, { type HlsConfig } from 'hls.js';

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

// Load budgets for hls.js.
//
// /api/stream/proxy can only answer a playlist once it has drained it from the
// CDN (it has to rewrite the segment links), and these shards drip-feed: a
// *series* playlist is a big multi-variant list and has taken 15–26 s to come
// through, where a movie's smaller one drains in about a second. hls.js's
// defaults allow a playlist only 10 s to the first byte and 20 s in total, so
// slow ones were aborted client-side — "Playback failed" on series while movies
// played. These match what the proxy itself tolerates (20 s to first byte, 60 s
// between body chunks).
// The proxy answers a playlist only once it has drained it, so the first byte
// *is* the whole drain: measured through it, a series variant playlist took
// 15.6 s and a movie's reached 81 s on a badly throttled shard — both past
// hls.js's own defaults for playlists (10 s to first byte, 20 s in total), which
// is what aborted series that the proxy had delivered fine. These ceilings are
// upper bounds, not waits: playback starts the moment the playlist lands. A dead
// shard still fails quickly — the proxy itself gives up after 20 s without
// headers or 60 s between body chunks.
const PLAYLIST_LOAD_POLICY = {
  maxTimeToFirstByteMs: 90000,
  maxLoadTimeMs: 150000,
  timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
  errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
};

// Segments start flowing as soon as the proxy has read one chunk, so only a
// genuinely stuck shard delays their first byte.
const FRAGMENT_LOAD_POLICY = {
  maxTimeToFirstByteMs: 30000,
  maxLoadTimeMs: 150000,
  timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
  errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
};

const HLS_CONFIG: Partial<HlsConfig> = {
  manifestLoadPolicy: { default: PLAYLIST_LOAD_POLICY },
  playlistLoadPolicy: { default: PLAYLIST_LOAD_POLICY },
  fragLoadPolicy: { default: FRAGMENT_LOAD_POLICY },
};

export type DirectStreamInfo = {
  url: string;
  type: string;
  referer: string;
  proxy: string;
};

type DirectStreamResponse = {
  success: boolean;
  error?: string;
  // Why the resolve failed: 'unavailable' = no source carries this title,
  // 'upstream-error' = a source did not answer. Only the second is retryable.
  reason?: 'unavailable' | 'upstream-error';
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
  // Two failures read very differently to a viewer, and only one is worth
  // acting on: a source that did not answer usually works on a second try,
  // while a title no source carries fails identically however often you ask.
  // On the media page the "Try next source" banner is the way out of the
  // second; here the retry button covers the first.
  const [retryable, setRetryable] = useState(false);
  // Bumped by the retry button to run the resolve below again.
  const [attempt, setAttempt] = useState(0);

  // 1. Resolve the playable link for this title.
  useEffect(() => {
    if (!mediaId || !['movie', 'tv'].includes(mediaType)) {
      setError('Nothing to play — a movie or TV id is required.');
      return;
    }

    let cancelled = false;
    setStream(null);
    setError(null);
    setRetryable(false);

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
          setRetryable(body.reason !== 'unavailable');
          return;
        }
        setTitle(body.title ?? null);
        setStream(body.stream);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not reach the stream service.');
        setRetryable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [mediaId, mediaType, season, episode, server, attempt]);

  // 2. Play it. hls.js where supported, native HLS (Safari) otherwise.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;

    if (Hls.isSupported()) {
      const hls = new Hls(HLS_CONFIG);
      hls.loadSource(stream.proxy);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          // Usually a stream link that has aged out (they are time-limited) or
          // a shard that stopped serving, so re-resolving is a real fix —
          // hence the retry rather than a dead end.
          setError('Playback failed — this title may no longer be available.');
          setRetryable(true);
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
          {retryable && (
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="mt-1.5 px-4 py-1.5 rounded-full bg-void-3 hover:bg-zinc-800 border border-glass-border text-foreground text-xs font-medium transition-colors cursor-pointer"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

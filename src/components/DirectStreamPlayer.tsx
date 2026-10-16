'use client';

import React, { useEffect, useRef, useState } from 'react';
import Hls, { type HlsConfig } from 'hls.js';
import PlayerControls from '@/components/PlayerControls';

// ── Our own player with automatic source fallback ──────────────────────────
//
// Plays what GET /api/stream/direct resolves for a TMDB id: the real HLS file
// behind one of our sources, handed back through /api/stream/proxy because
// those CDNs only answer requests carrying the source's own referer — a header
// a browser cannot send. No third-party embed, so no injected ad scripts and no
// popups.
//
// Instead of pinning one source and giving up when it has nothing, this player
// walks through a list of sources in order. If the current source reports the
// title unavailable or fails to load, it automatically tries the next one —
// so the viewer sees one player, not a row of source tabs to switch between.
// Only when every source has been exhausted does it surface a retryable error.
//
// Used in two places: the public /embed/[type]/[id] page (iframe that from
// anywhere) and the media page's unified "Direct" source. The proxy link is
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
const PLAYLIST_LOAD_POLICY = {
  maxTimeToFirstByteMs: 90000,
  maxLoadTimeMs: 150000,
  timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
  errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
};

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
  reason?: 'unavailable' | 'upstream-error';
  title?: string | null;
  stream?: DirectStreamInfo;
};

type DirectStreamPlayerProps = {
  mediaType: 'movie' | 'tv';
  mediaId: string;
  season?: number | string;
  episode?: number | string;
  // Sources to try in order. Each entry is a server number for
  // /api/stream/direct (1 = moviesapi, 2 = vidsrc.pm, 3 = VidCore, 4 = VidSrc),
  // or undefined for the API's default (source 1 with automatic fallback to 2).
  // When the current source fails the player silently moves to the next entry.
  // Defaults to [undefined, 3, 4] — the fast vidora pair first, then the
  // multi-request chains only when needed.
  servers?: (number | undefined)[];
  // All sources exhausted — the media page uses this to surface its
  // "try another source" banner for the third-party embeds.
  onError?: () => void;
  // Reported by the control overlay; the media page's play screen keeps its
  // chrome up while the picture is paused (see PlayerStage's `playing`).
  onPlayingChange?: (playing: boolean) => void;
  // Optional: report which source is currently being tried, so a host can
  // show "Trying VidCore…" etc.
  onSourceChange?: (server: number | undefined) => void;
  className?: string;
};

export default function DirectStreamPlayer({
  mediaType,
  mediaId,
  season = 1,
  episode = 1,
  servers = [undefined, 3, 4],
  onError,
  onPlayingChange,
  onSourceChange,
  className = 'w-full h-full bg-black',
}: DirectStreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [stream, setStream] = useState<DirectStreamInfo | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  // Which entry in the servers list we are currently trying.
  const [serverIndex, setServerIndex] = useState(0);
  // True while we are silently moving from one failed source to the next —
  // shown as a subtle "Trying alternative source…" label instead of an error.
  const [fallingBack, setFallingBack] = useState(false);
  // Bumped by the retry button to restart from the first source.
  const [attempt, setAttempt] = useState(0);

  const currentServer = servers[serverIndex];

  // Notify the host which source we're on.
  useEffect(() => {
    onSourceChange?.(currentServer);
  }, [currentServer, onSourceChange]);

  // 1. Resolve the playable link for this title from the current source.
  useEffect(() => {
    if (!mediaId || !['movie', 'tv'].includes(mediaType)) {
      setError('Nothing to play — a movie or TV id is required.');
      return;
    }

    let cancelled = false;
    setStream(null);
    setError(null);
    setRetryable(false);
    setFallingBack(false);

    const query = new URLSearchParams({ tmdb_id: mediaId, type: mediaType });
    if (mediaType === 'tv') {
      query.set('season', String(season || 1));
      query.set('episode', String(episode || 1));
    }
    if (currentServer !== undefined) query.set('server', String(currentServer));

    fetch(`/api/stream/direct?${query.toString()}`)
      .then(async (res) => (await res.json()) as DirectStreamResponse)
      .then((body) => {
        if (cancelled) return;
        if (!body.success || !body.stream) {
          // This source does not have the title. Try the next one if we can.
          if (serverIndex < servers.length - 1) {
            setFallingBack(true);
            setServerIndex((i) => i + 1);
          } else {
            setError(body.error || 'No stream available for this title.');
            setRetryable(body.reason !== 'unavailable');
          }
          return;
        }
        setTitle(body.title ?? null);
        setStream(body.stream);
      })
      .catch(() => {
        if (cancelled) return;
        // Network error — treat the same as a resolve failure and try next.
        if (serverIndex < servers.length - 1) {
          setFallingBack(true);
          setServerIndex((i) => i + 1);
        } else {
          setError('Could not reach the stream service.');
          setRetryable(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mediaId, mediaType, season, episode, currentServer, serverIndex, servers.length, attempt]);

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
          // Playback failed on this source. Try the next one before giving up.
          if (serverIndex < servers.length - 1) {
            setStream(null);
            setFallingBack(true);
            setServerIndex((i) => i + 1);
          } else {
            setError('Playback failed — this title may no longer be available.');
            setRetryable(true);
          }
        }
      });
      return () => hls.destroy();
    }

    video.src = stream.proxy;
  }, [stream, serverIndex, servers.length]);

  // Only tell the host when ALL sources are exhausted.
  useEffect(() => {
    if (error) onError?.();
  }, [error, onError]);

  // Reset to the first source when the retry button is pressed.
  const handleRetry = () => {
    setServerIndex(0);
    setAttempt((n) => n + 1);
  };

  return (
    <div ref={surfaceRef} className={`relative ${className}`}>
      <video
        ref={videoRef}
        className="w-full h-full bg-black"
        autoPlay
        playsInline
        title={title ? `${title} — player` : 'Stream player'}
      />

      {stream && !error && (
        <PlayerControls
          videoRef={videoRef}
          surfaceRef={surfaceRef}
          onPlayingChange={onPlayingChange}
        />
      )}

      {!stream && !error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-void">
          <div className="w-8 h-8 rounded-full border-2 border-t-transparent border-violet animate-spin" />
          <p className="text-[11px] text-muted font-medium tracking-wider uppercase">
            {fallingBack
              ? 'Trying alternative source…'
              : 'Loading stream…'}
          </p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-void px-6 text-center">
          <p className="font-display text-sm font-semibold text-foreground">
            {title ?? 'Playback unavailable'}
          </p>
          <p className="text-xs text-muted max-w-sm">{error}</p>
          {retryable && (
            <button
              type="button"
              onClick={handleRetry}
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

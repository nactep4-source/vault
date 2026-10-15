'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';

// ── Playback controls for our own player ────────────────────────────────────
//
// The browser's native <video controls> strip cannot be styled, and that stock
// row of buttons is the single biggest reason the player read as a browser
// video rather than a cinema app. This replaces it for the HLS streams
// /api/stream/direct resolves (see DirectStreamPlayer) and keeps only what a
// viewer actually reaches for: play/pause, ±10 s, a draggable timeline that
// shows the buffered range, volume, picture-in-picture and fullscreen.
//
// The behaviour it copies from the streaming apps people are used to:
//   • the chrome fades out while something is playing, and stays put while
//     paused — nothing sits over the picture once you are watching
//   • a click on the picture brings the chrome back; with the chrome already
//     up the same click plays/pauses
//   • pointer movement, taps and key presses all bring it back
//   • keyboard shortcuts apply only while the player itself has focus, never
//     page-wide, so they cannot hijack the rest of the app
//
// Third-party embeds keep their own controls — a cross-origin frame gives us
// nothing to attach to, so those sources look however their vendor made them.

const IDLE_HIDE_MS = 3200;

const BUTTON_CLASS =
  'flex h-9 w-9 flex-none items-center justify-center rounded-full text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white cursor-pointer';

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

// One draggable bar, used for both the timeline and the volume slider — the
// same pointer maths in both places, so scrubbing feels identical wherever you
// grab it. `buffered` is optional because only the timeline has one.
function ScrubTrack({
  value,
  buffered,
  onScrub,
  className = '',
}: {
  value: number; // 0..1
  buffered?: number; // 0..1
  onScrub: (ratio: number) => void;
  className?: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const ratioFrom = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const playedPct = Math.min(100, Math.max(0, value * 100));
  const bufferedPct = Math.min(100, Math.max(0, (buffered ?? 0) * 100));

  return (
    <div
      ref={barRef}
      className={`group/track relative flex cursor-pointer touch-none items-center py-2 ${className}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        setDragging(true);
        barRef.current?.setPointerCapture(e.pointerId);
        onScrub(ratioFrom(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging) onScrub(ratioFrom(e.clientX));
      }}
      onPointerUp={(e) => {
        setDragging(false);
        barRef.current?.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => setDragging(false)}
    >
      <div className="relative h-[3px] w-full rounded-full bg-white/20 transition-all duration-200 group-hover/track:h-[6px]">
        {buffered !== undefined && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/30"
            style={{ width: `${bufferedPct}%` }}
          />
        )}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white"
          style={{ width: `${playedPct}%` }}
        />
        <div
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.6)] ${
            dragging ? 'opacity-100' : 'opacity-0 group-hover/track:opacity-100'
          }`}
          style={{ left: `calc(${playedPct}% - 6px)` }}
        />
      </div>
    </div>
  );
}

export default function PlayerControls({
  videoRef,
  surfaceRef,
  onPlayingChange,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  // Reports whether the picture is actually running, so a host that frames this
  // player (the media page's play screen) can keep its own chrome up while the
  // picture is paused instead of guessing.
  onPlayingChange?: (playing: boolean) => void;
}) {
  // hls.js attaches its media source to the <video> a moment after this
  // component mounts, so the element is mirrored into state and every listener
  // below is bound to the element itself rather than to whatever the ref held
  // on the first render.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [inFullscreen, setInFullscreen] = useState(false);
  const [inPip, setInPip] = useState(false);
  const [supported, setSupported] = useState({ fullscreen: false, pip: false });
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVideo(videoRef.current ?? null);
  }, [videoRef]);

  // Feature detection happens after mount: there is no `document` while this
  // is rendered on the server.
  useEffect(() => {
    setSupported({
      fullscreen: Boolean(document.fullscreenEnabled),
      pip: Boolean(document.pictureInPictureEnabled),
    });
  }, []);

  // ── Chrome visibility ─────────────────────────────────────────────────────
  // Anything that counts as activity shows the chrome and restarts the idle
  // clock. While nothing is playing the clock never runs: a paused picture is
  // exactly when you want the controls on screen.
  const reveal = useCallback(() => {
    setVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (playing) idleTimer.current = setTimeout(() => setVisible(false), IDLE_HIDE_MS);
  }, [playing]);

  useEffect(() => {
    onPlayingChange?.(playing);
  }, [playing, onPlayingChange]);

  useEffect(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (playing && !scrubbing) {
      idleTimer.current = setTimeout(() => setVisible(false), IDLE_HIDE_MS);
    } else {
      setVisible(true);
    }
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [playing, scrubbing]);

  // ── Mirror the media element's state ──────────────────────────────────────
  useEffect(() => {
    if (!video) return;

    const syncProgress = () => {
      setCurrent(video.currentTime);
      const total = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(total);
      setBuffered(
        total && video.buffered.length
          ? video.buffered.end(video.buffered.length - 1) / total
          : 0
      );
      setPlaying(!video.paused && !video.ended);
    };
    const syncVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted || video.volume === 0);
    };
    const syncFullscreen = () => setInFullscreen(Boolean(document.fullscreenElement));
    const syncPip = () => setInPip(Boolean(document.pictureInPictureElement));

    video.addEventListener('loadedmetadata', syncProgress);
    video.addEventListener('durationchange', syncProgress);
    video.addEventListener('timeupdate', syncProgress);
    video.addEventListener('progress', syncProgress);
    video.addEventListener('play', syncProgress);
    video.addEventListener('pause', syncProgress);
    video.addEventListener('ended', syncProgress);
    video.addEventListener('volumechange', syncVolume);
    video.addEventListener('enterpictureinpicture', syncPip);
    video.addEventListener('leavepictureinpicture', syncPip);
    document.addEventListener('fullscreenchange', syncFullscreen);

    syncProgress();
    syncVolume();
    syncPip();
    syncFullscreen();

    return () => {
      video.removeEventListener('loadedmetadata', syncProgress);
      video.removeEventListener('durationchange', syncProgress);
      video.removeEventListener('timeupdate', syncProgress);
      video.removeEventListener('progress', syncProgress);
      video.removeEventListener('play', syncProgress);
      video.removeEventListener('pause', syncProgress);
      video.removeEventListener('ended', syncProgress);
      video.removeEventListener('volumechange', syncVolume);
      video.removeEventListener('enterpictureinpicture', syncPip);
      video.removeEventListener('leavepictureinpicture', syncPip);
      document.removeEventListener('fullscreenchange', syncFullscreen);
    };
  }, [video]);

  // ── Commands ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  }, [videoRef]);

  const seekBy = useCallback(
    (delta: number) => {
      const element = videoRef.current;
      if (!element || !Number.isFinite(element.duration)) return;
      element.currentTime = Math.min(element.duration, Math.max(0, element.currentTime + delta));
      setCurrent(element.currentTime);
    },
    [videoRef]
  );

  const toggleMute = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !element.muted;
  }, [videoRef]);

  const applyVolume = useCallback(
    (ratio: number) => {
      const element = videoRef.current;
      if (!element) return;
      element.volume = ratio;
      element.muted = ratio === 0;
    },
    [videoRef]
  );

  const toggleFullscreen = useCallback(async () => {
    const element = surfaceRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch {
      // The browser refused (no fullscreen permission, iOS quirks) — the
      // button simply has no effect rather than throwing at the viewer.
    }
  }, [surfaceRef]);

  const togglePip = useCallback(async () => {
    const element = videoRef.current;
    if (!element) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch {
      /* same: unsupported or blocked */
    }
  }, [videoRef]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const element = videoRef.current;
    if (!element) return;
    const key = event.key.toLowerCase();

    if (key === ' ' || key === 'k') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekBy(-10);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekBy(10);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      applyVolume(Math.min(1, element.volume + 0.05));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      applyVolume(Math.max(0, element.volume - 0.05));
    } else if (key === 'm') {
      toggleMute();
    } else if (key === 'f') {
      void toggleFullscreen();
    }
    reveal();
  };

  return (
    <div className="absolute inset-0 z-20" onPointerMove={reveal}>
      {/* The click surface covers the picture, and it is also the only element
          that owns the keyboard shortcuts — so they only apply while the
          player has focus. The bars below are its siblings, not its children,
          so a click on a button never also toggles playback. */}
      <div
        className="absolute inset-0 outline-none"
        tabIndex={0}
        role="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => (visible ? togglePlay() : reveal())}
        onKeyDown={onKeyDown}
      />

      {/* Fades the top edge so the chrome stays legible over any frame. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 via-black/25 to-transparent transition-opacity duration-500 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* A paused picture gets one unambiguous control, the play button. */}
      {!playing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          aria-label="Play"
          className="absolute left-1/2 top-1/2 z-30 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-white/15 backdrop-blur-md transition-all duration-200 hover:scale-105 hover:bg-white/25 md:h-[68px] md:w-[68px]"
        >
          <Play className="h-6 w-6 translate-x-[2px] fill-white text-white" />
        </button>
      )}

      {/* Bottom chrome */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 transition-opacity duration-500 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-2.5 pt-16 md:px-5 md:pb-3.5">
          <ScrubTrack
            value={duration ? current / duration : 0}
            buffered={buffered}
            onScrub={(ratio) => {
              const element = videoRef.current;
              if (!element || !Number.isFinite(element.duration)) return;
              element.currentTime = ratio * element.duration;
              setCurrent(ratio * element.duration);
            }}
          />

          <div className="mt-1 flex items-center gap-1 md:gap-1.5">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className={BUTTON_CLASS}
            >
              {playing ? <Pause className="h-[19px] w-[19px] fill-current" /> : <Play className="h-[19px] w-[19px] translate-x-[1px] fill-current" />}
            </button>

            <button
              type="button"
              onClick={() => seekBy(-10)}
              aria-label="Back 10 seconds"
              className={BUTTON_CLASS}
            >
              <span className="relative flex items-center justify-center">
                <RotateCcw className="h-[19px] w-[19px]" />
                <span className="absolute text-[8.5px] font-bold leading-none">10</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => seekBy(10)}
              aria-label="Forward 10 seconds"
              className={BUTTON_CLASS}
            >
              <span className="relative flex items-center justify-center">
                <RotateCw className="h-[19px] w-[19px]" />
                <span className="absolute text-[8.5px] font-bold leading-none">10</span>
              </span>
            </button>

            <span className="ml-1.5 hidden text-[12px] font-medium tabular-nums text-white/85 sm:block">
              {formatTime(current)}
              <span className="text-white/40"> / {formatTime(duration)}</span>
            </span>

            <div className="ml-auto flex items-center gap-1 md:gap-1.5">
              {/* The slider only appears on hover (or keyboard focus), so the
                  bar stays a row of buttons until you reach for the volume. */}
              <div className="group/vol flex items-center">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  className={BUTTON_CLASS}
                >
                  {muted ? (
                    <VolumeX className="h-[19px] w-[19px]" />
                  ) : volume < 0.5 ? (
                    <Volume1 className="h-[19px] w-[19px]" />
                  ) : (
                    <Volume2 className="h-[19px] w-[19px]" />
                  )}
                </button>
                <div className="w-0 overflow-hidden transition-[width] duration-200 group-hover/vol:w-[92px] group-focus-within/vol:w-[92px]">
                  <ScrubTrack
                    className="w-[92px] pr-3"
                    value={muted ? 0 : volume}
                    onScrub={applyVolume}
                  />
                </div>
              </div>

              {supported.pip && (
                <button
                  type="button"
                  onClick={() => void togglePip()}
                  aria-label={inPip ? 'Exit picture in picture' : 'Picture in picture'}
                  className={BUTTON_CLASS}
                >
                  <PictureInPicture2 className="h-[18px] w-[18px]" />
                </button>
              )}

              {supported.fullscreen && (
                <button
                  type="button"
                  onClick={() => void toggleFullscreen()}
                  aria-label={inFullscreen ? 'Exit full screen' : 'Full screen'}
                  className={BUTTON_CLASS}
                >
                  {inFullscreen ? (
                    <Minimize className="h-[19px] w-[19px]" />
                  ) : (
                    <Maximize className="h-[19px] w-[19px]" />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

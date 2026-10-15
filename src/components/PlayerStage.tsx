'use client';

import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Sparkles, X } from 'lucide-react';

// ── The play screen ─────────────────────────────────────────────────────────
//
// Where a title is watched, built the way the streaming apps build it: the
// picture is the screen and everything else is chrome that gets out of the way.
// It replaces the old inline player on the media page — the row of source tabs,
// the header, the info strip and the 16:9 box sat *around* the video on the
// page; here the video is the page and the same controls sit on top of it.
//
// Nothing about playing changed. The same sources, the same switching (our own
// Direct/Server 2/VidCore/VidSrc players vs. the third-party embeds), the same
// Clean mode and popup-blocker toggles, the same "try next source" recovery and
// the same Up Next card — only their presentation moved into an overlay.
//
// Chrome rules: it fades out while something is playing and comes back on
// pointer movement, a tap or Escape. It never fades while it is the only thing
// on screen that means something — loading a source, an error, the "nothing
// playing?" hint, or the source list being open.

const CHROME_IDLE_MS = 4200;

export type StageSource = { name: string; color: string };

type PlayerStageProps = {
  title: string;
  // Second line under the title: which episode is playing, or the year/runtime.
  context?: string | null;
  // The title's own artwork, blurred far behind the picture so the letterbox
  // around the video is not flat black.
  ambientSrc?: string;
  sources: StageSource[];
  activeSourceIndex: number;
  onSelectSource: (index: number) => void;
  onClose: () => void;
  onNextSource: () => void;
  // Our own player needs neither of the embed toggles, so they are hidden for
  // it and shown for every third-party source.
  showEmbedControls: boolean;
  cleanActive: boolean;
  onToggleClean: () => void;
  blockPopups: boolean;
  onTogglePopups: () => void;
  loadError: boolean;
  loading: boolean;
  hintVisible: boolean;
  onDismissHint: () => void;
  // Whether our own player is actually running. `false` means the picture is
  // deliberately standing still — still resolving, paused, or waiting for the
  // viewer — which is exactly when the chrome should stay put. `null` is a
  // third-party embed, where we cannot know and simply let it time out.
  playing?: boolean | null;
  notice?: string | null;
  // The player itself (our component or the third-party iframe).
  player: React.ReactNode;
  // Anything that belongs on the picture — the Up Next card.
  overlay?: React.ReactNode;
};

const PILL_CLASS =
  'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] px-3.5 py-2 text-[12px] font-medium text-white/80 backdrop-blur-md transition-colors duration-150 hover:bg-white/[0.12] hover:text-white cursor-pointer disabled:opacity-35 disabled:cursor-default disabled:hover:bg-white/[0.07]';

const PlayerStage = forwardRef<HTMLDivElement, PlayerStageProps>(function PlayerStage(
  {
    title,
    context,
    ambientSrc,
    sources,
    activeSourceIndex,
    onSelectSource,
    onClose,
    onNextSource,
    showEmbedControls,
    cleanActive,
    onToggleClean,
    blockPopups,
    onTogglePopups,
    loadError,
    loading,
    hintVisible,
    onDismissHint,
    playing,
    notice,
    player,
    overlay,
  },
  ref
) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const [sourceListOpen, setSourceListOpen] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeSource = sources[activeSourceIndex];

  // While any of these are true the chrome is the only thing on screen that
  // says what is going on, so it stays up instead of timing out.
  const chromePinned = sourceListOpen || loadError || loading || hintVisible || playing === false;

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS);
  }, []);

  useEffect(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (chromePinned) {
      setChromeVisible(true);
      return;
    }
    idleTimer.current = setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [chromePinned]);

  // Escape backs out of the source list first, then out of the player — the
  // same order the back gesture means in a video app.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (sourceListOpen) setSourceListOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sourceListOpen, onClose]);

  const chromeFade = chromeVisible
    ? 'opacity-100'
    : 'pointer-events-none opacity-0';

  return (
    <div
      ref={ref}
      // pointerdown as well as pointermove: a tap on a touch screen produces no
      // movement, and without it the chrome could hide itself out of reach.
      onPointerDown={showChrome}
      onPointerMove={showChrome}
      onPointerLeave={() => {
        if (!chromePinned) setChromeVisible(false);
      }}
      className={`relative w-full overflow-hidden bg-black text-foreground ${
        chromeVisible ? '' : 'cursor-none'
      }`}
    >
      {/* Ambient artwork behind the picture */}
      {ambientSrc && (
        <div
          className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-[0.22] blur-[90px]"
          style={{ backgroundImage: `url('${ambientSrc}')` }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-black/60 to-black/80" />

      {/* Swallows the click that closes the source list */}
      {sourceListOpen && (
        <div
          className="absolute inset-0 z-30"
          onClick={() => setSourceListOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="relative z-10 flex min-h-[100dvh] flex-col">
        {/* ── The picture ──
            The box is sized from the *shortest* side of the viewport (the
            chrome needs room at the top and bottom), so the video is as large
            as it can be without the controls ever falling off screen. */}
        <div className="flex flex-1 items-center justify-center px-4 pb-2 pt-20 md:pl-28 md:pr-10 md:pt-24">
          <div
            className="animate-fadeIn relative aspect-video w-full overflow-hidden rounded-[16px] bg-black ring-1 ring-white/[0.08] shadow-[0_40px_120px_rgba(0,0,0,0.8)] md:rounded-[20px]"
            style={{ maxWidth: 'min(1500px, calc((100dvh - 19rem) * 16 / 9))' }}
          >
            {player}

            {loading && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-[2px]">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent border-white/70" />
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
                  Connecting to {activeSource?.name ?? 'source'}…
                </p>
              </div>
            )}

            {overlay}

            {hintVisible && (
              <div className="absolute left-1/2 top-4 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/75 py-2 pl-4 pr-2 backdrop-blur-md">
                <p className="truncate text-[12px] text-white/70">
                  Nothing playing? Try another source or turn the popup blocker off.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onNextSource();
                    onDismissHint();
                  }}
                  className="flex-none rounded-full bg-white px-3 py-1 text-[11.5px] font-semibold text-black transition-opacity hover:opacity-90"
                >
                  Try next source
                </button>
                <button
                  type="button"
                  onClick={onDismissHint}
                  aria-label="Dismiss"
                  className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {notice && (
              <div className="absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-black/80 px-4 py-2 text-[12px] text-white/85 backdrop-blur-md">
                {notice}
              </div>
            )}
          </div>
        </div>

        {/* ── Bottom chrome ──
            Everything you can change about *what* is playing: the source, the
            embed toggles, and the way out when a source does not carry the
            title. Sitting under the picture rather than on it keeps the video
            unobstructed. */}
        <div
          className={`relative z-40 px-4 pb-24 pt-3 transition-opacity duration-500 md:pl-28 md:pr-10 md:pb-8 ${chromeFade}`}
        >
          {loadError && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-rose-300">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-3.5 w-3.5 flex-none"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v5M12 16h.01" />
                </svg>
                <span>Source encountered a loading issue. Try switching to another source.</span>
              </div>
              <button
                type="button"
                onClick={onNextSource}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-white/20"
              >
                Try next source
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* Source picker — a pill that opens the list upwards, so the
                picture keeps every pixel it can. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setSourceListOpen((open) => !open)}
                aria-expanded={sourceListOpen}
                className={PILL_CLASS}
              >
                <span
                  className="h-1.5 w-1.5 flex-none rounded-full"
                  style={{ background: activeSource?.color }}
                />
                Source · {activeSource?.name}
                <ChevronDown
                  className={`h-3.5 w-3.5 flex-none text-white/50 transition-transform duration-200 ${
                    sourceListOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {sourceListOpen && (
                <div className="animate-fadeIn absolute bottom-full left-0 z-40 mb-3 w-[260px] rounded-2xl border border-white/10 bg-[#0f0f0f]/95 p-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.7)] backdrop-blur-xl">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">
                    Source
                  </p>
                  {sources.map((source, index) => (
                    <button
                      key={source.name}
                      type="button"
                      onClick={() => {
                        onSelectSource(index);
                        setSourceListOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors ${
                        index === activeSourceIndex
                          ? 'bg-white/[0.09] text-white'
                          : 'text-white/70 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      <span
                        className="h-1.5 w-1.5 flex-none rounded-full"
                        style={{ background: source.color }}
                      />
                      <span className="flex-1 truncate font-medium">{source.name}</span>
                      {index === activeSourceIndex && <Check className="h-3.5 w-3.5 flex-none" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {showEmbedControls && (
              <>
                {/* The app's violet tokens are CSS variables, so a Tailwind
                    `/opacity` modifier would emit nothing — the active state
                    is set with the tokens themselves. */}
                <button
                  type="button"
                  onClick={onToggleClean}
                  title="Loads the player through our server with ad scripts removed. Turn off if the video won't play."
                  className={PILL_CLASS}
                  style={
                    cleanActive
                      ? {
                          background: 'var(--violet-dim)',
                          borderColor: 'var(--violet)',
                          color: 'var(--violet-light)',
                        }
                      : undefined
                  }
                >
                  <Sparkles className="h-3.5 w-3.5 flex-none" />
                  Clean mode: {cleanActive ? 'On' : 'Off'}
                </button>

                <button
                  type="button"
                  onClick={onTogglePopups}
                  title="Blocks popups and redirects from the player. Turn off if the video won't play."
                  className={`${PILL_CLASS} ${
                    blockPopups ? '!border-emerald-500/40 !bg-emerald-500/15 !text-emerald-300' : ''
                  }`}
                >
                  Popup blocker: {blockPopups ? 'On' : 'Off'}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onNextSource}
              disabled={activeSourceIndex === sources.length - 1}
              className={`${PILL_CLASS} ml-auto`}
            >
              Try next source
              <ChevronRight className="h-3.5 w-3.5 flex-none" />
            </button>
          </div>

          <p className="mt-3 text-[11.5px] text-white/45">
            {context ? `${context} · ` : ''}Streaming from{' '}
            <span className="font-medium text-white/70">{activeSource?.name}</span>
          </p>
        </div>
      </div>

      {/* ── Top chrome ── */}
      <div
        className={`absolute inset-x-0 top-0 z-40 bg-gradient-to-b from-black/85 via-black/40 to-transparent px-4 pb-14 pt-5 transition-opacity duration-500 md:pl-28 md:pr-10 md:pt-7 ${chromeFade}`}
      >
        <div className="flex items-start gap-3.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close player"
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-white/10 bg-white/[0.08] text-white/80 backdrop-blur-md transition-colors hover:bg-white/[0.16] hover:text-white"
          >
            <X className="h-[18px] w-[18px]" />
          </button>

          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[15px] font-semibold leading-tight md:text-[17px]">
              {title}
            </h2>
            {context && <p className="mt-1 truncate text-[12px] text-white/55">{context}</p>}
          </div>

          {!showEmbedControls && (
            <span className="hidden flex-none items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-white/60 backdrop-blur-md sm:inline-flex">
              <Sparkles className="h-3 w-3" />
              Ad-free
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export default PlayerStage;

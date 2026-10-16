'use client';

import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Sparkles, X } from 'lucide-react';

// ── Large in-page preview modal ──────────────────────────────────────────────
//
// Opens on top of the media detail page when the viewer presses Watch, so the
// page stays visible behind a darkened backdrop instead of being replaced by a
// full-screen player. The player surface (our own DirectStreamPlayer or a
// third-party iframe) is passed in from the media page, which owns all the
// playback state; this component is only the presentation shell — title bar,
// the 16:9 picture, and the source/embed controls underneath it.

type StageSource = { name: string; color: string };

type PreviewModalProps = {
  title: string;
  context?: string | null;
  onClose: () => void;
  player: React.ReactNode;
  sources: StageSource[];
  activeSourceIndex: number;
  onSelectSource: (index: number) => void;
  onNextSource: () => void;
  showEmbedControls: boolean;
  cleanActive: boolean;
  onToggleClean: () => void;
  blockPopups: boolean;
  onTogglePopups: () => void;
  loadError: boolean;
  loading: boolean;
  hintVisible?: boolean;
  onDismissHint?: () => void;
  notice?: string | null;
  overlay?: React.ReactNode;
};

const PILL =
  'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] px-3 py-1.5 text-[11.5px] font-medium text-white/80 backdrop-blur-md transition-colors duration-150 hover:bg-white/[0.12] hover:text-white cursor-pointer disabled:opacity-35 disabled:cursor-default';

export default function PreviewModal({
  title,
  context,
  onClose,
  player,
  sources,
  activeSourceIndex,
  onSelectSource,
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
  notice,
  overlay,
}: PreviewModalProps) {
  const [sourceListOpen, setSourceListOpen] = useState(false);
  const activeSource = sources[activeSourceIndex];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sourceListOpen) setSourceListOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sourceListOpen, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 md:p-8"
      onClick={() => {
        if (sourceListOpen) setSourceListOpen(false);
        else onClose();
      }}
    >
      <div className="relative w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        {/* Title bar */}
        <div className="mb-3 flex items-center justify-between">
          <div className="min-w-0 flex-1 pr-3">
            <h2 className="truncate font-display text-base font-semibold text-foreground">
              {title}
            </h2>
            {context && <p className="mt-0.5 truncate text-xs text-muted">{context}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex-none w-9 h-9 rounded-full border border-white/10 bg-white/[0.08] text-white/80 flex items-center justify-center hover:bg-white/[0.16] hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Player */}
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black ring-1 ring-white/[0.08] shadow-[0_24px_60px_rgba(0,0,0,0.7)]">
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

          {notice && (
            <div className="absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-black/80 px-4 py-2 text-[12px] text-white/85 backdrop-blur-md">
              {notice}
            </div>
          )}

          {hintVisible && (
            <div className="absolute left-1/2 top-4 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/75 py-2 pl-4 pr-2 backdrop-blur-md">
              <p className="truncate text-[12px] text-white/70">
                Nothing playing? Try another source.
              </p>
              <button
                type="button"
                onClick={() => {
                  onNextSource();
                  onDismissHint?.();
                }}
                className="flex-none rounded-full bg-white px-3 py-1 text-[11.5px] font-semibold text-black hover:opacity-90"
              >
                Try next source
              </button>
              <button
                type="button"
                onClick={onDismissHint}
                aria-label="Dismiss"
                className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {loadError && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80">
              <p className="text-sm font-semibold text-rose-300">
                Source encountered a loading issue.
              </p>
              <button
                onClick={onNextSource}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-white/20"
              >
                Try next source <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {/* Source controls */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setSourceListOpen((o) => !o)}
              className={PILL}
            >
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: activeSource?.color }}
              />
              Source · {activeSource?.name}
              <ChevronDown
                className={`h-3 w-3 flex-none text-white/50 transition-transform ${sourceListOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {sourceListOpen && (
              <div className="animate-fadeIn absolute top-full left-0 mt-2 z-40 w-[240px] rounded-2xl border border-white/10 bg-[#0f0f0f]/95 p-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.7)] backdrop-blur-xl">
                {sources.map((source, index) => (
                  <button
                    key={source.name}
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
              <button
                type="button"
                onClick={onToggleClean}
                title="Loads the player through our server with ad scripts removed."
                className={PILL}
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
                <Sparkles className="h-3 w-3 flex-none" />
                Clean: {cleanActive ? 'On' : 'Off'}
              </button>
              <button
                type="button"
                onClick={onTogglePopups}
                title="Blocks popups and redirects from the player."
                className={`${PILL} ${blockPopups ? '!border-emerald-500/40 !bg-emerald-500/15 !text-emerald-300' : ''}`}
              >
                Popup blocker: {blockPopups ? 'On' : 'Off'}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onNextSource}
            disabled={activeSourceIndex === sources.length - 1}
            className={`${PILL} ml-auto`}
          >
            Try next source <ChevronRight className="h-3 w-3 flex-none" />
          </button>
        </div>
      </div>
    </div>
  );
}

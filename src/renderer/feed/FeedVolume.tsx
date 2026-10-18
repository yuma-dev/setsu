// the local player's single-track mixer row (player-legacy/audio-tracks-manager.js SingleTrackMixer),
// same markup so player.css styles it. click opens it, an outside press closes it, keys and wheel
// flash it, and chromeVisibility keeps the chrome up while it shows. the feed plays the server stream through a bare <video> with no web audio gain, so the
// row tops out at 100% where the local one goes to 200%

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const FLASH_MS = 1600;
const DEFAULT_COLOR = "#ffffff";

const snap = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

interface FeedVolumeProps {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onNudge: (delta: number) => void;
  onToggleMute: () => void;
  /** bumped by the volume keys, each bump flashes the row */
  flash: number;
  children: ReactNode;
}

export default function FeedVolume({
  volume,
  muted,
  onVolume,
  onNudge,
  onToggleMute,
  flash,
  children,
}: FeedVolumeProps) {
  const [open, setOpen] = useState(false);
  const [transient, setTransient] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const flashTimerRef = useRef<number | undefined>(undefined);
  const nudgeRef = useRef(onNudge);
  nudgeRef.current = onNudge;
  const shown = open || transient;

  const pulse = useCallback(() => {
    window.clearTimeout(flashTimerRef.current);
    setTransient(true);
    flashTimerRef.current = window.setTimeout(() => setTransient(false), FLASH_MS);
  }, []);

  // the count outlives a close and reopen, only a bump while mounted flashes
  const seenFlashRef = useRef(flash);
  useEffect(() => {
    if (flash === seenFlashRef.current) return;
    seenFlashRef.current = flash;
    pulse();
  }, [flash, pulse]);

  useEffect(() => () => window.clearTimeout(flashTimerRef.current), []);

  // the colour picked for single-track clips in the local mixer
  useEffect(() => {
    window.clips
      .getTrackPreferences()
      .then((prefs: Record<string, { color?: unknown }> | null) => {
        const c = prefs?.["single-track"]?.color;
        if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)) setColor(c);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // native and non-passive: react's wheel listener is passive, and the overlay scrolls the
  // details sheet into view on wheel otherwise
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      nudgeRef.current(e.deltaY < 0 ? 0.05 : -0.05);
      pulse();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pulse]);

  const apply = (clientX: number) => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r && r.width > 0) onVolume(snap((clientX - r.left) / r.width));
  };

  const rowStyle = {
    "--fill": `${snap(volume) * 100}%`,
    "--c1": `${color}55`,
    "--c2": `${color}88`,
    color,
  } as CSSProperties;

  return (
    <div id="volume-container" ref={rootRef}>
      {shown && (
        <div id="audio-tracks-panel" className="mixer--single" onClick={(e) => e.stopPropagation()}>
          <div className="mixer__tracks">
            <div className="mixer__row-wrap">
              <div
                ref={rowRef}
                className={`mixer__row${muted ? " mixer__row--muted" : ""}`}
                data-dragging={dragging ? "true" : undefined}
                style={rowStyle}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDragging(true);
                  apply(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (dragging) apply(e.clientX);
                }}
                onPointerUp={() => setDragging(false)}
                onPointerCancel={() => setDragging(false)}
                onDoubleClick={() => onVolume(1)}
              >
                <div className="mixer__fill" />
                <div className="mixer__overlay">
                  <span className="mixer__dot" style={{ pointerEvents: "none" }} />
                  <div className="mixer__name" />
                  <div className="mixer__value">{Math.round(snap(volume) * 100)}%</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <button
        id="volume-button"
        type="button"
        aria-label="Volume"
        title="Volume, right-click to mute"
        onClick={(e) => {
          e.stopPropagation();
          window.clearTimeout(flashTimerRef.current);
          setTransient(false);
          setOpen((o) => !o);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onToggleMute();
        }}
      >
        {children}
      </button>
    </div>
  );
}

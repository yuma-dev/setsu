import { getLayers } from "./store";
import { pitchAt, rateAt } from "./model";

// the clip's own speed (the drum) is what playbackRate holds outside speed layers. inside one the
// loop scales it, and everything that means the clip's speed reads baseRate() instead
let base = 1;
let applied = 1;
// settings.speedPitch, for the clip's own speed; speed layers carry their own
let clipPitch: "tape" | "keep" = "tape";

export function setClipPitch(pitch: "tape" | "keep" | undefined): void {
  clipPitch = pitch === "keep" ? "keep" : "tape";
}

const video = () => document.getElementById("video-player") as HTMLVideoElement | null;

/** the clip's speed without speed layers */
export function baseRate(): number {
  const v = video();
  if (!v) return 1;
  // someone set playbackRate since the loop last did: that value is a base speed
  if (Math.abs(v.playbackRate - applied) > 1e-6) return v.playbackRate;
  return base;
}

declare global {
  interface Window {
    playerBaseRate?: () => number;
  }
}

export function installSpeedLayers(): () => void {
  window.playerBaseRate = baseRate;
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const v = video();
    if (!v) return;
    const pr = v.playbackRate;
    if (Math.abs(pr - applied) > 1e-6) {
      base = pr;
      applied = pr;
    }
    const { clip, items } = getLayers();
    const factor = clip ? rateAt(items, v.currentTime) : 1;
    const want = Math.min(16, Math.max(0.0625, base * factor));
    if (Math.abs(want - applied) > 1e-6) {
      applied = want;
      v.playbackRate = want;
    }
    // tape has chromium resample instead of running its pitch keeping stretch, the sound the
    // export makes. the space-hold boost is a fast forward, not an edit, so it keeps the pitch
    const pitch = (clip ? pitchAt(items, v.currentTime) : null) ?? clipPitch;
    const keep = pitch === "keep" || window.legacyState?.wasSpaceHoldBoostActive === true;
    if (v.preservesPitch !== keep) v.preservesPitch = keep;
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    const v = video();
    if (v && Math.abs(v.playbackRate - applied) < 1e-6) v.playbackRate = base;
    applied = base;
    delete window.playerBaseRate;
  };
}

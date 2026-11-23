import { memo, type CSSProperties } from "react";
import { Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { startUpdateDownload, useUpdater } from "./useUpdater";
import { KOFI_URL, openExternal } from "../ui/openExternal";
import { useKofiNoteShown } from "./kofiSession";

// Four-point sparkle used for the hover star burst (Game Launcher style).
function StarSvg() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 784.11 815.53" aria-hidden>
      <path d="M392.05 0c-20.9,210.08 -184.06,378.41 -392.05,407.78 207.96,29.37 371.12,197.68 392.05,407.74 20.93,-210.06 184.09,-378.37 392.05,-407.74 -207.98,-29.38 -371.16,-197.69 -392.06,-407.78z" />
    </svg>
  );
}

// ko-fi's cup with the heart on it, drawn small enough for the rail icon slot
function KofiCup() {
  return (
    <svg className="kofi-cup" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path className="kofi-cup-body" d="M2.5 6.5h14v6.75a5.25 5.25 0 0 1-5.25 5.25h-3.5A5.25 5.25 0 0 1 2.5 13.25V6.5z" />
      <path className="kofi-cup-handle" d="M16.5 8.25h1.6a2.9 2.9 0 0 1 0 5.8h-1.75" />
      <path className="kofi-cup-heart" d="M9.5 15.4s-3.2-1.9-3.2-4a1.65 1.65 0 0 1 3.2-.6 1.65 1.65 0 0 1 3.2.6c0 2.1-3.2 4-3.2 4z" />
    </svg>
  );
}

function HeartSvg() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 21s-9-5.6-9-11.6A4.9 4.9 0 0 1 12 6.9a4.9 4.9 0 0 1 9 2.5C21 15.4 12 21 12 21z" />
    </svg>
  );
}

// sits between the stat cards and profile card in the rail
// style copied from the Game Launcher rail updater: purple accent, progress fill, hover star burst
function UpdatePill() {
  const { phase, latestVersion, percent } = useUpdater();
  const noteShown = useKofiNoteShown();
  // nothing to update, the slot asks for a tip instead, unless the post-update note already did
  if (phase === "idle") {
    if (noteShown) return null;
    return (
      <button
        type="button"
        data-rail-tip="Buy me a coffee on Ko-fi"
        className="rail-update rail-update--kofi"
        onClick={() => openExternal(KOFI_URL)}
      >
        <span className="r-ico">
          <KofiCup />
        </span>
        <span className="rail-label">Buy me a coffee</span>
        <span className="rail-kofi-heart heart-1" aria-hidden><HeartSvg /></span>
        <span className="rail-kofi-heart heart-2" aria-hidden><HeartSvg /></span>
        <span className="rail-kofi-heart heart-3" aria-hidden><HeartSvg /></span>
      </button>
    );
  }

  const busy = phase === "downloading";
  const label =
    phase === "available"
      ? "Update available"
      : phase === "downloading"
        ? "Downloading"
        : phase === "downloaded"
          ? "Launching installer…"
          : "Update failed";
  const tip = phase === "available" && latestVersion ? `${label} (v${latestVersion})` : label;
  const Icon =
    phase === "downloaded" ? RotateCcw : phase === "downloading" ? Loader2 : phase === "error" ? RefreshCw : Download;

  const handleClick = () => {
    // available triggers download, error retries; downloading/downloaded do nothing
    // main launches the installer and quits on its own after the download
    if (phase === "available" || phase === "error") void startUpdateDownload();
  };

  return (
    <button
      type="button"
      data-rail-tip={tip}
      className={`rail-update rail-update--${phase}`}
      onClick={handleClick}
      disabled={busy || phase === "downloaded"}
      style={busy ? ({ "--rail-update-pct": `${percent}%` } as CSSProperties) : undefined}
    >
      <span className="r-ico">
        <Icon size={15} className={busy ? "rail-update-spin" : undefined} />
      </span>
      <span className="rail-label">{label}</span>
      {busy ? <span className="rail-update-pct-label rail-label">{percent}%</span> : null}
      {phase === "available" && latestVersion ? (
        <span className="rail-update-version rail-label">v{latestVersion}</span>
      ) : null}
      {phase === "available" ? (
        <>
          <span className="rail-update-star star-1" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-2" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-3" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-4" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-5" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-6" aria-hidden><StarSvg /></span>
        </>
      ) : null}
    </button>
  );
}

export default memo(UpdatePill);

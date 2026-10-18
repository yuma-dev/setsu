// when the player chrome shows, for the library and the feed player alike. activity in the player
// zone (the frame, the chevrons) shows it and arms a timer; the timer hides it unless the pointer is
// over chrome, a press that started on chrome is held, a chrome input has focus, a popover is open,
// or the video is paused with the pointer in the zone. leaving the zone hides it after a short
// grace that covers the trip out to a chevron, the backdrop never brings it back. legacy no longer
// touches the visible class.

const IDLE_MS = 2000;
const LEAVE_MS = 250;
const CHROME = "#video-controls .pl-pill, .video-nav-button, #audio-tracks-panel";
const ZONE = "#fullscreen-player, .video-nav-button";
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

export interface ChromeTargets {
  overlay: HTMLElement;
  controls: HTMLElement;
  /** read on every check, the feed remounts its video per clip */
  video: () => HTMLVideoElement | null;
  /** keys only count while this holds */
  isOpen: () => boolean;
}

export function installChromeVisibility({ overlay, controls, video, isOpen }: ChromeTargets): () => void {
  let timer: number | undefined;
  let hoverChrome = false;
  let inZone = false;
  let interacting = false;
  let last = { x: -1, y: -1 };

  // typing into the title keeps the chrome up, the input would vanish mid word otherwise; an
  // open layer popover, add menu or volume mixer holds it the same way
  const editing = () => {
    const el = document.activeElement;
    if (el && controls.contains(el) && el.matches("input, textarea")) return true;
    return !!controls.querySelector(".pl-lp, .pl-add-menu, #audio-tracks-panel:not(.hidden)");
  };
  const kept = () => interacting || hoverChrome || editing() || (inZone && (video()?.paused ?? true));
  const schedule = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (kept()) schedule(inZone ? IDLE_MS : LEAVE_MS);
      else controls.classList.remove("visible");
    }, ms);
  };
  const show = () => {
    controls.classList.add("visible");
    schedule(IDLE_MS);
  };
  const leave = () => {
    if (controls.classList.contains("visible")) schedule(LEAVE_MS);
  };
  const track = (target: EventTarget | null) => {
    const el = target as HTMLElement;
    hoverChrome = !!el.closest?.(CHROME);
    inZone = !!el.closest?.(ZONE);
  };

  // chromium fires a synthetic mousemove when the cursor style changes under a still pointer
  // (hiding the chrome hides the cursor), so only real movement counts
  const onMove = (e: MouseEvent) => {
    if (e.clientX === last.x && e.clientY === last.y) return;
    last = { x: e.clientX, y: e.clientY };
    track(e.target);
    if (inZone) show();
    else leave();
  };
  const onOver = (e: MouseEvent) => track(e.target);
  const onLeave = () => {
    hoverChrome = false;
    inZone = false;
    leave();
  };
  const onDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest?.(CHROME)) interacting = true;
  };
  const onUp = () => {
    if (!interacting) return;
    interacting = false;
    schedule(inZone ? IDLE_MS : LEAVE_MS);
  };
  const onKey = (e: KeyboardEvent) => {
    if (isOpen() && !MODIFIERS.has(e.key)) show();
  };
  const onActivity = () => show();
  // media events don't bubble but do pass an ancestor's capture listener; hover previews and
  // the export's temp video live in the overlay too, hence the target check
  const onMedia = (e: Event) => {
    if (e.target !== video()) return;
    if (e.type === "play") schedule(IDLE_MS);
    else show();
  };

  overlay.addEventListener("mousemove", onMove);
  overlay.addEventListener("mouseover", onOver);
  overlay.addEventListener("mouseleave", onLeave);
  overlay.addEventListener("play", onMedia, true);
  overlay.addEventListener("pause", onMedia, true);
  overlay.addEventListener("loadedmetadata", onMedia, true);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("mouseup", onUp, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("player-activity", onActivity);
  document.addEventListener("clip-open-state", onActivity);

  return () => {
    window.clearTimeout(timer);
    overlay.removeEventListener("mousemove", onMove);
    overlay.removeEventListener("mouseover", onOver);
    overlay.removeEventListener("mouseleave", onLeave);
    overlay.removeEventListener("play", onMedia, true);
    overlay.removeEventListener("pause", onMedia, true);
    overlay.removeEventListener("loadedmetadata", onMedia, true);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("mouseup", onUp, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("player-activity", onActivity);
    document.removeEventListener("clip-open-state", onActivity);
  };
}

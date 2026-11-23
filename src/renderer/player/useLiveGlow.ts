import { useEffect, useRef, type RefObject } from "react";
import type { AmbientGlowSettings } from "../settings/SettingsContext";

// longer side of the sampled frame in px, the css blur does the rest
const SIZE = 32;

/** paints the video into the glow canvases at the settings' update rate, each sample blended into the
 *  last by `smoothing`. the thumbnail stands in until the clip's first frame decodes */
export function useLiveGlow(
  getVideo: () => HTMLVideoElement | null,
  canvases: RefObject<HTMLCanvasElement | null>[],
  thumbUrl: string | null,
  glow: AmbientGlowSettings,
  active: boolean,
) {
  // read per tick so a settings change doesn't restart the loop
  const settingsRef = useRef(glow);
  settingsRef.current = glow;
  const getVideoRef = useRef(getVideo);
  getVideoRef.current = getVideo;
  const canvasesRef = useRef(canvases);
  canvasesRef.current = canvases;

  useEffect(() => {
    const els = canvasesRef.current.map((r) => r.current).filter((c): c is HTMLCanvasElement => c != null);
    const video = getVideoRef.current();
    if (!video || els.length === 0) return;
    const [main, ...copies] = els;
    if (!active) {
      for (const c of els) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      return;
    }
    const ctx = main.getContext("2d");
    if (!ctx) return;

    let filled = false;
    let fromVideo = false;
    const paint = (src: CanvasImageSource, sw: number, sh: number, blend: number) => {
      if (sw <= 0 || sh <= 0) return;
      const ar = sw / sh;
      const w = ar >= 1 ? SIZE : Math.max(1, Math.round(SIZE * ar));
      const h = ar >= 1 ? Math.max(1, Math.round(SIZE / ar)) : SIZE;
      // resizing wipes the canvas, so that sample goes in whole
      if (main.width !== w || main.height !== h) {
        main.width = w;
        main.height = h;
        filled = false;
      }
      ctx.globalAlpha = filled ? blend : 1;
      try {
        ctx.drawImage(src, 0, 0, w, h);
      } catch {
        return;
      }
      ctx.globalAlpha = 1;
      filled = true;
      for (const c of copies) {
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const cc = c.getContext("2d");
        cc?.clearRect(0, 0, w, h);
        cc?.drawImage(main, 0, 0);
      }
    };
    const paintVideo = (blend: number) => {
      if (video.readyState < 2) return;
      fromVideo = true;
      paint(video, video.videoWidth, video.videoHeight, blend);
    };

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = 0;
      if (video.paused || video.ended) return;
      const { fps, smoothing } = settingsRef.current;
      // the glow sits outside the fullscreen element, nothing to paint for
      if (!document.fullscreenElement && now - last >= 1000 / (fps || 30)) {
        last = now;
        paintVideo(smoothing || 0.5);
      }
      raf = requestAnimationFrame(tick);
    };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onPlay = () => {
      if (reduceMotion || raf) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const onJump = () => paintVideo(1);
    const onPause = () => paintVideo(settingsRef.current.smoothing || 0.5);
    const onFullscreen = () => {
      if (!document.fullscreenElement) paintVideo(1);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onJump);
    video.addEventListener("loadeddata", onJump);
    document.addEventListener("fullscreenchange", onFullscreen);

    // reruns on a clip switch: the video may already hold the new clip's frame
    paintVideo(1);
    if (!video.paused) onPlay();
    let img: HTMLImageElement | null = null;
    if (!fromVideo && thumbUrl) {
      img = new Image();
      img.onload = () => {
        if (img && !fromVideo) paint(img, img.naturalWidth, img.naturalHeight, 1);
      };
      img.src = thumbUrl;
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (img) img.onload = null;
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onJump);
      video.removeEventListener("loadeddata", onJump);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [active, thumbUrl]);
}

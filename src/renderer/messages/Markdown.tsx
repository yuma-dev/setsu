import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { parseMarkdown, type Block, type ButtonSpec, type Inline } from "./parse";
import { compareVersions, getMediaOverride, inRange, MEDIA_BASE } from "./feed";
import { openExternal } from "../ui/openExternal";
import { useAppNav } from "../shell/appNav";
import { reportUpdateAvailable, startUpdateDownload } from "../shell/useUpdater";

export interface MessageEnv {
  /** installed version, or the designer's simulated one */
  version: string;
  /** relative media path to a url; the designer maps drafts to local files */
  media?: (src: string) => string;
  /** the designer turns real actions into a note instead */
  dry?: boolean;
}

const EnvContext = createContext<MessageEnv>({ version: "0.0.0" });

const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

function useMedia(src: string): string {
  const env = useContext(EnvContext);
  if (/^https:\/\//i.test(src)) return src;
  const local = env.media ?? getMediaOverride();
  return local ? local(src) : MEDIA_BASE + src.replace(/^\/+/, "");
}

function cond(c: Record<string, string>, v: string): boolean {
  if (c.below && !(compareVersions(v, c.below) < 0)) return false;
  if (c.atMost && !(compareVersions(v, c.atMost) <= 0)) return false;
  if (c.is && compareVersions(v, c.is) !== 0) return false;
  if (c.atLeast && !(compareVersions(v, c.atLeast) >= 0)) return false;
  if (c.above && !(compareVersions(v, c.above) > 0)) return false;
  if (c.range && !inRange(v, c.range)) return false;
  return true;
}

function MediaEl({ src, loop, className, autoPlay = true }: { src: string; loop?: boolean; className?: string; autoPlay?: boolean }) {
  const url = useMedia(src);
  return VIDEO_EXT.test(src) ? (
    <video className={className} src={url} muted playsInline autoPlay={autoPlay} loop={loop ?? true} />
  ) : (
    <img className={className} src={url} alt="" draggable={false} />
  );
}

/** text with a dotted underline, previews its media above the bubble while hovered */
function Hover({ src, children }: { src: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const width = 260;
  return (
    <>
      <span
        ref={ref}
        className="msg-hover"
        onMouseEnter={() => setRect(ref.current?.getBoundingClientRect() ?? null)}
        onMouseLeave={() => setRect(null)}
      >
        {children}
      </span>
      {rect
        ? createPortal(
            <div
              className="msg-hover-pop"
              style={{
                width,
                left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)),
                bottom: window.innerHeight - rect.top + 8,
              }}
            >
              <MediaEl src={src} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="msg-lightbox" onClick={onClose}>
      <MediaEl src={src} className="msg-lightbox-media" />
    </div>,
    document.body,
  );
}

function InlineMedia({ src, loop }: { src: string; loop: boolean }) {
  const [big, setBig] = useState(false);
  return (
    <>
      <button type="button" className="msg-media" onClick={() => setBig(true)} title="Click to enlarge">
        <MediaEl src={src} loop={loop} />
      </button>
      {big ? <Lightbox src={src} onClose={() => setBig(false)} /> : null}
    </>
  );
}

function Buttons({ buttons }: { buttons: ButtonSpec[] }) {
  const env = useContext(EnvContext);
  const nav = useAppNav();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const run = async (b: ButtonSpec) => {
    if (env.dry) {
      setStatus(b.action === "update" ? "Would check for an update" : b.href ? `Would open ${b.href}` : `Would go to ${b.to}`);
      return;
    }
    if (b.href) return openExternal(b.href);
    if (b.to) {
      const [route, section] = b.to.split("/");
      if (route === "settings") nav.openSettings(section);
      else if (route === "library") nav.openLibrary();
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const r = await window.clips.checkForUpdates();
      if (r?.updateAvailable) {
        reportUpdateAvailable(r.latestVersion ?? null, r.changelog ?? null);
        void startUpdateDownload();
        setStatus("Downloading, Setsu restarts into the installer when it's done.");
      } else {
        setStatus(r?.error ? "Couldn't reach GitHub, try again in a bit." : "You're already on the newest version.");
      }
    } catch {
      setStatus("Couldn't check for updates.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msg-buttons">
      <div className="msg-buttons-row">
        {buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            className={`msg-btn${b.action === "update" || i === 0 ? " msg-btn-primary" : ""}`}
            disabled={busy && b.action === "update"}
            onClick={() => void run(b)}
          >
            {busy && b.action === "update" ? <Loader2 size={13} className="spin" /> : null}
            {b.label}
            {b.href ? <ArrowUpRight size={13} /> : null}
          </button>
        ))}
      </div>
      {status ? <div className="msg-buttons-status">{status}</div> : null}
    </div>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const env = useContext(EnvContext);
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <span key={i}>{n.v}</span>;
          case "version":
            return <span key={i}>{env.version}</span>;
          case "bold":
            return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case "italic":
            return <em key={i}><Inlines nodes={n.c} /></em>;
          case "code":
            return <code key={i}>{n.v}</code>;
          case "link":
            return (
              <a
                key={i}
                href={n.href}
                onClick={(e) => {
                  e.preventDefault();
                  if (!env.dry) openExternal(n.href);
                }}
              >
                <Inlines nodes={n.c} />
              </a>
            );
          case "hover":
            return (
              <Hover key={i} src={n.src}>
                <Inlines nodes={n.c} />
              </Hover>
            );
        }
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  const env = useContext(EnvContext);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <p key={i}>
                {b.c.map((line, j) => (
                  <span key={j}>
                    {j ? <br /> : null}
                    <Inlines nodes={line} />
                  </span>
                ))}
              </p>
            );
          case "h":
            return <h4 key={i}><Inlines nodes={b.c} /></h4>;
          case "list":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}><Inlines nodes={it} /></li>
                ))}
              </ul>
            );
          case "image":
          case "video":
            return <InlineMedia key={i} src={b.src} loop={b.loop || b.t === "image"} />;
          case "buttons":
            return <Buttons key={i} buttons={b.buttons} />;
          case "if":
            return <Blocks key={i} blocks={cond(b.cond, env.version) ? b.then : b.else} />;
        }
      })}
    </>
  );
}

export default function Markdown({ source, env, className }: { source: string; env: MessageEnv; className?: string }) {
  const parsed = useMemo(() => parseMarkdown(source), [source]);
  return (
    <EnvContext.Provider value={env}>
      <div className={`msg-md${className ? ` ${className}` : ""}`}>
        <Blocks blocks={parsed.blocks} />
      </div>
    </EnvContext.Provider>
  );
}

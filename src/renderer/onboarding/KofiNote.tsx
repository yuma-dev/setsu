import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Coffee, X } from "lucide-react";
import { useSettings } from "../settings/SettingsContext";
import { ONBOARDING_VERSION } from "./version";
import { afterIntro } from "../boot/bootHold";
import { KOFI_URL, openExternal } from "../ui/openExternal";
import { markKofiNoteShown } from "../shell/kofiSession";

// github serves the current profile picture here, so changing it there changes it in the app
const AVATAR_URL = "https://github.com/yuma-dev.png?size=128";
const TYPING_MS = 900;

// release:preview writes RELEASE_NOTE.md, the build bakes it in with the version it belongs to.
// gitignored and absent in a fresh checkout, the glob just comes back empty then
const baked = Object.values(
  import.meta.glob<{ version: string; text: string }>("../release-note.generated.json", { eager: true, import: "default" }),
)[0];

const DEFAULT_LINE = (v: string) => `Setsu just updated to v${v}. Thanks for sticking around.`;

// same cleanup as scripts/gen-release-note.mjs
function cleanNote(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RELEASE_NOTE.md at the repo root as it is right now, dev runs start electron from there.
 * null when there is no such file (packaged app, or no release:preview yet) */
function readDraftNote(): string | null {
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const fs = req?.("fs") as typeof import("fs") | undefined;
    const path = req?.("path") as typeof import("path") | undefined;
    if (!fs || !path) return null;
    return cleanNote(fs.readFileSync(path.join(process.cwd(), "RELEASE_NOTE.md"), "utf8"));
  } catch {
    return null;
  }
}

function noteFor(version: string, draft: string | null): string {
  const text = draft ?? (baked?.version === version ? baked.text.trim() : "");
  if (!text) return DEFAULT_LINE(version);
  // the greeting is ours, a note typed as "Hey, ..." anyway shouldn't say it twice
  const rest = text.replace(/^hey,?\s*/i, "");
  // "Hey, This update" reads wrong, but "I" and names keep their capital
  return /^[A-Z][a-z]/.test(rest) ? rest[0].toLowerCase() + rest.slice(1) : rest;
}

// a long note gets time to be read before it slides away
function shownMs(text: string): number {
  return Math.min(60000, 12000 + text.length * 70);
}

/** once per update, bottom right: my avatar, "Hey, " plus the note for this release, and the
 * ko-fi ask under it.
 * settings.lastRunVersion holds the version it last ran as. a fresh install records it
 * silently, the tour is enough on day one. from devtools: __showKofiNote() */
export default function KofiNote() {
  const { settings, ready, set } = useSettings();
  const [version, setVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(true);
  const [avatarOk, setAvatarOk] = useState(true);
  // set by __previewKofiNote, wins over the baked note
  const [draft, setDraft] = useState<string | null>(null);
  const checked = useRef(false);
  const hovered = useRef(false);

  useEffect(() => {
    window.clips
      .getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const show = useCallback((draftText: string | null = null) => {
    setDraft(draftText);
    setTyping(true);
    setOpen(true);
    markKofiNoteShown();
  }, []);

  const cancelWait = useRef<() => void>(() => {});
  useEffect(() => () => cancelWait.current(), []);
  useEffect(() => {
    if (!ready || !version || checked.current) return;
    checked.current = true;
    const last = String(settings.lastRunVersion ?? "");
    if (last === version) return;
    void set("lastRunVersion", version);
    const freshInstall = Number(settings.onboardingVersion ?? 0) < ONBOARDING_VERSION;
    if (freshInstall) return;
    cancelWait.current = afterIntro(() => show());
  }, [ready, version, settings.lastRunVersion, settings.onboardingVersion, set, show]);

  // __showKofiNote: what this build ships. __previewKofiNote: RELEASE_NOTE.md as typed right now,
  // re-run it after editing the file
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__showKofiNote = () => {
      show();
      return baked?.text ? `kofi note: baked note for v${baked.version}` : "kofi note: no baked note, default line";
    };
    w.__previewKofiNote = () => {
      const text = readDraftNote();
      if (text === null) return "kofi note: no RELEASE_NOTE.md in the working dir, run npm run release:preview";
      show(text);
      return text ? "kofi note: previewing RELEASE_NOTE.md" : "kofi note: RELEASE_NOTE.md is empty, default line";
    };
  }, [show]);

  useEffect(() => {
    if (!open || !typing) return;
    const t = window.setTimeout(() => setTyping(false), TYPING_MS);
    return () => window.clearTimeout(t);
  }, [open, typing]);

  // slides away on its own unless the pointer is resting on it
  const text = noteFor(version ?? "", draft);
  useEffect(() => {
    if (!open || typing) return;
    const t = window.setInterval(() => {
      if (!hovered.current) setOpen(false);
    }, shownMs(text));
    return () => window.clearInterval(t);
  }, [open, typing, text]);

  const tip = () => {
    openExternal(KOFI_URL);
    setOpen(false);
  };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="kofi-note"
          role="dialog"
          aria-label="A note from the developer"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12, transition: { duration: 0.18 } }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          onMouseEnter={() => (hovered.current = true)}
          onMouseLeave={() => (hovered.current = false)}
        >
          <motion.div
            className="kofi-note-bubble"
            initial={{ opacity: 0, scale: 0.9, x: 10 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{ delay: 0.15, type: "spring", stiffness: 420, damping: 30 }}
          >
            <button type="button" className="kofi-note-close" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={13} />
            </button>
            <div className="kofi-note-name">
              yuma{version ? <span className="kofi-note-version">v{version}</span> : null}
            </div>
            {typing ? (
              <div className="kofi-note-typing" aria-label="typing">
                <span />
                <span />
                <span />
              </div>
            ) : (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
                <p className="kofi-note-text">Hey, {text}</p>
                <p className="kofi-note-ask">Setsu is free and made by just me. If it helps you, even a coffee helps me.</p>
                <div className="kofi-note-actions">
                  <button type="button" className="kofi-note-tip" onClick={tip}>
                    <Coffee size={14} /> Buy me a coffee
                  </button>
                  <button type="button" className="kofi-note-later" onClick={() => setOpen(false)}>
                    Not now
                  </button>
                </div>
              </motion.div>
            )}
          </motion.div>
          <motion.div
            className="kofi-note-avatar"
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
          >
            {avatarOk ? (
              <img src={AVATAR_URL} alt="" draggable={false} onError={() => setAvatarOk(false)} />
            ) : (
              <Coffee size={20} />
            )}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

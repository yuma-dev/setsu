import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Coffee, Info, ShieldAlert, TriangleAlert, X } from "lucide-react";
import Markdown, { type MessageEnv } from "./Markdown";
import type { Broadcast, Level, Note } from "./feed";

// github serves the current profile picture here, so changing it there changes it in the app
export const AVATAR_URL = "https://github.com/yuma-dev.png?size=128";

export const LEVEL_META: Record<Level, { label: string; Icon: typeof Info }> = {
  info: { label: "Announcement", Icon: Info },
  warning: { label: "Heads up", Icon: TriangleAlert },
  critical: { label: "Important", Icon: ShieldAlert },
};

export function Avatar({ level, size = 52 }: { level?: Level; size?: number }) {
  const [ok, setOk] = useState(true);
  const Badge = level ? LEVEL_META[level].Icon : null;
  return (
    <div className={`msg-avatar${level ? ` msg-avatar--${level}` : ""}`} style={{ width: size, height: size }}>
      <div className="msg-avatar-img">
        {ok ? <img src={AVATAR_URL} alt="" draggable={false} onError={() => setOk(false)} /> : <Coffee size={size * 0.38} />}
      </div>
      {Badge ? (
        <span className="msg-avatar-badge">
          <Badge size={12} strokeWidth={2.4} />
        </span>
      ) : null}
    </div>
  );
}

// first words that stay capitalised after "Hey, "
const NAMES = new Set(["Setsu", "Discord", "GitHub", "Windows", "Steam", "Epic", "Fortnite", "Valorant", "NVIDIA", "AMD", "Intel", "Ko-fi", "I", "I'm", "I've", "I'll"]);

/** "Hey, " in front of the note. a note typed as "Hey, ..." anyway doesn't say it twice, and
 * "Hey, This" reads wrong but "I" and names keep their capital */
export function greet(body: string): string {
  const rest = body.trim().replace(/^hey,?\s*/i, "");
  if (!/^[A-Za-z"'(*_]/.test(rest)) return `Hey!\n\n${rest}`;
  const first = rest.split(/[\s,.!?:;]/)[0];
  return `Hey, ${/^[A-Z][a-z]/.test(rest) && !NAMES.has(first) ? rest[0].toLowerCase() + rest.slice(1) : rest}`;
}

export const DEFAULT_NOTE = "Setsu just updated to v{{version}}. Thanks for sticking around.";

const popIn = {
  initial: { opacity: 0, scale: 0.92, x: 10 },
  animate: { opacity: 1, scale: 1, x: 0 },
  transition: { delay: 0.12, type: "spring" as const, stiffness: 420, damping: 30 },
};

export function NotesCard({
  notes,
  env,
  typing,
  onClose,
  onTip,
}: {
  notes: Note[];
  env: MessageEnv;
  typing: boolean;
  onClose: () => void;
  onTip: () => void;
}) {
  const [page, setPage] = useState(0);
  const note = notes[Math.min(page, notes.length - 1)];
  const last = page >= notes.length - 1;
  return (
    <motion.div className="msg-bubble" {...popIn}>
      <button type="button" className="msg-close" aria-label="Close" onClick={onClose}>
        <X size={13} />
      </button>
      <div className="msg-head">
        <span className="msg-name">yuma</span>
        <span className="msg-chip">v{note.version}</span>
        {notes.length > 1 ? (
          <span className="msg-pager">
            <button type="button" aria-label="Newer" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft size={14} />
            </button>
            {page + 1} of {notes.length}
            <button type="button" aria-label="Older" disabled={last} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight size={14} />
            </button>
          </span>
        ) : null}
      </div>
      {typing ? (
        <div className="msg-typing" aria-label="typing">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <motion.div key={page} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
          <Markdown source={greet(note.body || DEFAULT_NOTE)} env={{ ...env, version: note.version }} className="msg-body" />
          {last ? (
            <>
              <p className="msg-ask">Setsu is free and made by just me. If it helps you, even a coffee helps me.</p>
              <div className="msg-actions">
                <button type="button" className="msg-tip" onClick={onTip}>
                  <Coffee size={14} /> Buy me a coffee
                </button>
                <button type="button" className="msg-later" onClick={onClose}>
                  Not now
                </button>
              </div>
            </>
          ) : (
            <div className="msg-actions">
              <button type="button" className="msg-next" onClick={() => setPage((p) => p + 1)}>
                Older update <ChevronRight size={14} />
              </button>
              <button type="button" className="msg-later" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

export function BroadcastCard({ broadcast, env, onClose }: { broadcast: Broadcast; env: MessageEnv; onClose: () => void }) {
  const { label, Icon } = LEVEL_META[broadcast.level];
  return (
    <motion.div className={`msg-bubble msg-bubble--broadcast msg-level--${broadcast.level}`} {...popIn}>
      <button type="button" className="msg-close" aria-label="Close" onClick={onClose}>
        <X size={13} />
      </button>
      <div className="msg-head">
        <span className="msg-level-label">
          <Icon size={12} strokeWidth={2.4} />
          {label}
        </span>
      </div>
      {broadcast.title ? <div className="msg-title">{broadcast.title}</div> : null}
      <Markdown source={broadcast.body} env={env} className="msg-body" />
      <div className="msg-actions msg-actions--end">
        <button type="button" className="msg-later" onClick={onClose}>
          {broadcast.level === "critical" ? "Later" : "Got it"}
        </button>
      </div>
    </motion.div>
  );
}

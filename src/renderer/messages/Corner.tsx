import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useSettings } from "../settings/SettingsContext";
import { ONBOARDING_VERSION } from "../onboarding/version";
import { afterIntro } from "../boot/bootHold";
import { KOFI_URL, openExternal } from "../ui/openExternal";
import { markKofiNoteShown } from "../shell/kofiSession";
import { Avatar, BroadcastCard, NotesCard } from "./Cards";
import type { MessageEnv } from "./Markdown";
import {
  broadcastKey,
  broadcastLive,
  compareVersions,
  currentFeed,
  noteKey,
  notesSince,
  refreshFeed,
  sortBroadcasts,
  startFeedPolling,
  useFeed,
  type Broadcast,
  type Feed,
  type Note,
} from "./feed";
import { useMessagePrefs } from "./prefs";

const TYPING_MS = 900;
// the version just installed usually has a note newer than the cached feed, so launch waits this
// long for the first fetch before falling back to the cache
const FIRST_FETCH_WAIT_MS = 6000;

// dev: the designer's "show it in the app" hands its cards to the mounted corner
let showHandler: ((items: CornerItem[]) => void) | null = null;
export function showInCorner(items: CornerItem[]): void {
  showHandler?.(items);
}

export type CornerItem = { id: string; kind: "broadcast"; broadcast: Broadcast } | { id: string; kind: "notes"; notes: Note[] };

/** one card plus my avatar. the corner and the designer preview both draw this */
export function CornerCard({
  item,
  env,
  typing,
  onClose,
  onTip,
  className = "msg-corner",
}: {
  item: CornerItem;
  env: MessageEnv;
  typing: boolean;
  onClose: () => void;
  onTip: () => void;
  className?: string;
}) {
  return (
    <motion.div
      key={item.id}
      className={className}
      role="dialog"
      aria-label={item.kind === "notes" ? "A note from the developer" : "Announcement"}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
    >
      {item.kind === "notes" ? (
        <NotesCard notes={item.notes} env={env} typing={typing} onClose={onClose} onTip={onTip} />
      ) : (
        <BroadcastCard broadcast={item.broadcast} env={env} onClose={onClose} />
      )}
      <motion.div
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 22 }}
      >
        <Avatar level={item.kind === "broadcast" ? item.broadcast.level : undefined} />
      </motion.div>
    </motion.div>
  );
}

/** what the corner shows for this feed: live broadcasts first, then notes since lastRun (the default
 * line when the installed version has none). used at launch and by the designer's simulation */
export function buildQueue(
  feed: Feed,
  opts: { version: string; lastRun: string; fresh: boolean; dismissed: readonly string[]; skip?: ReadonlySet<string> },
): CornerItem[] {
  const items: CornerItem[] = [];
  const live = feed.broadcasts.filter(
    (b) =>
      broadcastLive(b, opts.version) &&
      !opts.skip?.has(b.id) &&
      (b.level === "critical" || !opts.dismissed.includes(b.id)),
  );
  for (const b of sortBroadcasts(live)) items.push({ id: `bc:${b.id}`, kind: "broadcast", broadcast: b });
  if (!opts.fresh && opts.lastRun !== opts.version) {
    const notes = notesSince(feed, opts.lastRun, opts.version);
    items.push({ id: `notes:${opts.version}`, kind: "notes", notes: notes.length ? notes : [{ version: opts.version, body: "" }] });
  }
  return items;
}

// single-page items slide away on their own unless hovered; a long note gets more time
function shownMs(item: CornerItem): number | null {
  if (item.kind !== "notes" || item.notes.length > 1) return null;
  return Math.min(60000, 12000 + (item.notes[0].body.length || 60) * 70);
}

export default function Corner() {
  const { settings } = useSettings();
  const prefs = useMessagePrefs();
  const feed = useFeed();
  const [version, setVersion] = useState<string | null>(null);
  const [queue, setQueue] = useState<CornerItem[]>([]);
  const [typing, setTyping] = useState(true);
  const launched = useRef(false);
  // set once the launch queue is built, mid-session broadcasts wait for it so nothing shows during the intro
  const launchDone = useRef(false);
  const queuedBroadcasts = useRef(new Set<string>());
  const hovered = useRef(false);
  const current = queue[0] ?? null;

  useEffect(() => {
    window.clips
      .getAppVersion()
      .then(setVersion)
      .catch(() => {});
    startFeedPolling();
  }, []);

  const enqueue = useCallback((items: CornerItem[], replace = false) => {
    for (const it of items) if (it.kind === "broadcast") queuedBroadcasts.current.add(it.broadcast.id);
    setQueue((q) => (replace ? items : [...q, ...items.filter((it) => !q.some((x) => x.id === it.id))]));
  }, []);

  // launch, packaged builds only: dev shares settings.json with the installed app (see prefs.ts),
  // dev looks at messages through __designer() and __corner()
  const cancelWait = useRef<() => void>(() => {});
  useEffect(() => () => cancelWait.current(), []);
  useEffect(() => {
    if (import.meta.env.DEV || !prefs.ready || !version || launched.current) return;
    launched.current = true;
    const lastRun = prefs.lastRunVersion;
    const fresh = Number(settings.onboardingVersion ?? 0) < ONBOARDING_VERSION;
    if (lastRun !== version) prefs.setLastRun(version);
    cancelWait.current = afterIntro(() => {
      void Promise.race([refreshFeed(), new Promise((r) => window.setTimeout(r, FIRST_FETCH_WAIT_MS))]).then(() => {
        const f = currentFeed();
        // old notes are history for someone new, not unread
        if (fresh) prefs.markRead(f.notes.map(noteKey));
        enqueue(buildQueue(f, { version, lastRun, fresh, dismissed: prefs.dismissed }));
        launchDone.current = true;
      });
    });
  }, [prefs, version, settings.onboardingVersion, enqueue]);

  // mid-session: the 3 h refetch shows new broadcasts as soon as the corner is free
  useEffect(() => {
    if (import.meta.env.DEV || !launchDone.current || !version) return;
    const fresh = buildQueue(feed, { version, lastRun: version, fresh: true, dismissed: prefs.dismissed, skip: queuedBroadcasts.current });
    if (fresh.length) enqueue(fresh);
  }, [feed, version, prefs.dismissed, enqueue]);

  // dev: __corner("3.8.0") shows what someone coming from 3.8.0 gets, dismissals ignored
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    showHandler = (items) => {
      queuedBroadcasts.current.clear();
      enqueue(items, true);
    };
    (window as unknown as Record<string, unknown>).__corner = (lastRun?: string) => {
      const v = version ?? "0.0.0";
      const f = currentFeed();
      const older = f.notes.map((n) => n.version).filter((x) => compareVersions(x, v) <= 0).sort(compareVersions);
      const from = lastRun ?? older.at(-2) ?? "";
      queuedBroadcasts.current.clear();
      enqueue(buildQueue(f, { version: v, lastRun: from, fresh: false, dismissed: [] }), true);
      return `corner: v${v}, coming from ${from || "nothing"}`;
    };
  }, [version, enqueue]);

  useEffect(() => {
    if (!current) return;
    if (current.kind === "notes") {
      markKofiNoteShown();
      prefs.markRead(current.notes.filter((n) => n.body).map(noteKey));
    } else {
      prefs.markRead([broadcastKey(current.broadcast)]);
    }
    setTyping(current.kind === "notes");
    // keyed on the card id only, prefs changes on every markRead
  }, [current?.id]);

  useEffect(() => {
    if (!typing) return;
    const t = window.setTimeout(() => setTyping(false), TYPING_MS);
    return () => window.clearTimeout(t);
  }, [typing, current?.id]);

  const close = useCallback(() => {
    setQueue((q) => {
      const [head, ...rest] = q;
      if (head?.kind === "broadcast" && head.broadcast.level !== "critical") prefs.dismiss(head.broadcast.id);
      return rest;
    });
  }, [prefs]);

  useEffect(() => {
    if (!current || typing) return;
    const ms = shownMs(current);
    if (ms == null) return;
    const t = window.setInterval(() => {
      if (!hovered.current) close();
    }, ms);
    return () => window.clearInterval(t);
  }, [current, typing, close]);

  const tip = () => {
    openExternal(KOFI_URL);
    close();
  };

  return createPortal(
    <div onMouseEnter={() => (hovered.current = true)} onMouseLeave={() => (hovered.current = false)}>
      <AnimatePresence mode="wait">
        {current && version ? (
          <CornerCard key={current.id} item={current} env={{ version }} typing={typing} onClose={close} onTip={tip} />
        ) : null}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

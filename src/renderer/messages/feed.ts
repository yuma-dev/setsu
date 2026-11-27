import { useSyncExternalStore } from "react";

// release notes and broadcasts, written with the dev designer into github.com/yuma-dev/setsu-messages.
// raw.githubusercontent caches for 5 min (max-age=300) and sends ACAO *, so a plain fetch works
export const FEED_REPO = "yuma-dev/setsu-messages";
export const FEED_URL = `https://raw.githubusercontent.com/${FEED_REPO}/main/feed.json`;
export const MEDIA_BASE = `https://raw.githubusercontent.com/${FEED_REPO}/main/`;
/** feeds with a higher format are skipped, the cached one stays */
export const FEED_FORMAT = 1;
const REFRESH_MS = 3 * 60 * 60 * 1000;
const CACHE_KEY = "setsu.messages.feed.v1";

export type Level = "info" | "warning" | "critical";

export interface Note {
  version: string;
  date?: string;
  minApp?: string;
  body: string;
}

export interface Broadcast {
  id: string;
  level: Level;
  title?: string;
  /** installed versions it is for, e.g. "<3.9.1" or ">=3.8.6 <3.9.2". missing means everyone */
  versions?: string;
  start?: string;
  end?: string;
  minApp?: string;
  body: string;
}

export interface Feed {
  format: number;
  notes: Note[];
  broadcasts: Broadcast[];
}

export const EMPTY_FEED: Feed = { format: FEED_FORMAT, notes: [], broadcasts: [] };

// versions

export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** space separated comparators, all must hold: "<3.9.1", ">=3.8.6 <3.9.2", "3.9.0". null for bad syntax */
export function parseRange(range: string): ((v: string) => boolean) | null {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || (parts.length === 1 && parts[0] === "*")) return () => true;
  const tests: ((v: string) => boolean)[] = [];
  for (const p of parts) {
    const m = /^(<=|>=|<|>|=)?(v?\d+\.\d+\.\d+)$/.exec(p);
    if (!m) return null;
    const op = m[1] ?? "=";
    const ref = m[2];
    tests.push((v) => {
      const c = compareVersions(v, ref);
      return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === ">=" ? c >= 0 : c === 0;
    });
  }
  return (v) => tests.every((t) => t(v));
}

export function inRange(version: string, range: string | undefined): boolean {
  if (!range?.trim()) return true;
  const test = parseRange(range);
  return test ? test(version) : false;
}

// feed parsing, anything malformed is dropped instead of breaking the corner

const LEVELS: Level[] = ["info", "warning", "critical"];
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function readFeed(raw: unknown): Feed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const format = Number(r.format);
  if (!Number.isFinite(format) || format > FEED_FORMAT) return null;
  const notes: Note[] = [];
  for (const n of Array.isArray(r.notes) ? r.notes : []) {
    const version = str(n?.version);
    const body = typeof n?.body === "string" ? n.body : "";
    if (!version || !parseVersion(version)) continue;
    notes.push({ version, date: str(n.date), minApp: str(n.minApp), body });
  }
  const broadcasts: Broadcast[] = [];
  for (const b of Array.isArray(r.broadcasts) ? r.broadcasts : []) {
    const id = str(b?.id);
    const body = typeof b?.body === "string" ? b.body : "";
    if (!id) continue;
    broadcasts.push({
      id,
      level: LEVELS.includes(b.level) ? b.level : "info",
      title: str(b.title),
      versions: str(b.versions),
      start: str(b.start),
      end: str(b.end),
      minApp: str(b.minApp),
      body,
    });
  }
  return { format, notes, broadcasts };
}

// store: last good feed from localStorage until a fetch lands

function loadCache(): Feed | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? readFeed(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

let feed: Feed | null = loadCache();
/** the designer previews its draft through this */
let override: Feed | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function currentFeed(): Feed {
  return override ?? feed ?? EMPTY_FEED;
}

/** the designer points relative media at its local clone, unpublished files included */
let mediaOverride: ((src: string) => string) | null = null;
export function setMediaOverride(fn: ((src: string) => string) | null): void {
  mediaOverride = fn;
}
export function getMediaOverride(): ((src: string) => string) | null {
  return mediaOverride;
}

export function setFeedOverride(next: Feed | null): void {
  override = next;
  emit();
}

export function useFeed(): Feed {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentFeed,
  );
}

let inflight: Promise<void> | null = null;

export function refreshFeed(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(FEED_URL, { cache: "no-store" });
      if (!res.ok) return;
      const next = readFeed(await res.json());
      if (!next) return;
      feed = next;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      } catch {
        /* cache is a convenience */
      }
      emit();
    } catch {
      /* offline or github down, the cached feed stays */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

let polling = false;
export function startFeedPolling(): void {
  if (polling) return;
  polling = true;
  void refreshFeed();
  window.setInterval(() => void refreshFeed(), REFRESH_MS);
}

// what applies to whom

const today = () => new Date().toISOString().slice(0, 10);

function appOk(minApp: string | undefined, version: string): boolean {
  return !minApp || compareVersions(version, minApp) >= 0;
}

export function broadcastLive(b: Broadcast, version: string, day = today()): boolean {
  if (b.start && day < b.start) return false;
  if (b.end && day > b.end) return false;
  return appOk(b.minApp, version) && inRange(version, b.versions);
}

const LEVEL_ORDER: Record<Level, number> = { critical: 0, warning: 1, info: 2 };

export function sortBroadcasts(list: Broadcast[]): Broadcast[] {
  return [...list].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** most pages the pager shows, someone back after a year doesn't get forty */
export const MAX_NOTE_PAGES = 10;

/** notes after lastRun up to the installed version, newest first */
export function notesSince(f: Feed, lastRun: string, version: string): Note[] {
  return f.notes
    .filter((n) => appOk(n.minApp, version))
    .filter((n) => compareVersions(n.version, version) <= 0)
    .filter((n) => !lastRun || compareVersions(n.version, lastRun) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, MAX_NOTE_PAGES);
}

export const noteKey = (n: Note) => `note:${n.version}`;
export const broadcastKey = (b: Broadcast) => `bc:${b.id}`;

export type HistoryItem = { kind: "note"; note: Note; key: string } | { kind: "broadcast"; broadcast: Broadcast; key: string };

/** the What's new page: notes up to the installed version, broadcasts live now or already read */
export function historyFor(f: Feed, version: string, read: ReadonlySet<string>): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const n of f.notes) {
    if (!appOk(n.minApp, version) || compareVersions(n.version, version) > 0) continue;
    items.push({ kind: "note", note: n, key: noteKey(n) });
  }
  for (const b of f.broadcasts) {
    const key = broadcastKey(b);
    const started = !b.start || today() >= b.start;
    if (!started || !appOk(b.minApp, version)) continue;
    if (broadcastLive(b, version) || read.has(key)) items.push({ kind: "broadcast", broadcast: b, key });
  }
  const dateOf = (i: HistoryItem) => (i.kind === "note" ? i.note.date : i.broadcast.start) ?? "";
  return items.sort((a, b) => {
    const d = dateOf(b).localeCompare(dateOf(a));
    if (d) return d;
    if (a.kind === "note" && b.kind === "note") return compareVersions(b.note.version, a.note.version);
    return 0;
  });
}

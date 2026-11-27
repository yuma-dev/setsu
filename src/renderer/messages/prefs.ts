import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useSettings } from "../settings/SettingsContext";

// npm run dev shares %APPDATA%\Clips\settings.json with the installed app and already runs the
// bumped version. writing these from dev ate the installed app's 3.8.5 note, so dev keeps them in
// memory for the session
const DEV = import.meta.env.DEV;
const READ_CAP = 400;

type Key = "lastRunVersion" | "messagesDismissed" | "messagesRead";
const overlay: Partial<Record<Key, unknown>> = {};
let tick = 0;
const listeners = new Set<() => void>();

export interface MessagePrefs {
  ready: boolean;
  lastRunVersion: string;
  dismissed: string[];
  read: ReadonlySet<string>;
  setLastRun(version: string): void;
  dismiss(id: string): void;
  markRead(keys: string[]): void;
}

export function useMessagePrefs(): MessagePrefs {
  const { settings, set, ready } = useSettings();
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => tick,
  );

  const get = (k: Key): unknown => (DEV && k in overlay ? overlay[k] : settings[k]);
  const lastRunVersion = String(get("lastRunVersion") ?? "");
  const dismissedRaw = get("messagesDismissed");
  const dismissed = Array.isArray(dismissedRaw) ? (dismissedRaw as string[]) : [];
  const readRaw = get("messagesRead");
  const readJoined = Array.isArray(readRaw) ? (readRaw as string[]).join("\n") : "";
  const read = useMemo(() => new Set(readJoined ? readJoined.split("\n") : []), [readJoined]);

  // writes merge into the newest value, two calls in one tick must not drop each other
  const latest = useRef({ dismissed, read });
  latest.current = { dismissed, read };

  const write = useCallback(
    (k: Key, value: unknown) => {
      if (DEV) {
        overlay[k] = value;
        tick++;
        listeners.forEach((l) => l());
      } else {
        void set(k, value);
      }
    },
    [set],
  );

  const setLastRun = useCallback((v: string) => write("lastRunVersion", v), [write]);
  const dismiss = useCallback(
    (id: string) => {
      if (latest.current.dismissed.includes(id)) return;
      const next = [...latest.current.dismissed, id];
      latest.current.dismissed = next;
      write("messagesDismissed", next);
    },
    [write],
  );
  const markRead = useCallback(
    (keys: string[]) => {
      const fresh = keys.filter((k) => !latest.current.read.has(k));
      if (!fresh.length) return;
      const next = new Set([...latest.current.read, ...fresh]);
      latest.current.read = next;
      write("messagesRead", [...next].slice(-READ_CAP));
    },
    [write],
  );

  return { ready, lastRunVersion, dismissed, read, setLastRun, dismiss, markRead };
}

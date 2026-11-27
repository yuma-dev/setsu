import { useEffect, useMemo, useState } from "react";
import { historyFor, useFeed } from "./feed";
import { useMessagePrefs } from "./prefs";

let versionPromise: Promise<string> | null = null;

export function useAppVersion(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    versionPromise ??= window.clips.getAppVersion().catch(() => "0.0.0");
    let live = true;
    void versionPromise.then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, []);
  return v;
}

/** What's new entries this user hasn't seen in the corner or on the page, for the nav dot */
export function useUnreadCount(): number {
  const feed = useFeed();
  const prefs = useMessagePrefs();
  const version = useAppVersion();
  return useMemo(() => {
    if (!version || !prefs.ready) return 0;
    return historyFor(feed, version, prefs.read).filter((i) => !prefs.read.has(i.key)).length;
  }, [feed, version, prefs.ready, prefs.read]);
}

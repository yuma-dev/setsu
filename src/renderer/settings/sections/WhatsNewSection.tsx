import { useEffect, useMemo, useRef } from "react";
import { historyFor, startFeedPolling, useFeed } from "../../messages/feed";
import { useMessagePrefs } from "../../messages/prefs";
import { useAppVersion } from "../../messages/useUnread";
import Markdown from "../../messages/Markdown";
import { Avatar, DEFAULT_NOTE, LEVEL_META, greet } from "../../messages/Cards";

/** every release note up to the installed version and every broadcast that reached this user,
 * newest first. opening it counts them as read */
export default function WhatsNewSection() {
  const feed = useFeed();
  const prefs = useMessagePrefs();
  const version = useAppVersion();

  useEffect(() => startFeedPolling(), []);

  const items = useMemo(
    () => (version ? historyFor(feed, version, prefs.read) : []),
    [feed, version, prefs.read],
  );
  // keys that were unread when they first rendered here keep their "new" tag while the page is open,
  // marking them read below would clear it on the next render otherwise
  const unread = useRef(new Set<string>()).current;
  for (const i of items) if (!prefs.read.has(i.key)) unread.add(i.key);

  useEffect(() => {
    if (prefs.ready && items.length) prefs.markRead(items.map((i) => i.key));
  }, [items, prefs]);

  if (!version) return null;
  if (!items.length) {
    return <p className="whatsnew-empty">Nothing here yet. Notes about each update show up here once they're out.</p>;
  }

  return (
    <div className="whatsnew span-2">
      {items.map((item) => {
        const isNote = item.kind === "note";
        const date = isNote ? item.note.date : item.broadcast.start;
        return (
          <article
            key={item.key}
            className={`whatsnew-item${isNote ? "" : ` msg-level--${item.broadcast.level} whatsnew-item--broadcast`}`}
          >
            <Avatar level={isNote ? undefined : item.broadcast.level} size={34} />
            <div className="whatsnew-main">
              <div className="whatsnew-head">
                {isNote ? (
                  <>
                    <span className="msg-name">yuma</span>
                    <span className="msg-chip">v{item.note.version}</span>
                  </>
                ) : (
                  <>
                    <span className="msg-level-label">{LEVEL_META[item.broadcast.level].label}</span>
                    {item.broadcast.title ? <span className="whatsnew-title">{item.broadcast.title}</span> : null}
                  </>
                )}
                {unread.has(item.key) ? <span className="whatsnew-new">new</span> : null}
                {date ? <span className="whatsnew-date">{date}</span> : null}
              </div>
              <Markdown
                source={isNote ? greet(item.note.body || DEFAULT_NOTE) : item.broadcast.body}
                env={{ version: isNote ? item.note.version : version }}
                className="msg-body"
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

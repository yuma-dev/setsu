import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Bold,
  CircleCheck,
  CloudUpload,
  Code,
  Download,
  Eraser,
  Eye,
  EyeOff,
  GitBranch,
  ImagePlus,
  Italic,
  Link2,
  MousePointerClick,
  MonitorPlay,
  Plus,
  RotateCcw,
  ScanEye,
  Tag,
  Trash2,
} from "lucide-react";
import { useConfirm } from "../../ui/ConfirmDialog";
import { CornerCard, buildQueue, showInCorner, type CornerItem } from "../Corner";
import { parseMarkdown, mediaPaths } from "../parse";
import {
  EMPTY_FEED,
  FEED_REPO,
  broadcastLive,
  compareVersions,
  notesSince,
  parseRange,
  parseVersion,
  setFeedOverride,
  setMediaOverride,
  type Broadcast,
  type Feed,
  type Level,
  type Note,
} from "../feed";
import { useAppVersion } from "../useUnread";
import BlockEditor, { newBlock, pickMedia } from "./BlockEditor";
import { EditorContext, type EditorEnv, type RichApi } from "./RichText";
import { toBlocks, toMarkdown, type DBlock } from "./blocks";
import {
  addMedia,
  cloneRepo,
  discard,
  gitError,
  hasClone,
  localMedia,
  mediaExists,
  pendingChanges,
  publish,
  readDraft,
  readLive,
  repoDir,
  setRepoDir,
  writeDraft,
} from "./repo";
import { takeRequestedVersion } from "./request";

// dev-only Settings tab, laid out like a markdown editor: messages on the left, the document under
// one toolbar, the real bubble floating bottom right where it sits in the app. every change is saved to the local
// clone of github.com/yuma-dev/setsu-messages right away; nothing is live until Publish

type Sel = { kind: "note"; version: string } | { kind: "broadcast"; id: string } | null;
type Status = "live" | "changed" | "new";

const today = () => new Date().toISOString().slice(0, 10);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const LEVELS: { v: Level; label: string; desc: string }[] = [
  { v: "info", label: "Announcement", desc: "Shows once, gone after they close it." },
  { v: "warning", label: "Heads up", desc: "Shows once, in amber, for things people should know." },
  { v: "critical", label: "Important", desc: "Comes back every launch until they're on a version it doesn't target." },
];

type Audience = "everyone" | "older" | "newer" | "custom";
function audienceOf(versions: string | undefined): { kind: Audience; v: string } {
  const s = (versions ?? "").trim();
  if (!s) return { kind: "everyone", v: "" };
  let m = /^<(\d+\.\d+\.\d+)$/.exec(s);
  if (m) return { kind: "older", v: m[1] };
  m = /^>=(\d+\.\d+\.\d+)$/.exec(s);
  if (m) return { kind: "newer", v: m[1] };
  return { kind: "custom", v: s };
}
function versionsFor(kind: Audience, v: string): string {
  if (kind === "everyone") return "";
  if (kind === "older") return `<${v}`;
  if (kind === "newer") return `>=${v}`;
  return v;
}

/** one line of the message as plain words, for the list */
function summary(md: string): string {
  return md
    .split("\n")
    .filter((l) => !/^\s*:{2,3}/.test(l))
    .join(" ")
    .replace(/:hover\[([^\]]+)\]\{[^}]*\}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\{\{version\}\}/g, "their version")
    .replace(/[*_`#]/g, "")
    .replace(/^\s*-\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function problems(body: string, dir: string): string[] {
  const p = parseMarkdown(body);
  const out = [...p.warnings];
  for (const m of mediaPaths(p.blocks)) if (!mediaExists(dir, m)) out.push(`missing file ${m}`);
  return out;
}

export default function MessagesSection() {
  const appVersion = useAppVersion() ?? "0.0.0";
  const { confirm } = useConfirm();
  const [dir, setDir] = useState(repoDir);
  const [cloned, setCloned] = useState(() => hasClone(repoDir()));
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED);
  const [live, setLive] = useState<Feed>(EMPTY_FEED);
  const [pending, setPending] = useState(0);
  const [sel, setSel] = useState<Sel>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);

  // status lines fade on their own
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(null), 5000);
    return () => window.clearTimeout(t);
  }, [status]);

  const reload = useCallback((d: string) => {
    const f = readDraft(d);
    setFeed(f);
    setLive(readLive(d));
    setPending(pendingChanges(d));
    loaded.current = true;
    return f;
  }, []);

  // first open: load the clone, and if release:preview sent a version, open its note
  useEffect(() => {
    if (!cloned) return;
    const f = reload(dir);
    const wanted = takeRequestedVersion();
    if (wanted) {
      if (!f.notes.some((n) => n.version === wanted)) setFeed({ ...f, notes: [...f.notes, { version: wanted, date: today(), body: "" }] });
      setSel({ kind: "note", version: wanted });
    } else {
      const newest = [...f.notes].sort((a, b) => compareVersions(b.version, a.version))[0];
      if (newest) setSel({ kind: "note", version: newest.version });
    }
  }, [cloned, dir, reload]);

  // autosave into the clone, then refresh the "not live yet" count
  useEffect(() => {
    if (!loaded.current || !cloned) return;
    const t = window.setTimeout(() => {
      try {
        writeDraft(dir, feed);
        setPending(pendingChanges(dir));
      } catch (e) {
        setStatus(`Couldn't save: ${(e as Error).message}`);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [feed, dir, cloned]);

  // What's new and the real corner show the draft while this tab is open
  useEffect(() => {
    if (!cloned) return;
    setFeedOverride(feed);
    setMediaOverride((src) => localMedia(dir, src));
  }, [feed, dir, cloned]);
  useEffect(
    () => () => {
      setFeedOverride(null);
      setMediaOverride(null);
    },
    [],
  );

  const notes = useMemo(() => [...feed.notes].sort((a, b) => compareVersions(b.version, a.version)), [feed.notes]);
  const note = sel?.kind === "note" ? feed.notes.find((n) => n.version === sel.version) ?? null : null;
  const bc = sel?.kind === "broadcast" ? feed.broadcasts.find((b) => b.id === sel.id) ?? null : null;

  const noteStatus = (n: Note): Status => {
    const l = live.notes.find((x) => x.version === n.version);
    return !l ? "new" : same(l, n) ? "live" : "changed";
  };
  const bcStatus = (b: Broadcast): Status => {
    const l = live.broadcasts.find((x) => x.id === b.id);
    return !l ? "new" : same(l, b) ? "live" : "changed";
  };

  const patchNote = (p: Partial<Note>) => {
    if (!note) return;
    setFeed((f) => ({ ...f, notes: f.notes.map((n) => (n === note ? { ...n, ...p } : n)) }));
    if (p.version !== undefined) setSel({ kind: "note", version: p.version });
  };
  const patchBc = (p: Partial<Broadcast>) => {
    if (!bc) return;
    const next = { ...bc, ...p };
    // an unpublished broadcast's id follows its title, published ids never change (dismissals key on them)
    if (p.title !== undefined && bcStatus(bc) === "new") next.id = `${bc.start ?? today()}-${slug(p.title) || "announcement"}`;
    setFeed((f) => ({ ...f, broadcasts: f.broadcasts.map((b) => (b === bc ? next : b)) }));
    if (next.id !== bc.id) setSel({ kind: "broadcast", id: next.id });
  };

  // body: blocks while they can express the message, plain text otherwise
  const body = note?.body ?? bc?.body ?? "";
  const selKey = sel ? `${sel.kind}:${sel.kind === "note" ? sel.version : sel.id}` : "";
  const [blocks, setBlocks] = useState<DBlock[] | null>(null);
  const [asText, setAsText] = useState(false);
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  useEffect(() => {
    let b = toBlocks(body);
    if (b && !b.length) b = [newBlock("text")];
    setBlocks(b);
    setAsText(b === null);
    setActiveBlock(null);
    // only when switching messages, typing keeps its own block state
  }, [selKey]);
  const setBody = (v: string) => (note ? patchNote({ body: v }) : patchBc({ body: v }));
  const onBlocks = (b: DBlock[]) => {
    setBlocks(b);
    setBody(toMarkdown(b));
  };
  const insert = (b: DBlock) => {
    if (!blocks || asText) return setStatus("Switch off \"Edit as text\" to insert.");
    const at = activeBlock ? blocks.findIndex((x) => x.id === activeBlock) : -1;
    const next = at < 0 ? [...blocks, b] : [...blocks.slice(0, at + 1), b, ...blocks.slice(at + 1)];
    onBlocks(next);
    setActiveBlock(b.id);
  };

  // the toolbar drives whichever text field was focused last
  const active = useRef<RichApi | null>(null);
  const [linking, setLinking] = useState<Range | null>(null);
  const [url, setUrl] = useState("https://");
  const editorEnv = useMemo<EditorEnv>(() => ({ dir, status: setStatus, setActive: (api) => (active.current = api) }), [dir]);
  const fmt = (fn: (a: RichApi) => void) => {
    if (!active.current) return setStatus("Click into the text first.");
    fn(active.current);
  };

  const newNote = () => {
    const v = feed.notes.some((n) => n.version === appVersion) ? "" : appVersion;
    setFeed((f) => ({ ...f, notes: [...f.notes, { version: v, date: today(), body: "" }] }));
    setSel({ kind: "note", version: v });
  };
  const newBroadcast = () => {
    let id = `${today()}-announcement`;
    for (let i = 2; feed.broadcasts.some((b) => b.id === id); i++) id = `${today()}-announcement-${i}`;
    setFeed((f) => ({ ...f, broadcasts: [...f.broadcasts, { id, level: "info", start: today(), body: "" }] }));
    setSel({ kind: "broadcast", id });
  };
  const remove = async () => {
    if (!sel) return;
    const published = note ? noteStatus(note) !== "new" : bc ? bcStatus(bc) !== "new" : false;
    const ok = await confirm({
      title: "Delete this message?",
      message: published ? "It disappears for everyone once you publish." : "It was never published.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setFeed((f) => ({
      ...f,
      notes: note ? f.notes.filter((n) => n !== note) : f.notes,
      broadcasts: bc ? f.broadcasts.filter((b) => b !== bc) : f.broadcasts,
    }));
    setSel(null);
  };

  // what changed since the last publish, for the commit message and the confirm text
  const changes = useMemo(() => {
    const out: string[] = [];
    for (const n of feed.notes) {
      const l = live.notes.find((x) => x.version === n.version);
      if (!l) out.push(`notes: v${n.version}`);
      else if (!same(l, n)) out.push(`notes: v${n.version} edited`);
    }
    for (const l of live.notes) if (!feed.notes.some((n) => n.version === l.version)) out.push(`notes: v${l.version} removed`);
    for (const b of feed.broadcasts) {
      const l = live.broadcasts.find((x) => x.id === b.id);
      if (!l) out.push(`broadcast: ${b.id}`);
      else if (!same(l, b)) out.push(`broadcast: ${b.id} edited`);
    }
    for (const l of live.broadcasts) if (!feed.broadcasts.some((b) => b.id === l.id)) out.push(`broadcast: ${l.id} removed`);
    return out;
  }, [feed, live]);

  const allProblems = useMemo(() => {
    const out: string[] = [];
    for (const n of feed.notes) {
      if (!parseVersion(n.version)) out.push(`Release note "${n.version || "(no version)"}" needs a version like 3.9.0`);
      problems(n.body, dir).forEach((p) => out.push(`v${n.version}: ${p}`));
    }
    for (const b of feed.broadcasts) {
      const name = b.title || b.id;
      if (!b.body.trim()) out.push(`"${name}" has no message`);
      if (b.versions && !parseRange(b.versions)) out.push(`"${name}": who sees it isn't a valid version`);
      problems(b.body, dir).forEach((p) => out.push(`"${name}": ${p}`));
    }
    return out;
  }, [feed, dir]);

  const doPublish = async () => {
    if (allProblems.length) {
      const ok = await confirm({ title: "Publish with problems?", message: allProblems.join("\n"), confirmLabel: "Publish anyway" });
      if (!ok) return;
    }
    const ok = await confirm({
      title: "Publish to everyone?",
      message: `${changes.join(", ") || "No message changes"}. People see it within about 5 minutes.`,
      confirmLabel: "Publish",
    });
    if (!ok) return;
    setBusy(true);
    try {
      writeDraft(dir, feed);
      publish(dir, changes.slice(0, 4).join(", ") || "feed: update");
      reload(dir);
      setStatus("Published. Live for everyone within about 5 minutes.");
    } catch (e) {
      setStatus(`Publish failed: ${gitError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doDiscard = async () => {
    const ok = await confirm({ title: "Throw away unpublished changes?", message: "Everything goes back to what's live now.", confirmLabel: "Discard", danger: true });
    if (!ok) return;
    try {
      discard(dir);
      const f = reload(dir);
      const newest = [...f.notes].sort((a, b) => compareVersions(b.version, a.version))[0];
      setSel(newest ? { kind: "note", version: newest.version } : null);
      setStatus("Back to what's live.");
    } catch (e) {
      setStatus(`Discard failed: ${gitError(e)}`);
    }
  };

  // preview: what someone sees, with the one thing that changes it
  const [previewOn, setPreviewOn] = useState("");
  const [comingFrom, setComingFrom] = useState("");
  const [replay, setReplay] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  useEffect(() => {
    setPreviewOn("");
    setComingFrom("");
    setMoreOpen(false);
  }, [selKey]);
  const olderNotes = note ? notes.filter((n) => compareVersions(n.version, note.version) < 0) : [];
  const from = comingFrom || olderNotes[0]?.version || "";
  const asVersion = previewOn || appVersion;
  const pagerNotes = note ? notesSince(feed, from, note.version) : [];
  const previewItem: CornerItem | null = note
    ? { id: `n:${note.version}`, kind: "notes", notes: pagerNotes.length ? pagerNotes : [note] }
    : bc
      ? { id: `b:${bc.id}`, kind: "broadcast", broadcast: bc }
      : null;
  const reaches = bc ? broadcastLive(bc, asVersion) : true;

  if (!cloned) {
    return (
      <div className="dz-setup">
        <h3>Set up the messages repo</h3>
        <p>
          Release notes and broadcasts live in <b>github.com/{FEED_REPO}</b>. This tab edits a local copy and publishes it.
        </p>
        <label className="dz-prop-label">
          Folder for the copy
          <input value={dir} onChange={(e) => setDir(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            try {
              if (!hasClone(dir)) cloneRepo(dir);
              setRepoDir(dir);
              setCloned(true);
            } catch (e) {
              setStatus(`Couldn't download it: ${gitError(e)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Download size={14} /> {hasClone(dir) ? "Use this folder" : "Download a copy"}
        </button>
        {status ? <p className="dz-toast">{status}</p> : null}
      </div>
    );
  }

  const audience = bc ? audienceOf(bc.versions) : null;
  const docProblems = note ? problems(note.body, dir) : bc ? problems(bc.body, dir) : [];
  const docStatus = note ? noteStatus(note) : bc ? bcStatus(bc) : null;
  const textMode = asText || !blocks;

  return (
    <EditorContext.Provider value={editorEnv}>
      <div className="dz">
        {/* left: the messages, like files */}
        <aside className="dz-side">
          <div className="dz-side-head">Messages</div>
          <div className="dz-tree">
            <div className="dz-tree-group">
              <span>Release notes</span>
              <button type="button" title="New release note" onClick={newNote}>
                <Plus size={14} />
              </button>
            </div>
            {notes.map((n) => (
              <button key={n.version || "(new)"} type="button" className={`dz-file${note === n ? " active" : ""}`} onClick={() => setSel({ kind: "note", version: n.version })}>
                <i className={`dz-dot dz-dot--${noteStatus(n)}`} />
                <span className="dz-file-name">v{n.version || "?"}</span>
                <span className="dz-file-sub">{summary(n.body) || "Default line"}</span>
              </button>
            ))}
            {!notes.length ? <p className="dz-tree-empty">None yet</p> : null}
            <div className="dz-tree-group">
              <span>Broadcasts</span>
              <button type="button" title="New broadcast" onClick={newBroadcast}>
                <Plus size={14} />
              </button>
            </div>
            {feed.broadcasts.map((b) => (
              <button key={b.id} type="button" className={`dz-file msg-level--${b.level}${bc === b ? " active" : ""}`} onClick={() => setSel({ kind: "broadcast", id: b.id })}>
                <i className={`dz-dot dz-dot--${bcStatus(b)}`} />
                <span className="dz-file-name">{b.title || "Untitled"}</span>
                <span className="dz-file-sub">
                  <span className="dz-file-level">{LEVELS.find((l) => l.v === b.level)?.label}</span>
                  {b.end && b.end < today() ? " · ended" : b.start && b.start > today() ? ` · starts ${b.start}` : ""}
                </span>
              </button>
            ))}
            {!feed.broadcasts.length ? <p className="dz-tree-empty">None yet</p> : null}
          </div>
          <div className={`dz-side-foot${pending ? " has-changes" : ""}`}>
            {pending ? (
              <>
                <b>
                  {changes.length || pending} change{(changes.length || pending) === 1 ? "" : "s"} not live
                </b>
                <span>Saved on this PC</span>
                <div className="dz-side-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void doPublish()}>
                    <CloudUpload size={14} /> {busy ? "Publishing..." : "Publish"}
                  </button>
                  <button type="button" className="btn" title="Back to what's live" onClick={() => void doDiscard()}>
                    <RotateCcw size={14} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <b>
                  <CircleCheck size={13} /> Everything is live
                </b>
                <span>People get what you see here</span>
              </>
            )}
          </div>
        </aside>

        {/* middle: the document */}
        <section className={`dz-editor${previewItem && previewOpen ? " has-preview" : ""}`}>
          {note || bc ? (
            <>
              <div className="dz-docbar">
                <span className="dz-crumb">
                  {note ? "Release notes" : "Broadcasts"} <i>/</i> <b>{note ? `v${note.version || "?"}` : bc?.title || "Untitled"}</b>
                </span>
                {docStatus ? <span className={`dz-pill dz-pill--${docStatus}`}>{docStatus === "live" ? "Live" : docStatus === "changed" ? "Edited, not live" : "Not published"}</span> : null}
                <span className="dz-docbar-gap" />
                <button type="button" className={`dz-tb${textMode ? " on" : ""}`} title="Edit the raw text" onClick={() => {
                  if (textMode) {
                    const b = toBlocks(body);
                    if (!b) return setStatus("This message uses things the visual editor can't show, it stays as text.");
                    setBlocks(b.length ? b : [newBlock("text")]);
                    setAsText(false);
                  } else setAsText(true);
                }}>
                  <Code size={14} /> Source
                </button>
                <button type="button" className="dz-tb dz-tb-danger" title="Delete this message" onClick={() => void remove()}>
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="dz-toolbar" onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}>
                <div className="dz-tbgroup">
                  <button type="button" className="dz-tb" title="Bold (Ctrl+B)" disabled={textMode} onClick={() => fmt((a) => a.bold())}>
                    <Bold size={15} />
                  </button>
                  <button type="button" className="dz-tb" title="Italic (Ctrl+I)" disabled={textMode} onClick={() => fmt((a) => a.italic())}>
                    <Italic size={15} />
                  </button>
                  <button
                    type="button"
                    className="dz-tb"
                    title="Link the selected words"
                    disabled={textMode}
                    onClick={() =>
                      fmt((a) => {
                        const r = a.linkTarget();
                        if (r) setLinking(r);
                      })
                    }
                  >
                    <Link2 size={15} />
                  </button>
                  <button type="button" className="dz-tb" title="Remove formatting" disabled={textMode} onClick={() => fmt((a) => a.clear())}>
                    <Eraser size={15} />
                  </button>
                </div>
                <div className="dz-tbgroup">
                  <button type="button" className="dz-tb" title="The selected words show a picture or gif on hover" disabled={textMode} onClick={() => fmt((a) => a.hover())}>
                    <ScanEye size={15} /> Hover picture
                  </button>
                  <button type="button" className="dz-tb" title="Shows the reader's own version, like 3.9.0" disabled={textMode} onClick={() => fmt((a) => a.version())}>
                    <Tag size={15} /> Their version
                  </button>
                </div>
                <div className="dz-tbgroup">
                  <span className="dz-tblabel">Insert</span>
                  <button type="button" className="dz-tb" title="Text" disabled={textMode} onClick={() => insert(newBlock("text"))}>
                    Text
                  </button>
                  <button
                    type="button"
                    className="dz-tb"
                    title="Picture, gif or short video"
                    disabled={textMode}
                    onClick={() =>
                      pickMedia(async (f) => {
                        try {
                          insert(newBlock("media", await addMedia(dir, f)));
                        } catch (e) {
                          setStatus(`Couldn't add that file: ${(e as Error).message}`);
                        }
                      })
                    }
                  >
                    <ImagePlus size={15} /> Picture
                  </button>
                  <button type="button" className="dz-tb" title="Buttons" disabled={textMode} onClick={() => insert(newBlock("buttons"))}>
                    <MousePointerClick size={15} /> Button
                  </button>
                  <button type="button" className="dz-tb" title="Text only some versions see" disabled={textMode} onClick={() => insert(newBlock("version"))}>
                    <GitBranch size={15} /> Per version
                  </button>
                </div>
              </div>
              {linking ? (
                <form
                  className="dz-linkbar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!/^https:\/\/\S+\.\S+/.test(url)) return setStatus("Links have to start with https://");
                    active.current?.link(linking, url);
                    setLinking(null);
                    setUrl("https://");
                  }}
                >
                  <Link2 size={14} />
                  <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} />
                  <button type="submit" className="btn btn-primary">
                    Add link
                  </button>
                  <button type="button" className="btn" onClick={() => setLinking(null)}>
                    Cancel
                  </button>
                </form>
              ) : null}

              <div className="dz-scroll">
                <div className={`dz-page${bc ? ` msg-level--${bc.level}` : ""}`}>
                  {note ? (
                    <div className="dz-title">
                      <span>Release note for v</span>
                      <input value={note.version} placeholder="3.9.0" size={Math.max(5, note.version.length)} onChange={(e) => patchNote({ version: e.target.value.trim() })} />
                    </div>
                  ) : bc ? (
                    <input className="dz-title-input" value={bc.title ?? ""} placeholder="Untitled broadcast" onChange={(e) => patchBc({ title: e.target.value })} />
                  ) : null}

                  <div className="dz-props">
                    {note ? (
                      <>
                        <div className="dz-prop">
                          <span className="dz-prop-key">Shows</span>
                          <span className="dz-prop-val dz-muted">Bottom right after someone updates to this version. Someone who skipped versions pages through every note since theirs.</span>
                        </div>
                        {!parseVersion(note.version) ? (
                          <div className="dz-prop">
                            <span className="dz-prop-key" />
                            <span className="dz-prop-val dz-warn">Needs a version like 3.9.0</span>
                          </div>
                        ) : feed.notes.filter((n) => n.version === note.version).length > 1 ? (
                          <div className="dz-prop">
                            <span className="dz-prop-key" />
                            <span className="dz-prop-val dz-warn">There's already a note for this version</span>
                          </div>
                        ) : null}
                        <div className="dz-prop">
                          <span className="dz-prop-key">Date</span>
                          <input type="date" className="dz-prop-val" value={note.date ?? ""} onChange={(e) => patchNote({ date: e.target.value || undefined })} />
                        </div>
                      </>
                    ) : bc && audience ? (
                      <>
                        <div className="dz-prop">
                          <span className="dz-prop-key">Type</span>
                          <div className="dz-prop-val">
                            <div className="dz-seg">
                              {LEVELS.map((l) => (
                                <button key={l.v} type="button" className={`msg-level--${l.v}${bc.level === l.v ? " on" : ""}`} onClick={() => patchBc({ level: l.v })}>
                                  <i />
                                  {l.label}
                                </button>
                              ))}
                            </div>
                            <span className="dz-muted">{LEVELS.find((l) => l.v === bc.level)?.desc}</span>
                          </div>
                        </div>
                        <div className="dz-prop">
                          <span className="dz-prop-key">Who sees it</span>
                          <div className="dz-prop-val dz-inline">
                            <select value={audience.kind} onChange={(e) => {
                              const k = e.target.value as Audience;
                              patchBc({ versions: versionsFor(k, k === "custom" ? bc.versions ?? "" : audience.v || appVersion) });
                            }}>
                              <option value="everyone">Everyone</option>
                              <option value="older">People older than</option>
                              <option value="newer">People on or newer than</option>
                              <option value="custom">A version range</option>
                            </select>
                            {audience.kind !== "everyone" ? (
                              <input
                                value={audience.v}
                                placeholder={audience.kind === "custom" ? ">=3.8.6 <3.9.2" : appVersion}
                                onChange={(e) => patchBc({ versions: versionsFor(audience.kind, e.target.value.trim()) })}
                              />
                            ) : null}
                            {bc.versions && !parseRange(bc.versions) ? <span className="dz-warn">not a valid version</span> : null}
                          </div>
                        </div>
                        <div className="dz-prop">
                          <span className="dz-prop-key">Showing</span>
                          <div className="dz-prop-val dz-inline">
                            from
                            <input type="date" value={bc.start ?? ""} onChange={(e) => patchBc({ start: e.target.value || undefined })} />
                            until
                            <input type="date" value={bc.end ?? ""} onChange={(e) => patchBc({ end: e.target.value || undefined })} />
                            {!bc.end ? <span className="dz-muted">no end</span> : null}
                          </div>
                        </div>
                      </>
                    ) : null}
                    <button type="button" className="dz-more" onClick={() => setMoreOpen((o) => !o)}>
                      {moreOpen ? "Fewer options" : "More options"}
                    </button>
                    {moreOpen ? (
                      <>
                        {bc ? (
                          <div className="dz-prop">
                            <span className="dz-prop-key">Id</span>
                            <div className="dz-prop-val">
                              <input value={bc.id} readOnly={bcStatus(bc) !== "new"} onChange={(e) => patchBc({ id: slug(e.target.value) })} />
                              <span className="dz-muted">Dismissals are remembered by this, it can't change once published.</span>
                            </div>
                          </div>
                        ) : null}
                        <div className="dz-prop">
                          <span className="dz-prop-key">Hide from</span>
                          <div className="dz-prop-val">
                            <input
                              value={(note ?? bc)?.minApp ?? ""}
                              placeholder="nobody"
                              onChange={(e) => (note ? patchNote({ minApp: e.target.value.trim() || undefined }) : patchBc({ minApp: e.target.value.trim() || undefined }))}
                            />
                            <span className="dz-muted">Setsu versions older than this never get it. For messages using something old versions can't show.</span>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>

                  {note ? <p className="dz-greet">Hey,</p> : null}
                  {textMode ? (
                    <textarea className="dz-raw" value={body} spellCheck onChange={(e) => setBody(e.target.value)} />
                  ) : blocks ? (
                    <BlockEditor
                      blocks={blocks}
                      onChange={onBlocks}
                      onFocusBlock={setActiveBlock}
                      textPlaceholder={note ? "this update fixes ... (empty shows the default line)" : "What everyone should know"}
                    />
                  ) : null}
                  {docProblems.length ? (
                    <ul className="dz-problems">
                      {docProblems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="dz-blank">
              <p>Pick a message on the left, or start one.</p>
              <div className="dz-inline">
                <button type="button" className="btn" onClick={newNote}>
                  <Plus size={14} /> Release note
                </button>
                <button type="button" className="btn" onClick={newBroadcast}>
                  <Plus size={14} /> Broadcast
                </button>
              </div>
            </div>
          )}
          {/* the bubble floats where it will sit in the app, bottom right */}
          {previewItem ? (
            previewOpen ? (
              <div className="dz-float">
                <div className="dz-float-bar">
                  <b>Preview</b>
                  {note ? (
                    <label>
                      from
                      <select value={from} onChange={(e) => setComingFrom(e.target.value)}>
                        {olderNotes.map((n) => (
                          <option key={n.version} value={n.version}>
                            v{n.version}
                          </option>
                        ))}
                        <option value="0.0.0">an old version</option>
                      </select>
                    </label>
                  ) : (
                    <label>
                      on
                      <input value={previewOn} placeholder={appVersion} onChange={(e) => setPreviewOn(e.target.value.trim())} />
                    </label>
                  )}
                  <button
                    type="button"
                    title="Show it in the app"
                    onClick={() =>
                      showInCorner(note ? buildQueue(feed, { version: note.version, lastRun: from, fresh: false, dismissed: [] }).filter((i) => i.kind === "notes") : [previewItem])
                    }
                  >
                    <MonitorPlay size={14} />
                  </button>
                  <button type="button" title="Hide the preview" onClick={() => setPreviewOpen(false)}>
                    <EyeOff size={14} />
                  </button>
                </div>
                {bc && !reaches ? <div className="dz-float-note">Someone on v{asVersion} wouldn't get this today.</div> : null}
                <AnimatePresence mode="wait">
                  <CornerCard
                    key={`${previewItem.id}:${replay}:${from}`}
                    item={previewItem}
                    env={{ version: asVersion, media: (src) => localMedia(dir, src), dry: true }}
                    typing={false}
                    onClose={() => setReplay((r) => r + 1)}
                    onTip={() => setStatus("That button opens your Ko-fi.")}
                    className="msg-corner msg-corner--float"
                  />
                </AnimatePresence>
              </div>
            ) : (
              <button type="button" className="dz-float-open" onClick={() => setPreviewOpen(true)}>
                <Eye size={14} /> Preview
              </button>
            )
          ) : null}
          {status ? <div className="dz-toast">{status}</div> : null}
        </section>
      </div>
    </EditorContext.Provider>
  );
}

import { useContext, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, GitBranch, ImagePlus, Plus, Trash2, X } from "lucide-react";
import { ALL_SECTIONS } from "../../settings/nav";
import RichText, { EditorContext } from "./RichText";
import { addMedia, localMedia } from "./repo";
import { blockId, type ButtonKind, type DBlock, type DButton, type VersionOp } from "./blocks";

// the message body as one document: text flows like a page, pictures, buttons and per-version text
// sit inline as what they'll look like. block controls show in the left margin on hover

const OPS: { v: VersionOp; label: string }[] = [
  { v: "below", label: "older than" },
  { v: "atLeast", label: "on or newer than" },
  { v: "is", label: "exactly on" },
];

const BUTTON_KINDS: { v: ButtonKind; label: string }[] = [
  { v: "update", label: "Updates Setsu" },
  { v: "link", label: "Opens a website" },
  { v: "settings", label: "Opens a settings page" },
  { v: "library", label: "Goes to the library" },
];

const SECTIONS = ALL_SECTIONS.filter((s) => !s.id.startsWith("dev-"));
const isVideo = (src: string) => /\.(mp4|webm|mov)$/i.test(src);

export function pickMedia(onFile: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,video/mp4,video/webm";
  input.onchange = () => input.files?.[0] && onFile(input.files[0]);
  input.click();
}

export function newBlock(k: DBlock["k"], src = ""): DBlock {
  const id = blockId();
  if (k === "text") return { id, k, md: "" };
  if (k === "media") return { id, k, src };
  if (k === "buttons") return { id, k, items: [{ label: "Update now", kind: "update" }] };
  return { id, k, op: "below", v: "", then: "", other: "" };
}

function MediaBlock({ src, onChange, onRemove }: { src: string; onChange: (src: string) => void; onRemove: () => void }) {
  const env = useContext(EditorContext);
  const [over, setOver] = useState(false);
  const take = async (f: File) => {
    try {
      onChange(await addMedia(env.dir, f));
    } catch (e) {
      env.status(`Couldn't add that file: ${(e as Error).message}`);
    }
  };
  const url = src ? (/^https:/.test(src) ? src : localMedia(env.dir, src)) : "";
  return (
    <div
      className={`dz-media${over ? " over" : ""}`}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void take(f);
      }}
    >
      {url ? (
        <>
          {isVideo(src) ? <video src={url} muted autoPlay loop playsInline /> : <img src={url} alt="" />}
          <div className="dz-media-over">
            <button type="button" onClick={() => pickMedia((f) => void take(f))}>
              Replace
            </button>
            <button type="button" onClick={onRemove}>
              Remove
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="dz-media-empty" onClick={() => pickMedia((f) => void take(f))}>
          <ImagePlus size={18} />
          Drop a picture, gif or short video, or click to pick one
        </button>
      )}
    </div>
  );
}

function ButtonEdit({ b, onChange, onRemove, onDone }: { b: DButton; onChange: (p: Partial<DButton>) => void; onRemove: () => void; onDone: () => void }) {
  return (
    <div className="dz-pop">
      <label>
        Says
        <input autoFocus value={b.label} placeholder="Button text" onChange={(e) => onChange({ label: e.target.value })} />
      </label>
      <label>
        Clicking it
        <select value={b.kind} onChange={(e) => onChange({ kind: e.target.value as ButtonKind })}>
          {BUTTON_KINDS.map((k) => (
            <option key={k.v} value={k.v}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {b.kind === "link" ? (
        <label>
          Website
          <input value={b.href ?? ""} placeholder="https://" onChange={(e) => onChange({ href: e.target.value })} />
        </label>
      ) : null}
      {b.kind === "settings" ? (
        <label>
          Page
          <select value={b.section ?? "general"} onChange={(e) => onChange({ section: e.target.value })}>
            {SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="dz-pop-foot">
        <button type="button" className="dz-link-danger" onClick={onRemove}>
          Remove button
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function ButtonsBlock({ items, onChange }: { items: DButton[]; onChange: (items: DButton[]) => void }) {
  const [editing, setEditing] = useState<number | null>(items.length === 1 && !items[0].label ? 0 : null);
  return (
    <div className="dz-btns">
      <div className="dz-btns-row">
        {items.map((b, i) => (
          <button key={i} type="button" className={`msg-btn${i === 0 ? " msg-btn-primary" : ""}${editing === i ? " editing" : ""}`} onClick={() => setEditing(editing === i ? null : i)}>
            {b.label || "Button"}
            {b.kind === "link" ? <ArrowUpRight size={13} /> : null}
          </button>
        ))}
        {items.length < 3 ? (
          <button
            type="button"
            className="dz-chip-add"
            title="Add a button"
            onClick={() => {
              onChange([...items, { label: "", kind: "link", href: "https://" }]);
              setEditing(items.length);
            }}
          >
            <Plus size={13} />
          </button>
        ) : null}
      </div>
      {editing !== null && items[editing] ? (
        <ButtonEdit
          b={items[editing]}
          onChange={(p) => onChange(items.map((x, j) => (j === editing ? { ...x, ...p } : x)))}
          onRemove={() => {
            onChange(items.filter((_, j) => j !== editing));
            setEditing(null);
          }}
          onDone={() => setEditing(null)}
        />
      ) : (
        <p className="dz-under">Click a button to change it. The first one is the coloured one.</p>
      )}
    </div>
  );
}

export default function BlockEditor({
  blocks,
  onChange,
  onFocusBlock,
  textPlaceholder,
}: {
  blocks: DBlock[];
  onChange: (b: DBlock[]) => void;
  onFocusBlock: (id: string) => void;
  textPlaceholder: string;
}) {
  const set = (i: number, b: DBlock) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: number) => {
    const next = [...blocks];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const drop = (i: number) => onChange(blocks.filter((_, j) => j !== i));

  return (
    <div className="dz-doc">
      {blocks.map((b, i) => (
        <div key={b.id} className={`dz-blk dz-blk--${b.k}`} onFocusCapture={() => onFocusBlock(b.id)} onMouseDown={() => onFocusBlock(b.id)}>
          <div className="dz-gutter">
            <button type="button" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={12} />
            </button>
            <button type="button" title="Move down" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={12} />
            </button>
            <button type="button" title="Remove" onClick={() => drop(i)}>
              <Trash2 size={12} />
            </button>
          </div>
          {b.k === "text" ? (
            <RichText value={b.md} onChange={(md) => set(i, { ...b, md })} placeholder={i === 0 ? textPlaceholder : "Write something"} />
          ) : b.k === "media" ? (
            <MediaBlock src={b.src} onChange={(src) => set(i, { ...b, src })} onRemove={() => drop(i)} />
          ) : b.k === "buttons" ? (
            <ButtonsBlock items={b.items} onChange={(items) => (items.length ? set(i, { ...b, items }) : drop(i))} />
          ) : (
            <div className="dz-callout">
              <div className="dz-callout-head">
                <GitBranch size={13} />
                Only people
                <select value={b.op} onChange={(e) => set(i, { ...b, op: e.target.value as VersionOp })}>
                  {OPS.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input value={b.v} placeholder="3.9.1" onChange={(e) => set(i, { ...b, v: e.target.value.trim() })} />
                see
                <button type="button" className="dz-callout-x" title="Remove" onClick={() => drop(i)}>
                  <X size={13} />
                </button>
              </div>
              <RichText value={b.then} onChange={(then) => set(i, { ...b, then })} placeholder="e.g. You're on an affected version, please update." />
              <div className="dz-callout-head dz-callout-else">Everyone else sees</div>
              <RichText value={b.other} onChange={(other) => set(i, { ...b, other })} placeholder="Nothing (leave empty)" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

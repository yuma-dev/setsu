// the designer edits a message as a list of blocks and stores it as the corner's markdown
// (messages/parse.ts). a message the blocks can't express (nested version blocks, directives inside
// one) opens in the plain text editor instead
import { parseAttrs } from "../parse";

export type ButtonKind = "update" | "link" | "settings" | "library";

export interface DButton {
  label: string;
  kind: ButtonKind;
  href?: string;
  section?: string;
}

export type VersionOp = "below" | "atLeast" | "is";

export type DBlock =
  | { id: string; k: "text"; md: string }
  | { id: string; k: "media"; src: string }
  | { id: string; k: "buttons"; items: DButton[] }
  | { id: string; k: "version"; op: VersionOp; v: string; then: string; other: string };

let seq = 0;
export const blockId = () => `b${++seq}`;

function button(label: string, attrs: Record<string, string>): DButton {
  if (attrs.action === "update") return { label, kind: "update" };
  if (attrs.href) return { label, kind: "link", href: attrs.href };
  const [route, section] = (attrs.to ?? "").split("/");
  if (route === "library") return { label, kind: "library" };
  return { label, kind: "settings", section: section || "general" };
}

/** null when the message needs the text editor */
export function toBlocks(md: string): DBlock[] | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: DBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    const t = text.join("\n").replace(/^\n+|\n+$/g, "");
    if (t.trim()) out.push({ id: blockId(), k: "text", md: t });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    let m: RegExpExecArray | null;
    if ((m = /^:::if\{(.*)\}$/.exec(trimmed))) {
      flush();
      const attrs = parseAttrs(m[1]);
      const keys = Object.keys(attrs);
      if (keys.length !== 1 || !["below", "atLeast", "is"].includes(keys[0])) return null;
      const then: string[] = [];
      const other: string[] = [];
      let into = then;
      let closed = false;
      for (i++; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === ":::") {
          closed = true;
          break;
        }
        if (t === ":::else") {
          into = other;
          continue;
        }
        if (/^::/.test(t)) return null;
        into.push(lines[i]);
      }
      if (!closed) return null;
      out.push({ id: blockId(), k: "version", op: keys[0] as VersionOp, v: attrs[keys[0]], then: then.join("\n").trim(), other: other.join("\n").trim() });
    } else if ((m = /^::(image|video)\{(.*)\}$/.exec(trimmed))) {
      flush();
      out.push({ id: blockId(), k: "media", src: parseAttrs(m[2]).src ?? "" });
    } else if ((m = /^::button\[([^\]]+)\]\{(.*)\}$/.exec(trimmed))) {
      flush();
      const b = button(m[1], parseAttrs(m[2]));
      const prev = out[out.length - 1];
      if (prev?.k === "buttons") prev.items.push(b);
      else out.push({ id: blockId(), k: "buttons", items: [b] });
    } else if (/^:::?/.test(trimmed)) {
      return null;
    } else {
      text.push(lines[i]);
    }
  }
  flush();
  return out;
}

const isVideo = (src: string) => /\.(mp4|webm|mov)$/i.test(src);

function buttonLine(b: DButton): string {
  const label = b.label.replace(/[\]\n]/g, "").trim() || "Button";
  if (b.kind === "update") return `::button[${label}]{action=update}`;
  if (b.kind === "link") return `::button[${label}]{href=${b.href ?? ""}}`;
  if (b.kind === "library") return `::button[${label}]{to=library}`;
  return `::button[${label}]{to=settings/${b.section ?? "general"}}`;
}

export function toMarkdown(blocks: DBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.k) {
        case "text":
          return b.md.trim();
        case "media":
          return b.src ? (isVideo(b.src) ? `::video{src=${b.src} loop}` : `::image{src=${b.src}}`) : "";
        case "buttons":
          return b.items.map(buttonLine).join("\n");
        case "version":
          return [`:::if{${b.op}=${b.v.trim() || "0.0.0"}}`, b.then.trim(), ...(b.other.trim() ? [":::else", b.other.trim()] : []), ":::"].join("\n");
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

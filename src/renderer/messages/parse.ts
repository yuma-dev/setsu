// the small markdown the corner bubble understands. no raw html ever reaches the dom, links are
// https only. directives on top of markdown:
//   :hover[text]{src=media/x.gif}       text that previews an image, gif or video on hover
//   :::if{below=3.9.1} ... :::else ... :::   blocks by installed version (below, atMost, is, atLeast, above, range)
//   ::button[Update now]{action=update}  also href=https://... and to=settings/audio or to=library
//   ::image{src=media/x.png}  ::video{src=media/x.mp4 loop}
//   {{version}}                          the installed version

export type Inline =
  | { t: "text"; v: string }
  | { t: "version" }
  | { t: "bold" | "italic"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "hover"; src: string; c: Inline[] };

export interface ButtonSpec {
  label: string;
  action?: "update";
  href?: string;
  to?: string;
}

export type Block =
  | { t: "p"; c: Inline[][] }
  | { t: "h"; c: Inline[] }
  | { t: "list"; items: Inline[][] }
  | { t: "image" | "video"; src: string; alt?: string; loop: boolean }
  | { t: "buttons"; buttons: ButtonSpec[] }
  | { t: "if"; cond: Record<string, string>; then: Block[]; else: Block[] };

export interface Parsed {
  blocks: Block[];
  warnings: string[];
}

export const IF_KEYS = ["below", "atMost", "is", "atLeast", "above", "range"];

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z]+)(?:=("([^"]*)"|[^\s"]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[2] ?? "true";
  return out;
}

const safeHref = (h: string) => /^https:\/\/[^\s]+$/i.test(h);

export function parseInline(text: string, warnings: string[]): Inline[] {
  const re =
    /\{\{version\}\}|:hover\[([^\]]+)\]\{([^}]*)\}|\*\*(.+?)\*\*|\*(.+?)\*|(?<![\w])_(.+?)_(?![\w])|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    last = re.lastIndex;
    if (m[0] === "{{version}}") out.push({ t: "version" });
    else if (m[1] !== undefined) {
      const src = parseAttrs(m[2]).src;
      if (!src) warnings.push(`:hover[${m[1]}] has no src`);
      out.push(src ? { t: "hover", src, c: parseInline(m[1], warnings) } : { t: "text", v: m[1] });
    } else if (m[3] !== undefined) out.push({ t: "bold", c: parseInline(m[3], warnings) });
    else if (m[4] !== undefined) out.push({ t: "italic", c: parseInline(m[4], warnings) });
    else if (m[5] !== undefined) out.push({ t: "italic", c: parseInline(m[5], warnings) });
    else if (m[6] !== undefined) out.push({ t: "code", v: m[6] });
    else if (m[7] !== undefined) {
      if (safeHref(m[8])) out.push({ t: "link", href: m[8], c: parseInline(m[7], warnings) });
      else {
        warnings.push(`link "${m[8]}" is not https, shown as plain text`);
        out.push({ t: "text", v: m[7] });
      }
    }
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

function parseButton(label: string, attrs: Record<string, string>, warnings: string[]): ButtonSpec | null {
  if (attrs.action === "update") return { label, action: "update" };
  if (attrs.href) {
    if (safeHref(attrs.href)) return { label, href: attrs.href };
    warnings.push(`button "${label}": href must be https`);
    return null;
  }
  if (attrs.to) return { label, to: attrs.to };
  warnings.push(`button "${label}" needs action=update, href= or to=`);
  return null;
}

export function parseMarkdown(src: string): Parsed {
  const warnings: string[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const blocks = (until: (line: string) => boolean): Block[] => {
    const out: Block[] = [];
    let para: string[] = [];
    const flush = () => {
      if (para.length) out.push({ t: "p", c: para.map((l) => parseInline(l, warnings)) });
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (until(trimmed)) break;
      i++;
      let m: RegExpExecArray | null;
      if (!trimmed) {
        flush();
      } else if ((m = /^:::if\{(.*)\}$/.exec(trimmed))) {
        flush();
        const cond = parseAttrs(m[1]);
        if (!Object.keys(cond).some((k) => IF_KEYS.includes(k))) warnings.push(`:::if needs one of ${IF_KEYS.join(", ")}`);
        const then = blocks((l) => l === ":::" || l === ":::else");
        let other: Block[] = [];
        if (lines[i]?.trim() === ":::else") {
          i++;
          other = blocks((l) => l === ":::");
        }
        if (lines[i]?.trim() === ":::") i++;
        else warnings.push(":::if is missing its closing :::");
        out.push({ t: "if", cond, then, else: other });
      } else if ((m = /^::(image|video)\{(.*)\}$/.exec(trimmed))) {
        flush();
        const a = parseAttrs(m[2]);
        if (!a.src) warnings.push(`::${m[1]} has no src`);
        else out.push({ t: m[1] as "image" | "video", src: a.src, alt: a.alt, loop: "loop" in a });
      } else if ((m = /^::button\[([^\]]+)\]\{(.*)\}$/.exec(trimmed))) {
        flush();
        const b = parseButton(m[1], parseAttrs(m[2]), warnings);
        if (b) {
          const prev = out[out.length - 1];
          if (prev?.t === "buttons") prev.buttons.push(b);
          else out.push({ t: "buttons", buttons: [b] });
        }
      } else if ((m = /^#{1,3}\s+(.*)$/.exec(trimmed))) {
        flush();
        out.push({ t: "h", c: parseInline(m[1], warnings) });
      } else if ((m = /^[-*]\s+(.*)$/.exec(trimmed))) {
        flush();
        const prev = out[out.length - 1];
        const item = parseInline(m[1], warnings);
        if (prev?.t === "list") prev.items.push(item);
        else out.push({ t: "list", items: [item] });
      } else {
        if (/^:{2,3}\w/.test(trimmed)) warnings.push(`unknown directive: ${trimmed.slice(0, 40)}`);
        para.push(line.trim());
      }
    }
    flush();
    return out;
  };

  const out = blocks(() => false);
  return { blocks: out, warnings };
}

/** media paths a message uses, for the designer's missing-file check */
export function mediaPaths(blocks: Block[]): string[] {
  const out: string[] = [];
  const inl = (c: Inline[]) => {
    for (const n of c) {
      if (n.t === "hover") out.push(n.src);
      if ("c" in n) inl(n.c);
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === "p") b.c.forEach(inl);
      else if (b.t === "h") inl(b.c);
      else if (b.t === "list") b.items.forEach(inl);
      else if (b.t === "image" || b.t === "video") out.push(b.src);
      else if (b.t === "if") {
        walk(b.then);
        walk(b.else);
      }
    }
  };
  walk(blocks);
  return out;
}

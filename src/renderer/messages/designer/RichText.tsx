import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { parseInline, type Inline } from "../parse";
import { addMedia } from "./repo";

// a contenteditable that shows formatting as it will look and stores the corner's markdown.
// one div per line, the way chromium builds them on enter. only bold, italic, links, hover
// pictures and the version chip; paste is plain text so nothing else gets in. the toolbar above the
// document drives whichever field was focused last

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return esc(n.v);
        case "version":
          return `<span class="rt-token" contenteditable="false" data-token="version">version</span>`;
        case "bold":
          return `<b>${inlineHtml(n.c)}</b>`;
        case "italic":
          return `<i>${inlineHtml(n.c)}</i>`;
        case "code":
          return esc(`\`${n.v}\``);
        case "link":
          return `<a href="${esc(n.href)}" title="${esc(n.href)}">${inlineHtml(n.c)}</a>`;
        case "hover":
          return `<span class="rt-hover" data-hover="${esc(n.src)}" title="Shows ${esc(n.src)} on hover">${inlineHtml(n.c)}</span>`;
      }
    })
    .join("");
}

export function mdToHtml(md: string): string {
  return md
    .split("\n")
    .map((line) => `<div>${line ? inlineHtml(parseInline(line, [])) : "<br>"}</div>`)
    .join("");
}

function inlineMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/ /g, " ");
  if (!(node instanceof HTMLElement)) return "";
  const kids = () => [...node.childNodes].map(inlineMd).join("");
  const tag = node.tagName;
  if (tag === "BR") return "\n";
  if (node.dataset.token === "version") return "{{version}}";
  if (node.dataset.hover) return `:hover[${kids()}]{src=${node.dataset.hover}}`;
  if (tag === "A") return `[${kids()}](${node.getAttribute("href") ?? ""})`;
  const inner = kids();
  if (!inner.trim()) return inner;
  if (tag === "B" || tag === "STRONG") return `**${inner}**`;
  if (tag === "I" || tag === "EM") return `*${inner}*`;
  if (tag === "DIV" || tag === "P") return `\n${inner}`;
  return inner;
}

export function htmlToMd(root: HTMLElement): string {
  const lines: string[] = [];
  let cur = "";
  let started = false;
  for (const node of root.childNodes) {
    if (node instanceof HTMLElement && (node.tagName === "DIV" || node.tagName === "P")) {
      if (started || cur) lines.push(cur);
      const only = node.childNodes.length === 1 && (node.firstChild as HTMLElement)?.tagName === "BR";
      cur = only ? "" : [...node.childNodes].map(inlineMd).join("");
      started = true;
    } else {
      cur += inlineMd(node);
    }
  }
  lines.push(cur);
  return lines.join("\n").replace(/\n+$/, "");
}

export interface RichApi {
  bold(): void;
  italic(): void;
  /** the selection to link, null (with a status) when nothing is selected */
  linkTarget(): Range | null;
  link(target: Range, url: string): void;
  hover(): void;
  version(): void;
  clear(): void;
}

export interface EditorEnv {
  dir: string;
  status(s: string): void;
  setActive(api: RichApi): void;
}

export const EditorContext = createContext<EditorEnv>({ dir: "", status: () => {}, setActive: () => {} });

export default function RichText({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const env = useContext(EditorContext);
  const ref = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState(!value);

  // only rewrite the dom when the value came from outside, typing keeps the caret
  useLayoutEffect(() => {
    if (!ref.current || value === emitted.current) return;
    ref.current.innerHTML = mdToHtml(value);
    emitted.current = value;
    setEmpty(!value);
  }, [value]);

  const emit = () => {
    if (!ref.current) return;
    const md = htmlToMd(ref.current);
    emitted.current = md;
    setEmpty(!md.trim());
    onChange(md);
  };

  const selection = (): Range | null => {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !ref.current) return null;
    const r = s.getRangeAt(0);
    return ref.current.contains(r.commonAncestorContainer) ? r : null;
  };
  const restore = (r: Range) => {
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  };
  const words = (what: string): Range | null => {
    const r = selection();
    if (!r || r.collapsed) {
      env.status(`Select some words first, then ${what}.`);
      return null;
    }
    return r.cloneRange();
  };
  const cmd = (name: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(name, false, arg);
    emit();
  };

  const api: RichApi = {
    bold: () => cmd("bold"),
    italic: () => cmd("italic"),
    linkTarget: () => words("click Link"),
    link: (target, url) => {
      ref.current?.focus();
      restore(target);
      cmd("createLink", url);
    },
    hover: () => {
      const r = words("click Hover picture");
      if (!r) return;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/mp4,video/webm";
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          const rel = await addMedia(env.dir, f);
          const span = document.createElement("span");
          span.className = "rt-hover";
          span.dataset.hover = rel;
          span.title = `Shows ${rel} on hover`;
          span.appendChild(r.extractContents());
          r.insertNode(span);
          emit();
        } catch (e) {
          env.status(`Couldn't add that file: ${(e as Error).message}`);
        }
      };
      input.click();
    },
    version: () => {
      ref.current?.focus();
      const span = document.createElement("span");
      span.className = "rt-token";
      span.contentEditable = "false";
      span.dataset.token = "version";
      span.textContent = "version";
      const r = selection();
      if (r) {
        r.deleteContents();
        r.insertNode(span);
        r.setStartAfter(span);
        r.collapse(true);
        restore(r);
      } else ref.current?.appendChild(span);
      emit();
    },
    clear: () => {
      const r = selection();
      if (!r) return env.status("Select the text to clear first.");
      for (const el of [...(ref.current?.querySelectorAll<HTMLElement>("[data-hover]") ?? [])]) {
        if (r.intersectsNode(el)) el.replaceWith(...el.childNodes);
      }
      cmd("unlink");
      cmd("removeFormat");
    },
  };
  const apiRef = useRef(api);
  apiRef.current = api;

  return (
    <div
      ref={ref}
      className={`rt${empty ? " rt-empty" : ""}${className ? ` ${className}` : ""}`}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onFocus={() =>
        env.setActive({
          bold: () => apiRef.current.bold(),
          italic: () => apiRef.current.italic(),
          linkTarget: () => apiRef.current.linkTarget(),
          link: (t, u) => apiRef.current.link(t, u),
          hover: () => apiRef.current.hover(),
          version: () => apiRef.current.version(),
          clear: () => apiRef.current.clear(),
        })
      }
      onInput={emit}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      }}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

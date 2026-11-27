// the designer works on a local clone of github.com/yuma-dev/setsu-messages. every edit lands in its
// feed.json right away, HEAD is what's live (publishing pushes it), so "not live yet" is git status
import { EMPTY_FEED, FEED_FORMAT, FEED_REPO, compareVersions, readFeed, type Feed } from "../feed";

type NodeReq = (m: string) => unknown;
const req = (window as unknown as { require: NodeReq }).require;
const fs = req("fs") as typeof import("fs");
const path = req("path") as typeof import("path");
const cp = req("child_process") as typeof import("child_process");
const crypto = req("crypto") as typeof import("crypto");

const DIR_KEY = "setsu.designer.repo";
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function repoDir(): string {
  return localStorage.getItem(DIR_KEY) || path.resolve(process.cwd(), "..", "setsu-messages");
}

export function setRepoDir(dir: string): void {
  localStorage.setItem(DIR_KEY, dir);
}

function git(dir: string, args: string[]): string {
  return cp.execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function gitError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || String(e)).trim().split("\n").slice(-3).join(" ");
}

export function hasClone(dir: string): boolean {
  return fs.existsSync(path.join(dir, "feed.json")) && fs.existsSync(path.join(dir, ".git"));
}

export function cloneRepo(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  cp.execFileSync("git", ["clone", `https://github.com/${FEED_REPO}.git`, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function readDraft(dir: string): Feed {
  return readFeed(JSON.parse(fs.readFileSync(path.join(dir, "feed.json"), "utf8"))) ?? EMPTY_FEED;
}

/** what's live: the last commit (publish pushes it). empty before the first publish */
export function readLive(dir: string): Feed {
  try {
    return readFeed(JSON.parse(git(dir, ["show", "HEAD:feed.json"]))) ?? EMPTY_FEED;
  } catch {
    return EMPTY_FEED;
  }
}

export function serialize(feed: Feed): string {
  const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
  const notes = [...feed.notes].sort((a, b) => compareVersions(b.version, a.version)).map(clean);
  return `${JSON.stringify({ format: FEED_FORMAT, notes, broadcasts: feed.broadcasts.map(clean) }, null, 2)}\n`;
}

export function writeDraft(dir: string, feed: Feed): void {
  fs.writeFileSync(path.join(dir, "feed.json"), serialize(feed));
}

/** files changed since the last publish, feed.json and media included */
export function pendingChanges(dir: string): number {
  try {
    return git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function publish(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  if (git(dir, ["status", "--porcelain"]).trim()) git(dir, ["commit", "-m", message]);
  git(dir, ["pull", "--rebase", "--autostash"]);
  git(dir, ["push"]);
}

/** back to what's live: feed.json from HEAD, unpublished media deleted */
export function discard(dir: string): void {
  git(dir, ["checkout", "--", "."]);
  git(dir, ["clean", "-fd", "--", "media"]);
}

/** copies a dropped or picked file into media/ under a content hash, so a published url never
 * changes what it points at. returns the path the message uses */
export async function addMedia(dir: string, file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8);
  const ext = (path.extname(file.name) || ".png").toLowerCase();
  const base =
    path
      .basename(file.name, path.extname(file.name))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "media";
  const rel = `media/${base}-${hash}${ext}`;
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), buf);
  return rel;
}

export function mediaExists(dir: string, rel: string): boolean {
  return /^https:/.test(rel) || fs.existsSync(path.join(dir, rel));
}

const dataUrls = new Map<string, string>();

/** media for the preview straight from the clone, unpublished files included */
export function localMedia(dir: string, rel: string): string {
  const file = path.join(dir, rel);
  const hit = dataUrls.get(file);
  if (hit) return hit;
  try {
    const ext = path.extname(file).slice(1).toLowerCase();
    const url = `data:${MIME[ext] ?? "application/octet-stream"};base64,${fs.readFileSync(file).toString("base64")}`;
    dataUrls.set(file, url);
    return url;
  } catch {
    return "";
  }
}

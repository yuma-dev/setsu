// numbers and copy for the recap pages, derived once from what main computed (main/recap.js)
import type { RecapData, RecapFriend, RecapGameRef } from "../../types/clips";
import { fileUrl } from "../player/layers/meta";

export const SANS = '"Geist Variable", Geist, system-ui, sans-serif';
export const MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace';
export const DISPLAY = '"Unbounded Variable", Unbounded, sans-serif';

export const MLs = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const NAMES: Record<string, string> = {
  stack: "THE STACK",
  clock: "YOUR HOURS",
  orbit: "YOUR ORBIT",
  cut: "THE CUTTING ROOM",
  repeat: "ON REPEAT",
  chart: "STAR CHART",
  card: "YOUR CARD",
};

export type Ref = { name: string; h: number; kind: string };
export const STACK_REF: Array<[string, number, string]> = [
  ["a person", 1.8, "person"],
  ["a double-decker bus", 4.4, "bus"],
  ["a house", 9, "house"],
  ["a lighthouse", 30, "light"],
  ["Big Ben", 96, "bigben"],
  ["the Eiffel Tower", 330, "eiffel"],
  ["the Burj Khalifa", 828, "burj"],
];
export const MARKS: Array<[string, number]> = [
  ["Mount Everest", 8849],
  ["Airliners", 11000],
  ["Weather balloons", 35000],
  ["Edge of space", 1e5],
  ["Northern lights", 250000],
  ["Space Station", 408000],
  ["Hubble", 540000],
  ["GPS satellites", 20200000],
  ["The Moon", 384400000],
];
export const END_REF: Array<[string, number, string]> = [
  ["the Burj Khalifa", 828, "burj"],
  ["Mount Everest", 8849, "mountain"],
  ["a cruising airliner", 11000, "plane"],
  ["the edge of space", 1e5, "karman"],
  ["the Space Station", 408000, "iss"],
  ["GPS satellites", 20200000, "gps"],
];

// the card's title: N/D night or day, C/K cuts or keeps, L/P links or pastes, S/O squad or on your own
export const TYPES: Record<string, [string, string]> = {
  NCPS: ["Midnight Snack Crew", "You trim the crew's late-night bits and paste them in the group chat."],
  NCPO: ["Half Moon Snipper", "Solo after dark, you snip each clip down and paste it into a chat."],
  NCLS: ["Night Launch Squad", "You trim the squad's late-night runs and beam them out as links."],
  NCLO: ["Star Map Maker", "You map out the night alone, trim each clip neat and share a link."],
  NKPS: ["Night Owl Gossip", "You paste every second of the squad's late nights into the group chat."],
  NKPO: ["Clipboard Comet", "By yourself at night, you paste every clip whole straight into a chat."],
  NKLS: ["Moon Base Captain", "You host the crew every night and send full clips out as links."],
  NKLO: ["Starlight Librarian", "Alone after dark, you keep clips whole and lend them out as links."],
  DCPS: ["Lunchtime Meme Team", "You trim your friends' daytime moments and paste them in the group chat."],
  DCPO: ["Sunny Scissors", "Solo in the sunshine, you snip clips short and paste them in chats."],
  DCLS: ["Sunrise Rocket Club", "You and your friends trim daytime clips and launch them as links."],
  DCLO: ["Daylight Tailor", "On your own by day, you cut clips to fit and send files."],
  DKPS: ["Picnic Chatterbox", "By day, you paste the squad's full clips straight into the group chat."],
  DKPO: ["Sunshine Copycat", "Just you and the sun, copying whole clips and pasting them into a chat."],
  DKLS: ["Blue Sky Satellite", "You keep the crew's daytime clips whole and send everyone the link."],
  DKLO: ["Cloud Collector", "Alone in daylight, you keep every clip whole and share it as a file."],
};

export const cl = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const eio = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
export const eo = (p: number) => 1 - Math.pow(1 - p, 3);
export const eob = (p: number) => {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};
export const pad = (n: number) => String(n).padStart(2, "0");
/** "1 clip", "3 clips"; the plural is the word plus s unless given */
export const plural = (n: number, word: string, many = word + "s") => `${fmtN(n)} ${Math.round(n) === 1 ? word : many}`;
/** a count or size from main that might be missing or broken, as a finite number >= 0 */
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
export const fmtN = (n: number) => Math.round(n).toLocaleString("en-US");
export const pct = (x: number) => Math.round(x * 100) + "%";
export const fmtLen = (m: number) =>
  m < 1
    ? (m * 100).toFixed(1) + " cm"
    : m < 1000
      ? m.toFixed(1) + " m"
      : m < 1e7
        ? (m / 1000).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + " km"
        : fmtN(m / 1000) + " km";
export const fmtAlt = (m: number) =>
  m < 10 ? m.toFixed(1) + " m" : m < 1000 ? Math.round(m) + " m" : m < 1e5 ? (m / 1000).toFixed(1) + " km" : fmtN(m / 1000) + " km";
export const fmtHM = (s: number) => {
  // rounded to the minute first, or 59.5 minutes read "60 min"
  const t = Math.round(s / 60);
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (h) return `${h} h ${pad(m)} m`;
  return t ? `${t} min` : `${Math.round(s)} s`;
};
export const fmtHMS = (s: number) => `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.round(s % 60))}`;
/** a share of a minute as m:ss */
export const fmtS = (f: number) => {
  const s = Math.round(f * 60);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
export const hhmm = (h: number) => {
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    hh++;
    mm = 0;
  }
  return pad(hh % 24) + ":" + pad(mm);
};
export type Lch = [number, number, number];
export const parseL = (c: string | undefined): Lch => {
  const m = /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c || "");
  return m ? [+m[1], +m[2], +m[3]] : [0.72, 0.08, 300];
};
export const lch = (l: number, c: number, h: number, a?: number | string) =>
  `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}${a != null ? " / " + a : ""})`;
/** a game name that fits a stat chip, cut on a word */
export const shortName = (n: string) => {
  if (n.length <= 14) return n;
  let s = "";
  for (const x of n.split(/[\s:]+/)) {
    if ((s + " " + x).trim().length > 14) break;
    s = (s + " " + x).trim();
  }
  s = s.replace(/\s+(of|the|a|to|and)$/i, "");
  return s || n.slice(0, 14);
};

/** the reference that makes the number feel closest, within about 3x either way */
export function pickRef(list: Array<[string, number, string]>, actual: number): Ref {
  if (!(actual > 0)) return { name: list[0][0], h: list[0][1], kind: list[0][2] };
  let best: [string, number, string] | null = null;
  let bs = 1e9;
  for (const r of list) {
    const q = actual / r[1];
    if (q < 0.35 || q > 2.05) continue;
    const s = Math.abs(Math.log(q));
    if (s < bs) {
      bs = s;
      best = r;
    }
  }
  if (!best) best = list.reduce((a, r) => (Math.abs(Math.log(actual / r[1])) < Math.abs(Math.log(actual / a[1])) ? r : a));
  return { name: best[0], h: best[1], kind: best[2] };
}

/** day-of-year helpers for one year; leap years shift everything after February */
export interface Calendar {
  ms: number[];
  monthOf(d: number): number;
  fmtD(d: number): string;
}
export function calendar(year: number): Calendar {
  const ms = [0];
  for (let m = 0; m < 11; m++) ms.push(ms[m] + new Date(year, m + 1, 0).getDate());
  const monthOf = (d: number) => {
    let m = 0;
    for (let i = 0; i < 12; i++) if (d >= ms[i]) m = i;
    return m;
  };
  return { ms, monthOf, fmtD: (d) => `${MLs[monthOf(d)]} ${d - ms[monthOf(d)] + 1}` };
}

/** art first, the exe icon behind it; both go in as css layers or canvas fallbacks */
export const srcsOf = (g: { icon: string | null; iconPath: string | null } | null | undefined): string[] =>
  g ? [g.icon, g.iconPath ? fileUrl(g.iconPath) : null].filter((s): s is string => Boolean(s)) : [];
export const bgOf = (srcs: string[]) => srcs.map((s) => `url("${s}")`).join(", ");

export interface Game {
  name: string;
  srcs: string[];
  color: string;
  lch: Lch;
}
export interface Friend extends Omit<RecapFriend, "games"> {
  games: Array<{ name: string; n: number; srcs: string[] }>;
  lc: Lch;
}
export interface Owner {
  name: string;
  handle: string;
  av: string | null;
}

export type Model = ReturnType<typeof buildModel>;

const tidy = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "");

export function buildModel(R: RecapData, owner: Owner) {
  const year = Number.isInteger(R.year) ? R.year : new Date().getFullYear();
  const cal = calendar(year);
  // whatever main sent, as finite numbers: an older main or a half-written log leaves holes
  const RC = R.clips ?? ({} as Partial<RecapData["clips"]>);
  const C = {
    count: num(RC.count),
    seconds: num(RC.seconds),
    bytes: num(RC.bytes),
    named: num(RC.named),
    trimmed: num(RC.trimmed),
    noDuration: num(RC.noDuration),
    activeDays: num(RC.activeDays),
    streak: RC.streak && RC.streak.len > 0 ? RC.streak : null,
    latest: RC.latest ?? null,
  };
  const counts = (o: Record<string, number> | undefined) => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (num(v)) out[k] = num(v);
    return out;
  };
  const games: Game[] = (R.games ?? []).map((g) => ({ name: tidy(g.name) || "A game", srcs: srcsOf(g), color: g.color, lch: parseL(g.color) }));
  const ref = (g: RecapGameRef & { n: number }) => ({ name: tidy(g.name) || "A game", n: num(g.n), srcs: srcsOf(g) });
  const pts = (R.pts ?? []).filter((p) => Array.isArray(p) && p.length >= 5 && p.every((v) => Number.isFinite(v)));
  const hasGames = games.length > 0;
  const byHour = Array.from({ length: 24 }, (_, i) => num(R.byHour?.[i]));
  const hours = byHour.reduce((a, b) => a + b, 0);
  const tot = hours || 1;
  // ties go to the earlier hour
  let peak = 0;
  byHour.forEach((v, i) => {
    if (v > byHour[peak]) peak = i;
  });
  const nightShare = byHour.reduce((a, v, i) => a + (i >= 20 || i < 6 ? v : 0), 0) / tot;
  // loops, not Math.min(...pts): a spread of a big library overflows the call stack
  let firstDay = Infinity;
  let lastDay = -Infinity;
  for (const p of pts) {
    if (p[0] < firstDay) firstDay = p[0];
    if (p[0] > lastDay) lastDay = p[0];
  }
  if (!pts.length) firstDay = lastDay = 0;
  const dayMin = cal.ms[cal.monthOf(firstDay)];
  const dayMax = pts.length ? lastDay + 1 : dayMin + 1;
  const friends: Friend[] = (R.friends ?? [])
    .filter((f) => num(f.clips) > 0)
    .sort((a, b) => b.clips - a.clips)
    .map((f) => ({ ...f, name: tidy(f.name) || "A friend", user: tidy(f.user), color: f.color || "oklch(.75 .12 250)", games: (f.games ?? []).map(ref), lc: parseL(f.color) }));
  // averages from main, held to a share of the clip with the start before the end
  const tr = R.trims ?? { n: 0, s: 0, e: 0, surv: [] };
  const ts = cl(Number.isFinite(tr.s) ? tr.s : 0);
  const trims = {
    n: num(tr.n),
    s: ts,
    e: Math.max(ts, cl(Number.isFinite(tr.e) ? tr.e : 1)),
    surv: Array.from({ length: 60 }, (_, i) => cl(Number.isFinite(tr.surv?.[i]) ? tr.surv[i] : 0)),
  };
  const hasTrims = trims.n >= 5 && trims.e > trims.s;
  const act = counts(R.act);
  const exports = counts(R.exports);
  const exportsTotal = Object.values(exports).reduce((a, b) => a + b, 0);
  const clipN = (exports.trimmed_clipboard || 0) + (exports.clipboard || 0);
  const clipShare = exportsTotal ? clipN / exportsTotal : 0;
  const since = R.voiceDay == null || !Number.isFinite(R.voiceDay) ? [] : pts.filter((p) => p[0] >= R.voiceDay!);
  const crewShare = friends.length && since.length ? since.filter((p) => p[4] > 0).length / since.length : 0;
  const trimShare = C.count ? C.trimmed / C.count : 0;
  const code =
    (nightShare >= 0.5 ? "N" : "D") +
    (trimShare >= 0.25 ? "C" : "K") +
    (exportsTotal && clipShare < 0.6 ? "L" : "P") +
    (crewShare >= 0.5 ? "S" : "O");
  // clips with no known length count at the average of the ones that have one, so a library
  // still waiting on thumbnails doesn't print a stack of nothing
  const timed = C.count - C.noDuration;
  const footage = C.seconds + (timed > 0 ? (C.seconds / timed) * C.noDuration : 0);
  const frames = Math.round(footage * (num(R.fps) || 60));
  const gc: Record<number, number> = {};
  for (const p of pts) if (p[2] >= 0 && p[2] < 99) gc[p[2]] = (gc[p[2]] || 0) + 1;
  const topGames = Object.keys(gc)
    .map(Number)
    .filter((i) => games[i])
    .sort((a, b) => gc[b] - gc[a])
    .map((i) => ({ ...games[i], n: gc[i] }));
  return {
    cal,
    year,
    through: R.through || "",
    fps: num(R.fps) || 60,
    count: C.count,
    seconds: C.seconds,
    bytes: C.bytes,
    frames,
    /** any footage to print at all; without it the stack and the line have nothing to show */
    hasFootage: frames > 0,
    /** part of the footage is the average standing in for clips of unknown length */
    footageEstimated: C.noDuration > 0 && timed > 0,
    /** any clip has an hour; the clock and the night/day type mean nothing without */
    hasHours: hours > 0,
    /** anything was ever exported; the link/paste part of the type is a default without */
    hasExports: exportsTotal > 0,
    // 0.1 mm a printed sheet, 29.7 cm laid end to end
    stackH: frames * 1e-4,
    endH: frames * 0.297,
    pts,
    games,
    hasGames,
    topGames,
    byHour,
    peak,
    nightShare,
    dayMin,
    dayMax,
    activeDays: C.activeDays,
    streak: C.streak ?? { a: 0, b: 0, len: 0 },
    latest: C.latest && C.latest.t ? { t: C.latest.t, date: cal.fmtD(num(C.latest.day)) } : null,
    friends,
    pairs: counts(R.pairs),
    trims,
    hasTrims,
    trimmed: C.trimmed,
    named: C.named,
    act,
    exports,
    exportsTotal,
    clipN,
    speeds: counts(R.speeds),
    watch: R.watch?.top ? { ...R.watch.top, title: tidy(R.watch.top.title) || tidy(R.watch.top.file).replace(/\.[^.]+$/, "") } : null,
    watchSec: num(R.watch?.seconds),
    longestTitle: tidy(R.longestTitle) || null,
    code,
    owner: { name: tidy(owner.name) || "You", handle: tidy(owner.handle), av: owner.av || null },
  };
}

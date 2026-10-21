// what a shared recap page gets: the card and the numbers behind it, nothing that points back at
// the machine (no file paths, no clip file names). the page is web/recap-share/index.html, the
// server's side is docs/recap-share-api.md. the server rejects unknown fields, so a new field here
// has to be taught to the server first
import { END_REF, STACK_REF, TYPES, cl, fmtN, lch, pad, pickRef, plural, shortName, type Lch, type Model } from "./model";

export type ShareTier = "spot" | "close" | "near" | "off";
export type ShareQuestion = "stack" | "end" | "hour" | "who" | "cut" | "rw";

export interface ShareExtra {
  /** how close each guess came; spot and close count as right */
  guesses?: Partial<Record<ShareQuestion, ShareTier>>;
  /** other people's names and faces are theirs, so friends only go out when the owner says so */
  friends?: boolean;
}

/** an https url or a data:image url, null for none */
type Pic = string | null;

export interface SharePayload {
  v: 1;
  year: number;
  /** last day covered, "Oct 21" */
  through: string;
  /** the server puts the signed-in account here whatever is sent */
  owner: { name: string; handle: string; avatar: Pic };
  type: { code: string; name: string; line: string };
  clips: number;
  /** seconds of footage */
  footage: number;
  bytes: number;
  activeDays: number;
  streak: { days: number; from: string; to: string } | null;
  peakHour: number;
  byHour: number[];
  /** share of clips between 20:00 and 06:00 */
  nightShare: number;
  /** the card's day art: 24 columns from 06:00, each a column of palette indexes from the bottom */
  day: { palette: string[]; cols: number[][] };
  games: Array<{ name: string; icon: Pic; color: string; clips: number }>;
  /** every saved frame printed, 0.1 mm a sheet stacked, 29.7 cm a sheet end to end */
  stack: { meters: number; ref: string; refMeters: number } | null;
  line: { meters: number; ref: string; refMeters: number } | null;
  /** the average kept range, as shares of a minute; null without enough trims */
  trim: { from: number; to: number } | null;
  /** the star chart, most telling first */
  stats: Array<{ label: string; value: string; note: string }>;
  /** the four chips on the card front */
  chips: Array<{ label: string; value: string; icon: Pic; round: boolean }>;
  /** title only when the clip was renamed, an unnamed clip's title is its file name */
  rewatch: { title: string | null; count: number } | null;
  /** empty when nothing was guessed. lists are never null, the server only takes a list or nothing */
  guesses: Array<{ q: ShareQuestion; tier: ShareTier }>;
  /** empty with the crew off */
  friends: Array<{ name: string; avatar: Pic; clips: number }>;
}

// the server copies pictures from these hosts itself, so they go as links
const DISCORD = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i;
// it takes 64 KB of payload; inlined pictures stop short of that
const BUDGET = 60_000;
// icons show at 30 to 40 px on the card and the page, 96 covers a 2x screen
const SIDE = 96;
// on the public page one or two clips together is a chance meeting, not crew
const CREW_MIN = 3;

const norm = (s: string) => (s.startsWith("file:///") ? decodeURIComponent(s.slice(8)) : s);

// the server rejects control characters and anything over its caps, it never trims. cuts by
// utf-16 length, never under the length in code points, and keeps surrogate pairs whole
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const cap = (v: string | null | undefined, n: number) => {
  const t = String(v ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  let out = "";
  for (const ch of t) {
    if (out.length + ch.length > n - 1) break;
    out += ch;
  }
  return out.trimEnd() + "…";
};
// colours the server takes: #hex or a function of plain numbers
const COLOR = /^(#[0-9a-f]{3,8}|(oklch|rgba?|hsla?)\([\d.\s,/]+\))$/i;
// past this many dots the day art alone outgrows the 64 KB payload (48k clips is about 100 KB)
const DOTS = 4000;

/** "28 s" under a minute, where fmtHM says "0 min" */
export const fmtDur = (s: number) => {
  if (s < 59.5) return Math.max(1, Math.round(s)) + " s";
  const m = Math.round(s / 60);
  // past 100 hours the minutes are noise and push the card's footage line over its edge
  return m < 60 ? m + " min" : m >= 6000 ? `${fmtN(Math.round(m / 60))} h` : `${Math.floor(m / 60)} h ${pad(m % 60)} m`;
};
export const fmtBytes = (b: number) => (b >= 1e12 ? (b / 1e12).toFixed(1) + " TB" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1e6)) + " MB");

/** the card's title and line. with nothing ever exported the link or paste letter is only a default,
 * so the line says what the clips show and nothing about sharing */
export function typeOf(D: Model): [string, string] {
  const tp = TYPES[D.code] || ["Star Clipper", ""];
  if (D.hasExports) return [tp[0], tp[1]];
  const [n, c, , s] = D.code;
  return [tp[0], `${s === "S" ? "With the crew" : "On your own"} ${n === "N" ? "after dark" : "by day"}, you ${c === "C" ? "trim clips down" : "keep clips whole"}.`];
}

export interface Stat {
  l: string;
  v: string;
  n: string;
}
/** the star chart, most telling first; the app and the shared page both show this */
export function statsOf(D: Model): Stat[] {
  const a = D.act;
  const out: Stat[] = [];
  const add = (l: string, v: string | false | null | undefined, n = "") => {
    if (v) out.push({ l, v, n });
  };
  add("CLIPS SAVED", D.count > 0 && fmtN(D.count), D.bytes > 0 ? `${fmtBytes(D.bytes)} on disk` : "");
  add("OF FOOTAGE", D.seconds > 0 && fmtDur(D.seconds), D.activeDays > 0 ? `${plural(D.activeDays, "day")} with a clip` : "");
  if (D.streak.len > 1) add("DAY STREAK", fmtN(D.streak.len), `${D.cal.fmtD(D.streak.a)} to ${D.cal.fmtD(D.streak.b)}`);
  if (a.watch_session) add("REWATCHES", fmtN(a.watch_session), D.watchSec > 0 ? `${fmtDur(D.watchSec)} of watching` : "");
  if (D.exportsTotal) {
    const ex = D.exports;
    const parts: string[] = [];
    if (D.clipN) parts.push(`${fmtN(D.clipN)} copied`);
    if (ex.share_upload) parts.push(plural(ex.share_upload, "link"));
    if (ex.file) parts.push(plural(ex.file, "file"));
    add("EXPORTS", fmtN(D.exportsTotal), parts.join(" · "));
  }
  if (a.rename) add("RENAMES", fmtN(a.rename), D.named ? `${plural(D.named, "clip")} ${D.named === 1 ? "has" : "have"} a real name` : "");
  if (a.trim) add("TRIMS", fmtN(a.trim), D.trimmed ? `across ${plural(D.trimmed, "clip")}` : "");
  if (a.favorite_add) add("FAVOURITES", fmtN(a.favorite_add));
  const spd = Object.entries(D.speeds)
    .filter(([k]) => k !== "1")
    .sort((x, y) => y[1] - x[1]);
  if (a.speed_change) add("SPEED CHANGES", fmtN(a.speed_change), spd.length ? `mostly ${spd[0][0]}×` : "");
  if (a.delete) add("DELETED", fmtN(a.delete));
  if (a.volume_change) add("VOLUME TWEAKS", fmtN(a.volume_change));
  if (D.latest) add("LATEST CLIP", D.latest.t, D.latest.date);
  if (D.longestTitle && D.longestTitle.length > 40) add("LONGEST TITLE", D.longestTitle.length + " chars");
  return out;
}

export interface Chip {
  l: string;
  v: string;
  srcs?: string[];
  rad?: string;
}
/** the card's four chips, the first ones with something to say: no zeros, no chip twice */
export function chipsOf(D: Model, duo: { name: string; av: string | null } | null): Chip[] {
  const a = D.act;
  const top = D.hasGames ? D.topGames.find((g) => g.name && g.srcs) : undefined;
  const all: Array<Chip | false> = [
    !!top && { l: "MAIN GAME", v: shortName(top.name), srcs: top.srcs, rad: "9px" },
    !!duo && { l: "DUO", v: duo.name, srcs: duo.av ? [duo.av] : undefined, rad: "50%" },
    D.streak.len > 1 && { l: "LONGEST STREAK", v: plural(D.streak.len, "day") },
    !!a.trim && { l: "TRIM EDITS", v: fmtN(a.trim) },
    !!a.watch_session && { l: "REWATCHES", v: fmtN(a.watch_session) },
    D.activeDays > 0 && { l: "ACTIVE DAYS", v: fmtN(D.activeDays) },
    D.bytes > 0 && { l: "ON DISK", v: fmtBytes(D.bytes) },
    !!D.latest && { l: "LATEST CLIP", v: D.latest.t },
  ];
  return all.filter((c): c is Chip => Boolean(c)).slice(0, 4);
}

/** down to SIDE px as webp. also turns svg game art into a raster, the server takes no svg */
function shrink(src: string): Promise<string | null> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, SIDE / Math.max(im.naturalWidth || SIDE, im.naturalHeight || SIDE));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round((im.naturalWidth || SIDE) * k));
      c.height = Math.max(1, Math.round((im.naturalHeight || SIDE) * k));
      c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
      res(c.toDataURL("image/webp", 0.85));
    };
    im.onerror = () => res(null);
    im.src = src;
  });
}

/** the payload with every picture something the server keeps. game art on disk is inlined small
 * (1 to 2 KB as webp), so it doesn't hang on the server fetching it from discord; a picture only on
 * discord goes as a link, the server copies those; one from anywhere else is read through main (no
 * cors, can read the disk, see recapInlineImages) and inlined too, the server has no game art of its
 * own. over the size limit the inlined pictures go, least important first */
export async function sharePayloadWithPics(D: Model, extra: ShareExtra, read: (srcs: string[]) => Promise<Record<string, string | null>>): Promise<SharePayload> {
  const lists = [D.owner.av, ...D.topGames.slice(0, 5).flatMap((g) => g.srcs), ...(extra.friends === true ? D.friends.filter((f) => f.clips >= CREW_MIN).map((f) => f.av) : [])];
  const want = [...new Set(lists.filter((s): s is string => Boolean(s) && !DISCORD.test(s!)).map(norm))];
  const got = want.length ? await read(want).catch(() => ({}) as Record<string, string | null>) : {};
  const small = new Map<string, string>();
  for (const src of want) {
    const d = got[src];
    const sm = d && d.startsWith("data:image/") ? await shrink(d) : null;
    if (sm) small.set(src, sm);
  }
  // from disk first, then a discord link, then from elsewhere on the web
  const find = (srcs: Array<string | null | undefined>): Pic => {
    const all = srcs.filter((x): x is string => Boolean(x));
    for (const x of all.map(norm).filter((x) => !/^https?:/i.test(x))) if (small.has(x)) return small.get(x)!;
    const dc = all.find((x) => DISCORD.test(x));
    if (dc) return dc;
    for (const x of all.filter((x) => /^https:/i.test(x))) if (small.has(x)) return small.get(x)!;
    return null;
  };
  const p = sharePayload(D, extra, find);
  const drop: Array<{ icon: Pic }> = [...p.games.slice(1).reverse(), p.chips[0], p.games[0]].filter(Boolean);
  while (JSON.stringify(p).length > BUDGET) {
    const x = drop.find((g) => g.icon?.startsWith("data:"));
    if (!x) break;
    x.icon = null;
  }
  for (const f of p.friends.slice().reverse()) {
    if (JSON.stringify(p).length <= BUDGET) break;
    if (f.avatar?.startsWith("data:")) f.avatar = null;
  }
  return p;
}

/** `find` picks the picture for a list of sources; without it there are no pictures */
export function sharePayload(D: Model, extra: ShareExtra = {}, find: (srcs: Array<string | null | undefined>) => Pic = () => null): SharePayload {
  const pic = find;
  const tp = typeOf(D);
  const refA = pickRef(STACK_REF, D.stackH);
  const refB = pickRef(END_REF, D.endH);
  const crew = extra.friends === true ? D.friends.filter((f) => f.clips >= CREW_MIN).slice(0, 12) : [];
  const friends = crew.map((f) => ({ name: cap(f.name, 60), avatar: pic([f.av]), clips: f.clips }));

  // the same dots the card draws, bottom up in each hour, grouped by game
  const col = (g: number): Lch => (g >= 0 && g < 99 && D.games[g] ? D.games[g].lch : g === 99 ? [0.66, 0.07, 285] : [0.5, 0.03, 300]);
  // the server takes 16 colours; games past the 15th share the no-game grey
  const OTHER = lch(0.5, 0.03, 300);
  const palette: string[] = [];
  const cols: Array<Array<{ g: number; c: number }>> = Array.from({ length: 24 }, () => []);
  for (const p of D.pts.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const j = cl(Math.floor(p[1] - 6), 0, 23);
    const h = (6 + j) % 24;
    const k = col(p[2]);
    const c = D.hasGames ? lch(k[0], k[1], k[2]) : h >= 20 || h < 6 ? "oklch(.72 .21 330)" : "oklch(.8 .09 300)";
    let i = palette.indexOf(c);
    if (i < 0 && palette.length >= 15) i = palette.indexOf(OTHER);
    if (i < 0) i = palette.push(palette.length >= 15 ? OTHER : c) - 1;
    cols[j].push({ g: p[2], c: i });
  }
  for (const g of cols) g.sort((x, y) => x.g - y.g);
  // a big year thins every hour by the same factor so the shape holds; an hour with a clip keeps a dot
  const total = cols.reduce((n, g) => n + g.length, 0);
  const thin = total > DOTS ? total / DOTS : 1;
  const dayCols = cols.map((g) => {
    if (thin === 1) return g.map((d) => d.c);
    const n = Math.max(g.length ? 1 : 0, Math.round(g.length / thin));
    return Array.from({ length: n }, (_, i) => g[Math.floor((i * g.length) / n)].c);
  });

  const stats = statsOf(D)
    .slice(0, 24)
    .map((x) => ({ label: cap(x.l, 40), value: cap(x.v, 40), note: cap(x.n, 120) }));
  // the crew chip only with friends shared
  const chips = chipsOf(D, crew[0] ?? null).map((x) => ({ label: cap(x.l, 30), value: cap(x.v, 60), icon: x.srcs ? pic(x.srcs) : null, round: x.rad === "50%" }));

  const guesses = extra.guesses
    ? (Object.entries(extra.guesses) as Array<[ShareQuestion, ShareTier | undefined]>).filter((e): e is [ShareQuestion, ShareTier] => Boolean(e[1])).map(([q, tier]) => ({ q, tier }))
    : null;

  return {
    v: 1,
    year: D.year,
    through: cap(D.through, 20),
    owner: { name: cap(D.owner.name, 60), handle: cap(D.owner.handle, 40), avatar: pic([D.owner.av]) },
    type: { code: D.code, name: cap(tp[0], 80), line: cap(tp[1], 300) },
    clips: D.count,
    footage: D.seconds,
    bytes: D.bytes,
    activeDays: Math.min(366, D.activeDays),
    streak: D.streak.len > 1 ? { days: D.streak.len, from: D.cal.fmtD(D.streak.a), to: D.cal.fmtD(D.streak.b) } : null,
    peakHour: D.peak,
    byHour: D.byHour.slice(),
    nightShare: Math.round(D.nightShare * 1000) / 1000,
    day: { palette, cols: dayCols },
    games: D.topGames
      .filter((g) => g.name && g.srcs)
      .slice(0, 5)
      .map((g) => ({ name: cap(g.name, 80), icon: pic(g.srcs), color: COLOR.test(g.color || "") ? g.color : lch(g.lch[0], g.lch[1], g.lch[2]), clips: g.n })),
    stack: D.hasFootage ? { meters: Math.round(D.stackH * 10) / 10, ref: refA.name, refMeters: refA.h } : null,
    line: D.hasFootage ? { meters: Math.round(D.endH), ref: refB.name, refMeters: refB.h } : null,
    trim: D.hasTrims ? { from: Math.round(D.trims.s * 1000) / 1000, to: Math.round(D.trims.e * 1000) / 1000 } : null,
    stats,
    chips,
    // the app shows a most-watched clip from 3 sessions up, one or two is no habit
    rewatch: D.watch && D.watch.sessions >= 3 ? { title: D.watch.title && D.watch.title !== (D.watch.file || "").replace(/\.[^.]+$/, "") ? cap(D.watch.title, 160) || null : null, count: D.watch.sessions } : null,
    guesses: guesses ?? [],
    friends,
  };
}

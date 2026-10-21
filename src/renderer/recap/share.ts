// what a shared recap page gets: the card and the numbers behind it, nothing that points back at
// the machine (no file paths, no clip file names). the page is web/recap-share/index.html, the
// server's side is docs/recap-share-api.md. the server rejects unknown fields, so a new field here
// has to be taught to the server first
import { END_REF, STACK_REF, TYPES, cl, fmtHM, fmtN, lch, pickRef, shortName, type Lch, type Model } from "./model";

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
  stack: { meters: number; ref: string; refMeters: number };
  line: { meters: number; ref: string; refMeters: number };
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
  return p;
}

/** `find` picks the picture for a list of sources; without it there are no pictures */
export function sharePayload(D: Model, extra: ShareExtra = {}, find: (srcs: Array<string | null | undefined>) => Pic = () => null): SharePayload {
  const a = D.act;
  const pic = find;
  const tp = TYPES[D.code] || ["Star Clipper", ""];
  const refA = pickRef(STACK_REF, D.stackH);
  const refB = pickRef(END_REF, D.endH);
  const friends = extra.friends === true ? D.friends.filter((f) => f.clips >= CREW_MIN).map((f) => ({ name: f.name, avatar: pic([f.av]), clips: f.clips })) : [];

  // the same dots the card draws, bottom up in each hour, grouped by game
  const col = (g: number): Lch => (g >= 0 && g < 99 && D.games[g] ? D.games[g].lch : g === 99 ? [0.66, 0.07, 285] : [0.5, 0.03, 300]);
  const palette: string[] = [];
  const cols: Array<Array<{ g: number; c: number }>> = Array.from({ length: 24 }, () => []);
  for (const p of D.pts.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const j = cl(Math.floor(p[1] - 6), 0, 23);
    const h = (6 + j) % 24;
    const k = col(p[2]);
    const c = D.hasGames ? lch(k[0], k[1], k[2]) : h >= 20 || h < 6 ? "oklch(.72 .21 330)" : "oklch(.8 .09 300)";
    let i = palette.indexOf(c);
    if (i < 0) i = palette.push(c) - 1;
    cols[j].push({ g: p[2], c: i });
  }
  for (const g of cols) g.sort((x, y) => x.g - y.g);

  // the star chart, kept in step with chartStats() in Recap.tsx
  const stats: SharePayload["stats"] = [];
  const add = (label: string, v: string | number | false | null | undefined, note = "") => {
    if (v) stats.push({ label, value: String(v), note });
  };
  add("CLIPS SAVED", fmtN(D.count), `${(D.bytes / 1e9).toFixed(1)} GB on disk`);
  add("OF FOOTAGE", fmtHM(D.seconds), `${D.activeDays} days with a clip`);
  if (D.streak.len > 1) add("DAY STREAK", D.streak.len, `${D.cal.fmtD(D.streak.a)} to ${D.cal.fmtD(D.streak.b)}`);
  if (a.watch_session) add("REWATCHES", fmtN(a.watch_session), `${fmtHM(D.watchSec)} of watching`);
  if (D.exportsTotal) {
    const ex = D.exports;
    const parts: string[] = [];
    if (D.clipN) parts.push(`${D.clipN} copied`);
    if (ex.share_upload) parts.push(`${ex.share_upload} links`);
    if (ex.file) parts.push(`${ex.file} files`);
    add("EXPORTS", fmtN(D.exportsTotal), parts.join(" · "));
  }
  if (a.rename) add("RENAMES", fmtN(a.rename), D.named ? `${D.named} clips have a real name` : "");
  if (a.trim) add("TRIMS", fmtN(a.trim), `across ${D.trimmed} clips`);
  if (a.favorite_add) add("FAVOURITES", fmtN(a.favorite_add));
  const spd = Object.entries(D.speeds)
    .filter(([k]) => k !== "1")
    .sort((x, y) => y[1] - x[1]);
  if (a.speed_change) add("SPEED CHANGES", fmtN(a.speed_change), spd.length ? `mostly ${spd[0][0]}×` : "");
  if (a.delete) add("DELETED", fmtN(a.delete));
  if (a.volume_change) add("VOLUME TWEAKS", fmtN(a.volume_change));
  if (D.latest) add("LATEST CLIP", D.latest.t, D.latest.date);
  if (D.longestTitle && D.longestTitle.length > 40) add("LONGEST TITLE", D.longestTitle.length + " chars");

  // the card's chips, as cardChips() in Recap.tsx; the crew chip only with friends shared
  const chips: SharePayload["chips"] = [];
  const top = D.topGames[0];
  if (D.hasGames && top) chips.push({ label: "MAIN GAME", value: shortName(top.name), icon: pic(top.srcs), round: false });
  else chips.push({ label: "ACTIVE DAYS", value: String(D.activeDays), icon: null, round: false });
  if (friends.length) chips.push({ label: "DUO", value: friends[0].name, icon: friends[0].avatar, round: true });
  else chips.push({ label: "ON DISK", value: (D.bytes / 1e9).toFixed(1) + " GB", icon: null, round: false });
  chips.push(D.streak.len > 1 ? { label: "LONGEST STREAK", value: D.streak.len + " days", icon: null, round: false } : { label: "ACTIVE DAYS", value: String(D.activeDays), icon: null, round: false });
  chips.push(a.trim ? { label: "TRIM EDITS", value: fmtN(a.trim), icon: null, round: false } : { label: "REWATCHES", value: fmtN(a.watch_session || 0), icon: null, round: false });

  const guesses = extra.guesses
    ? (Object.entries(extra.guesses) as Array<[ShareQuestion, ShareTier | undefined]>).filter((e): e is [ShareQuestion, ShareTier] => Boolean(e[1])).map(([q, tier]) => ({ q, tier }))
    : null;

  return {
    v: 1,
    year: D.year,
    through: D.through,
    owner: { name: D.owner.name, handle: D.owner.handle, avatar: pic([D.owner.av]) },
    type: { code: D.code, name: tp[0], line: tp[1] },
    clips: D.count,
    footage: D.seconds,
    bytes: D.bytes,
    activeDays: D.activeDays,
    streak: D.streak.len > 1 ? { days: D.streak.len, from: D.cal.fmtD(D.streak.a), to: D.cal.fmtD(D.streak.b) } : null,
    peakHour: D.peak,
    byHour: D.byHour.slice(),
    nightShare: Math.round(D.nightShare * 1000) / 1000,
    day: { palette, cols: cols.map((g) => g.map((d) => d.c)) },
    games: D.topGames.slice(0, 5).map((g) => ({ name: g.name, icon: pic(g.srcs), color: g.color, clips: g.n })),
    stack: { meters: Math.round(D.stackH * 10) / 10, ref: refA.name, refMeters: refA.h },
    line: { meters: Math.round(D.endH), ref: refB.name, refMeters: refB.h },
    trim: D.hasTrims ? { from: Math.round(D.trims.s * 1000) / 1000, to: Math.round(D.trims.e * 1000) / 1000 } : null,
    stats,
    chips,
    rewatch: D.watch ? { title: D.watch.title && D.watch.title !== D.watch.file.replace(/\.[^.]+$/, "") ? D.watch.title : null, count: D.watch.sessions } : null,
    guesses: guesses ?? [],
    friends,
  };
}

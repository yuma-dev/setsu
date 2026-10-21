// year recap: every number the recap pages show, from the clip folder, .clip_metadata and the
// activity log. computed when the recap opens, nothing is cached
const path = require('path');
const fs = require('fs').promises;
const { app, dialog, clipboard, nativeImage, net } = require('electron');
const clipsModule = require('./clips');
const metadata = require('./metadata');
const thumbnails = require('./thumbnails');
const clipdip = require('./clipdip');
const discord = require('./discord');
const share = require('./share');
const { mapLimit } = require('../utils/pool');

// top games get their own colour, the rest show as "other"
const GAME_COLORS = [
  'oklch(.70 .2 320)', 'oklch(.78 .14 70)', 'oklch(.78 .13 180)', 'oklch(.79 .16 140)',
  'oklch(.78 .13 15)', 'oklch(.76 .14 115)', 'oklch(.72 .15 250)', 'oklch(.72 .17 290)',
  'oklch(.68 .19 25)', 'oklch(.82 .14 92)', 'oklch(.80 .1 220)'
];
const FRIEND_COLORS = ['oklch(.80 .13 175)', 'oklch(.82 .14 80)', 'oklch(.76 .13 15)', 'oklch(.75 .12 250)', 'oklch(.80 .14 140)'];
const OTHER_GAME = 99;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// a trim that keeps the whole clip within this is no trim
const TRIM_SLACK_S = 0.5;
// with no signed-in account in any call, the one in this share of voice clips is taken for the owner
const OWNER_SHARE = 0.6;
// below this a year has too little for the recap: the clock, the stack and the type all read as
// noise, and three days at least make it a year of clipping, not one evening
const MIN_CLIPS = 10;
const MIN_DAYS = 3;

// the 2026 recap came out on Oct 21 2026 and covers the year up to that day, both Oct 21s in;
// any other year is its calendar year. [y, m0, d] of the first day and the day after the last
const SPANS = { 2026: { from: [2025, 9, 21], to: [2026, 9, 22] } };
const spanOf = (year) => {
  const s = SPANS[year];
  return s ? { from: new Date(...s.from), to: new Date(...s.to) } : { from: new Date(year, 0, 1), to: new Date(year + 1, 0, 1) };
};
const inSpan = (d, sp) => Boolean(d) && d >= sp.from && d < sp.to;
// days since the span's first day. Date.UTC keeps a DST change from shifting the count
const dayIn = (d, from) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 864e5);
const fmtDay = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const pad = (n) => String(n).padStart(2, '0');

const tally = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const validDate = (v) => {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

// who "you" are in the voice rosters: the Discord account the recorder and the library's presence
// are signed in as, and the Setsu account's. counting rosters can't tell you from a friend who is
// in every call too, the tie went to whoever Discord listed first
async function whoAmI(getSettings) {
  const ids = new Set();
  const names = new Set();
  const rpcUser = discord.selfUser();
  if (rpcUser?.id) ids.add(rpcUser.id);
  const [rec, acct] = await Promise.all([
    clipdip.control('status').catch(() => null),
    // /auth/me can take its 10 s timeout when the server's away, the recap won't wait that long
    Promise.race([share.testConnection(getSettings).catch(() => null), new Promise((r) => setTimeout(r, 3000, null))])
  ]);
  // the recorder only says the username, usernames are unique on Discord
  const u = rec?.ok && rec.discord?.state === 'connected' ? rec.discord.user : null;
  if (typeof u === 'string' && u && u !== 'unknown') names.add(u.toLowerCase());
  const did = acct?.success ? acct.user?.discordId : null;
  if (typeof did === 'string' && did) ids.add(did);
  return (p) => ids.has(p.id) || names.has(String(p.username).toLowerCase());
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** the activity log over a recap's span, each line as written; the log is one file per month */
async function readActivity(sp) {
  const dir = path.join(app.getPath('userData'), 'activity_logs');
  const out = [];
  for (let m = new Date(sp.from.getFullYear(), sp.from.getMonth(), 1); m < sp.to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const y = m.getFullYear();
    let text;
    try {
      text = await fs.readFile(path.join(dir, `user_activity_log_${y}-${pad(m.getMonth() + 1)}.jsonl`), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e.type !== 'string') continue;
        // the first and last month are only partly in; a line without a time goes by its year
        const t = validDate(e.timestamp);
        if (t ? inSpan(t, sp) : e.year === y) out.push(e);
      } catch {
        // half-written last line from a crash
      }
    }
  }
  return out;
}

// the rail button asks on every launch; a scan per ask would double the library's own at startup
const eligibleCache = new Map();
const ELIGIBLE_TTL_MS = 10 * 60 * 1000;

/**
 * whether a year has enough for the recap, from the clip list alone: clips and distinct days
 * @param {number} year
 * @param {Function} getSettings
 * @returns {Promise<{ok: boolean, clips: number, days: number, need: {clips: number, days: number}}>}
 */
async function recapEligible(year, getSettings) {
  year = Number(year) || new Date().getFullYear();
  const settings = await getSettings();
  const key = `${settings?.clipLocation || ''}|${year}`;
  const hit = eligibleCache.get(key);
  if (hit && Date.now() - hit.at < ELIGIBLE_TTL_MS) return hit.res;
  const sp = spanOf(year);
  let clips = 0;
  const days = new Set();
  try {
    for (const c of await clipsModule.getClips(getSettings)) {
      const d = validDate(c.createdAt);
      if (!inSpan(d, sp)) continue;
      clips++;
      days.add(dayIn(d, sp.from));
    }
  } catch {
    // no readable clip folder, nothing to recap
  }
  const res = { ok: clips >= MIN_CLIPS && days.size >= MIN_DAYS, clips, days: days.size, need: { clips: MIN_CLIPS, days: MIN_DAYS } };
  eligibleCache.set(key, { at: Date.now(), res });
  return res;
}

/**
 * @param {number} year
 * @param {Function} getSettings
 */
async function getRecap(year, getSettings) {
  year = Number(year) || new Date().getFullYear();
  const settings = await getSettings();
  const folder = settings.clipLocation;
  const metaDir = metadata.getMetadataFolder(folder);
  const now = new Date();
  const sp = spanOf(year);
  const isMe = whoAmI(getSettings);

  const all = await clipsModule.getClips(getSettings);
  const inYear = all.filter((c) => inSpan(validDate(c.createdAt), sp));
  let sidecars = new Set();
  try {
    sidecars = new Set((await fs.readdir(metaDir)).map((f) => f.toLowerCase()));
  } catch {
    // no metadata folder, every clip is plain
  }
  const has = (name, ext) => sidecars.has(`${metadata.metadataSafeName(name)}.${ext}`.toLowerCase());
  const side = (name, ext) => path.join(metaDir, `${metadata.metadataSafeName(name)}.${ext}`);

  const iconOk = new Map();
  const iconExists = (p) => {
    if (!iconOk.has(p)) iconOk.set(p, fs.access(p).then(() => true, () => false));
    return iconOk.get(p);
  };

  const clips = await mapLimit(inYear, 16, async (c) => {
    const d = new Date(c.createdAt);
    const full = path.join(folder, c.originalName);
    const [stat, thumbMeta, info, trim, tags, speed] = await Promise.all([
      fs.stat(full).catch(() => null),
      thumbnails.getThumbnailMetadata(c.thumbnailPath).catch(() => null),
      has(c.originalName, 'gameinfo') ? readJson(side(c.originalName, 'gameinfo')) : null,
      c.isTrimmed ? readJson(side(c.originalName, 'trim')) : null,
      has(c.originalName, 'tags') ? readJson(side(c.originalName, 'tags')) : null,
      has(c.originalName, 'speed') ? readJson(side(c.originalName, 'speed')) : null
    ]);
    const duration = Number(thumbMeta?.duration) > 0 ? Number(thumbMeta.duration) : 0;
    const game = metadata.normalizeGame(info?.game);
    let iconPath = null;
    if (game && typeof info.icon_file === 'string' && info.icon_file) {
      const p = path.join(folder, 'icons', info.icon_file);
      if (await iconExists(p)) iconPath = p;
    }
    const realTrim =
      trim && duration > 0 && Number.isFinite(trim.start) && Number.isFinite(trim.end) &&
      trim.end - trim.start > TRIM_SLACK_S &&
      (trim.start > TRIM_SLACK_S || trim.end < duration - TRIM_SLACK_S)
        ? { start: Math.max(0, trim.start), end: Math.min(duration, trim.end) }
        : null;
    const base = path.basename(c.originalName, path.extname(c.originalName));
    return {
      file: c.originalName,
      full,
      title: c.customName || base,
      named: Boolean(c.customName) && c.customName !== base,
      private: Array.isArray(tags) && tags.includes('Private'),
      date: d,
      day: dayIn(d, sp.from),
      hour: d.getHours() + d.getMinutes() / 60,
      bytes: stat?.size || 0,
      duration,
      game,
      icon: game ? { icon: game.icon_url ? game.icon_url.replace(/([?&]size=)\d+/, '$1128') : null, iconPath } : null,
      discord: metadata.normalizeDiscordInfo(info?.discord),
      trim: realTrim,
      speed: Number(speed) || 1,
      thumbnailPath: c.thumbnailPath
    };
  });
  clips.sort((a, b) => a.date - b.date);

  // owner: the signed-in account seen most in the calls, else the one in nearly every call
  // as long as nobody ties with them
  const voiceClips = clips.filter((c) => c.discord);
  const seen = new Map();
  const mine = new Set();
  const me = await isMe;
  for (const c of voiceClips) {
    for (const p of c.discord.participants) {
      if (p.bot) continue;
      tally(seen, p.id);
      if (me(p)) mine.add(p.id);
    }
  }
  const ranks = top(seen, Infinity);
  const [first, second] = ranks;
  const ownerId = ranks.find(([id]) => mine.has(id))?.[0] ?? (first && first[1] >= voiceClips.length * OWNER_SHARE && first[1] > (second?.[1] ?? 0) ? first[0] : null);
  const isOwner = Boolean(ownerId);
  const latestOf = (id) => {
    let p = null;
    for (const c of voiceClips) for (const q of c.discord.participants) if (q.id === id) p = q;
    return p;
  };
  let owner = null;
  if (isOwner) {
    const p = latestOf(ownerId);
    owner = { id: ownerId, name: p.global_name || p.nick || p.username || 'You', handle: p.username || '', avatar: p.avatar_url || null };
  }
  const friendsIn = (c) => (c.discord ? c.discord.participants.filter((p) => !p.bot && p.id !== owner?.id) : []);

  // games, by clip count
  const gameCount = new Map();
  const gameRef = new Map();
  for (const c of clips) {
    if (!c.game) continue;
    tally(gameCount, c.game.id);
    const ref = gameRef.get(c.game.id);
    if (!ref) gameRef.set(c.game.id, { name: c.game.name, icon: c.icon.icon, iconPath: c.icon.iconPath });
    else {
      ref.icon = ref.icon || c.icon.icon;
      ref.iconPath = ref.iconPath || c.icon.iconPath;
    }
  }
  const ranked = top(gameCount, Infinity).map(([id]) => id);
  const topIds = ranked.slice(0, GAME_COLORS.length);
  const games = topIds.map((id, i) => ({ ...gameRef.get(id), color: GAME_COLORS[i] }));
  const gameIdx = (c) => (!c.game ? -1 : topIds.includes(c.game.id) ? topIds.indexOf(c.game.id) : OTHER_GAME);
  const refN = (id, n) => ({ ...gameRef.get(id), n });

  // the day ends at 06:00, a 01:30 clip belongs to the night before
  const pts = clips.map((c) => {
    const late = c.hour < 6;
    return [Math.max(0, c.day - (late ? 1 : 0)), Math.round((late ? c.hour + 24 : c.hour) * 100) / 100, gameIdx(c), Math.round(c.duration), friendsIn(c).length];
  });

  const byHour = Array(24).fill(0);
  for (const c of clips) byHour[c.date.getHours()]++;

  // calendar days, not nights, for streaks
  const days = [...new Set(clips.map((c) => c.day))].sort((a, b) => a - b);
  let streak = null;
  let run = null;
  for (const d of days) {
    run = run && d === run.b + 1 ? { ...run, b: d, len: run.len + 1 } : { a: d, b: d, len: 1 };
    if (!streak || run.len > streak.len) streak = run;
  }
  const latestClip = clips.reduce((best, c) => {
    const h = c.hour < 6 ? c.hour + 24 : c.hour;
    return !best || h > best.h ? { c, h } : best;
  }, null);

  // friends: everyone else in voice, top five
  const fr = new Map();
  for (const c of clips) {
    for (const p of friendsIn(c)) {
      let f = fr.get(p.id);
      if (!f) fr.set(p.id, (f = { id: p.id, p, clips: 0, first: c.day, games: new Map() }));
      f.p = p;
      f.clips++;
      if (c.game) tally(f.games, c.game.id);
    }
  }
  const friendList = [...fr.values()].sort((a, b) => b.clips - a.clips).slice(0, 5);
  const friends = friendList.map((f, i) => ({
    id: f.id,
    name: f.p.nick || f.p.global_name || f.p.username || 'A friend',
    user: f.p.username || '',
    clips: f.clips,
    first: f.first,
    games: top(f.games, 3).map(([id, n]) => refN(id, n)),
    av: f.p.avatar_url ? f.p.avatar_url.replace(/([?&]size=)\d+/, '$1256') : null,
    color: FRIEND_COLORS[i]
  }));
  const friendIds = new Set(friends.map((f) => f.id));
  const pairs = {};
  for (const c of clips) {
    const ids = friendsIn(c).map((p) => p.id).filter((id) => friendIds.has(id)).sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = `${ids[i]}-${ids[j]}`;
      pairs[k] = (pairs[k] || 0) + 1;
    }
  }

  // trims as a share of each clip, so long recordings line up with 60 s replays
  const trimmed = clips.filter((c) => c.trim);
  const surv = Array(60).fill(0);
  let sumS = 0;
  let sumE = 0;
  for (const c of trimmed) {
    const s = c.trim.start / c.duration;
    const e = c.trim.end / c.duration;
    sumS += s;
    sumE += e;
    for (let i = 0; i < 60; i++) if ((i + 0.5) / 60 >= s && (i + 0.5) / 60 < e) surv[i]++;
  }
  const n = trimmed.length;

  const events = await readActivity(sp);
  const act = {};
  const exports = {};
  const speeds = {};
  const watched = new Map();
  let watchSeconds = 0;
  for (const e of events) {
    act[e.type] = (act[e.type] || 0) + 1;
    const d = e.details || {};
    if (e.type === 'export' && d.destination) exports[d.destination] = (exports[d.destination] || 0) + 1;
    if (e.type === 'speed_change' && d.speed != null) speeds[String(d.speed)] = (speeds[String(d.speed)] || 0) + 1;
    if (e.type === 'watch_session' && d.originalName) {
      const w = watched.get(d.originalName) || { sessions: 0, seconds: 0, real: 0 };
      const sec = Number(d.durationSeconds) || 0;
      w.sessions++;
      w.seconds += sec;
      // opened and actually watched, not opened to rename or trim and closed again
      if (sec >= 10) w.real++;
      watched.set(d.originalName, w);
      watchSeconds += sec;
    }
  }

  // the clip on repeat: the one watched for real (10 s or more) the most. counting every open picked
  // clips opened over and over to rename or trim. only clips that still exist and were watched at
  // least 3 times; private ones never show
  const byFile = new Map(clips.map((c) => [c.file, c]));
  const showcase = async (file, w) => {
    const c = byFile.get(file) || null;
    const lib = c ? null : all.find((x) => x.originalName === file);
    if (c?.private || (!c && !lib)) return null;
    if (lib) {
      // watched this year, saved in an earlier one
      const tags = has(file, 'tags') ? await readJson(side(file, 'tags')) : null;
      if (Array.isArray(tags) && tags.includes('Private')) return null;
    }
    const meta = c || (await thumbnails.getThumbnailMetadata(lib.thumbnailPath).catch(() => null));
    const duration = c ? c.duration : Number(meta?.duration) || 0;
    const trim = c ? c.trim : lib.isTrimmed ? await readJson(side(file, 'trim')) : null;
    const info = c ? null : has(file, 'gameinfo') ? await readJson(side(file, 'gameinfo')) : null;
    const date = c ? c.date : validDate(lib.createdAt);
    const thumb = c ? c.thumbnailPath : lib.thumbnailPath;
    // with no known length the clip plays its last 25 s from the trim, or from the start, until
    // the video itself ends
    const known = trim?.end > 0 ? Math.min(trim.end, duration || trim.end) : duration;
    const start = Math.max(0, trim?.start > 0 ? trim.start : 0, known - 25);
    const end = known > start ? known : start + 25;
    return {
      file,
      title: (c ? c.title : lib.customName) || path.basename(file, path.extname(file)),
      sessions: w.real,
      seconds: w.seconds,
      video: path.join(folder, file),
      poster: thumb && (await fs.access(thumb).then(() => true, () => false)) ? thumb : null,
      game: (c ? c.game : metadata.normalizeGame(info?.game))?.name || null,
      date: !date ? '' : date.getFullYear() === year ? fmtDay(date) : `${fmtDay(date)}, ${date.getFullYear()}`,
      start,
      end,
      speed: c ? c.speed : 1
    };
  };
  let watchTop = null;
  for (const [file, w] of [...watched.entries()].sort((a, b) => b[1].real - a[1].real || b[1].seconds - a[1].seconds)) {
    if (w.real < 3) break;
    watchTop = await showcase(file, w);
    if (watchTop) break;
  }

  const longest = clips.filter((c) => c.named && !c.private).reduce((a, c) => (!a || c.title.length > a.length ? c.title : a), null);
  const through = now < sp.to ? now : new Date(sp.to.getFullYear(), sp.to.getMonth(), sp.to.getDate() - 1);
  const voiceFirst = clips.find((c) => c.discord);

  return {
    year,
    from: `${sp.from.getFullYear()}-${pad(sp.from.getMonth() + 1)}-${pad(sp.from.getDate())}`,
    through: fmtDay(through),
    fps: 60,
    owner,
    clips: {
      count: clips.length,
      seconds: Math.round(clips.reduce((s, c) => s + c.duration, 0)),
      noDuration: clips.filter((c) => !(c.duration > 0)).length,
      bytes: clips.reduce((s, c) => s + c.bytes, 0),
      named: clips.filter((c) => c.named).length,
      trimmed: n,
      activeDays: days.length,
      streak,
      latest: latestClip
        ? { t: `${pad(latestClip.c.date.getHours())}:${pad(latestClip.c.date.getMinutes())}`, day: latestClip.c.day }
        : null
    },
    byHour,
    games,
    pts,
    friends,
    pairs,
    voiceDay: voiceFirst ? voiceFirst.day : null,
    trims: { n, s: n ? sumS / n : 0, e: n ? sumE / n : 0, surv: surv.map((v) => (n ? Math.round((v / n) * 1000) / 1000 : 0)) },
    act,
    exports,
    speeds,
    watch: { sessions: act.watch_session || 0, seconds: Math.round(watchSeconds), top: watchTop },
    longestTitle: longest
  };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** data urls for the card's pictures: html-to-image can't fetch file:// and the cdn sends no cors */
async function inlineImages(srcs) {
  const out = {};
  await Promise.all(
    (Array.isArray(srcs) ? srcs : []).map(async (src) => {
      try {
        if (/^https:\/\//.test(src)) {
          const res = await net.fetch(src);
          if (!res.ok) throw new Error(`${res.status}`);
          const type = res.headers.get('content-type') || 'image/png';
          out[src] = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
        } else {
          const type = MIME[path.extname(src).toLowerCase()] || 'image/png';
          out[src] = `data:${type};base64,${(await fs.readFile(src)).toString('base64')}`;
        }
      } catch {
        out[src] = null;
      }
    })
  );
  return out;
}

const pngBuffer = (dataUrl) => Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');

async function saveCard(mainWindow, dataUrl, fileName) {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('pictures'), path.basename(String(fileName || 'setsu-recap.png'))),
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.writeFile(result.filePath, pngBuffer(dataUrl));
  return { saved: true, path: result.filePath };
}

function copyCard(dataUrl) {
  clipboard.writeImage(nativeImage.createFromBuffer(pngBuffer(dataUrl)));
  return true;
}

// the dev mixer's levels (__recapMix() in the recap), kept as a file so they can be read back
// and written into recap/audio.ts
const mixPath = () => path.join(app.getPath('userData'), 'recap-mix.json');

async function loadMix() {
  try {
    return JSON.parse(await fs.readFile(mixPath(), 'utf8'));
  } catch {
    return null;
  }
}

async function saveMix(mix) {
  await fs.writeFile(mixPath(), JSON.stringify(mix, null, 2));
  return mixPath();
}

// the link handed out per year, with the key that takes it down; anonymous shares can only be
// replaced or removed with that key, so it lives here and nowhere else
const sharesFile = () => path.join(app.getPath('userData'), 'recap-shares.json');

async function loadShares() {
  try {
    const j = JSON.parse(await fs.readFile(sharesFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

async function getShare(year) {
  return (await loadShares())[String(year)] || null;
}

async function setShare(year, entry) {
  const all = await loadShares();
  if (entry) all[String(year)] = entry;
  else delete all[String(year)];
  await fs.writeFile(sharesFile(), JSON.stringify(all, null, 2));
}

module.exports = { getRecap, recapEligible, inlineImages, saveCard, copyCard, loadMix, saveMix, getShare, setShare };

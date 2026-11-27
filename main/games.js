// games across the library: which games the clips are from (rail list, game filter), searching
// Discord's app list for the "Set game" picker, and writing a picked game into .gameinfo.
// the list is the one clipdip caches; reading it here avoids a process spawn per keystroke
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const metadata = require('./metadata');
const libraryWorker = require('./library-worker');

const MAX_RESULTS = 30;

function cachePath() {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(local, 'clipdip', 'data', 'gamedb', 'detectable.json');
}

// same normalization as the recorder's matcher: zero-width padding and trademark signs go,
// everything not a letter or digit separates words
function norm(s) {
  return String(s || '')
    .replace(/[​-‍⁠﻿­™®©]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function iconUrlOf(app) {
  if (app.icon) return `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.png?size=128`;
  if (app.steam) return `https://cdn.cloudflare.steamstatic.com/steam/apps/${app.steam}/library_600x900.jpg`;
  return null;
}

let index = null;

/** the cached list, refetched by clipdip when missing (first run before clipdip ever started) */
async function loadIndex(resolveGames) {
  const file = cachePath();
  let st = await fs.stat(file).catch(() => null);
  if (!st && resolveGames) {
    // an empty batch still makes the CLI download and cache the list
    await resolveGames([]).catch(() => null);
    st = await fs.stat(file).catch(() => null);
  }
  if (!st) return null;
  if (index && index.mtimeMs === st.mtimeMs) return index;
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const apps = (Array.isArray(raw.apps) ? raw.apps : []).map((a) => ({
      id: a.id,
      name: a.name,
      icon_url: iconUrlOf(a),
      steam_appid: a.steam || null,
      key: norm(a.name),
      alias: (a.aliases || []).map(norm)
    }));
    index = { mtimeMs: st.mtimeMs, apps };
    return index;
  } catch (error) {
    logger.warn(`Game list unreadable: ${error.message}`);
    return null;
  }
}

/**
 * picker results; the library's own games rank first
 * @param {string} query
 * @param {Array<{id: string, name: string, icon_url: string|null}>} libraryGames
 */
async function searchGames(query, libraryGames, resolveGames) {
  const q = norm(query);
  const own = Array.isArray(libraryGames) ? libraryGames : [];
  if (!q) return own.slice(0, MAX_RESULTS).map(pickPublic);

  const ownIds = new Set(own.map((g) => g.id));
  const scored = [];
  const rank = (key) => {
    if (key === q) return 0;
    if (key.startsWith(q)) return 1;
    if (key.includes(` ${q}`)) return 2;
    if (key.includes(q)) return 3;
    return -1;
  };
  for (const g of own) {
    const r = rank(norm(g.name));
    if (r >= 0) scored.push({ r: r - 0.5, g });
  }
  const idx = await loadIndex(resolveGames);
  for (const a of idx?.apps ?? []) {
    if (ownIds.has(a.id)) continue;
    let r = rank(a.key);
    for (const al of a.alias) {
      const ar = rank(al);
      if (ar >= 0 && (r < 0 || ar < r)) r = ar;
    }
    if (r >= 0) scored.push({ r, g: a });
  }
  // shorter names first within a rank, "Minecraft" before "Minecraft Story Mode"
  scored.sort((x, y) => x.r - y.r || x.g.name.length - y.g.name.length);
  const seen = new Set();
  const out = [];
  for (const { g } of scored) {
    const k = norm(g.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(pickPublic(g));
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function pickPublic(g) {
  return { id: g.id, name: g.name, icon_url: g.icon_url ?? null, steam_appid: g.steam_appid ?? null };
}

/**
 * every game in the library with its clip count, plus which game each clip is
 * @returns {Promise<{games: object[], byClip: Object<string,string>}>}
 */
async function getLibraryGames(clipNames, getSettings) {
  const settings = await getSettings();
  // every clip's .gameinfo at launch, read in the library worker
  return libraryWorker.run('libraryGames', {
    clipLocation: settings.clipLocation,
    metadataFolder: metadata.getMetadataFolder(settings.clipLocation),
    names: Array.isArray(clipNames) ? clipNames : []
  });
}

/**
 * `game` null marks the clips as not a game, the backfill leaves those alone
 * @returns {Promise<string[]>} clip names written
 */
async function setClipGame(clipNames, game, getSettings) {
  const settings = await getSettings();
  const metadataFolder = metadata.getMetadataFolder(settings.clipLocation);
  const value = game
    ? {
        id: String(game.id),
        name: String(game.name),
        ...(game.steam_appid ? { steam_appid: String(game.steam_appid) } : {}),
        ...(game.icon_url ? { icon_url: String(game.icon_url) } : {}),
        source: 'manual'
      }
    : false;
  const written = [];
  for (const clipName of Array.isArray(clipNames) ? clipNames : []) {
    const file = path.join(metadataFolder, `${metadata.metadataSafeName(clipName)}.gameinfo`);
    let info = {};
    try {
      info = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      // unparseable: don't clobber it with a game-only file
      if (error.code !== 'ENOENT') continue;
    }
    await metadata.writeFileAtomically(file, JSON.stringify({ ...info, game: value }, null, 2));
    written.push(clipName);
  }
  return written;
}

/** every game clipdip ever showed in the Discord status, newest first; written by clipdip */
async function getPlayedGames() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  try {
    const raw = JSON.parse(await fs.readFile(path.join(appData, 'clipdip', 'config', 'played_games.json'), 'utf8'));
    return (Array.isArray(raw) ? raw : [])
      .filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')
      .map((g) => ({ id: g.id, name: g.name, icon_url: g.icon_url ?? null, last_seen: Number(g.last_seen) || 0 }));
  } catch {
    return [];
  }
}

module.exports = { searchGames, getLibraryGames, setClipGame, loadIndex, getPlayedGames };

'use strict';
// the library-wide file reads a launch fires at once: the clip walk, every .customname, every
// .tags and .gameinfo, the folder size. ~20k fs calls whose js side alone held the main process
// for over a second, and electron routes clicks and scrolls through that same thread. they run in
// the library worker (main/library-worker.js); in-process only when the worker is down.
// node builtins and ./read-retry only, the worker loads these sources with nothing else around them.
// no logger, no telemetry: problems come back in the result for the caller to report.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { readFileRetry } = require('./read-retry');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov']);
// concurrent fs.stat calls during a library walk
const STAT_CONCURRENCY = 32;
const METADATA_READ_CONCURRENCY = 64;
const GAMEINFO_CONCURRENCY = 16;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** flat .clip_metadata/ key: "highlights/gameplay.mp4" becomes "highlights--gameplay.mp4" */
function metadataSafeName(clipName) {
  return clipName.replace(/\//g, '--');
}

/** cache file name for a clip's thumbnail, md5 of the absolute clip path */
function thumbnailFileName(clipPath) {
  return `${crypto.createHash('md5').update(clipPath).digest('hex')}.jpg`;
}

/**
 * the `game` block clipdip writes on save, the library backfill or a manual pick writes later.
 * `false` means picked as not a game
 * @param {any} raw
 * @returns {{id: string, name: string, steam_appid: string|null, icon_url: string|null}|null}
 */
function normalizeGame(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  if (!raw.id || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    steam_appid: typeof raw.steam_appid === 'string' ? raw.steam_appid : null,
    icon_url: typeof raw.icon_url === 'string' ? raw.icon_url : null
  };
}

/**
 * every clip under dir, names relative to baseDir with forward slashes. dot folders and
 * icons/ are skipped
 * @returns {Promise<{ files: {name: string, mtimeMs: number}[], unreadable: {errno: string, depth: number}[], dropped: {count: number, errno?: string} }>}
 */
async function walkClips(dir, baseDir = dir) {
  const unreadable = [];
  const dropped = { count: 0, errno: undefined };
  const walk = async (current, depth) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      // the root failing is the caller's error, a subtree failing only loses that subtree
      if (depth === 0) throw error;
      unreadable.push({ errno: error.code, depth });
      return [];
    }
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'icons') dirs.push(entry.name);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(entry.name);
      }
    }
    const subtrees = Promise.all(dirs.map((name) => walk(path.join(current, name), depth + 1)));
    // bounded: an unbounded fan-out queued thousands of stats at once and starved other file ops
    const stats = await mapLimit(files, STAT_CONCURRENCY, async (name) => {
      const fullPath = path.join(current, name);
      try {
        const st = await fs.stat(fullPath);
        // whole ms like the Date the old walk returned; the renderer compares createdAt against
        // its snapshot, and a fraction would make every card look changed
        return { name: path.relative(baseDir, fullPath).replace(/\\/g, '/'), mtimeMs: Math.round(st.mtimeMs) };
      } catch (error) {
        // tallied, not reported per file: one bad drive drops thousands
        dropped.count += 1;
        if (!dropped.errno) dropped.errno = error.code;
        return null;
      }
    });
    return [...stats.filter(Boolean), ...(await subtrees).flat()];
  };
  const files = await walk(dir, 0);
  return { files, unreadable, dropped };
}

/**
 * the clip list, newest first, with custom names, recording dates and metadata flags
 * @param {{ clipLocation: string, thumbnailCacheDir: string }} args
 */
async function scanLibrary({ clipLocation, thumbnailCacheDir }) {
  const metadataFolder = path.join(clipLocation, '.clip_metadata');
  const startedAt = Date.now();
  const walked = await walkClips(clipLocation, clipLocation);
  const files = walked.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanMs = Date.now() - startedAt;

  // one readdir instead of ~3 ENOENT probes per clip; lowercased both sides since NTFS is
  // case-insensitive and casing can drift
  let metadataFiles = new Set();
  let metadataDirErrno;
  try {
    metadataFiles = new Set((await fs.readdir(metadataFolder)).map((f) => f.toLowerCase()));
  } catch (error) {
    // missing folder: no metadata. anything else means every clip loses its custom name and flags
    if (error.code !== 'ENOENT') metadataDirErrno = error.code;
  }
  const hasMetadata = (name) => metadataFiles.has(name.toLowerCase());
  const readErrors = { count: 0, errno: undefined };

  const clips = await mapLimit(files, METADATA_READ_CONCURRENCY, async (file) => {
    const fullPath = path.join(clipLocation, file.name);
    const safeName = metadataSafeName(file.name);
    let customName = path.basename(file.name, path.extname(file.name));
    let createdAt = file.mtimeMs;
    if (hasMetadata(`${safeName}.customname`)) {
      try {
        customName = await readFileRetry(path.join(metadataFolder, `${safeName}.customname`));
      } catch (error) {
        readErrors.count += 1;
        readErrors.errno = readErrors.errno || error.code;
      }
    }
    // recording timestamp beats file mtime when present, ISO 8601 e.g. "2023-08-02T22:07:31+02:00"
    if (hasMetadata(`${safeName}.date`)) {
      try {
        const recordingDate = new Date(await readFileRetry(path.join(metadataFolder, `${safeName}.date`)));
        if (!isNaN(recordingDate.getTime())) createdAt = recordingDate.getTime();
      } catch (error) {
        readErrors.count += 1;
        readErrors.errno = readErrors.errno || error.code;
      }
    }
    return {
      originalName: file.name,
      customName,
      createdAt,
      thumbnailPath: path.join(thumbnailCacheDir, thumbnailFileName(fullPath)),
      isTrimmed: hasMetadata(`${safeName}.trim`),
      isFavorite: hasMetadata(`${safeName}.favorite`)
    };
  });

  return {
    clips,
    scanMs,
    totalMs: Date.now() - startedAt,
    problems: { unreadable: walked.unreadable, dropped: walked.dropped, metadataDirErrno, readErrors }
  };
}

/** bytes under dir, every file (clips, thumbnails, metadata) for the folder's real footprint */
async function dirSize(dir) {
  const failed = { count: 0, errno: undefined };
  const sizeOf = async (current) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      failed.count += 1;
      if (!failed.errno) failed.errno = error.code;
      return 0;
    }
    const sizes = await mapLimit(entries, STAT_CONCURRENCY, async (entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) return sizeOf(fullPath);
      if (!entry.isFile()) return 0;
      try {
        return (await fs.stat(fullPath)).size;
      } catch (error) {
        failed.count += 1;
        if (!failed.errno) failed.errno = error.code;
        return 0;
      }
    });
    return sizes.reduce((a, b) => a + b, 0);
  };
  const bytes = await sizeOf(dir);
  return { bytes, failed };
}

/**
 * tags per clip: [] for no tags file. a file that couldn't be read gets no entry at all, so the
 * renderer keeps what it shows instead of saving [] over it later
 * @param {{ metadataFolder: string, names: string[] }} args
 */
async function readTags({ metadataFolder, names }) {
  const byName = {};
  const unreadable = { count: 0, errno: undefined };
  // unparseable files: they come back as [] like before, the caller reports the loss
  const corrupt = [];
  await mapLimit(names, 32, async (clipName) => {
    let data;
    try {
      data = await readFileRetry(path.join(metadataFolder, `${metadataSafeName(clipName)}.tags`));
      const parsed = JSON.parse(data);
      byName[clipName] = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        byName[clipName] = [];
      } else if (data === undefined) {
        unreadable.count += 1;
        unreadable.errno = unreadable.errno || error.code;
      } else {
        corrupt.push({ file_bytes: Buffer.byteLength(data, 'utf8'), errno: error.code });
        byName[clipName] = [];
      }
    }
  });
  return { byName, unreadable, corrupt };
}

/**
 * games across the library from each clip's .gameinfo, most clips first, plus which game every
 * clip belongs to
 * @param {{ clipLocation: string, metadataFolder: string, names: string[] }} args
 */
async function libraryGames({ clipLocation, metadataFolder, names }) {
  const games = new Map();
  const byClip = {};
  await mapLimit(names, GAMEINFO_CONCURRENCY, async (clipName) => {
    let info;
    try {
      info = JSON.parse(await readFileRetry(path.join(metadataFolder, `${metadataSafeName(clipName)}.gameinfo`)));
    } catch {
      return;
    }
    const game = normalizeGame(info.game);
    if (!game) return;
    byClip[clipName] = game.id;
    let g = games.get(game.id);
    if (!g) {
      g = { id: game.id, name: game.name, icon_url: game.icon_url, iconPath: null, count: 0 };
      games.set(game.id, g);
    }
    g.count += 1;
    if (!g.icon_url && game.icon_url) g.icon_url = game.icon_url;
    if (!g.iconPath && typeof info.icon_file === 'string' && info.icon_file) {
      g.iconPath = path.join(clipLocation, 'icons', info.icon_file);
    }
  });
  // a local exe icon only stands in when there's no Discord art, check it exists once per game
  await Promise.all(
    [...games.values()].map(async (g) => {
      if (g.icon_url || !g.iconPath) return;
      const ok = await fs.access(g.iconPath).then(() => true, () => false);
      if (!ok) g.iconPath = null;
    })
  );
  const list = [...games.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { games: list, byClip };
}

/** which of these files exist */
async function existing({ paths }) {
  return mapLimit(paths, METADATA_READ_CONCURRENCY, (p) => fs.access(p).then(() => true, () => false));
}

module.exports = {
  VIDEO_EXTENSIONS,
  mapLimit,
  metadataSafeName,
  thumbnailFileName,
  normalizeGame,
  walkClips,
  scanLibrary,
  dirSize,
  readTags,
  libraryGames,
  existing,
  // what the worker may be asked to run
  jobs: {
    walkClips: ({ dir, baseDir }) => walkClips(dir, baseDir || dir),
    scanLibrary,
    dirSize: ({ dir }) => dirSize(dir),
    readTags,
    libraryGames,
    existing
  }
};

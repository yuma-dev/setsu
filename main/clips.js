const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const thumbnailsModule = require('./thumbnails');
const libraryWorker = require('./library-worker');
const { metadataSafeName } = require('./library-fs');
const { logActivity } = require('../utils/activity-tracker');

// count from the last successful getClips(); kept so callers that only need
// the count (telemetry) skip a rescan. null = no successful scan yet this session
let lastClipCount = null;

/** skips dirs starting with '.' and 'icons'; runs in the library worker
 * @param {string} dir
 * @param {string} baseDir
 * @returns {Promise<Array<{name: string, date: Date}>>}
 */
async function walkClips(dir, baseDir) {
  const walked = await libraryWorker.run('walkClips', { dir, baseDir });
  reportWalkProblems(walked);
  return walked.files.map((f) => ({ name: f.name, date: new Date(f.mtimeMs) }));
}

function reportWalkProblems({ unreadable, dropped }) {
  for (const { errno, depth } of unreadable) {
    logger.error(`Error reading a clip subfolder (${errno})`);
    // This whole subtree just vanished from the library with no user-visible sign.
    telemetry.event('clips_subtree_unreadable', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno, depth },
      coalesceMs: 60000
    });
  }
  if (dropped.count > 0) {
    logger.error(`Could not stat ${dropped.count} clip(s) (${dropped.errno})`);
    telemetry.event('clip_stat_dropped', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: dropped.errno, count: dropped.count }
    });
  }
}

// Module state
let periodicSaveInterval = null;

function getLastClipsFilePath() {
  return path.join(app.getPath('userData'), 'last-clips.json');
}

// snapshots the current clip list for next-session comparison
async function saveCurrentClipList(getSettings) {
  const LAST_CLIPS_FILE = getLastClipsFilePath();
  // which step we died on, for telemetry only
  let stage = 'scan';

  try {
    const settings = await getSettings();
    const clipsFolder = settings?.clipLocation;

    if (!clipsFolder) {
      logger.warn('No clip location set, skipping clip list save');
      return;
    }

    const files = await walkClips(clipsFolder, clipsFolder);
    const clipNames = files.map((file) => file.name);

    const clipListData = {
      timestamp: Date.now(),
      clips: clipNames
    };

    const tempFile = LAST_CLIPS_FILE + '.tmp';
    const jsonData = JSON.stringify(clipListData, null, 2);

    stage = 'write';
    await fs.writeFile(tempFile, jsonData, 'utf8');

    stage = 'verify';
    const verification = await fs.readFile(tempFile, 'utf8');
    stage = 'parse';
    JSON.parse(verification);

    stage = 'rename';
    await fs.rename(tempFile, LAST_CLIPS_FILE);

    logger.info(`Saved ${clipNames.length} clips for next session comparison`);
  } catch (error) {
    logger.error('Error saving current clip list:', error);
    telemetry.event('clip_list_save_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: error.code, stage },
      error
    });

    try {
      const tempFile = LAST_CLIPS_FILE + '.tmp';
      await fs.unlink(tempFile);
    } catch (cleanupError) {
    }
  }
}

/** watched-clips file: clips the user has opened in the player; a clip is
 * "new" until it appears here */
function getWatchedClipsFilePath() {
  return path.join(app.getPath('userData'), 'watched-clips.json');
}

// in-memory watched set, loaded once per process; null = not loaded yet
let watchedClips = null;

/** loads into watchedClips; returns false if the file doesn't exist yet (pre-migration installs) */
async function loadWatchedClips() {
  if (watchedClips) return true;
  let data = null;
  try {
    data = await fs.readFile(getWatchedClipsFilePath(), 'utf8');
    const parsed = JSON.parse(data);
    watchedClips = new Set(Array.isArray(parsed.watched) ? parsed.watched : []);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading watched clips file:', error);
      // every clip in the library gets re-flagged as new after this
      telemetry.event('watched_clips_reset', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          // set is always empty here (not loaded yet); file_bytes carries the real magnitude
          prior_size: watchedClips ? watchedClips.size : 0,
          file_bytes: data == null ? 0 : Buffer.byteLength(data, 'utf8'),
          errno: error.code
        },
        error
      });
      // unreadable/corrupt: start over rather than flagging the whole library
      watchedClips = new Set();
      return true;
    }
    return false;
  }
}

async function saveWatchedClips() {
  if (!watchedClips) return;
  const file = getWatchedClipsFilePath();
  const tempFile = file + '.tmp';
  try {
    await fs.writeFile(tempFile, JSON.stringify({ watched: [...watchedClips] }), 'utf8');
    await fs.rename(tempFile, file);
  } catch (error) {
    logger.error('Error saving watched clips file:', error);
    try {
      await fs.unlink(tempFile);
    } catch {
    }
  }
}

// records clips opened in the player, so they stop counting as new
async function markClipsWatched(clipNames) {
  const names = (Array.isArray(clipNames) ? clipNames : [clipNames]).filter(Boolean);
  if (names.length === 0) return;
  if (!(await loadWatchedClips())) watchedClips = new Set();
  let changed = false;
  for (const name of names) {
    if (!watchedClips.has(name)) {
      watchedClips.add(name);
      changed = true;
    }
  }
  if (changed) await saveWatchedClips();
}

/** "new" = never opened in the player. Migration: pre-tracking installs seed
 * watched from the old last-clips.json snapshot; true first run (neither file) seeds the whole library as watched */
async function getNewClipsInfo(getSettings, knownNames) {
  try {
    const settings = await getSettings();
    const clipsFolder = settings?.clipLocation;
    if (!clipsFolder) return { newClips: [], totalNewCount: 0 };

    // renderer passes names from its own get-clips scan; only walk again if it didn't
    const currentClips = Array.isArray(knownNames)
      ? knownNames
      : (await walkClips(clipsFolder, clipsFolder)).map((file) => file.name);

    if (!(await loadWatchedClips())) {
      let previousClips = null;
      try {
        const data = await fs.readFile(getLastClipsFilePath(), 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.clips)) previousClips = parsed.clips;
      } catch (error) {
        // missing/corrupt snapshot: treated as first run below. missing file
        // is the normal pre-migration case; anything else lost the seed
        if (error.code !== 'ENOENT') {
          telemetry.event('watched_migration_failed', {
            kind: telemetry.KIND.SILENT_FAILURE,
            severity: telemetry.SEVERITY.WARNING,
            context: { errno: error.code },
            error
          });
        }
      }
      watchedClips = new Set(previousClips ?? currentClips);
      logger.info(
        previousClips
          ? `Seeded watched clips from last-session snapshot (${watchedClips.size} clips)`
          : `First run: seeded all ${watchedClips.size} clips as watched`
      );
      await saveWatchedClips();
    }

    // Absence from a scan does not mean deletion: the user may have switched
    // folders, disconnected a drive, or encountered an unreadable subtree.
    // Keep watched history so returning clips retain their existing status.

    const newClips = currentClips.filter((clipName) => !watchedClips.has(clipName));
    logger.info(`Found ${newClips.length} unwatched clips`);

    return {
      newClips,
      totalNewCount: newClips.length
    };
  } catch (error) {
    logger.error('Error getting new clips info:', error);
    return { newClips: [], totalNewCount: 0 };
  }
}

/** recording timestamp from metadata beats file creation time when available
 * @param {Function} getSettings
 * @param {string} fileName
 * @returns {Promise<Object>}
 */
async function getNewClipInfo(getSettings, fileName) {
  const settings = await getSettings();
  const filePath = path.join(settings.clipLocation, fileName);
  const metadataFolder = path.join(settings.clipLocation, ".clip_metadata");
  const datePath = path.join(metadataFolder, `${metadataSafeName(fileName)}.date`);
  const stats = await fs.stat(filePath);

  // default to file system time
  let createdAt = stats.birthtimeMs || stats.ctimeMs;

  try {
    const dateStr = await fs.readFile(datePath, "utf8");
    // ISO 8601, e.g. "2023-08-02T22:07:31+02:00"
    const recordingDate = new Date(dateStr);
    if (!isNaN(recordingDate.getTime())) {
      createdAt = recordingDate.getTime();
      logger.info(`Using recording timestamp for new clip ${fileName}: ${dateStr}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.error("Error reading date metadata for new clip:", error);
    }
  }

  // a merged save lands with its name already written
  let customName = path.basename(fileName, path.extname(fileName));
  try {
    customName = (await fs.readFile(path.join(metadataFolder, `${metadataSafeName(fileName)}.customname`), "utf8")) || customName;
  } catch {
  }

  const newClipInfo = {
    originalName: fileName,
    customName,
    createdAt: createdAt,
    tags: []
  };

  return newClipInfo;
}

function startPeriodicSave(getSettings) {
  stopPeriodicSave();

  periodicSaveInterval = setInterval(() => {
    saveCurrentClipList(getSettings).catch((error) => {
      logger.error('Error in periodic save:', error);
    });
  }, 5 * 60 * 1000);
}

function stopPeriodicSave() {
  if (periodicSaveInterval) {
    clearInterval(periodicSaveInterval);
    periodicSaveInterval = null;
  }
}

/** newest first; .mp4/.avi/.mov; missing optional metadata files
 * (.customname/.trim/.date) fall back cleanly. returns [] on failure
 * @param {Function} getSettings - resolves to { clipLocation: string }
 * @returns {Promise<Array<{originalName: string, customName: string, createdAt: number, thumbnailPath: string, isTrimmed: boolean, isFavorite: boolean}>>}
 */
async function getClips(getSettings) {
  const settings = await getSettings();
  const clipsFolder = settings?.clipLocation;
  const scanStartedAt = Date.now();

  try {
    // dev profiler spans, no-op in production (global.__perf only exists in dev)
    const tScan = global.__perf?.now();
    const result = await libraryWorker.run('scanLibrary', {
      clipLocation: clipsFolder,
      thumbnailCacheDir: thumbnailsModule.getCacheDir()
    });
    if (tScan != null) {
      global.__perf.fsSpan('scan-clips-dir', tScan, result.scanMs, { clips: result.clips.length });
      global.__perf.span('read-clip-metadata', tScan + result.scanMs, result.totalMs - result.scanMs, { clips: result.clips.length });
    }
    const { problems } = result;
    reportWalkProblems(problems);
    // metadata exists but is unreadable: every clip loses its custom name and trim flag silently
    if (problems.metadataDirErrno) {
      telemetry.event('clip_metadata_dir_unreadable', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: { errno: problems.metadataDirErrno, clips: result.clips.length }
      });
    }
    if (problems.readErrors.count > 0) {
      logger.error(`Could not read custom name/date for ${problems.readErrors.count} clip(s) (${problems.readErrors.errno})`);
    }
    telemetry.metric('library_scan_ms', Date.now() - scanStartedAt, { unit: 'ms' });
    lastClipCount = result.clips.length;
    return result.clips;
  } catch (error) {
    logger.error("Error reading directory:", error);
    // library renders empty, which reads to the user as "no clips"
    telemetry.event('clips_scan_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code },
      error
    });
    return [];
  }
}

/** every file under dir (video, thumbnail, metadata) for the folder's real disk footprint,
 * walked in the library worker */
async function dirSize(dir) {
  const { bytes, failed } = await libraryWorker.run('dirSize', { dir });
  if (failed.count > 0) {
    // under-reported size looks like the user freed space they still use
    telemetry.event('folder_size_underreported', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno_count: failed.count, errno: failed.errno }
    });
  }
  return bytes;
}

// cached so repeated renderer polls don't re-walk the tree; nothing needs
// this fresh, so a stale-but-cheap hit within TTL beats another sweep
let folderSizeCache = { location: null, bytes: 0, at: 0 };
const FOLDER_SIZE_TTL = 4 * 60 * 1000; // 4 min, comfortably below the 5-min poll

/** total bytes of the clip folder; recomputed at most once per TTL, cached
 * otherwise. the walk runs in the library worker */
async function getClipsFolderSize(getSettings) {
  const settings = await getSettings();
  const clipsFolder = settings?.clipLocation;
  if (!clipsFolder) return { bytes: 0 };

  const now = Date.now();
  if (
    folderSizeCache.location === clipsFolder &&
    now - folderSizeCache.at < FOLDER_SIZE_TTL
  ) {
    return { bytes: folderSizeCache.bytes };
  }

  try {
    const bytes = await dirSize(clipsFolder);
    telemetry.metric('folder_size_ms', Date.now() - now, { unit: 'ms' });
    folderSizeCache = { location: clipsFolder, bytes, at: now };
    return { bytes };
  } catch (error) {
    logger.error('Error computing clips folder size:', error);
    // fall back to the last known value rather than flashing 0
    return { bytes: folderSizeCache.location === clipsFolder ? folderSizeCache.bytes : 0 };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** deletes a clip and its metadata (.customname/.trim/.layers/.favorite/thumbnail)
 * @param {string} clipName
 * @param {Function} getSettings
 * @param {Object} thumbnailsModule
 * @param {Object} videoPlayer
 * @returns {Promise<Object>}
 */
async function deleteClip(clipName, getSettings, thumbnailsModule, videoPlayer) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const metadataFolder = path.join(settings.clipLocation, ".clip_metadata");
  const safeName = metadataSafeName(clipName);
  const customNamePath = path.join(metadataFolder, `${safeName}.customname`);
  const trimDataPath = path.join(metadataFolder, `${safeName}.trim`);
  const layersPath = path.join(metadataFolder, `${safeName}.layers`);
  const favoritePath = path.join(metadataFolder, `${safeName}.favorite`);
  const thumbnailPath = thumbnailsModule.generateThumbnailPath(clipPath);

  const sidecars = [customNamePath, trimDataPath, layersPath, favoritePath, thumbnailPath];

  if (videoPlayer) {
    videoPlayer.src = "";
  }

  const maxRetries = 50; // ~5s total retry time
  const retryDelay = 100; // 0.1 s between attempts

  // the video only ever goes to the recycle bin, never unlinked. electron reports a file held by
  // the player or antivirus as a generic failure, so every error gets the retry budget
  let retryErrno;
  let lastError = null;
  let trashed = false;
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      await shell.trashItem(clipPath);
      trashed = true;
      if (retry > 0) {
        // locked files cost up to ~5s of retries today with nothing reported
        telemetry.event('clip_delete_retried', {
          kind: telemetry.KIND.DEGRADED,
          severity: telemetry.SEVERITY.INFO,
          context: { retries_used: retry, errno: retryErrno },
          coalesceMs: 600000
        });
      }
      break;
    } catch (error) {
      lastError = error;
      // trashItem has no ENOENT code, so a vanished file only shows up on stat
      if (!(await fs.stat(clipPath).then(() => true, () => false))) {
        trashed = true;
        break;
      }
      retryErrno = error.code;
      if (retry < maxRetries - 1) await delay(retryDelay);
    }
  }

  if (!trashed) {
    logger.error(`Error deleting clip ${clipName}:`, lastError);
    telemetry.event('clip_delete_failed', {
      kind: telemetry.KIND.ERROR,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: lastError?.code, retries_used: maxRetries, via: 'trash' },
      error: lastError
    });
    return {
      success: false,
      error: "Could not move the clip to the Recycle Bin. The file may be in use.",
    };
  }

  // sidecars go along so a restore from the bin keeps the name and trim. unlink is fine for them,
  // the video is already gone and a leftover .trim would stick to the next clip with this name
  for (const file of sidecars) {
    try {
      await shell.trashItem(file);
    } catch {
      try {
        await fs.unlink(file);
      } catch (e) {
        if (e.code !== 'ENOENT') logger.warn(`Could not remove ${path.basename(file)} for ${clipName}:`, e);
      }
    }
  }

  logActivity('delete', { clipName });
  return { success: true };
}

/**
 * @param {string} clipName
 * @param {Function} getSettings
 * @returns {Promise<Object>}
 */
async function revealClip(clipName, getSettings) {
  try {
    const settings = await getSettings();
    const clipPath = path.join(settings.clipLocation, clipName);
    shell.showItemInFolder(clipPath);
    return { success: true };
  } catch (error) {
    logger.error('Error revealing clip:', error);
    return { success: false, error: error.message };
  }
}

/** count from the last successful getClips(), no rescan
 * @returns {number|null} null if none yet
 */
function getLastClipCount() {
  return lastClipCount;
}

module.exports = {
  saveCurrentClipList,
  getNewClipsInfo,
  markClipsWatched,
  getNewClipInfo,
  startPeriodicSave,
  stopPeriodicSave,
  getClips,
  getLastClipCount,
  getClipsFolderSize,
  deleteClip,
  revealClip
};

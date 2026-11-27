'use strict';
// files ffprobe can't open, remembered by the size and mtime they failed at. a broken clip used
// to be probed about 7 times per launch forever (fast path, queue retries, analysis, open)
const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { redactPaths } = require('./telemetry/scrub');

const FILE_NAME = 'unreadable-clips.json';

// clipPath -> { size, mtimeMs }
let entries = null;
let loading = null;
let saveTimer = null;

function filePath() {
  return path.join(app.getPath('userData'), 'thumbnail-cache', FILE_NAME);
}

async function load() {
  if (entries) return entries;
  if (!loading) {
    loading = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(filePath(), 'utf8'));
        entries = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        entries = {};
      }
      return entries;
    })();
  }
  return loading;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const file = filePath();
    try {
      await fs.writeFile(`${file}.tmp`, JSON.stringify(entries));
      await fs.rename(`${file}.tmp`, file);
    } catch (error) {
      logger.warn(`[clip-health] save failed: ${error.message}`);
    }
  }, 1000);
}

/** true while the file failed before and hasn't changed since; a finished copy or a repair re-tries it */
async function isKnownUnreadable(clipPath) {
  const map = await load();
  const entry = map[clipPath];
  if (!entry) return false;
  try {
    const stat = await fs.stat(clipPath);
    if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) return true;
  } catch { /* gone, forget it */ }
  delete map[clipPath];
  scheduleSave();
  return false;
}

async function markUnreadable(clipPath) {
  const map = await load();
  try {
    const stat = await fs.stat(clipPath);
    map[clipPath] = { size: stat.size, mtimeMs: stat.mtimeMs };
    scheduleSave();
  } catch { /* deleted meanwhile */ }
}

/**
 * A file another program is still writing. Explorer's copy (CopyFileEx) sets the final size up
 * front, so a size that stopped changing says nothing; but the writer holds it without write
 * sharing, so opening it for writing fails with EBUSY until the copy is done. ffprobe meanwhile
 * gets "Permission denied" and exits 1. Opening without writing leaves the mtime alone.
 */
async function isBeingWritten(clipPath) {
  let handle;
  try {
    handle = await fs.open(clipPath, 'r+');
    return false;
  } catch (error) {
    // EPERM/EACCES is also a read-only file, which would wait forever
    return error?.code === 'EBUSY';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** ffprobe's own reason ("moov atom not found", "Permission denied"), without the path in front */
function probeFailureReason(error) {
  const text = String(error?.stderr || error?.message || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // fluent's message carries the version banner and build config before the actual error
  const last = lines.filter((l) => !/^(ffprobe|ffmpeg) (exited|version)|^built with|^configuration:|^lib\w+\s/.test(l)).pop();
  if (!last) return undefined;
  const reason = last.includes(': ') ? last.slice(last.lastIndexOf(': ') + 2) : last;
  return redactPaths(reason).slice(0, 80);
}

module.exports = { isKnownUnreadable, markUnreadable, isBeingWritten, probeFailureReason };

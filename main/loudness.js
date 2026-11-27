'use strict';
/**
 * Loudness matching on top of the audio analysis (main/audio-analysis.js): the per-clip
 * integrated loudness lands here as a compact index, .clip_metadata/loudness_v1.json, so the
 * library median is one read. Gains are derived at read time from the target, so changing the
 * target or turning the feature off never touches a clip's own files. Clips with a custom
 * .volume keep it; a value of exactly 1 counts as no custom level.
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const { readFileRetry } = require('./read-retry');

const INDEX_FILE = 'loudness_v1.json';
const INDEX_VERSION = 3;
// peak headroom and gain limits; a quiet clip with hot peaks lands under target instead of clipping.
// ebur128 measures the sample peak: true peak costs 4x oversampling (+170 ms per clip, 40% of the
// run) and sat at most 0.6 dB above sample peak across 40 clips, so a 1 dB margin covers it
const HEADROOM_DBTP = -1;
const SAMPLE_PEAK_MARGIN_DB = 1;
const MAX_GAIN_DB = 12;
// boosts stop at 2x, the top of the volume slider and the mixer rows; cuts keep the full 12 dB
const MAX_BOOST_DB = 6;
// a clip this far under the library is quiet on purpose (menu music, a calm moment): it can be
// lowered but never raised
const QUIET_LUFS = -38;
const QUIET_BELOW_MEDIAN_LU = 6;
// envelope rms of the mono downmix reads about 1 dB hot against ebur128 on 40 mix tracks
const ENVELOPE_TO_LUFS_DB = -1;
const ENVELOPE_GATE_DB = -70;
// ebur128 reports -70 for digital silence; at or under this a clip has nothing to match, and
// boosting whatever noise floor it has by the full 12 dB helps nobody
const SILENT_LUFS = -60;
const DEFAULT_TARGET_LUFS = -16;
const SAVE_DEBOUNCE_MS = 1500;
// a library run records a clip every few hundred ms, which would hold the debounce off for the
// whole run; a quit in between (dev restart, crash) then lost every entry since the last quiet gap
const SAVE_MAX_WAIT_MS = 10000;

let getSettings = null;
let analysis = null;
let send = null;
// clipName -> ordinals the mixer never matches: hidden tracks (the Mix) and ones left alone
let getSkippedTracks = null;

// { location, clips: { [name]: { v, av, mtimeMs, size, lufs, peak, mode } } }; av is the analysis
// sidecar version the entry came from
let index = null;
let indexPromise = null;
let saveTimer = null;
let dirtySince = 0;
let medianCache = null;

function init(deps) {
  getSettings = deps.getSettings;
  analysis = deps.analysis;
  send = deps.send;
  getSkippedTracks = deps.getSkippedTracks || null;
}

function isEnabled(settings) {
  return !!(settings && settings.loudness && settings.loudness.enabled);
}

function indexPath(location) {
  return path.join(location, '.clip_metadata', INDEX_FILE);
}

async function loadIndex() {
  const settings = await getSettings();
  const location = settings.clipLocation;
  if (index && index.location === location) return index;
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    let clips = {};
    let raw;
    try {
      raw = await readFileRetry(indexPath(location));
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.clips === 'object') clips = parsed.clips;
    } catch (error) {
      if (error.code !== 'ENOENT' && raw === undefined) {
        // the file is fine, the read wasn't (EMFILE at launch). caching an empty index here got
        // the whole file replaced by the next save, so hand back a throwaway one: saveIndex skips
        // while index is null and the next call reads again
        logger.warn(`[loudness] index read failed, retrying on next use: ${error.message}`);
        telemetry.event('loudness_index_read_failed', {
          kind: telemetry.KIND.DEGRADED,
          severity: telemetry.SEVERITY.WARNING,
          context: { errno: error?.code }
        });
        indexPromise = null;
        return { location, clips: {} };
      }
      if (error.code !== 'ENOENT') {
        logger.warn(`[loudness] index unreadable, starting empty: ${error.message}`);
        telemetry.event('loudness_index_corrupt', {
          kind: telemetry.KIND.DATA_LOSS,
          severity: telemetry.SEVERITY.WARNING,
          context: { errno: error?.code }
        });
      }
    }
    index = { location, clips };
    medianCache = null;
    indexPromise = null;
    return index;
  })();
  return indexPromise;
}

function scheduleSave() {
  medianCache = null;
  const now = Date.now();
  if (!dirtySince) dirtySince = now;
  if (saveTimer) clearTimeout(saveTimer);
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, dirtySince + SAVE_MAX_WAIT_MS - now));
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveIndex();
  }, wait);
}

function serialized() {
  return JSON.stringify({ version: INDEX_VERSION, clips: index.clips });
}

async function saveIndex() {
  if (!index) return;
  dirtySince = 0;
  const file = indexPath(index.location);
  const tmp = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, serialized());
    await fs.rename(tmp, file);
  } catch (error) {
    logger.error(`[loudness] index save failed: ${error.message}`);
  }
}

/** flushes a pending debounced save */
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveIndex();
  }
}

/** before-quit cannot wait on a promise, so the pending save goes out synchronously */
function flushSync() {
  if (!saveTimer || !index) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  dirtySince = 0;
  const file = indexPath(index.location);
  const tmp = `${file}.tmp`;
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(tmp, serialized());
    fsSync.renameSync(tmp, file);
  } catch (error) {
    logger.error(`[loudness] index save at quit failed: ${error.message}`);
  }
}

/** the index knows this clip at this mtime and size, from the current sidecar version; the
 * library scan skips the sidecar read for these */
async function has(clipName, stat, analysisVersion) {
  const idx = await loadIndex();
  const e = idx.clips[clipName];
  return !!e && e.v === INDEX_VERSION && e.av === analysisVersion && e.mtimeMs === stat.mtimeMs && e.size === stat.size;
}

/** an analysis landed (or was found on disk); pushes the matched gain to an open player */
async function record(clipName, entry, fresh) {
  const idx = await loadIndex();
  const prev = idx.clips[clipName];
  const loud = entry.loudness || {};
  if (!prev || prev.mtimeMs !== entry.mtimeMs || prev.size !== entry.size || prev.v !== INDEX_VERSION || prev.av !== entry.v) {
    idx.clips[clipName] = { v: INDEX_VERSION, av: entry.v, mtimeMs: entry.mtimeMs, size: entry.size, lufs: loud.lufs ?? null, peak: loud.peak ?? null, mode: loud.mode || 'none' };
    scheduleSave();
  }
  if (!fresh || !send) return;
  const settings = await getSettings();
  if (!isEnabled(settings)) return;
  const { gain, gainDb, quiet } = gainFromEntry(idx.clips[clipName], targetFor(settings));
  const trackGains = await trackGainsFor(clipName, settings, entry, quiet);
  send('loudness-measured', { clipName, gain, gainDb, lufs: idx.clips[clipName].lufs, trackGains });
}

function targetFor(settings) {
  const raw = settings?.loudness?.targetLufs;
  if (Number.isFinite(raw)) return raw;
  const median = libraryMedian();
  return Number.isFinite(median) ? median : DEFAULT_TARGET_LUFS;
}

function audible(lufs) {
  return Number.isFinite(lufs) && lufs > SILENT_LUFS;
}

function libraryMedian() {
  if (medianCache !== null) return medianCache;
  if (!index) return NaN;
  const values = Object.values(index.clips).map((e) => e.lufs).filter(audible).sort((a, b) => a - b);
  medianCache = values.length ? values[Math.floor(values.length / 2)] : NaN;
  return medianCache;
}

function quietLimit() {
  const median = libraryMedian();
  return Number.isFinite(median) ? Math.min(QUIET_LUFS, median - QUIET_BELOW_MEDIAN_LU) : QUIET_LUFS;
}

/** gain for one measured entry at a target; capped by peak headroom, +MAX_BOOST_DB and -MAX_GAIN_DB.
 * quiet clips are never raised; tracks skip that rule, leaving one alone is the user's call */
function gainFromEntry(entry, targetLufs, isTrack = false) {
  if (!entry || !audible(entry.lufs)) return { gain: 1, gainDb: 0, capped: false, silent: true };
  const wanted = targetLufs - entry.lufs;
  let gainDb = wanted;
  if (Number.isFinite(entry.peak)) gainDb = Math.min(gainDb, HEADROOM_DBTP - SAMPLE_PEAK_MARGIN_DB - entry.peak);
  gainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_BOOST_DB, gainDb));
  const quiet = !isTrack && entry.lufs < quietLimit();
  if (quiet) gainDb = Math.min(gainDb, 0);
  return { gain: Math.pow(10, gainDb / 20), gainDb, capped: !quiet && gainDb < wanted - 0.05, silent: false, quiet };
}

/** loudness of one envelope track, LUFS-ish: mean power of its 100 ms windows, gated like
 * BS.1770 (absolute, then 10 dB under the mean) */
function envelopeLufs(rms) {
  if (!Array.isArray(rms) || rms.length === 0) return NaN;
  let sum = 0;
  let n = 0;
  const powers = [];
  for (const db of rms) {
    if (!(db > ENVELOPE_GATE_DB)) continue;
    const p = Math.pow(10, db / 10);
    powers.push(p);
    sum += p;
    n += 1;
  }
  if (n === 0) return NaN;
  const gate = (sum / n) / 10;
  sum = 0;
  n = 0;
  for (const p of powers) {
    if (p <= gate) continue;
    sum += p;
    n += 1;
  }
  return n ? 10 * Math.log10(sum / n) + ENVELOPE_TO_LUFS_DB : NaN;
}

/** per-track gains from a sidecar, ordinal -> linear gain. every audible track is pulled to the
 * same level, set so their sum lands near the target; silent and skipped tracks are left out.
 * cutOnly is for a clip that is quiet on purpose: its tracks may come down, never up */
function trackGainsFromSidecar(sidecar, targetLufs, skipped, cutOnly) {
  const tracks = Array.isArray(sidecar?.tracks) ? sidecar.tracks : [];
  if (tracks.length < 2) return null;
  const measured = [];
  for (const t of tracks) {
    if (skipped && skipped.has(t.ordinal)) continue;
    const lufs = envelopeLufs(t.rms);
    if (!audible(lufs)) continue;
    let peak = -Infinity;
    for (const db of t.peak || []) if (db > peak) peak = db;
    measured.push({ ordinal: t.ordinal, lufs, peak: Number.isFinite(peak) ? peak : null });
  }
  if (measured.length === 0) return null;
  // uncorrelated tracks add in power, so n tracks at the same level sit 10 log n above one
  const each = targetLufs - 10 * Math.log10(Math.max(1, measured.length));
  const out = {};
  for (const m of measured) {
    const gain = gainFromEntry(m, each, true).gain;
    out[m.ordinal] = cutOnly ? Math.min(1, gain) : gain;
  }
  return out;
}

async function trackGainsFor(clipName, settings, sidecar, cutOnly) {
  if (!settings?.loudness?.perTrack || !analysis) return null;
  const entry = sidecar || await analysis.getEntry(clipName).catch(() => null);
  const skipped = getSkippedTracks ? await getSkippedTracks(clipName).catch(() => null) : null;
  return trackGainsFromSidecar(entry, targetFor(settings), skipped, cutOnly);
}

/**
 * Effective volume for a clip. rawVolume is the .volume file value (1 when absent).
 * trackGains (ordinal -> gain) is set when per-track matching is on.
 * @returns {{volume:number, source:'custom'|'normalized'|'default', gain?:number, gainDb?:number, lufs?:number, capped?:boolean, measured:boolean, trackGains?:Object|null}}
 */
async function resolveVolume(clipName, rawVolume) {
  const raw = Number(rawVolume);
  if (Number.isFinite(raw) && raw !== 1) return { volume: raw, source: 'custom', measured: false };
  const settings = await getSettings();
  if (!isEnabled(settings)) return { volume: 1, source: 'default', measured: false };
  const idx = await loadIndex();
  const entry = idx.clips[clipName];
  if (!entry) {
    // the open-state batch already asks the analysis for this clip; nothing more to queue
    return { volume: 1, source: 'default', measured: false };
  }
  const { gain, gainDb, capped, silent, quiet } = gainFromEntry(entry, targetFor(settings));
  if (silent) return { volume: 1, source: 'default', measured: true };
  const trackGains = await trackGainsFor(clipName, settings, null, quiet);
  return { volume: gain, source: 'normalized', gain, gainDb, lufs: entry.lufs, capped, measured: true, trackGains };
}

async function remove(clipName) {
  const idx = await loadIndex();
  if (idx.clips[clipName]) {
    delete idx.clips[clipName];
    scheduleSave();
  }
}

/** analysis reset: the index goes with the sidecars */
async function resetIndex() {
  const idx = await loadIndex();
  idx.clips = {};
  medianCache = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await saveIndex();
}

/** everything the settings page draws from: entries, median, effective target */
async function getSummary() {
  const settings = await getSettings();
  const idx = await loadIndex();
  const entries = [];
  // silent clips are not matched, so they stay out of the chart and the samples too
  for (const [name, e] of Object.entries(idx.clips)) {
    if (audible(e.lufs)) entries.push({ name, lufs: e.lufs, peak: Number.isFinite(e.peak) ? e.peak : null });
  }
  const median = libraryMedian();
  return {
    enabled: isEnabled(settings),
    targetLufs: Number.isFinite(settings?.loudness?.targetLufs) ? settings.loudness.targetLufs : null,
    effectiveTarget: targetFor(settings),
    median: Number.isFinite(median) ? median : null,
    // what the page mirrors in its gain math: the sample peak cap including the margin
    headroomDbtp: HEADROOM_DBTP - SAMPLE_PEAK_MARGIN_DB,
    maxGainDb: MAX_GAIN_DB,
    maxBoostDb: MAX_BOOST_DB,
    quietLufs: quietLimit(),
    measured: Object.keys(idx.clips).length,
    entries,
    scan: analysis ? analysis.progressPayload() : { running: false, paused: false, pending: 0, total: 0, done: 0, etaSeconds: null }
  };
}

module.exports = { init, isEnabled, has, record, resolveVolume, gainFromEntry, remove, resetIndex, flush, flushSync, getSummary };

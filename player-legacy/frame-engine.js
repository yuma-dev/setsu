'use strict';
// paused frames without waiting on <video> seeks. a <video> seek on our 2 s-gop av1 clips took
// 35 ms a frame forward, 98 ms back and landed 14 of 60 times in a second of dragging; webcodecs
// decodes a whole gop on the gpu in ~100 ms (~1000 fps). so while paused this decodes the clip
// itself (mp4.js), keeps frames around, and paints them on #frame-canvas over the video.
// two sizes, picked by how fast the playhead moves:
// - small (480 px): fast scrubs, and the background fill of the gops around the playhead
// - display size: steps, rests and slow drags, decoded ahead in the direction of travel
// each size has a byte budget; over it, the frames farthest from the playhead go first.
// no gpu decoder for the codec (older cards and av1): software decoding, ~130 fps here. there is
// no slow-machine mode: a mode picked from a measured rate flipped mid-drag (the gpu reads 190-700
// fps while dragging) and froze drags on keyframes for seconds. instead a job for a gop the
// playhead has left is dropped, and every job starts at its keyframe, so a slow decoder shows the
// keyframe at once and as many frames toward the target as it gets to
// the <video> itself is only seeked once things rest (SYNC_IDLE_MS) and right before it plays: a
// seek per display frame kept chromium decoding from keyframes on the same gpu decoder, and a
// recorded drag froze for half a second crossing a gop. meanwhile its currentTime reads the
// engine's time, so the playhead, time display and layers follow without a seek
const mp4 = require('./mp4');
const logger = require('./logger');

const LOW_WIDTH = 480;
// gpu-backed bitmaps; halved below 8 GB of ram. small: ~0.5 MB a frame, ~3 gops of 60 fps.
// display size: 4-8 MB a frame, a few dozen
const MB = 1024 * 1024;
const roomy = !navigator.deviceMemory || navigator.deviceMemory >= 8;
const LOW_BYTES = (roomy ? 192 : 96) * MB;
const FULL_BYTES = (roomy ? 192 : 96) * MB;
// the background fill stays inside this share of the small budget, so it never evicts itself
const WARM_SHARE = 0.8;
// a drag slower than SLOW_ENTER (media seconds per second) is slow enough to look at and gets
// display-size frames until it passes SLOW_EXIT; one threshold flipped sharp/soft 151 times in a
// recorded minute of dragging around it
const SLOW_ENTER = 0.6;
const SLOW_EXIT = 1.0;
// keyframes the background fill gets first around the playhead, each way: a decode each, and a
// coarse frame anywhere near before the whole gops come in
const WARM_KEYS = 10;
// decode failures on one clip before the engine steps aside for plain <video> seeks
const MAX_FAILS = 3;
// display-size frames decoded ahead in the direction of travel, refilled when this close to the end
const AHEAD = 18;
const REFILL_AT = 6;
// a scrub that rests this long gets its display-size frame
const SETTLE_MS = 90;
// a fast scrub's job decodes this far past its target, not the whole gop: the drag is in the
// next gop long before a whole one is done
const SCRUB_AHEAD = 30;
// going back across a gop start the first frame wanted is the previous gop's last, which needs
// all of that gop decoded: 270 ms frozen in a recorded slow drag. this close (media seconds) to the
// start while moving back, the previous gop gets decoded ahead. forward crossings start on the
// keyframe and need nothing
const BACK_AHEAD_S = 1;
const SYNC_IDLE_MS = 150;
// after a pause, before filling the gops around the playhead
const WARM_AFTER_PAUSE_MS = 250;
const nativeTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');

let video = null;
let canvas = null;
let ctx = null;
// the open clip: file handle, video track, decoder config, its decoder
let clip = null;
let opening = null;
// presentation index -> { bmp, bytes }
const low = new Map();
const full = new Map();
const used = { low: 0, full: 0 };
let fullKey = '';
// what should be on the canvas, and what is
let want = null;
let shownP = -1;
let shownFull = false;
// the time the engine shows and the <video> doesn't yet; null when the <video> is the truth
let engineTime = null;
let syncTimer = 0;
let syncing = false;
// the frame the <video> was last seeked to by us, so play() and rests don't seek it again
let nativeP = -1;
let detail = false;
let settleTimer = 0;
let warmTimer = 0;
// one job decodes at a time: the waiting display job, then the waiting ahead/preview job, then
// the background fill. latest wins in each slot
let running = null;
let nextShow = null;
let nextAhead = null;
let preview = null;

// devtools tuning trace, see video-player.js
function trace(...entry) {
  const t = window.__scrubTrace;
  if (t && t.length < 500000) t.push([performance.now(), ...entry]);
}

function attach(videoEl, canvasEl) {
  video = videoEl;
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  video.addEventListener('emptied', () => {
    nativeP = -1;
    hide('emptied');
  });
  // in case something holds the prototype's play: a late seek beats playing from the old spot
  video.addEventListener('play', () => {
    flushSync();
    hide('play');
    nativeP = -1;
  });
  video.addEventListener('pause', () => {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(schedule, WARM_AFTER_PAUSE_MS);
  });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get() {
      return engineTime ?? nativeTime.get.call(this);
    },
    set(t) {
      // a seek somebody else made (skip keys, a click while playing): our frame is stale
      if (!syncing) {
        hide('seek');
        nativeP = -1;
      }
      nativeTime.set.call(this, t);
    },
  });
  // every way of starting playback goes through play(); the <video> has to be where we are first
  video.play = function play() {
    flushSync();
    hide('play');
    return HTMLMediaElement.prototype.play.call(this);
  };
}

function seekNative(p) {
  if (p === nativeP) return;
  nativeP = p;
  syncing = true;
  try {
    nativeTime.set.call(video, timeOf(p));
  } finally {
    syncing = false;
  }
}

function flushSync() {
  clearTimeout(syncTimer);
  syncTimer = 0;
  if (engineTime === null || !video || !clip) return;
  // onto the frame we show; the time we report stays the one asked for
  seekNative(index(engineTime));
}

/** a drag let go of mid-glide that will play when it lands: the <video> can seek there already */
function preseek(t) {
  if (clip && video) seekNative(index(Math.max(0, Math.min(t, video.duration || t))));
}

// timeupdate is what the time display and layer ui listen for; no seek, no event, so send one
let tickRaf = 0;
function tick() {
  if (tickRaf) return;
  tickRaf = requestAnimationFrame(() => {
    tickRaf = 0;
    if (video) video.dispatchEvent(new Event('timeupdate'));
  });
}

function hide(why) {
  if (!canvas) return;
  if (shownP >= 0 || engineTime !== null) trace('hide', why);
  if (paintRaf) cancelAnimationFrame(paintRaf);
  paintRaf = 0;
  canvas.style.visibility = 'hidden';
  shownP = -1;
  want = null;
  detail = false;
  engineTime = null;
  clearTimeout(syncTimer);
  clearTimeout(settleTimer);
}

/** where the user is: what is wanted, else shown, else the <video>'s time */
function focus() {
  if (want) return want.p;
  if (shownP >= 0) return shownP;
  return clip ? index(video.currentTime) : 0;
}

function put(kind, p, bmp) {
  const map = kind === 'low' ? low : full;
  const budget = kind === 'low' ? LOW_BYTES : FULL_BYTES;
  const old = map.get(p);
  if (old) {
    old.bmp.close();
    used[kind] -= old.bytes;
  }
  const bytes = bmp.width * bmp.height * 4;
  map.set(p, { bmp, bytes });
  used[kind] += bytes;
  if (used[kind] <= budget) return;
  const at = focus();
  while (used[kind] > budget && map.size > 1) {
    let far = -1;
    let dist = -1;
    for (const k of map.keys()) {
      const d = Math.abs(k - at);
      if (d > dist) {
        dist = d;
        far = k;
      }
    }
    const v = map.get(far);
    map.delete(far);
    used[kind] -= v.bytes;
    v.bmp.close();
  }
}

function clearFull() {
  for (const v of full.values()) v.bmp.close();
  full.clear();
  used.full = 0;
}

function clearCaches() {
  clearFull();
  for (const v of low.values()) v.bmp.close();
  low.clear();
  used.low = 0;
}

/** opens the clip for paused frames; resolves false when it can't be decoded this way */
function openClip(file) {
  closeClip();
  const my = (opening = (async () => {
    if (typeof VideoDecoder === 'undefined' || !video) return false;
    let fh = null;
    try {
      fh = await mp4.open(file);
      const track = (await mp4.readTracks(fh)).find((t) => t && t.kind === 'video');
      if (!track || track.count < 2) throw new Error('no video track we can read');
      let config = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
      const supported = async (cfg) => (await VideoDecoder.isConfigSupported(cfg)).supported;
      let ok = await supported(config);
      if (!ok && track.codec.startsWith('av01.')) {
        // the av1C level can be one chromium won't name; the plain main profile string decodes them
        config = { ...config, codec: 'av01.0.08M.08' };
        ok = await supported(config);
      }
      const hw = ok;
      if (!ok) {
        config = { ...config, hardwareAcceleration: 'no-preference' };
        ok = await supported(config);
      }
      if (!ok) throw new Error(`no decoder for ${track.codec}`);
      if (opening !== my) {
        await fh.close();
        return false;
      }
      // a first guess at the decode rate until a job measures it
      const c = { file, fh, track, config, decoder: null, onFrame: null, failed: null, fails: 0 };
      if (!hw) logger.info(`[frame-engine] no gpu decoder for ${track.codec}, decoding in software`);
      // the priming frames can sit before 0; webcodecs gets times from 0 up
      c.shift = Math.max(0, -track.presTimes[0]);
      c.step = (track.presTimes[track.count - 1] - track.presTimes[0]) / (track.count - 1);
      // decode index -> presentation index
      c.presOf = new Uint32Array(track.count);
      track.order.forEach((d, p) => { c.presOf[d] = p; });
      clip = c;
      return true;
    } catch (error) {
      if (fh) fh.close().catch(() => {});
      logger.info(`[frame-engine] off for this clip: ${error && error.message}`);
      return false;
    }
  })());
  return my;
}

// a decoder that hit an error is closed for good, the next job gets a new one
function decoderFor(c) {
  if (!c.decoder || c.decoder.state === 'closed') {
    c.decoder = new VideoDecoder({
      output: (frame) => (c.onFrame ? c.onFrame(frame) : frame.close()),
      error: (e) => { c.failed = e; },
    });
  }
  return c.decoder;
}

function closeClip() {
  opening = null;
  hide('close');
  clearTimeout(warmTimer);
  const c = clip;
  clip = null;
  nextShow = null;
  nextAhead = null;
  preview = null;
  clearCaches();
  if (c) {
    try { if (c.decoder) c.decoder.close(); } catch (_) { /* already closed */ }
    c.fh.close().catch(() => {});
  }
}

const ready = () => !!clip;

/** presentation index of the frame a paused <video> shows at t */
function index(t) {
  const times = clip.track.presTimes;
  let lo = 0;
  let hi = times.length - 1;
  // a hair of slack: currentTime set to a frame's exact time can read back a float below it
  const at = t + 1e-4;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** a time safely inside frame p, for the <video>'s own seek */
const timeOf = (p) => clip.track.presTimes[p] + Math.min(0.002, clip.step / 4);

function canvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // the video's object-fit: contain box inside it
  const vw = clip.track.width;
  const vh = clip.track.height;
  const s = Math.min(w / vw, h / vh);
  const dw = Math.max(1, Math.round(vw * s));
  const dh = Math.max(1, Math.round(vh * s));
  return { w, h, dw, dh, x: Math.round((w - dw) / 2), y: Math.round((h - dh) / 2) };
}

function paint(p) {
  const f = full.get(p);
  const entry = f || low.get(p);
  if (!entry || !video.paused) return false;
  const box = canvasSize();
  ctx.imageSmoothingQuality = f ? 'low' : 'high';
  ctx.clearRect(0, 0, box.w, box.h);
  ctx.drawImage(entry.bmp, box.x, box.y, box.dw, box.dh);
  canvas.style.visibility = 'visible';
  shownP = p;
  shownFull = !!f;
  trace('paint', p, shownFull, want ? want.p : -1);
  return true;
}

// frames arrive at decode speed (hundreds a second); the canvas only needs one per display frame
let paintRaf = 0;
let paintP = -1;
function requestPaint(p) {
  paintP = p;
  if (!paintRaf) {
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0;
      if (clip) paint(paintP);
    });
  }
}

const decodeIndex = (p) => clip.track.order[p];

/** the cached frame nearest p within a gop and a half either way, or -1 */
function nearestCached(p) {
  const n = clip.track.count;
  for (let r = 1; r <= 180; r++) {
    if (p - r >= 0 && (low.has(p - r) || full.has(p - r))) return p - r;
    if (p + r < n && (low.has(p + r) || full.has(p + r))) return p + r;
  }
  return -1;
}

function keyBefore(d) {
  const keys = clip.track.keys;
  while (d > 0 && !keys[d]) d--;
  return d;
}

function keyAfter(d) {
  const { keys, count } = clip.track;
  d++;
  while (d < count && !keys[d]) d++;
  return d;
}

const lowFrameBytes = (track) => LOW_WIDTH * Math.round((LOW_WIDTH * track.height) / track.width) * 4;

/** keyframe up to a little past presentation frame p, every frame kept small, for a fast scrub */
function scrubJob(p) {
  const d = decodeIndex(p);
  return { from: keyBefore(d), to: Math.min(keyAfter(d), d + 1 + SCRUB_AHEAD), full: null, low: true };
}

/** display-size frames [a, b] (presentation), decoded from the keyframe before the earliest */
function fullJob(a, b) {
  const n = clip.track.count;
  a = Math.max(0, a);
  b = Math.min(n - 1, b);
  let lo = Infinity;
  let hi = -1;
  for (let p = a; p <= b; p++) {
    const d = decodeIndex(p);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { from: keyBefore(lo), to: hi + 1, full: [a, b], low: true };
}

/** display-size frames from p onward in the direction of travel */
const aheadJob = (p, dir) => (dir < 0 ? fullJob(p - AHEAD, p) : fullJob(p, p + AHEAD));

function covers(job, p, needFull) {
  if (!job || job.from > decodeIndex(p) || job.to <= decodeIndex(p)) return false;
  return !needFull || (job.full && p >= job.full[0] && p <= job.full[1]);
}

/**
 * background fill while paused: the nearest gop around the playhead with small frames missing,
 * inside the share of the budget the fill may use. null when the neighbourhood is done
 */
function warmJob() {
  if (!clip || !video.paused) return null;
  const { track } = clip;
  const at = focus();
  // keyframes first, nearest first
  let next = keyBefore(decodeIndex(at));
  let prev = next;
  const keys = [next];
  for (let i = 0; i < WARM_KEYS; i++) {
    next = keyAfter(next);
    if (next < track.count) keys.push(next);
    if (prev > 0) {
      prev = keyBefore(prev - 1);
      keys.push(prev);
    }
  }
  // past the fill's share, a key no nearer than the farthest small frame held is evicted by its
  // own put and picked again: one keyframe went 441 times in a drag, a decode every 27 ms
  let reach = Infinity;
  if (used.low + lowFrameBytes(track) > LOW_BYTES * WARM_SHARE) {
    reach = 0;
    for (const p of low.keys()) reach = Math.max(reach, Math.abs(p - at));
  }
  const k = keys.find((x) => {
    const p = clip.presOf[x];
    return Math.abs(p - at) < reach && !low.has(p) && !full.has(p);
  });
  if (k !== undefined) return { from: k, to: k + 1, full: null, low: true, warm: true };
  const radius = Math.floor((LOW_BYTES * WARM_SHARE) / lowFrameBytes(track) / 2);
  const here = keyBefore(decodeIndex(at));
  // gops by distance: this one, next, previous, the one after next...
  const gops = [here];
  let fwd = here;
  let back = here;
  for (let i = 0; i < 16; i++) {
    if (fwd < track.count) {
      fwd = keyAfter(fwd);
      if (fwd < track.count) gops.push(fwd);
    }
    if (back > 0) {
      back = keyBefore(back - 1);
      gops.push(back);
    }
  }
  for (const k of gops) {
    const end = keyAfter(k);
    // whole gops only: one hanging past the radius would get its far end evicted by its own fill
    // and be picked again, forever
    if (Math.abs(clip.presOf[k] - at) > radius || Math.abs(clip.presOf[end - 1] - at) > radius) continue;
    for (let d = k; d < end; d++) {
      const p = clip.presOf[d];
      if (!low.has(p) && !full.has(p)) return { from: k, to: end, full: null, low: true, warm: true };
    }
  }
  return null;
}

function schedule() {
  if (running || !clip) return;
  let job;
  if (nextShow) {
    job = nextShow;
    nextShow = null;
  } else if (nextAhead) {
    job = nextAhead;
    nextAhead = null;
  } else {
    job = warmJob();
  }
  if (!job) return;
  running = job;
  trace('job', job.warm ? 'warm' : job.full ? 'full' : 'scrub', job.from, job.to);
  const c = clip;
  run(job).catch((error) => {
    if (error && error.name === 'AbortError') return;
    logger.warn('[frame-engine] decode failed:', error && error.message);
    c.fails += 1;
    if (c.fails >= MAX_FAILS && clip === c) {
      logger.warn('[frame-engine] off for this clip after repeated decode failures');
      closeClip();
    }
  }).finally(() => {
    running = null;
    schedule();
  });
}

/**
 * called when frame p is wanted and the running job doesn't decode it. the background fill yields
 * at once, and so does a job for another gop: the playhead left it, and finishing it only delays
 * the frame that is wanted now. a job in p's own gop runs on, its frames are on the way there
 */
function preempt(p) {
  if (!running || !clip) return;
  if (!running.warm && (p === undefined || running.from === keyBefore(decodeIndex(p)))) return;
  trace('preempt', running.warm ? 'warm' : 'stale', running.from);
  running.aborted = true;
  if (clip.decoder && clip.decoder.state === 'configured') clip.decoder.reset();
}

async function run(job) {
  const c = clip;
  const { track } = c;
  const [frames] = await mp4.readFrames(c.fh, [{ track, from: job.from, to: job.to }]);
  if (clip !== c || job.aborted) return;
  const box = canvasSize();
  const key = `${box.dw}x${box.dh}`;
  if (key !== fullKey) {
    clearFull();
    fullKey = key;
  }
  const lowSize = { resizeWidth: LOW_WIDTH, resizeHeight: Math.max(1, Math.round((LOW_WIDTH * track.height) / track.width)), resizeQuality: 'low' };
  const fullSize = { resizeWidth: box.dw, resizeHeight: box.dh, resizeQuality: 'high' };
  const stores = [];
  c.onFrame = (frame) => {
    const p = index(frame.timestamp / 1e6 - c.shift);
    const wantFull = (job.full && p >= job.full[0] && p <= job.full[1]) || (want && want.p === p && want.full);
    const jobs = [];
    // every job keeps its frames small too, display-size jobs included: on a slow decoder the
    // run-up from the keyframe is what's on screen until the display frame lands
    if (job.low && !wantFull && !low.has(p) && !full.has(p)) jobs.push(createImageBitmap(frame, lowSize).then((b) => put('low', p, b)));
    if (wantFull && !full.has(p)) jobs.push(createImageBitmap(frame, fullSize).then((b) => put('full', p, b)));
    if (jobs.length === 0) {
      frame.close();
      return;
    }
    stores.push(Promise.all(jobs).finally(() => {
      frame.close();
      if (clip !== c || !want) {
        if (clip === c && preview && preview.p === p) showPreview();
        return;
      }
      const best = paintRaf ? paintP : shownP;
      if (want.p === p) {
        if (shownP !== p || (!shownFull && full.has(p))) requestPaint(p);
      } else if ((!want.full || !full.has(want.p)) && (best < 0 || Math.abs(p - want.p) < Math.abs(best - want.p))) {
        // anything nearer the target than what's up beats waiting for the exact frame
        requestPaint(p);
      }
      if (preview && preview.p === p) showPreview();
    }));
  };
  c.failed = null;
  const decoder = decoderFor(c);
  decoder.reset();
  decoder.configure(c.config);
  for (let d = job.from; d < job.to && !c.failed; d++) {
    const at = frames.at[d - job.from];
    decoder.decode(new EncodedVideoChunk({
      type: track.keys[d] ? 'key' : 'delta',
      timestamp: Math.round((track.times[d] + c.shift) * 1e6),
      data: frames.data.subarray(at, at + track.sizes[d]),
    }));
  }
  try {
    await decoder.flush();
  } finally {
    await Promise.all(stores);
    c.onFrame = null;
  }
  if (c.failed) throw c.failed;
}

function syncVideo(t) {
  engineTime = t;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushSync, SYNC_IDLE_MS);
  tick();
}

/**
 * paints the frame at t while paused; the <video> follows once things rest. exact (steps,
 * clicks, rests) wants the display-size frame now. a drag passes its speed in media seconds per
 * second: slow drags get display-size frames decoded ahead, fast ones the small ones
 * @returns {boolean} false when the engine is off for this clip
 */
function show(t, { exact = false, dir = 0, speed = Infinity } = {}) {
  if (!clip || !video || !video.paused) return false;
  t = Math.max(0, Math.min(t, video.duration || t));
  const p = index(t);
  if (!exact) detail = detail ? Math.abs(speed) < SLOW_EXIT : Math.abs(speed) < SLOW_ENTER;
  const slow = !exact && detail;
  const travel = dir || (Number.isFinite(speed) && speed !== 0 ? Math.sign(speed) : 0);
  want = { p, exact, full: exact || slow };
  syncVideo(t);
  const painted = paint(p);
  // not decoded yet: the nearest frame we have beats the last one painted, which may be far off
  if (!painted) {
    const q = nearestCached(p);
    if (q >= 0 && (shownP < 0 || Math.abs(q - p) < Math.abs(shownP - p))) paint(q);
  }
  if (want.full && !full.has(p)) {
    if (!covers(running, p, true)) {
      nextShow = exact && !travel ? fullJob(p - 4, p + 8) : aheadJob(p, travel);
      preempt(p);
    }
  } else if (!painted && !low.has(p) && !covers(running, p, false)) {
    nextShow = scrubJob(p);
    preempt(p);
  }
  if (want.full && travel) {
    // keep a run of display-size frames ahead of a held step key or a slow drag
    const edge = p + travel * REFILL_AT;
    const n = clip.track.count;
    if (edge >= 0 && edge < n && !full.has(edge) && !covers(running, edge, true) && !covers(nextShow, edge, true)) {
      nextAhead = travel > 0 ? fullJob(p + 1, p + AHEAD) : fullJob(p - AHEAD, p - 1);
    }
  }
  if (travel < 0 && !nextAhead) {
    const k = keyBefore(decodeIndex(p));
    const start = clip.presOf[k];
    const q = start - 1;
    if (k > 0 && q >= 0 && (p - start) * clip.step < BACK_AHEAD_S && !low.has(q) && !full.has(q)
      && !covers(running, q, false) && !covers(nextShow, q, false)) {
      nextAhead = { from: keyBefore(k - 1), to: k, full: null, low: true };
    }
  }
  clearTimeout(settleTimer);
  if (!exact) settleTimer = setTimeout(() => { if (want && want.p === p) show(t, { exact: true }); }, SETTLE_MS);
  schedule();
  return true;
}

/** one frame forward or back from where we are; the time it moved to, or null when off */
function step(dir) {
  if (!clip || !video || !video.paused) return null;
  // currentTime reads the engine's time while it leads
  const p = Math.max(0, Math.min(clip.track.count - 1, index(video.currentTime) + dir));
  show(timeOf(p), { exact: true, dir });
  return timeOf(p);
}

function showPreview() {
  const entry = low.get(preview.p) || full.get(preview.p);
  if (entry) preview.draw(entry.bmp);
}

/**
 * the hover preview's frame at t, handed to draw(bitmap) now or once decoded. works while playing
 * too; it only ever waits behind a display job
 * @returns {boolean} false when the engine is off for this clip
 */
function previewAt(t, draw) {
  if (!clip) return false;
  const p = index(t);
  preview = { p, draw };
  if (low.has(p) || full.has(p)) {
    showPreview();
  } else if (!covers(running, p, false) && !covers(nextShow, p, false)) {
    nextAhead = scrubJob(p);
    preempt(p);
    schedule();
  }
  return true;
}

module.exports = { attach, openClip, closeClip, ready, show, step, previewAt, hide, flushSync, preseek };

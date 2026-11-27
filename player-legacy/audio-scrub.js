'use strict';
// paused trim drags play the audio under the handle, like moving a record by hand: drag speed is
// playback speed so the pitch follows, dragging back plays it reversed, holding still goes quiet.
// mp4-audio.js decodes the audible mix to mono s16 (~2.9 MB a minute), the 2 s under the handle
// first, and a worklet chases the handle through it. ffmpeg in main only for what that can't read
const { ipcRenderer } = require('electron');
const path = require('path');
const logger = require('./logger');
const state = require('./state');
const { streamMix } = require('./mp4-audio');

// runs on the audio thread. the handle it follows is already sprung (video-player.js); pos chases
// it with a 60 ms lag and speed eases over 15 ms, which is critically damped: any slower speed ease
// overshoots when the hand stops and plays a blip backwards
const WORKLET = `
const LAG_S = 0.06;
const MAX_SPEED = 4;
// past this the chase would play seconds of fast-forward, jump instead
const JUMP_S = 1.5;
const velEase = 1 - Math.exp(-1 / (sampleRate * 0.015));
const gainEase = 1 - Math.exp(-1 / (sampleRate * 0.012));
class ClipScrub extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = null;
    this.rate = 24000;
    this.pos = 0;
    this.target = 0;
    this.vel = 0;
    this.gain = 0;
    this.active = false;
    this.port.onmessage = ({ data }) => {
      if (data.alloc) { this.pcm = new Int16Array(data.alloc); this.rate = data.rate; }
      if (data.fill !== undefined && this.pcm) this.pcm.set(data.pcm, data.fill);
      if (data.drop) this.pcm = null;
      if (typeof data.at === 'number') {
        if (!this.active || Math.abs(data.at - this.pos) > JUMP_S) { this.pos = data.at; this.vel = 0; }
        this.target = data.at;
        this.active = true;
      }
      if (data.stop) this.active = false;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.pcm || (!this.active && this.gain < 1e-4)) { this.gain = 0; return true; }
    const pcm = this.pcm;
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      const want = this.active ? Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (this.target - this.pos) / LAG_S)) : 0;
      this.vel += (want - this.vel) * velEase;
      this.pos += this.vel / sampleRate;
      // full level from 0.15x up: slow drags were dipping in volume on every hesitation
      this.gain += (Math.min(1, Math.abs(this.vel) * 7) - this.gain) * gainEase;
      const x = this.pos * this.rate;
      const k = Math.floor(x);
      let s = 0;
      if (k >= 0 && k + 1 < pcm.length) {
        const f = x - k;
        s = ((pcm[k] * (1 - f) + pcm[k + 1] * f) / 32768) * this.gain;
      }
      for (let c = 0; c < out.length; c++) out[c][i] = s;
    }
    return true;
  }
}
registerProcessor('clip-scrub', ClipScrub);
`;

let node = null;
let nodeCtx = null;
let nodeLoading = null;
// the clip + mix being decoded or decoded: blocks wait in `fills` until the worklet exists
let current = null;
// bumped to call off a decode that is no longer wanted
let gen = 0;
let dragging = false;
let lastTime = null;

function audibleMix(manager) {
  if (!manager || typeof manager.getExportMix !== 'function') return null;
  try {
    return manager.getExportMix().map((t) => ({ streamIndex: t.streamIndex, volume: t.volume }));
  } catch (_) {
    return null;
  }
}

async function ensureNode(ctx, dest) {
  if (node && nodeCtx === ctx) return node;
  if (nodeLoading && nodeCtx === ctx) return nodeLoading;
  nodeCtx = ctx;
  node = null;
  // a new worklet starts empty, what went to the old one has to be decoded again
  if (current && current.attached) {
    current = null;
    gen++;
  }
  nodeLoading = (async () => {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const n = new AudioWorkletNode(ctx, 'clip-scrub', { numberOfInputs: 0, outputChannelCount: [2] });
    // into the master gain, so the player's volume and mute apply
    n.connect(dest);
    node = n;
    return n;
  })();
  try {
    return await nodeLoading;
  } finally {
    nodeLoading = null;
  }
}

function attach() {
  if (!node || !current || current.attached || !current.length) return;
  node.port.postMessage({ alloc: current.length, rate: current.rate });
  for (const f of current.fills) node.port.postMessage({ fill: f.offset, pcm: f.pcm }, [f.pcm.buffer]);
  current.fills = [];
  current.attached = true;
  if (dragging && lastTime != null) node.port.postMessage({ at: lastTime });
}

function onStart(entry, { rate, length }) {
  entry.rate = rate;
  entry.length = length;
  attach();
}

function onFill(entry, offset, pcm) {
  if (current !== entry) return;
  if (entry.attached) node.port.postMessage({ fill: offset, pcm }, [pcm.buffer]);
  else entry.fills.push({ offset, pcm });
}

/** what main's ffmpeg gives, for files mp4-audio can't read: one block, all at once */
async function loadWithFfmpeg(entry, clip, mix, my) {
  const res = await ipcRenderer.invoke('get-scrub-audio', clip.originalName, mix);
  if (my !== gen || !res || !res.pcm) return;
  const bytes = res.pcm;
  // the ipc buffer can sit at an odd offset, Int16Array needs an aligned copy
  const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
  onStart(entry, { rate: res.rate, length: pcm.length });
  onFill(entry, 0, pcm);
}

/**
 * starts decoding the clip's audio unless it is under way already, nearest `around` (seconds)
 * first. hovering near a trim handle while paused calls this ahead of the press
 * @param {{ manager: any, around: number }} deps
 */
async function load({ manager, around }) {
  const clip = state.currentClip;
  if (!clip || !state.clipLocation) return;
  // the worklet needs no gesture, only a context; one the player already made saves the press ~10 ms
  const ctx = state.audioContext;
  if (ctx && state.gainNode && ctx.audioWorklet) {
    ensureNode(ctx, state.gainNode).then(attach, (error) => logger.warn('[audio-scrub] worklet failed:', error && error.message));
  }
  const mix = audibleMix(manager);
  const key = `${clip.originalName}|${JSON.stringify(mix)}`;
  if (current && current.key === key) return;
  const my = ++gen;
  const entry = { key, clip: clip.originalName, rate: 0, length: 0, fills: [], attached: false };
  current = entry;
  if (node) node.port.postMessage({ drop: true });
  const file = path.join(state.clipLocation, clip.originalName);
  try {
    const audible = await streamMix(file, mix, {
      around,
      onStart: (info) => onStart(entry, info),
      onFill: (offset, pcm) => onFill(entry, offset, pcm),
      cancelled: () => my !== gen,
    });
    if (!audible && current === entry) current.length = 0;
  } catch (error) {
    if (my !== gen) return;
    // nothing decoded yet: not an mp4 or a codec webcodecs lacks, main's ffmpeg reads anything
    if (!entry.length) {
      logger.info(`[audio-scrub] ${error && error.message}, using ffmpeg`);
      await loadWithFfmpeg(entry, clip, mix, my).catch((e) => logger.warn('[audio-scrub] ffmpeg failed:', e && e.message));
    } else {
      logger.warn('[audio-scrub] decode stopped:', error && error.message);
    }
  }
}

/**
 * mousedown on a trim handle while paused. builds the audio graph only here, a user gesture: an
 * AudioContext made on hover would start suspended and take the video's sound with it
 * @param {{ setupAudioContext: () => void, manager: any, around: number }} deps
 */
function start(deps) {
  dragging = true;
  lastTime = null;
  try {
    if (!state.audioContext) deps.setupAudioContext();
    const ctx = state.audioContext;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (ctx && state.gainNode && ctx.audioWorklet) {
      ensureNode(ctx, state.gainNode).then(attach, (error) => logger.warn('[audio-scrub] worklet failed:', error && error.message));
    }
  } catch (error) {
    logger.warn('[audio-scrub] no audio graph:', error && error.message);
  }
  return load(deps);
}

/** the handle's media time, every drag step */
function move(time) {
  if (!dragging || !Number.isFinite(time)) return;
  lastTime = time;
  // arrow keys switch clips without a close, the worklet may still hold the last one
  if (node && current && current.attached && state.currentClip && current.clip === state.currentClip.originalName) {
    node.port.postMessage({ at: time });
  }
}

function stop() {
  if (!dragging) return;
  dragging = false;
  lastTime = null;
  if (node) node.port.postMessage({ stop: true });
}

/** player closed: let go of the clip's audio */
function release() {
  stop();
  current = null;
  gen++;
  if (node) node.port.postMessage({ drop: true });
}

module.exports = { load, start, move, stop, release };

// the recap's sound: one context, music + sfx + ui buses into a room and a limiter.
// the cues come from the pack opening study (rights cleared by the owner), built by
// agents/recap-sfx/build.py: rings notched, harsh tops shelved, every file levelled to a loudness
// for its role. bus and cue levels below were tuned by ear in the dev mixer and written in here.
// mix rules taken from the study: duck fast, recover slow; jingles take the music down to nothing
// until they ring out; ui only dips it to 0.8; nothing is pitched by pointer speed
const files = import.meta.glob("../assets/sfx/recap/*.ogg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const URLS: Record<string, string> = {};
for (const [p, u] of Object.entries(files)) URLS[p.slice(p.lastIndexOf("/") + 1, -4)] = u;

export type Cue =
  | "jingle-rare-a"
  | "jingle-rare-c"
  | "jingle-rare-e"
  | "cut-1"
  | "cut-2"
  | "cut-3"
  | "cut-snap"
  | "open-heavy"
  | "open-medium"
  | "open-rare"
  | "tap-1"
  | "tap-2"
  | "pack-in"
  | "pack-select"
  | "card-slide"
  | "card-slide-rare"
  | "card-open"
  | "card-open-rare"
  | "card-flick"
  | "card-shine"
  | "next"
  | "tick"
  | "riser-1"
  | "riser-10"
  | "list-ef"
  | "guide"
  | "stinger-rhombus"
  | "stinger-star"
  | "stinger-crown"
  | "whiteout"
  | "push-start"
  | "push-end"
  | "rotate"
  | "rotate-small"
  | "fadeout"
  | "immersive-start"
  | "immersive-end"
  | "toast"
  | "nope";

export type Track = "menu";
// intro plays once, then [a, b) loops. found by agents/recap-sfx/loops.py, the file carries no
// loop points of its own
const LOOPS: Record<Track, { a: number; b: number }> = {
  menu: { a: 2.731, b: 37.429 },
};

/** every cue, grouped by where it plays, for the mixer */
export const CUES: Array<[string, Array<[Cue, string]>]> = [
  ["Intro", [
    ["list-ef", "warp in; stack column moving"],
    ["riser-1", "builds to the year landing; clock colour wave"],
    ["rotate-small", "each year digit; planets; later card flips; replay"],
    ["stinger-star", "year landing; big numbers; peak hour; star chart; card reveal"],
    ["card-flick", "shooting stars; going back"],
    ["pack-select", "Open your year"],
    ["immersive-start", "entering; zoom to space; clip starts"],
    ["fadeout", "closing; start over"],
  ]],
  ["Ui", [
    ["tick", "hovers, drags, clock hours"],
    ["next", "next chapter; colour by game"],
    ["push-end", "locking in an answer"],
    ["toast", "saved, copied"],
    ["nope", "wrong answer; failed export"],
  ]],
  ["Answers", [
    ["jingle-rare-a", "right or close answer, one of two"],
    ["jingle-rare-c", "right or close answer, one of two"],
    ["stinger-rhombus", "close answers; not far; card reveal"],
    ["stinger-crown", "spot on; past the atmosphere; top friend"],
  ]],
  ["Chapters", [
    ["riser-10", "stack zoom out"],
    ["card-slide", "column extends; card rising"],
    ["rotate", "clock sweep; card reveal"],
    ["card-open", "picking a friend"],
    ["card-shine", "cut bars; star chart done; sweeping over the card"],
    ["push-start", "clip intro; holding a finished cut"],
    ["immersive-end", "clip ends"],
      ]],
  ["Pack", [
    ["pack-in", "pack flies in"],
    ["guide", "first hint along the line"],
    ["tap-1", "pressing the pack"],
    ["tap-2", "pressing the pack, second take"],
    ["cut-1", "tear, soft start"],
    ["cut-2", "tear, long"],
    ["cut-3", "tear, dense; locking the cut"],
    ["cut-snap", "rip snap; locking the cut"],
    ["open-heavy", "rip"],
    ["open-rare", "rip sparkle"],
    ["whiteout", "rip swell"],
    ["card-slide-rare", "card rising out"],
  ]],
  ["Reveal", [
    ["card-open-rare", "first look at the front"],
    ["jingle-rare-e", "the reveal"],
  ]],
];

type Bus = "sfx" | "ui";
export interface PlayOpts {
  gain?: number;
  /** playback rate, only for ui ticks; foley and stingers always play at 1 */
  rate?: number;
  /** seconds from now */
  at?: number;
  /** -1..1 */
  pan?: number;
  bus?: Bus;
  /** reverb send, 0..1 */
  room?: number;
  /** jingle: music down to nothing until it ends; ui: a short dip to 0.8 */
  duck?: "jingle" | "ui";
  /** cancel(group) drops whatever of it hasn't started and fades what has */
  group?: string;
}

interface Live {
  src: AudioBufferSourceNode;
  g: GainNode;
  at: number;
  jingle: boolean;
}
const groups = new Map<string, Set<Live>>();

const MUTE_KEY = "clip-library:recap-muted";

// bus levels before the mixer's multipliers. the room is off: by ear everything sat better dry
const BASE = { master: 0.8, music: 0.09, sfx: 0.32, ui: 1.6, room: 0 };
type BusName = keyof typeof BASE;
// per cue, on top of the file's own levelling
const LEVEL: Partial<Record<Cue, { gain?: number; room?: number }>> = {
  "cut-1": { gain: 0.39, room: 0 },
  "cut-2": { gain: 0.39 },
  "cut-3": { gain: 0.48 },
  "cut-snap": { gain: 0.51 },
  "open-heavy": { gain: 0.69, room: 0 },
};

// the dev mixer (__recapMix(), MixPanel.tsx): multipliers on top of the levels in this file, kept
// in localStorage and in userData/recap-mix.json so they can be read back and written in here
export interface Mix {
  bus: Record<BusName, number>;
  cue: Partial<Record<Cue, { gain?: number; room?: number }>>;
}
const MIX_KEY = "clip-library:recap-mix";
// mixes saved before their values moved into BASE and LEVEL would count twice
const MIX_V = 2;
const flat = (): Mix => ({ bus: { master: 1, music: 1, sfx: 1, ui: 1, room: 1 }, cue: {} });
let mix: Mix = flat();
const mixSubs = new Set<() => void>();
let savedTo = "";
let saveT = 0;
const useMix = (m: unknown): boolean => {
  const x = m as (Partial<Mix> & { v?: number }) | null;
  if (!x || typeof x !== "object" || !x.bus || x.v !== MIX_V) return false;
  mix = { bus: { ...flat().bus, ...x.bus }, cue: { ...(x.cue || {}) } };
  return true;
};
try {
  if (!useMix(JSON.parse(localStorage.getItem(MIX_KEY) || "null"))) {
    void window.clips
      ?.loadRecapMix?.()
      .then((m) => {
        if (useMix(m)) {
          applyBuses();
          mixSubs.forEach((f) => f());
        }
      })
      .catch(() => {});
  }
} catch {
  /* ignore */
}

export function getMix(): Mix {
  return mix;
}
export function mixFile(): string {
  return savedTo;
}
export function subscribeMix(f: () => void): () => void {
  mixSubs.add(f);
  return () => mixSubs.delete(f);
}
export function setMix(next: Mix): void {
  mix = next;
  try {
    localStorage.setItem(MIX_KEY, JSON.stringify({ ...mix, v: MIX_V }));
  } catch {
    /* ignore */
  }
  applyBuses();
  clearTimeout(saveT);
  saveT = window.setTimeout(() => {
    void window.clips
      ?.saveRecapMix?.({ ...mix, v: MIX_V })
      .then((p) => {
        savedTo = p;
        mixSubs.forEach((f) => f());
      })
      .catch(() => {});
  }, 500);
  mixSubs.forEach((f) => f());
}
export function resetMix(): void {
  setMix(flat());
}

const busLevel = (b: BusName) => BASE[b] * mix.bus[b];

function applyBuses(): void {
  const a = ctx;
  if (!a) return;
  const t = a.currentTime;
  master.gain.setTargetAtTime(muted ? 0 : busLevel("master"), t, 0.05);
  musicBus.gain.setTargetAtTime(busLevel("music"), t, 0.05);
  sfxBus.gain.setTargetAtTime(busLevel("sfx"), t, 0.05);
  uiBus.gain.setTargetAtTime(busLevel("ui"), t, 0.05);
  roomIn.gain.setTargetAtTime(busLevel("room"), t, 0.05);
}

let ctx: AudioContext | null = null;
let master: GainNode;
let musicBus: GainNode;
let musicDuck: GainNode;
let musicTone: BiquadFilterNode;
let sfxBus: GainNode;
let uiBus: GainNode;
let roomIn: GainNode;
const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === "1";
} catch {
  /* ignore */
}

/** a 2 s room with a 20 ms pre-delay and an 8 kHz high cut, the study's effect reverb */
function room(a: AudioContext): AudioBuffer {
  const len = Math.round(a.sampleRate * 2.2);
  const pre = Math.round(a.sampleRate * 0.02);
  const ir = a.createBuffer(2, len, a.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / a.sampleRate;
      // one pole lowpass on the noise keeps the tail dark
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * 3.2) * 0.6;
    }
  }
  return ir;
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const a = new AudioContext({ latencyHint: "interactive" });
    // only there for when several loud cues stack, single cues sit under it
    const lim = a.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.knee.value = 2;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    master = a.createGain();
    master.gain.value = muted ? 0 : busLevel("master");
    master.connect(lim).connect(a.destination);
    const verb = a.createConvolver();
    verb.buffer = room(a);
    const hc = a.createBiquadFilter();
    hc.type = "lowpass";
    hc.frequency.value = 8000;
    roomIn = a.createGain();
    roomIn.gain.value = busLevel("room");
    roomIn.connect(verb).connect(hc).connect(master);
    musicBus = a.createGain();
    musicBus.gain.value = busLevel("music");
    musicDuck = a.createGain();
    // opened up when the recap is entered, dull on the title screen
    musicTone = a.createBiquadFilter();
    musicTone.type = "lowpass";
    musicTone.frequency.value = 20000;
    musicTone.Q.value = 0.5;
    musicBus.connect(musicDuck).connect(musicTone).connect(master);
    sfxBus = a.createGain();
    sfxBus.gain.value = busLevel("sfx");
    sfxBus.connect(master);
    uiBus = a.createGain();
    uiBus.gain.value = busLevel("ui");
    uiBus.connect(master);
    ctx = a;
  } catch {
    ctx = null;
  }
  return ctx;
}

function load(name: string): Promise<AudioBuffer | null> {
  const a = audio();
  const url = URLS[name];
  if (!a || !url) return Promise.resolve(null);
  let p = loading.get(name);
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => a.decodeAudioData(b))
      .then((buf) => {
        buffers.set(name, buf);
        return buf;
      })
      .catch(() => null);
    loading.set(name, p);
  }
  return p;
}

/** decodes everything but the music up front, music loads when its track is asked for */
export function preload(): void {
  if (!audio()) return;
  for (const name of Object.keys(URLS)) if (!name.startsWith("music-")) void load(name);
}

/** call from a pointer press or key, so autoplay rules never hold the context */
export function unlock(): void {
  void audio()?.resume();
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* ignore */
  }
  const a = audio();
  if (!a) return;
  master.gain.cancelScheduledValues(a.currentTime);
  master.gain.setTargetAtTime(m ? 0 : busLevel("master"), a.currentTime, 0.08);
}

/** dips the music: down in `attack` s, holds, back in `release` s */
export function duck(level: number, attack: number, hold: number, release: number): void {
  const a = audio();
  if (!a) return;
  const g = musicDuck.gain;
  const now = a.currentTime;
  g.cancelAndHoldAtTime(now);
  g.setTargetAtTime(level, now, Math.max(0.005, attack / 3));
  g.setTargetAtTime(1, now + attack + hold, release / 3);
}

/** holds the music down until `release` is called, for a playing clip */
let held = 1;
export function holdMusic(level: number, attack = 0.5): void {
  const a = audio();
  if (!a) return;
  held = level;
  musicDuck.gain.cancelAndHoldAtTime(a.currentTime);
  musicDuck.gain.setTargetAtTime(level, a.currentTime, attack / 3);
}
export function releaseMusic(release = 1.5): void {
  const a = audio();
  if (!a || held === 1) return;
  held = 1;
  musicDuck.gain.cancelAndHoldAtTime(a.currentTime);
  musicDuck.gain.setTargetAtTime(1, a.currentTime, release / 3);
}

/** how open the music sounds, 0 = through a wall, 1 = full */
export function musicOpen(v: number, time = 1.2): void {
  const a = audio();
  if (!a) return;
  const f = 350 * Math.pow(20000 / 350, Math.max(0, Math.min(1, v)));
  musicTone.frequency.cancelScheduledValues(a.currentTime);
  musicTone.frequency.setTargetAtTime(f, a.currentTime, time / 3);
}

/** where a sound has rung 24 dB down from its loudest 50 ms, in s. the jingles carry long tails
 * (the top reveal one is 9 s of file, quiet after 4.8) and the music waited out the whole file */
const rang = new WeakMap<AudioBuffer, number>();
function ringOut(buf: AudioBuffer): number {
  let t = rang.get(buf);
  if (t != null) return t;
  const d = buf.getChannelData(0);
  const win = Math.round(buf.sampleRate * 0.05);
  const rms: number[] = [];
  for (let i = 0; i < d.length; i += win) {
    const e = Math.min(d.length, i + win);
    let s = 0;
    for (let j = i; j < e; j++) s += d[j] * d[j];
    rms.push(Math.sqrt(s / (e - i)));
  }
  const floor = Math.max(...rms) * 0.063;
  let k = rms.length - 1;
  while (k > 0 && rms[k] < floor) k--;
  t = ((k + 1) * win) / buf.sampleRate;
  rang.set(buf, t);
  return t;
}

export function play(cue: Cue, o: PlayOpts = {}): void {
  const a = audio();
  if (!a || muted) return;
  const buf = buffers.get(cue);
  if (!buf) {
    // not decoded yet: late is better than never for anything but ticks
    if (cue !== "tick") void load(cue).then((b) => b && (o.at ?? 0) < 0.3 && play(cue, { ...o, at: 0 }));
    return;
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  if (o.rate) src.playbackRate.value = o.rate;
  const g = a.createGain();
  const m = mix.cue[cue];
  const lv = LEVEL[cue];
  g.gain.value = (o.gain ?? 1) * (lv?.gain ?? 1) * (m?.gain ?? 1);
  let node: AudioNode = src.connect(g);
  if (o.pan) {
    const p = a.createStereoPanner();
    p.pan.value = o.pan;
    node = node.connect(p);
  }
  node.connect(o.bus === "ui" ? uiBus : sfxBus);
  const room = (o.room ?? (o.bus === "ui" ? 0 : 0.12)) * (lv?.room ?? 1) * (m?.room ?? 1);
  if (room > 0) {
    const s = a.createGain();
    s.gain.value = room;
    node.connect(s).connect(roomIn);
  }
  const at = a.currentTime + Math.max(0, o.at ?? 0);
  src.start(at);
  if (o.group) {
    let set = groups.get(o.group);
    if (!set) groups.set(o.group, (set = new Set()));
    const live = { src, g, at, jingle: o.duck === "jingle" };
    set.add(live);
    src.onended = () => set!.delete(live);
  }
  if (o.duck === "jingle") {
    const g2 = musicDuck.gain;
    g2.cancelAndHoldAtTime(at);
    g2.setTargetAtTime(0, at, 0.02);
    g2.setTargetAtTime(held, at + ringOut(buf) / (o.rate ?? 1), 0.5);
  } else if (o.duck === "ui" && held === 1) duck(0.8, 0.01, 0.05, 0.1);
}

/** drops a group's cues that haven't started yet and fades the ones playing; a cancelled riser
 * dies over `fade` instead of being cut, like the study's hold cancel */
export function cancel(group: string, fade = 0.15): void {
  const a = ctx;
  const set = groups.get(group);
  if (!a || !set) return;
  const now = a.currentTime;
  let jingle = false;
  for (const l of set) {
    jingle ||= l.jingle;
    try {
      if (l.at > now + 0.005) l.src.stop();
      else {
        l.g.gain.cancelAndHoldAtTime(now);
        l.g.gain.setTargetAtTime(0, now, fade / 3);
        l.src.stop(now + fade * 2);
      }
    } catch {
      /* already stopped */
    }
  }
  set.clear();
  if (jingle) {
    musicDuck.gain.cancelAndHoldAtTime(now);
    musicDuck.gain.setTargetAtTime(held, now, 0.3);
  }
}

const last = new Map<string, number>();
/** play unless the same key fired within `gap` ms, for hovers and fast repeats */
export function playThrottled(key: string, gap: number, cue: Cue, o: PlayOpts = {}): void {
  const now = performance.now();
  if (now - (last.get(key) ?? -1e9) < gap) return;
  last.set(key, now);
  play(cue, o);
}

/** a hover tick. `step` walks a whole-tone scale, so sliding across a row of controls plays a
 * little run upward instead of the same click */
export function hover(step = 0): void {
  playThrottled("hover", 45, "tick", { bus: "ui", gain: 0.55, rate: Math.pow(2, (step % 8) / 6) });
}

// the sparkles' echo, made on first use: with the room off they need something to hang in. short
// and bright, a darker one smeared the glitter into a hum
let echoIn: GainNode | null = null;
function echo(a: AudioContext): GainNode {
  if (echoIn) return echoIn;
  echoIn = a.createGain();
  const d = a.createDelay(1);
  d.delayTime.value = 0.19;
  const fb = a.createGain();
  fb.gain.value = 0.42;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 9000;
  const wet = a.createGain();
  wet.gain.value = 0.38;
  echoIn.connect(d).connect(lp).connect(fb).connect(d);
  lp.connect(wet).connect(sfxBus);
  return echoIn;
}

// a second of white noise, shared by every sparkle's shimmer
let noiseBuf: AudioBuffer | null = null;
function noise(a: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** one glassy tink: a sine struck by a quick fm burst at an inharmonic ratio, gone in a moment */
function ping(a: AudioContext, dest: AudioNode, freq: number, t: number, peak: number, dec: number, srcs: AudioScheduledSourceNode[]): void {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  const car = a.createOscillator();
  car.frequency.value = freq;
  const mod = a.createOscillator();
  mod.frequency.value = freq * 2.76;
  const idx = a.createGain();
  idx.gain.setValueAtTime(freq * 1.2, t);
  idx.gain.exponentialRampToValueAtTime(freq * 0.02, t + 0.12);
  mod.connect(idx).connect(car.frequency);
  car.connect(g).connect(dest);
  for (const o of [car, mod]) {
    o.start(t);
    o.stop(t + dec + 0.02);
    srcs.push(o);
  }
}

const SPARKLE_GAIN = 0.1;
// a run goes up from the star's note by these, each tink fainter and shorter
const RUN = [1, 1.5, 2, 3, 4];

/** a star: a quick run of high tinks up from `freq`, a breath of filtered noise on top, the echo
 * behind. made here, not from a file: sampled sparkles pitched up a scale sounded like a toy and a
 * single bell sat too low and round */
export function sparkle(freq: number, o: { at?: number; gain?: number; pan?: number; n?: number; decay?: number; group?: string } = {}): void {
  const a = audio();
  if (!a || muted) return;
  const t = a.currentTime + Math.max(0, o.at ?? 0);
  const peak = SPARKLE_GAIN * (o.gain ?? 1);
  const dec = o.decay ?? 0.9;
  const out = a.createGain();
  let node: AudioNode = out;
  if (o.pan) {
    const p = a.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    node = out.connect(p);
  }
  node.connect(sfxBus);
  node.connect(echo(a));
  const srcs: AudioScheduledSourceNode[] = [];
  const n = o.n ?? 4;
  for (let k = 0; k < n; k++) {
    const f = freq * RUN[k % RUN.length];
    // past this it's a whistle, not a glint
    if (f > 11000) break;
    ping(a, out, f * (1 + (Math.random() - 0.5) * 0.006), t + k * 0.034 + Math.random() * 0.012, peak * (1 - k * 0.17), dec * (1 - k * 0.14), srcs);
  }
  const ns = a.createBufferSource();
  ns.buffer = noise(a);
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = Math.min(12000, freq * 4);
  bp.Q.value = 2.5;
  const ng = a.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(peak * 0.9, t + 0.003);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  ns.connect(bp).connect(ng).connect(out);
  ns.start(t, Math.random() * 0.6);
  ns.stop(t + 0.3);
  srcs.push(ns);
  if (o.group) {
    let set = groups.get(o.group);
    if (!set) groups.set(o.group, (set = new Set()));
    // cancel() fades `out` and stops the voice, here every oscillator and the noise: stopping only
    // one source of a sparkle that hadn't started left the rest of its run ringing
    const voice = {
      stop: (w?: number) => {
        for (const sn of srcs) {
          try {
            sn.stop(w);
          } catch {
            /* already stopped */
          }
        }
      },
    };
    const live = { src: voice as unknown as AudioBufferSourceNode, g: out, at: t, jingle: false };
    set.add(live);
    srcs[0].onended = () => set!.delete(live);
  }
}

/** a pop, like a cork: a sine dropping fast in pitch with a click of noise on top. made here, none
 * of the files has one */
export function pop(o: { at?: number; gain?: number } = {}): void {
  const a = audio();
  if (!a || muted) return;
  const t = a.currentTime + Math.max(0, o.at ?? 0);
  const peak = 0.38 * (o.gain ?? 1);
  const osc = a.createOscillator();
  osc.frequency.setValueAtTime(820, t);
  osc.frequency.exponentialRampToValueAtTime(190, t + 0.08);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(g).connect(sfxBus);
  osc.start(t);
  osc.stop(t + 0.14);
  const ns = a.createBufferSource();
  ns.buffer = noise(a);
  const hp = a.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2500;
  const ng = a.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(peak * 0.4, t + 0.001);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
  ns.connect(hp).connect(ng).connect(sfxBus);
  ns.start(t, Math.random() * 0.5);
  ns.stop(t + 0.04);
}

/** the chart closing: glints falling all over the stereo field, faster then thinning out */
export function starfall(notes: number[], o: { at?: number; gain?: number; group?: string } = {}): void {
  const at = o.at ?? 0;
  for (let k = 0; k < 18; k++) {
    const f = notes[Math.floor(Math.random() * notes.length)];
    sparkle(f, { at: at + 0.9 * Math.pow(k / 18, 1.6), gain: (o.gain ?? 1) * (1 - k / 26), pan: (Math.random() - 0.5) * 1.6, n: 2, decay: 1.4, group: o.group });
  }
}

/** a tick for a number counting up, rising with how far it has got, capped at ~25 per second */
export function count(progress: number): void {
  playThrottled("count", 40, "tick", { bus: "ui", gain: 0.5, rate: 0.9 + 0.5 * Math.max(0, Math.min(1, progress)) });
}

let taps = 0;
/** a press on the pack that doesn't start a cut: a foil crinkle, the two takes in turn */
export function tap(): void {
  play(taps++ % 2 ? "tap-2" : "tap-1");
}

// progress points along the pack's cut line, each fires the next take, always at normal speed.
// a fast swipe passes several in one move and they overlap into one rip, a slow one leaves
// silence between them, which is what slow tearing sounds like: separate pops, not a stretched
// noise. soft take, a long one that speeds up, a dense end; the snap is kept for the rip
const MARKS = [0.02, 0.25, 0.55, 0.8];
const TAKES: Cue[] = ["cut-1", "cut-2", "cut-3"];
let mark = 0;
let take = 0;
let lastTake = 0;

export function cutStart(): void {
  mark = 0;
}

/** progress 0..1 along the cut line */
export function cut(progress: number): void {
  while (mark < MARKS.length && progress >= MARKS[mark]) {
    const now = performance.now();
    // a second without a take starts the arc over at the soft one
    if (now - lastTake > 1000) take = 0;
    play(TAKES[Math.min(take, TAKES.length - 1)]);
    take++;
    mark++;
    lastTake = now;
  }
}

interface Voice {
  src: AudioBufferSourceNode;
  g: GainNode;
}
let track: Track | null = null;
let voice: Voice | null = null;

/** crossfades to a track, or to silence with null. the same track keeps playing */
export function music(next: Track | null, fade = 1.6): void {
  const a = audio();
  if (!a || next === track) return;
  track = next;
  const old = voice;
  voice = null;
  if (old) {
    old.g.gain.cancelAndHoldAtTime(a.currentTime);
    old.g.gain.setTargetAtTime(0, a.currentTime, fade / 4);
    old.src.stop(a.currentTime + fade * 1.5);
  }
  if (!next) return;
  void load(`music-${next}`).then((buf) => {
    if (!buf || track !== next || voice) return;
    const src = a.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = LOOPS[next].a;
    src.loopEnd = LOOPS[next].b;
    const g = a.createGain();
    g.gain.value = 0;
    src.connect(g).connect(musicBus);
    // the study starts its first loop 400 ms after the trigger, which leaves room for the cue that
    // caused it
    src.start(a.currentTime + 0.4);
    g.gain.setTargetAtTime(1, a.currentTime + 0.4, fade / 4);
    voice = { src, g };
  });
}

/** everything out, for closing the recap */
export function stopAll(fade = 0.8): void {
  music(null, fade);
  releaseMusic(0.2);
}

// the year recap: an intro and up to seven chapters on a 1920x1080 stage scaled to the window.
// ported from the "Setsu Recap 2026" design. a class because the scenes are one imperative rAF
// engine that reads and writes the same instance state from pointer handlers and the frame loop
import { Component, createRef, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type SyntheticEvent } from "react";
import { Copy, Download, ExternalLink, Image as ImageIcon, Link2, Pause, Play, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/unbounded";
import cornersUrl from "../../../assets/setsu/corners.png";
// inline so the exported card has it without a fetch
import starUrl from "../../../assets/setsu/star.svg?inline";
import type { RecapData } from "../../types/clips";
import { fileUrl } from "../player/layers/meta";
import {
  DISPLAY,
  END_REF,
  MARKS,
  MONO,
  NAMES,
  SANS,
  STACK_REF,
  bgOf,
  buildModel,
  cl,
  eio,
  eo,
  eob,
  fmtAlt,
  fmtLen,
  fmtN,
  fmtS,
  hhmm,
  lch,
  pad,
  pct,
  pickRef,
  plural,
  shortName,
  type Friend,
  type Lch,
  type Model,
  type Owner,
  type Ref,
} from "./model";
import { drawISS, drawPlane, drawSil, lay, loadImage, ready, rrp, seeded } from "./draw";
import { PackScene, type PackPhase } from "./pack";
import { chipsOf, fmtDur, sharePayloadWithPics, statsOf, typeOf, type ShareQuestion, type ShareTier, type Stat } from "./share";
import * as au from "./audio";
import { MixPanel } from "./MixPanel";
import { markRecapFinished } from "./recapStore";
import "./recap.css";

type Key = "stack" | "clock" | "orbit" | "cut" | "repeat" | "chart" | "card";
type CardPhase = "pack" | "opening" | "back" | "front";

interface Guesses {
  stack?: number;
  end?: number;
  hour?: number;
  who?: string;
  rw?: number;
}

interface State {
  intro: boolean;
  introOut: boolean;
  ci: number;
  step: number;
  g: Guesses;
  rev: Partial<Record<"stack" | "end" | "hour" | "who" | "cut" | "rw", true>>;
  sel: string | null;
  hover: string | null;
  toast: string | null;
  k: number;
  vph: "intro" | "play";
  /** the rewatched clip's file is gone or won't play */
  vbad: boolean;
  vp: number;
  muted: boolean;
  /** the cutting room guess, as shares of a minute */
  cs: number;
  ce: number;
  drag: "s" | "e" | null;
  cardPh: CardPhase;
  packPh: PackPhase;
  /** hovered game on the clock */
  hg: number | null;
  /** data urls for the card's two chip pictures, so the png export has them */
  inl: Record<string, string>;
  /** stage px the window shows beyond the 1920x1080 stage on each side, filled by the sky */
  bx: number;
  by: number;
  /** the recap's own sound, not the clip's */
  soundOff: boolean;
  /** the clip on repeat, paused by hand */
  paused: boolean;
  /** this year's share link, kept by main */
  shareUrl: string | null;
  sharing: boolean;
  /** friends on the shared page, off unless the owner turns it on: their names and faces are theirs */
  crew: boolean;
  /** "click the card" shows once the card has sat unflipped a while, and never after the first click */
  flipHint: boolean;
  /** how many chart stars are traced in order so far, all of them lights the constellation */
  lit: number;
  /** the chart star under the pointer, -1 for none */
  hot: number;
}

interface Props {
  data: RecapData;
  owner: Owner;
  onClose(): void;
}

interface Block {
  h: number;
  am: boolean;
  slot: number;
  th: number;
  g: number;
  c1: string;
  c2: string;
  x: number;
  y: number;
}
interface ClockLayout {
  CX: number;
  CY: number;
  RI: number;
  RO: number;
  R0: number;
  R1: number;
  blocks: Block[];
  pitch: number;
  size: number;
}
interface Dot {
  j: number;
  g: number;
  c2: string;
}
interface OrbitFriend extends Friend {
  r: number;
  base: number;
  w: number;
  th0: number;
  th: number;
  rr: number;
  x: number;
  y: number;
  sz: number;
  k: number;
  ds: number;
  z: number;
}
interface CardSim {
  x: number;
  y: number;
  o: number;
  vx: number;
  vy: number;
  vo: number;
  f: number;
  vf: number;
  ft: number;
  hov: boolean;
  hx: number;
  hy: number;
  ph: "pack" | "open";
  ready: boolean;
  /** how much of the pointer tilt the card takes, 0 while it's still in the pack */
  mix: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

const EASE_OUT = "cubic-bezier(.16,1,.3,1)";
const EASE_POP = "cubic-bezier(.34,1.56,.64,1)";
const rise = (d: number, dur = 0.7): CSSProperties => ({ animation: `rc-rise ${dur}s ${EASE_OUT} ${d}s both` });
const pop = (d: number, dur = 0.5): CSSProperties => ({ animation: `rc-pop ${dur}s ${EASE_POP} ${d}s both` });
const fade = (d: number, dur: number): CSSProperties => ({ animation: `rc-fade ${dur}s ease ${d}s both` });
/** a smaller font once the text runs past `max` characters at `px`, so a big number stays on one line */
const fit = (t: string, px: number, max: number): CSSProperties => (t.length > max ? { fontSize: Math.floor((px * max) / t.length) } : {});
const trunc = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
/** where the kept part sits, only said when the trims agree on it */
const cutWhere = (s: number, e: number) => {
  const w = s < 0.15 && e > 0.85 ? "Nearly the whole thing" : e > 0.85 && s > 0.35 ? "Almost always the ending" : s < 0.15 && e < 0.65 ? "Mostly the start" : "";
  return w ? w + ": on average from" : "On average from";
};

type Tier = "spot" | "close" | "near" | "off";
/** how close a guess came. spot and close count as right */
interface Near {
  tier: Tier;
  /** 0..1, fills the meter */
  acc: number;
  /** a percent and a meter only where a share is what was guessed: heights and the trim overlap.
   * a pick from a few options or an hour on a clock reads wrong as a percentage */
  pct: boolean;
  /** what stands in for the percent otherwise, in the guess's own unit */
  big?: string;
  said: string;
  off: string;
}
/** error to tier, against the most an error can be for each tier up to near */
const tierOf = (e: number, spot: number, close: number, near: number): Tier => (e <= spot ? "spot" : e <= close ? "close" : e <= near ? "near" : "off");
// the star chart: where each stat's star sits on the stage, joined in this order, and when the
// first one lights and how far apart the rest follow, in s
const CHART: Array<[number, number]> = [
  [880, 300],
  [1150, 200],
  [1430, 290],
  [1700, 190],
  [1650, 500],
  [1370, 580],
  [1090, 500],
  [870, 700],
  [1160, 810],
  [1460, 760],
  [1720, 820],
];
// the note a chart star glints at: up E major pentatonic from E6, one degree per star
const starHz = (i: number) => 1318.5 * Math.pow(2, (12 * Math.floor(i / 5) + [0, 2, 4, 7, 9][i % 5]) / 12);
const CHART_T0 = 0.55;
const CHART_DT = 0.26;
type Side = "b" | "br" | "bl" | "t" | "r" | "l";
/** where each chart star's label goes: under it unless a line runs through there, else hanging off
 * to one side, above, right or left, wherever it covers no line, star or other label. sizes are
 * guesses from the text length */
function chartSides(stats: Stat[]): Side[] {
  const pts = CHART.slice(0, stats.length);
  const boxes: number[][] = [];
  const inside = (b: number[], x: number, y: number, m: number) => x > b[0] - m && x < b[2] + m && y > b[1] - m && y < b[3] + m;
  return stats.map((st, i) => {
    const [x, y] = pts[i];
    const big = i === 0;
    const w = Math.max(st.v.length * (big ? 35 : 25), st.l.length * 11, st.n.length * 7.6);
    const h = (big ? 67 : 53) + (st.n ? 25 : 0);
    // same offsets as .rc-node-lab and its sides in recap.css
    const gap = big ? 32 : 24;
    const mid = big ? 24 : 17;
    const at: Record<Side, number[]> = {
      b: [x - w / 2, y + gap, x + w / 2, y + gap + h],
      t: [x - w / 2, y - gap - h, x + w / 2, y - gap],
      r: [x + gap + 4, y - mid, x + gap + 4 + w, y - mid + h],
      l: [x - gap - 4 - w, y - mid, x - gap - 4, y - mid + h],
      br: [x - 20, y + gap, x - 20 + w, y + gap + h],
      bl: [x + 20 - w, y + gap, x + 20, y + gap + h],
    };
    let best: Side = "b";
    let low = Infinity;
    (["b", "br", "bl", "t", "r", "l"] as const).forEach((s, k) => {
      const b = at[s];
      let bad = k * 0.5;
      for (let j = 1; j < pts.length; j++) {
        const [x1, y1] = pts[j - 1];
        const [x2, y2] = pts[j];
        for (let q = 0; q <= 1; q += 1 / 48) {
          if (inside(b, x1 + (x2 - x1) * q, y1 + (y2 - y1) * q, 6)) {
            bad += 4;
            break;
          }
        }
      }
      for (let j = 0; j < pts.length; j++) if (j !== i && inside(b, pts[j][0], pts[j][1], 26)) bad += 4;
      for (const o of boxes) if (b[0] < o[2] + 16 && o[0] < b[2] + 16 && b[1] < o[3] + 16 && o[1] < b[3] + 16) bad += 6;
      // the copy block sits top left, the chrome along the bottom
      if (b[0] < 730 || b[2] > 1880 || b[1] < 60 || b[3] > 1000) bad += 6;
      if (bad < low) {
        low = bad;
        best = s;
      }
    });
    boxes.push(at[best]);
    return best;
  });
}
// faint stars around the chart that belong to no line
const CHART_DUST = Array.from({ length: 26 }, (_, i) => [760 + ((i * 397) % 1060), 130 + ((i * 251) % 800), 0.25 + ((i * 7) % 5) / 10] as const);
const TIER: Record<Tier, string> = { spot: "Spot on", close: "So close", near: "Not far", off: "Way off" };
// where a right answer's sparkles fly, fixed so a rerender doesn't reshuffle them
const BURST = Array.from({ length: 22 }, (_, i) => {
  const a = (i / 22) * Math.PI * 2 + (i % 3) * 0.21;
  const d = 80 + ((i * 37) % 70);
  return { x: Math.cos(a) * d * 1.9, y: Math.sin(a) * d, s: 0.55 + ((i * 13) % 10) / 14, c: i % 3 };
});

function Logo({ size, style }: { size: number; style?: CSSProperties }) {
  return (
    <div className="rc-logo" style={{ width: size, height: size, ...style }}>
      <img src={cornersUrl} alt="" draggable={false} />
      <img src={starUrl} alt="" draggable={false} />
    </div>
  );
}

export default class Recap extends Component<Props, State> {
  state: State = {
    intro: true,
    introOut: false,
    ci: 0,
    step: 0,
    g: {},
    rev: {},
    sel: null,
    hover: null,
    toast: null,
    k: 1,
    vph: "intro",
    vbad: false,
    vp: 0,
    muted: false,
    cs: 0.2,
    ce: 0.7,
    drag: null,
    cardPh: "pack",
    packPh: "enter",
    hg: null,
    inl: {},
    bx: 0,
    by: 0,
    soundOff: au.isMuted(),
    paused: false,
    shareUrl: null,
    sharing: false,
    crew: false,
    flipHint: false,
    lit: 0,
    hot: -1,
  };

  rootRef = createRef<HTMLDivElement>();
  introCv = createRef<HTMLCanvasElement>();
  stackCv = createRef<HTMLCanvasElement>();
  clockCv = createRef<HTMLCanvasElement>();
  orbitCv = createRef<HTMLCanvasElement>();
  vidRef = createRef<HTMLVideoElement>();
  trackRef = createRef<HTMLDivElement>();
  stageRef = createRef<HTMLDivElement>();
  cardRef = createRef<HTMLDivElement>();
  flipRef = createRef<HTMLDivElement>();
  frontRef = createRef<HTMLDivElement>();
  packBackCv = createRef<HTMLCanvasElement>();
  packFrontCv = createRef<HTMLCanvasElement>();
  dimRef = createRef<HTMLDivElement>();
  flashLineRef = createRef<HTMLDivElement>();
  artCv = createRef<HTMLCanvasElement>();
  planetRef = createRef<HTMLDivElement>();
  holoRef = createRef<HTMLDivElement>();
  specRef = createRef<HTMLDivElement>();
  titleRef = createRef<HTMLDivElement>();
  tiltRef = createRef<HTMLDivElement>();
  shadowRef = createRef<HTMLDivElement>();
  raysRef = createRef<HTMLDivElement>();
  flashRef = createRef<HTMLDivElement>();
  sparkCv = createRef<HTMLCanvasElement>();

  D: Model;
  col!: (g: number, day: number) => Lch;
  refA!: Ref;
  refB!: Ref;
  VA = 1;
  VB = 1;
  stars: Array<{ x: number; y: number; r: number; a: number }> = [];
  dots: Dot[] = [];
  ck!: ClockLayout;
  orbF: OrbitFriend[] = [];
  imgs = new Map<string, HTMLImageElement>();

  stepT = 0;
  touched = { stack: false };
  stDrag = false;
  cDrag = false;
  cdpr = 1;
  mx: number | null = null;
  my = 0;
  outT = 0;

  iStars: Array<{ x: number; y: number; z: number; ph: number }> | null = null;
  neb: HTMLCanvasElement | null = null;
  iv = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
  shoot: { t0: number; x: number; y: number; a: number } | null = null;
  nextShoot = 4;
  irnd: () => number = Math.random;
  digits: Array<{ ch: string; x: number; w: number }> | null = null;
  digEls: HTMLDivElement[] | null = null;
  // last written per digit, so settled digits stop touching the dom
  digT: string[] = [];
  introT0 = 0;
  titleBuilt = false;
  pearlEl: SVGLinearGradientElement | null = null;

  cs0: CardSim | null = null;
  pack: PackScene | null = null;
  packTried = false;
  skyCv = createRef<HTMLCanvasElement>();
  stgRef = createRef<HTMLDivElement>();
  /** the starfield behind everything, in stage px over a field wider than any window */
  skyStars: Array<{ x: number; y: number; z: number; ph: number }> = [];
  bandStars: Array<{ x: number; y: number; a: number; r: number }> = [];
  introSky: { t: number; out: boolean; ot: number; ox: number; oy: number } | null = null;
  sv = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
  glow = { x: 960, y: 420, r: 900, c0: 90, c1: 30, c2: 170, a: 0.12 };
  chapT0 = 0;
  shootAt = 0;
  skyShoot: { t0: number; x: number; y: number; a: number; dim: number } | null = null;
  // answers given this run, in sync with rv() so a verdict scheduled right after it can see them
  revd = new Set<string>();
  hoverEl: Element | null = null;
  stB = -1;
  /** the stack block's drawn height in px and its speed, sprung toward the real one */
  blk = { h: 0, v: 0, t: 0 };
  prevH = 0;
  /** when a right answer lands, the sky blooms */
  pulseAt = 0;
  // easter eggs: the card flipped five times in a moment spins, a shooting star can be caught, the
  // konami code throws the sky into hyperspace, the star chart lights up when traced in order
  flips: number[] = [];
  spinT0 = 0;
  shootPos: { x: number; y: number; ex: number; ey: number } | null = null;
  caught: Array<{ x: number; y: number; t0: number }> = [];
  kpos = 0;
  warpT0 = 0;
  hinted = false;
  tiltT = 0;
  tiltX = 0.5;
  tiltY = 0.5;
  // the first flip to the front is the reveal, it gets its own sound and jingle
  revealed = false;
  hintT = 0;
  // a canvas keeps its lost webgl context forever, so every pack gets fresh canvases
  packGen = 0;
  packK = 0;
  lastTip: { x: number; y: number } | null = null;
  lastFlash = 0;
  sparks: Spark[] = [];
  /** four point glints that pop on the pack as it lands: they grow, turn and fade where they are */
  glints: Array<{ x: number; y: number; t0: number; life: number; r: number; rot: number }> = [];
  artDone = false;

  raf = 0;
  ot = 0;
  vt = 0;
  tt = 0;
  dead = false;
  ro: ResizeObserver | null = null;

  constructor(props: Props) {
    super(props);
    this.D = buildModel(props.data, props.owner);
    this.prep();
  }

  componentDidMount() {
    const root = this.rootRef.current;
    if (root) {
      this.ro = new ResizeObserver(() => {
        const r = root.getBoundingClientRect();
        const k = Math.min(r.width / 1920, r.height / 1080);
        this.setState({ k, bx: Math.max(0, (r.width / k - 1920) / 2), by: Math.max(0, (r.height / k - 1080) / 2) });
      });
      this.ro.observe(root);
    }
    au.preload();
    void this.prepIntro();
    window.addEventListener("keydown", this.kd, true);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      try {
        this.frame(now);
      } catch {
        // a bad frame should not stop the loop
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  componentWillUnmount() {
    this.dead = true;
    this.ro?.disconnect();
    window.removeEventListener("keydown", this.kd, true);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.ot);
    clearTimeout(this.vt);
    clearTimeout(this.tt);
    this.vidRef.current?.pause();
    this.dropPack();
    au.cancel("intro");
    au.cancel("step");
    au.stopAll(0.4);
  }

  close = () => {
    au.play("fadeout");
    au.stopAll(0.8);
    this.props.onClose();
  };

  toggleSound = () => {
    const m = !au.isMuted();
    au.setMuted(m);
    this.setState({ soundOff: m });
    if (!m) au.play("tick", { bus: "ui" });
  };

  /** hover ticks for every button, rising along a row so sliding across the segments plays a run */
  overUi = (e: RPointerEvent<HTMLDivElement>) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b === this.hoverEl) return;
    this.hoverEl = b;
    if (!b || b.disabled || b.classList.contains("rc-node")) return;
    const row = b.parentElement ? Array.from(b.parentElement.children).filter((n) => n.tagName === "BUTTON") : [];
    au.hover(Math.max(0, row.indexOf(b)));
  };

  // modal while open: the library's shortcuts never see these keys
  kd = (e: KeyboardEvent) => {
    e.stopPropagation();
    // the mixer's sliders keep their arrow keys
    if ((e.target as HTMLElement | null)?.closest?.(".rc-mix")) return;
    au.unlock();
    const onButton = (e.target as HTMLElement | null)?.tagName === "BUTTON";
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    // up up down down left right left right b a: the arrows mid-code don't change chapters
    const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === KONAMI[this.kpos]) {
      this.kpos++;
      if (this.kpos === KONAMI.length) {
        this.kpos = 0;
        this.warpT0 = performance.now();
        au.play("immersive-start", { gain: 0.8 });
        au.play("riser-1", { at: 0.1, gain: 0.7 });
        au.play("stinger-star", { at: 2.4, gain: 0.5 });
        return;
      }
      if (this.kpos > 4) {
        e.preventDefault();
        return;
      }
    } else this.kpos = key === KONAMI[0] ? 1 : 0;
    if (e.key === "m" || e.key === "M") {
      this.toggleSound();
    } else if ((e.key === " " || e.key === "Enter") && onButton) {
      return;
    } else if (e.key === " " && this.curKey() === "repeat" && this.state.step === 1 && this.state.vph === "play") {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.prev();
    }
  };

  img(srcs: string[] | string | null | undefined): HTMLImageElement | undefined {
    const list = typeof srcs === "string" ? [srcs] : srcs ?? [];
    if (!list.length) return undefined;
    const key = list.join("|");
    let im = this.imgs.get(key);
    if (!im) {
      im = loadImage(list);
      this.imgs.set(key, im);
    }
    return im;
  }

  prep() {
    const D = this.D;
    const col = (g: number, day: number): Lch => {
      if (g >= 0 && g < 99 && D.games[g]) return D.games[g].lch;
      if (!D.hasGames) {
        // no games anywhere: colour by date instead
        const t = cl((day - D.dayMin) / Math.max(1, D.dayMax - D.dayMin));
        return [0.74, 0.16, 345 - t * 95];
      }
      return g === 99 ? [0.66, 0.07, 285] : [0.5, 0.03, 300];
    };
    this.col = col;
    const sorted = D.pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.refA = pickRef(STACK_REF, D.stackH);
    this.refB = pickRef(END_REF, D.endH);
    this.VA = Math.max(this.refA.h / 0.45, D.stackH / 0.86);
    this.VB = Math.max(this.refB.h / 0.45, D.endH / 0.86);
    const rnd = seeded(7);
    this.stars = Array.from({ length: 320 }, () => ({ x: rnd() * 1920, y: rnd() * 1080, r: rnd() < 0.85 ? 1.2 : 2.2, a: 0.3 + rnd() * 0.7 }));
    this.dots = sorted.map((p) => {
      const j = cl(Math.floor(p[1] - 6), 0, 23);
      const h = (6 + j) % 24;
      const k = col(p[2], p[0]);
      const c1 = h >= 20 || h < 6 ? "oklch(.72 .21 330)" : "oklch(.8 .09 300)";
      return { j, g: p[2], c2: D.hasGames ? lch(k[0], k[1], k[2]) : c1 };
    });
    this.prepClock();
    const F = D.friends.slice(0, 5);
    this.orbF = F.map((f, i) => ({
      ...f,
      r: 210 + i * 64,
      base: 22 + 28 * Math.sqrt(f.clips / F[0].clips),
      w: 0.28 * Math.pow(210 / (210 + i * 64), 1.5),
      th0: i * 2.3 + 0.6,
      th: 0,
      rr: 0,
      x: 0,
      y: 0,
      sz: 0,
      k: 0,
      ds: 0,
      z: 0,
    }));
    this.img(D.owner.av);
    for (const f of F) this.img(f.av);
    for (const g of D.games) this.img(g.srcs);
  }

  /** a field 3520 x 2080 around the stage, so the widest window still has stars at its edges,
   * plus a faint band of small ones across it for the galaxy */
  prepSky() {
    const rnd = seeded(23);
    this.skyStars = Array.from({ length: 1500 }, () => ({ x: -800 + rnd() * 3520, y: -500 + rnd() * 2080, z: Math.pow(rnd(), 1.6), ph: rnd() * 6.28 }));
    const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    this.bandStars = Array.from({ length: 700 }, () => {
      const u = rnd();
      const off = g() * 190;
      return { x: -800 + u * 3520 + off * 0.4, y: 1350 - u * 1700 + off, a: 0.12 + rnd() * 0.4, r: rnd() < 0.9 ? 0.8 : 1.4 };
    });
  }

  async prepIntro() {
    if (!this.skyStars.length) this.prepSky();
    this.shootAt = performance.now() / 1000 + 4;
    const rnd = seeded(11);
    this.iStars = Array.from({ length: 560 }, () => ({ x: rnd() * 2100 - 90, y: rnd() * 1200 - 60, z: Math.pow(rnd(), 1.6), ph: rnd() * 6.28 }));
    const nb = document.createElement("canvas");
    nb.width = 2300;
    nb.height = 1400;
    const n = nb.getContext("2d")!;
    const blobs: Array<[number, number, number, string]> = [
      [600, 420, 520, "rgba(165,6,230,.20)"],
      [1500, 300, 620, "rgba(61,3,215,.22)"],
      [1180, 620, 420, "rgba(232,11,238,.12)"],
      [300, 820, 380, "rgba(80,40,200,.14)"],
      [1900, 820, 460, "rgba(165,6,230,.12)"],
    ];
    for (const [x, y, r, c] of blobs) {
      const g = n.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(1, "rgba(0,0,0,0)");
      n.fillStyle = g;
      n.fillRect(0, 0, 2300, 1400);
    }
    this.neb = nb;
    this.iv = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
    this.shoot = null;
    this.nextShoot = 4;
    this.irnd = rnd;
    this.digits = null;
    this.digEls = null;
    this.introT0 = performance.now();
    try {
      await document.fonts.load(`800 330px ${DISPLAY}`);
    } catch {
      // measured with the fallback face then
    }
    if (this.dead) return;
    const o = document.createElement("canvas").getContext("2d")!;
    o.font = `800 330px ${DISPLAY}`;
    const yr = String(this.D.year).split("");
    const ws = yr.map((ch) => o.measureText(ch).width);
    let x = 760 - ws.reduce((a, b) => a + b, 0) / 2;
    this.digits = yr.map((ch, i) => {
      const cx = x + ws[i] / 2;
      x += ws[i];
      return { ch, x: cx, w: ws[i] };
    });
    this.titleBuilt = false;
    this.introT0 = performance.now();
    this.introScore();
  }

  /** the title screen: the menu track through a wall, the warp in, a riser that peaks as the year
   * lands, one turn per digit left to right, a sparkle on the landing flash */
  introScore() {
    au.cancel("intro");
    au.music("menu");
    au.musicOpen(0.12, 0.3);
    const at = (cue: au.Cue, t: number, o: au.PlayOpts = {}) => au.play(cue, { ...o, at: t - (performance.now() - this.introT0) / 1000, group: "intro" });
    at("list-ef", 0, { gain: 0.8 });
    // its shimmer peaks 0.75 s in, on the landing flash at 2.15
    at("riser-1", 1.4, { gain: 0.8 });
    [1.95, 2.09, 2.23, 2.37].forEach((t, i) => at("rotate-small", t - 0.12, { gain: 0.5, pan: -0.45 + i * 0.3 }));
    at("stinger-star", 2.15, { gain: 0.7 });
  }

  /** the year, one flat plane per digit: the design stacked 13 svgs per digit in 3d and
   * chromium sorted those 52 overlapping planes differently from frame to frame, so the purple
   * back layers flickered through the face. the 12 depth layers are baked into a canvas once,
   * shrunk toward the vanishing point like the perspective drew them, the pearl face sits on top */
  buildTitle(TR: HTMLDivElement) {
    TR.replaceChildren();
    const NS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(NS, "svg");
    defs.setAttribute("width", "0");
    defs.setAttribute("height", "0");
    defs.style.position = "absolute";
    const grad = document.createElementNS(NS, "linearGradient");
    grad.id = "rc-pearl";
    for (const [k, v] of Object.entries({ gradientUnits: "userSpaceOnUse", x1: "200", y1: "0", x2: "900", y2: "260", spreadMethod: "reflect" })) grad.setAttribute(k, v);
    const stops: Array<[number, string]> = [[0, "#ffffff"], [0.14, "#ffd6f7"], [0.3, "#d9c4ff"], [0.46, "#b8ecff"], [0.6, "#c9ffe4"], [0.74, "#fff0c9"], [0.88, "#ffd6f7"], [1, "#ffffff"]];
    for (const [off, c] of stops) {
      const st = document.createElementNS(NS, "stop");
      st.setAttribute("offset", String(off));
      st.setAttribute("stop-color", c);
      grad.appendChild(st);
    }
    defs.appendChild(grad);
    TR.appendChild(defs);
    this.pearlEl = grad;
    // the title box sits at 200,220 on the stage, the 1400px perspective looks at 960,540
    const OX = 760;
    const OY = 320;
    const H = 440;
    const font = `800 330px ${DISPLAY}`;
    const s = Math.min(2, Math.max(1, (window.devicePixelRatio || 1) * this.state.k));
    this.digT = [];
    this.digEls = (this.digits ?? []).map((d) => {
      const w = Math.ceil(d.w + 120);
      const left = d.x - w / 2;
      const wrap = document.createElement("div");
      wrap.style.cssText = `position:absolute;left:${left.toFixed(1)}px;top:0;width:${w}px;height:${H}px;visibility:hidden;will-change:transform;transform-origin:${(d.x - left).toFixed(1)}px 220px`;
      const cv = document.createElement("canvas");
      cv.width = Math.round(w * s);
      cv.height = Math.round(H * s);
      cv.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${H}px`;
      const ctx = cv.getContext("2d")!;
      ctx.scale(s, s);
      ctx.font = font;
      ctx.textAlign = "center";
      for (let i = 12; i >= 1; i--) {
        const f = 1400 / (1400 + i * 3.2);
        ctx.save();
        ctx.translate(OX - left, OY);
        ctx.scale(f, f);
        ctx.translate(-(OX - left), -OY);
        ctx.fillStyle = `oklch(${(0.58 - (i - 1) * 0.035).toFixed(3)} .17 ${305 - (i - 1) * 2})`;
        ctx.fillText(d.ch, d.x - left, 330);
        ctx.restore();
      }
      wrap.appendChild(cv);
      // the face keeps the title box's coordinates so the shared gradient lines up across digits
      const svg = document.createElementNS(NS, "svg");
      for (const [k, v] of Object.entries({ width: String(w), height: String(H), viewBox: `${left.toFixed(1)} 0 ${w} ${H}` })) svg.setAttribute(k, v);
      svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", d.x.toFixed(1));
      t.setAttribute("y", "330");
      t.setAttribute("text-anchor", "middle");
      t.style.font = font;
      t.style.fill = "url(#rc-pearl)";
      t.textContent = d.ch;
      svg.appendChild(t);
      wrap.appendChild(svg);
      TR.appendChild(wrap);
      return wrap;
    });
    this.titleBuilt = true;
  }

  chapters(): Key[] {
    const D = this.D;
    // a chapter with nothing true to say is left out: no footage, no hours, or trims too few or
    // too unknown to average while plenty of clips were trimmed
    const cut = D.hasTrims || D.trimmed < Math.max(1, D.count * 0.1);
    const all: Array<Key | false> = [D.hasFootage && "stack", D.hasHours && "clock", D.friends.length >= 2 && "orbit", cut && "cut", (D.watch?.sessions ?? 0) >= 3 && "repeat", "chart", "card"];
    return all.filter((k): k is Key => Boolean(k));
  }

  /** where a chapter picks up when revisited: past any question already answered */
  resume(key: Key): number {
    const r = this.state.rev;
    switch (key) {
      case "stack":
        return r.end ? 3 : r.stack ? 1 : 0;
      case "clock":
        return r.hour ? (this.D.hasGames ? 2 : 1) : 0;
      case "orbit":
        return r.who ? 1 : 0;
      case "cut":
        return r.cut ? 1 : 0;
      case "repeat":
        return r.rw ? 2 : 0;
      default:
        return 0;
    }
  }

  /** something is left in this chapter, an open question or a step not seen yet, so "Next"
   * reads "Skip" */
  left(): boolean {
    const key = this.curKey();
    if (!key) return false;
    const last: Record<Key, number> = { stack: 3, clock: this.D.hasGames ? 2 : 1, orbit: 1, cut: this.D.hasTrims ? 1 : 0, repeat: 2, chart: 0, card: 0 };
    return this.state.step < last[key];
  }

  curKey(): Key | null {
    return this.state.intro ? null : this.chapters()[this.state.ci] ?? null;
  }

  go(ci: number, step?: number) {
    const key = this.chapters()[ci];
    const s = step ?? this.resume(key);
    // forward deals the next card, back flicks one away; from the intro the open already sounded
    const from = this.state.intro ? -1 : this.state.ci;
    if (from >= 0) au.play(ci > from ? "next" : ci < from ? "card-flick" : "rotate-small", { duck: "ui" });
    au.music("menu");
    this.vidRef.current?.pause();
    clearTimeout(this.vt);
    this.setState({ ci, step: s, sel: null, hover: null, toast: null });
    this.stepT = performance.now();
    this.onEnter(key, s);
  }

  setStep(s: number) {
    this.setState({ step: s, hg: null });
    this.stepT = performance.now();
    const key = this.curKey();
    if (key) this.onEnter(key, s);
  }

  rv(k: keyof State["rev"], extra?: Partial<State>) {
    this.revd.add(k);
    this.setState((s) => ({ ...s, rev: { ...s.rev, [k]: true }, ...(extra || {}) }));
  }

  onEnter(key: Key, s: number) {
    au.cancel("step");
    au.cancel("charge", 0.4);
    if (key !== "repeat" || s !== 1) {
      clearTimeout(this.vt);
      this.vidRef.current?.pause();
      au.releaseMusic(1.5);
    }
    if (key === "repeat" && s === 1) this.playClip();
    this.dropPack();
    if (key === "card") {
      this.cs0 = { x: 0.5, y: 0.5, o: 0.6, vx: 0, vy: 0, vo: 0, f: 180, vf: 0, ft: 180, hov: false, hx: 0.5, hy: 0.5, ph: "pack", ready: false, mix: 0 };
      this.sparks = [];
      this.glints = [];
      this.artDone = false;
      this.revealed = false;
      this.lastTip = null;
      this.lastFlash = 0;
      this.hinted = false;
      clearTimeout(this.hintT);
      this.setState({ cardPh: "pack", packPh: "enter", flipHint: false });
      void this.inlineCardImages();
      void window.clips
        .recapShareState(this.D.year)
        .then((s) => !this.dead && this.setState({ shareUrl: s?.url ?? null }))
        .catch(() => {});
    }
    this.score(key, s);
  }

  /** a step's sounds on the same clock as its animations, scheduled up front and dropped by the
   * next onEnter if the user moves on first */
  score(key: Key, s: number) {
    const D = this.D;
    const t0 = this.stepT;
    const at = (cue: au.Cue, t: number, o: au.PlayOpts = {}) => au.play(cue, { ...o, at: t - (performance.now() - t0) / 1000, group: "step" });
    // right and close answers get a jingle that takes the music out for a moment and a sparkle,
    // spot on the crown on top; not far a lone sparkle, way off a soft shrug. waits a tick for the
    // answer rv() just set
    const verdict = (k: keyof State["rev"], t: number) =>
      window.setTimeout(() => {
        if (this.dead || this.stepT !== t0 || !this.revd.has(k)) return;
        const tier = this.near(k)?.tier;
        if (tier === "spot" || tier === "close") {
          at(Math.random() < 0.5 ? "jingle-rare-a" : "jingle-rare-c", t, { duck: "jingle" });
          at(tier === "spot" ? "stinger-crown" : "stinger-rhombus", t + 0.05, { gain: tier === "spot" ? 0.7 : 0.5 });
          this.pulseAt = performance.now() + t * 1000;
        } else if (tier === "near") at("stinger-rhombus", t, { gain: 0.55 });
        else at("nope", t, { gain: 0.8 });
      }, 0);
    const pops = (t: number, n: number) => {
      for (let i = 0; i < n; i++) at("tick", t + i * 0.08, { bus: "ui", gain: 0.45, rate: Math.pow(2, i / 6) });
    };
    if (key === "stack") {
      if (s === 1) {
        at("list-ef", 0.15, { gain: 0.8 });
        at("stinger-star", 1.1, { gain: 0.6 });
        verdict("stack", 1.4);
      } else if (s === 2) {
        // out to space
        at("immersive-start", 0, { gain: 0.9 });
        at("riser-10", 0.3, { gain: 0.7 });
        at("card-slide", 2.6);
      } else if (s === 3) {
        this.prevH = 0;
        at("list-ef", 0.15, { gain: 0.8 });
        at(D.endH >= 1e5 ? "stinger-crown" : "stinger-star", 1.4, { gain: 0.7 });
        verdict("end", 1.7);
      }
    } else if (key === "clock") {
      if (s === 1) {
        at("rotate", 0.2, { gain: 0.8 });
        // the hand plays the day: a tick per hour with clips, louder the busier it was
        const max = Math.max(1, ...D.byHour);
        D.byHour.forEach((n, h) => {
          if (n > 0) at("tick", 0.2 + ((h + 0.5) / 24) * 2.6, { bus: "ui", gain: 0.25 + 0.55 * Math.sqrt(n / max), rate: 0.85 + 0.45 * (h / 23), pan: Math.sin((h / 24) * Math.PI * 2) * 0.5 });
        });
        verdict("hour", 2.5);
        at("stinger-star", 2.9, { gain: 0.45 });
      } else if (s === 2) {
        // its shimmer peaks with the end of the recolour wave
        at("riser-1", 0.1, { gain: 0.6 });
      }
    } else if (key === "orbit") {
      if (s === 0) pops(0.2, Math.min(4, D.friends.length));
      else if (s === 1) {
        for (let i = 0; i < Math.min(5, D.friends.length); i++) at("rotate-small", 0.1 + 0.12 * i, { gain: 0.45, pan: i % 2 ? 0.35 : -0.35 });
        at("stinger-star", 0.4, { gain: 0.5 });
        verdict("who", 0.65);
      }
    } else if (key === "cut") {
      if (s === 1 || !D.hasTrims) {
        // a roll with the bars, every fourth one
        for (let i = 0; i < 15; i++) at("tick", 0.1 + i * 0.048, { bus: "ui", gain: 0.35, rate: 0.85 + i * 0.035 });
        at("card-shine", 0.9, { gain: 0.35 });
        if (D.hasTrims) verdict("cut", 1.3);
        else at("stinger-rhombus", 1.3, { gain: 0.6 });
      }
    } else if (key === "repeat") {
      if (s === 0) pops(0.3, 3);
      else if (s === 1) at("push-start", 0, { gain: 0.8 });
      else if (s === 2) {
        at("stinger-star", 0.2, { gain: 0.6 });
        verdict("rw", 0.7);
      }
    } else if (key === "chart") {
      // every star glints as its line reaches it, climbing, panned to where it sits, and the chart
      // closes with stars falling all over
      const n = Math.min(CHART.length, this.chartStats().length);
      const t0 = this.stepT;
      const when = (t: number) => t - (performance.now() - t0) / 1000;
      for (let i = 0; i < n; i++) au.sparkle(starHz(i), { at: when(CHART_T0 + i * CHART_DT), pan: (CHART[i][0] - 1200) / 900, group: "step" });
      const end = CHART_T0 + n * CHART_DT + 0.12;
      au.starfall([0, 1, 2, 3, 4, 5, 6, 7].map(starHz), { at: when(end), gain: 0.7, group: "step" });
      at("stinger-star", end + 0.02, { gain: 0.5 });
      at("card-shine", end + 0.1, { gain: 0.35 });
    }
  }

  open = () => {
    if (this.state.introOut || this.D.count === 0) return;
    au.unlock();
    au.cancel("intro", 0.3);
    au.play("pack-select");
    au.play("immersive-start", { gain: 0.9 });
    // the music comes out from behind the wall as the title flies past
    au.musicOpen(1, 1.6);
    this.outT = performance.now();
    this.setState({ introOut: true });
    this.ot = window.setTimeout(() => {
      this.chapT0 = performance.now();
      this.setState({ intro: false, introOut: false });
      this.go(0);
    }, 900);
  };

  restart() {
    this.revd.clear();
    au.play("fadeout");
    this.setState({ intro: true, introOut: false, g: {}, rev: {}, ci: 0, step: 0 });
    void this.prepIntro();
  }

  next = () => {
    const st = this.state;
    if (st.intro) {
      this.open();
      return;
    }
    if (st.ci < this.chapters().length - 1) this.go(st.ci + 1);
    else this.restart();
  };

  prev = () => {
    const st = this.state;
    if (st.intro) return;
    if (st.ci > 0) this.go(st.ci - 1);
    else {
      au.play("card-flick");
      this.setState({ intro: true, introOut: false }, () => void this.prepIntro());
    }
  };

  /** pointer position in stage pixels */
  cPt(e: RMouseEvent<Element>): [number, number] {
    const r = (this.stgRef.current ?? e.currentTarget).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 1920, ((e.clientY - r.top) / r.height) * 1080];
  }

  introMove = (e: RPointerEvent<HTMLDivElement>) => {
    const [x, y] = this.cPt(e);
    this.mx = x;
    this.my = y;
  };
  introLeave = () => {
    this.mx = null;
  };
  /** a click near a passing shooting star catches it */
  rootDown = (e: RPointerEvent<HTMLDivElement>) => {
    au.unlock();
    const s = this.shootPos;
    if (!s || !this.skyShoot) return;
    const [x, y] = this.cPt(e);
    // near its head or anywhere along its tail
    const vx = s.ex - s.x;
    const vy = s.ey - s.y;
    const q = cl(((x - s.x) * vx + (y - s.y) * vy) / (vx * vx + vy * vy || 1));
    if (Math.hypot(x - (s.x + vx * q), y - (s.y + vy * q)) > 55) return;
    this.skyShoot = null;
    this.shootPos = null;
    this.caught.push({ x: s.x, y: s.y, t0: performance.now() });
    au.play("stinger-star", { gain: 0.7 });
    au.play("card-shine", { at: 0.05, gain: 0.5 });
  };

  /** the sky leans away from the pointer on every page */
  rootMove = (e: RPointerEvent<HTMLDivElement>) => {
    const [x, y] = this.cPt(e);
    this.mx = x;
    this.my = y;
    if (this.curKey() === "chart") this.chartMove(x, y);
    else if (this.state.hot >= 0) this.setState({ hot: -1 });
  };
  rootLeave = () => {
    this.mx = null;
    if (this.state.hot >= 0) this.setState({ hot: -1 });
  };

  // stack
  stActive(): boolean {
    const S = this.state.step;
    const el = (performance.now() - this.stepT) / 1000;
    return this.curKey() === "stack" && (S === 0 || (S === 2 && el > 3));
  }
  stDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!this.stActive()) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    this.stDrag = true;
    // grabbed: it gives a little under the hand
    this.blk.v -= 380;
    this.stSet(e);
  };
  stMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (this.stDrag) this.stSet(e);
  };
  stUp = () => {
    // let go: a plop that it wobbles out of
    if (this.stDrag) this.blk.v -= 420;
    this.stDrag = false;
  };
  stSet(e: RPointerEvent<HTMLCanvasElement>) {
    const [, y] = this.cPt(e);
    const S = this.state.step;
    const V = S === 0 ? this.VA : this.VB;
    const a = cl((900 - y) / (640 / V), V * 0.01, V * 0.97);
    // a ratchet: a click per 24th of the range, higher the taller
    const b = Math.floor((a / V) * 24);
    if (b !== this.stB) {
      this.stB = b;
      au.playThrottled("drag", 28, "tick", { bus: "ui", gain: 0.45, rate: 0.8 + 0.7 * (a / V) });
    }
    this.touched.stack = true;
    this.setState((s) => ({ g: { ...s.g, [S === 0 ? "stack" : "end"]: a } }));
  }
  lockA = () => {
    const g = this.state.g;
    this.rv("stack", { g: { ...g, stack: g.stack ?? this.refA.h * 0.5 } });
    au.play("push-end", { gain: 0.6 });
    this.blk.v += 380;
    this.setStep(1);
  };
  toEnd = () => {
    this.touched.stack = false;
    this.stB = -1;
    this.setStep(2);
  };
  lockB = () => {
    const g = this.state.g;
    this.rv("end", { g: { ...g, end: g.end ?? this.refB.h * 0.5 } });
    au.play("push-end", { gain: 0.6 });
    this.setStep(3);
  };

  // clock
  clDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (this.state.step !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    this.cDrag = true;
    this.clSet(e);
  };
  clMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (this.cDrag) {
      this.clSet(e);
      return;
    }
    const D = this.D;
    const S = this.state.step;
    const el = (performance.now() - this.stepT) / 1000;
    if (!D.hasGames || S !== 2 || el < 1) return;
    const [x, y] = this.cPt(e);
    const K = this.ck;
    let hg: number | null = null;
    let bd = Math.pow(K.pitch * 0.9, 2);
    for (const b of K.blocks) {
      const dx = b.x - x;
      const dy = b.y - y;
      const q = dx * dx + dy * dy;
      if (q < bd) {
        bd = q;
        hg = b.g;
      }
    }
    if (hg !== this.state.hg) {
      if (hg != null) au.hover(hg % 8);
      this.setState({ hg });
    }
  };
  clLeave = () => {
    this.cDrag = false;
    if (this.state.hg != null) this.setState({ hg: null });
  };
  clUp = () => {
    this.cDrag = false;
  };
  clSet(e: RPointerEvent<HTMLCanvasElement>) {
    const [x, y] = this.cPt(e);
    const K = this.ck;
    const dx = x - K.CX;
    const dy = y - K.CY;
    const r = Math.hypot(dx, dy);
    if (r < 40) return;
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    const h12 = Math.floor((a / (Math.PI * 2)) * 12) % 12;
    const h = r < (K.RI + K.RO) / 2 ? h12 : h12 + 12;
    if (h !== this.state.g.hour) {
      au.playThrottled("drag", 20, "tick", { bus: "ui", gain: 0.5, rate: 0.85 + 0.5 * (h / 23), pan: Math.sin(a) * 0.4 });
      this.setState((s) => ({ g: { ...s.g, hour: h } }));
    }
  }
  lockHour = () => {
    if (this.state.g.hour == null) return;
    this.rv("hour");
    au.play("push-end", { gain: 0.6 });
    this.setStep(1);
  };
  toMonths = () => {
    au.play("next", { gain: 0.7 });
    this.setStep(2);
  };

  hovG() {
    const D = this.D;
    const i = this.state.hg;
    const none = { on: false, off: D.hasGames && this.state.step === 2, srcs: [] as string[], name: "", n: "" };
    if (i == null || !this.ck) return none;
    const bs = this.ck.blocks.filter((b) => b.g === i);
    if (!bs.length) return none;
    const hc = Array(24).fill(0);
    bs.forEach((b) => hc[Math.floor(b.h)]++);
    const ph = hc.indexOf(Math.max(...hc));
    const G = i >= 0 && i < 99 ? D.games[i] : null;
    return {
      on: true,
      off: false,
      srcs: G ? G.srcs : [starUrl],
      name: G ? G.name : i === 99 ? "Other games" : "No game detected",
      n: `${plural(bs.length, "clip")} · peaks at ${pad(ph)}:00`,
    };
  }

  // orbit
  orbitHit(e: RMouseEvent<HTMLCanvasElement>): string | null {
    const [x, y] = this.cPt(e);
    let hit: string | null = null;
    let z = -9;
    for (const f of this.orbF) {
      if (f.k > 0.5 && Math.hypot(x - f.x, y - f.y) < f.sz + 6 && f.z > z) {
        hit = f.id;
        z = f.z;
      }
    }
    return hit;
  }
  orbitMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (this.state.step !== 1) return;
    const h = this.orbitHit(e);
    if (h !== this.state.hover) {
      if (h) au.hover(Math.max(0, this.D.friends.findIndex((f) => f.id === h)));
      this.setState({ hover: h });
    }
  };
  orbitLeave = () => {
    if (this.state.hover) this.setState({ hover: null });
  };
  orbitClick = (e: RMouseEvent<HTMLCanvasElement>) => {
    if (this.state.step !== 1) return;
    const h = this.orbitHit(e);
    if (h && h !== this.state.sel) au.play("card-open", { gain: 0.8 });
    if (h) this.setState({ sel: h });
  };

  // cut
  cutF(e: RPointerEvent<HTMLDivElement>): number {
    const r = this.trackRef.current!.getBoundingClientRect();
    return cl((e.clientX - r.left) / r.width);
  }
  cutDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (this.state.step !== 0 || !this.D.hasTrims) return;
    const f = this.cutF(e);
    const h = Math.abs(f - this.state.cs) < Math.abs(f - this.state.ce) ? "s" : "e";
    e.currentTarget.setPointerCapture?.(e.pointerId);
    this.setState({ drag: h });
    this.cutSet(h, f);
  };
  cutMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (this.state.drag) this.cutSet(this.state.drag, this.cutF(e));
  };
  cutUp = () => this.setState({ drag: null });
  cutSet(h: "s" | "e", f: number) {
    f = Math.round(f * 60) / 60;
    // a click per second the handle moves
    const was = h === "s" ? this.state.cs : this.state.ce;
    if (Math.abs(f - was) > 1e-6) au.playThrottled("drag", 20, "tick", { bus: "ui", gain: 0.45, rate: 0.8 + 0.6 * f, pan: (f - 0.5) * 0.8 });
    if (h === "s") this.setState((s) => ({ cs: Math.min(f, s.ce - 2 / 60) }));
    else this.setState((s) => ({ ce: Math.max(f, s.cs + 2 / 60) }));
  }
  lockCut = () => {
    this.rv("cut");
    au.play("cut-snap");
    au.play("cut-3", { at: 0.04, gain: 0.8 });
    this.setStep(1);
  };
  iou(): number {
    const { cs, ce } = this.state;
    const a = this.D.trims.s;
    const b = this.D.trims.e;
    const i = Math.max(0, Math.min(ce, b) - Math.max(cs, a));
    return i / (Math.max(ce, b) - Math.min(cs, a));
  }

  // repeat: plays the clip's trim, or its last 25 s
  playClip() {
    this.setState({ vph: "intro", vp: 0 });
    clearTimeout(this.vt);
    this.vt = window.setTimeout(() => {
      // nothing to play, straight to the answer after the title
      if (this.state.vbad) return this.vidEnded();
      this.setState({ vph: "play" });
      au.play("immersive-start", { gain: 0.8 });
      // the clip's own sound takes over, the music waits underneath
      if (!this.state.muted) au.holdMusic(0.08, 0.6);
      const v = this.vidRef.current;
      const W = this.D.watch;
      if (!v || !W) return;
      v.currentTime = W.start;
      v.muted = this.state.muted;
      this.setState({ paused: false });
      v.play().catch(() => {
        v.muted = true;
        this.setState({ muted: true });
        v.play().catch(() => {});
      });
    }, 2300);
  }
  vidErr = () => {
    this.setState({ vbad: true });
    if (this.state.vph === "play") this.vidEnded();
  };
  vidEnded = () => {
    if (this.curKey() === "repeat" && this.state.step === 1) {
      au.play("immersive-end", { gain: 0.8 });
      au.releaseMusic(2);
      this.setStep(2);
    }
  };
  vidTime = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const W = this.D.watch;
    if (!W || this.state.vph !== "play") return;
    this.setState({ vp: cl((v.currentTime - W.start) / Math.max(0.1, W.end - W.start)) });
    if (v.currentTime >= W.end - 0.05) {
      v.pause();
      this.vidEnded();
    }
  };
  toggleMute = (e: RMouseEvent) => {
    e.stopPropagation();
    const m = !this.state.muted;
    this.setState({ muted: m });
    const v = this.vidRef.current;
    if (v) v.muted = m;
    if (this.state.vph === "play") {
      if (m) au.releaseMusic(0.8);
      else au.holdMusic(0.08, 0.4);
    }
  };
  togglePlay = () => {
    const v = this.vidRef.current;
    if (!v || this.state.vph !== "play") return;
    const p = !v.paused;
    if (p) v.pause();
    else void v.play().catch(() => {});
    this.setState({ paused: p });
    au.play("tick", { bus: "ui", gain: 0.5, rate: p ? 0.85 : 1.1 });
    // paused, the music comes back up under the still frame
    if (!this.state.muted) {
      if (p) au.releaseMusic(0.8);
      else au.holdMusic(0.08, 0.4);
    }
  };
  skipClip = () => {
    this.vidRef.current?.pause();
    this.vidEnded();
  };
  /** click or drag along the bar to scrub */
  seekClip = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.type === "pointermove" && !e.buttons) return;
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture?.(e.pointerId);
    const v = this.vidRef.current;
    const W = this.D.watch;
    if (!v || !W) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = cl((e.clientX - r.left) / r.width, 0, 0.995);
    v.currentTime = W.start + f * (W.end - W.start);
    this.setState({ vp: f });
  };
  replayClip = () => {
    au.play("rotate-small");
    this.setStep(1);
  };

  // card
  sPt(e: RPointerEvent<HTMLDivElement>): [number, number] {
    const r = this.stageRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 600, ((e.clientY - r.top) / r.height) * 860];
  }
  /** stage px of a pointer on the card stage, which sits at 660,92 */
  stagePt(e: RPointerEvent<HTMLDivElement>): [number, number] {
    const [x, y] = this.sPt(e);
    return [660 + x, 92 + y];
  }
  cardDown = (e: RPointerEvent<HTMLDivElement>) => {
    au.unlock();
    if (!this.pack || this.cs0?.ph !== "pack") return;
    const [x, y] = this.stagePt(e);
    if (this.pack.down(x, y)) e.currentTarget.setPointerCapture?.(e.pointerId);
    else if (this.pack.phase === "idle") {
      au.tap();
      this.pack.poke(x, y);
    }
  };
  cardMove = (e: RPointerEvent<HTMLDivElement>) => {
    const c = this.cs0;
    if (!c) return;
    const [x, y] = this.sPt(e);
    c.hx = cl(x / 600);
    c.hy = cl(y / 860);
    c.hov = true;
    if (this.pack && c.ph === "pack") this.pack.move(660 + x, 92 + y);
  };
  cardUp = () => {
    this.pack?.up();
  };
  cardLeave = () => {
    if (this.cs0) this.cs0.hov = false;
  };
  ensurePack() {
    if (this.pack || this.packTried || this.cs0?.ph !== "pack") return;
    const b = this.packBackCv.current;
    const f = this.packFrontCv.current;
    if (!b || !f || f.dataset.gen !== String(this.packGen)) return;
    this.packTried = true;
    try {
      const pack = new PackScene(b, f, {
        phase: (packPh) => {
          const was = this.state.packPh;
          // the entrance: a whoosh as it rises, the spin's own sweep, the chime when it lands
          if (packPh === "enter") {
            au.play("pack-in");
            au.play("rotate", { at: 0.12, gain: 0.55 });
          }
          else if (packPh === "idle" && !this.hinted) {
            // the guide chimes once, with the first spark along the line
            this.hinted = true;
            au.play("guide", { at: 1.6, gain: 0.7, group: "step" });
          } else if (packPh === "trace") {
            au.cutStart();
            // the room goes quiet while you cut, like it goes dark
            au.holdMusic(0.45, 2);
          } else if (packPh === "armed") au.play("push-start", { group: "charge", gain: 0.9 });
          if (packPh === "idle" && (was === "trace" || was === "armed")) {
            au.cancel("charge", 0.4);
            au.releaseMusic(1.5);
          }
          this.setState({ packPh });
        },
        done: () => this.packDone(),
        sound: (n) => {
          if (n === "rip") {
            au.cancel("charge", 0.4);
            au.play("cut-snap");
            au.play("open-heavy", { at: 0.02 });
            au.play("open-rare", { at: 0.05, gain: 0.8 });
            au.play("whiteout", { at: 0.03, gain: 0.5 });
            // duck fast, recover slow: the study takes ten seconds to bring the music back
            au.releaseMusic(10);
          } else if (n === "cardOut") {
            au.play("card-slide-rare", { gain: 0.85 });
            au.play("card-slide");
          } else if (n === "hop") {
            au.play("pack-select", { gain: 0.55 });
            au.play("card-flick", { at: 0.08, gain: 0.6 });
          } else if (n === "hopLand") {
            au.tap();
          } else if (n === "land") {
            au.play("stinger-crown", { gain: 0.8 });
            au.play("card-shine", { at: 0.04, gain: 0.45 });
            // glints on its corners first, then along its edges, following the light across it
            const t0 = performance.now();
            const spots: Array<[number, number, number]> = [
              [668, 100, 0],
              [1252, 944, 380],
              [1252, 100, 160],
              [668, 944, 260],
            ];
            for (let i = 0; i < 8; i++) {
              const u = Math.random();
              const side = i % 4;
              spots.push(side === 0 ? [668 + u * 584, 100, 80 + u * 300] : side === 1 ? [1252, 100 + u * 844, 120 + u * 340] : side === 2 ? [668 + u * 584, 944, 200 + u * 300] : [668, 100 + u * 844, 60 + u * 340]);
            }
            for (const [x, y, d] of spots) this.glints.push({ x, y, t0: t0 + d, life: 520 + Math.random() * 260, r: 14 + Math.random() * 16, rot: Math.random() * 0.6 });
          } else au.play("card-shine", { gain: 0.75 });
        },
        cut: (progress) => au.cut(progress),
      });
      this.pack = pack;
      this.packK = this.state.k;
      pack.init(this.D.year, cornersUrl, starUrl, this.state.k).catch(() => this.packDone());
    } catch {
      // no webgl: skip the pack, the card is just there
      this.packDone();
    }
  }
  packDone() {
    const c = this.cs0;
    if (!c || c.ph !== "pack") return;
    c.ph = "open";
    c.ready = true;
    c.vo += 0.3;
    if (!this.pack) c.mix = 1;
    this.setState({ cardPh: "back" });
    clearTimeout(this.hintT);
    this.hintT = window.setTimeout(() => !this.dead && !this.revealed && this.setState({ flipHint: true }), 3500);
  }
  dropPack() {
    this.pack?.dispose();
    this.pack = null;
    this.packTried = false;
    this.packGen++;
  }
  cardClick = () => {
    const c = this.cs0;
    if (!c || !c.ready) return;
    c.ft = c.ft === 0 ? 180 : 0;
    if (c.ft === 0 && !this.revealed) {
      // the reveal is the rarest pull there is; the stinger on top goes by how many guesses were right
      const asked = Object.keys(this.state.rev) as Array<keyof State["rev"]>;
      const r = asked.length ? asked.filter((k) => this.correct(k)).length / asked.length : 0.5;
      au.play("rotate");
      au.play("card-open-rare", { at: 0.1 });
      au.play("jingle-rare-e", { at: 0.2, duck: "jingle" });
      au.play(r >= 1 ? "stinger-crown" : r >= 0.5 ? "stinger-star" : "stinger-rhombus", { at: 0.35, gain: 0.7 });
    } else au.play("rotate-small");
    // five flips in a moment: the card does three whole turns
    const tn = performance.now();
    this.flips = [...this.flips.filter((t) => tn - t < 2600), tn];
    if (this.flips.length >= 5 && this.revealed && !this.spinT0) {
      this.flips = [];
      this.spinT0 = tn;
      au.play("rotate", { gain: 0.8 });
      au.play("card-shine", { at: 0.3, gain: 0.5 });
      au.play("stinger-crown", { at: 1.25, gain: 0.7 });
      for (const [x, y, d] of [[715, 150, 1250], [1205, 895, 1330], [1205, 150, 1410], [715, 895, 1490]] as const) this.glints.push({ x, y, t0: tn + d, life: 600, r: 22, rot: 0.3 });
    }
    if (c.ft === 0) {
      this.revealed = true;
      // seen through: once the recap closes, its rail button flies into settings
      markRecapFinished();
    }
    clearTimeout(this.hintT);
    this.setState({ cardPh: c.ft === 0 ? "front" : "back", flipHint: false });
  };
  toastIt(t: string, ms = 2600) {
    this.setState({ toast: t });
    clearTimeout(this.tt);
    this.tt = window.setTimeout(() => this.setState({ toast: null }), ms);
  }

  cardChips() {
    return chipsOf(this.D, this.D.friends[0] ?? null);
  }

  /** the chip pictures as data urls before anyone saves the card; the first source that loads wins */
  async inlineCardImages() {
    const toPath = (src: string) => (src.startsWith("file:///") ? decodeURIComponent(src.slice(8)) : src);
    const chips = this.cardChips().filter((c) => c.srcs?.length);
    const srcs = [...new Set(chips.flatMap((c) => c.srcs!.map(toPath)))];
    if (!srcs.length) return;
    const got = await window.clips.recapInlineImages(srcs).catch(() => ({}) as Record<string, string | null>);
    if (this.dead) return;
    const inl: Record<string, string> = {};
    for (const c of chips) {
      const hit = c.srcs!.map((src) => got[toPath(src)]).find(Boolean);
      if (hit) inl[c.srcs!.join("|")] = hit;
    }
    this.setState({ inl });
  }

  async cardPng(): Promise<string | null> {
    const n = this.frontRef.current;
    if (!n) return null;
    const { renderCard } = await import("./cardExport");
    return renderCard(n);
  }

  doSave = async () => {
    const D = this.D;
    this.toastIt("Rendering…", 20000);
    try {
      const url = await this.cardPng();
      if (!url) throw new Error("no card");
      const res = await window.clips.saveRecapCard(url, `setsu-recap-${D.year}${D.owner.handle ? "-" + D.owner.handle : ""}.png`);
      if (res.saved) {
        au.play("toast");
        this.toastIt("Saved · 1560 × 2184 PNG");
      } else this.setState({ toast: null });
    } catch {
      au.play("nope");
      this.toastIt("Export failed. Try again.");
    }
  };

  doCopy = async () => {
    this.toastIt("Rendering…", 20000);
    try {
      const url = await this.cardPng();
      if (!url) throw new Error("no card");
      await window.clips.copyRecapCard(url);
      au.play("toast");
      this.toastIt("Copied, paste it anywhere");
    } catch {
      au.play("nope");
      this.toastIt("Copy failed. Try again.");
    }
  };

  /** a link to the card and the year behind it, copied straight away. no account needed; sharing
   * again keeps the same link */
  doShare = async () => {
    if (this.state.sharing) return;
    const D = this.D;
    this.setState({ sharing: true });
    try {
      const card = await this.cardPng();
      if (!card) throw new Error("");
      const guesses: Partial<Record<ShareQuestion, ShareTier>> = {};
      for (const k of Object.keys(this.state.rev) as ShareQuestion[]) {
        const t = this.near(k)?.tier;
        if (t) guesses[k] = t;
      }
      const payload = await sharePayloadWithPics(D, { friends: this.state.crew, guesses }, (s) => window.clips.recapInlineImages(s));
      const res = await window.clips.shareRecap({ year: D.year, payload, card });
      if (!res.success || !res.url) throw new Error(res.status === 429 ? "Too many shares this hour. Try again later." : res.error || "");
      await navigator.clipboard.writeText(res.url).catch(() => {});
      au.play("toast");
      this.setState({ shareUrl: res.url });
      this.toastIt("Link copied, paste it anywhere");
    } catch (e) {
      au.play("nope");
      this.toastIt(e instanceof Error && e.message ? e.message : "Sharing failed. Try again.", 4000);
    } finally {
      this.setState({ sharing: false });
    }
  };
  copyLink = async () => {
    const u = this.state.shareUrl;
    if (!u) return;
    await navigator.clipboard.writeText(u).catch(() => {});
    au.play("toast");
    this.toastIt("Link copied");
  };
  setCrew = (on: boolean) => {
    // already shared: the page follows straight away, same link
    this.setState({ crew: on }, () => this.state.shareUrl && void this.doShare());
  };
  unshare = async () => {
    const res = await window.clips.unshareRecap(this.D.year).catch(() => ({ success: false }) as { success: boolean; error?: string });
    if (res.success) {
      au.play("card-flick");
      this.setState({ shareUrl: null });
      this.toastIt("Link taken down");
    } else {
      au.play("nope");
      this.toastIt(res.error || "Couldn't take it down. Try again.", 4000);
    }
  };

  /** how close a guess came, null when it wasn't made */
  near(k: keyof State["rev"]): Near | null {
    const D = this.D;
    const st = this.state;
    const g = st.g;
    // heights are magnitudes, so the meter is on a log scale: twice too high or half too low both
    // read 50%, four times off reads 0
    const rel = (gv: number | undefined, a: number, said: string): Near | null => {
      if (gv == null || !a || gv <= 0) return null;
      const e = Math.abs(gv - a) / a;
      return { tier: tierOf(e, 0.05, 0.2, 0.5), acc: Math.max(0, 1 - Math.abs(Math.log(gv / a)) / Math.log(4)), pct: true, said, off: e < 0.005 ? "Dead on." : `${gv < a ? "Under" : "Over"} by ${pct(e)}.` };
    };
    switch (k) {
      case "stack":
        return rel(g.stack, D.stackH, `You said ${fmtAlt(g.stack ?? 0)}.`);
      case "end":
        return rel(g.end, D.endH, `You said ${fmtAlt(g.end ?? 0)}.`);
      case "hour": {
        if (g.hour == null) return null;
        const d0 = Math.abs(g.hour - D.peak);
        const d = Math.min(d0, 24 - d0);
        return { tier: tierOf(d, 0, 1, 3), acc: 1 - d / 12, pct: false, big: d ? `±${d} h` : undefined, said: `You said ${pad(g.hour)}:00.`, off: d ? `${d} hour${d > 1 ? "s" : ""} off.` : "That's the one." };
      }
      case "who": {
        const F = D.friends;
        const i = F.findIndex((f) => f.id === g.who);
        if (i < 0) return null;
        const f = F[i];
        // friends are sorted by clips, so a tie ranks where its count first shows up
        const r = F.findIndex((x) => x.clips === f.clips);
        const acc = f.clips / F[0].clips;
        // a near tie for first is as good as first
        return { tier: r === 0 ? "spot" : acc >= 0.85 ? "close" : acc >= 0.6 ? "near" : "off", acc, pct: false, big: `#${r + 1}`, said: `You picked ${f.name}.`, off: r === 0 ? `${plural(f.clips, "clip")} together.` : `Your #${r + 1}, ${plural(f.clips, "clip")} to ${fmtN(F[0].clips)}.` };
      }
      case "cut": {
        if (!D.hasTrims) return null;
        const iou = this.iou();
        return { tier: tierOf(1 - iou, 0.15, 0.5, 0.7), acc: iou, pct: true, said: `You kept ${fmtS(st.cs)} to ${fmtS(st.ce)}.`, off: `${pct(iou)} overlap.` };
      }
      case "rw": {
        const n = D.watch?.sessions ?? 0;
        if (g.rw == null || !n) return null;
        const e = Math.abs(g.rw - n) / n;
        return { tier: tierOf(e, 0, 0.2, 0.5), acc: Math.max(0, 1 - e), pct: false, said: `You said ${g.rw}×.`, off: g.rw === n ? "Exactly." : `It was ${n}×.` };
      }
    }
    return null;
  }

  correct(k: keyof State["rev"]): boolean {
    const t = this.near(k)?.tier;
    return t === "spot" || t === "close";
  }

  /** the answer's card: tier, accuracy counting up, a meter and the numbers; right ones burst */
  verdictEl(k: keyof State["rev"], d: number) {
    const v = this.near(k);
    if (!v) return null;
    const win = v.tier === "spot" || v.tier === "close";
    const vars = { ["--d" as string]: d + "s", ["--acc" as string]: Math.round(v.acc * 100) };
    return (
      <div className={`rc-vd rc-vd-${v.tier}`} style={{ ...pop(d), ...vars }}>
        {win ? (
          <div className="rc-vd-burst">
            {BURST.slice(0, v.tier === "spot" ? 22 : 12).map((b, i) => (
              <i key={i} className={"c" + b.c} style={{ ["--x" as string]: b.x.toFixed(0) + "px", ["--y" as string]: b.y.toFixed(0) + "px", ["--s" as string]: b.s.toFixed(2) }} />
            ))}
          </div>
        ) : null}
        <div className="rc-vd-top">
          <span className="rc-vd-tier">{TIER[v.tier]}</span>
          {v.pct ? <span className="rc-vd-acc" /> : v.big ? <span className="rc-vd-big">{v.big}</span> : null}
        </div>
        {v.pct ? (
          <div className="rc-vd-meter">
            <div />
          </div>
        ) : null}
        <span className="rc-vd-line">
          {v.said} {v.off}
        </span>
      </div>
    );
  }

  frame(now: number) {
    const st = this.state;
    if (st.intro) {
      const cv = this.introCv.current;
      if (cv) this.drawIntro(this.fit(cv), now);
      this.drawSky(now);
      return;
    }
    this.drawSky(now);
    const key = this.curKey();
    const el = (now - this.stepT) / 1000;
    const cv = key === "stack" ? this.stackCv.current : key === "clock" ? this.clockCv.current : key === "orbit" ? this.orbitCv.current : null;
    if (cv) {
      const ctx = this.fit(cv, key === "stack");
      if (key === "stack") this.drawStack(ctx, st.step, el);
      else if (key === "clock") this.drawClock(ctx, st.step, el);
      else this.drawOrbit(ctx, st.step, el, now / 1000);
    }
    if (key === "card") this.cardFrame(now);
  }

  /** where each chapter's glow sits in the sky, lerped between chapters */
  static GLOWS: Record<Key | "intro", [number, number, number, number, number, number, number]> = {
    intro: [960, 420, 900, 90, 30, 170, 0.12],
    stack: [1500, 980, 900, 120, 60, 230, 0.22],
    clock: [1240, 540, 700, 200, 30, 230, 0.16],
    orbit: [960, 540, 800, 165, 6, 230, 0.18],
    cut: [960, 1100, 1000, 150, 20, 200, 0.2],
    repeat: [960, 540, 900, 60, 20, 120, 0.08],
    chart: [1300, 480, 900, 120, 50, 220, 0.2],
    card: [960, 500, 900, 140, 20, 210, 0.26],
  };

  /** the sky behind every page, full window: base, nebula, a chapter's glow, a galaxy band, stars
   * drifting slowly and leaning away from the pointer, the odd shooting star. in the intro it
   * also does the warp, so the stars that streak past on open are the ones the chapters drift in */
  drawSky(now: number) {
    const cv = this.skyCv.current;
    const root = this.rootRef.current;
    if (!cv || !root || !this.skyStars.length || !this.neb) return;
    const W = root.clientWidth;
    const H = root.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
    }
    const ctx = cv.getContext("2d")!;
    const k = this.state.k;
    const offX = (W - 1920 * k) / 2;
    const offY = (H - 1080 * k) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#07060b";
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, offX * dpr, offY * dpr);
    const x0 = -offX / k - 20;
    const x1 = 1920 + offX / k + 20;
    const y0 = -offY / k - 20;
    const y1 = 1080 + offY / k + 20;
    const T = now / 1000;
    const I = this.state.intro ? this.introSky : null;
    let ox: number;
    let oy: number;
    if (I) {
      ox = I.ox;
      oy = I.oy;
    } else {
      const sv = this.sv;
      const tx = this.mx != null ? this.mx / 1920 : 0.5 + 0.1 * Math.sin(T * 0.21);
      const ty = this.mx != null ? this.my / 1080 : 0.5 + 0.07 * Math.sin(T * 0.27 + 1);
      sv.vx = (sv.vx + (tx - sv.x) * 0.02) * 0.88;
      sv.vy = (sv.vy + (ty - sv.y) * 0.02) * 0.88;
      sv.x += sv.vx;
      sv.y += sv.vy;
      ox = (sv.x - 0.5) * 0.6;
      oy = (sv.y - 0.5) * 0.6;
    }
    // chapters fade their sky back in after the warp took it away
    const back = I ? 0 : cl((now - this.chapT0) / 1400);
    const nebA = I ? (I.out ? 1 - cl(I.ot / 0.8) : cl((I.t - 0.3) / 1.6)) : 0.6 * back;
    const nb = this.neb;
    const sc = Math.max(1, (x1 - x0 + 400) / nb.width, (y1 - y0 + 340) / nb.height);
    ctx.globalAlpha = nebA;
    ctx.drawImage(nb, 960 - (nb.width * sc) / 2 - ox * 18, 540 - (nb.height * sc) / 2 - oy * 12, nb.width * sc, nb.height * sc);
    const G = Recap.GLOWS[this.curKey() ?? "intro"];
    const gl = this.glow;
    const ks = ["x", "y", "r", "c0", "c1", "c2", "a"] as const;
    ks.forEach((kk, n) => (gl[kk] += (G[n] - gl[kk]) * 0.03));
    const pu = I ? 0 : Math.max(0, 1 - Math.abs(now - this.pulseAt - 350) / 1100);
    const rg = ctx.createRadialGradient(gl.x - ox * 12, gl.y - oy * 8, 0, gl.x - ox * 12, gl.y - oy * 8, gl.r * (1 + 0.25 * pu));
    rg.addColorStop(0, `rgba(${gl.c0 | 0},${gl.c1 | 0},${gl.c2 | 0},${(gl.a + 0.16 * pu * pu).toFixed(3)})`);
    rg.addColorStop(1, `rgba(${gl.c0 | 0},${gl.c1 | 0},${gl.c2 | 0},0)`);
    ctx.globalAlpha = I ? nebA : 1;
    ctx.fillStyle = rg;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // the galaxy band: a long soft glow with its own dust of small stars
    const bandA = I ? nebA * 0.8 : back;
    if (bandA > 0.01) {
      ctx.save();
      ctx.translate(960 - ox * 10, 600 - oy * 6);
      ctx.rotate(-0.45);
      ctx.scale(1, 0.16);
      const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1500);
      bg.addColorStop(0, "rgba(200,170,255,.07)");
      bg.addColorStop(0.5, "rgba(150,100,230,.035)");
      bg.addColorStop(1, "rgba(150,100,230,0)");
      ctx.globalAlpha = bandA;
      ctx.fillStyle = bg;
      ctx.fillRect(-1600, -1600, 3200, 3200);
      ctx.restore();
      ctx.fillStyle = "#e9dcff";
      for (const b of this.bandStars) {
        const x = b.x - ox * 6 - T * 1.2;
        const xx = ((((x + 800) % 3520) + 3520) % 3520) - 800;
        const y = b.y - oy * 4;
        if (xx < x0 || xx > x1 || y < y0 || y > y1) continue;
        ctx.globalAlpha = b.a * bandA;
        ctx.fillRect(xx, y, b.r, b.r);
      }
    }
    // stars: the intro's warp in and out, then a slow drift, nearer ones faster
    const w = I ? (I.out ? eio(cl(I.ot / 0.85)) : Math.pow(1 - cl(I.t / 1.1), 2)) : 0;
    // hyperspace: every star stretches out from the middle for a few seconds
    const wq = this.warpT0 ? (now - this.warpT0) / 3000 : 1;
    if (wq >= 1) this.warpT0 = 0;
    const warp = wq < 1 ? Math.pow(Math.sin(Math.PI * wq), 1.3) : 0;
    const starA = I ? cl((I.t - 0.6) / 0.8) : back;
    for (const st of this.skyStars) {
      const dx0 = T * (2 + 8 * st.z);
      const xr = ((((st.x - dx0 + 800) % 3520) + 3520) % 3520) - 800;
      const yr = ((((st.y - T * (0.6 + 2 * st.z) + 500) % 2080) + 2080) % 2080) - 500;
      // the lean stays a hint, a stronger one read as the whole sky sliding
      const x = xr - ox * st.z * 26;
      const y = yr - oy * st.z * 16;
      if (x < x0 - 200 || x > x1 + 200 || y < y0 - 200 || y > y1 + 200) continue;
      const r = 0.7 + st.z * 1.9;
      if (w > 0.003 && I) {
        const dx = x - 960;
        const dy = y - 470;
        const f = w * w * (1.2 + st.z * 3) * (I.out ? 1 : 0.8);
        ctx.globalAlpha = (0.4 + 0.6 * st.z) * (I.out ? 1 - cl((I.ot - 0.5) / 0.4) : cl(I.t / 0.25));
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = r;
        ctx.beginPath();
        ctx.moveTo(x + dx * f * 0.35, y + dy * f * 0.35);
        ctx.lineTo(x + dx * f, y + dy * f);
        ctx.stroke();
        if (I.out) continue;
      }
      if (warp > 0.01) {
        const f = warp * (0.35 + st.z * 1.1);
        ctx.globalAlpha = (0.35 + 0.65 * st.z) * Math.min(1, warp * 2);
        ctx.strokeStyle = st.z > 0.7 ? "#ffe0ff" : "#fff";
        ctx.lineWidth = r;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (x - 960) * f, y + (y - 500) * f);
        ctx.stroke();
        continue;
      }
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const tw = 0.5 + 0.5 * Math.sin(T * (0.8 + st.z * 2.4) + st.ph);
      ctx.globalAlpha = (0.25 + 0.75 * st.z) * (0.45 + 0.55 * tw) * starA;
      ctx.fillStyle = st.z > 0.8 ? "#ffe9ff" : "#ffffff";
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    // the odd shooting star; only the intro's make a sound
    if (!this.skyShoot && T > this.shootAt && !(I && I.out)) {
      const a = 0.35 + Math.random() * 0.3;
      const x = x0 + 200 + Math.random() * Math.max(200, x1 - x0 - 900);
      this.skyShoot = { t0: T, x, y: y0 + 80 + Math.random() * 260, a, dim: I ? 1 : 0.6 };
      this.shootAt = T + (I ? 4 + Math.random() * 4 : 9 + Math.random() * 9);
      if (I) au.play("card-flick", { gain: 0.22, pan: cl((x - 960) / 1100, -1, 1), group: "intro" });
    }
    const sh = this.skyShoot;
    if (sh) {
      const q = (T - sh.t0) / 0.9;
      if (q > 1) this.skyShoot = null;
      else {
        const x = sh.x + Math.cos(sh.a) * q * 700;
        const y = sh.y + Math.sin(sh.a) * q * 700;
        const ex = x - Math.cos(sh.a) * 260;
        const ey = y - Math.sin(sh.a) * 260;
        this.shootPos = { x, y, ex, ey };
        const g = ctx.createLinearGradient(x, y, ex, ey);
        g.addColorStop(0, "rgba(255,240,255,.9)");
        g.addColorStop(1, "rgba(255,240,255,0)");
        ctx.globalAlpha = Math.sin(q * Math.PI) * sh.dim;
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    } else this.shootPos = null;
    // a caught shooting star: a ring of light, a glint, and a wish
    for (let i = this.caught.length - 1; i >= 0; i--) {
      const c = this.caught[i];
      const q = (now - c.t0) / 1400;
      if (q >= 1) {
        this.caught.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = 1 - q;
      ctx.strokeStyle = "#ffd6f7";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 10 + 110 * (1 - Math.pow(1 - q, 3)), 0, Math.PI * 2);
      ctx.stroke();
      const r = 26 * Math.sin(Math.PI * Math.min(1, q * 1.6));
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - r);
      ctx.quadraticCurveTo(c.x, c.y, c.x + r, c.y);
      ctx.quadraticCurveTo(c.x, c.y, c.x, c.y + r);
      ctx.quadraticCurveTo(c.x, c.y, c.x - r, c.y);
      ctx.quadraticCurveTo(c.x, c.y, c.x, c.y - r);
      ctx.fill();
      ctx.globalAlpha = Math.sin(Math.PI * q);
      ctx.font = `500 15px ${MONO}`;
      ctx.textAlign = "center";
      ctx.fillStyle = "#f3e8ff";
      ctx.fillText("WISH MADE", c.x, c.y - 40 - 40 * q);
    }
    ctx.globalAlpha = 1;
  }

  /** backing store at the on-screen size, capped at 2x */
  fit(cv: HTMLCanvasElement, bleed = false): CanvasRenderingContext2D {
    const s = Math.min(2, Math.max(1, (window.devicePixelRatio || 1) * this.state.k));
    const bx = bleed ? this.state.bx : 0;
    const by = bleed ? this.state.by : 0;
    const w = Math.round((1920 + 2 * bx) * s);
    const h = Math.round((1080 + 2 * by) * s);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext("2d")!;
    if (bleed) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
    }
    ctx.setTransform(s, 0, 0, s, bx * s, by * s);
    this.cdpr = s;
    return ctx;
  }

  drawIntro(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.iStars || !this.neb) return;
    const t = (now - this.introT0) / 1000;
    const iv = this.iv;
    const out = this.state.introOut;
    const ot = out ? (now - this.outT) / 1000 : 0;
    let tx: number;
    let ty: number;
    if (this.mx != null) {
      tx = this.mx / 1920;
      ty = this.my / 1080;
    } else {
      tx = 0.5 + 0.1 * Math.sin(t * 0.35);
      ty = 0.5 + 0.07 * Math.sin(t * 0.45 + 1);
    }
    iv.vx = (iv.vx + (tx - iv.x) * 0.045) * 0.84;
    iv.vy = (iv.vy + (ty - iv.y) * 0.045) * 0.84;
    iv.x += iv.vx;
    iv.y += iv.vy;
    const ox = iv.x - 0.5;
    const oy = iv.y - 0.5;
    ctx.clearRect(0, 0, 1920, 1080);
    // stars, nebula and shooting stars are drawn on the sky canvas, so they reach past the stage
    this.introSky = { t, out, ot, ox, oy };
    // the flash as the year lands
    const land = t - 2.15;
    if (!out && land > 0 && land < 1.6) {
      const a = Math.sin(cl(land / 1.6) * Math.PI) * 0.55;
      const g = ctx.createRadialGradient(960, 400, 0, 960, 400, 700);
      g.addColorStop(0, `rgba(220,170,255,${a})`);
      g.addColorStop(1, "rgba(220,170,255,0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1920, 1080);
    }
    ctx.globalAlpha = 1;
    const TR = this.titleRef.current;
    const PL = this.planetRef.current;
    if (TR && this.digits && (!this.titleBuilt || !TR.firstChild)) this.buildTitle(TR);
    const rY = ox * 26;
    const rX = -oy * 18;
    const z = out ? eio(cl(ot / 0.85)) * 1300 : 0;
    if (TR) TR.style.transform = `translateZ(${z.toFixed(1)}px) rotateX(${rX.toFixed(2)}deg) rotateY(${rY.toFixed(2)}deg)`;
    this.digEls?.forEach((el, i) => {
      const p = cl((t - 0.9 - i * 0.14) / 1.05);
      let tf = "hidden";
      if (p > 0) {
        const e1 = eo(p);
        const zz = -2400 * (1 - eob(p));
        const rx = (1 - e1) * -75;
        const ry = (1 - e1) * (i - 1.5) * 28;
        const yy = (1 - e1) * -90;
        tf = `translate3d(0,${yy.toFixed(1)}px,${zz.toFixed(1)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      }
      if (this.digT[i] === tf) return;
      this.digT[i] = tf;
      el.style.visibility = p > 0 ? "visible" : "hidden";
      if (p > 0) el.style.transform = tf;
    });
    if (this.pearlEl) {
      const sw = t > 2.1 && t < 3.3 ? -1800 + 3600 * eio((t - 2.1) / 1.2) : 0;
      this.pearlEl.setAttribute("gradientTransform", `translate(${(ox * 700 + sw).toFixed(1)} ${(oy * 240).toFixed(1)})`);
    }
    if (PL) {
      const e = eo(cl((t - 0.2) / 2));
      PL.style.transform = `translate(${(-ox * 12).toFixed(1)}px,${(-oy * 5 + (out ? ot * ot * 700 : 0) + (1 - e) * 600).toFixed(1)}px)`;
      // the shimmer turns and the highlight slides with the pointer as transforms, so the 3200px
      // planet never repaints (the design moved them with css variables)
      const HO = this.holoRef.current;
      const SP = this.specRef.current;
      if (HO) HO.style.transform = `rotate(${(iv.x * 40).toFixed(2)}deg)`;
      if (SP) SP.style.transform = `translateX(${((42 + iv.x * 16) * 32 - 448).toFixed(1)}px)`;
    }
  }

  drawStack(ctx: CanvasRenderingContext2D, step: number, el: number) {
    const D = this.D;
    const A = this.refA;
    const B = this.refB;
    const g = this.state.g;
    const GY = 900;
    const SPAN = 640;
    const CX = 1500;
    const RX = 1080;
    let V = this.VA;
    let colW = 150;
    let p = 0;
    let H: number;
    if (step >= 2) {
      p = step === 2 ? eio(cl(el / 2.6)) : 1;
      V = Math.exp(Math.log(this.VA) + (Math.log(this.VB) - Math.log(this.VA)) * p);
      colW = 150 + (6 - 150) * p;
    }
    const gs = g.stack ?? A.h * 0.5;
    const ge = g.end ?? B.h * 0.5;
    if (step === 0) H = gs;
    else if (step === 1) H = gs + (D.stackH - gs) * eob(cl((el - 0.15) / 1.1));
    else if (step === 2) H = el < 2.6 ? D.stackH : D.stackH + (ge - D.stackH) * eo(cl((el - 2.6) / 0.6));
    else H = ge + (D.endH - ge) * eob(cl((el - 0.15) / 1.4));
    if (step === 3) {
      // a tick for every altitude mark the column passes on its way up, higher each time
      let n = 0;
      for (const [, h] of MARKS) {
        if (this.prevH < h && H >= h) au.playThrottled("mark", 60, "tick", { bus: "ui", gain: 0.5, rate: 0.9 + 0.12 * n });
        if (H >= h) n++;
      }
      this.prevH = H;
    }
    // pixels per metre; once the planet's radius fits on screen the ground curves
    const ppm = SPAN / V;
    const Rp = 6371e3 * ppm;
    const curved = Rp < 4e5;
    const drop = (x: number) => (curved ? Rp - Math.sqrt(Math.max(0, Rp * Rp - (x - CX) * (x - CX))) : 0);
    const X0 = -this.state.bx - 4;
    const XW = 1920 + 2 * this.state.bx + 8;
    const kh = 1e5 * ppm;
    // the air: a haze over the ground that thins out as the view leaves the atmosphere, which is
    // where the sky's stars come through
    const air = cl(kh / 640) * (1 - p);
    if (air > 0.01) {
      const ag = ctx.createLinearGradient(0, GY, 0, GY - 420);
      ag.addColorStop(0, `rgba(60,28,110,${(0.38 * air).toFixed(3)})`);
      ag.addColorStop(1, "rgba(60,28,110,0)");
      ctx.fillStyle = ag;
      ctx.fillRect(X0, GY - 420, XW, 420);
    }
    const hz = Math.max(70, Math.min(560, 1.4e5 * ppm));
    if (curved) {
      const g2 = ctx.createRadialGradient(CX, GY + Rp, Rp, CX, GY + Rp, Rp + hz);
      g2.addColorStop(0, "rgba(140,60,230,.32)");
      g2.addColorStop(1, "rgba(140,60,230,0)");
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(CX, GY + Rp, Rp + hz, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const g2 = ctx.createLinearGradient(0, GY, 0, GY - hz);
      g2.addColorStop(0, "rgba(140,60,230,.24)");
      g2.addColorStop(1, "rgba(140,60,230,0)");
      ctx.fillStyle = g2;
      ctx.fillRect(X0, GY - hz, XW, hz);
    }
    ctx.fillStyle = "#0d0a14";
    if (curved) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, GY + Rp, Rp, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = "rgba(165,6,230,.9)";
      ctx.shadowBlur = 30;
      ctx.strokeStyle = "rgba(214,160,255,.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillRect(X0, GY, XW, 180 + this.state.by);
      const lg = ctx.createLinearGradient(X0, 0, X0 + XW, 0);
      lg.addColorStop(0, "rgba(199,116,224,0)");
      lg.addColorStop(0.5, "rgba(199,116,224,.6)");
      lg.addColorStop(1, "rgba(199,116,224,0)");
      ctx.fillStyle = lg;
      ctx.fillRect(X0, GY, XW, 1.5);
    }
    const label = (name: string, h: number, x: number, y: number, a: number) => {
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#f3f1f7";
      ctx.font = `500 20px ${SANS}`;
      ctx.fillText(name.charAt(0).toUpperCase() + name.slice(1), x, y - 30);
      ctx.font = `400 15px ${MONO}`;
      ctx.fillStyle = "rgba(243,241,247,.6)";
      ctx.fillText(fmtAlt(h), x, y - 10);
      ctx.globalAlpha = 1;
    };
    const guessing = step === 0 || (step === 2 && el > 2.6);
    if (step >= 2) {
      const ma = cl((p - 0.5) / 0.4);
      if (ma > 0) {
        let lastY = 1e9;
        const by = GY - B.h * ppm;
        const gy = step === 3 ? GY - ge * ppm : -1e9;
        ctx.textAlign = "right";
        ctx.font = `500 13px ${MONO}`;
        for (const [n, h] of MARKS) {
          if (Math.abs(h - B.h) / B.h < 0.05) continue;
          const y = GY - h * ppm;
          if (y > GY - 18 || y < 130) continue;
          if (Math.abs(y - by) < 26 || lastY - y < 24 || Math.abs(y - gy) < 20) continue;
          lastY = y;
          ctx.globalAlpha = ma;
          ctx.save();
          ctx.setLineDash([2, 8]);
          ctx.strokeStyle = h === 1e5 ? "rgba(140,200,255,.32)" : "rgba(243,241,247,.15)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (curved) ctx.arc(CX, GY + Rp, Rp + h * ppm, Math.PI * 1.2, Math.PI * 1.8);
          else {
            ctx.moveTo(600, y);
            ctx.lineTo(1800, y);
          }
          ctx.stroke();
          ctx.restore();
          const reached = H >= h;
          ctx.fillStyle = reached ? "rgba(231,163,255,.95)" : "rgba(243,241,247,.55)";
          ctx.fillText(n.toUpperCase() + " · " + fmtAlt(h), CX - 30, y + 4);
          ctx.fillRect(CX - 22, y - 0.5, 12, 1);
        }
        ctx.globalAlpha = 1;
      }
    }
    // the first reference, fading out as the scale zooms out
    const aA = step < 2 ? 1 : cl(1 - p * 2.2);
    const hA = A.h * ppm;
    if (aA > 0 && hA > 1) {
      ctx.globalAlpha = aA;
      const yb = GY + drop(RX);
      const hw = drawSil(ctx, A.kind, RX, yb, hA);
      ctx.globalAlpha = 1;
      label(A.name, A.h, RX, yb - hA, aA);
      if (guessing && step === 0) {
        ctx.save();
        ctx.setLineDash([3, 7]);
        ctx.strokeStyle = "rgba(243,241,247,.22)";
        ctx.beginPath();
        ctx.moveTo(RX + hw + 18, yb - hA);
        ctx.lineTo(CX - colW / 2 - 18, yb - hA);
        ctx.stroke();
        ctx.restore();
      }
    }
    // the second reference
    if (step >= 2) {
      const aB = cl((p - 0.45) / 0.4);
      if (aB > 0) {
        const alt = B.h * ppm;
        const yb = GY + drop(RX);
        const ya = yb - alt;
        ctx.globalAlpha = aB;
        if (B.kind === "mountain" || B.kind === "burj") {
          drawSil(ctx, B.kind, RX, yb, alt);
          ctx.globalAlpha = 1;
          label(B.name, B.h, RX, ya, aB);
        } else {
          ctx.save();
          ctx.setLineDash(B.kind === "karman" ? [6, 6] : [3, 7]);
          ctx.strokeStyle = B.kind === "karman" ? "rgba(160,210,255,.85)" : "rgba(243,241,247,.32)";
          ctx.lineWidth = B.kind === "karman" ? 1.5 : 1;
          ctx.beginPath();
          if (curved) ctx.arc(CX, GY + Rp, Rp + alt, Math.PI, Math.PI * 2);
          else {
            ctx.moveTo(0, ya);
            ctx.lineTo(1920, ya);
          }
          ctx.stroke();
          ctx.restore();
          if (B.kind === "iss") drawISS(ctx, RX, ya);
          else if (B.kind === "gps") {
            ctx.fillStyle = "#f3f1f7";
            ctx.beginPath();
            ctx.arc(RX, ya, 7, 0, Math.PI * 2);
            ctx.fill();
          } else if (B.kind === "plane") drawPlane(ctx, RX, ya, 34);
          ctx.globalAlpha = 1;
          label(B.name, B.h, RX, ya - (B.kind === "karman" ? 0 : 24), aB);
        }
        ctx.globalAlpha = 1;
      }
    }
    // the column: every sheet in one block, drawn like the cutting room's range, a see-through
    // guess with a white rim while it's being pulled and the solid answer once it's revealed. its
    // drawn height chases the real one on a spring, so pulling stretches it thin and letting go
    // squashes it wide before it settles, volume kept roughly the same
    const target = Math.max(1.5, H * ppm);
    const bk = this.blk;
    const nowS = performance.now() / 1000;
    const dt = bk.t ? Math.min(0.05, nowS - bk.t) : 0;
    bk.t = nowS;
    if (!dt || (step === 2 && el < 2.6)) {
      bk.h = target;
      bk.v = 0;
    } else {
      bk.v += (340 * (target - bk.h) - 17 * bk.v) * dt;
      bk.h += bk.v * dt;
    }
    const hpx = Math.max(1.5, bk.h);
    const sq = Math.tanh(bk.v / 900);
    const bw = Math.max(2, colW * (1 - 0.32 * sq));
    const x0 = CX - colW / 2;
    const bx0 = CX - bw / 2;
    const top = GY - hpx;
    // the top domes when it's pulled up and dents when it drops
    const dome = cl(bk.v / 40, -14, 14) * cl(bw / 120);
    const rad = Math.min(14, bw / 3, hpx / 2);
    // closed for the fill, open along the ground for the rim
    const body = (close: boolean) => {
      ctx.beginPath();
      ctx.moveTo(bx0, GY);
      ctx.lineTo(bx0, top + rad);
      ctx.quadraticCurveTo(bx0, top, bx0 + rad, top);
      ctx.quadraticCurveTo(CX, top - dome * 2, bx0 + bw - rad, top);
      ctx.quadraticCurveTo(bx0 + bw, top, bx0 + bw, top + rad);
      ctx.lineTo(bx0 + bw, GY);
      if (close) ctx.closePath();
    };
    if (bw > 10) {
      const solid = step === 1 || step === 3;
      // a glow either side, a gradient: a shadow blur this size every frame costs too much
      const gw = bw + 120;
      const gl = ctx.createLinearGradient(CX - gw / 2, 0, CX + gw / 2, 0);
      gl.addColorStop(0, "rgba(232,11,238,0)");
      gl.addColorStop(0.5, `rgba(232,11,238,${solid ? 0.3 : 0.18})`);
      gl.addColorStop(1, "rgba(232,11,238,0)");
      ctx.fillStyle = gl;
      ctx.fillRect(CX - gw / 2, top + rad, gw, hpx - rad);
      const fg = ctx.createLinearGradient(0, top, 0, GY);
      if (solid) {
        fg.addColorStop(0, "#ff7bff");
        fg.addColorStop(0.4, "#e80bee");
        fg.addColorStop(1, "#a506e6");
      } else {
        fg.addColorStop(0, "rgba(232,11,238,.62)");
        fg.addColorStop(1, "rgba(165,6,230,.5)");
      }
      ctx.fillStyle = fg;
      body(true);
      ctx.fill();
      // the sheets, packed tighter while it's squashed
      if (hpx > 40) {
        ctx.save();
        ctx.clip();
        ctx.fillStyle = "rgba(255,255,255,.08)";
        const gap = 6 * (1 + 0.3 * sq);
        for (let y = GY - gap; y > top + 4; y -= gap) ctx.fillRect(bx0, y, bw, 1);
        ctx.restore();
      }
      ctx.strokeStyle = solid ? "rgba(255,255,255,.4)" : "#f3f1f7";
      ctx.lineWidth = solid ? 1.5 : 3;
      ctx.lineJoin = "round";
      body(false);
      ctx.stroke();
    } else {
      // zoomed out it's a line of light
      ctx.fillStyle = "#ff9dff";
      ctx.fillRect(CX - bw / 2, top, bw, hpx);
    }
    if (colW < 40) {
      const rg = ctx.createRadialGradient(CX, top, 0, CX, top, 60);
      rg.addColorStop(0, "rgba(255,255,255,.8)");
      rg.addColorStop(0.3, "rgba(232,11,238,.45)");
      rg.addColorStop(1, "rgba(232,11,238,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(CX - 60, top - 60, 120, 120);
    }
    if (guessing && (step === 0 || el > 3)) {
      // the grip: the cutting room's handle laid on the rim, bigger when the pointer is near it or
      // holding it
      const near = this.stDrag || (this.mx != null && Math.abs(this.mx - CX) < Math.max(90, bw) && Math.abs(this.my - (top - dome)) < 60);
      const kw = Math.max(52, Math.min(120, bw * 0.72));
      const kh = near ? 16 : 12;
      const ky = top - dome * 1.5;
      ctx.save();
      ctx.shadowColor = "rgba(232,11,238,.9)";
      ctx.shadowBlur = near ? 26 : 18;
      ctx.fillStyle = "#f3f1f7";
      ctx.beginPath();
      rrp(ctx, CX - kw / 2, ky - kh / 2, kw, kh, kh / 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "rgba(243,241,247,.85)";
      const ax = CX + Math.max(bw, colW) / 2 + 34;
      ctx.beginPath();
      ctx.moveTo(ax, top - 22);
      ctx.lineTo(ax - 7, top - 13);
      ctx.lineTo(ax + 7, top - 13);
      ctx.closePath();
      ctx.moveTo(ax, top + 22);
      ctx.lineTo(ax - 7, top + 13);
      ctx.lineTo(ax + 7, top + 13);
      ctx.closePath();
      ctx.fill();
      if (!this.touched.stack) {
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(el * 4);
        ctx.font = `500 13px ${MONO}`;
        ctx.textAlign = "left";
        ctx.fillStyle = "#f3f1f7";
        ctx.fillText("PULL", ax + 16, top + 5);
        ctx.globalAlpha = 1;
      }
    }
    if (step === 1 || step === 3) {
      const gv = step === 1 ? gs : ge;
      const gy = GY - gv * ppm;
      const a = cl((el - 0.3) / 0.4);
      ctx.globalAlpha = a;
      ctx.save();
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = "rgba(255,255,255,.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0 - 80, gy);
      ctx.lineTo(x0 + colW + 14, gy);
      ctx.stroke();
      ctx.restore();
      ctx.textAlign = "right";
      ctx.font = `500 14px ${MONO}`;
      ctx.fillStyle = "rgba(243,241,247,.75)";
      ctx.fillText("YOU · " + fmtAlt(gv), x0 - 90, gy + 5);
      ctx.globalAlpha = 1;
      const ra = cl((el - 1) / 0.4);
      ctx.globalAlpha = ra;
      ctx.textAlign = "left";
      ctx.font = `600 30px ${DISPLAY}`;
      ctx.fillStyle = "#fff";
      ctx.fillText(fmtLen(step === 1 ? D.stackH : D.endH), x0 + colW + 30, top + 11);
      ctx.globalAlpha = 1;
    }
  }

  prepClock() {
    const D = this.D;
    const CX = 1240;
    const CY = 540;
    const RI = 200;
    const RO = 258;
    const R0 = 92;
    const R1 = 430;
    const col = this.col;
    const sorted = D.pts.slice().sort((a, b) => a[1] - b[1]);
    const slots: Record<number, Block[]> = {};
    // 72 slots of 10 minutes round the dial; morning stacks inward, afternoon outward
    const blocks: Block[] = sorted.map((p) => {
      const h = p[1] % 24;
      const slot = Math.floor(h * 6);
      const th = (((slot % 72) + 0.5) / 72) * Math.PI * 2 - Math.PI / 2;
      const k = col(p[2], p[0]);
      const c1 = h >= 20 || h < 6 ? "oklch(.72 .21 330)" : "oklch(.8 .09 300)";
      return { h, am: h < 12, slot, th, g: p[2], c1, c2: D.hasGames ? lch(k[0], k[1], k[2]) : c1, x: 0, y: 0 };
    });
    for (const b of blocks) (slots[b.slot] = slots[b.slot] || []).push(b);
    let mi = 1;
    let mo = 1;
    for (const k in slots) {
      const a = slots[k];
      if (a[0].am) mi = Math.max(mi, a.length);
      else mo = Math.max(mo, a.length);
    }
    const pitch = Math.min(11, (RI - 8 - R0) / mi, (R1 - RO - 8) / mo);
    for (const k in slots) {
      const a = slots[k];
      a.sort((x, y) => Number(x.g < 0) - Number(y.g < 0) || x.g - y.g);
      a.forEach((b, i) => {
        const r = b.am ? RI - 8 - (i + 0.5) * pitch : RO + 8 + (i + 0.5) * pitch;
        b.x = CX + Math.cos(b.th) * r;
        b.y = CY + Math.sin(b.th) * r;
      });
    }
    this.ck = { CX, CY, RI, RO, R0, R1, blocks, pitch, size: Math.max(3, pitch * 0.8) };
  }

  drawClock(ctx: CanvasRenderingContext2D, step: number, el: number) {
    const K = this.ck;
    const D = this.D;
    const st = this.state;
    const { CX, CY, RI, RO, R0, R1 } = K;
    const TAU = Math.PI * 2;
    const A = (h: number) => ((h % 12) / 12) * TAU - Math.PI / 2;
    ctx.clearRect(0, 0, 1920, 1080);
    const sec = (r1: number, r2: number, a1: number, a2: number) => {
      ctx.beginPath();
      ctx.arc(CX, CY, r2, a1, a2);
      ctx.arc(CX, CY, r1, a2, a1, true);
      ctx.closePath();
    };
    const gg = ctx.createRadialGradient(CX, CY, 0, CX, CY, R1 + 140);
    gg.addColorStop(0, "rgba(165,6,230,.11)");
    gg.addColorStop(1, "rgba(165,6,230,0)");
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.fillStyle = "rgba(255,255,255,.02)";
    ctx.beginPath();
    ctx.arc(CX, CY, R1, 0, TAU);
    ctx.fill();
    // night shading: 20-24 outside, 00-06 inside
    ctx.fillStyle = "rgba(61,3,215,.13)";
    sec(RO, R1, A(20), A(20) + TAU / 3);
    ctx.fill();
    sec(R0, RI, A(0), A(0) + TAU / 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.05)";
    sec(RI, RO, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    ctx.lineWidth = 1;
    for (const r of [RI, RO]) {
      ctx.beginPath();
      ctx.arc(CX, CY, r, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.beginPath();
    ctx.arc(CX, CY, R1, 0, TAU);
    ctx.stroke();
    for (let h = 0; h < 60; h++) {
      const a = (h / 60) * TAU - Math.PI / 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const big = h % 5 === 0;
      ctx.strokeStyle = big ? "rgba(255,255,255,.4)" : "rgba(255,255,255,.14)";
      ctx.beginPath();
      ctx.moveTo(CX + c * RI, CY + s * RI);
      ctx.lineTo(CX + c * (RI + (big ? 7 : 3)), CY + s * (RI + (big ? 7 : 3)));
      ctx.moveTo(CX + c * RO, CY + s * RO);
      ctx.lineTo(CX + c * (RO - (big ? 7 : 3)), CY + s * (RO - (big ? 7 : 3)));
      ctx.stroke();
    }
    const hl = new Set<number>();
    if (step === 0 && st.g.hour != null) hl.add(st.g.hour);
    if (step >= 1 && (step === 2 || el > 2.9)) hl.add(D.peak);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let h = 0; h < 12; h++) {
      const a = A(h);
      for (const [hh, r] of [[h, RI + 19], [h + 12, RO - 19]] as const) {
        const on = hl.has(hh);
        ctx.font = on ? `700 15px ${MONO}` : `500 13px ${MONO}`;
        ctx.fillStyle = on ? "#fff" : hh < 12 ? "rgba(243,241,247,.48)" : "rgba(243,241,247,.75)";
        ctx.fillText(pad(hh), CX + Math.cos(a) * r, CY + Math.sin(a) * r);
      }
    }
    const hand = (h: number, dash: boolean, alpha: number, w: number): [number, number] => {
      const am = h < 12;
      const a = A(h + 0.5);
      const L = am ? RI - 22 : R1 - 16;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      if (dash) ctx.setLineDash([6, 8]);
      else {
        ctx.shadowColor = "rgba(232,11,238,.9)";
        ctx.shadowBlur = 20;
      }
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + Math.cos(a) * L, CY + Math.sin(a) * L);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!dash) {
        ctx.beginPath();
        ctx.arc(CX + Math.cos(a) * L, CY + Math.sin(a) * L, 11, 0, TAU);
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
      ctx.restore();
      return [CX + Math.cos(a) * (L + 22), CY + Math.sin(a) * (L + 22)];
    };
    let center: [string, string] | null = null;
    if (step === 0) {
      const gh = st.g.hour;
      const h = gh == null ? 22 : gh;
      const al = gh == null ? 0.35 + 0.2 * Math.sin(el * 3) : 1;
      ctx.globalAlpha = al;
      ctx.fillStyle = "rgba(232,11,238,.18)";
      if (h < 12) sec(R0, RI, A(h), A(h + 1));
      else sec(RO, R1, A(h), A(h + 1));
      ctx.fill();
      ctx.globalAlpha = 1;
      hand(h, false, al, h < 12 ? 6 : 4);
      center = [gh == null ? "--:--" : pad(gh) + ":00", "YOUR GUESS"];
    }
    if (step >= 1) {
      // the hand sweeps the day once and drops each clip's block as it passes
      const T = step === 1 ? el : 99;
      const hs = cl((T - 0.2) / 2.6) * 24;
      const s0 = K.size;
      const hg = step === 2 ? st.hg : null;
      const dp = this.cdpr || 1;
      for (const b of K.blocks) {
        if (b.h > hs) continue;
        const sc = eob(cl((((hs - b.h) / 24) * 2.6) / 0.35));
        if (sc <= 0) continue;
        let c = b.c1;
        let a = 1;
        let s = s0 * sc;
        if (step === 2) {
          if (el - 0.1 - (b.h / 24) * 0.8 > 0) c = b.c2;
          if (hg != null) {
            if (b.g === hg) s *= 1.2;
            else a = 0.12;
          }
        }
        const co = Math.cos(b.th);
        const si = Math.sin(b.th);
        ctx.globalAlpha = a;
        ctx.fillStyle = c;
        ctx.setTransform(dp * co, dp * si, -dp * si, dp * co, dp * b.x, dp * b.y);
        ctx.fillRect(-s / 2, -s / 2, s, s);
      }
      ctx.setTransform(dp, 0, 0, dp, 0, 0);
      ctx.globalAlpha = 1;
      if (step === 1 && hs < 24) {
        const a = ((hs % 12) / 12) * TAU - Math.PI / 2;
        const L = hs < 12 ? RI : R1;
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.lineWidth = 2;
        ctx.shadowColor = "#e80bee";
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.moveTo(CX, CY);
        ctx.lineTo(CX + Math.cos(a) * L, CY + Math.sin(a) * L);
        ctx.stroke();
        ctx.restore();
        center = [hhmm(hs), ""];
      }
      const showPeak = step === 2 || el > 2.9;
      if (showPeak) {
        const pa = step === 2 ? 1 : cl((el - 2.9) / 0.5);
        const ph = D.peak;
        ctx.globalAlpha = pa;
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.lineWidth = 1.5;
        if (ph < 12) sec(R0, RI, A(ph), A(ph + 1));
        else sec(RO, R1, A(ph), A(ph + 1));
        ctx.stroke();
        const gh = st.g.hour;
        if (gh != null && gh !== ph && step === 1) {
          const [lx, ly] = hand(gh, true, pa * 0.8, 2);
          ctx.font = `500 12px ${MONO}`;
          ctx.fillStyle = "#e7a3ff";
          ctx.fillText("YOU", lx, ly);
        }
        ctx.globalAlpha = 1;
        if (step === 1) center = [pad(ph) + ":00", plural(D.byHour[ph], "CLIP", "CLIPS")];
      }
    }
    ctx.fillStyle = "#0c0914";
    ctx.beginPath();
    ctx.arc(CX, CY, R0 - 14, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (step === 2) {
      const hg = st.hg;
      const G = hg != null && hg >= 0 && hg < 99 ? D.games[hg] : null;
      if (G) {
        const im = this.img(G.srcs);
        if (ready(im)) {
          ctx.save();
          ctx.beginPath();
          rrp(ctx, CX - 32, CY - 32, 64, 64, 16);
          ctx.clip();
          ctx.drawImage(im, CX - 32, CY - 32, 64, 64);
          ctx.restore();
        }
      } else center = [hg == null ? "BY GAME" : "OTHER", ""];
    }
    if (center) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.font = center[0].length > 5 ? `600 18px ${DISPLAY}` : `600 30px ${DISPLAY}`;
      ctx.fillText(center[0], CX, CY - (center[1] ? 8 : 0));
      if (center[1]) {
        ctx.font = `500 11px ${MONO}`;
        ctx.fillStyle = "rgba(243,241,247,.6)";
        ctx.fillText(center[1], CX, CY + 20);
      }
    }
    ctx.font = `500 10px ${MONO}`;
    ctx.fillStyle = "rgba(243,241,247,.42)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const a = A(11.5);
    ctx.fillText("00–11", CX + Math.cos(a) * (RI + 19), CY + Math.sin(a) * (RI + 19));
    ctx.fillText("12–23", CX + Math.cos(a) * (RO - 19), CY + Math.sin(a) * (RO - 19));
    ctx.textBaseline = "alphabetic";
  }

  drawOrbit(ctx: CanvasRenderingContext2D, step: number, el: number, t: number) {
    const cx = 820;
    const cy = 580;
    const TY = 0.4;
    const F = this.orbF;
    const st = this.state;
    const D = this.D;
    ctx.clearRect(0, 0, 1920, 1080);
    const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 600);
    gg.addColorStop(0, "rgba(165,6,230,.16)");
    gg.addColorStop(1, "rgba(165,6,230,0)");
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.lineWidth = 1;
    for (const f of F) {
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, f.r, f.r * TY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const selId = st.sel || F[0]?.id;
    const hov = st.hover;
    F.forEach((f, i) => {
      const th = f.th0 + f.w * t;
      f.th = th;
      f.k = step === 0 ? 1 : eob(cl((el - 0.1 - i * 0.12) / 0.8));
      const g2 = step === 0 ? 1 : 0.3 + 0.7 * eo(cl((el - 0.1 - i * 0.12) / 0.9));
      f.rr = f.r * g2;
      f.x = cx + Math.cos(th) * f.rr;
      f.y = cy + Math.sin(th) * f.rr * TY;
      f.ds = 0.76 + 0.24 * (Math.sin(th) + 1);
      f.sz = step === 0 ? 9 * f.ds : Math.max(0.5, f.base * f.ds * f.k);
      f.z = Math.sin(th) + f.base / 300;
    });
    if (step >= 1) {
      const mxp = Math.max(1, ...Object.values(D.pairs));
      for (const k in D.pairs) {
        const [a, b] = k.split("-");
        const A = F.find((f) => f.id === a);
        const B = F.find((f) => f.id === b);
        if (!A || !B) continue;
        const v = D.pairs[k] / mxp;
        const on = a === selId || b === selId || a === hov || b === hov;
        ctx.globalAlpha = cl(Math.min(A.k, B.k)) * (on ? 0.35 + 0.5 * v : 0.05 + 0.15 * v);
        ctx.strokeStyle = on ? "#ffb4ff" : "#fff";
        ctx.lineWidth = on ? 1.5 + 3 * v : 1;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // back to front, "you" sits in the middle of the depth order
    const items: Array<{ f?: OrbitFriend; z: number }> = [...F.map((f) => ({ f, z: f.z })), { z: 0.2 }];
    items.sort((a, b) => a.z - b.z);
    for (const it of items) {
      if (!it.f) {
        const pr = 72 + Math.sin(t * 2) * 5;
        const hg = ctx.createRadialGradient(cx, cy, 40, cx, cy, pr + 50);
        hg.addColorStop(0, "rgba(232,11,238,.45)");
        hg.addColorStop(1, "rgba(232,11,238,0)");
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(cx, cy, pr + 50, 0, Math.PI * 2);
        ctx.fill();
        const lg = ctx.createLinearGradient(cx - 60, cy - 60, cx + 60, cy + 60);
        lg.addColorStop(0, "#e80bee");
        lg.addColorStop(0.5, "#a506e6");
        lg.addColorStop(1, "#3d03d7");
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(cx, cy, 60, 0, Math.PI * 2);
        ctx.fill();
        const oi = this.img(D.owner.av);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 54, 0, Math.PI * 2);
        ctx.clip();
        if (ready(oi)) ctx.drawImage(oi, cx - 54, cy - 54, 108, 108);
        ctx.restore();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.font = `600 14px ${MONO}`;
        ctx.fillStyle = "rgba(243,241,247,.75)";
        ctx.fillText("YOU", cx, cy + 72);
        ctx.textBaseline = "alphabetic";
        continue;
      }
      const f = it.f;
      const L = f.lc;
      if (step === 0) {
        ctx.fillStyle = "rgba(255,255,255,.12)";
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.sz, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // comet tail along the orbit behind each friend
      {
        const N = 44;
        const span = 1.05;
        const P: Array<[number, number, number]> = [];
        for (let s = 0; s <= N; s++) {
          const q = s / N;
          const an = f.th - span * (1 - q);
          P.push([cx + Math.cos(an) * f.rr, cy + Math.sin(an) * f.rr * TY, q]);
        }
        const Lp: Array<[number, number]> = [];
        const Rr: Array<[number, number]> = [];
        for (let s = 0; s <= N; s++) {
          const p0 = P[Math.max(0, s - 1)];
          const p1 = P[Math.min(N, s + 1)];
          let nx = -(p1[1] - p0[1]);
          let ny = p1[0] - p0[0];
          const l = Math.hypot(nx, ny) || 1;
          nx /= l;
          ny /= l;
          const w = f.sz * 0.48 * Math.pow(P[s][2], 1.4);
          Lp.push([P[s][0] + nx * w, P[s][1] + ny * w]);
          Rr.push([P[s][0] - nx * w, P[s][1] - ny * w]);
        }
        const gr = ctx.createLinearGradient(P[0][0], P[0][1], P[N][0], P[N][1]);
        gr.addColorStop(0, lch(L[0], L[1], L[2], 0));
        gr.addColorStop(1, lch(L[0], L[1], L[2], (0.5 * cl(f.k)).toFixed(3)));
        ctx.fillStyle = gr;
        ctx.beginPath();
        Lp.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        for (let i = N; i >= 0; i--) ctx.lineTo(Rr[i][0], Rr[i][1]);
        ctx.closePath();
        ctx.fill();
        const gc = ctx.createLinearGradient(P[0][0], P[0][1], P[N][0], P[N][1]);
        gc.addColorStop(0, "rgba(255,255,255,0)");
        gc.addColorStop(1, `rgba(255,255,255,${(0.5 * cl(f.k)).toFixed(3)})`);
        ctx.strokeStyle = gc;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        P.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
      const s = f.sz;
      const isSel = f.id === selId;
      const isHov = f.id === hov;
      ctx.save();
      ctx.shadowColor = lch(L[0], L[1], L[2]);
      ctx.shadowBlur = isSel ? 44 : 24;
      ctx.fillStyle = lch(L[0], L[1], L[2]);
      ctx.beginPath();
      ctx.arc(f.x, f.y, s + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const im = this.img(f.av);
      ctx.save();
      ctx.beginPath();
      ctx.arc(f.x, f.y, s, 0, Math.PI * 2);
      ctx.clip();
      if (ready(im)) ctx.drawImage(im, f.x - s, f.y - s, s * 2, s * 2);
      else {
        ctx.fillStyle = "#221b2e";
        ctx.fill();
      }
      ctx.restore();
      if (isSel || isHov) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(f.x, f.y, s + 10 + Math.sin(t * 4) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (f.k > 0.6) {
        ctx.globalAlpha = cl((f.k - 0.6) * 2.5) * (0.55 + (0.45 * (f.ds - 0.76)) / 0.48);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.font = `600 16px ${SANS}`;
        ctx.fillStyle = "#f3f1f7";
        ctx.fillText(trunc(f.name, 20), f.x, f.y + s + 12);
        ctx.font = `400 13px ${MONO}`;
        ctx.fillStyle = "rgba(243,241,247,.55)";
        ctx.fillText(plural(f.clips, "clip"), f.x, f.y + s + 33);
        ctx.textBaseline = "alphabetic";
        ctx.globalAlpha = 1;
      }
    }
  }

  /** the card's "your day" strip: every clip as a block, columns per hour from 06 to 06 */
  drawArt(cv: HTMLCanvasElement) {
    const ctx = cv.getContext("2d")!;
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const groups = Array.from({ length: 24 }, () => [] as Array<{ d: Dot; qx: number; qy: number }>);
    for (const d of this.dots) groups[d.j].push({ d, qx: 0, qy: 0 });
    for (const g of groups) g.sort((a, b) => a.d.g - b.d.g);
    const L = lay(groups, 28, W - 28, H - 48, H - 120, 28);
    const P = L.P * 0.78;
    const pj = (this.D.peak - 6 + 24) % 24;
    ctx.fillStyle = "rgba(232,11,238,.14)";
    ctx.beginPath();
    rrp(ctx, 28 + pj * L.cw + 2, L.tops[pj] - 10, L.cw - 4, H - 48 - L.tops[pj] + 14, 10);
    ctx.fill();
    for (const g of groups) {
      for (const o of g) {
        ctx.fillStyle = o.d.c2;
        ctx.beginPath();
        rrp(ctx, o.qx - P / 2, o.qy - P / 2, P, P, P * 0.3);
        ctx.fill();
      }
    }
    ctx.font = `500 20px ${MONO}`;
    ctx.fillStyle = "rgba(243,241,247,.45)";
    ctx.textAlign = "center";
    for (let j = 0; j <= 24; j += 6) ctx.fillText(pad((6 + j) % 24), 28 + j * L.cw, H - 14);
  }

  spark(x: number, y: number, pw: number) {
    const r = Math.random;
    this.sparks.push({ x, y, vx: (r() - 0.5) * 5 * pw, vy: -(1 + r() * 4.5) * pw, life: 0.45 + r() * 0.5 });
  }

  /** springs follow the pointer; the pack scene opens, then the card takes the tilt and flips */
  cardFrame(now: number) {
    const c = this.cs0;
    const SG = this.stageRef.current;
    if (!c || !SG) return;
    const t = now / 1000;
    let tx: number;
    let ty: number;
    let to: number;
    if (c.hov) {
      tx = c.hx;
      ty = c.hy;
      to = 1;
    } else {
      tx = 0.5 + 0.25 * Math.sin(t * 0.7);
      ty = 0.5 + 0.18 * Math.sin(t * 0.95 + 1.2);
      to = 0.55;
    }
    const sp = (k: "x" | "y" | "o" | "f", tg: number, s: number, d: number) => {
      const vk = ("v" + k) as "vx" | "vy" | "vo" | "vf";
      c[vk] = (c[vk] + (tg - c[k]) * s) * d;
      c[k] += c[vk];
    };
    sp("x", tx, 0.07, 0.8);
    sp("y", ty, 0.07, 0.8);
    // a fast sweep across the open card catches the foil
    if (c.ready && c.hov && this.tiltT) {
      const v = Math.hypot(c.hx - this.tiltX, c.hy - this.tiltY) / Math.max(0.004, (now - this.tiltT) / 1000);
      if (v > 2.2) au.playThrottled("tilt", 1100, "card-shine", { gain: Math.min(0.3, (v - 2) * 0.08), room: 0.25, pan: (c.hx - 0.5) * 0.8 });
    }
    this.tiltT = now;
    this.tiltX = c.hx;
    this.tiltY = c.hy;
    sp("o", to, 0.05, 0.82);
    const S = SG.style;
    const x = c.x;
    const y = c.y;
    S.setProperty("--mx", (x * 100).toFixed(2) + "%");
    S.setProperty("--my", (y * 100).toFixed(2) + "%");
    S.setProperty("--bx", (100 - x * 100).toFixed(2) + "%");
    S.setProperty("--by", (100 - y * 100).toFixed(2) + "%");
    S.setProperty("--fx", (x * 100).toFixed(2) + "%");
    S.setProperty("--o", cl(c.o).toFixed(3));

    this.ensurePack();
    const P = this.pack;
    if (P) {
      if (this.packK !== this.state.k) {
        this.packK = this.state.k;
        P.resize(this.state.k);
      }
      P.update(now, x, y);
      // the pouch has dropped away and the rays have faded: free the gpu
      if (P.phase === "done" && P.rays <= 0) this.dropPack();
    }
    const packing = c.ph === "pack";
    c.mix += ((packing ? 0 : 1) - c.mix) * 0.05;
    const rY = (x - 0.5) * 38 * c.mix;
    const rX = -(y - 0.5) * 26 * c.mix;
    const bob = Math.sin(t * 1.3) * 6 * c.mix;
    const TL = this.tiltRef.current;
    const CR = this.cardRef.current;
    const FR = this.flipRef.current;
    const RY = this.raysRef.current;
    const SH = this.shadowRef.current;
    const SC = this.sparkCv.current;
    const DM = this.dimRef.current;
    const FL = this.flashRef.current;
    const FLL = this.flashLineRef.current;
    const lift = P && packing ? P.cardLift : 0;
    const vis = packing ? (P ? P.cardVis : 0) : 1;
    if (RY) {
      const ro = (P ? P.rays : 0) * 0.9;
      RY.style.opacity = ro.toFixed(3);
      if (ro > 0) RY.style.transform = `rotate(${(t * 7).toFixed(2)}deg)`;
    }
    if (DM) DM.style.opacity = ((P ? P.dim : 0) * 0.62).toFixed(3);
    if (FL) FL.style.opacity = (P ? Math.pow(P.flash, 1.6) * 0.85 : 0).toFixed(3);
    if (FLL) FLL.style.opacity = (P && P.phase === "rip" ? P.flash : 0).toFixed(3);
    if (c.ready) sp("f", c.ft, 0.06, 0.78);
    if (TL) TL.style.transform = `translate3d(0,${bob.toFixed(2)}px,0) rotateX(${rX.toFixed(2)}deg) rotateY(${rY.toFixed(2)}deg)`;
    if (CR) {
      CR.style.transform = `translateY(${lift.toFixed(2)}px)`;
      CR.style.opacity = String(vis);
      // inside the pouch the card only shows above the mouth and within the pouch's sides
      const o = packing && P ? P.outline : null;
      if (o) {
        // the card sits at 40,66 inside the stage at 660,92
        const p = (i: number) => `${(o[i * 2] - 700).toFixed(1)}px ${(o[i * 2 + 1] - 158 - lift).toFixed(1)}px`;
        const top = (i: number) => (o[i * 2 + 1] - 158 - lift).toFixed(1);
        CR.style.clipPath = `polygon(-600px -3000px, 1200px -3000px, 1200px ${top(5)}px, ${p(5)}, ${p(4)}, ${p(3)}, ${p(2)}, ${p(1)}, ${p(0)}, -600px ${top(0)}px)`;
      } else if (CR.style.clipPath) CR.style.clipPath = "";
    }
    // the card trick: three turns on top of the flip, fast then slowing, the foil flaring as it goes
    let extra = 0;
    if (this.spinT0) {
      const q = (now - this.spinT0) / 1500;
      if (q >= 1) {
        this.spinT0 = 0;
        CR?.style.removeProperty("--hi");
      } else {
        extra = 1080 * (1 - Math.pow(1 - q, 3));
        CR?.style.setProperty("--hi", (1 + 2.2 * Math.sin(Math.PI * q)).toFixed(3));
      }
    }
    if (FR) FR.style.transform = `rotateY(${(c.f + extra).toFixed(2)}deg)`;
    if (SH) {
      SH.style.opacity = String(c.mix);
      SH.style.transform = `translateX(${(-rY * 3).toFixed(1)}px) scale(${(1 - bob / 90).toFixed(3)})`;
    }
    // sparks off the head of the traced line, a shower along the cut on the rip
    if (P?.tip) {
      const dx = this.lastTip ? Math.abs(P.tip.x - this.lastTip.x) : 0;
      if (dx > 0.5) for (let i = 0; i < Math.min(6, 1 + ((dx / 6) | 0)); i++) this.spark(P.tip.x, P.tip.y, 1);
    }
    this.lastTip = P?.tip ?? null;
    if (P && P.flash > 0.9 && this.lastFlash <= 0.9) for (let i = 0; i < 70; i++) this.spark(660 + Math.random() * 600, 188, 1.4);
    this.lastFlash = P ? P.flash : 0;
    if (SC) {
      const g = this.fit(SC);
      g.clearRect(0, 0, 1920, 1080);
      const sparks = this.sparks;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.vy += 0.22;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 1 / 60;
        if (p.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        g.globalAlpha = Math.min(1, p.life * 1.8);
        g.strokeStyle = p.life > 0.4 ? "#fff" : "#ffb4ff";
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2);
        g.stroke();
      }
      g.globalAlpha = 1;
      const star = (x: number, y: number, r: number, rot: number) => {
        g.save();
        g.translate(x, y);
        g.rotate(rot);
        g.beginPath();
        g.moveTo(0, -r);
        g.quadraticCurveTo(0, 0, r, 0);
        g.quadraticCurveTo(0, 0, 0, r);
        g.quadraticCurveTo(0, 0, -r, 0);
        g.quadraticCurveTo(0, 0, 0, -r);
        g.fill();
        g.restore();
      };
      const gl = this.glints;
      if (gl.length) {
        g.save();
        g.fillStyle = "#fff";
        g.shadowColor = "rgba(255,190,250,.95)";
        g.shadowBlur = 16;
        for (let i = gl.length - 1; i >= 0; i--) {
          const q = (now - gl[i].t0) / gl[i].life;
          if (q >= 1) {
            gl.splice(i, 1);
            continue;
          }
          if (q < 0) continue;
          const k = Math.sin(Math.PI * q);
          const p = gl[i];
          star(p.x, p.y, p.r * k, p.rot + q * 0.8);
          star(p.x, p.y, p.r * k * 0.45, p.rot + q * 0.8 + Math.PI / 4);
        }
        g.restore();
      }
    }
    if (!this.artDone && this.artCv.current) {
      this.drawArt(this.artCv.current);
      this.artDone = true;
    }
  }

  kick(c: Key): string {
    const i = this.chapters().indexOf(c);
    return (i >= 0 ? pad(i + 1) : "--") + " · " + NAMES[c];
  }

  renderIntro() {
    const D = this.D;
    const uiO = this.state.introOut ? 0 : 1;
    const line = D.count ? `${plural(D.count, "clip")}. One year. Let's look back.` : `No clips saved in ${D.year} yet. Come back once you've clipped something.`;
    return (
      <div className="rc-intro" onPointerMove={this.introMove} onPointerLeave={this.introLeave}>
        <canvas ref={this.introCv} className="rc-cv" />
        <div className="rc-fill rc-nopt">
          <div ref={this.planetRef} className="rc-planet">
            <div className="rc-planet-holo">
              <div ref={this.holoRef} />
            </div>
            <div ref={this.specRef} className="rc-planet-spec" />
          </div>
        </div>
        <div className="rc-intro-persp" style={{ opacity: uiO }}>
          <div ref={this.titleRef} className="rc-intro-title" />
        </div>
        <div className="rc-intro-brand" style={{ opacity: uiO }}>
          <Logo size={34} style={fade(2.6, 1)} />
          <span className="rc-intro-name" style={fade(2.7, 1)}>
            SETSU RECAP
          </span>
        </div>
        <div className="rc-intro-cta" style={{ opacity: uiO }}>
          <span className="rc-intro-line" style={rise(2.9, 0.8)}>
            {line}
          </span>
          {D.count ? (
            <button
              type="button"
              className="rc-btn rc-btn-open"
              onClick={this.open}
              onPointerEnter={() => au.musicOpen(0.4, 0.6)}
              onPointerLeave={() => !this.state.introOut && au.musicOpen(0.12, 0.8)}
              style={rise(3.1, 0.8)}
            >
              Open your year
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  renderStack() {
    const D = this.D;
    const S = this.state.step;
    const g = this.state.g;
    const A = this.refA;
    const B = this.refB;
    const gs = g.stack ?? A.h * 0.5;
    const ge = g.end ?? B.h * 0.5;
    const qA = D.stackH / A.h;
    const qB = D.endH / B.h;
    const stackLine = qA < 0.005 ? `Less than 1% of ${A.name}.` : qA < 0.95 ? `About ${pct(qA)} of ${A.name}.` : qA < 1.05 ? `Almost exactly ${A.name}.` : `${qA.toFixed(1)}× ${A.name}.`;
    const endLine =
      (qB > 1.05 ? `Past ${B.name} by ${fmtLen(D.endH - B.h)}.` : qB > 0.95 ? `Right at ${B.name}.` : qB < 0.005 ? `Less than 1% of the way to ${B.name}.` : `${pct(qB)} of the way to ${B.name}.`) +
      (D.endH > 1e5 && B.kind !== "karman" ? " Your year left the atmosphere." : "");
    return (
      <div className="rc-ch">
        <canvas
          ref={this.stackCv}
          className="rc-cv"
          onPointerDown={this.stDown}
          onPointerMove={this.stMove}
          onPointerUp={this.stUp}
          style={{ cursor: S === 0 || S === 2 ? "ns-resize" : "default", touchAction: "none", left: -this.state.bx, top: -this.state.by, width: 1920 + 2 * this.state.bx, height: 1080 + 2 * this.state.by }}
        />
        <div className="rc-copy rc-nopt" style={{ left: 120, top: 120, width: 640, gap: 24 }}>
          <span className="rc-kick">{this.kick("stack")}</span>
          {S === 0 ? (
            <div className="rc-col" style={{ gap: 24 }}>
              <h1 className="rc-h1" style={rise(0.05)}>
                Print every frame you saved this year. Stack the sheets.
              </h1>
              <p className="rc-p" style={rise(0.15)}>
                {D.footageEstimated ? "About " : ""}
                {fmtN(D.frames)} frames, one sheet each. How tall is the pile next to {A.name}?
              </p>
              <div className="rc-row" style={{ gap: 28, marginTop: 8, ...rise(0.25) }}>
                <span className="rc-guess">{fmtAlt(gs)}</span>
                <button type="button" className="rc-btn" onClick={this.lockA}>
                  Lock it in
                </button>
              </div>
            </div>
          ) : null}
          {S === 1 ? (
            <div className="rc-col" style={{ gap: 22 }}>
              <span className="rc-big" style={{ ...fit(fmtLen(D.stackH), 120, 7), ...rise(1.1, 0.8) }}>
                {fmtLen(D.stackH)}
              </span>
              <p className="rc-p rc-p-lg" style={rise(1.2, 0.8)}>
                {stackLine}
              </p>
              {this.verdictEl("stack", 1.4)}
              <button type="button" className="rc-btn rc-btn-go" onClick={this.toEnd} style={{ marginTop: 14, ...rise(1.8) }}>
                Now lay them end to end<span>→</span>
              </button>
            </div>
          ) : null}
          {S === 2 ? (
            <div className="rc-col" style={{ gap: 24 }}>
              <h1 className="rc-h1" style={rise(2.4)}>
                Same sheets, end to end, pointing straight up.
              </h1>
              <p className="rc-p" style={rise(2.5)}>
                29.7 cm per sheet. How high does the line reach next to {B.name}?
              </p>
              <div className="rc-row" style={{ gap: 28, marginTop: 8, ...rise(2.9) }}>
                <span className="rc-guess">{fmtAlt(ge)}</span>
                <button type="button" className="rc-btn" onClick={this.lockB}>
                  Lock it in
                </button>
              </div>
            </div>
          ) : null}
          {S === 3 ? (
            <div className="rc-col" style={{ gap: 22 }}>
              <span className="rc-big" style={{ ...fit(fmtLen(D.endH), 120, 7), ...rise(1.4, 0.8) }}>
                {fmtLen(D.endH)}
              </span>
              <p className="rc-p rc-p-lg" style={rise(1.5, 0.8)}>
                {endLine}
              </p>
              {this.verdictEl("end", 1.7)}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  renderClock() {
    const D = this.D;
    const S = this.state.step;
    const gh = this.state.g.hour;
    const hov = this.hovG();
    return (
      <div className="rc-ch">
        <canvas
          ref={this.clockCv}
          className="rc-cv"
          onPointerDown={this.clDown}
          onPointerMove={this.clMove}
          onPointerUp={this.clUp}
          onPointerLeave={this.clLeave}
          style={{ cursor: S === 0 ? "ew-resize" : "default", touchAction: "none" }}
        />
        <div className="rc-copy rc-nopt" style={{ left: 120, top: 100, width: 660, gap: 22 }}>
          <span className="rc-kick">{this.kick("clock")}</span>
          {S === 0 ? (
            <div className="rc-col" style={{ gap: 22 }}>
              <h1 className="rc-h1" style={rise(0.05)}>
                When do you clip the most?
              </h1>
              <div className="rc-row" style={{ gap: 28, ...rise(0.15) }}>
                <p className="rc-p rc-p-flat">Drag the hand. Inner ring is 00–11, outer ring is 12–23.</p>
                <button type="button" className="rc-btn rc-btn-sm" onClick={this.lockHour} style={{ opacity: gh == null ? 0.4 : 1 }}>
                  Lock in {gh == null ? "" : pad(gh) + ":00"}
                </button>
              </div>
            </div>
          ) : null}
          {S === 1 ? (
            <div className="rc-col" style={{ gap: 18 }}>
              <h1 className="rc-h1" style={rise(2.2)}>
                {pad(D.peak)}:00 is your hour.
              </h1>
              <p className="rc-p rc-p-74" style={rise(2.3)}>
                {plural(D.byHour[D.peak], "clip")} in that hour alone.{" "}
                {D.nightShare < 0.005 ? "None of it" : D.nightShare > 0.995 ? "All of it" : `${pct(D.nightShare)} of everything`} happens after 20:00.
              </p>
              {this.verdictEl("hour", 2.5)}
              {D.hasGames ? (
                <button type="button" className="rc-btn rc-btn-go rc-btn-xs" onClick={this.toMonths} style={{ marginTop: 6, ...rise(2.9) }}>
                  Colour by game<span>→</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {S === 2 ? (
            <div className="rc-col" style={{ gap: 18 }}>
              <h1 className="rc-h1" style={rise(1.4)}>
                {D.hasGames && D.topGames[0] ? `${shortName(D.topGames[0].name)} rules your clock.` : "Your clock."}
              </h1>
              <p className="rc-p rc-p-74" style={rise(1.5)}>
                Every block is a clip, coloured by game. Hover one to light up the rest.
              </p>
              <div className="rc-row" style={{ gap: 14, minHeight: 56, ...fade(2, 0.6) }}>
                {hov.on ? (
                  <div className="rc-hov">
                    <div className="rc-icon" style={{ width: 40, height: 40, borderRadius: 10, backgroundImage: bgOf(hov.srcs) }} />
                    <div className="rc-col" style={{ gap: 6 }}>
                      <span className="rc-hov-name">{hov.name}</span>
                      <span className="rc-hov-n">{hov.n}</span>
                    </div>
                  </div>
                ) : null}
                {hov.off ? <span className="rc-hint">HOVER ANY BLOCK TO LIGHT UP ITS GAME</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  renderOrbit() {
    const D = this.D;
    const st = this.state;
    const S = st.step;
    const F = D.friends;
    const top = F[0];
    const whoOpts = [1, 0, 3, 2]
      .map((i) => F[i])
      .filter(Boolean)
      .slice(0, 4);
    const sf = F.find((f) => f.id === (st.sel || top.id)) || top;
    // a tie for first is everyone in it, the verdict already counts any of them as right
    const tied = F.filter((f) => f.clips === top.clips);
    let duo: { name: string; n: number } | null = null;
    for (const k in D.pairs) {
      const [a, b] = k.split("-");
      if (a !== sf.id && b !== sf.id) continue;
      const o = F.find((f) => f.id === (a === sf.id ? b : a));
      if (o && (!duo || D.pairs[k] > duo.n)) duo = { name: o.name, n: D.pairs[k] };
    }
    return (
      <div className="rc-ch">
        <canvas
          ref={this.orbitCv}
          className="rc-cv"
          onPointerMove={this.orbitMove}
          onPointerLeave={this.orbitLeave}
          onClick={this.orbitClick}
          style={{ cursor: st.hover ? "pointer" : "default" }}
        />
        <div className="rc-copy rc-nopt" style={{ left: 120, top: 120, width: 640, gap: 22 }}>
          <span className="rc-kick">{this.kick("orbit")}</span>
          {S === 0 ? (
            <h1 className="rc-h1" style={rise(0.05)}>
              Who shows up in your clips the most?
            </h1>
          ) : (
            <div className="rc-col" style={{ gap: 18 }}>
              <h1 className="rc-h1 rc-h1-56" style={rise(0.4)}>
                {tied.length > 2 ? `${tied[0].name}, ${tied[1].name} and more.` : tied.map((f) => f.name).join(" and ") + "."}
              </h1>
              {this.verdictEl("who", 0.6)}
            </div>
          )}
        </div>
        <div className="rc-orbit-side">
          {S === 0 ? (
            <div className="rc-who">
              {whoOpts.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  className="rc-who-opt"
                  style={{ ...pop(0.2 + i * 0.08) }}
                  onClick={() => {
                    this.rv("who", { g: { ...this.state.g, who: f.id } });
                    au.play("push-end", { gain: 0.6 });
                    this.setStep(1);
                  }}
                >
                  <div className="rc-av" style={{ width: 88, height: 88, backgroundImage: f.av ? `url("${f.av}")` : undefined }} />
                  <span className="rc-who-name">{f.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rc-friend" style={rise(0.9, 0.6)}>
              <div className="rc-row" style={{ gap: 16 }}>
                <div className="rc-av" style={{ width: 76, height: 76, flex: "none", backgroundImage: sf.av ? `url("${sf.av}")` : undefined, boxShadow: `0 0 0 3px ${sf.color}` }} />
                <div className="rc-col" style={{ gap: 8, minWidth: 0 }}>
                  <span className="rc-friend-name">{sf.name}</span>
                  <span className="rc-friend-user">@{sf.user}</span>
                </div>
              </div>
              <div className="rc-row rc-baseline" style={{ gap: 12 }}>
                <span className="rc-friend-n" style={fit(fmtN(sf.clips), 64, 4)}>
                  {fmtN(sf.clips)}
                </span>
                <span className="rc-friend-since">
                  {sf.clips === 1 ? "clip" : "clips"} together
                  <br />
                  since {D.cal.fmtD(sf.first)}
                </span>
              </div>
              <div className="rc-col" style={{ gap: 10 }}>
                {sf.games.map((gm) => (
                  <div key={gm.name} className="rc-row" style={{ gap: 12 }}>
                    <div className="rc-icon" style={{ width: 30, height: 30, borderRadius: 8, backgroundImage: bgOf(gm.srcs.length ? gm.srcs : [starUrl]) }} />
                    <span className="rc-friend-game">{gm.name}</span>
                    <span className="rc-friend-gn">{fmtN(gm.n)}</span>
                  </div>
                ))}
              </div>
              {duo ? (
                <span className="rc-friend-duo">
                  Shows up with {duo.name} in {fmtN(duo.n)} of those.
                </span>
              ) : null}
              <span className="rc-hint rc-hint-sm">CLICK ANYONE IN ORBIT</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  renderCut() {
    const D = this.D;
    const st = this.state;
    const S = st.step;
    const T = D.trims;
    const cutA = S === 1 || (S === 0 && !D.hasTrims);
    const cutQ = S === 0 && D.hasTrims;
    const ks = D.hasTrims ? T.s : 0;
    const kw = D.hasTrims ? T.e - T.s : 1;
    // a range near the start puts the label under the verdict, so it sits past the line's end or at its right edge
    const keepLab: CSSProperties = !D.hasTrims || ks >= 0.3 ? {} : ks + kw < 0.75 ? { left: "calc(100% + 16px)" } : { left: "auto", right: 0 };
    return (
      <div className="rc-ch rc-cut">
        <div className="rc-copy" style={{ left: 120, top: 120, width: 1000, gap: 24 }}>
          <span className="rc-kick">{this.kick("cut")}</span>
          {cutQ ? (
            <div className="rc-col" style={{ gap: 24 }}>
              <h1 className="rc-h1" style={rise(0.05)}>
                How much of a minute do you actually keep?
              </h1>
              <p className="rc-p rc-p-flat" style={rise(0.15)}>
                Drag the handles to where your average trim lands.
              </p>
              <div className="rc-row" style={{ gap: 28, marginTop: 6, ...rise(0.25) }}>
                <span className="rc-guess rc-guess-auto">{Math.round((st.ce - st.cs) * 60)} s</span>
                <span className="rc-cut-read">
                  {fmtS(st.cs)} → {fmtS(st.ce)}
                </span>
                <button type="button" className="rc-btn" onClick={this.lockCut}>
                  Lock it in
                </button>
              </div>
            </div>
          ) : null}
          {cutA ? (
            <div className="rc-col" style={{ gap: 20 }}>
              <h1 className="rc-h1 rc-h1-64" style={rise(0.9)}>
                {D.hasTrims ? `About ${Math.round((T.e - T.s) * 60)} seconds.` : "You keep every second."}
              </h1>
              <p className="rc-p rc-p-74" style={{ maxWidth: 760, ...rise(1) }}>
                {D.hasTrims
                  ? `${cutWhere(T.s, T.e)} ${fmtS(T.s)} to ${fmtS(T.e)}. Taller bars are seconds that survived more often.`
                  : D.trimmed
                    ? `${plural(D.count, "clip")} and barely a trim. The whole minute, almost every time.`
                    : `${plural(D.count, "clip")} and not a single trim. The whole minute, every time.`}
              </p>
              {this.verdictEl("cut", 1.3)}
            </div>
          ) : null}
        </div>
        <div className="rc-bars">
          {Array.from({ length: 60 }, (_, i) => {
            const v = D.hasTrims ? T.surv[i] : 1;
            const inW = D.hasTrims ? i / 60 >= T.s - 0.005 && i / 60 < T.e : true;
            return (
              <div
                // remounted for the answer, or the grow animation never replays after the lock
                key={cutA ? "a" + i : i}
                className="rc-bar"
                style={{
                  height: cutA ? Math.max(0.02, v) * 100 + "%" : "0%",
                  background: cutA && inW ? "linear-gradient(180deg,#ff7bff,#e80bee 40%,#a506e6)" : "rgba(199,116,224,.22)",
                  animationDelay: cutA ? (0.1 + i * 0.012).toFixed(3) + "s" : "0s",
                }}
              />
            );
          })}
        </div>
        {cutA ? (
          <div className="rc-keep-line" style={{ left: 120 + 1680 * ks, width: 1680 * kw }}>
            <span style={keepLab}>WHAT YOU KEEP · {D.hasTrims ? `${fmtS(T.s)} → ${fmtS(T.e)}` : "EVERYTHING"}</span>
          </div>
        ) : null}
        <div
          ref={this.trackRef}
          className="rc-track"
          onPointerDown={this.cutDown}
          onPointerMove={this.cutMove}
          onPointerUp={this.cutUp}
          style={{ cursor: cutQ ? "ew-resize" : "default" }}
        >
          {cutA ? <div className="rc-track-keep" style={{ left: ks * 100 + "%", width: kw * 100 + "%" }} /> : null}
          <div
            className="rc-track-guess"
            style={{
              left: st.cs * 100 + "%",
              width: (st.ce - st.cs) * 100 + "%",
              borderColor: D.hasTrims ? (cutA ? "rgba(255,255,255,.85)" : "#f3f1f7") : "transparent",
              background: cutQ ? "linear-gradient(90deg,rgba(232,11,238,.55),rgba(165,6,230,.55))" : "transparent",
            }}
          />
          <div className="rc-track-handle" style={{ left: st.cs * 100 + "%", opacity: cutQ ? 1 : 0 }} />
          <div className="rc-track-handle" style={{ left: st.ce * 100 + "%", opacity: cutQ ? 1 : 0 }} />
        </div>
        <div className="rc-track-scale">
          <span>0:00</span>
          <span>0:15</span>
          <span>0:30</span>
          <span>0:45</span>
          <span>1:00</span>
        </div>
      </div>
    );
  }

  renderRepeat() {
    const D = this.D;
    const st = this.state;
    const S = st.step;
    const W = D.watch!;
    const n = W.sessions;
    const rpPlay = S === 1 && st.vph === "play";
    const filter = S === 0 ? "blur(28px) brightness(.45) saturate(1.3)" : rpPlay ? "none" : S === 1 ? "blur(14px) brightness(.5)" : "blur(22px) brightness(.42) saturate(1.2)";
    const opts = [Math.max(2, Math.round(n * 0.35)), n, Math.round(n * 2.3)];
    const meta = [W.date, W.game].filter(Boolean).join(" · ");
    return (
      <div className="rc-ch rc-repeat">
        <video
          ref={this.vidRef}
          className="rc-video"
          src={`${fileUrl(W.video)}#t=${W.start.toFixed(2)}`}
          poster={W.poster ? fileUrl(W.poster) : undefined}
          playsInline
          preload="auto"
          onEnded={this.vidEnded}
          onError={this.vidErr}
          onTimeUpdate={this.vidTime}
          onClick={rpPlay ? this.togglePlay : undefined}
          style={{ filter, transform: `scale(${rpPlay ? 1 : 1.08})`, cursor: rpPlay ? "pointer" : undefined, opacity: st.vbad && !W.poster ? 0 : undefined }}
        />
        {S === 0 ? (
          <>
            <div className="rc-fill rc-repeat-shade" />
            <div className="rc-copy" style={{ left: 120, top: 120, width: 820, gap: 26 }}>
              <span className="rc-kick">{this.kick("repeat")}</span>
              <h1 className="rc-h1 rc-h1-52" style={rise(0.05)}>
                One clip you kept coming back to. How many times did you watch it?
              </h1>
              <div className="rc-row" style={{ gap: 16, marginTop: 20 }}>
                {opts.map((v, i) => (
                  <button
                    key={i}
                    type="button"
                    className="rc-rw-opt"
                    style={pop(0.3 + i * 0.08)}
                    onClick={() => {
                      this.rv("rw", { g: { ...this.state.g, rw: v } });
                      au.play("push-end", { gain: 0.6 });
                      this.setStep(1);
                    }}
                  >
                    {v}×
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
        {S === 1 && st.vph === "intro" ? (
          <div className="rc-fill rc-rp-intro">
            <span className="rc-rp-kick">YOUR MOST-WATCHED CLIP OF {D.year}</span>
            <span className="rc-rp-title" style={rise(0.15)}>
              “{W.title}”
            </span>
            {meta ? <span className="rc-rp-meta">{meta}</span> : null}
          </div>
        ) : null}
        {rpPlay ? (
          <>
            <div className="rc-vp" onPointerDown={this.seekClip} onPointerMove={this.seekClip}>
              <div style={{ width: st.vp * 100 + "%" }} />
            </div>
            <div className="rc-vctl">
              <button type="button" className="rc-vbtn" onClick={this.togglePlay} aria-label={st.paused ? "Play" : "Pause"}>
                {st.paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
              </button>
              <button type="button" className="rc-vbtn rc-vbtn-txt" onClick={this.toggleMute}>
                {st.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                {st.muted ? "SOUND OFF" : "SOUND ON"}
              </button>
            </div>
            <button type="button" className="rc-vbtn rc-vbtn-txt rc-vskip" onClick={this.skipClip}>
              SKIP CLIP
              <SkipForward size={16} />
            </button>
          </>
        ) : null}
        {S === 2 ? (
          <>
            <div className="rc-fill rc-repeat-fade" />
            <div className="rc-rp-answer">
              <span className="rc-kick">{this.kick("repeat")}</span>
              <span className="rc-rp-big" style={pop(0.2, 0.8)}>
                {n}×
              </span>
              <span className="rc-rp-name" style={rise(0.5)}>
                “{W.title}”
              </span>
              {this.verdictEl("rw", 0.7)}
              {st.vbad ? null : (
                <button type="button" className="rc-btn-ghost" onClick={this.replayClip} style={{ alignSelf: "flex-start", ...rise(1.1) }}>
                  Watch again
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  /** the year's other numbers, most telling first, one per star */
  chartStats(): Stat[] {
    return statsOf(this.D).slice(0, CHART.length);
  }

  /** which star the pointer is on, by distance with some slack before it lets go: element enter and
   * leave fired again on every wobble across the gap between a star and its label */
  chartMove(x: number, y: number) {
    const n = this.chartStats().length;
    const el = (performance.now() - this.stepT) / 1000;
    const near = (i: number, r: number) => el > CHART_T0 + i * CHART_DT && Math.hypot(x - CHART[i][0], y - CHART[i][1]) < r + (i ? 0 : 12);
    const cur = this.state.hot;
    if (cur >= 0 && near(cur, 95)) return;
    let hot = -1;
    for (let i = 0; i < n; i++) if (near(i, 60)) hot = i;
    if (hot === cur) return;
    this.setState({ hot });
    if (hot >= 0) this.traceStar(hot, n);
  }

  /** stars hovered in order, first to last, stay lit and light the line to them; all of them lights
   * the constellation. going back over lit ones doesn't count, skipping ahead starts over */
  traceStar(i: number, n: number) {
    const k = this.state.lit;
    const pan = (CHART[i][0] - 1200) / 900;
    if (n < 3 || k >= n || i < k || (i > k && k === 0)) {
      au.sparkle(starHz(i), { gain: 0.4, n: 2, decay: 0.6, pan });
      return;
    }
    if (i > k) {
      au.sparkle(starHz(i), { gain: 0.4, n: 2, decay: 0.6, pan });
      this.setState({ lit: 0 });
      return;
    }
    au.sparkle(starHz(i), { gain: 0.55, n: 3, decay: 0.8, pan });
    this.setState({ lit: k + 1 });
    if (k + 1 < n) return;
    au.starfall([0, 1, 2, 3, 4, 5, 6, 7].map(starHz), { gain: 0.9 });
    au.play("stinger-crown", { at: 0.1, gain: 0.6 });
  }

  renderChart() {
    const D = this.D;
    const stats = this.chartStats();
    const pts = CHART.slice(0, stats.length);
    const T = (i: number) => CHART_T0 + i * CHART_DT;
    const { lit, hot } = this.state;
    const traced = stats.length >= 3 && lit >= stats.length;
    const sides = chartSides(stats);
    return (
      <div className={"rc-ch rc-chart" + (traced ? " traced" : "")}>
        <div className="rc-copy rc-nopt" style={{ left: 120, top: 120, width: 560, gap: 24 }}>
          <span className="rc-kick">{this.kick("chart")}</span>
          <h1 className="rc-h1" style={rise(0.05)}>
            Everything else you did, charted.
          </h1>
          <p className="rc-p" style={rise(0.15)}>
            {D.span ? `${D.span}. ` : ""}Every star is something you did in Setsu. Hover one.
          </p>
        </div>
        <svg className="rc-chart-lines" viewBox="0 0 1920 1080" aria-hidden>
          {CHART_DUST.map(([x, y, a], i) => (
            <circle key={"d" + i} cx={x} cy={y} r={1.6} fill="#e9dcff" style={{ opacity: a, ...fade(0.2 + (i % 7) * 0.1, 1.2) }} />
          ))}
          <g>
            {pts.slice(1).map(([x, y], i) => (
              <line key={i} x1={pts[i][0]} y1={pts[i][1]} x2={x} y2={y} pathLength={1} style={{ animationDelay: (T(i) + 0.04).toFixed(2) + "s" }} />
            ))}
            {traced
              ? null
              : pts.slice(1, lit).map(([x, y], i) => <line key={"t" + i} className="rc-trace" x1={pts[i][0]} y1={pts[i][1]} x2={x} y2={y} pathLength={1} />)}
          </g>
        </svg>
        {stats.map((st, i) => (
          <button
            key={st.l}
            type="button"
            className={"rc-node" + (i === 0 ? " rc-node-big" : "") + (i === hot ? " on" : "") + (i < lit && !traced ? " lit" : "")}
            style={{ left: pts[i][0], top: pts[i][1], ["--d" as string]: T(i).toFixed(2) + "s", ["--tw" as string]: (2.4 + (i % 4) * 0.7).toFixed(1) + "s" }}
          >
            <span className="rc-node-star" style={{ backgroundImage: `url("${starUrl}")` }} />
            <span className={"rc-node-lab " + sides[i]}>
              <span className="rc-node-v">{st.v}</span>
              <span className="rc-node-l">{st.l}</span>
              {st.n ? <span className="rc-node-n">{st.n}</span> : null}
            </span>
          </button>
        ))}
      </div>
    );
  }

  renderCard() {
    const D = this.D;
    const st = this.state;
    const ph = st.cardPh;
    const tp = typeOf(D);
    const asked = Object.keys(st.rev) as Array<keyof State["rev"]>;
    const score = asked.filter((k) => this.correct(k)).length;
    const chips = this.cardChips();
    const packHint: Record<PackPhase, string> = {
      enter: "",
      idle: "Trace the line across the top of the pack.",
      trace: "All the way across.",
      armed: "Now let go.",
      rip: "",
      done: "",
    };
    const hint = ph === "pack" ? packHint[st.packPh] : st.flipHint && !this.revealed ? "Click the card to flip it." : "";
    const open = ph === "back" || ph === "front";
    const holo = (o: number): CSSProperties => ({ opacity: `calc(var(--o,.5) * ${o} * var(--hi,1))` });
    return (
      <div className="rc-ch rc-card-ch">
        <span className="rc-kick rc-kick-abs">{this.kick("card")}</span>
        <div ref={this.dimRef} className="rc-fill rc-card-dim" />
        <div ref={this.raysRef} className="rc-rays" />
        <canvas key={`b${this.packGen}`} ref={this.packBackCv} data-gen={this.packGen} className="rc-cv rc-pack-cv" />
        <div
          ref={this.stageRef}
          className="rc-card-stage"
          onPointerDown={this.cardDown}
          onPointerMove={this.cardMove}
          onPointerUp={this.cardUp}
          onPointerLeave={this.cardLeave}
          onClick={this.cardClick}
          onPointerCancel={this.cardUp}
          style={{ cursor: ph === "pack" ? (st.packPh === "idle" || st.packPh === "trace" || st.packPh === "armed" ? "crosshair" : "default") : "pointer" }}
        >
          <div ref={this.shadowRef} className="rc-card-shadow" />
          <div ref={this.tiltRef} className="rc-tilt">
            <div ref={this.cardRef} className="rc-card">
              <div ref={this.flipRef} className="rc-flip">
                <div ref={this.frontRef} className="rc-face rc-front">
                  <div className="rc-face-in rc-front-in">
                    <div className="rc-fill rc-front-glow" />
                    <div className="rc-front-body">
                      <div className="rc-front-top">
                        <span>SETSU · {D.year}</span>
                        <span>No. {String(D.count).padStart(4, "0")}</span>
                      </div>
                      <div className="rc-row rc-front-count">
                        <span className="rc-front-n" style={fit(fmtN(D.count), 120, 3)}>
                          {fmtN(D.count)}
                        </span>
                        <div className="rc-col" style={{ gap: 8, paddingBottom: 4 }}>
                          <span className="rc-front-saved">{D.count === 1 ? "clip saved" : "clips saved"}</span>
                          {D.seconds > 0 ? <span className="rc-front-footage">{fmtDur(D.seconds)} of footage</span> : null}
                        </div>
                      </div>
                      <div className="rc-art">
                        <canvas ref={this.artCv} width={904} height={360} />
                        <div className="rc-art-top">
                          <span>YOUR DAY · 06 → 06</span>
                          <span>PEAK {pad(D.peak)}:00</span>
                        </div>
                        <div className="rc-fill rc-holo rc-holo-art" style={holo(0.8)} />
                      </div>
                      <div className="rc-col" style={{ gap: 8 }}>
                        <span className="rc-type">{tp[0]}</span>
                        <span className="rc-type-line">{tp[1]}</span>
                      </div>
                      <div className="rc-chips">
                        {chips.map((s) => (
                          <div key={s.l} className="rc-chip">
                            {s.srcs ? <div className="rc-icon" style={{ width: 34, height: 34, borderRadius: s.rad, backgroundImage: bgOf(st.inl[s.srcs.join("|")] ? [st.inl[s.srcs.join("|")]] : s.srcs) }} /> : null}
                            <div className="rc-col" style={{ gap: 6, minWidth: 0 }}>
                              <span className="rc-chip-l">{s.l}</span>
                              <span className="rc-chip-v">{s.v}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="rc-front-foot">
                        <div className="rc-row rc-baseline" style={{ gap: 10 }}>
                          <span className="rc-front-name">{D.owner.name.toUpperCase()}</span>
                          {D.owner.handle ? <span className="rc-front-handle">@{D.owner.handle}</span> : null}
                        </div>
                        <div className="rc-row" style={{ gap: 12 }}>
                          <span className="rc-front-score">{asked.length ? `GUESSED ${score}/${asked.length}` : D.activeDays ? plural(D.activeDays, "DAY", "DAYS") : ""}</span>
                          <img src={starUrl} alt="" style={{ width: 20, height: 20 }} />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="rc-fill rc-holo" style={holo(0.45)} />
                  <div className="rc-fill rc-spec" />
                </div>
                <div className="rc-face rc-back">
                  <div className="rc-face-in rc-back-in">
                    <div className="rc-fill rc-back-stars" style={{ backgroundImage: `url("${starUrl}")` }} />
                    <div className="rc-back-ring" />
                    <div className="rc-fill rc-back-body">
                      <Logo size={210} />
                      <span className="rc-back-name">SETSU</span>
                      <span className="rc-back-sub">RECAP {D.year}</span>
                    </div>
                  </div>
                  <div className="rc-fill rc-holo" style={holo(0.5)} />
                  <div className="rc-fill rc-spec" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <canvas key={`f${this.packGen}`} ref={this.packFrontCv} data-gen={this.packGen} className="rc-cv rc-pack-cv" />
        <canvas ref={this.sparkCv} className="rc-cv rc-sparks" />
        <div ref={this.flashLineRef} className="rc-flash-line" />
        <div ref={this.flashRef} className="rc-fill rc-flash" />
        <div className="rc-card-side">
          {hint ? (
            <span key={hint} className="rc-card-hint" style={fade(0, 0.6)}>
              {hint}
            </span>
          ) : null}
          {open && this.revealed ? (
            <div className="rc-share" style={rise(0.5, 0.6)}>
              <span className="rc-share-kick">
                {st.shareUrl ? <i className="rc-live" /> : null}
                {st.shareUrl ? "LIVE · ANYONE WITH THE LINK" : "SHARE YOUR YEAR"}
              </span>
              {st.shareUrl ? (
                <div className="rc-link">
                  <button type="button" className="rc-link-url" onClick={this.copyLink} title="Copy link">
                    {st.shareUrl.replace(/^https:\/\//, "")}
                  </button>
                  <button type="button" className="rc-ibtn" onClick={this.copyLink} title="Copy link" aria-label="Copy link">
                    <Copy size={16} />
                  </button>
                  <button type="button" className="rc-ibtn" onClick={() => void window.clips.openRecapShare(D.year)} title="Open in browser" aria-label="Open in browser">
                    <ExternalLink size={16} />
                  </button>
                </div>
              ) : (
                <button type="button" className="rc-btn rc-share-go" onClick={this.doShare} disabled={st.sharing}>
                  <Link2 size={18} />
                  {st.sharing ? "Making your link…" : "Get share link"}
                </button>
              )}
              <div className="rc-share-row">
                {D.friends.length ? (
                  <button type="button" role="switch" aria-checked={st.crew} className={"rc-crew" + (st.crew ? " on" : "")} onClick={() => this.setCrew(!st.crew)} disabled={st.sharing} title="Show who you play with on the shared page">
                    <span className="rc-crew-avs">
                      {D.friends.slice(0, 3).map((f) => (
                        <i key={f.id} style={{ backgroundImage: f.av ? `url("${f.av}")` : undefined }} />
                      ))}
                    </span>
                    Crew
                    <span className="rc-sw" />
                  </button>
                ) : null}
                <span style={{ flex: 1 }} />
                <button type="button" className="rc-ibtn" onClick={this.doSave} title="Save image" aria-label="Save image">
                  <Download size={16} />
                </button>
                <button type="button" className="rc-ibtn" onClick={this.doCopy} title="Copy image" aria-label="Copy image">
                  <ImageIcon size={16} />
                </button>
              </div>
              {st.shareUrl ? (
                <button type="button" className="rc-unshare" onClick={this.unshare}>
                  Stop sharing
                </button>
              ) : null}
            </div>
          ) : null}
          {st.toast ? (
            <span className="rc-toast" style={pop(0, 0.35)}>
              {st.toast}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  renderChrome() {
    const st = this.state;
    const CH = this.chapters();
    const lastCh = st.ci === CH.length - 1;
    const left = this.left();
    const nextLab = lastCh ? "Start over" : left ? "Skip" : "Next";
    const playing = this.curKey() === "repeat" && st.step === 1 && st.vph === "play";
    return (
      <div className="rc-chrome" style={{ opacity: playing ? 0 : 1 }}>
        <button type="button" className="rc-chrome-prev" onClick={this.prev} aria-label="Back">
          ←
        </button>
        <div className="rc-segs">
          {CH.map((c, i) => (
            <button
              key={c}
              type="button"
              className="rc-seg"
              aria-label={NAMES[c]}
              onClick={() => this.go(i)}
              style={{ background: i < st.ci ? "rgba(243,241,247,.55)" : i === st.ci ? "#f3f1f7" : "rgba(243,241,247,.16)" }}
            />
          ))}
        </div>
        <button type="button" className={"rc-chrome-next" + (lastCh ? "" : left ? " is-skip" : " is-done")} onClick={this.next}>
          {nextLab}
          <span>→</span>
        </button>
      </div>
    );
  }

  render() {
    const st = this.state;
    const key = this.curKey();
    return (
      <>
      <div className="rc-root" ref={this.rootRef} onPointerOver={this.overUi} onPointerDown={this.rootDown} onPointerMove={this.rootMove} onPointerLeave={this.rootLeave}>
        <canvas ref={this.skyCv} className="rc-sky" />
        <div className="rc-stage" ref={this.stgRef} style={{ transform: `scale(${st.k})`, ["--bx" as string]: st.bx + "px", ["--by" as string]: st.by + "px" }}>
          {st.intro ? this.renderIntro() : null}
          {key === "stack" ? this.renderStack() : null}
          {key === "clock" ? this.renderClock() : null}
          {key === "orbit" ? this.renderOrbit() : null}
          {key === "cut" ? this.renderCut() : null}
          {key === "repeat" ? this.renderRepeat() : null}
          {key === "chart" ? this.renderChart() : null}
          {key === "card" ? this.renderCard() : null}
          {!st.intro ? this.renderChrome() : null}
        </div>
        <button type="button" className="rc-close rc-sound" onClick={this.toggleSound} aria-label={st.soundOff ? "Sound on" : "Sound off"} title={st.soundOff ? "Sound on (M)" : "Sound off (M)"}>
          {st.soundOff ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <button type="button" className="rc-close" onClick={this.close} aria-label="Close recap">
          <X size={18} />
        </button>
      </div>
      <MixPanel />
      </>
    );
  }
}

// the booster pack of the card chapter, timed against the Pokemon TCG Pocket opening: a glossy
// filled pouch with pressed-in sides, a tear that follows the pointer and curls the cut part of
// the lid toward you, the rip on release, the lid tumbling off, the pouch tipping its mouth open
// to show the silver inside, then the card rising while the pouch drops away.
// three.js draws it into two canvases, one behind and one in front of the dom card, so the real
// card slides out between the pouch's back and front. coordinates are stage px (1920x1080, y down)
import * as THREE from "three";
import { DISPLAY, MONO, cl, eio, eo, eob } from "./model";
// the pack's saying in Shippori Mincho B1 (OFL, license next to it), cut down to its six glyphs by
// Google Fonts' text= subsetting: 3 KB where the whole font would be megabytes
import minchoUrl from "../assets/fonts/setsuna-mincho.woff2?url";

const MINCHO = '"Setsu Mincho", serif';
let mincho: Promise<unknown> | null = null;
const loadMincho = () =>
  (mincho ??= new FontFace("Setsu Mincho", `url(${minchoUrl})`, { weight: "700" })
    .load()
    .then((f) => document.fonts.add(f))
    .catch(() => null));

const W = 600;
const H = 860;
// the printed cut line, this far below the top edge
const CUT = 96;
// lid and body overlap by this much around the cut, the torn path decides who draws what
const BAND = 24;
// grid rows are this far apart where lid and body overlap, so both cut the same triangles
const ROW = 6;
// the front lip that rolls outward once the mouth opens
const LIP = 44;
// a torn lid bends over this much of its height, the rest stays a flat flap
const BEND = 30;
// the entrance takes this long, in s, and lands this far through
const ENTER = 1.7;
const LAND = 0.78;
// pack centre on the stage
const CX = 960;
const CY = 522;
// how far the face bulges, and how much the filled middle pulls the long sides in
const BULGE = 30;
const PINCH = 0.036;
// matches the css perspective of the card stage, so the dom card lines up with the pouch
const DIST = 1800;
// samples of the torn path across the width, stored as px off the printed line
const NPATH = 97;
const PATH_RANGE = 32;
// a press this close to a side, as a share of the width, starts the tear at that side's notch
const EDGE = 0.14;

export type PackPhase = "enter" | "idle" | "trace" | "armed" | "rip" | "done";

export interface PackEvents {
  phase(p: PackPhase): void;
  /** fired once the pouch has dropped away and the card stands on its own */
  done(): void;
  /** land: the entrance spin settles, the moment for the chime and the burst */
  sound(name: "rip" | "cardOut" | "shine" | "land" | "hop" | "hopLand"): void;
  /** the cut moved, progress 0..1 up to where the line counts as complete */
  cut(progress: number): void;
}

const smooth = (a: number, b: number, x: number) => {
  const t = cl((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** the closed pouch: pack px in (x from -300, y from the top), local 3d out */
function surf(x: number, y: number, side: 1 | -1, out: THREE.Vector3): THREE.Vector3 {
  const u = Math.min(1, Math.abs(x) / (W / 2));
  // full across the face, falling off hard into a flat pressed edge
  const a = u >= 0.975 ? 0 : Math.sqrt(1 - Math.pow(u / 0.975, 4));
  const v = y / H;
  const b = smooth(0.035, 0.1, v) * (1 - smooth(0.9, 0.965, v));
  const dent = Math.sin(x * 0.019 + 1.3) * Math.sin(y * 0.013 + 0.4) + Math.sin(x * 0.041 + y * 0.027) * 0.5;
  const z = a * b * (BULGE + dent * 0.7) * (side < 0 ? 0.92 : 1);
  // the sealed ends keep their width, the filled middle pulls the sides in. the films stay a hair
  // apart at the seals, or the back's silver inside z-fights through the front
  return out.set(x * (1 - PINCH * b * u * u), H / 2 - y, side * Math.max(z, 0.8));
}

interface Surface {
  geo: THREE.BufferGeometry;
  /** pack px of each vertex: x from -300, y from the top */
  base: Float32Array;
  side: 1 | -1;
}

function surface(ys: number[], nx: number, side: 1 | -1): Surface {
  const geo = new THREE.BufferGeometry();
  const ny = ys.length - 1;
  const count = (nx + 1) * (ny + 1);
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const base = new Float32Array(count * 2);
  const v = new THREE.Vector3();
  let k = 0;
  for (const y of ys) {
    for (let i = 0; i <= nx; i++) {
      const x = -W / 2 + (W * i) / nx;
      surf(x, y, side, v);
      pos.set([v.x, v.y, v.z], k * 3);
      base.set([x, y], k * 2);
      uv.set([(x + W / 2) / W, 1 - y / H], k * 2);
      k++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const c = a + nx + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  geo.setIndex(idx);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("aPack", new THREE.BufferAttribute(base.slice(), 2));
  geo.computeVertexNormals();
  // rewritten every frame while the pack bends; static buffers stalled ANGLE's d3d11 backend
  // and halved the frame rate during the rip
  (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geo.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  return { geo, base, side };
}

const rows = (y0: number, y1: number, step: number) => {
  const out: number[] = [];
  for (let y = y0; y < y1 - 0.01; y += step) out.push(y);
  out.push(y1);
  return out;
};

// glow along a ribbon: soft across it, lit between uA and uB, a flare at the head
const LINE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const LINE_FRAG = /* glsl */ `
uniform float uA;
uniform float uB;
uniform float uHead;
uniform float uOn;
uniform float uPulse;
uniform float uHint;
uniform vec3 uCol;
varying vec2 vUv;
void main() {
  float x = vUv.x;
  float d = abs(vUv.y * 2.0 - 1.0);
  float glow = exp(-d * d * 7.0);
  float core = smoothstep(0.24, 0.0, d);
  float lit = smoothstep(uA - 0.012, uA, x) * smoothstep(uB + 0.012, uB, x) * uOn;
  vec3 col = uCol * glow * lit * (1.4 + uPulse);
  col += vec3(1.0) * core * lit * (1.1 + uPulse * 0.8);
  col += vec3(1.0, 0.86, 1.0) * glow * exp(-pow((x - uHead) * 22.0, 2.0)) * 2.2 * uOn;
  col += vec3(1.0, 0.92, 1.0) * glow * exp(-pow((x - uHint) * 30.0, 2.0)) * 1.3;
  gl_FragColor = vec4(col, 1.0);
}`;

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.25, "rgba(230,240,255,.6)");
  r.addColorStop(1, "rgba(200,220,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const loadImg = (src: string) =>
  new Promise<HTMLImageElement>((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(i);
    i.src = src;
  });

type Ctx = CanvasRenderingContext2D & { letterSpacing: string };

// the art's landmarks in pack px: the star the rays come from and the planet's horizon
const SUN_Y = 318;
const HORIZON = 676;
const PLANET_R = 760;

const sparkle = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.quadraticCurveTo(x, y, x, y + r);
  g.quadraticCurveTo(x, y, x - r, y);
  g.quadraticCurveTo(x, y, x, y - r);
  g.fill();
};

/** the printed sides, the foil map and the shared alpha (zigzag seal ends, everything else solid).
 * foil packs iridescence, roughness and metalness into r, g, b, the channels three reads them from */
async function drawArt(year: number, corners: string, star: string) {
  await Promise.all([document.fonts.load(`700 80px ${DISPLAY}`), document.fonts.load(`600 14px ${DISPLAY}`), document.fonts.load(`500 15px ${MONO}`), loadMincho()]).catch(() => null);
  const [ci, si] = await Promise.all([loadImg(corners), loadImg(star)]);
  const S = 1024 / W;
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = Math.round(W * S);
    c.height = Math.round(H * S);
    const g = c.getContext("2d")! as Ctx;
    g.scale(S, S);
    return { c, g };
  };
  // the same shapes go on the print and on the foil map, so each takes its fill
  let sd = 3;
  const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const rayAngles: Array<[number, number]> = [];
  for (let i = 0; i < 26; i++) {
    const a0 = (i / 26) * Math.PI * 2 + 0.06;
    rayAngles.push([a0, a0 + (Math.PI / 26) * (0.55 + 0.6 * rnd())]);
  }
  const rays = (g: CanvasRenderingContext2D, stops: string[]) => {
    const rg = g.createRadialGradient(W / 2, SUN_Y, 30, W / 2, SUN_Y, 640);
    stops.forEach((c, i) => rg.addColorStop(i / (stops.length - 1), c));
    g.fillStyle = rg;
    for (const [a0, a1] of rayAngles) {
      g.beginPath();
      g.moveTo(W / 2, SUN_Y);
      g.arc(W / 2, SUN_Y, 900, a0, a1);
      g.closePath();
      g.fill();
    }
  };
  const sparks: Array<[number, number, number]> = [];
  for (let i = 0; i < 16; i++) {
    const x = 30 + rnd() * (W - 60);
    const y = CUT + 30 + rnd() * (HORIZON - CUT - 80);
    // not on top of the mark or the name
    if (Math.abs(x - W / 2) < 150 && y > SUN_Y - 130 && y < 620) continue;
    sparks.push([x, y, 5 + rnd() * rnd() * 20]);
  }
  const planet = (g: CanvasRenderingContext2D) => {
    g.beginPath();
    g.arc(W / 2, HORIZON + PLANET_R, PLANET_R, 0, Math.PI * 2);
  };
  const word = (g: Ctx) => {
    g.font = `700 80px ${DISPLAY}`;
    g.letterSpacing = "0.1em";
    g.textAlign = "center";
    g.textBaseline = "middle";
  };
  const WORD_Y = 540;

  const { c: front, g } = mk();
  // a slice of the recap's sky: indigo under the lid, hotter toward the planet's glow
  const sky = g.createLinearGradient(0, CUT, 0, HORIZON);
  sky.addColorStop(0, "#43179e");
  sky.addColorStop(0.45, "#7128dc");
  sky.addColorStop(0.8, "#b443ee");
  sky.addColorStop(1, "#ff7ee0");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.filter = "blur(34px)";
  for (const [x, y, r, col] of [
    [80, 230, 130, "rgba(255,90,220,.55)"],
    [540, 170, 110, "rgba(120,200,255,.45)"],
    [520, 470, 120, "rgba(255,120,210,.45)"],
    [90, 520, 120, "rgba(110,170,255,.4)"],
    [300, 150, 150, "rgba(150,90,255,.5)"],
  ] as const) {
    g.fillStyle = col;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.filter = "none";
  rays(g, ["rgba(255,236,255,.34)", "rgba(255,236,255,0)"]);
  // halftone falling off from the upper corners, the print texture of a real pack
  g.fillStyle = "rgba(255,255,255,.13)";
  for (let y = CUT + 6; y < 360; y += 9) {
    for (let x = ((y - CUT) / 9) % 2 ? 4.5 : 0; x <= W; x += 9) {
      const r = 2.6 * (1 - Math.min(Math.hypot(x, y - CUT), Math.hypot(W - x, y - CUT)) / 250);
      if (r > 0.3) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(255,245,255,${(0.2 + rnd() * 0.6).toFixed(2)})`;
    const r = rnd() < 0.85 ? 1 : 2;
    g.fillRect(rnd() * W, CUT + 6 + rnd() * (HORIZON - CUT), r, r);
  }
  g.save();
  g.fillStyle = "#fff";
  g.shadowColor = "rgba(255,200,255,.95)";
  g.shadowBlur = 12;
  for (const [x, y, r] of sparks) sparkle(g, x, y, r);
  g.restore();
  // the glow the planet throws up, then the planet, lit along its top like the title screen's
  const atm = g.createRadialGradient(W / 2, HORIZON, 0, W / 2, HORIZON, 340);
  atm.addColorStop(0, "rgba(255,200,250,.85)");
  atm.addColorStop(0.35, "rgba(255,130,235,.4)");
  atm.addColorStop(1, "rgba(255,130,235,0)");
  g.fillStyle = atm;
  g.fillRect(0, HORIZON - 340, W, 340);
  const pg = g.createRadialGradient(W / 2 - 60, HORIZON, 0, W / 2 - 60, HORIZON, 560);
  pg.addColorStop(0, "#fff6ff");
  pg.addColorStop(0.07, "#e6d4ff");
  pg.addColorStop(0.22, "#ad86f6");
  pg.addColorStop(0.5, "#6a35c8");
  pg.addColorStop(1, "#3c1a86");
  g.fillStyle = pg;
  planet(g);
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = "rgba(255,255,255,.1)";
  g.lineWidth = 10;
  for (const d of [52, 96, 150]) {
    g.beginPath();
    g.ellipse(W / 2, HORIZON + d + 520, 760, 520, 0, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }
  g.restore();
  g.save();
  g.shadowColor = "rgba(255,170,250,1)";
  g.shadowBlur = 22;
  g.strokeStyle = "#fff";
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(W / 2, HORIZON + PLANET_R, PLANET_R, Math.PI * 1.25, Math.PI * 1.75);
  g.stroke();
  g.restore();
  // the star the rays come from, burning white
  const sun = g.createRadialGradient(W / 2, SUN_Y, 0, W / 2, SUN_Y, 250);
  sun.addColorStop(0, "rgba(255,255,255,1)");
  sun.addColorStop(0.16, "rgba(255,220,255,.75)");
  sun.addColorStop(0.42, "rgba(240,90,240,.3)");
  sun.addColorStop(1, "rgba(240,90,240,0)");
  g.fillStyle = sun;
  g.fillRect(0, SUN_Y - 250, W, 500);
  g.save();
  g.shadowColor = "rgba(60,0,120,.55)";
  g.shadowBlur = 24;
  g.shadowOffsetY = 8;
  g.drawImage(ci, W / 2 - 112, SUN_Y - 112, 224, 224);
  g.restore();
  g.drawImage(si, W / 2 - 112, SUN_Y - 112, 224, 224);
  for (const [w, h] of [[560, 3], [3, 300]]) {
    const fl = w > h ? g.createLinearGradient(W / 2 - w / 2, 0, W / 2 + w / 2, 0) : g.createLinearGradient(0, SUN_Y - h / 2, 0, SUN_Y + h / 2);
    fl.addColorStop(0, "rgba(255,255,255,0)");
    fl.addColorStop(0.5, "rgba(255,255,255,.95)");
    fl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = fl;
    g.fillRect(W / 2 - w / 2, SUN_Y - h / 2, w, h);
  }
  const core = g.createRadialGradient(W / 2, SUN_Y, 0, W / 2, SUN_Y, 60);
  core.addColorStop(0, "rgba(255,255,255,.9)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = core;
  g.fillRect(W / 2 - 60, SUN_Y - 60, 120, 120);
  // the name, outlined so it reads on the bright art, and the year on a white tab
  word(g);
  g.lineJoin = "round";
  g.lineWidth = 14;
  g.strokeStyle = "#260a62";
  g.save();
  g.shadowColor = "rgba(30,0,70,.6)";
  g.shadowBlur = 18;
  g.shadowOffsetY = 6;
  g.strokeText("SETSU", W / 2 + 4, WORD_Y);
  g.restore();
  const wg = g.createLinearGradient(0, WORD_Y - 34, 0, WORD_Y + 34);
  wg.addColorStop(0, "#ffffff");
  wg.addColorStop(0.55, "#f4e9ff");
  wg.addColorStop(1, "#c9a6ff");
  g.fillStyle = wg;
  g.fillText("SETSU", W / 2 + 4, WORD_Y);
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(W / 2 - 98, WORD_Y + 52, 196, 38, 19);
  g.fill();
  g.font = `600 15px ${DISPLAY}`;
  g.letterSpacing = "0.3em";
  g.fillStyle = "#2c0c6e";
  g.fillText(`RECAP ${year}`, W / 2 + 2, WORD_Y + 72);
  // setsu is short for setsuna, the fleeting moment: "the moment itself is forever"
  g.font = `700 21px ${MINCHO}`;
  g.letterSpacing = "0.34em";
  g.fillStyle = "rgba(255,255,255,.88)";
  g.fillText("刹那こそ永遠", W / 2 + 4, H - 64);
  const tw = g.measureText("刹那こそ永遠").width / 2 + 22;
  g.fillStyle = "rgba(255,255,255,.4)";
  g.fillRect(W / 2 - tw - 34, H - 64, 34, 1);
  g.fillRect(W / 2 + tw, H - 64, 34, 1);
  // the lid: a hot foil band with the star pattern, like the ball pattern on Pocket's packs
  const lid = g.createLinearGradient(0, 0, W, 0);
  lid.addColorStop(0, "#ff4fd8");
  lid.addColorStop(0.35, "#b83cff");
  lid.addColorStop(0.65, "#7c3cff");
  lid.addColorStop(1, "#ff4fd8");
  g.fillStyle = lid;
  g.fillRect(0, 0, W, CUT);
  g.globalAlpha = 0.22;
  for (let y = 36; y < CUT; y += 30) for (let x = (y / 30) % 2 ? 0 : 15; x < W; x += 30) g.drawImage(si, x, y - 6, 14, 14);
  g.globalAlpha = 1;
  g.drawImage(ci, W / 2 - 104, 44, 28, 28);
  g.drawImage(si, W / 2 - 104, 44, 28, 28);
  g.textAlign = "left";
  g.font = `500 14px ${MONO}`;
  g.letterSpacing = "0.32em";
  g.fillStyle = "#fff";
  g.fillText("SETSU RECAP", W / 2 - 66, 59);
  g.fillStyle = "#260a62";
  g.beginPath();
  g.roundRect(W - 96, 46, 62, 26, 6);
  g.fill();
  g.font = `600 14px ${DISPLAY}`;
  g.letterSpacing = "0.04em";
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.fillText(String(year), W - 65, 60);
  // where to tear: a perforation and a notch at each edge
  g.fillStyle = "rgba(255,255,255,.6)";
  for (let x = 16; x < W - 16; x += 12) g.fillRect(x, CUT - 0.7, 6, 1.4);
  g.fillStyle = "#260a62";
  for (const x of [0, W]) {
    g.beginPath();
    g.moveTo(x, CUT - 6);
    g.lineTo(x + (x ? -9 : 9), CUT);
    g.lineTo(x, CUT + 6);
    g.fill();
  }
  // crimped seals, pressed lighter
  for (const [y0, y1] of [[0, 30], [H - 30, H]]) {
    g.fillStyle = "rgba(255,255,255,.14)";
    g.fillRect(0, y0, W, y1 - y0);
    g.fillStyle = "rgba(255,255,255,.08)";
    for (let x = 0; x < W; x += 4) g.fillRect(x, y0, 1.5, y1 - y0);
  }

  // foil: a little holo over the whole film, full on the rays, the mark, the name and the lid
  const { c: foil, g: f } = mk();
  f.fillStyle = "rgb(70,90,40)";
  f.fillRect(0, 0, W, H);
  rays(f, ["rgba(255,35,120,0)", "rgba(255,35,120,.95)", "rgba(255,35,120,.6)", "rgba(255,35,120,0)"]);
  f.fillStyle = "rgb(255,30,30)";
  for (const [x, y, r] of sparks) sparkle(f, x, y, r * 1.4);
  f.fillStyle = "rgb(150,60,110)";
  planet(f);
  f.fill();
  f.strokeStyle = "rgb(255,20,200)";
  f.lineWidth = 6;
  f.beginPath();
  f.arc(W / 2, HORIZON + PLANET_R, PLANET_R, Math.PI * 1.25, Math.PI * 1.75);
  f.stroke();
  // the star's own shape, a disc around it read as a dark ring
  const st = document.createElement("canvas");
  st.width = st.height = 256;
  const sg = st.getContext("2d")!;
  sg.drawImage(si, 0, 0, 256, 256);
  sg.globalCompositeOperation = "source-in";
  sg.fillStyle = "rgb(200,30,12)";
  sg.fillRect(0, 0, 256, 256);
  f.drawImage(st, W / 2 - 112, SUN_Y - 112, 224, 224);
  word(f);
  f.fillStyle = "rgb(210,40,25)";
  f.fillText("SETSU", W / 2 + 4, WORD_Y);
  f.fillStyle = "rgb(230,35,170)";
  f.fillRect(0, 30, W, CUT - 30);
  f.fillStyle = "rgb(90,120,110)";
  f.fillRect(0, 0, W, 30);
  f.fillRect(0, H - 30, W, 30);

  // the back mirrors through the film, so nothing on it reads left to right
  const { c: back, g: b } = mk();
  const bg = b.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#4a1aac");
  bg.addColorStop(0.6, "#8a32e6");
  bg.addColorStop(1, "#d55cec");
  b.fillStyle = bg;
  b.fillRect(0, 0, W, H);
  b.fillStyle = "rgba(255,236,255,.12)";
  for (const [a0, a1] of rayAngles) {
    b.beginPath();
    b.moveTo(W / 2, H / 2);
    b.arc(W / 2, H / 2, 900, a0, a1);
    b.closePath();
    b.fill();
  }
  b.drawImage(si, W / 2 - 60, H / 2 - 60, 120, 120);

  const { c: alpha, g: al } = mk();
  al.fillStyle = "#fff";
  al.fillRect(0, 0, W, H);
  al.fillStyle = "#000";
  for (let x = 0; x < W; x += 15) {
    for (const [y, d] of [[0, 6], [H, -6]]) {
      al.beginPath();
      al.moveTo(x, y);
      al.lineTo(x + 7.5, y + d);
      al.lineTo(x + 15, y);
      al.fill();
    }
  }
  return { front, back, alpha, foil };
}

/** folds and seams only, the printed face stays smooth: pressed seal ridges, the step down to the
 * pressed edges, tension creases fanning in from the corners, a few soft wrinkles along the sides.
 * one height field, a normal map per strength */
function wrinkles(strengths: number[]): THREE.CanvasTexture[] {
  const cw = 384;
  const ch = Math.round((cw * H) / W);
  const sx = W / cw;
  let sd = 21;
  const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  type Seg = { x0: number; y0: number; vx: number; vy: number; w: number; amp: number };
  const segs: Seg[] = [];
  const seg = (x0: number, y0: number, x1: number, y1: number, w: number, amp: number) => segs.push({ x0, y0, vx: x1 - x0, vy: y1 - y0, w, amp });
  for (const [cx, cy, dx, dy] of [[0, 30, 1, 1], [W, 30, -1, 1], [0, H - 30, 1, -1], [W, H - 30, -1, -1]]) {
    for (let k = 0; k < 4; k++) {
      const ang = Math.atan2(dy, dx * 1.6) + (k - 1.5) * 0.28 + (rnd() - 0.5) * 0.15;
      const len = 70 + rnd() * 90;
      const x0 = cx + dx * 6;
      const y0 = cy + dy * rnd() * 30;
      seg(x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len, 4 + rnd() * 5, 0.5 + rnd() * 0.5);
    }
  }
  for (const side of [0, W]) {
    for (let k = 0; k < 7; k++) {
      const x = side ? side - 6 - rnd() * 22 : 6 + rnd() * 22;
      const y = 120 + rnd() * (H - 260);
      seg(x, y, x + (rnd() - 0.5) * 10, y + 40 + rnd() * 80, 2.5 + rnd() * 3, 0.35 + rnd() * 0.3);
    }
  }
  const height = new Float32Array(cw * ch);
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const x = px * sx;
      const y = py * sx;
      const seal = Math.min(y, H - y);
      const sideD = Math.min(x, W - x);
      let h = 0;
      if (seal < 30) h += 0.07 * Math.sin((x / 4) * Math.PI * 2);
      // seals and side edges sit a step below the filled face
      h += 0.3 * smooth(24, 34, seal) * smooth(3, 12, sideD);
      height[py * cw + px] = h;
    }
  }
  for (const s of segs) {
    const r = s.w * 3;
    const l2 = s.vx * s.vx + s.vy * s.vy;
    const px0 = Math.max(0, Math.floor((Math.min(s.x0, s.x0 + s.vx) - r) / sx));
    const px1 = Math.min(cw - 1, Math.ceil((Math.max(s.x0, s.x0 + s.vx) + r) / sx));
    const py0 = Math.max(0, Math.floor((Math.min(s.y0, s.y0 + s.vy) - r) / sx));
    const py1 = Math.min(ch - 1, Math.ceil((Math.max(s.y0, s.y0 + s.vy) + r) / sx));
    for (let py = py0; py <= py1; py++) {
      for (let px = px0; px <= px1; px++) {
        const x = px * sx;
        const y = py * sx;
        const t = cl(((x - s.x0) * s.vx + (y - s.y0) * s.vy) / l2);
        const ddx = x - (s.x0 + s.vx * t);
        const ddy = y - (s.y0 + s.vy * t);
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < r * r) height[py * cw + px] += s.amp * Math.exp(-d2 / (s.w * s.w)) * (1 - t) * 0.6;
      }
    }
  }
  const at = (x: number, y: number) => height[Math.min(ch - 1, Math.max(0, y)) * cw + Math.min(cw - 1, Math.max(0, x))];
  return strengths.map((strength) => {
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d")!;
    const out = g.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const nx = -(at(x + 1, y) - at(x - 1, y)) * strength;
        const ny = (at(x, y + 1) - at(x, y - 1)) * strength;
        const l = Math.hypot(nx, ny, 1);
        const o = (y * cw + x) * 4;
        out.data[o] = ((nx / l) * 0.5 + 0.5) * 255;
        out.data[o + 1] = ((ny / l) * 0.5 + 0.5) * 255;
        out.data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
        out.data[o + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    return t;
  });
}

/** a product-shot studio for the reflections: long bright strips, so the gloss shows crisp
 * streaks that slide as the pack tilts. the camera looks down -z, so the lights sit at +z */
function studio(): THREE.Scene {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), new THREE.MeshBasicMaterial({ color: 0x3a2c66, side: THREE.BackSide })));
  const panel = (w: number, h: number, color: number, power: number, pos: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  panel(16, 2.6, 0xffffff, 5, [0, 10, 5]);
  panel(2.4, 16, 0xffd6f7, 6, [-11, 1, 6]);
  panel(2.4, 16, 0xb8ecff, 6, [11, -1, 6]);
  panel(9, 6, 0xffffff, 0.6, [0, -3, 13]);
  panel(12, 12, 0x7a3cff, 0.6, [0, 0, -14]);
  return s;
}

export class PackScene {
  phase: PackPhase = "enter";
  // read by the recap every frame
  dim = 0;
  flash = 0;
  /** dom card offset from its resting place, px, and whether it shows yet */
  cardLift = 56;
  cardVis = 0;
  rays = 0;
  /** head of the tear in stage px, null when nothing is being cut */
  tip: { x: number; y: number } | null = null;
  /** the pouch's sides below the mouth in stage px, [x, y] pairs left top to bottom then right
   * bottom to top. the dom card is clipped to it while it is still inside */
  outline: number[] | null = null;

  private r: THREE.WebGLRenderer;
  private env: THREE.Texture;
  private backCv: HTMLCanvasElement;
  private back: CanvasRenderingContext2D | null;
  private backShown = false;
  private ready = false;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private root = new THREE.Group();
  private tilt = new THREE.Group();
  private body = new THREE.Group();
  private lid = new THREE.Group();
  private lidF!: Surface;
  private lidB!: Surface;
  private bodyF!: Surface;
  private bodyB!: Surface;
  private line!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private rimF!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private rimB!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private inner!: THREE.Sprite;
  private key = new THREE.DirectionalLight(0xffffff, 0.9);
  /** the printed outside films, flared by the landing light */
  private films: THREE.MeshPhysicalMaterial[] = [];
  /** when the entrance landed, for the light that sweeps over the pack then */
  private landAt = 0;
  private disposables: Array<{ dispose(): void }> = [];

  // the torn path, px off the printed line per sample, and the same packed into a texture
  private path = new Float32Array(NPATH);
  private pathBytes = new Uint8Array(NPATH).fill(128);
  private pathTex: THREE.DataTexture;
  private pathDirty = true;
  private lastYoff = 0;

  private t0 = 0;
  private now = 0;
  private a = 0.5;
  private b = 0.5;
  private head = 0.5;
  private dir = 0;
  private start = 0.5;
  private lead = 0;
  private tracing = false;
  private lastF = 0.5;
  private peel = 0;
  private peelV = 0;
  private flutter = 0;
  private open = 0;
  private recoil = 0;
  private recoilV = 0;
  private lidVel = new THREE.Vector3();
  private lidSpin = new THREE.Vector3();
  private sounded = new Set<string>();
  private placed = { peel: NaN, open: NaN, head: NaN, flutter: NaN, dent: false };
  /** presses on the closed pack, in pack px with the time they landed: each dents the film and it
   * springs back */
  private pokes: Array<{ x: number; y: number; t0: number }> = [];
  // poked six times in two seconds it has had enough: a hop with a full turn in the air
  private pokeTimes: number[] = [];
  private hopT0 = 0;
  private dead = false;
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();

  constructor(
    back: HTMLCanvasElement,
    front: HTMLCanvasElement,
    private ev: PackEvents,
  ) {
    // one context for both layers, the back one is copied into a 2d canvas. a second context
    // doubled the startup: its own reflections and every shader compiled twice
    this.r = new THREE.WebGLRenderer({ canvas: front, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    this.r.setClearColor(0x000000, 0);
    this.r.toneMapping = THREE.NeutralToneMapping;
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.backCv = back;
    this.back = back.getContext("2d");
    const room = studio();
    const pm = new THREE.PMREMGenerator(this.r);
    this.env = pm.fromScene(room, 0.02).texture;
    this.scene.environment = this.env;
    pm.dispose();
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    this.camera = new THREE.PerspectiveCamera((2 * Math.atan(540 / DIST) * 180) / Math.PI, 1920 / 1080, 10, 6000);
    this.camera.position.set(0, 0, DIST);
    this.scene.add(this.root);
    this.root.position.set(CX - 960, 540 - CY, 0);
    this.root.add(this.tilt);
    this.tilt.add(this.body, this.lid);
    this.key.position.set(-300, 500, 900);
    const amb = new THREE.AmbientLight(0xffffff, 0.25);
    // lights obey camera layers too, and each canvas renders one layer
    this.key.layers.enableAll();
    amb.layers.enableAll();
    this.scene.add(this.key, amb);
    this.pathTex = new THREE.DataTexture(this.pathBytes, NPATH, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.pathTex.magFilter = this.pathTex.minFilter = THREE.LinearFilter;
    this.pathTex.needsUpdate = true;
    this.disposables.push(this.pathTex);
  }

  private film(m: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
    this.films.push(m);
    return m;
  }

  /** textures and meshes; the constructor already threw if there's no webgl */
  async init(year: number, corners: string, star: string, scale: number): Promise<void> {
    const art = await drawArt(year, corners, star);
    if (this.dead) return;
    const tex = (c: HTMLCanvasElement, srgb = true) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 8;
      this.disposables.push(t);
      return t;
    };
    const [face, crumple] = wrinkles([2.2, 4.5]);
    this.disposables.push(face, crumple);
    const frontMap = tex(art.front);
    const backMap = tex(art.back);
    const alphaMap = tex(art.alpha, false);
    const foilMap = tex(art.foil, false);
    const pathUniform = { value: this.pathTex };
    // lid and body each draw only their side of the torn path
    const cut = (m: THREE.MeshPhysicalMaterial, lid: boolean) => {
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uPath = pathUniform;
        sh.uniforms.uLid = { value: lid ? 1 : 0 };
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nattribute vec2 aPack;\nvarying vec2 vPack;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPack = aPack;");
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform sampler2D uPath;\nuniform float uLid;\nvarying vec2 vPack;")
          .replace(
            "void main() {",
            `void main() {
  float cutY = ${CUT.toFixed(1)} + (texture2D(uPath, vec2((vPack.x + ${(W / 2).toFixed(1)}) / ${W.toFixed(1)}, 0.5)).r * 2.0 - 1.0) * ${PATH_RANGE.toFixed(1)};
  if (uLid > 0.5 ? vPack.y > cutY : vPack.y < cutY) discard;`,
          );
      };
      m.customProgramCacheKey = () => "pack-cut";
      this.disposables.push(m);
      return m;
    };
    // new film: a glossy clear coat over a print, holo foil where the foil map says. a metallised
    // print all over only mirrored the dark room and read as near black
    const outer = (map: THREE.Texture, foil: THREE.Texture | null, lid: boolean, side: THREE.Side) =>
      cut(
        this.film(new THREE.MeshPhysicalMaterial({
          map,
          alphaMap,
          alphaTest: 0.5,
          normalMap: face,
          normalScale: new THREE.Vector2(0.6, 0.6),
          metalness: foil ? 1 : 0.2,
          metalnessMap: foil,
          roughness: foil ? 1 : 0.3,
          roughnessMap: foil,
          iridescence: foil ? 1 : 0.35,
          iridescenceMap: foil,
          iridescenceIOR: 1.6,
          iridescenceThicknessRange: [180, 620],
          clearcoat: 1,
          clearcoatRoughness: 0.035,
          envMapIntensity: 1,
          side,
        })),
        lid,
      );
    // the inside is bare silver film, crumpled a bit harder
    const inner = (lid: boolean, side: THREE.Side) =>
      cut(
        new THREE.MeshPhysicalMaterial({
          color: 0xd6d9e2,
          alphaMap,
          alphaTest: 0.5,
          normalMap: crumple,
          metalness: 1,
          roughness: 0.17,
          envMapIntensity: 1.15,
          side,
        }),
        lid,
      );
    // triangles wind toward +z, so the front's outside is its front side and the back's is its back side
    this.lidF = surface(rows(0, CUT + BAND, ROW), 60, 1);
    this.lidB = surface(rows(0, CUT + BAND, ROW), 60, -1);
    const bodyRows = [...rows(CUT - BAND, 216, ROW), ...rows(216, H, (H - 216) / 60).slice(1)];
    this.bodyF = surface(bodyRows, 60, 1);
    this.bodyB = surface(bodyRows, 60, -1);
    for (const s of [this.lidF, this.lidB, this.bodyF, this.bodyB]) this.disposables.push(s.geo);
    const add = (g: THREE.Group, s: Surface, lid: boolean, layer: number) => {
      const out = new THREE.Mesh(s.geo, s.side > 0 ? outer(frontMap, foilMap, lid, THREE.FrontSide) : outer(backMap, null, lid, THREE.BackSide));
      const ins = new THREE.Mesh(s.geo, inner(lid, s.side > 0 ? THREE.BackSide : THREE.FrontSide));
      out.layers.set(layer);
      ins.layers.set(layer);
      g.add(out, ins);
    };
    add(this.lid, this.lidF, true, 0);
    add(this.lid, this.lidB, true, 0);
    add(this.body, this.bodyF, false, 0);
    // the pouch's back and its silver inside go behind the card
    add(this.body, this.bodyB, false, 1);

    const lineMat = (col: number) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        uniforms: {
          uA: { value: 0.5 },
          uB: { value: 0.5 },
          uHead: { value: -1 },
          uOn: { value: 0 },
          uPulse: { value: 0 },
          uHint: { value: -1 },
          uCol: { value: new THREE.Color(col) },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      this.disposables.push(m);
      return m;
    };
    const ribbon = (mat: THREE.ShaderMaterial) => {
      const g = new THREE.PlaneGeometry(W, 10, 60, 1);
      this.disposables.push(g);
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = 2;
      return m;
    };
    this.line = ribbon(lineMat(0xff4bf0));
    this.tilt.add(this.line);
    this.rimF = ribbon(lineMat(0x9ff4ff));
    this.rimB = ribbon(lineMat(0x9ff4ff));
    for (const r of [this.rimF, this.rimB]) {
      const u = r.material.uniforms;
      u.uA.value = 0;
      u.uB.value = 1;
      r.visible = false;
    }
    this.rimB.layers.set(1);
    this.body.add(this.rimF, this.rimB);
    const glow = glowTexture();
    this.disposables.push(glow);
    const sm = new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, toneMapped: false });
    this.disposables.push(sm);
    this.inner = new THREE.Sprite(sm);
    this.inner.layers.set(1);
    this.inner.position.set(0, H / 2 - CUT - 20, -6);
    this.inner.scale.set(500, 200, 1);
    this.body.add(this.inner);
    this.camera.layers.enableAll();
    this.resize(scale);
    // compiled off the main thread where the driver allows, the first frame stalled ~250ms otherwise
    await this.r.compileAsync(this.scene, this.camera).catch(() => null);
    if (this.dead) return;
    this.ready = true;
    this.t0 = this.now = performance.now();
    this.ev.phase("enter");
  }

  resize(scale: number): void {
    const pr = Math.min(2, Math.max(1, (window.devicePixelRatio || 1) * scale));
    this.r.setPixelRatio(pr);
    this.r.setSize(1920, 1080, false);
    this.backCv.width = this.r.domElement.width;
    this.backCv.height = this.r.domElement.height;
  }

  private to(phase: PackPhase): void {
    this.phase = phase;
    this.t0 = this.now;
    this.ev.phase(phase);
  }

  /** stage px into pack px, ignoring the small idle tilt */
  private local(x: number, y: number): [number, number] {
    return [x - CX, y - (CY - H / 2)];
  }

  /** the tear's y off the printed line at a pack x */
  private pathAt(x: number): number {
    const f = cl((x + W / 2) / W) * (NPATH - 1);
    const i = Math.min(NPATH - 2, Math.floor(f));
    return this.path[i] + (this.path[i + 1] - this.path[i]) * (f - i);
  }

  private setPath(i: number, v: number): void {
    this.path[i] = v;
    this.pathBytes[i] = Math.round(cl((v / PATH_RANGE) * 0.5 + 0.5) * 255);
    this.pathDirty = true;
  }

  down(x: number, y: number): boolean {
    if (this.phase !== "idle") return false;
    const [lx, ly] = this.local(x, y);
    if (Math.abs(ly - CUT) > 70 || Math.abs(lx) > W / 2 + 20) return false;
    const f = cl((lx + W / 2) / W);
    this.a = this.b = this.head = this.lastF = this.start = f;
    this.dir = 0;
    this.lastYoff = cl(ly - CUT, -16, 16);
    for (let i = 0; i < NPATH; i++) this.setPath(i, 0);
    // started near an edge: the tear runs from that edge's notch, or the strip between the notch
    // and the pointer stayed standing until the whole line was done
    this.lead = 0;
    const i0 = Math.round(f * (NPATH - 1));
    if (f < EDGE) {
      this.lead = f;
      this.a = 0;
      for (let i = 0; i <= i0; i++) this.setPath(i, this.lastYoff);
    } else if (f > 1 - EDGE) {
      this.lead = 1 - f;
      this.b = 1;
      for (let i = i0; i < NPATH; i++) this.setPath(i, this.lastYoff);
    }
    this.tracing = true;
    this.to("trace");
    return true;
  }

  move(x: number, y: number): void {
    if (!this.tracing || (this.phase !== "trace" && this.phase !== "armed")) return;
    const [lx, ly] = this.local(x, y);
    const f = cl((lx + W / 2) / W);
    // the tear follows the pointer's height, smoothed, within a band around the printed line
    const yoff = this.lastYoff + (cl(ly - CUT, -16, 16) - this.lastYoff) * 0.45;
    const i0 = Math.round(this.lastF * (NPATH - 1));
    const i1 = Math.round(f * (NPATH - 1));
    const n = Math.max(1, Math.abs(i1 - i0));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      this.setPath(i0 + Math.sign(i1 - i0) * k, this.lastYoff + (yoff - this.lastYoff) * t + (Math.random() - 0.5) * 2.4);
    }
    this.lastYoff = yoff;
    this.lastF = f;
    this.a = Math.min(this.a, f);
    this.b = Math.max(this.b, f);
    this.head = f;
    if (!this.dir && Math.abs(f - this.start) > 0.012) this.dir = Math.sign(f - this.start);
    // once the line is complete nothing more tears
    // the part given by starting at an edge doesn't count, the cut sounds follow the hand
    if (this.phase === "trace") this.ev.cut(cl((this.b - this.a - this.lead) / (0.93 - this.lead)));
    if (this.phase === "trace" && this.b - this.a >= 0.93) {
      // the last few px at the ends follow their neighbours
      const ia = Math.round(this.a * (NPATH - 1));
      const ib = Math.round(this.b * (NPATH - 1));
      for (let i = 0; i < ia; i++) this.setPath(i, this.path[ia]);
      for (let i = ib + 1; i < NPATH; i++) this.setPath(i, this.path[ib]);
      this.a = 0;
      this.b = 1;
      this.to("armed");
    }
  }

  /** a press that didn't start a cut: the film dents under it and wobbles back */
  poke(x: number, y: number): void {
    if (this.phase !== "idle") return;
    const [lx, ly] = this.local(x, y);
    if (Math.abs(lx) > W / 2 || ly < 0 || ly > H) return;
    this.pokes.push({ x: lx, y: ly, t0: this.now });
    if (this.pokes.length > 4) this.pokes.shift();
    this.pokeTimes = [...this.pokeTimes.filter((t) => this.now - t < 2000), this.now];
    if (this.pokeTimes.length >= 6 && !this.hopT0) {
      this.pokeTimes = [];
      this.hopT0 = this.now;
      this.ev.sound("hop");
    }
  }

  /** how deep the presses push the film in at a pack point: a dimple that springs back with a few
   * shrinking wobbles */
  private dent(x: number, y: number): number {
    let d = 0;
    for (const p of this.pokes) {
      const age = (this.now - p.t0) / 1000;
      const dx = x - p.x;
      const dy = y - p.y;
      d += 16 * Math.exp(-age / 0.2) * Math.cos(2 * Math.PI * 4.2 * age) * Math.exp(-(dx * dx + dy * dy) / (2 * 75 * 75));
    }
    return d;
  }

  up(): void {
    if (!this.tracing) return;
    this.tracing = false;
    if (this.phase === "armed") this.to("rip");
    else if (this.phase === "trace") this.to("idle");
  }

  dispose(): void {
    this.dead = true;
    for (const d of this.disposables) d.dispose();
    this.env.dispose();
    this.r.dispose();
    this.r.forceContextLoss();
  }

  /** how far the cut part of the lid curls toward you at a pack x: nothing at the head, most far
   * behind it, so the corner you started from goes first */
  private foldAt(x: number): number {
    if (this.peel < 1e-3) return 0;
    const f = (x + W / 2) / W;
    if (f < this.a - 0.004 || f > this.b + 0.004) return 0;
    return this.peel * smooth(0, 0.3, Math.abs(f - this.head));
  }

  /** a lid point: once torn the strip loses its air and flattens onto the front film, bends over
   * right above the tear and folds down toward you as a flat flap */
  private lidPoint(x: number, y: number, side: 1 | -1, out: THREE.Vector3): THREE.Vector3 {
    surf(x, y, side, out);
    const th = Math.min(2.6, this.foldAt(x) + this.flutter);
    if (Math.abs(th) < 1e-3) return out;
    const cy = CUT + this.pathAt(x);
    const flat = 0.9 * Math.min(1, Math.abs(th) / 1.4);
    // the front film at the tear is where the folded strip hinges, so it never cuts into the body
    const hz = flat * (surf(x, cy, 1, this.w).z - 3);
    const d = out.z + (side * 3 - out.z) * flat;
    const s = Math.max(0, cy - y);
    const R = BEND / th;
    const ph = (th * Math.min(s, BEND)) / BEND;
    let py = R * Math.sin(ph);
    let pz = R * (1 - Math.cos(ph));
    if (s > BEND) {
      py += (s - BEND) * Math.cos(th);
      pz += (s - BEND) * Math.sin(th);
    }
    out.y = H / 2 - cy + py - d * Math.sin(ph);
    out.z = hz + pz + d * Math.cos(ph);
    return out;
  }

  /** a body point: once torn the mouth spreads, the back wall falls back and the front lip rolls
   * outward, so the silver inside shows */
  private bodyPoint(x: number, y: number, side: 1 | -1, out: THREE.Vector3): THREE.Vector3 {
    surf(x, y, side, out);
    const o = this.open;
    if (o < 1e-3) return out;
    const cy = CUT + this.pathAt(x);
    const spread = (yy: number) => {
      const f = Math.max(0, 1 - (yy - cy) / 170);
      return 1 + o * (side > 0 ? 1.7 : 1.3) * f * f;
    };
    out.z *= spread(y);
    if (side < 0 || y > cy + LIP) return out;
    const u = Math.min(1, Math.abs(x) / (W / 2));
    // the sealed side edges can't roll
    const phi = o * (1.45 + 0.25 * Math.sin(x * 0.021 + 0.7)) * (1 - u * u * u * u);
    if (phi < 1e-3) return out;
    const hz = surf(x, cy + LIP, 1, this.w).z * spread(cy + LIP);
    const R = LIP / phi;
    const ph = (phi * (LIP - Math.max(0, y - cy))) / LIP;
    const d = out.z - hz;
    out.y = H / 2 - cy - LIP + (R - d) * Math.sin(ph);
    out.z = hz + R * (1 - Math.cos(ph)) + d * Math.cos(ph);
    return out;
  }

  /** puts surfaces where the fold, the tear and the opening say, only when one of them changed */
  private place(): void {
    const P = this.placed;
    this.pokes = this.pokes.filter((p) => this.now - p.t0 < 900);
    // a dent moves everything while it lasts, and once more as it ends so the film is smooth again
    const denting = this.pokes.length > 0;
    const redent = denting || P.dent;
    P.dent = denting;
    const lidMoved = redent || this.pathDirty || P.peel !== this.peel || P.head !== this.head || P.flutter !== this.flutter;
    // the closed body never changes, it only moves once the mouth opens
    const bodyMoved = redent || P.open !== this.open || (this.open > 0 && this.pathDirty);
    if (!lidMoved && !bodyMoved) return;
    P.peel = this.peel;
    P.head = this.head;
    P.flutter = this.flutter;
    P.open = this.open;
    if (this.pathDirty) {
      this.pathTex.needsUpdate = true;
      this.pathDirty = false;
    }
    const v = this.v;
    const fill = (s: Surface, at: (x: number, y: number, side: 1 | -1, out: THREE.Vector3) => THREE.Vector3) => {
      const p = s.geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        at(s.base[i * 2], s.base[i * 2 + 1], s.side, v);
        // the front gives under the press, the back bulges a little with the air pushed into it
        if (denting) v.z -= this.dent(s.base[i * 2], s.base[i * 2 + 1]) * (s.side > 0 ? 1 : 0.3);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      p.needsUpdate = true;
      s.geo.computeVertexNormals();
    };
    const lidAt = this.lidPoint.bind(this);
    const bodyAt = this.bodyPoint.bind(this);
    if (lidMoved) {
      fill(this.lidF, lidAt);
      fill(this.lidB, lidAt);
    }
    if (bodyMoved) {
      fill(this.bodyF, bodyAt);
      fill(this.bodyB, bodyAt);
    }
    // glow ribbons along the tear: across the front while cutting, both torn edges after
    const strip = (m: THREE.Mesh, side: 1 | -1, half: number) => {
      const rp = m.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < rp.count; i++) {
        const x = -W / 2 + (W * (i % 61)) / 60;
        this.bodyPoint(x, CUT + this.pathAt(x) + 0.5, side, v);
        rp.setXYZ(i, v.x, v.y + (i <= 60 ? half : -half), v.z + side);
      }
      rp.needsUpdate = true;
    };
    strip(this.line, 1, 5);
    if (this.rimF.visible) {
      strip(this.rimF, 1, 3);
      strip(this.rimB, -1, 3);
    }
  }

  /** advances one frame. tx/ty is the card's pointer spring, 0..1 per axis */
  update(now: number, tx: number, ty: number): void {
    if (this.dead || !this.ready) return;
    const dt = this.now ? Math.min(0.05, (now - this.now) / 1000) : 1 / 60;
    this.now = now;
    const t = (now - this.t0) / 1000;
    const lu = this.line.material.uniforms;
    let scale = 1;
    let lift = 0;
    let spin = 0;
    let shake = 0;
    let lean = 0;
    let exposure: number;
    this.tip = null;

    // the entrance: up out of the dark spinning two whole turns, growing past its size as the spin
    // runs out and settling back, with a flash of light and the rays as it lands
    let land = 0;
    if (this.phase === "enter") {
      const p = cl(t / ENTER);
      scale = 0.1 + 0.9 * eob(cl(p / 0.82));
      lift = (1 - eo(p)) * 300;
      spin = Math.pow(1 - p, 5) * Math.PI * 4;
      if (p >= LAND && !this.sounded.has("land")) {
        this.sounded.add("land");
        this.landAt = now;
        this.ev.sound("land");
      }
      land = p >= LAND ? 1 - cl((p - LAND) / (1 - LAND)) * 0.4 : 0;
      if (p >= 1) this.to("idle");
    }
    // a spark runs along the printed line every couple of seconds until someone starts
    if (this.phase === "idle") {
      const hd = t > 1.6 ? ((t - 1.6) % 2.4) / 1.3 : 2;
      lu.uHint.value = hd <= 1 ? hd : -1;
    } else lu.uHint.value = -1;

    const tracing = this.phase === "trace" || this.phase === "armed";
    // the room goes dark while the tear runs, snaps back on the rip
    this.dim += ((tracing ? 1 : 0) - this.dim) * (tracing ? 0.12 : this.phase === "rip" ? 0.35 : 0.15);
    exposure = 1 - this.dim * 0.3;
    if (tracing) {
      lu.uOn.value = Math.min(1, lu.uOn.value + dt * 8);
      lu.uA.value = this.a;
      lu.uB.value = this.b;
      lu.uHead.value = this.head;
      const hx = -W / 2 + this.head * W;
      this.tip = { x: CX + hx, y: CY - H / 2 + CUT + this.pathAt(hx) };
    } else if (this.phase === "idle") {
      // let go too early: the glow fades and the torn path settles back
      lu.uOn.value = Math.max(0, lu.uOn.value - dt * 3);
      for (let i = 0; i < NPATH; i++) if (this.path[i]) this.setPath(i, Math.abs(this.path[i]) < 0.3 ? 0 : this.path[i] * 0.85);
    }
    const armed = this.phase === "armed";
    lu.uPulse.value = armed ? 0.6 + 0.4 * Math.sin(t * 14) : 0;
    if (armed) shake = 0.8 + Math.min(1.5, t * 1.2);
    // the curl grows with how much has been cut, springs back when let go early
    if (this.phase !== "rip" && this.phase !== "done") {
      const peelTo = tracing ? 0.45 + 2.05 * (this.b - this.a) : 0;
      this.peelV = (this.peelV + (peelTo - this.peel) * 0.14) * 0.76;
      this.peel = Math.max(0, this.peel + this.peelV);
    }

    if (this.phase === "rip") {
      // a short freeze, then the snap
      const HIT = 0.07;
      const r = t - HIT;
      if (r >= 0) {
        if (!this.sounded.has("rip")) {
          this.sounded.add("rip");
          this.ev.sound("rip");
          this.flash = 1;
          this.recoilV = -9;
          // the lid leaves on its own, with whatever pose it had
          this.lid.updateMatrixWorld();
          this.scene.attach(this.lid);
          // up, off to the side it was torn toward, and away from the camera so it shrinks
          this.lidVel.set(this.dir < 0 ? -760 : 760, 1500, -900);
          this.lidSpin.set(6.5, 1.6, this.dir < 0 ? 3.2 : -3.2);
          this.line.visible = false;
          this.rimF.visible = this.rimB.visible = true;
          for (const rm of [this.rimF, this.rimB]) rm.material.uniforms.uOn.value = 1;
        }
        this.flash = Math.max(0, this.flash - dt * 2.6);
        exposure = 1 + Math.max(0, 0.35 - r * 1.2);
        this.lidVel.y -= 260 * dt;
        this.lid.position.addScaledVector(this.lidVel, dt);
        this.lid.rotation.x += this.lidSpin.x * dt;
        this.lid.rotation.y += this.lidSpin.y * dt;
        this.lid.rotation.z += this.lidSpin.z * dt;
        this.flutter = 0.45 * Math.sin(r * 11) * Math.max(0, 1 - r);
        if (r > 0.8) this.lid.visible = false;
        // the pouch tips its mouth toward you and spreads open
        this.open = eob(cl(r / 0.45));
        lean = 0.42 * eo(cl(r / 0.5));
        this.rimF.material.uniforms.uPulse.value = this.rimB.material.uniforms.uPulse.value = Math.max(0, 0.8 - r);
        // the breath before the card: light swells inside the open mouth while the lid flies
        const E = 0.8;
        (this.inner.material as THREE.SpriteMaterial).opacity = cl((r - 0.15) / (E - 0.15)) * (1 - cl((r - E - 0.15) / 0.35));
        if (r >= E) {
          if (!this.sounded.has("whoosh")) {
            this.sounded.add("whoosh");
            this.ev.sound("cardOut");
          }
          const e = r - E;
          this.cardVis = 1;
          // card shoots up out of the pouch with a little overshoot, then settles
          this.cardLift = e < 0.24 ? 56 - 90 * eo(cl(e / 0.24)) : -34 + 34 * eob(cl((e - 0.24) / 0.5));
          // the pouch drops away underneath it, straightening as it goes
          const d = cl((e - 0.05) / 0.5);
          lift = -1050 * d * d * d;
          lean *= 1 - d;
          this.tilt.rotation.z = 0.09 * d * d;
          this.rays = cl(e / 0.4) * (1 - cl((e - 1.2) / 1));
          if (e > 0.62 && !this.sounded.has("shimmer")) {
            this.sounded.add("shimmer");
            this.ev.sound("shine");
          }
          if (e > 0.9) {
            this.to("done");
            this.root.visible = false;
            this.lid.visible = false;
            this.ev.done();
          }
        }
      }
    }
    if (this.phase === "enter" || this.phase === "idle") {
      if (land > 0) {
        this.rays = Math.max(this.rays, 0.85 * land);
        this.flash = Math.max(this.flash, 0.18 * land * land);
        exposure *= 1 + 0.35 * land;
      } else {
        this.rays = Math.max(0, this.rays - dt * 0.55);
        this.flash = Math.max(0, this.flash - dt * 1.4);
      }
    }
    if (this.phase === "done") {
      this.rays = Math.max(0, this.rays - dt * 0.8);
      this.cardLift = 0;
      this.flash = 0;
    }

    // recoil spring after the snap
    this.recoilV = (this.recoilV - this.recoil * 0.2) * 0.8;
    this.recoil += this.recoilV;
    // float, tilt toward the pointer, shiver while armed
    const float = this.phase === "rip" || this.phase === "done" ? 0 : Math.sin((now / 1000) * 1.3) * 6;
    const k = tracing ? 0.25 : this.phase === "rip" ? 0 : 1;
    // the entrance spin is set outright, eased toward it would lag a whole turn behind
    const hq = this.hopT0 ? (now - this.hopT0) / 1100 : -1;
    // the hop: up, stretched in the air, and down
    const hop = hq >= 0 && hq < 1 ? Math.sin(Math.PI * hq) : 0;
    if (this.phase === "enter") this.tilt.rotation.y = spin + (tx - 0.5) * 0.42 * (1 - spin / (Math.PI * 4));
    else if (hq >= 0 && hq < 1) this.tilt.rotation.y = Math.PI * 2 * eio(hq) + (tx - 0.5) * 0.42;
    else this.tilt.rotation.y += ((tx - 0.5) * 0.42 * k + spin - this.tilt.rotation.y) * 0.12;
    if (hq >= 1) {
      // a whole turn is no turn: unwound so the pointer tilt doesn't spin it back
      this.hopT0 = 0;
      this.tilt.rotation.y -= Math.PI * 2;
      this.ev.sound("hopLand");
    }
    this.tilt.rotation.x += (-(ty - 0.5) * 0.3 * k + lean - this.tilt.rotation.x) * 0.12;
    this.root.scale.setScalar(scale * (1 + (tracing ? 0.025 * (this.b - this.a) : 0)));
    // a press squashes the whole pack a touch, wider and shorter, and it wobbles back with the dent
    if (hop) {
      this.root.scale.x *= 1 - 0.05 * hop;
      this.root.scale.y *= 1 + 0.07 * hop;
    }
    const last = this.pokes[this.pokes.length - 1];
    if (last) {
      const age = (now - last.t0) / 1000;
      const w = Math.exp(-age / 0.18) * Math.cos(2 * Math.PI * 3.6 * age);
      this.root.scale.x *= 1 + 0.018 * w;
      this.root.scale.y *= 1 - 0.026 * w;
    }
    this.root.position.set(CX - 960 + (Math.random() - 0.5) * shake, 540 - CY + lift + float + this.recoil + 190 * hop, 0);
    // the key light follows the pointer so glints slide across the film
    this.key.position.set((tx - 0.5) * 1400, (0.5 - ty) * 900 + 300, 900);
    const sw = this.landAt ? (now - this.landAt) / 750 : 1;
    if (sw < 1) {
      const bell = Math.pow(Math.sin(Math.PI * sw), 1.4);
      this.key.position.set(-1700 + 3400 * sw, 1100 - 1900 * sw, 900);
      this.key.intensity = 0.9 + 3.4 * bell;
      for (const m of this.films) m.envMapIntensity = 1 + 1.6 * bell;
    } else if (this.key.intensity !== 0.9) {
      this.key.intensity = 0.9;
      for (const m of this.films) m.envMapIntensity = 1;
    }
    this.place();
    this.outline = null;
    if (this.cardVis && this.phase === "rip") {
      // tipped toward you the pouch's bottom rises and narrows, the card mustn't show past it
      this.root.updateMatrixWorld(true);
      const pts: number[] = [];
      for (const s of [-1, 1]) {
        for (const y of s < 0 ? [CUT + 40, H / 2, H - 34] : [H - 34, H / 2, CUT + 40]) {
          const p = surf((s * W) / 2, y, 1, this.v);
          p.x -= s * 5;
          p.applyMatrix4(this.body.matrixWorld).project(this.camera);
          pts.push(((p.x + 1) / 2) * 1920, ((1 - p.y) / 2) * 1080);
        }
      }
      this.outline = pts;
    }

    this.r.toneMappingExposure = exposure;
    const bw = this.backCv.width;
    const bh = this.backCv.height;
    // the back layer only shows once the pouch is open, before that the front covers all of it
    if (this.back && this.phase === "rip") {
      this.camera.layers.set(1);
      this.r.render(this.scene, this.camera);
      this.back.clearRect(0, 0, bw, bh);
      this.back.drawImage(this.r.domElement, 0, 0);
      this.backShown = true;
    } else if (this.back && this.backShown) {
      this.back.clearRect(0, 0, bw, bh);
      this.backShown = false;
    }
    this.camera.layers.set(0);
    this.r.render(this.scene, this.camera);
  }
}

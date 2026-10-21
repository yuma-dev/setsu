// canvas helpers for the recap scenes: landmark outlines and the dot grid layout

// half outlines, mirrored around x; a = width over height, p = [x, y] with y up from the ground
interface Sil {
  a: number;
  p?: Array<[number, number]>;
  full?: Array<[number, number]>;
  arch?: [number, number];
  clock?: [number, number];
}
const SIL: Record<string, Sil> = {
  eiffel: {
    a: 0.38,
    p: [[1, 0], [0.78, 0.1], [0.6, 0.2], [0.66, 0.2], [0.66, 0.235], [0.52, 0.235], [0.4, 0.38], [0.44, 0.38], [0.44, 0.41], [0.32, 0.41], [0.14, 0.75], [0.17, 0.75], [0.17, 0.78], [0.1, 0.78], [0.05, 0.93], [0.015, 1]],
    arch: [0.55, 0.13],
  },
  bigben: { a: 0.16, p: [[1, 0], [1, 0.66], [1.18, 0.66], [1.18, 0.7], [1, 0.7], [1, 0.78], [0.62, 0.84], [0.62, 0.88], [0.12, 0.99], [0, 1]], clock: [0.62, 0.6] },
  light: { a: 0.26, p: [[1, 0], [0.62, 0.78], [0.95, 0.78], [0.95, 0.82], [0.58, 0.82], [0.58, 0.93], [0.3, 0.98], [0, 1]] },
  house: { a: 1, p: [[0.85, 0], [0.85, 0.6], [1, 0.58], [0, 1]] },
  burj: { a: 0.11, p: [[1, 0], [1, 0.2], [0.8, 0.2], [0.8, 0.4], [0.6, 0.4], [0.6, 0.58], [0.42, 0.58], [0.42, 0.74], [0.24, 0.74], [0.16, 0.88], [0.03, 1]] },
  mountain: { a: 2.4, full: [[-1, 0], [-0.55, 0.45], [-0.38, 0.4], [-0.1, 0.92], [0, 1], [0.12, 0.9], [0.3, 0.7], [0.45, 0.74], [1, 0]] },
  bus: { a: 2.5 },
  person: { a: 0.3 },
};

export function rrp(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** outline of a reference landmark standing on yb, h tall; returns its half width */
export function drawSil(ctx: CanvasRenderingContext2D, k: string, x: number, yb: number, h: number): number {
  const S = SIL[k];
  if (!S) return 0;
  const hw = (h * S.a) / 2;
  ctx.beginPath();
  if (k === "bus") {
    rrp(ctx, x - hw, yb - h * 0.92, hw * 2, h * 0.8, h * 0.12);
    ctx.moveTo(x - hw * 0.62 + h * 0.12, yb - h * 0.12);
    ctx.arc(x - hw * 0.62, yb - h * 0.12, h * 0.12, 0, Math.PI * 2);
    ctx.moveTo(x + hw * 0.62 + h * 0.12, yb - h * 0.12);
    ctx.arc(x + hw * 0.62, yb - h * 0.12, h * 0.12, 0, Math.PI * 2);
  } else if (k === "person") {
    ctx.arc(x, yb - h * 0.9, h * 0.095, 0, Math.PI * 2);
    rrp(ctx, x - hw * 0.85, yb - h * 0.78, hw * 1.7, h * 0.78, hw * 0.7);
  } else {
    const P = S.full || [...S.p!, ...S.p!.slice().reverse().map(([a, b]): [number, number] => [-a, b])];
    P.forEach(([a, b], i) => {
      const px = x + a * hw;
      const py = yb - b * h;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
    if (S.arch) {
      ctx.moveTo(x + S.arch[0] * hw, yb);
      ctx.ellipse(x, yb, S.arch[0] * hw, S.arch[1] * h, 0, 0, Math.PI, true);
      ctx.closePath();
    }
  }
  ctx.fillStyle = "rgba(243,241,247,.09)";
  ctx.fill("evenodd");
  ctx.strokeStyle = "rgba(243,241,247,.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (S.clock) {
    ctx.beginPath();
    ctx.arc(x, yb - S.clock[1] * h, S.clock[0] * hw, 0, Math.PI * 2);
    ctx.fillStyle = "#07060b";
    ctx.fill();
    ctx.stroke();
  }
  return hw;
}

export function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  rrp(ctx, x - s, y - s * 0.09, s * 2, s * 0.18, s * 0.09);
  ctx.moveTo(x + s * 0.15, y);
  ctx.lineTo(x - s * 0.25, y - s * 0.75);
  ctx.lineTo(x - s * 0.42, y - s * 0.75);
  ctx.lineTo(x - s * 0.2, y);
  ctx.lineTo(x - s * 0.42, y + s * 0.75);
  ctx.lineTo(x - s * 0.25, y + s * 0.75);
  ctx.closePath();
  ctx.moveTo(x - s * 0.78, y);
  ctx.lineTo(x - s * 0.95, y - s * 0.35);
  ctx.lineTo(x - s * 1.02, y - s * 0.35);
  ctx.lineTo(x - s * 0.92, y);
  ctx.closePath();
  ctx.fillStyle = "rgba(243,241,247,.8)";
  ctx.fill();
}

export function drawISS(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "rgba(243,241,247,.85)";
  ctx.fillRect(x - 52, y - 1.5, 104, 3);
  ctx.fillRect(x - 12, y - 6, 24, 12);
  ctx.fillStyle = "rgba(150,170,255,.5)";
  ctx.strokeStyle = "rgba(210,215,255,.9)";
  ctx.lineWidth = 1;
  for (const dx of [-50, -34, 22, 38]) {
    ctx.fillRect(x + dx, y - 20, 12, 40);
    ctx.strokeRect(x + dx, y - 20, 12, 40);
  }
}

export interface Placed {
  qx: number;
  qy: number;
}

/** stacks each group's dots in columns from the baseline up, the biggest pitch that fits */
export function lay<T extends Placed>(groups: T[][], X0: number, X1: number, BY: number, HM: number, PM: number) {
  const n = groups.length;
  const cw = (X1 - X0) / n;
  const mx = Math.max(1, ...groups.map((g) => g.length));
  let P = 0;
  let K = 1;
  for (let k = 1; k <= 40; k++) {
    const q = Math.min(PM, (cw * 0.84) / k, HM / Math.ceil(mx / k));
    if (q > P) {
      P = q;
      K = k;
    }
  }
  const tops = groups.map((g, gi) => {
    g.forEach((d, i) => {
      const c = i % K;
      const r = Math.floor(i / K);
      d.qx = X0 + gi * cw + cw / 2 + (c - (K - 1) / 2) * P;
      d.qy = BY - (r + 0.5) * P;
    });
    return BY - Math.ceil(g.length / K) * P;
  });
  return { P, K, cw, tops };
}

/** seeded so every open draws the same sky */
export function seeded(seed: number): () => number {
  let sd = seed;
  return () => {
    sd = (sd * 16807) % 2147483647;
    return sd / 2147483647;
  };
}

/** an image that falls through its sources when one fails to load */
export function loadImage(srcs: string[]): HTMLImageElement {
  const img = new Image();
  let i = 0;
  img.onerror = () => {
    if (++i < srcs.length) img.src = srcs[i];
  };
  if (srcs.length) img.src = srcs[0];
  return img;
}

export const ready = (img: HTMLImageElement | undefined): img is HTMLImageElement =>
  Boolean(img && img.complete && img.naturalWidth);

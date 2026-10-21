import { memo, useEffect, useRef } from "react";
import { checkRecapEligible, markRecapDocked, openRecap, useRecap } from "../recap/recapStore";

// the Setsu star, filled pearl like the recap's year
const STAR = "M500 63A437 437 0 0 0 937 500A437 437 0 0 0 500 937A437 437 0 0 0 63 500A437 437 0 0 0 500 63Z";
// the four point sparkle the update pill bursts
const SPARKLE =
  "M392.05 0c-20.9,210.08 -184.06,378.41 -392.05,407.78 207.96,29.37 371.12,197.68 392.05,407.74 20.93,-210.06 184.09,-378.37 392.05,-407.74 -207.98,-29.38 -371.16,-197.69 -392.06,-407.78z";

function Sparkle({ className }: { className: string }) {
  return (
    <svg className={`rail-recap-spark ${className}`} viewBox="0 0 784.11 815.53" aria-hidden>
      <path d={SPARKLE} />
    </svg>
  );
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the pill drawn flat into a canvas, so the flight can lay it along its path strip by strip and
 * bend it round the turn; a dom copy can only turn as a stiff block */
function pillTexture(pill: HTMLElement, w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext("2d")!;
  g.scale(dpr, dpr);
  const box = pill.getBoundingClientRect();
  const shape = () => {
    g.beginPath();
    g.roundRect(0.75, 0.75, w - 1.5, h - 1.5, Math.min(11, h / 2 - 1));
  };
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#1d0a33");
  bg.addColorStop(0.5, "#33105a");
  bg.addColorStop(1, "#1a0830");
  shape();
  g.fillStyle = bg;
  g.fill();
  const ring = g.createLinearGradient(0, 0, w, 0);
  ["#ff9ef5", "#b9a5ff", "#8ff0ff", "#a8ffcf", "#ffe3a3", "#ff9ef5"].forEach((col, i) => ring.addColorStop(i / 5, col));
  shape();
  g.lineWidth = 1.5;
  g.strokeStyle = ring;
  g.stroke();
  const pearl = (x0: number, x1: number) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, "#ffd6f7");
    gr.addColorStop(0.5, "#d9c4ff");
    gr.addColorStop(1, "#b8ecff");
    return gr;
  };
  const ico = pill.querySelector(".r-ico")?.getBoundingClientRect();
  if (ico) {
    const cx = ico.left - box.left + ico.width / 2;
    const cy = ico.top - box.top + ico.height / 2;
    g.save();
    g.translate(cx - 8, cy - 8);
    g.scale(0.016, 0.016);
    g.shadowColor = "rgba(255,158,245,.75)";
    g.shadowBlur = 4;
    g.fillStyle = pearl(0, 1000);
    g.fill(new Path2D(STAR));
    g.restore();
  }
  const label = pill.querySelector<HTMLElement>(".rail-label");
  if (label && getComputedStyle(label).opacity !== "0") {
    const cs = getComputedStyle(label);
    const lr = label.getBoundingClientRect();
    const year = pill.querySelector(".rail-recap-year")?.textContent ?? "";
    let x = lr.left - box.left;
    const y = lr.top - box.top + lr.height / 2;
    g.textBaseline = "middle";
    const put = (t: string, weight: string, fill: string | CanvasGradient) => {
      g.font = `${weight} ${cs.fontSize} ${cs.fontFamily}`;
      g.fillStyle = fill;
      g.fillText(t, x, y);
      x += g.measureText(t).width;
    };
    put("Your ", cs.fontWeight, "#f7f0ff");
    g.font = `800 ${cs.fontSize} ${cs.fontFamily}`;
    put(year, "800", pearl(x, x + g.measureText(year).width));
    put(" recap", cs.fontWeight, "#f7f0ff");
  }
  return c;
}

/** the flight as a path, sampled by length: from the pill's left end a straight run out of the
 * rail, a U turn up and over (where it turns, a quarter to point straight up, another to come back
 * upside down), then a straight run back along the settings row into the gear's centre */
function flightPath(x0: number, y0: number, run: number, gx: number, gy: number) {
  const xc = x0 + run;
  const ry = Math.max(40, (y0 - gy) / 2);
  const rx = Math.min(230, Math.max(110, ry * 0.7));
  const yc = (y0 + gy) / 2;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 60; i++) pts.push([x0 + ((xc - x0) * i) / 60, y0]);
  for (let i = 1; i <= 180; i++) {
    const p = Math.PI / 2 - (Math.PI * i) / 180;
    pts.push([xc + rx * Math.cos(p), yc + ry * Math.sin(p)]);
  }
  for (let i = 1; i <= 80; i++) pts.push([xc + ((gx - xc) * i) / 80, gy]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  // headings, unwrapped so the half turn never snaps the short way round
  const head = [0];
  for (let i = 1; i < pts.length; i++) {
    let h = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    while (h - head[i - 1] > Math.PI) h -= 2 * Math.PI;
    while (h - head[i - 1] < -Math.PI) h += 2 * Math.PI;
    head.push(h);
  }
  const total = len[len.length - 1];
  const at = (d: number): [number, number, number] => {
    const dd = Math.min(total, Math.max(0, d));
    let lo = 0;
    let hi = len.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (len[m] < dd) lo = m;
      else hi = m;
    }
    const q = len[hi] > len[lo] ? (dd - len[lo]) / (len[hi] - len[lo]) : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * q, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * q, head[lo] + (head[hi] - head[lo]) * q];
  };
  return { at, total };
}

/** the head's share of the flight distance at a share of the flight time, after the release: one
 * speed curve integrated once, launched fast, easing a little through the turn, then faster and
 * faster into the gear, never stopping on the way */
function flightCurve(): (q: number) => number {
  const N = 240;
  const acc = [0];
  for (let i = 1; i <= N; i++) {
    const q = i / N;
    acc.push(acc[i - 1] + 1 + 2.4 * Math.exp(-q / 0.08) + 3.2 * Math.pow(q, 2.2));
  }
  return (q: number) => {
    const x = Math.min(1, Math.max(0, q)) * N;
    const i = Math.min(N - 1, Math.floor(x));
    return (acc[i] + (acc[i + 1] - acc[i]) * (x - i)) / acc[N];
  };
}

/** the pill jumps out of the rail, then the settings gear pulls it in: it follows the path round,
 * bending with it, faster and faster, right end first (upside down and on the left by the end), and
 * flows into the gear narrowing like a funnel while a glow builds there. the gear swells as it
 * closes in and spins as it swallows the last of it. drawn on a canvas over the window while the
 * pill's own slot folds shut */
function flyToSettings(pill: HTMLElement, done: () => void): void {
  const gear = document.querySelector<HTMLElement>('.rail-nav [data-nav="settings"]');
  const ico = gear?.querySelector<HTMLElement>(".r-ico") ?? gear;
  if (!gear || !ico || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    console.info(`recap: ${gear ? "reduced motion, skipping the fly" : "no settings button to fly into"}`);
    done();
    return;
  }
  const a = pill.getBoundingClientRect();
  const b = ico.getBoundingClientRect();
  const W = a.width;
  const H = a.height;
  const gx = b.left + b.width / 2;
  const gy = b.top + b.height / 2;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const tex = pillTexture(pill, W, H, dpr);
  const POP = 170;
  // how far the right end draws out before it lets go
  const STRETCH = 58;
  const path = flightPath(a.left, a.top + H / 2, W + POP, gx, gy);
  const flight = flightCurve();
  const E = path.total;
  const cv = document.createElement("canvas");
  cv.className = "rail-recap-flight";
  cv.width = Math.round(innerWidth * dpr);
  cv.height = Math.round(innerHeight * dpr);
  document.body.appendChild(cv);
  const g = cv.getContext("2d")!;
  const DUR = 1720;
  // the draw-back takes this share of the time, the flight the rest
  const PULL = 0.245;
  pill.style.visibility = "hidden";
  pill.animate([{ height: `${H}px`, minHeight: "0px", marginTop: "10px" }, { height: "0px", minHeight: "0px", marginTop: "0px" }], {
    duration: 420,
    delay: DUR * PULL,
    easing: "cubic-bezier(.4,0,.2,1)",
    fill: "forwards",
  });
  void import("../recap/audio").then((au) => {
    // the release: a pop as it lets go, the whoosh of the flight right after
    au.pop({ at: (DUR * PULL) / 1000 });
    au.play("card-flick", { at: (DUR * PULL) / 1000 + 0.03, gain: 0.6 });
    au.play("stinger-star", { at: (DUR * 0.9) / 1000, gain: 0.55 });
  });
  const t0 = performance.now();
  let trail = 0;
  let pulled = false;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / DUR);
    // where the pill's right end is along the path and how long the ribbon is. first the draw-back:
    // the right end pulls out of the rail while the left end holds, thinning like a band. then it
    // lets go, the left end snaps after it, and the release carries straight into the flight,
    // stretching with speed until its tail has gone into the gear
    let headD: number;
    let len: number;
    let thick: number;
    if (t < PULL) {
      const q = smooth(0, 1, t / PULL);
      headD = W + STRETCH * q;
      len = W + STRETCH * q;
      thick = 1 - 0.14 * q;
    } else {
      const q = (t - PULL) / (1 - PULL);
      const snap = Math.exp(-q / 0.05);
      len = W * (1 + 0.45 * q * q) + STRETCH * snap;
      thick = 1 + 0.1 * Math.sin(Math.min(1, q / 0.14) * Math.PI) - 0.14 * snap;
      headD = W + STRETCH + (E + W * 1.45 - W - STRETCH) * flight(q);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    // the glow at the gear: building as it closes in, strongest while it swallows
    const near = smooth(E - 420, E, headD);
    const eaten = Math.min(1, Math.max(0, (headD - E) / len));
    const glowA = 0.55 * near + 0.45 * eaten;
    if (glowA > 0.01) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rg = g.createRadialGradient(gx, gy, 0, gx, gy, 46);
      rg.addColorStop(0, `rgba(255,214,247,${(0.9 * glowA).toFixed(3)})`);
      rg.addColorStop(0.35, `rgba(185,165,255,${(0.45 * glowA).toFixed(3)})`);
      rg.addColorStop(1, "rgba(185,165,255,0)");
      g.fillStyle = rg;
      g.fillRect(gx - 46, gy - 46, 92, 92);
    }
    // the ribbon, two pixels of the pill at a time, each on the path at its own distance and turned
    // to the path there, so the back follows the same curve as the front. near the gear it narrows
    // like a funnel, past it it's gone
    const SL = 2;
    for (let x = 0; x < W; x += SL) {
      const d = headD - (W - x - SL / 2) * (len / W);
      if (d > E) continue;
      const [px, py, th] = path.at(d);
      const funnel = 0.1 + 0.9 * smooth(0, 110, E - d);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(px, py);
      g.rotate(th);
      const sw = SL * (len / W) + 0.6;
      g.drawImage(tex, x * dpr, 0, SL * dpr, H * dpr, -sw / 2, (-H * thick * funnel) / 2, sw, H * thick * funnel);
    }
    if (!pulled && near > 0.15) {
      pulled = true;
      gear.classList.add("rail-pulling");
    }
    // glints off its tail
    const tailD = headD - len;
    if (t > PULL && tailD < E - 20 && now - trail > 40) {
      trail = now;
      const [tx, ty] = path.at(Math.max(0, tailD));
      const s = document.createElement("i");
      s.className = "rail-recap-trail";
      s.style.left = `${tx + (Math.random() - 0.5) * 10}px`;
      s.style.top = `${ty + (Math.random() - 0.5) * 10}px`;
      s.dataset.h = String(Math.floor(Math.random() * 3));
      document.body.appendChild(s);
      window.setTimeout(() => s.remove(), 700);
    }
    if (t < 1) requestAnimationFrame(step);
    else {
      cv.remove();
      gear.classList.remove("rail-pulling");
      gear.classList.add("rail-absorb");
      window.setTimeout(() => gear.classList.remove("rail-absorb"), 900);
      done();
    }
  };
  requestAnimationFrame(step);
}

// sits above the update pill; only there once __recap() turned it on and the year has enough to
// recap. after the recap was seen through it flies into settings once and from then on only shows
// in the settings rail
function RecapPill({ inSettings }: { inSettings: boolean }) {
  const { enabled: on, year, open, finished, docked, flyNow, eligible, force } = useRecap();
  // asked a while after launch: the check scans the clip list, and at launch the library is doing
  // the same
  useEffect(() => {
    if (!on || force) return;
    const t = window.setTimeout(checkRecapEligible, 2500);
    return () => window.clearTimeout(t);
  }, [on, force, year]);
  const enabled = on && (force || eligible === true);
  const ref = useRef<HTMLButtonElement>(null);
  const flying = useRef(false);
  const launch = () => {
    if (!ref.current || flying.current) return;
    flying.current = true;
    flyToSettings(ref.current, () => {
      // the same pill can fly again after __recapUndock()
      flying.current = false;
      markRecapDocked();
    });
  };
  useEffect(() => {
    if (!enabled || !finished || docked || open || inSettings || flying.current) return;
    // only with someone looking: on a launch it played before the window was even shown. so the
    // pointer has to move over the window first, then a beat for the rail to settle
    let t = 0;
    const go = () => {
      window.removeEventListener("pointermove", go);
      t = window.setTimeout(launch, 600);
    };
    window.addEventListener("pointermove", go);
    return () => {
      window.removeEventListener("pointermove", go);
      window.clearTimeout(t);
    };
  }, [enabled, finished, docked, open, inSettings]);
  // __recapFly(): straight away, the pointer is in devtools when it's typed
  useEffect(() => {
    if (!flyNow) return;
    if (inSettings) {
      console.info("recap: in settings the button already lives here, it flies once you leave");
      return;
    }
    const t = window.setTimeout(launch, 250);
    return () => window.clearTimeout(t);
  }, [flyNow]);
  if (!enabled || (docked && !inSettings)) return null;
  return (
    <button ref={ref} type="button" data-rail-tip={`Your ${year} recap`} className="rail-recap" onClick={openRecap}>
      <span className="r-ico">
        <svg className="rail-recap-star" viewBox="0 0 1000 1000" aria-hidden>
          <defs>
            <linearGradient id="rail-recap-pearl" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffd6f7" />
              <stop offset="0.5" stopColor="#d9c4ff" />
              <stop offset="1" stopColor="#b8ecff" />
            </linearGradient>
          </defs>
          <path d={STAR} fill="url(#rail-recap-pearl)" />
        </svg>
      </span>
      <span className="rail-label rail-recap-label">
        Your <span className="rail-recap-year">{year}</span> recap
      </span>
      <Sparkle className="spark-1" />
      <Sparkle className="spark-2" />
      <Sparkle className="spark-3" />
    </button>
  );
}

export default memo(RecapPill);

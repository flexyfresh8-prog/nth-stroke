// V4 motor-control mathematics — human movement models, expressed as pure
// functions so they can be unit-verified (spec §6).
//
//  • Minimum-jerk point-to-point trajectories — Flash & Hogan (1985):
//    x(τ) = x0 + Δ·(10τ³ − 15τ⁴ + 6τ⁵); smooth bell velocity, zero end-point
//    velocity and acceleration. Used for pen-up travel and approach moves.
//  • Sigma-lognormal speed profile — Plamondon's kinematic theory of rapid
//    human movements: v(t) = D/(σ√(2π)(t−t0))·exp(−(ln(t−t0)−μ)²/(2σ²)).
//    Asymmetric accelerate-fast / decelerate-slow strokes. Sampled into a
//    normalised arc-length lookup shared by every stroke.
//  • Two-thirds power law — Lacquaniti, Terzuolo & Viviani (1983):
//    angular velocity ω = k·κ^(2/3), i.e. tangential v = k·κ^(−1/3): the pen
//    slows into curves in the same proportion as a human hand.
//  • Fitts' law for travel timing: MT = a + b·log₂(2D/W).
//  • Corrective submovements (Meyer et al.): overlapping minimum-jerk pulses
//    added vectorially to the primary movement.
//  • Raised-cosine pressure envelopes: C¹-continuous pressure transitions
//    (a real nib cannot step pressure instantaneously).

export interface MinJerk {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  T: number;
  t: number;
}

export function startMinJerk(x0: number, y0: number, x1: number, y1: number, T: number): MinJerk {
  return { x0, y0, dx: x1 - x0, dy: y1 - y0, T, t: 0 };
}

/** Advance a minimum-jerk hop; returns [x, y, done]. */
export function stepMinJerk(m: MinJerk, dt: number): [number, number, boolean] {
  m.t = Math.min(m.T, m.t + dt);
  const tau = m.T > 0 ? m.t / m.T : 1;
  const s = tau * tau * tau * (10 - 15 * tau + 6 * tau * tau); // 10τ³−15τ⁴+6τ⁵
  return [m.x0 + m.dx * s, m.y0 + m.dy * s, m.t >= m.T];
}

/** Analytic minimum-jerk position/velocity at normalised time τ (tests). */
export const minJerkPos = (tau: number) => tau * tau * tau * (10 - 15 * tau + 6 * tau * tau);
export const minJerkVel = (tau: number) => 30 * tau * tau * (1 - 2 * tau + tau * tau);

/** Fitts' law travel time: a + b·log₂(2D/W) seconds. */
export function fittsTime(distance: number, tolerance: number, a = 0.16, b = 0.13): number {
  const W = Math.max(1.5, tolerance);
  return a + b * Math.log2((2 * Math.max(1, distance)) / W + 1);
}

// --- sigma-lognormal -------------------------------------------------------

/**
 * Sample a lognormal velocity profile into an arc-length-indexed shape table
 * with mean 1. `s01` ∈ [0,1] is fraction of stroke length; the value is the
 * speed multiplier at that point (mean 1, range clamped for stability).
 */
export class SpeedShape {
  private table: Float32Array;
  constructor(sigmaLogWeight: number, seedPhase: number) {
    // Handwriting statistics: μ ≈ −2, σ ≈ 0.35 (Plamondon), with per-stroke
    // variation. sigmaLogWeight 0 → flat (no shaping).
    const n = 64,
      mu = -2.0 + 0.25 * Math.sin(seedPhase * 2.3),
      sigma = 0.32 + 0.1 * Math.cos(seedPhase * 1.7),
      v = new Float32Array(n);
    let total = 0;
    const t0 = 0.012;
    for (let i = 0; i < n; i++) {
      const t = t0 + ((i + 0.5) / n) * (Math.exp(mu + 3.2 * sigma) - t0);
      const ln = Math.log(t - t0);
      const speed = (1 / ((t - t0) * sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-((ln - mu) ** 2) / (2 * sigma * sigma));
      v[i] = speed;
      total += speed;
    }
    const mean = total / n || 1;
    this.table = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const shaped = 1 + (v[i] / mean - 1) * sigmaLogWeight;
      this.table[i] = Math.max(0.28, Math.min(2.1, shaped));
    }
  }
  at(s01: number): number {
    const s = s01 < 0 ? 0 : s01 > 1 ? 1 : s01;
    const f = s * (this.table.length - 1),
      i = Math.floor(f),
      k = f - i;
    return i >= this.table.length - 1 ? this.table[this.table.length - 1] : this.table[i] * (1 - k) + this.table[i + 1] * k;
  }
}

// --- two-thirds power law --------------------------------------------------

/**
 * Speed multiplier from curvature: v = k·κ^(−1/3), calibrated so that
 * multiplier = 1 at κ = κref. Clamped to [0.22, 1.5] — the hand never fully
 * stops in a cusp and never races on straights beyond 1.5×.
 */
export function powerLawFactor(kappa: number, kappaRef: number, weight: number): number {
  if (weight <= 0) return 1;
  const k = Math.max(1e-4, kappa),
    ref = Math.max(1e-4, kappaRef);
  const raw = Math.pow(ref / k, 1 / 3);
  const shaped = 1 + (raw - 1) * weight;
  return Math.max(0.22, Math.min(1.5, shaped));
}

// --- submovements ----------------------------------------------------------

export interface Submovement {
  /** Additive offset target (px) applied over its lifetime. */
  ox: number;
  oy: number;
  t: number;
  T: number;
}

/**
 * Vectorial submovement synthesis: each correction is a minimum-jerk offset
 * pulse; the sum of active pulses is the total corrective displacement.
 */
export function stepSubmovements(list: Submovement[], dt: number): [number, number] {
  let x = 0,
    y = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    s.t = Math.min(s.T, s.t + dt);
    x += s.ox * minJerkPos(s.t / s.T);
    y += s.oy * minJerkPos(s.t / s.T);
    if (s.t >= s.T) list.splice(i, 1);
  }
  return [x, y];
}

export function addSubmovement(list: Submovement[], ox: number, oy: number, T: number) {
  list.push({ ox, oy, t: 0, T: Math.max(0.03, T) });
}

// --- pressure envelope -----------------------------------------------------

export interface PressureEnvelope {
  entry: number;
  level: number;
  exit: number;
  attack: number;
  release: number;
}

/** Raised-cosine ramps between entry → level → exit along s01 ∈ [0,1]. */
export function pressureAt(s01: number, e: PressureEnvelope): number {
  const s = s01 < 0 ? 0 : s01 > 1 ? 1 : s01;
  const rise = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t); // C¹ smooth
  let p: number;
  if (s < e.attack) p = e.entry + (e.level - e.entry) * rise(s / Math.max(1e-4, e.attack));
  else if (s > 1 - e.release) p = e.level + (e.exit - e.level) * rise((s - (1 - e.release)) / Math.max(1e-4, e.release));
  else p = e.level;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

// --- path utilities --------------------------------------------------------

/** Cumulative arc lengths of a flat [x,y,…] polyline. */
export function arcLengths(pts: Float32Array): Float64Array {
  const n = pts.length / 2,
    out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = pts[2 * i] - pts[2 * i - 2],
      dy = pts[2 * i + 1] - pts[2 * i - 1];
    out[i] = out[i - 1] + Math.hypot(dx, dy);
  }
  return out;
}

/** Discrete curvature (1/radius) at vertex i via the circumscribed circle. */
export function curvatureAt(pts: Float32Array, i: number): number {
  const n = pts.length / 2;
  const a = Math.max(0, i - 1),
    b = Math.min(n - 1, i + 1);
  if (b === a) return 0;
  const ax = pts[2 * a],
    ay = pts[2 * a + 1],
    bx = pts[2 * i],
    by = pts[2 * i + 1],
    cx = pts[2 * b],
    cy = pts[2 * b + 1];
  const abx = bx - ax,
    aby = by - ay,
    bcx = cx - bx,
    bcy = cy - by;
  const cross = abx * bcy - aby * bcx;
  const d1 = Math.hypot(abx, aby),
    d2 = Math.hypot(bcx, bcy);
  if (d1 < 1e-6 || d2 < 1e-6) return 0;
  const denom = d1 * d2 * Math.hypot(bcx - abx, bcy - aby);
  if (denom < 1e-7) return 0;
  return Math.abs(2 * cross) / denom;
}

/** Interpolated point + tangent at arc length s along the polyline. */
export function pointAtArc(pts: Float32Array, arc: Float64Array, s: number, out: Float32Array): void {
  const n = arc.length;
  if (n === 0) return;
  if (s <= 0) {
    out[0] = pts[0];
    out[1] = pts[1];
    out[2] = pts[2] - pts[0] || 1;
    out[3] = pts[3] - pts[1] || 0;
    return;
  }
  const total = arc[n - 1];
  if (s >= total) {
    out[0] = pts[2 * n - 2];
    out[1] = pts[2 * n - 1];
    out[2] = pts[2 * n - 2] - pts[2 * n - 4] || 1;
    out[3] = pts[2 * n - 1] - pts[2 * n - 3] || 0;
    return;
  }
  // binary search for segment
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - arc[lo]) / Math.max(1e-9, arc[hi] - arc[lo]);
  out[0] = pts[2 * lo] + (pts[2 * hi] - pts[2 * lo]) * t;
  out[1] = pts[2 * lo + 1] + (pts[2 * hi + 1] - pts[2 * lo + 1]) * t;
  const tx = pts[2 * hi] - pts[2 * lo],
    ty = pts[2 * hi + 1] - pts[2 * lo + 1];
  const len = Math.hypot(tx, ty) || 1;
  out[2] = tx / len;
  out[3] = ty / len;
}

/** Resample a polyline to ~even spacing (used before motor execution). */
export function resample(pts: Float32Array, spacing: number): Float32Array {
  const arc = arcLengths(pts);
  const total = arc[arc.length - 1];
  if (total < 1e-6) return pts.slice();
  const n = Math.max(2, Math.round(total / Math.max(0.75, spacing)) + 1);
  const out = new Float32Array(2 * n);
  const probe = new Float32Array(4);
  for (let i = 0; i < n; i++) {
    pointAtArc(pts, arc, (total * i) / (n - 1), probe);
    out[2 * i] = probe[0];
    out[2 * i + 1] = probe[1];
  }
  return out;
}

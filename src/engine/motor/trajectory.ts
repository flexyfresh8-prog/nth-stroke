/**
 * Trajectory generation for the virtual hand (spec §5).
 *
 * Human stroke kinematics are modelled with two established motor-control
 * laws rather than cosmetic randomness:
 *
 *  - Minimum-jerk profile: movements start and end at zero velocity and
 *    acceleration with a bell-shaped speed curve (Flash & Hogan 1985).
 *  - Two-thirds power law: tangential speed scales with the curvature
 *    radius as v = K·R^(1/3) — the hand slows into bends (Lacquaniti 1983).
 *  - Fitts's law: pointing/travel time grows logarithmically with the
 *    distance-to-target-width ratio.
 *
 * Signal-dependent motor noise (Harris & Wolpert) is added as a smooth
 * Ornstein–Uhlenbeck process on the motor command — never as position
 * jitter — so variability emerges from the controller itself.
 */

import { clamp } from '../core/math';
import { catmullRom, cumulativeLengths, curvatureRadius, resample, simplify } from '../core/math';
import type { Vec2 } from '../core/types';
import type { Rng } from '../core/rng';

export interface TrajectorySample {
  x: number;
  y: number;
  /** Arc position (px). */
  s: number;
  /** Local tangent direction. */
  dir: number;
}

export interface TimingProfile {
  /** Cumulative time at each arc position (same length as positions). */
  times: number[];
  totalMs: number;
}

export const SAMPLE_HZ = 240;
export const SAMPLE_DT = 1000 / SAMPLE_HZ;

/** Build a dense, smoothed trajectory from planner waypoints. */
export function buildTrajectory(waypoints: Vec2[], smooth: boolean): TrajectorySample[] {
  let pts: Vec2[];
  if (waypoints.length === 2) {
    // Straight construction lines stay straight — only resampled.
    const a = waypoints[0];
    const b = waypoints[1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(2, Math.ceil(len / 1.25));
    pts = Array.from({ length: n + 1 }, (_, i) => ({
      x: a.x + ((b.x - a.x) * i) / n,
      y: a.y + ((b.y - a.y) * i) / n,
    }));
  } else {
    const simple = simplify(waypoints, 0.55);
    pts = smooth ? catmullRom(simple.length >= 3 ? simple : waypoints, 6) : simple;
    pts = resample(pts, 1.25);
  }
  const cum = cumulativeLengths(pts);
  const out: TrajectorySample[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    out.push({
      x: pts[i].x,
      y: pts[i].y,
      s: cum[i],
      dir: Math.atan2(next.y - prev.y, next.x - prev.x),
    });
  }
  return out;
}

/**
 * Two-thirds power-law speed profile blended with a minimum-jerk envelope,
 * scaled so the mean speed matches the requested pace.
 */
export function powerLawTiming(traj: TrajectorySample[], targetSpeed: number, speedScale: number): TimingProfile {
  const total = traj.length > 0 ? traj[traj.length - 1].s : 0;
  if (total <= 0) return { times: traj.map(() => 0), totalMs: 0 };
  const vmax = Math.max(0.05, targetSpeed * speedScale);
  const vmin = Math.max(0.045, vmax * 0.3);

  // Mean of R^(1/3) to normalize K so average speed ≈ vmax.
  let rSum = 0;
  const rRoots: number[] = [];
  for (let i = 0; i < traj.length; i++) {
    // Use a windowed curvature so single-vertex kinks don't stall the hand.
    const ia = Math.max(0, i - 3);
    const ib = Math.min(traj.length - 1, i + 3);
    let rMin = Infinity;
    for (let k = ia; k <= ib; k++) {
      const pts3 = [traj[Math.max(0, k - 1)], traj[k], traj[Math.min(traj.length - 1, k + 1)]];
      const r = windowCurvature(pts3);
      if (r < rMin) rMin = r;
    }
    const root = Math.pow(Math.min(rMin, 4000), 1 / 3);
    rRoots.push(root);
    rSum += root;
  }
  const rootMean = Math.max(0.4, rSum / traj.length);
  const K = vmax / rootMean;

  const times: number[] = [0];
  let t = 0;
  for (let i = 1; i < traj.length; i++) {
    const ds = traj[i].s - traj[i - 1].s;
    const sMid = (traj[i].s + traj[i - 1].s) / 2 / total; // normalized arc
    // Min-jerk envelope over arc: bell-shaped acceleration/deceleration.
    // The floor keeps the pen from crawling (which would cook the physics).
    const env = Math.max(0.16, 30 * sMid * sMid * (1 - sMid) * (1 - sMid) / 1.875);
    const v = clamp(K * ((rRoots[i] + rRoots[i - 1]) / 2), vmin, vmax * 1.6) * env;
    // v is in px/ms, so arc/time directly yields milliseconds.
    t += ds / Math.max(v, 1e-4);
    times.push(t);
  }
  return { times, totalMs: t };
}

function windowCurvature(pts: Array<{ x: number; y: number }>): number {
  return curvatureRadius(pts, 1);
}

/** Fitts's law travel time (ms) for a pen-up hop of `distance` px. */
export function fittsTravelMs(distance: number, targetRadius: number): number {
  const d = Math.max(1, distance);
  const w = Math.max(2, targetRadius);
  const id = Math.log2(d / w + 1);
  return 110 + 155 * id;
}

/** Minimum-jerk scalar profile s(t) for a movement of duration T. */
export function minJerk(t: number, T: number): number {
  if (T <= 0) return 1;
  const x = clamp(t / T, 0, 1);
  return 10 * x * x * x - 15 * x * x * x * x + 6 * x * x * x * x * x;
}

/**
 * Signal-dependent motor noise. Returns a per-sample 2-D offset made of two
 * Ornstein–Uhlenbeck components:
 *  - fast physiological tremor (short time constant, ~0.1 px), and
 *  - slow hand wander (long time constant, ~0.45 px) that is pinned to zero
 *    at touch-down and lift-off, so a line leaves and arrives where the
 *    planner intended but bows slightly in between like a hand-drawn line.
 * The earlier tremor-only noise had a stationary std of ~0.05 px, which is
 * invisible and left every stroke looking like a perfect spline.
 */
export function motorNoiseOffsets(
  n: number,
  speeds: number[],
  rng: Rng,
  tauMs = 55,
  gain = 0.006,
  wanderTauMs = 220,
  wanderStd = 0.45,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let ox = 0;
  let oy = 0;
  let wx = 0;
  let wy = 0;
  const wSigma = wanderStd * Math.sqrt(2 / wanderTauMs);
  for (let i = 0; i < n; i++) {
    const sigma = gain * (1 + speeds[i] * 6);
    ox += (-ox / tauMs) * SAMPLE_DT + sigma * rng.gaussian() * Math.sqrt(SAMPLE_DT);
    oy += (-oy / tauMs) * SAMPLE_DT + sigma * rng.gaussian() * Math.sqrt(SAMPLE_DT);
    wx += (-wx / wanderTauMs) * SAMPLE_DT + wSigma * rng.gaussian() * Math.sqrt(SAMPLE_DT);
    wy += (-wy / wanderTauMs) * SAMPLE_DT + wSigma * rng.gaussian() * Math.sqrt(SAMPLE_DT);
    const env = Math.pow(Math.sin((Math.PI * (i + 1)) / (n + 1)), 0.7);
    // Clamp so noise is a subtle tremor, never a jump.
    out.push({ x: clamp(ox + wx * env, -1.6, 1.6), y: clamp(oy + wy * env, -1.6, 1.6) });
  }
  return out;
}

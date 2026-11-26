/**
 * HandController — the virtual hand and stylus (spec §5).
 *
 * Executes one DrawOp at a time: pen-up travel (Fitts-timed minimum-jerk
 * hop with an arc), touch down, draw along the planned trajectory (power-law
 * timing + motor noise), lift. Emits a full 240 Hz sample stream with
 * continuously evolving position, velocity, pressure, tilt and azimuth.
 */

import type { Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import type { DrawOp, OpTrace, StylusSample, Vec2 } from '../core/types';
import { instrument } from '../media/instruments';
import { PressureModel, pressureTiming } from './pressure';
import {
  SAMPLE_DT,
  buildTrajectory,
  fittsTravelMs,
  minJerk,
  motorNoiseOffsets,
  powerLawTiming,
} from './trajectory';

export class HandController {
  private pressure = new PressureModel();
  /** Where the hand currently rests (canvas px). */
  cursor: Vec2 = { x: 0, y: 0 };
  /** Slowly evolving pen posture — consistent within a stroke. */
  private baseTilt = 0.16;
  private baseAzimuth = 0;

  constructor(private readonly rng: Rng) {}

  setCursor(p: Vec2) {
    this.cursor = { ...p };
  }

  /**
   * Generate the complete trace for an op. Deterministic given the RNG state
   * and the current cursor. Simulated time advances across calls.
   */
  execute(op: DrawOp, t0: number): OpTrace {
    const spec = instrument(op.instrument);
    this.pressure.reset();
    // Defensive: planners should never hand over empty paths.
    if (!op.waypoints || op.waypoints.length < 1 || !op.waypoints[0]) {
      return {
        opId: op.id,
        samples: [],
        contact: [],
        durationMs: 1,
        travelPx: 0,
        drawPx: 0,
        meanPressure: 0,
        peakPressure: 0,
      };
    }
    // Fresh pen posture for the stroke: artists regrip between strokes.
    this.baseTilt = op.broad ? 0.62 + this.rng.next() * 0.22 : 0.1 + this.rng.next() * 0.16;
    this.baseAzimuth = this.rng.next() * Math.PI * 2;

    const start = op.waypoints[0];
    const hop = Math.hypot(start.x - this.cursor.x, start.y - this.cursor.y);
    const samples: StylusSample[] = [];
    const contact: StylusSample[] = [];
    let t = t0;

    // ---- Pen-up travel -------------------------------------------------
    const travelTarget = Math.max(3, spec.baseRadius * 2);
    let travelMs = 0;
    if (op.travel && hop > 2.5) {
      travelMs = fittsTravelMs(hop, travelTarget) / clamp(0.8 + op.speed * 0.3, 0.8, 2.4);
      const steps = Math.max(2, Math.round(travelMs / SAMPLE_DT));
      const from = { ...this.cursor };
      for (let i = 1; i <= steps; i++) {
        const tt = (i * travelMs) / steps;
        const f = minJerk(tt, travelMs);
        const x = lerp(from.x, start.x, f);
        const y = lerp(from.y, start.y, f);
        // Gentle lift arc: up to 5 px above the paper mid-hop.
        const z = Math.sin(Math.PI * f) * Math.min(5, 2 + hop * 0.04);
        samples.push({
          t: t0 + tt,
          x,
          y,
          z,
          pressure: 0,
          v: 0,
          tilt: this.baseTilt,
          azimuth: this.baseAzimuth,
        });
      }
      t = t0 + travelMs;
    }

    // ---- Touch down ------------------------------------------------------
    const touchMs = 12 + this.rng.next() * 22;
    samples.push({
      t,
      x: start.x,
      y: start.y,
      z: 0,
      pressure: 0,
      v: 0,
      tilt: this.baseTilt,
      azimuth: this.baseAzimuth,
    });
    t += touchMs;

    // ---- Draw ------------------------------------------------------------
    const traj = buildTrajectory(op.waypoints, op.kind === 'stroke');
    const totalPx = traj.length ? traj[traj.length - 1].s : 0;
    const timing = powerLawTiming(traj, spec.naturalSpeed * spec.speedGain, clamp(op.speed, 0.3, 2.5));
    const strokeDuration = Math.max(SAMPLE_DT, timing.totalMs);
    const n = Math.max(1, Math.round(strokeDuration / SAMPLE_DT));
    const speeds: number[] = [];
    for (let i = 0; i < n; i++) speeds.push(0.3);
    const offsets = motorNoiseOffsets(n, speeds, this.rng);

    // Sample the trajectory at uniform dt via arc-time interpolation.
    const pts: Array<{ x: number; y: number; s: number; dir: number }> = traj;
    const times = timing.times;
    const pTiming = pressureTiming(op.pressure, this.rng);
    const pressureParams = {
      target: clamp(op.pressure, 0.05, 1),
      attackMs: pTiming.attackMs,
      releaseMs: pTiming.releaseMs,
      speedKnee: spec.naturalSpeed * 1.35,
    };

    let prevPos = { x: start.x, y: start.y };
    let prevT = t;
    let pressureSum = 0;
    let pressurePeak = 0;
    let contactCount = 0;

    if (totalPx <= 0.75) {
      // A tap (stipple / accent): pressure pulse without travel.
      const tapMs = 55 + this.rng.next() * 70;
      const steps = Math.max(2, Math.round(tapMs / SAMPLE_DT));
      for (let i = 1; i <= steps; i++) {
        const tt = (i * tapMs) / steps;
        const envelope = Math.sin(Math.PI * (tt / tapMs));
        const p = clamp(op.pressure * envelope, 0, 1);
        const s: StylusSample = {
          t: t + tt,
          x: start.x,
          y: start.y,
          z: 0,
          pressure: p,
          v: 0,
          tilt: this.baseTilt,
          azimuth: this.baseAzimuth,
        };
        samples.push(s);
        contact.push(s);
        pressureSum += p;
        pressurePeak = Math.max(pressurePeak, p);
        contactCount++;
      }
      t += tapMs;
    } else {
      let idx = 0;
      for (let i = 1; i <= n; i++) {
        const tt = i * SAMPLE_DT;
        // Advance idx to the trajectory segment covering tt.
        while (idx < times.length - 1 && times[idx + 1] < tt) idx++;
        const segStart = times[idx];
        const segEnd = times[Math.min(times.length - 1, idx + 1)];
        const f = segEnd > segStart ? clamp((tt - segStart) / (segEnd - segStart), 0, 1) : 1;
        const a = pts[idx];
        const b = pts[Math.min(pts.length - 1, idx + 1)];
        const x = lerp(a.x, b.x, f) + offsets[i - 1].x;
        const y = lerp(a.y, b.y, f) + offsets[i - 1].y;
        const v = (Math.hypot(x - prevPos.x, y - prevPos.y) / Math.max(SAMPLE_DT, tt - (prevT - t))) || 0;
        const p = this.pressure.step(SAMPLE_DT, tt, strokeDuration, Math.min(v, 2.5), pressureParams, this.rng);
        // Azimuth tracks stroke direction with lag (the hand leads the tool).
        const dir = lerp(a.dir, b.dir, f);
        const azimuth = angleTowards(this.baseAzimuth, dir, 0.65);
        const s: StylusSample = {
          t: t + tt,
          x,
          y,
          z: 0,
          pressure: p,
          v: Math.min(v, 4),
          tilt: this.baseTilt,
          azimuth,
        };
        samples.push(s);
        contact.push(s);
        pressureSum += p;
        pressurePeak = Math.max(pressurePeak, p);
        contactCount++;
        prevPos = { x, y };
        prevT = t + tt;
      }
      t += strokeDuration;
      this.pressure.reset();
    }

    // ---- Lift ------------------------------------------------------------
    const liftMs = 14 + this.rng.next() * 26;
    const end = op.waypoints[op.waypoints.length - 1];
    const liftSteps = Math.max(1, Math.round(liftMs / SAMPLE_DT));
    for (let i = 1; i <= liftSteps; i++) {
      const f = i / liftSteps;
      samples.push({
        t: t + liftMs * f,
        x: end.x,
        y: end.y,
        z: f * 3.5,
        pressure: 0,
        v: 0,
        tilt: this.baseTilt,
        azimuth: this.baseAzimuth,
      });
    }
    t += liftMs;

    this.cursor = { ...end };
    return {
      opId: op.id,
      samples,
      contact,
      durationMs: t - t0,
      travelPx: hop,
      drawPx: totalPx,
      meanPressure: contactCount ? pressureSum / contactCount : 0,
      peakPressure: pressurePeak,
    };
  }
}

function angleTowards(base: number, target: number, t: number): number {
  let d = target - base;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return base + d * t;
}

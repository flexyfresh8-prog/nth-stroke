/**
 * The deposition engine: applies stylus contact samples to the graphite map
 * through a physically inspired model (spec §6):
 *
 *  - pressure → tip compression → footprint size
 *  - paper tooth modulates local contact force (hard pencils skip troughs)
 *  - dwell time (∝ 1/speed) drives deposit per unit length (friction)
 *  - Beer–Lambert saturation limits how dark each material can go
 *  - tip load depletes along a stroke and varies between strokes
 *  - tip wear widens the line until a re-sharpen
 *  - charcoal smears existing graphite along the direction of motion
 *  - the blending stump homogenizes and drags graphite forward
 *  - erasers lift light marks completely but leave ghosts in deep blacks
 *
 * Every visible change to the artwork goes through this engine — engine
 * strokes and user strokes alike (spec §1, §7).
 */

import type { Rng } from '../core/rng';
import { TileGrid } from '../core/tiles';
import type { StylusSample } from '../core/types';
import { GraphiteMap } from './graphite';
import { Paper } from './paper';
import type { InstrumentSpec } from './instruments';

export interface TraceResult {
  drawnPx: number;
  deposited: number;
  sharpened: boolean;
}

const V_REF = 0.45; // px/ms reference speed

export class MediaEngine {
  readonly grid: TileGrid;
  private tipLoad = 1;
  private drawnSinceSharpen = 0;
  /** Result of the most recent applyTrace (read by the controller). */
  lastResult: TraceResult = { drawnPx: 0, deposited: 0, sharpened: false };

  constructor(
    readonly paper: Paper,
    readonly map: GraphiteMap,
    private readonly rng: Rng,
    /** Separate stream for user strokes so interjections never perturb the
     *  engine's deterministic RNG sequence (spec §10). */
    private readonly userRng: Rng = rng,
  ) {
    this.grid = new TileGrid(map.width, map.height);
  }

  /** Serializable tip state for checkpoints (spec §11). */
  serialize(): { tipLoad: number; drawnSinceSharpen: number } {
    return { tipLoad: this.tipLoad, drawnSinceSharpen: this.drawnSinceSharpen };
  }

  restoreMedia(state: { tipLoad: number; drawnSinceSharpen: number }) {
    this.tipLoad = state.tipLoad;
    this.drawnSinceSharpen = state.drawnSinceSharpen;
  }

  /** Apply a sequence of contact samples (already ordered, pen-down).
   *  `continuation=true` keeps the tip state when the controller feeds an
   *  in-flight trace chunk by chunk. */
  applyTrace(spec: InstrumentSpec, samples: StylusSample[], opId: number, broad = false, continuation = false, user = false): TraceResult {
    const startPx = continuation ? this.lastResult.drawnPx : 0;
    const result: TraceResult = continuation
      ? { ...this.lastResult }
      : { drawnPx: 0, deposited: 0, sharpened: false };
    this.lastResult = result;
    if (samples.length === 0) return result;
    const rng = user ? this.userRng : this.rng;
    if (!continuation) {
      // Fresh tip position between strokes — slight per-stroke variation.
      this.tipLoad = 0.88 + rng.next() * 0.12;
      if (this.drawnSinceSharpen > spec.sharpenInterval) {
        this.drawnSinceSharpen = 0;
        result.sharpened = true;
      }
    }

    let prev = samples[0];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (i > 0) {
        // Stamp at a fixed spacing along the segment so deposit per unit
        // length is independent of the sample rate.
        const dx = s.x - prev.x;
        const dy = s.y - prev.y;
        const seg = Math.hypot(dx, dy);
        result.drawnPx += seg;
        if (s.z <= 0.35 && s.pressure > 0.012) {
          const r = this.footprintRadius(spec, s, broad);
          const spacing = Math.max(0.4, r * 0.45);
          const steps = Math.max(1, Math.ceil(seg / spacing));
          for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            this.stamp(spec, prev.x + dx * t, prev.y + dy * t, s, Math.atan2(dy, dx), broad, spacing, result, opId);
          }
        } else {
          // Pen lifted mid-trace: contact momentarily lost, tip partially recovers.
          this.tipLoad = Math.min(1, this.tipLoad + 0.05);
        }
        prev = s;
      } else if (s.z <= 0.35 && s.pressure > 0.012) {
        this.stamp(spec, s.x, s.y, s, Math.atan2(0, 1), broad, 0.5, result, opId);
      }
    }
    this.drawnSinceSharpen += result.drawnPx - startPx;
    this.map.edits++;
    return result;
  }

  /** Effective tip radius for one sample (pressure compression + wear + tilt). */
  private footprintRadius(spec: InstrumentSpec, s: StylusSample, broad: boolean): number {
    let r = spec.baseRadius + s.pressure * spec.pressureRadius;
    if (spec.wearRate > 0) {
      r *= 1 + Math.min(0.8, (this.drawnSinceSharpen / spec.sharpenInterval) * spec.wearRate * 4);
    }
    if (broad) {
      // Side of the tip: a wide flat contact.
      r *= 2.1;
    }
    return r;
  }

  private stamp(
    spec: InstrumentSpec,
    x: number,
    y: number,
    s: StylusSample,
    direction: number,
    broad: boolean,
    spacing: number,
    result: TraceResult,
    opId: number,
  ) {
    const r = this.footprintRadius(spec, s, broad);
    // Tilt elongates the contact ellipse along the tilt azimuth.
    const elong = 1 + Math.min(0.9, s.tilt * 0.85);
    const rx = r; // across the stroke
    const ry = r * elong; // along the stroke
    const theta = broad ? direction : s.azimuth;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const edge = broad ? spec.edge * 0.6 : spec.edge;

    const x0 = Math.max(0, Math.floor(x - ry - 1));
    const x1 = Math.min(this.map.width - 1, Math.ceil(x + ry + 1));
    const y0 = Math.max(0, Math.floor(y - ry - 1));
    const y1 = Math.min(this.map.height - 1, Math.ceil(y + ry + 1));
    if (x1 < x0 || y1 < y0) return;

    // Dwell: slower strokes press longer per unit length (friction physics).
    const dwell = Math.min(2.1, Math.pow(V_REF / Math.max(0.08, s.v), 0.65));
    const p = s.pressure;
    const grainAmp = 0.22 + 0.75 * spec.hardness;
    const skipThreshold = spec.hardness * 0.13 * (1 - p);
    const liftBase = spec.class === 'eraser' ? (spec.lift ?? 0.5) * p : 0;
    const blend = spec.class === 'blender' ? (spec.blend ?? 0.5) * p : 0;

    // Blender needs neighbourhood means first.
    let meanIn = 0;
    if (blend > 0) {
      meanIn = this.map.meanDensity(x, y, r);
    }
    const dirBack = { x: x - Math.cos(direction) * r * 0.9, y: y - Math.sin(direction) * r * 0.9 };
    const meanBehind = blend > 0 ? this.map.meanDensity(dirBack.x, dirBack.y, r) : 0;

    let stampDeposit = 0;
    const density = this.map.density;
    const width = this.map.width;

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - x;
        const dy = py + 0.5 - y;
        const ex = dx * cos + dy * sin;
        const ey = -dx * sin + dy * cos;
        const nd = (ex * ex) / (rx * rx) + (ey * ey) / (ry * ry);
        if (nd > 1) continue;
        const falloff = Math.pow(1 - nd, edge);
        const i = py * width + px;

        if (spec.class === 'eraser') {
          const d = density[i];
          if (d <= 0) continue;
          const g = this.paper.height[i];
          const relief = (g - 0.5) * 2;
          // Light marks lift out completely; deep-set graphite leaves a ghost.
          const ease = d / (d + 0.055);
          const lift = Math.min(0.96, liftBase * falloff * ease * (1 + relief * 0.12));
          density[i] = d * (1 - lift);
          continue;
        }

        if (spec.class === 'blender') {
          const d = density[i];
          // Homogenize toward the local mean, drag material from behind,
          // and lose only a trace of graphite into the stump itself.
          const blended = d + (meanIn - d) * blend * falloff;
          const dragged = blended + (meanBehind - blended) * blend * 0.3 * falloff;
          density[i] = Math.max(0, dragged * (1 - 0.0004 * falloff));
          continue;
        }

        // Pencil / charcoal deposition — mass-conserving normalization:
        // a pixel under the footprint centre is covered by ≈ (2·ry)/spacing
        // consecutive stamps, so per-stamp deposit × coverage = line darkness,
        // independent of tip width, stamp spacing and speed. Broad charcoal
        // thus cannot lay down more density per pass than a pencil — it only
        // covers more area, exactly like real tools.
        const g = this.paper.height[i];
        const relief = (g - 0.5) * 2;
        let force = p * (1 + relief * grainAmp * 0.5);
        if (force <= skipThreshold) continue; // tooth trough untouched
        force = Math.min(1.5, force);
        const before = density[i];
        const headroom = Math.max(0, spec.saturation - before) / spec.saturation;
        const coverage = spacing <= 0.55 ? 1 : Math.min(1, spacing / (2 * Math.max(0.6, ry)));
        const deposit =
          spec.darkness *
          Math.pow(force, 1.3) *
          spec.friction *
          dwell *
          this.tipLoad *
          headroom *
          falloff *
          coverage;
        density[i] = before + deposit;
        stampDeposit += deposit;
      }
    }

    // Charcoal / soft graphite drags existing marks along the motion — but
    // only when the pen is actually travelling; a stalled pen smears nothing.
    if (spec.smear > 0.08 && p > 0.15 && s.v > 0.08 && this.rng.chance(0.35)) {
      const fx = x + Math.cos(direction) * r * 0.7;
      const fy = y + Math.sin(direction) * r * 0.7;
      const existing = this.map.meanDensity(fx, fy, r * 0.6);
      if (existing > 0.02) {
        this.smearAt(fx, fy, r * 0.6, Math.min(0.06, existing * spec.smear * 0.08 * p));
      }
    }

    result.deposited += stampDeposit;
    this.tipLoad = Math.max(0.55, this.tipLoad - stampDeposit * 0.004);
    this.grid.markPoint(x, y, r + 1, opId);
  }

  private smearAt(x: number, y: number, radius: number, amount: number) {
    const x0 = Math.max(0, Math.floor(x - radius));
    const x1 = Math.min(this.map.width - 1, Math.ceil(x + radius));
    const y0 = Math.max(0, Math.floor(y - radius));
    const y1 = Math.min(this.map.height - 1, Math.ceil(y + radius));
    const r2 = radius * radius;
    const density = this.map.density;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - x;
        const dy = py + 0.5 - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const falloff = 1 - d2 / r2;
        density[py * this.map.width + px] += amount * falloff;
      }
    }
  }
}

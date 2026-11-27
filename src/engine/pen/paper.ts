// The V4 Virtual Canvas (spec §1). The ONLY object that stores artwork.
// Material lives in two per-pixel channels:
//   • graphite density (Beer–Lambert multiplicative darkening — layered
//     passes accumulate like real graphite), and
//   • ink coverage (alpha-composited, saturating like real ink).
// An eraser physically removes material along its path.
// Everything is a typed array; tiles track dirtiness for incremental
// compositing, so the UI only ever receives the pixels that changed.

import { blotAmount, instruments, stampParams } from './instruments';
import { hash2, valueNoise } from './rng';
import type { InstrumentId, LayerId } from './types';

export const TILE = 64;
export const PAPER: [number, number, number] = [252, 250, 245];
const INK: [number, number, number] = [26, 26, 31];

export interface StrokeRecord {
  instrument: InstrumentId;
  layer: LayerId;
  stage: number;
  importance: number;
  /** Mean deposit alpha (drives SVG opacity). */
  alpha: number;
  /** Decimated samples: [x, y, halfWidth, alpha] × n. */
  pts: Float32Array;
  length: number;
}

export class VirtualCanvas {
  readonly w: number;
  readonly h: number;
  readonly graphite: Float32Array;
  readonly ink: Float32Array;
  readonly cols: number;
  readonly rows: number;
  readonly dirty: Uint8Array;
  readonly nibScale: number;
  readonly seed: number;
  dirtyTiles: number[] = [];
  private blotPending = 0;

  // live stroke accumulation
  private live: number[] | null = null;
  private liveLen = 0;
  private liveAlpha = 0;
  private liveCount = 0;
  registry: StrokeRecord[] = [];
  registryPoints = 0;

  constructor(w: number, h: number, nibScale: number, seed: number) {
    this.w = w;
    this.h = h;
    this.graphite = new Float32Array(w * h);
    this.ink = new Float32Array(w * h);
    this.cols = Math.ceil(w / TILE);
    this.rows = Math.ceil(h / TILE);
    this.dirty = new Uint8Array(this.cols * this.rows);
    this.nibScale = nibScale;
    this.seed = seed >>> 0;
  }

  // --- dirty tile bookkeeping ---------------------------------------------
  private touch(x: number, y: number, r: number) {
    const x0 = Math.max(0, ((x - r) / TILE) | 0),
      y0 = Math.max(0, ((y - r) / TILE) | 0),
      x1 = Math.min(this.cols - 1, ((x + r) / TILE) | 0),
      y1 = Math.min(this.rows - 1, ((y + r) / TILE) | 0);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const ti = ty * this.cols + tx;
        if (!this.dirty[ti]) {
          this.dirty[ti] = 1;
          this.dirtyTiles.push(ti);
        }
      }
  }

  takeDirtyTiles(): number[] {
    const list = this.dirtyTiles;
    this.dirtyTiles = [];
    this.dirty.fill(0);
    return list;
  }

  // --- stroke registry -----------------------------------------------------
  beginStroke(layer: LayerId, stage: number, importance: number): void {
    this.live = [];
    this.liveLayer = layer;
    this.liveStage = stage;
    this.liveImportance = importance;
    this.liveLen = 0;
    this.liveAlpha = 0;
    this.liveCount = 0;
  }
  private liveLayer: LayerId = 'sketch';
  private liveStage = 0;
  private liveImportance = 0;

  private sample(x: number, y: number, r: number, a: number) {
    const l = this.live!;
    // safety cap: pathological strokes must not grow the accumulator forever
    if (l.length < 2_400_000) l.push(x, y, r, a);
    this.liveLen++;
    this.liveAlpha += a;
    this.liveCount++;
  }

  endStroke(instrument: InstrumentId): StrokeRecord | null {
    if (!this.live || this.liveCount === 0) {
      this.live = null;
      return null;
    }
    const raw = this.live;
    this.live = null;
    const meanA = this.liveAlpha / this.liveCount;
    // Decimate: keep endpoints + points that move or change width materially.
    let tol = 0.5;
    let keep: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      keep = [raw[0], raw[1], raw[2], raw[3]];
      let lx = raw[0],
        ly = raw[1],
        lr = raw[2];
      for (let i = 1; i < this.liveCount; i++) {
        const x = raw[4 * i],
          y = raw[4 * i + 1],
          r = raw[4 * i + 2];
        if (Math.hypot(x - lx, y - ly) > tol || Math.abs(r - lr) > 0.09 * (1 + lr)) {
          keep.push(x, y, r, raw[4 * i + 3]);
          lx = x;
          ly = y;
          lr = r;
        }
      }
      const lastI = 4 * (this.liveCount - 1);
      keep.push(raw[lastI], raw[lastI + 1], raw[lastI + 2], raw[lastI + 3]);
      if (keep.length / 4 <= 160) break;
      tol *= 1.7;
    }
    const record: StrokeRecord = {
      instrument,
      layer: this.liveLayer,
      stage: this.liveStage,
      importance: this.liveImportance,
      alpha: meanA,
      pts: new Float32Array(keep),
      length: this.liveLen,
    };
    this.registry.push(record);
    this.registryPoints += keep.length / 4;
    return record;
  }

  // --- deposition ----------------------------------------------------------
  /**
   * Deposit material for one simulation step of pen contact. All inputs are
   * quantised to float32 — the recorder stores float32, so live drawing and
   * event replay traverse bit-identical arithmetic (verified in tests).
   * `blot` injects the touch-down pool of dip/brush pens.
   */
  deposit(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    pressure: number,
    speed: number,
    tilt: number,
    azimuth: number,
    direction: number,
    instrumentId: InstrumentId,
    blot = 0,
  ): void {
    x0 = Math.fround(x0);
    y0 = Math.fround(y0);
    x1 = Math.fround(x1);
    y1 = Math.fround(y1);
    pressure = Math.fround(pressure);
    speed = Math.fround(speed);
    tilt = Math.fround(tilt);
    azimuth = Math.fround(azimuth);
    direction = Math.fround(direction);
    const inst = instruments[instrumentId];
    const dx = x1 - x0,
      dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const dir = dist > 1e-6 ? Math.atan2(dy, dx) : direction;
    // Side-of-tip contact factor.
    let da = azimuth - dir;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const side = Math.abs(Math.cos(da));
    const stamps = Math.max(1, Math.ceil(dist / 0.7));
    if (inst.model === 'eraser') {
      for (let i = 0; i < stamps; i++) {
        const t = (i + 0.5) / stamps;
        this.eraseStamp(x0 + dx * t, y0 + dy * t, pressure, inst);
      }
      if (this.live) this.sample(x1, y1, 0, 0);
      return;
    }
    const params = stampParams(inst, pressure, speed, tilt, side);
    const r = Math.max(0.32, params.r * this.nibScale);
    const grainK = inst.grain;
    const seed = this.seed;
    for (let i = 0; i < stamps; i++) {
      const t = (i + 0.5) / stamps;
      const sx = x0 + dx * t,
        sy = y0 + dy * t;
      let a = params.a;
      if (grainK > 0) {
        // Paper tooth: deterministic value noise, clamped so grain can never
        // fully cancel or double the deposit.
        const n = valueNoise(sx * 0.83, sy * 0.83, seed);
        const g = 1 - grainK * 0.55 + grainK * (0.35 + 1.05 * n);
        a *= Math.max(0.3, Math.min(1.7, g));
      }
      if (i === 0 && blot > 0) a += blotAmount(inst, pressure) * blot;
      this.stamp(sx, sy, r, a, params.sigma, inst.model);
      if (this.live) this.sample(sx, sy, r, Math.min(1, a));
    }
    if (this.live && stamps > 1) this.sample(x1, y1, r, Math.min(1, params.a));
    // A touch-down blot also marks slightly ahead of the nib.
    if (blot > 0 && dist < 0.2) this.stamp(x1, y1, r * 1.15, blotAmount(inst, pressure) * 0.8, params.sigma, inst.model);
  }

  private stamp(cx: number, cy: number, r: number, a: number, sigmaK: number, model: 'graphite' | 'ink'): void {
    if (a <= 0) return;
    const w = this.w,
      h = this.h;
    if (cx < -r - 1 || cy < -r - 1 || cx > w + r + 1 || cy > h + r + 1) return;
    this.touch(cx, cy, r + 1);
    const sigma = Math.max(0.55, r * (0.55 + 0.75 * sigmaK));
    const cut = 2.3 * sigma;
    const x0 = Math.max(0, Math.floor(cx - cut)),
      x1 = Math.min(w - 1, Math.ceil(cx + cut)),
      y0 = Math.max(0, Math.floor(cy - cut)),
      y1 = Math.min(h - 1, Math.ceil(cy + cut));
    const inv2s2 = 1 / (2 * sigma * sigma);
    if (model === 'ink') {
      for (let y = y0; y <= y1; y++) {
        const row = y * w;
        for (let x = x0; x <= x1; x++) {
          const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
          if (d2 > cut * cut) continue;
          const k = Math.exp(-d2 * inv2s2) * a;
          if (k <= 1e-4) continue;
          const i = row + x;
          this.ink[i] = 1 - (1 - this.ink[i]) * (1 - Math.min(0.96, k));
        }
      }
    } else {
      for (let y = y0; y <= y1; y++) {
        const row = y * w;
        for (let x = x0; x <= x1; x++) {
          const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
          if (d2 > cut * cut) continue;
          const k = Math.exp(-d2 * inv2s2) * a;
          if (k <= 1e-4) continue;
          this.graphite[row + x] += k;
        }
      }
    }
  }

  private eraseStamp(cx: number, cy: number, pressure: number, inst: (typeof instruments)['eraser']): void {
    const r = Math.max(1, (inst.nib * (inst.wMin + (inst.wMax - inst.wMin) * Math.pow(pressure, inst.gammaW)) * this.nibScale) / 2);
    this.touch(cx, cy, r + 1);
    const w = this.w,
      h = this.h;
    const x0 = Math.max(0, Math.floor(cx - r)),
      x1 = Math.min(w - 1, Math.ceil(cx + r)),
      y0 = Math.max(0, Math.floor(cy - r)),
      y1 = Math.min(h - 1, Math.ceil(cy + r));
    const effG = Math.exp(-inst.eraseGraphite * pressure * 0.85);
    const effI = Math.exp(-inst.eraseInk * pressure * 0.85);
    const inv2s2 = 1 / (2 * r * r * 0.6);
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > r * r * 1.3) continue;
        const k = Math.exp(-d2 * inv2s2);
        const i = row + x;
        const g = Math.pow(effG, k);
        this.graphite[i] *= g;
        this.ink[i] *= Math.pow(effI, k);
        if (this.graphite[i] < 1e-4) this.graphite[i] = 0;
        if (this.ink[i] < 1e-4) this.ink[i] = 0;
      }
    }
  }

  // --- compositing ---------------------------------------------------------
  /** Luminance 0..255 of the composited pixel (feedback + previews). */
  tone(x: number, y: number): number {
    const xi = Math.max(0, Math.min(this.w - 1, x | 0)),
      yi = Math.max(0, Math.min(this.h - 1, y | 0));
    const i = yi * this.w + xi;
    const d = this.graphite[i],
      c = this.ink[i];
    const r = this.chan(0, d) * (1 - c) + INK[0] * c,
      g = this.chan(1, d) * (1 - c) + INK[1] * c,
      b = this.chan(2, d) * (1 - c) + INK[2] * c;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  private chan(cIdx: 0 | 1 | 2, d: number): number {
    return PAPER[cIdx] * Math.exp(-d * [0.95, 0.97, 1.05][cIdx]);
  }

  /** Composite one tile into RGBA (alpha 255 unless transparent). */
  compositeTile(ti: number, out: Uint8ClampedArray, transparent = false): void {
    const tx = (ti % this.cols) * TILE,
      ty = ((ti / this.cols) | 0) * TILE;
    const x0 = Math.max(0, tx),
      y0 = Math.max(0, ty),
      x1 = Math.min(this.w, tx + TILE),
      y1 = Math.min(this.h, ty + TILE);
    const tw = TILE,
      gw = this.w;
    for (let y = y0; y < y1; y++) {
      let o = ((y - ty) * tw + (x0 - tx)) * 4;
      let gi = y * gw + x0;
      for (let x = x0; x < x1; x++, gi++, o += 4) {
        const d = this.graphite[gi],
          c = this.ink[gi];
        const rC = this.chan(0, d),
          gC = this.chan(1, d),
          bC = this.chan(2, d);
        const r = rC * (1 - c) + INK[0] * c,
          g = gC * (1 - c) + INK[1] * c,
          b = bC * (1 - c) + INK[2] * c;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = transparent ? 255 * Math.min(1, c + (d > 0.06 ? 1 - Math.exp(-d) : 0)) : 255;
      }
    }
    // fill untouched margins with paper
    for (let y = ty; y < ty + TILE; y++) {
      if (y >= y1 || y < y0) {
        const o = ((y - ty) * tw) * 4;
        for (let k = 0; k < tw * 4; k += 4) {
          out[o + k] = PAPER[0];
          out[o + k + 1] = PAPER[1];
          out[o + k + 2] = PAPER[2];
          out[o + k + 3] = transparent ? 0 : 255;
        }
      } else {
        for (let x = tx; x < x0; x++) {
          const o = ((y - ty) * tw + (x - tx)) * 4;
          out[o] = PAPER[0];
          out[o + 1] = PAPER[1];
          out[o + 2] = PAPER[2];
          out[o + 3] = transparent ? 0 : 255;
        }
        for (let x = x1; x < tx + TILE; x++) {
          const o = ((y - ty) * tw + (x - tx)) * 4;
          out[o] = PAPER[0];
          out[o + 1] = PAPER[1];
          out[o + 2] = PAPER[2];
          out[o + 3] = transparent ? 0 : 255;
        }
      }
    }
  }

  /** Full-canvas RGBA composite (exports / full refresh). */
  compositeAll(transparent = false): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    for (let i = 0, o = 0; i < this.w * this.h; i++, o += 4) {
      const d = this.graphite[i],
        c = this.ink[i];
      const r = this.chan(0, d) * (1 - c) + INK[0] * c,
        g = this.chan(1, d) * (1 - c) + INK[1] * c,
        b = this.chan(2, d) * (1 - c) + INK[2] * c;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = transparent ? 255 * Math.min(1, c + (d > 0.06 ? 1 - Math.exp(-d) : 0)) : 255;
    }
    return out;
  }

  /** Mean absolute tone error over a bbox against a reference plane. */
  regionTone(x0: number, y0: number, x1: number, y1: number, ref: { gray: Uint8Array; w: number; h: number }): { err: number; missing: number; excess: number } {
    const kx = ref.w / this.w,
      ky = ref.h / this.h;
    let sum = 0,
      n = 0,
      missing = 0,
      excess = 0;
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 48));
    for (let y = y0; y < y1; y += step)
      for (let x = x0; x < x1; x += step) {
        if (x >= this.w || y >= this.h) continue;
        const drawn = this.tone(x, y);
        const r = ref.gray[Math.min(ref.h - 1, (y * ky) | 0) * ref.w + Math.min(ref.w - 1, (x * kx) | 0)];
        const d = drawn - r;
        sum += Math.abs(d);
        if (d > 16) missing++;
        else if (d < -16) excess++;
        n++;
      }
    return n ? { err: sum / n, missing: missing / n, excess: excess / n } : { err: 0, missing: 0, excess: 0 };
  }
}

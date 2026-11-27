// The V4 Visual Feedback System (spec §10). Continuously compares the
// emerging drawing against the reference:
//   • per-cell luminance error (missing / excess separation),
//   • global SSIM, MAE and edge precision/recall (via the shared V1
//     multiscale metric, exercised on a 160 px evaluation plane),
//   • edge-density comparison per cell for "undrawn contour" detection.
// Results drive the brain: stage transitions, corrections, revisits and
// mid-stroke interrupts all consume these numbers.

import { measure } from '../adaptive/metrics';
import { reduce, type Plane } from '../structural/source';
import type { VirtualCanvas } from './paper';
import type { Box, Quality } from './types';

export interface CellStat {
  err: number;
  missing: number;
  excess: number;
  edgeRef: number;
  edgeDrawn: number;
}

export interface Problem {
  box: Box; // work coords
  err: number;
  kind: 'missing' | 'excess' | 'edge';
  attention: number;
}

const EVAL = 160;

export class Feedback {
  readonly plane: Plane;
  readonly G: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly stats: CellStat[];
  private ref128: Float32Array;
  private refW: number;
  private refH: number;
  last: Quality | null = null;

  constructor(plane: Plane, workW: number, workH: number) {
    this.plane = plane;
    this.G = 26;
    this.cellW = workW / this.G;
    this.cellH = workH / this.G;
    this.stats = Array.from({ length: this.G * this.G }, () => ({ err: 0, missing: 0, excess: 0, edgeRef: 0, edgeDrawn: 0 }));
    // evaluation plane for the shared metric
    const p = reduce(plane, EVAL);
    this.refW = p.w;
    this.refH = p.h;
    this.ref128 = new Float32Array(p.gray.length);
    for (let i = 0; i < p.gray.length; i++) this.ref128[i] = p.gray[i] / 255;
    // reference edge density per cell
    for (let gy = 0; gy < this.G; gy++)
      for (let gx = 0; gx < this.G; gx++) {
        const x0 = Math.floor((gx * plane.w) / this.G),
          y0 = Math.floor((gy * plane.h) / this.G),
          x1 = Math.floor(((gx + 1) * plane.w) / this.G),
          y1 = Math.floor(((gy + 1) * plane.h) / this.G);
        let sum = 0,
          n = 0;
        for (let y = Math.max(1, y0); y < Math.min(plane.h - 1, y1); y++)
          for (let x = Math.max(1, x0); x < Math.min(plane.w - 1, x1); x++) {
            const i = y * plane.w + x;
            sum += Math.abs(plane.gray[i + 1] - plane.gray[i - 1]) + Math.abs(plane.gray[i + plane.w] - plane.gray[i - plane.w]);
            n++;
          }
        this.stats[gy * this.G + gx].edgeRef = n ? sum / n / 42 : 0;
      }
  }

  /** Recompute cells intersecting a work-space box (cheap; per stroke). */
  updateBox(paper: VirtualCanvas, box: Box): void {
    const gx0 = Math.max(0, Math.floor(box[0] / this.cellW)),
      gx1 = Math.min(this.G - 1, Math.floor(box[2] / this.cellW)),
      gy0 = Math.max(0, Math.floor(box[1] / this.cellH)),
      gy1 = Math.min(this.G - 1, Math.floor(box[3] / this.cellH));
    for (let gy = gy0; gy <= gy1; gy++) this.cell(paper, gx0, gx1, gy);
  }

  private cell(paper: VirtualCanvas, gx0: number, gx1: number, gy: number) {
    const kx = this.plane.w / paper.w,
      ky = this.plane.h / paper.h;
    for (let gx = gx0; gx <= gx1; gx++) {
      const s = this.stats[gy * this.G + gx];
      let err = 0,
        missing = 0,
        excess = 0,
        edge = 0,
        n = 0;
      const S = 3; // 3×3 samples per cell
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const wx = (gx + (i + 0.5) / S) * this.cellW,
            wy = (gy + (j + 0.5) / S) * this.cellH;
          if (wx >= paper.w || wy >= paper.h) continue;
          const drawn = paper.tone(wx, wy);
          const rx = Math.min(this.plane.w - 1, (wx * kx) | 0),
            ry = Math.min(this.plane.h - 1, (wy * ky) | 0);
          const ref = this.plane.gray[ry * this.plane.w + rx];
          const d = drawn - ref;
          err += Math.abs(d);
          // Deadbands sized for textured media: hatched graphite naturally
          // sits a few levels either side of the reference. "Missing" only
          // counts where the reference is meaningfully dark — graphite cannot
          // make paper lighter than the sheet it already is.
          if (d > 22 && ref < 226) missing++;
          else if (d < -22) excess++;
          edge += Math.abs(paper.tone(wx + 1, wy) - paper.tone(wx - 1, wy)) + Math.abs(paper.tone(wx, wy + 1) - paper.tone(wx, wy - 1));
          n++;
        }
      if (n) {
        s.err = err / n;
        s.missing = missing / n;
        s.excess = excess / n;
        s.edgeDrawn = edge / n / 42;
      }
    }
  }

  /** Full quality pass — SSIM / MAE / edges (call at stroke cadence). */
  full(paper: VirtualCanvas): Quality {
    const a = new Float32Array(this.refW * this.refH);
    const kx = paper.w / this.refW,
      ky = paper.h / this.refH;
    for (let y = 0; y < this.refH; y++)
      for (let x = 0; x < this.refW; x++) a[y * this.refW + x] = paper.tone(Math.min(paper.w - 1, x * kx), Math.min(paper.h - 1, y * ky)) / 255;
    const m = measure(a, this.ref128, this.refW, this.refH);
    let missing = 0,
      excess = 0,
      n = 0;
    for (const s of this.stats) {
      missing += s.missing;
      excess += s.excess;
      n++;
    }
    this.last = {
      ssim: m.ssim,
      mae: m.mae,
      edge: (m.precision + m.recall) / 2,
      missing: missing / n,
      excess: excess / n,
    };
    return this.last;
  }

  /** Refresh every cell (stage boundaries and correction planning). */
  refreshAll(paper: VirtualCanvas): void {
    for (let gy = 0; gy < this.G; gy++) this.cell(paper, 0, this.G - 1, gy);
  }

  /** Ranked problems: hot cells merged into rectangles, worst first. */
  problems(attentionAt: (x: number, y: number) => number, topN = 10): Problem[] {
    const hot: { gx: number; gy: number; score: number; kind: Problem['kind'] }[] = [];
    for (let gy = 0; gy < this.G; gy++)
      for (let gx = 0; gx < this.G; gx++) {
        const s = this.stats[gy * this.G + gx];
        const wx = (gx + 0.5) * this.cellW,
          wy = (gy + 0.5) * this.cellH;
        const att = 0.35 + attentionAt(wx, wy);
        const edgeDeficit = Math.max(0, s.edgeRef - s.edgeDrawn) * 1.5;
        const score = Math.max(s.err / 26 + edgeDeficit, s.missing * 1.5, s.excess * 2.2) * att;
        const kind: Problem['kind'] = s.excess > s.missing * 1.4 && s.excess > 0.06 ? 'excess' : edgeDeficit > s.err / 26 ? 'edge' : 'missing';
        if (score > 0.3) hot.push({ gx, gy, score, kind });
      }
    hot.sort((a, b) => b.score - a.score);
    const problems: Problem[] = [];
    const taken = new Uint8Array(this.G * this.G);
    for (const h of hot) {
      if (problems.length >= topN) break;
      if (taken[h.gy * this.G + h.gx]) continue;
      // grow a rectangle of same-kind hot neighbours; only the RING around
      // the current rectangle is scanned, so growth strictly monotonous
      let x0 = h.gx,
        x1 = h.gx,
        y0 = h.gy,
        y1 = h.gy,
        grown = true;
      while (grown) {
        grown = false;
        for (let gy = y0 - 1; gy <= y1 + 1; gy++)
          for (let gx = x0 - 1; gx <= x1 + 1; gx++) {
            const onRing = gy === y0 - 1 || gy === y1 + 1 || gx === x0 - 1 || gx === x1 + 1;
            if (!onRing || gx < 0 || gy < 0 || gx >= this.G || gy >= this.G) continue;
            const i = gy * this.G + gx;
            if (taken[i]) continue;
            const s = this.stats[i];
            const same = h.kind === 'excess' ? s.excess > 0.07 : h.kind === 'edge' ? s.edgeRef - s.edgeDrawn > 0.12 : s.missing > 0.11;
            if (same) {
              x0 = Math.min(x0, gx);
              x1 = Math.max(x1, gx);
              y0 = Math.min(y0, gy);
              y1 = Math.max(y1, gy);
              grown = true;
            }
          }
      }
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) taken[gy * this.G + gx] = 1;
      const box: Box = [x0 * this.cellW, y0 * this.cellH, (x1 + 1) * this.cellW, (y1 + 1) * this.cellH];
      problems.push({
        box,
        err: h.score,
        kind: h.kind,
        attention: attentionAt((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
      });
    }
    return problems;
  }

  /** Mean cell error inside a box — per-stroke closed-loop acceptance.
   * `signed` is mean(drawn − reference): negative = too dark. */
  boxError(paper: VirtualCanvas, box: Box): { err: number; missing: number; excess: number; signed: number } {
    this.updateBox(paper, box);
    const gx0 = Math.max(0, Math.floor(box[0] / this.cellW)),
      gx1 = Math.min(this.G - 1, Math.floor(box[2] / this.cellW)),
      gy0 = Math.max(0, Math.floor(box[1] / this.cellH)),
      gy1 = Math.min(this.G - 1, Math.floor(box[3] / this.cellH));
    let err = 0,
      missing = 0,
      excess = 0,
      signed = 0,
      n = 0;
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const s = this.stats[gy * this.G + gx];
        err += s.err;
        missing += s.missing;
        excess += s.excess;
        signed += s.missing - s.excess;
        n++;
      }
    return n
      ? { err: err / n, missing: missing / n, excess: excess / n, signed: (signed / n) * 255 }
      : { err: 0, missing: 0, excess: 0, signed: 0 };
  }
}

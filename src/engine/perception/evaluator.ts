/**
 * Multiscale evaluator (spec §9). Compares the current canvas against the
 * reference at several scales, producing live metrics (SSIM, tone error,
 * edge alignment, contrast, structure) and a ranked problem list that
 * drives the planner's next decision. Coarse levels judge big structure;
 * fine levels judge detail — the engine progresses from large structures
 * to increasingly fine ones.
 */

import { densityForTone, type SceneGraph } from '../analysis/scene';
import type { GraphiteMap } from '../media/graphite';
import type { LiveMetrics, Vec2 } from '../core/types';
import { clamp } from '../core/math';

export interface Problem {
  /** Centre in canvas pixels. */
  x: number;
  y: number;
  /** Radius of influence in canvas pixels. */
  radius: number;
  /** Mean signed tone error: + = too light (needs graphite), − = too dark. */
  signedError: number;
  /** Importance 0..1 (saliency × severity). */
  priority: number;
  /** Analysis-res cell grid origin for debugging. */
  cell: { cx: number; cy: number };
}

export interface Evaluation {
  metrics: LiveMetrics;
  problems: Problem[];
  /** Tone error map at analysis resolution (signed, canvas − reference). */
  errorMap: Float32Array;
  /** Cells where the canvas has an edge much harder than the reference —
   *  candidates for blending-stump softening (spec §8). Canvas px. */
  harshCells: Array<{ x: number; y: number }>;
  /** Strong reference edges not yet covered by any drawn stroke (canvas px). */
  uncoveredEdges: Array<{ x: number; y: number; strength: number }>;
}

function downsample2(src: Float32Array, w: number, h: number): { data: Float32Array; w: number; h: number } {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2);
      const y0 = Math.min(h - 1, y * 2);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      out[y * nw + x] = (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]) * 0.25;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Single-scale SSIM (8×8 windows) between two tone maps. */
export function ssim(a: Float32Array, b: Float32Array, w: number, h: number): number {
  const C1 = 0.0009;
  const C2 = 0.0009;
  let sum = 0;
  let count = 0;
  const win = 8;
  for (let y = 0; y + win <= h; y += win) {
    for (let x = 0; x + win <= w; x += win) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          ma += a[(y + j) * w + x + i];
          mb += b[(y + j) * w + x + i];
        }
      }
      const n = win * win;
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const da = a[(y + j) * w + x + i] - ma;
          const db = b[(y + j) * w + x + i] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= n;
      vb /= n;
      cov /= n;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? sum / count : 1;
}

/** Two-pass chamfer distance transform of a binary field (in px). */
export function chamfer(field: Float32Array, w: number, h: number, threshold = 0.5): Float32Array {
  const dist = new Float32Array(w * h).fill(1e9);
  for (let i = 0; i < field.length; i++) if (field[i] >= threshold) dist[i] = 0;
  const D1 = 1;
  const D2 = 1.4142;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + D1);
      if (y > 0) d = Math.min(d, dist[i - w] + D1);
      if (x > 0 && y > 0) d = Math.min(d, dist[i - w - 1] + D2);
      if (x < w - 1 && y > 0) d = Math.min(d, dist[i - w + 1] + D2);
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + D1);
      if (y < h - 1) d = Math.min(d, dist[i + w] + D1);
      if (x < w - 1 && y < h - 1) d = Math.min(d, dist[i + w + 1] + D2);
      if (x > 0 && y < h - 1) d = Math.min(d, dist[i + w - 1] + D2);
      dist[i] = d;
    }
  }
  return dist;
}

/** Simple Sobel magnitude on a tone map, 0..1. */
function sobel(tone: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        tone[i - w + 1] + 2 * tone[i + 1] + tone[i + w + 1] -
        tone[i - w - 1] - 2 * tone[i - 1] - tone[i + w - 1];
      const gy =
        tone[i + w - 1] + 2 * tone[i + w] + tone[i + w + 1] -
        tone[i - w - 1] - 2 * tone[i - w] - tone[i - w + 1];
      out[i] = Math.min(1, Math.hypot(gx, gy) * 2.2);
    }
  }
  return out;
}

export class Evaluator {
  private cache: Evaluation | null = null;

  /** Full evaluation. `map` is the live canvas state. */
  evaluate(scene: SceneGraph, map: GraphiteMap, albedo: Float32Array): Evaluation {
    const w = scene.width;
    const h = scene.height;
    const canvasTone = map.tonePyramidLevel(albedo, w, h);
    const refTone = scene.fields.lum;

    // --- Tone error map (signed) -------------------------------------------
    const errorMap = new Float32Array(w * h);
    let absSum = 0;
    for (let i = 0; i < errorMap.length; i++) {
      errorMap[i] = canvasTone[i] - refTone[i];
      absSum += Math.abs(errorMap[i]);
    }
    const toneError = absSum / errorMap.length;

    // --- SSIM (multiscale mean of 3 levels) ---------------------------------
    const l1 = { data: canvasTone, w, h };
    const r1 = { data: refTone, w, h };
    const l2 = downsample2(l1.data, l1.w, l1.h);
    const r2 = downsample2(r1.data, r1.w, r1.h);
    const l3 = downsample2(l2.data, l2.w, l2.h);
    const r3 = downsample2(r2.data, r2.w, r2.h);
    const ssimValue = (ssim(l1.data, r1.data, l1.w, l1.h) + ssim(l2.data, r2.data, l2.w, l2.h) + ssim(l3.data, r3.data, l3.w, l3.h)) / 3;

    // --- Edge alignment: reference edges vs drawn edges ----------------------
    const canvasEdges = sobel(canvasTone, w, h);
    const refEdges = scene.fields.edges;
    const refStrong = new Float32Array(w * h);
    let refCount = 0;
    for (let i = 0; i < refEdges.length; i++) {
      refStrong[i] = refEdges[i] >= 0.5 ? 1 : 0;
      refCount += refStrong[i];
    }
    const canvasStrong = new Float32Array(w * h);
    for (let i = 0; i < canvasEdges.length; i++) canvasStrong[i] = canvasEdges[i] >= 0.28 ? 1 : 0;
    const dtCanvas = chamfer(canvasStrong, w, h);
    let nearSum = 0;
    let distSum = 0;
    for (let i = 0; i < dtCanvas.length; i++) {
      if (refStrong[i] > 0) {
        const d = Math.min(dtCanvas[i], 12);
        distSum += d;
        if (d <= 2.5) nearSum++;
      }
    }
    const edgeAlignment = refCount > 0 ? nearSum / refCount : 1;

    // --- Contrast error (local std difference, coarse) ------------------------
    let contrastSum = 0;
    const cell = 12;
    let cells = 0;
    for (let y = 0; y + cell <= h; y += cell) {
      for (let x = 0; x + cell <= w; x += cell) {
        let mc = 0;
        let mr = 0;
        for (let j = 0; j < cell; j++) {
          for (let i = 0; i < cell; i++) {
            mc += canvasTone[(y + j) * w + x + i];
            mr += refTone[(y + j) * w + x + i];
          }
        }
        const n = cell * cell;
        mc /= n;
        mr /= n;
        let vc = 0;
        let vr = 0;
        for (let j = 0; j < cell; j++) {
          for (let i = 0; i < cell; i++) {
            vc += (canvasTone[(y + j) * w + x + i] - mc) ** 2;
            vr += (refTone[(y + j) * w + x + i] - mr) ** 2;
          }
        }
        contrastSum += Math.abs(Math.sqrt(vc / n) - Math.sqrt(vr / n));
        cells++;
      }
    }
    const contrastError = cells ? Math.min(1, (contrastSum / cells) * 3.2) : 0;

    // --- Structure error: region tone ordering + face feature presence -------
    let structureError = 0;
    let checks = 0;
    const regionIds = scene.subjects.length ? scene.subjects.slice(0, 6) : scene.regions.slice(0, 6).map((r) => r.id);
    const drawnTones: Array<{ ref: number; drawn: number }> = [];
    for (const id of regionIds) {
      const region = scene.regions.find((r) => r.id === id);
      if (!region) continue;
      const cx = Math.round((region.bbox.x + region.bbox.w / 2) * scene.scale);
      const cy = Math.round((region.bbox.y + region.bbox.h / 2) * scene.scale);
      const r = Math.max(4, (region.bbox.w / 2) * scene.scale);
      const drawn = map.meanDensity(cx, cy, r);
      const target = densityForTone(region.meanTone);
      drawnTones.push({ ref: region.meanTone, drawn });
      structureError += Math.abs(drawn - target) / Math.max(0.4, target + drawn);
      checks++;
    }
    if (scene.face) {
      // Features must carry marks: eyes, nostrils, mouth corners.
      const scale = scene.scale;
      const lm = scene.face.observation.landmarks;
      const featureIdx = [33, 263, 1, 61, 291, 168];
      for (const idx of featureIdx) {
        const p = lm[idx];
        if (!p) continue;
        const cx = p.x * scene.canvasWidth;
        const cy = p.y * scene.canvasHeight;
        const ink = map.meanDensity(cx, cy, 5 * scale);
        if (ink < 0.04) {
          structureError += 0.22;
        }
        checks++;
      }
    }
    const structure = checks ? clamp(structureError / checks, 0, 1) : 0;

    // --- Harsh edges and uncovered reference edges ----------------------------
    const harshCells: Array<{ x: number; y: number }> = [];
    const uncoveredEdges: Array<{ x: number; y: number; strength: number }> = [];
    for (let y = 2; y < h - 2; y += 4) {
      for (let x = 2; x < w - 2; x += 4) {
        const i = y * w + x;
        if (canvasEdges[i] > 0.55 && refEdges[i] < 0.16) {
          harshCells.push({ x: x * scene.scale, y: y * scene.scale });
        }
        if (refStrong[i] > 0 && dtCanvas[i] > 4 && scene.fields.saliency[i] > 0.35) {
          uncoveredEdges.push({ x: x * scene.scale, y: y * scene.scale, strength: refEdges[i] });
        }
      }
    }

    // --- Problems: cluster signed error over a coarse grid ---------------------
    const problems = this.detectProblems(scene, errorMap, canvasTone, refTone);

    const metrics: LiveMetrics = {
      ssim: clamp(ssimValue, 0, 1),
      toneError,
      edgeAlignment,
      contrastError,
      structureError: structure,
    };
    this.cache = { metrics, problems, errorMap, harshCells, uncoveredEdges };
    return this.cache;
  }

  private detectProblems(scene: SceneGraph, errorMap: Float32Array, canvasTone: Float32Array, refTone: Float32Array): Problem[] {
    const w = scene.width;
    const h = scene.height;
    const cell = 14;
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    const cellErr = new Float32Array(cols * rows);
    const cellAbs = new Float32Array(cols * rows);
    const cellSal = new Float32Array(cols * rows);
    const { saliency } = scene.fields;
    for (let y = 0; y < h; y++) {
      const cy = Math.min(rows - 1, (y / cell) | 0);
      for (let x = 0; x < w; x++) {
        const cx = Math.min(cols - 1, (x / cell) | 0);
        const i = y * w + x;
        const ci = cy * cols + cx;
        cellErr[ci] += errorMap[i];
        cellAbs[ci] += Math.abs(errorMap[i]);
        cellSal[ci] += saliency[i];
      }
    }
    const perCell = cell * cell;
    const problems: Problem[] = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const ci = cy * cols + cx;
        const mean = cellErr[ci] / perCell;
        const meanAbs = cellAbs[ci] / perCell;
        const sal = cellSal[ci] / perCell;
        // Severity is the ABSOLUTE mismatch (a half-dark/half-light cell is
        // still wrong); the sign tells the planner which way to correct.
        const severity = meanAbs;
        if (severity < 0.09) continue;
        const priority = clamp(severity * 2.4 * (0.35 + sal), 0, 1) * Math.sign(mean || 1);
        problems.push({
          x: (cx + 0.5) * cell * scene.scale,
          y: (cy + 0.5) * cell * scene.scale,
          radius: cell * 0.75 * scene.scale,
          signedError: mean,
          priority: Math.abs(priority),
          cell: { cx, cy },
        });
      }
    }
    // Merge nearby same-sign problems to avoid tiny fragmented fixes.
    const merged: Problem[] = [];
    problems.sort((a, b) => b.priority - a.priority);
    for (const p of problems) {
      const near = merged.find(
        (m) =>
          Math.sign(m.signedError) === Math.sign(p.signedError) &&
          Math.hypot(m.x - p.x, m.y - p.y) < (m.radius + p.radius) * 1.35,
      );
      if (near) {
        const wa = near.priority;
        const wb = p.priority;
        near.x = (near.x * wa + p.x * wb) / (wa + wb);
        near.y = (near.y * wa + p.y * wb) / (wa + wb);
        near.signedError = (near.signedError * wa + p.signedError * wb) / (wa + wb);
        near.radius = Math.max(near.radius, Math.hypot(near.x - p.x, near.y - p.y) + p.radius);
        near.priority = Math.min(1, near.priority + p.priority * 0.4);
      } else {
        merged.push({ ...p });
      }
    }
    return merged.slice(0, 24);
  }

  lastEvaluation(): Evaluation | null {
    return this.cache;
  }
}

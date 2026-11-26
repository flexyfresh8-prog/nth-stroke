/**
 * Region segmentation (spec §3): a lightweight SLIC-style superpixel pass in
 * (luminance, x, y) space followed by merging, then a foreground/background
 * split using saliency, edge density and border contact. Produces the
 * region list of the SceneGraph — "what the image contains", not just pixels.
 */

import type { ClassicalFields } from './classical';
import { clamp } from '../core/math';

export interface SceneRegion {
  id: number;
  bbox: { x: number; y: number; w: number; h: number };
  area: number;
  meanTone: number;
  toneRange: number;
  saliency: number;
  edgeDensity: number;
  coherence: number;
  /** Mean form-following direction (vector-summed, radians). */
  orientation: number;
  background: boolean;
  /** Downsampled membership mask (cols × rows, 1 = member). */
  mask: { cols: number; rows: number; cells: Uint8Array };
}

interface Superpixel {
  cx: number;
  cy: number;
  tone: number;
  pixels: number[];
}

export function segmentRegions(fields: ClassicalFields, targetCount = 64): { regions: SceneRegion[]; labels: Int32Array } {
  const { width, height, lum, saliency, edges, coherence, orientation, texture } = fields;
  const n = width * height;
  const count = Math.max(12, Math.min(targetCount, Math.floor(n / 90)));
  const step = Math.sqrt(n / count);

  // --- Init superpixel seeds on a jittered grid ---------------------------
  const sps: Superpixel[] = [];
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      sps.push({ cx: x, cy: y, tone: lum[Math.min(n - 1, (y | 0) * width + (x | 0))], pixels: [] });
    }
  }
  const labels = new Int32Array(n).fill(-1);
  const spatial = step * 1.8;
  const iterations = 5;
  for (let it = 0; it < iterations; it++) {
    for (const sp of sps) sp.pixels.length = 0;
    labels.fill(-1);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let best = -1;
        let bestD = Infinity;
        for (let s = 0; s < sps.length; s++) {
          const sp = sps[s];
          const dx = x - sp.cx;
          const dy = y - sp.cy;
          if (Math.abs(dx) > spatial || Math.abs(dy) > spatial) continue;
          const d = (lum[i] - sp.tone) * (lum[i] - sp.tone) * 90 + (dx * dx + dy * dy) / (spatial * spatial);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        if (best >= 0) {
          labels[i] = best;
          sps[best].pixels.push(i);
        }
      }
    }
    for (const sp of sps) {
      if (!sp.pixels.length) continue;
      let sx = 0;
      let sy = 0;
      let st = 0;
      for (const i of sp.pixels) {
        sx += i % width;
        sy += (i / width) | 0;
        st += lum[i];
      }
      sp.cx = sx / sp.pixels.length;
      sp.cy = sy / sp.pixels.length;
      sp.tone = st / sp.pixels.length;
    }
  }

  // --- Merge tiny fragments into their strongest neighbour -----------------
  const areaThreshold = (n / count) * 0.22;
  for (let s = 0; s < sps.length; s++) {
    if (sps[s].pixels.length >= areaThreshold || labels[sps[s].pixels[0] ?? 0] !== s) continue;
    // Find the neighbouring superpixel with the most shared border.
    const votes = new Map<number, number>();
    for (const i of sps[s].pixels) {
      const x = i % width;
      const y = (i / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const l = labels[yy * width + xx];
        if (l >= 0 && l !== s) votes.set(l, (votes.get(l) ?? 0) + 1);
      }
    }
    let bestTarget = -1;
    let bestVotes = 0;
    for (const [l, v] of votes) if (v > bestVotes) {
      bestVotes = v;
      bestTarget = l;
    }
    if (bestTarget >= 0) {
      for (const i of sps[s].pixels) labels[i] = bestTarget;
      sps[bestTarget].pixels.push(...sps[s].pixels);
      sps[s].pixels = [];
    }
  }

  // --- Build scene regions --------------------------------------------------
  const regions: SceneRegion[] = [];
  const maskCols = 48;
  const maskRows = Math.max(1, Math.round((maskCols * height) / width));
  const usedIds = new Set<number>();
  for (let s = 0; s < sps.length; s++) {
    const sp = sps[s];
    if (sp.pixels.length < 4) continue;
    if (usedIds.has(s)) continue;
    // Union all pixels currently labelled s (includes merged fragments).
    const pixels: number[] = [];
    for (let i = 0; i < n; i++) if (labels[i] === s) pixels.push(i);
    if (pixels.length < 4) continue;
    usedIds.add(s);

    let minX = width, maxX = 0, minY = height, maxY = 0;
    let toneSum = 0, toneMin = 1, toneMax = 0, salSum = 0, edgeSum = 0, cohSum = 0;
    let ox = 0, oy = 0;
    let borderTouch = 0;
    const cells = new Uint8Array(maskCols * maskRows);
    for (const i of pixels) {
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      toneSum += lum[i];
      if (lum[i] < toneMin) toneMin = lum[i];
      if (lum[i] > toneMax) toneMax = lum[i];
      salSum += saliency[i];
      edgeSum += edges[i] > 0.5 ? 1 : 0;
      cohSum += coherence[i];
      ox += Math.cos(orientation[i]);
      oy += Math.sin(orientation[i]);
      cells[Math.min(maskRows - 1, ((y / height) * maskRows) | 0) * maskCols + Math.min(maskCols - 1, ((x / width) * maskCols) | 0)] = 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) borderTouch++;
    }
    const area = pixels.length;
    const meanTone = toneSum / area;
    const saliencyMean = salSum / area;
    const edgeDensity = edgeSum / area;
    const borderRatio = borderTouch / Math.max(1, Math.min(maxX - minX + 1, maxY - minY + 1));
    const background = saliencyMean < 0.3 && edgeDensity < 0.06 && (borderRatio > 0.12 || area / n > 0.22);
    regions.push({
      id: s,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      area,
      meanTone,
      toneRange: toneMax - toneMin,
      saliency: saliencyMean,
      edgeDensity,
      coherence: cohSum / area,
      orientation: Math.atan2(oy, ox),
      background,
      mask: { cols: maskCols, rows: maskRows, cells },
    });
  }

  // Rank: subjects first by saliency × area share.
  regions.sort((a, b) => {
    const sa = (a.saliency + 0.05) * Math.sqrt(a.area);
    const sb = (b.saliency + 0.05) * Math.sqrt(b.area);
    if (a.background !== b.background) return a.background ? 1 : -1;
    return sb - sa;
  });
  return { regions, labels };
}

/** Dominant straight-edge orientations (perspective cue, spec §3). */
export function dominantEdgeDirections(fields: ClassicalFields, maxDirections = 3): Array<{ angle: number; weight: number }> {
  const { width, height, edges, gradDir } = fields;
  const bins = 72;
  const histogram = new Float32Array(bins);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = y * width + x;
      if (edges[i] < 0.5) continue;
      // Contour direction = gradient direction + 90°.
      const a = gradDir[i] + Math.PI / 2;
      const bin = Math.round((((a % Math.PI) + Math.PI) % Math.PI) / Math.PI * bins) % bins;
      histogram[bin] += 1;
    }
  }
  const peaks: Array<{ angle: number; weight: number }> = [];
  for (let k = 0; k < maxDirections; k++) {
    let bestBin = -1;
    let bestVal = 0;
    for (let b = 0; b < bins; b++) {
      if (histogram[b] > bestVal) {
        bestVal = histogram[b];
        bestBin = b;
      }
    }
    if (bestBin < 0 || bestVal <= 0) break;
    const angle = ((bestBin + 0.5) / bins) * Math.PI;
    const total = histogram.reduce((s, v) => s + v, 0) || 1;
    peaks.push({ angle, weight: bestVal / total });
    // Suppress the neighbourhood.
    for (let b = bestBin - 3; b <= bestBin + 3; b++) histogram[(b + bins) % bins] = 0;
  }
  return peaks;
}

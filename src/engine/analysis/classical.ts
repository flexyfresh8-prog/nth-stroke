/**
 * Classical computer-vision core of the observation stage (spec §3, §4-A).
 * Everything here is deterministic, dependency-free and runs on plain typed
 * arrays, both in the worker and in Node tests.
 *
 * Extracts: luminance, gradients, structure-tensor orientation field,
 * Canny-style edges, center-surround saliency, texture energy, tonal
 * percentiles and light-direction estimate.
 */

import { clamp } from '../core/math';

export interface TonePercentiles {
  p5: number;
  p12: number;
  p20: number;
  p50: number;
  p80: number;
  p85: number;
  p95: number;
}

export interface ClassicalFields {
  width: number;
  height: number;
  /** Luminance 0..1. */
  lum: Float32Array;
  /** Gradient magnitude 0..1. */
  gradMag: Float32Array;
  /** Gradient direction (radians). */
  gradDir: Float32Array;
  /** Edge strength after NMS + hysteresis (0/1 with soft values). */
  edges: Float32Array;
  /** Form-following direction field (radians) — hatches follow this. */
  orientation: Float32Array;
  /** Structure-tensor coherence 0..1 (1 = strong local structure). */
  coherence: Float32Array;
  /** Saliency 0..1. */
  saliency: Float32Array;
  /** Local texture energy 0..1 (band-pass energy). */
  texture: Float32Array;
  tonePercentiles: TonePercentiles;
  /** Estimated direction toward the light (unit vector), null if unclear. */
  light: { x: number; y: number; strength: number } | null;
}

export function luminanceFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const lum = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++) {
    const o = i * 4;
    lum[i] = (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;
  }
  return lum;
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        sum += src[y * width + xx];
      }
      tmp[y * width + x] = sum * norm;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        sum += tmp[yy * width + x];
      }
      out[y * width + x] = sum * norm;
    }
  }
  return out;
}

function downsample(src: Float32Array, width: number, height: number, factor: number): Float32Array {
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = y * factor + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          if (sx >= width) break;
          sum += src[sy * width + sx];
          n++;
        }
      }
      out[y * w + x] = n ? sum / n : 0;
    }
  }
  return out;
}

function upsampleTo(src: Float32Array, sw: number, sh: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const fx = sw / width;
  const fy = sh / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * fy));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * fx));
      out[y * width + x] = src[sy * sw + sx];
    }
  }
  return out;
}

function normalizeField(f: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < min) min = f[i];
    if (f[i] > max) max = f[i];
  }
  const range = max - min;
  if (range < 1e-9) return new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - min) / range;
  return f;
}

function percentile(sorted: Float32Array, p: number): number {
  const idx = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx];
}

/** Full classical analysis of an RGBA image at analysis resolution. */
export function analyzeClassical(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): ClassicalFields {
  const n = width * height;
  const lum = luminanceFromRgba(rgba, width, height);
  const lumSoft = boxBlur(lum, width, height, 1);

  // --- Sobel gradients ---------------------------------------------------
  const gradMag = new Float32Array(n);
  const gradDir = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(width - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);
      const tl = lum[ym * width + xm];
      const t = lum[ym * width + x];
      const tr = lum[ym * width + xp];
      const l = lum[y * width + xm];
      const r = lum[y * width + xp];
      const bl = lum[yp * width + xm];
      const b = lum[yp * width + x];
      const br = lum[yp * width + xp];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      const i = y * width + x;
      gradMag[i] = Math.min(1, Math.hypot(gx, gy) * 1.15);
      gradDir[i] = Math.atan2(gy, gx);
    }
  }

  // --- Structure tensor → orientation + coherence -------------------------
  // Computed on a SMOOTHED luminance so gentle form gradients (the slow
  // value ramp across a cheek or a sphere) still define the local form —
  // the field an artist shades along — while pixel noise does not.
  const lumForm = boxBlur(lum, width, height, 3);
  const jxx = new Float32Array(n);
  const jyy = new Float32Array(n);
  const jxy = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(width - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);
      const gx = lumForm[y * width + xp] - lumForm[y * width + xm];
      const gy = lumForm[yp * width + x] - lumForm[ym * width + x];
      const i = y * width + x;
      jxx[i] = gx * gx;
      jyy[i] = gy * gy;
      jxy[i] = gx * gy;
    }
  }
  const sJxx = boxBlur(jxx, width, height, 2);
  const sJyy = boxBlur(jyy, width, height, 2);
  const sJxy = boxBlur(jxy, width, height, 2);
  const orientation = new Float32Array(n);
  const coherence = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const xx = sJxx[i];
    const yy = sJyy[i];
    const xy = sJxy[i];
    const trace = xx + yy;
    if (trace < 1e-9) {
      orientation[i] = Math.PI / 2; // default vertical-ish
      coherence[i] = 0;
      continue;
    }
    // Eigenvector for the largest eigenvalue gives the dominant gradient
    // direction; the form-following stroke direction is perpendicular.
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    const det = xx * yy - xy * xy;
    const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
    const l1 = trace / 2 + disc;
    const l2 = trace / 2 - disc;
    orientation[i] = angle + Math.PI / 2;
    // Coherence = pure anisotropy (reliable direction) attenuated only for
    // essentially flat areas, so smooth forms keep a usable field.
    const anisotropy = clamp((l1 - l2) / (l1 + l2), 0, 1);
    coherence[i] = anisotropy * clamp(0.35 + Math.sqrt(trace) * 9, 0, 1);
  }

  // --- Edges: NMS + hysteresis --------------------------------------------
  const edges = new Float32Array(n);
  const hi = 0.14;
  const lo = 0.05;
  const stack: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const m = gradMag[i];
      if (m < lo) continue;
      const dir = gradDir[i];
      const dx = Math.cos(dir);
      const dy = Math.sin(dir);
      const a = gradMag[(y + Math.round(dy)) * width + (x + Math.round(dx))];
      const b = gradMag[(y - Math.round(dy)) * width + (x - Math.round(dx))];
      if (m >= a && m >= b) {
        edges[i] = m >= hi ? 1 : m * 0.5;
        if (m >= hi) stack.push(i);
      }
    }
  }
  // Hysteresis grow from strong edges.
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const j = yy * width + xx;
        if (edges[j] > 0 && edges[j] < 0.9) {
          edges[j] = 1;
          stack.push(j);
        }
      }
    }
  }

  // --- Saliency: center-surround + edge structure + center bias -----------
  const fine = boxBlur(lum, width, height, 2);
  const coarse = upsampleTo(
    downsample(lum, width, height, 8),
    Math.max(1, Math.floor(width / 8)),
    Math.max(1, Math.floor(height / 8)),
    width,
    height,
  );
  const contrast = new Float32Array(n);
  for (let i = 0; i < n; i++) contrast[i] = Math.abs(fine[i] - coarse[i]);
  normalizeField(contrast);
  const edgeSmooth = boxBlur(edges, width, height, 4);
  normalizeField(edgeSmooth);
  const saliency = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const cy = 1 - Math.abs((y + 0.5) / height - 0.46) * 1.7;
    for (let x = 0; x < width; x++) {
      const cx = 1 - Math.abs((x + 0.5) / width - 0.5) * 1.6;
      const center = clamp(Math.min(cx, cy), 0.12, 1);
      const i = y * width + x;
      saliency[i] = clamp(0.45 * contrast[i] + 0.35 * edgeSmooth[i] + 0.2 * center, 0, 1);
    }
  }
  normalizeField(saliency);

  // --- Texture energy: band-pass (fine blur − medium blur) -----------------
  const f1 = boxBlur(lum, width, height, 1);
  const f3 = boxBlur(lum, width, height, 3);
  const texture = new Float32Array(n);
  for (let i = 0; i < n; i++) texture[i] = Math.abs(f1[i] - f3[i]);
  normalizeField(texture);

  // --- Tone percentiles ----------------------------------------------------
  const sorted = Float32Array.from(lum).sort();
  const tonePercentiles: TonePercentiles = {
    p5: percentile(sorted, 0.05),
    p12: percentile(sorted, 0.12),
    p20: percentile(sorted, 0.2),
    p50: percentile(sorted, 0.5),
    p80: percentile(sorted, 0.8),
    p85: percentile(sorted, 0.85),
    p95: percentile(sorted, 0.95),
  };

  // --- Light direction: saliency-weighted mean gradient ---------------------
  let gxSum = 0;
  let gySum = 0;
  let wSum = 0;
  for (let i = 0; i < n; i++) {
    const w = saliency[i] * gradMag[i] * (1 - Math.abs(lum[i] - tonePercentiles.p50));
    gxSum += Math.cos(gradDir[i]) * w;
    gySum += Math.sin(gradDir[i]) * w;
    wSum += w;
  }
  let light: ClassicalFields['light'] = null;
  if (wSum > 1e-6) {
    const gx = gxSum / wSum;
    const gy = gySum / wSum;
    const len = Math.hypot(gx, gy);
    // Coherence of the vote decides whether the estimate is trustworthy.
    if (len > 0.06) light = { x: gx / len, y: gy / len, strength: clamp(len * 2.4, 0, 1) };
  }

  return {
    width,
    height,
    lum,
    gradMag,
    gradDir,
    edges,
    orientation,
    coherence,
    saliency,
    texture,
    tonePercentiles,
    light,
  };
}

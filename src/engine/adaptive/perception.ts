import { analyzeClassical } from '../analysis/classical';
import type { FaceObservation } from '../ml/provider';
import type { Vec2 } from '../core/types';

export interface Field {
  width: number;
  height: number;
  tone: Float32Array;
  levels: Float32Array[];
  angle: Float32Array;
  coherence: Float32Array;
  edge: Float32Array;
  coarseEdge: Float32Array;
  contrast: Float32Array;
  importance: Float32Array;
  saliency: Float32Array;
  regions: Uint32Array;
  highlights: Uint8Array;
  shadows: Uint8Array;
  landmarks: Vec2[];
  contours: Vec2[][];
  kind: 'line' | 'portrait' | 'tone' | 'scene';
}

export function whiteTone(rgba: Uint8Array | Uint8ClampedArray) {
  const tone = new Float32Array(rgba.length / 4);
  for (let i = 0; i < tone.length; i++) {
    const p = i * 4;
    tone[i] =
      1 - ((1 - (rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722) / 255) * rgba[p + 3]) / 255;
  }
  return tone;
}

export function gaussian(src: Float32Array, w: number, h: number, stride: number) {
  const tmp = new Float32Array(src.length),
    out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      tmp[p] =
        (src[y * w + Math.max(0, x - 2 * stride)] +
          4 * src[y * w + Math.max(0, x - stride)] +
          6 * src[p] +
          4 * src[y * w + Math.min(w - 1, x + stride)] +
          src[y * w + Math.min(w - 1, x + 2 * stride)]) /
        16;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      out[p] =
        (tmp[Math.max(0, y - 2 * stride) * w + x] +
          4 * tmp[Math.max(0, y - stride) * w + x] +
          6 * tmp[p] +
          4 * tmp[Math.min(h - 1, y + stride) * w + x] +
          tmp[Math.min(h - 1, y + 2 * stride) * w + x]) /
        16;
    }
  return out;
}

export function gradient(t: Float32Array, w: number, h: number) {
  const out = new Float32Array(t.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      out[y * w + x] =
        0.5 *
        Math.hypot(
          t[y * w + Math.min(w - 1, x + 1)] - t[y * w + Math.max(0, x - 1)],
          t[Math.min(h - 1, y + 1) * w + x] - t[Math.max(0, y - 1) * w + x],
        );
    }
  return out;
}

function tonalRegions(tone: Float32Array, w: number) {
  const labels = new Uint32Array(tone.length);
  const queue = new Int32Array(tone.length);
  let id = 0;
  for (let p = 0; p < tone.length; p++) {
    if (labels[p]) continue;
    const band = Math.min(5, Math.floor(tone[p] * 6));
    labels[p] = ++id;
    let head = 0,
      tail = 1;
    queue[0] = p;
    while (head < tail) {
      const i = queue[head++];
      const neighbors = [i % w ? i - 1 : -1, i % w < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const n of neighbors) {
        if (n < 0 || n >= tone.length || labels[n] || Math.min(5, Math.floor(tone[n] * 6)) !== band) continue;
        labels[n] = id;
        queue[tail++] = n;
      }
    }
  }
  return labels;
}

// Trace level crossings joined by their shared grid edge. Ambiguous cells use
// the midpoint value. Retain subpixel positions and break long paths at lifts.
function contours(t: Float32Array, w: number, h: number) {
  const paths: Vec2[][] = [];
  for (const level of [0.39, 0.65, 0.83]) {
    const points = new Map<number, Vec2>(),
      links = new Map<number, number[]>();
    function join(a: number, b: number) {
      if (!links.has(a)) links.set(a, []);
      if (!links.has(b)) links.set(b, []);
      links.get(a)!.push(b);
      links.get(b)!.push(a);
    }
    for (let y = 0; y < h - 1; y++)
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x,
          a = t[i],
          b = t[i + 1],
          c = t[i + w + 1],
          d = t[i + w];
        const keys: number[] = [];
        function cross(key: number, a: number, b: number, x0: number, y0: number, vertical: boolean) {
          if (a < level === b < level) return;
          keys.push(key);
          const u = (level - a) / (b - a);
          points.set(key, { x: x0 + (vertical ? 0 : u), y: y0 + (vertical ? u : 0) });
        }
        cross(2 * i, a, b, x, y, false);
        cross(2 * (i + 1) + 1, b, c, x + 1, y, true);
        cross(2 * (i + w), d, c, x, y + 1, false);
        cross(2 * i + 1, a, d, x, y, true);
        if (keys.length === 2) join(keys[0], keys[1]);
        if (keys.length === 4) {
          if ((a + b + c + d) * 0.25 < level === a < level) keys.push(keys.shift()!);
          join(keys[0], keys[1]);
          join(keys[2], keys[3]);
        }
      }
    const visited = new Set<number>();
    function take(start: number) {
      let i: number | undefined = start;
      const chain: Vec2[] = [];
      while (i !== undefined && !visited.has(i)) {
        visited.add(i);
        chain.push(points.get(i)!);
        i = links.get(i)!.find((k) => !visited.has(k));
      }
      if (chain.length < Math.max(10, Math.max(w, h) * 0.047)) return;
      const span = Math.max(14, Math.round(Math.max(w, h) * 0.24));
      for (let j = 0; j < chain.length - 8; j += span) {
        const segment = chain.slice(j, j + span + 1);
        paths.push(segment.filter((_, k) => k % 3 === 0 || k === segment.length - 1));
      }
    }
    for (const [i, ns] of links) if (ns.length === 1) take(i);
    for (const i of links.keys()) take(i);
  }
  return paths.sort((a, b) => b.length - a.length).slice(0, 160);
}

export function observe(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  face?: FaceObservation | null,
  restored?: Vec2[],
): Field {
  const tone = whiteTone(rgba),
    aligned = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < tone.length; i++) aligned.fill(Math.round(tone[i] * 255), i * 4, i * 4 + 3);
  const classical = analyzeClassical(aligned, width, height);
  const near = gaussian(tone, width, height, 1),
    medium = gaussian(near, width, height, 2),
    broad = gaussian(medium, width, height, 4);
  const edge = gradient(tone, width, height),
    coarseEdge = gradient(medium, width, height);
  const contrast = new Float32Array(tone.length),
    importance = new Float32Array(tone.length);
  const highlights = new Uint8Array(tone.length),
    shadows = new Uint8Array(tone.length);
  const landmarks: Vec2[] = restored ?? [];
  if (face?.landmarks) {
    for (const i of [1, 13, 14, 33, 133, 159, 145, 362, 263, 386, 374, 70, 300, 152, 61, 291]) {
      const p = face.landmarks[i];
      if (p) landmarks.push({ x: p.x * width, y: p.y * height });
    }
  }
  let extremes = 0,
    edgeMass = 0;
  const focusRadius = Math.max(width, height) * 0.033;
  for (let i = 0; i < tone.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    contrast[i] = Math.abs(tone[i] - medium[i]);
    const focus = landmarks.some((p) => Math.hypot(p.x - x, p.y - y) < focusRadius) ? 0.46 : 0;
    importance[i] = Math.min(1, contrast[i] * 1.5 + edge[i] * 1.65 + classical.saliency[i] * 0.31 + focus);
    if (tone[i] > 0.88 || tone[i] < 0.15) extremes++;
    if (edge[i] > 0.1) edgeMass++;
    highlights[i] = Number(tone[i] > 0.89 && broad[i] > 0.68);
    shadows[i] = Number(broad[i] < 0.42);
  }
  return {
    width,
    height,
    tone,
    levels: [tone, near, medium, broad],
    angle: classical.orientation,
    coherence: classical.coherence,
    edge,
    coarseEdge,
    contrast,
    importance,
    saliency: classical.saliency,
    regions: tonalRegions(medium, width),
    highlights,
    shadows,
    landmarks,
    contours: contours(medium, width, height),
    kind: landmarks.length
      ? 'portrait'
      : extremes / tone.length > 0.56 && edgeMass / tone.length > 0.037
        ? 'line'
        : edgeMass / tone.length < 0.04
          ? 'tone'
          : 'scene',
  };
}

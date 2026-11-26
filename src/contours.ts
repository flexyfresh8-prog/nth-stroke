import { clamp, mix } from './brush';
import type { ReferenceAnalysis } from './drawing';
import type { Point, Stroke } from './engine';

interface Contour {
  id: number;
  path: Point[];
  length: number;
  contrast: number;
  coarse: boolean;
}

function soften(input: Float32Array, w: number, h: number, rounds: number) {
  let signal = input.slice();
  let out = new Float32Array(input.length);
  for (let round = 0; round < rounds; round++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = (4 * signal[i] + signal[x ? i - 1 : i] + signal[x + 1 < w ? i + 1 : i]
          + signal[y ? i - w : i] + signal[y + 1 < h ? i + w : i]) / 8;
      }
    }
    [signal, out] = [out, signal];
  }
  return signal;
}

// Join level crossings by their shared grid edge; closed silhouettes remain continuous.
function levelLines(field: Float32Array, w: number, h: number, level: number) {
  const links = new Map<number, number[]>();
  const positions = new Map<number, Point>();
  function join(a: number, b: number) {
    for (const [p, q] of [[a, b], [b, a]]) {
      const neighbors = links.get(p);
      if (neighbors) neighbors.push(q);
      else links.set(p, [q]);
    }
  }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const a = field[i], b = field[i + 1], c = field[i + w + 1], d = field[i + w];
      const mask = Number(a > level) + 2 * Number(b > level) + 4 * Number(c > level) + 8 * Number(d > level);
      if (mask === 0 || mask === 15) continue;
      const edges: number[] = [];
      const cross = (key: number, first: number, last: number, px: number, py: number, vertical: boolean) => {
        if ((first > level) === (last > level)) return;
        edges.push(key);
        if (positions.has(key)) return;
        const t = (level - first) / (last - first);
        positions.set(key, { x: px + 0.5 + (vertical ? 0 : t), y: py + 0.5 + (vertical ? t : 0) });
      };
      cross(2 * i, a, b, x, y, false);
      cross(2 * (i + 1) + 1, b, c, x + 1, y, true);
      cross(2 * (i + w), d, c, x, y + 1, false);
      cross(2 * i + 1, a, d, x, y, true);
      if (edges.length === 2) join(edges[0], edges[1]);
      else {
        if (((a + b + c + d) / 4 > level) === (a > level)) edges.push(edges.shift()!);
        join(edges[0], edges[1]);
        join(edges[2], edges[3]);
      }
    }
  }
  const visited = new Set<number>();
  const chains: Point[][] = [];
  function walk(start: number) {
    if (visited.has(start)) return;
    const points: Point[] = [];
    let current = start;
    let prev = -1;
    while (!visited.has(current)) {
      visited.add(current);
      points.push(positions.get(current)!);
      const next = links.get(current)!.find(n => n !== prev);
      if (next === undefined) break;
      prev = current;
      current = next;
      if (current === start) points.push(points[0]);
    }
    if (points.length >= 5) chains.push(points);
  }
  for (const [key, neighbors] of links) if (neighbors.length === 1) walk(key);
  for (const key of links.keys()) walk(key);
  return chains;
}

function features(ref: ReferenceAnalysis) {
  const { width: w, height: h } = ref.sample;
  const side = Math.max(w, h);
  const found: Contour[] = [];
  if (w < 2 || h < 2 || ref.strength < 0.001) return found;
  for (const coarse of [true, false]) {
    const signal = soften(ref.tone, w, h, coarse ? 8 : 1);
    let lo = 1, hi = 0;
    for (const v of signal) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 0.025) continue;
    for (const band of coarse ? [0.35, 0.63, 0.86] : [0.22, 0.48, 0.72, 0.87]) {
      for (const chain of levelLines(signal, w, h, mix(lo, hi, band))) {
        let arc: Point[] = [chain[0]];
        let length = 0, contrast = 0, since = 0;
        for (let i = 1; i < chain.length; i++) {
          const p = chain[i], prior = chain[i - 1];
          const d = Math.hypot(p.x - prior.x, p.y - prior.y);
          length += d;
          since += d;
          const pixel = clamp(Math.floor(p.y), 0, h - 1) * w + clamp(Math.floor(p.x), 0, w - 1);
          const left = Math.max(0, pixel - 1), right = Math.min(ref.edge.length - 1, pixel + 1);
          const peak = Math.max(ref.edge[pixel], ref.edge[left], ref.edge[right], ref.edge[Math.max(0, pixel - w)], ref.edge[Math.min(ref.edge.length - 1, pixel + w)]);
          contrast += peak * d;
          if (since >= (coarse ? 2.2 : 1.15) || i === chain.length - 1) { arc.push(p); since = 0; }
          if (length < side * (coarse ? 0.56 : 0.32) && i < chain.length - 1) continue;
          if (length > Math.max(3, side * (coarse ? 0.08 : 0.023)) && arc.length > 2) {
            found.push({ id: found.length, path: arc, length, contrast: contrast / length, coarse });
          }
          arc = [p]; length = 0; contrast = 0; since = 0;
        }
      }
    }
  }
  return found;
}

// Block the outer shape into a few changes of direction, then round the joins.
function constructionArc(points: Point[], tolerance: number): Point[] {
  const anchors: Point[] = [points[0]];
  function simplify(first: number, last: number) {
    const a = points[first], b = points[last];
    const dx = b.x - a.x, dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    let split = -1, furthest = tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const t = squared ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / squared, 0, 1) : 0;
      const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (distance > furthest) { split = i; furthest = distance; }
    }
    if (split < 0) anchors.push(b);
    else { simplify(first, split); simplify(split, last); }
  }
  simplify(0, points.length - 1);
  const softened = [anchors[0]];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    for (const t of [0.18, 0.82]) softened.push({x: mix(a.x, b.x, t), y: mix(a.y, b.y, t)});
  }
  softened.push(anchors.at(-1)!);
  // Sample long spans so the pencil can build pressure between the anchors.
  const path = [softened[0]];
  for (let i = 1; i < softened.length; i++) {
    const a = softened[i - 1], b = softened[i];
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2.5));
    for (let n = 1; n <= count; n++) path.push({ x: mix(a.x, b.x, n / count), y: mix(a.y, b.y, n / count) });
  }
  return path;
}

export class ContourPicker {
  private readonly lines: Contour[];
  private readonly covered: Uint8Array;
  private readonly used = new Set<number>();
  private recorded = 0;
  private previous?: Stroke;

  constructor(private readonly ref: ReferenceAnalysis) {
    this.lines = features(ref);
    this.covered = new Uint8Array(ref.tone.length);
  }

  private sync(history: readonly Stroke[]) {
    if (this.recorded > history.length || (this.recorded && history[this.recorded - 1] !== this.previous)) {
      this.recorded = 0; this.used.clear(); this.covered.fill(0);
    }
    const { width, height } = this.ref.sample;
    for (; this.recorded < history.length; this.recorded++) {
      const mark = history[this.recorded];
      if (mark.feature === undefined) continue;
      this.used.add(mark.feature);
      for (const p of mark.path) {
        const x = Math.floor(p.x * width), y = Math.floor(p.y * height);
        for (let j = Math.max(0, y - 2); j <= Math.min(height - 1, y + 2); j++) {
          for (let k = Math.max(0, x - 2); k <= Math.min(width - 1, x + 2); k++) {
            const idx = j * width + k;
            this.covered[idx] = Math.max(this.covered[idx], mark.stage === 'Construction' ? 1 : 2);
          }
        }
      }
    }
    this.previous = history.at(-1);
  }

  choose(pass: number, work: ImageData, history: readonly Stroke[], random: () => number, brush: Stroke['brush']): Stroke | undefined {
    this.sync(history);
    const { width, height, data } = work;
    const side = Math.max(width, height);
    const native = Math.max(this.ref.width, this.ref.height) / side;
    const last = history.at(-1)?.end;
    let best: Contour | undefined;
    let score = 0;
    for (const line of this.lines) {
      if ((pass === 0 && !line.coarse) || (pass === 2 && line.coarse) || this.used.has(line.id)) continue;
      if (line.contrast < (pass === 0 ? 0.13 : 0.20)) continue;
      let need = 0, samples = 0;
      const step = Math.max(1, Math.floor(line.path.length / 10));
      for (let i = 0; i < line.path.length; i += step) {
        const p = line.path[i];
        const idx = Math.floor(p.y) * width + Math.floor(p.x);
        const paper = (data[idx * 4] + data[idx * 4 + 1] + data[idx * 4 + 2]) / 765;
        const coverage = this.covered[idx];
        need += Math.max(0, paper - 0.25) * (coverage ? (pass === 2 && coverage === 1 ? 0.65 : 0.035) : 1);
        samples++;
      }
      need /= samples;
      if (need < 0.12) continue;
      const start = line.path[0], end = line.path.at(-1)!;
      const distance = last ? Math.min(Math.hypot(start.x - last.x * width, start.y - last.y * height),
        Math.hypot(end.x - last.x * width, end.y - last.y * height)) / side : 0;
      const rank = Math.sqrt(line.length) * (0.14 + line.contrast) * need / (0.28 + distance);
      if (rank > score) { best = line; score = rank; }
    }
    if (!best) return;
    const amplitude = (pass === 0 ? 1.5 : pass === 1 ? 0.75 : 0.20) * Math.min(1, side / 110);
    const bend = (random() - 0.5) * 2 * amplitude;
    const offset = (random() - 0.5) * amplitude;
    const line = pass === 0 ? constructionArc(best.path, Math.max(0.8, side * 0.014)) : best.path;
    const path = line.map((p, i, points) => {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const displacement = offset + bend * Math.sin(Math.PI * i / (points.length - 1));
      return { x: clamp((p.x - displacement * (b.y - a.y) / len) / width, 0, 1),
        y: clamp((p.y + displacement * (b.x - a.x) / len) / height, 0, 1) };
    });
    const distanceTo = (p: Point) => Math.hypot((p.x - (last?.x ?? 0.42)) * width, (p.y - (last?.y ?? 0.24)) * height);
    if (distanceTo(path.at(-1)!) < distanceTo(path[0])) path.reverse();
    const order = history.length, start = path[0], end = path.at(-1)!;
    const stage = (['Construction', 'Rough sketch', 'Refined linework'] as const)[pass];
    const weight = 0.52 + random() * 0.4;
    const peak = 0.35 + random() * 0.32;
    return { id: 's-' + (order + 1), order, stage, layer: stage.toLowerCase(), feature: best.id,
      start, end, path, controls: [start, end], brush, size: native * (pass === 2 ? 1.05 : 0.80),
      color: pass === 0 ? '#6e6660' : '#363638', opacity: [0.38, 0.58, 0.78][pass],
      velocity: (pass === 0 ? 1.27 : 0.85) * (0.85 + random() * 0.45),
      pressure: path.map((_, i) => {
        const t = i / (path.length - 1);
        return 0.06 + weight * Math.pow(Math.sin(Math.PI * Math.pow(t, peak + 0.45)), 0.65);
      }),
    };
  }
}

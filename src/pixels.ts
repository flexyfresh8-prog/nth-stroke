import { clamp, mix } from './brush';
import type { ReferenceAnalysis } from './drawing';
import type { Point, Stroke } from './engine';

export interface PixelNib {
  x: number;
  y: number;
  width: number;
  height: number;
  vertical: boolean;
  reverse: boolean;
  track?: Array<Point & { radius: number }>;
}

interface Patch {
  x: number;
  y: number;
  width: number;
  height: number;
  remaining: number;
}

export function nibLength(nib: PixelNib) {
  return nib.track?.length ?? (nib.vertical ? nib.height : nib.width);
}

export class PixelRefinement {
  readonly artwork: ImageData;
  private readonly paint: Uint32Array;
  private readonly source: Uint32Array;
  private readonly patches: Patch[] = [];
  private readonly owners: Uint16Array;
  private readonly pending = new Set<number>();
  private changed = 0;
  readonly initialDifference: number;
  private readonly spacing: number;

  constructor(private readonly ctx: CanvasRenderingContext2D, private readonly reference: ReferenceAnalysis) {
    const { width, height } = reference;
    this.artwork = ctx.getImageData(0, 0, width, height);
    this.paint = new Uint32Array(this.artwork.data.buffer);
    this.source = new Uint32Array(reference.pixels.data.buffer);
    this.owners = new Uint16Array(width * height);
    // Cells index unresolved pixels. Brush paths freely cross their boundaries.
    this.spacing = Math.max(4, Math.ceil(Math.max(width, height) / 28));
    for (let y = 0; y < height; y += this.spacing) {
      for (let x = 0; x < width; x += this.spacing) {
        this.addPatch({ x, y, width: Math.min(this.spacing, width - x),
          height: Math.min(this.spacing, height - y), remaining: 0 });
      }
    }
    this.initialDifference = this.changed;
  }

  get match() {
    return 1 - this.changed / this.paint.length;
  }

  private addPatch(patch: Patch) {
    const { x, y, width, height } = patch;
    const stride = this.artwork.width;
    const id = this.patches.length;
    this.patches.push(patch);
    for (let row = y; row < y + height; row++) {
      const start = row * stride + x;
      this.owners.fill(id, start, start + width);
      for (let p = start; p < start + width; p++) {
        if (this.paint[p] !== this.source[p]) patch.remaining++;
      }
    }
    if (patch.remaining) this.pending.add(id);
    this.changed += patch.remaining;
  }

  next(previous: Point, order: number, brush: Stroke['brush']): Stroke | undefined {
    const { width, height } = this.artwork;
    const px = previous.x * width;
    const py = previous.y * height;
    const locality = Math.max(width, height) / 11;
    let selected: Patch | undefined;
    let best = 0;
    for (const id of this.pending) {
      const patch = this.patches[id];
      const distance = Math.hypot(px - patch.x - patch.width / 2, py - patch.y - patch.height / 2);
      const score = (0.5 + Math.sqrt(patch.remaining / (patch.width * patch.height))) / (1 + distance / locality);
      if (score <= best) continue;
      selected = patch;
      best = score;
    }
    if (!selected) return;
    const patch = selected;
    const cx = patch.x + (patch.width - 1) / 2, cy = patch.y + (patch.height - 1) / 2;
    let anchor = -1, priority = -Infinity;
    const target = this.reference.pixels.data;
    const actual = this.artwork.data;
    for (let y = patch.y; y < patch.y + patch.height; y++) {
      for (let x = patch.x; x < patch.x + patch.width; x++) {
        const p = y * width + x;
        if (this.paint[p] === this.source[p]) continue;
        let error = 0;
        for (let c = 0; c < 4; c++) error += Math.abs(target[p * 4 + c] - actual[p * 4 + c]);
        const value = error / 600 - Math.hypot(x - cx, y - cy) / this.spacing;
        if (value > priority) { priority = value; anchor = p; }
      }
    }
    if (anchor === -1) throw new Error('Inconsistent pixel count');
    const center = { x: anchor % width + 0.5, y: Math.floor(anchor / width) + 0.5 };
    const { sample, gx, gy, edge } = this.reference;
    const site = (p: Point) => Math.floor(p.y * sample.height / height) * sample.width + Math.floor(p.x * sample.width / width);
    const index = site(center);
    const bias = Math.sin(order * 2.39996);
    const theta = edge[index] > 0.10 ? Math.atan2(gy[index], gx[index]) + Math.PI / 2 : -0.57 + bias * 0.38;
    const radius = Math.max(1.1, this.spacing * (0.9 - 0.44 * edge[index]));
    const stride = Math.max(0.28, radius * 0.22);
    const steps = Math.ceil(this.spacing * (1.12 + 0.42 * Math.abs(bias)) / stride);
    const half = (sign: number) => {
      const points: Array<Point & { radius: number }> = [];
      let angle = theta + (sign < 0 ? Math.PI : 0), p = center;
      for (let i = 1; i <= steps; i++) {
        const j = site(p);
        if (edge[j] > 0.12) {
          const tangent = Math.atan2(gy[j], gx[j]) + Math.PI / 2;
          angle += 0.23 * Math.atan2(Math.sin(2 * (tangent - angle)), Math.cos(2 * (tangent - angle)));
        }
        angle += sign * bias * 0.024;
        const x = clamp(p.x + Math.cos(angle) * stride, 0.5, width - 0.5);
        const y = clamp(p.y + Math.sin(angle) * stride, 0.5, height - 0.5);
        if (Math.hypot(x - p.x, y - p.y) < 0.02) break;
        p = { x, y };
        points.push({ x, y, radius: Math.max(0.6, radius * (1 - 0.72 * (i / steps) ** 1.6)) });
      }
      return points;
    };
    const track = [...half(-1).reverse(), { ...center, radius }, ...half(1)];
    if (track.length === 1) track.push(track[0]);
    const distance = (p: Point) => Math.hypot(p.x - px, p.y - py);
    if (distance(track.at(-1)!) < distance(track[0])) track.reverse();
    const path = track.map(p => ({ x: p.x / width, y: p.y / height }));
    const start = path[0], end = path.at(-1)!;
    const color = '#' + Array.from(target.subarray(anchor * 4, anchor * 4 + 3), v => v.toString(16).padStart(2, '0')).join('');
    return {
      id: 's-' + (order + 1), stage: 'Iterative refinement', layer: 'pixel refinement', order, start, end, path,
      controls: [start, end], brush, size: radius * 2, color, opacity: 1,
      pressure: track.map(p => p.radius / radius), velocity: 1.02 + Math.abs(bias) * 0.26,
      detail: { x: patch.x, y: patch.y, width: patch.width, height: patch.height, vertical: false, reverse: false, track },
    };
  }

  private correctRow(start: number, end: number) {
    for (let p = start; p < end; p++) {
      if (this.paint[p] === this.source[p]) continue;
      this.paint[p] = this.source[p];
      this.changed--;
      const id = this.owners[p];
      if (--this.patches[id].remaining === 0) this.pending.delete(id);
    }
  }

  private paintTrack(track: NonNullable<PixelNib['track']>, from: number, until: number) {
    const { width, height } = this.artwork;
    let left = width, right = 0, top = height, bottom = 0;
    for (let i = from; i < until; i++) {
      const { x, y, radius } = track[i];
      const minY = Math.max(0, Math.ceil(y - radius - 0.5));
      const maxY = Math.min(height, Math.floor(y + radius - 0.5) + 1);
      top = Math.min(top, minY); bottom = Math.max(bottom, maxY);
      for (let row = minY; row < maxY; row++) {
        const dy = row + 0.5 - y;
        const span = Math.sqrt(Math.max(0, radius * radius - dy * dy));
        const x0 = Math.max(0, Math.ceil(x - span - 0.5));
        const x1 = Math.min(width, Math.floor(x + span - 0.5) + 1);
        this.correctRow(row * width + x0, row * width + x1);
        left = Math.min(left, x0); right = Math.max(right, x1);
      }
    }
    if (right > left && bottom > top) this.ctx.putImageData(this.artwork, 0, 0, left, top, right - left, bottom - top);
  }

  paintNib(nib: PixelNib, from: number, until: number) {
    if (until <= from) return;
    if (nib.track) return this.paintTrack(nib.track, from, until);
    // Replay rectangular nibs recorded by the earlier engine.
    const start = nib.reverse ? nibLength(nib) - until : from;
    const count = until - from;
    const x = nib.x + (nib.vertical ? 0 : start);
    const y = nib.y + (nib.vertical ? start : 0);
    const width = nib.vertical ? nib.width : count;
    const height = nib.vertical ? count : nib.height;
    const stride = this.artwork.width;
    for (let row = y; row < y + height; row++) {
      const left = row * stride + x;
      this.correctRow(left, left + width);
    }
    this.ctx.putImageData(this.artwork, 0, 0, x, y, width, height);
  }
}

export function nibTip(nib: PixelNib, width: number, height: number, fraction: number): Point {
  if (nib.track) {
    const f = fraction * (nib.track.length - 1);
    const a = nib.track[Math.floor(f)], b = nib.track[Math.ceil(f)];
    return { x: mix(a.x, b.x, f % 1) / width, y: mix(a.y, b.y, f % 1) / height };
  }
  const t = nib.reverse ? 1 - fraction : fraction;
  return {
    x: (nib.x + nib.width * (nib.vertical ? 0.5 : t)) / width,
    y: (nib.y + nib.height * (nib.vertical ? t : 0.5)) / height,
  };
}

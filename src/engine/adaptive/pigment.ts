import type { Vec2, InstrumentId } from '../core/types';

export interface Medium {
  strength: number;
  softness: number;
  tooth: number;
  mode: 'deposit' | 'lift' | 'blend';
  radius: number;
}
export const MEDIA: Record<InstrumentId, Medium> = {
  'pencil-2h': { strength: 0.45, softness: 0.45, tooth: 0.24, mode: 'deposit', radius: 0.9 },
  'pencil-hb': { strength: 0.78, softness: 0.42, tooth: 0.48, mode: 'deposit', radius: 1.05 },
  'pencil-2b': { strength: 0.91, softness: 0.36, tooth: 0.63, mode: 'deposit', radius: 1.3 },
  'pencil-4b': { strength: 0.96, softness: 0.33, tooth: 0.69, mode: 'deposit', radius: 1.75 },
  'pencil-6b': { strength: 0.985, softness: 0.27, tooth: 0.74, mode: 'deposit', radius: 2.2 },
  mechanical: { strength: 0.94, softness: 0.29, tooth: 0.15, mode: 'deposit', radius: 0.65 },
  charcoal: { strength: 0.985, softness: 0.53, tooth: 0.84, mode: 'deposit', radius: 2.65 },
  stump: { strength: 0.6, softness: 0.7, tooth: 0, mode: 'blend', radius: 2.3 },
  'eraser-kneaded': { strength: 0.7, softness: 0.7, tooth: 0.15, mode: 'lift', radius: 2.5 },
  'eraser-precision': { strength: 0.96, softness: 0.31, tooth: 0.04, mode: 'lift', radius: 0.8 },
};
export interface Mark {
  path: Vec2[];
  radius: number;
  instrument: InstrumentId;
  opacity: number;
  phase: number;
  speed: number;
}
export interface Patch {
  indices: Int32Array;
  coverage: Float32Array;
  arrival: Float32Array;
  box: { x: number; y: number; w: number; h: number };
  mode: Medium['mode'];
}

export class Pigment {
  readonly density: Float32Array;
  readonly grain: Float32Array;
  private readonly mask: Float32Array;
  private readonly times: Float32Array;
  private readonly touched: Int32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    seed: number,
    private readonly texture: number,
  ) {
    const size = width * height;
    this.density = new Float32Array(size);
    this.grain = new Float32Array(size);
    this.mask = new Float32Array(size);
    this.times = new Float32Array(size);
    this.touched = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      let hash = Math.imul(i + 1, 0x9e3779b1) ^ seed;
      hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
      this.grain[i] = (hash >>> 0) / 4294967295;
    }
  }

  footprint(mark: Mark): Patch {
    const { width: w, height: h } = this,
      medium = MEDIA[mark.instrument];
    let length = 0;
    const distance = [0];
    for (let i = 1; i < mark.path.length; i++) {
      length += Math.hypot(mark.path[i].x - mark.path[i - 1].x, mark.path[i].y - mark.path[i - 1].y);
      distance.push(length);
    }
    const count = Math.max(1, Math.ceil(length / Math.max(0.42, mark.radius * 0.72)));
    let n = 0,
      minX = w,
      minY = h,
      maxX = -1,
      maxY = -1,
      seg = 1;
    for (let step = 0; step <= count; step++) {
      const f = step / count,
        d = f * length;
      while (seg < distance.length - 1 && distance[seg] < d) seg++;
      const a = mark.path[seg - 1],
        b = mark.path[seg],
        u = (d - distance[seg - 1]) / (distance[seg] - distance[seg - 1] || 1);
      const x = a.x + (b.x - a.x) * u,
        y = a.y + (b.y - a.y) * u;
      const taper = 0.73 + 0.27 * Math.sin(Math.PI * f) ** 0.6;
      const rx = mark.radius * taper + 0.49;
      const x0 = Math.max(0, Math.ceil(x - rx)),
        x1 = Math.min(w - 1, Math.floor(x + rx));
      const y0 = Math.max(0, Math.ceil(y - rx)),
        y1 = Math.min(h - 1, Math.floor(y + rx));
      const core = Math.max(0, mark.radius * taper * (1 - medium.softness) - 0.26);
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const q = Math.hypot(i - x, j - y);
          if (q >= rx) continue;
          const p = j * w + i,
            k = Math.min(1, (rx - q) / (rx - core));
          const strength =
            k * k * (3 - 2 * k) * taper * (1 - this.texture * 0.24 * medium.tooth * this.grain[p]);
          if (strength <= this.mask[p]) continue;
          if (!this.mask[p]) {
            this.touched[n++] = p;
            minX = Math.min(minX, i);
            maxX = Math.max(maxX, i);
            minY = Math.min(minY, j);
            maxY = Math.max(maxY, j);
          }
          this.mask[p] = strength;
          this.times[p] = f;
        }
    }
    const indices = this.touched.slice(0, n),
      coverage = new Float32Array(n),
      arrival = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = indices[i];
      coverage[i] = this.mask[p];
      arrival[i] = this.times[p];
      this.mask[p] = 0;
    }
    return {
      indices,
      coverage,
      arrival,
      box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      mode: medium.mode,
    };
  }

  /** Signed physical direction prior to fitting the pressure scalar. */
  direction(patch: Patch): Float32Array {
    const { indices, coverage, mode } = patch;
    let mean = 0,
      sum = 0;
    if (mode === 'blend') {
      for (let i = 0; i < indices.length; i++) {
        mean += coverage[i] * this.density[indices[i]];
        sum += coverage[i];
      }
      mean /= sum || 1;
    }
    return Float32Array.from(indices, (p, i) => {
      const d = this.density[p];
      // Dense graphite can fill the remaining paper tooth with a soft pencil.
      // The ceiling is the unoccupied pigment capacity, regardless of pressure.
      if (mode === 'deposit') return Math.min(1 - d, coverage[i] * Math.max(0.34, 1 - d));
      return coverage[i] * (mode === 'lift' ? -d : mean - d);
    });
  }

  tone() {
    return Float32Array.from(this.density, (d) => Math.round((1 - d) * 255) / 255);
  }
  compositeRect(
    _paper: Float32Array,
    out: Uint8ClampedArray,
    rect: { x: number; y: number; w: number; h: number },
    _size: { width: number; height: number },
    stride = rect.w,
  ) {
    for (let y = 0; y < rect.h; y++)
      for (let x = 0; x < rect.w; x++) {
        const p = (y * stride + x) * 4,
          value = 255 * (1 - this.density[(rect.y + y) * this.width + rect.x + x]);
        out[p] = out[p + 1] = out[p + 2] = value;
        out[p + 3] = 255;
      }
  }
}

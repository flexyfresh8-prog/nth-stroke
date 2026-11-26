/**
 * The graphite density map — the single source of truth for the artwork
 * (spec §1: the canvas state IS the accumulated deposits; nothing else).
 * Compositing to displayable pixels uses Beer–Lambert absorption over the
 * paper albedo. Runs in pure typed arrays — no DOM — so the same class
 * serves the worker, the browser composite and the Node verification runs.
 */

import { TILE } from '../core/tiles';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of raw bytes — works in Node and the browser identically. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) & 63) << 6) |
      (B64.indexOf(clean[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class GraphiteMap {
  readonly density: Float32Array;
  /** Total graphite deposited (for mass-conservation checks in tests). */
  totalDeposited = 0;
  /** Monotonic edit counter — bumped by any mutation (user or engine). */
  edits = 0;

  constructor(readonly width: number, readonly height: number) {
    this.density = new Float32Array(width * height);
  }

  clear() {
    this.density.fill(0);
    this.totalDeposited = 0;
    this.edits++;
  }

  /** Composite a rect to grayscale RGBA bytes (paper × e^{-k·density}).
   *  `out` holds (stride × rect-height) pixels; local coordinates start
   *  at the rect origin, so callers may pass either a full-canvas buffer
   *  (stride = width) or a tight tile buffer (stride = rect width). */
  compositeRect(
    albedo: Float32Array,
    out: Uint8ClampedArray,
    rect: Rect,
    paper: { width: number; height: number },
    stride: number = this.width,
  ) {
    const x1 = Math.max(0, Math.floor(rect.x));
    const y1 = Math.max(0, Math.floor(rect.y));
    const x2 = Math.min(this.width, Math.ceil(rect.x + rect.w));
    const y2 = Math.min(this.height, Math.ceil(rect.y + rect.h));
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = y * this.width + x;
        const a = paper.width === this.width && paper.height === this.height ? albedo[i] : albedo[(y % paper.height) * paper.width + (x % paper.width)];
        // Beer–Lambert: transmitted light falls exponentially with density.
        const tone = a * Math.exp(-2.6 * this.density[i]);
        const v = tone * 255;
        const o = ((y - y1) * stride + (x - x1)) * 4;
        out[o] = v;
        out[o + 1] = v * 0.998;
        out[o + 2] = v * 0.992;
        out[o + 3] = 255;
      }
    }
  }

  /** Mean tone (0..1 luminance) over the whole map — cheap global metric. */
  meanTone(albedo: Float32Array): number {
    let sum = 0;
    const n = this.density.length;
    for (let i = 0; i < n; i++) sum += albedo[i] * Math.exp(-2.6 * this.density[i]);
    return sum / n;
  }

  /** Downsample the density map into a coarse grid (box filter) for the
   *  multiscale evaluator. Returns a tone map [0,1] of size cw×ch. */
  tonePyramidLevel(albedo: Float32Array, cw: number, ch: number): Float32Array {
    const out = new Float32Array(cw * ch);
    const sx = this.width / cw;
    const sy = this.height / ch;
    for (let cy = 0; cy < ch; cy++) {
      const y0 = Math.floor(cy * sy);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * sy));
      for (let cx = 0; cx < cw; cx++) {
        const x0 = Math.floor(cx * sx);
        const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * sx));
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1 && y < this.height; y++) {
          const row = y * this.width;
          for (let x = x0; x < x1 && x < this.width; x++) {
            const i = row + x;
            sum += albedo[i] * Math.exp(-2.6 * this.density[i]);
            count++;
          }
        }
        out[cy * cw + cx] = count ? sum / count : 1;
      }
    }
    return out;
  }

  /** Mean deposited density in a disc (used by planner/evaluator). */
  meanDensity(x: number, y: number, radius: number): number {
    let sum = 0;
    let count = 0;
    const x0 = Math.max(0, Math.floor(x - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(x + radius));
    const y0 = Math.max(0, Math.floor(y - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(y + radius));
    const r2 = radius * radius;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - x;
        const dy = py + 0.5 - y;
        if (dx * dx + dy * dy > r2) continue;
        sum += this.density[py * this.width + px];
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  /** Highest density in a disc — used to detect overshoot. */
  maxDensity(x: number, y: number, radius: number): number {
    let m = 0;
    const x0 = Math.max(0, Math.floor(x - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(x + radius));
    const y0 = Math.max(0, Math.floor(y - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(y + radius));
    const r2 = radius * radius;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - x;
        const dy = py + 0.5 - y;
        if (dx * dx + dy * dy > r2) continue;
        const d = this.density[py * this.width + px];
        if (d > m) m = d;
      }
    }
    return m;
  }

  /** Tiles that contain any graphite. */
  occupiedTiles(): number[] {
    const cols = Math.ceil(this.width / TILE);
    const rows = Math.ceil(this.height / TILE);
    const marks = new Uint8Array(cols * rows);
    for (let y = 0; y < this.height; y++) {
      const ty = Math.min(rows - 1, (y / TILE) | 0);
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (this.density[row + x] > 0.01) {
          marks[ty * cols + Math.min(cols - 1, (x / TILE) | 0)] = 1;
        }
      }
    }
    const out: number[] = [];
    for (let i = 0; i < marks.length; i++) if (marks[i]) out.push(i);
    return out;
  }

  /** FNV-1a-ish hash of the density bits — determinism checks in tests. */
  fingerprint(): string {
    let h = 2166136261;
    const d = this.density;
    for (let i = 0; i < d.length; i++) {
      // Quantize to 1e-3 so float noise cannot flip the fingerprint.
      const q = Math.round(d[i] * 1000) | 0;
      h ^= q & 255;
      h = Math.imul(h, 16777619);
      h ^= (q >>> 8) & 255;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /** Serialize / restore (checkpoints + .nth project files).
   *  The density bits are stored losslessly (Float32 → base64) so a
   *  restored run continues bit-exactly. */
  encode(): { width: number; height: number; b64: string } {
    const bytes = new Uint8Array(this.density.buffer, this.density.byteOffset, this.density.byteLength);
    return { width: this.width, height: this.height, b64: bytesToBase64(bytes) };
  }

  static decode(data: { width: number; height: number; b64: string }): GraphiteMap {
    const map = new GraphiteMap(data.width, data.height);
    const bytes = base64ToBytes(data.b64);
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    map.density.set(floats.subarray(0, map.density.length));
    map.edits = 1;
    return map;
  }
}

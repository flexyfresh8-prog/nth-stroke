/**
 * Procedural paper model: a height field ("tooth") plus a subtle albedo
 * mottle, deterministic from the engine seed. The height field drives the
 * grain response of every instrument (spec §6 — paper grain).
 */

/** Deterministic 2-D hash noise in [0,1). */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth bilinear value noise with period `scale` pixels. */
function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export class Paper {
  /** Tooth height per pixel, ~[0,1]. */
  readonly height: Float32Array;
  /** Display albedo per pixel [0,1] (paper color with mottle). */
  readonly albedo: Float32Array;

  constructor(readonly width: number, readonly heightPx: number, seed: number, grain: number) {
    const n = width * heightPx;
    this.height = new Float32Array(n);
    this.albedo = new Float32Array(n);
    // Three octaves of fine grain — fibers at paper scale.
    const s1 = seed ^ 0x1a2b3c4d;
    const s2 = mixSeed(seed, 977);
    const s3 = mixSeed(seed, 740_231);
    const s4 = mixSeed(seed, 41_337);
    const tooth = 0.35 + 0.5 * grain;
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const fine = valueNoise(x, y, 0.9, s1);
        const mid = valueNoise(x, y, 2.6, s2);
        const coarse = valueNoise(x, y, 7.5, s3);
        const hRaw = 0.5 + (fine - 0.5) * 0.62 + (mid - 0.5) * 0.28 + (coarse - 0.5) * 0.12;
        // tooth scales deviation from the mean surface.
        this.height[i] = clamp01(0.5 + (hRaw - 0.5) * tooth * 1.6);
        // Albedo mottle is very subtle, low frequency.
        const mottle = valueNoise(x, y, 96, s4);
        this.albedo[i] = 0.948 + (mottle - 0.5) * 0.03;
      }
    }
  }

  heightAt(x: number, y: number): number {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.heightPx) return 0.5;
    return this.height[yi * this.width + xi];
  }

  albedoAt(x: number, y: number): number {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.heightPx) return 0.948;
    return this.albedo[yi * this.width + xi];
  }
}

function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ b;
  return (h ^ (h >>> 13)) >>> 0;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Deterministic RNG (xoshiro128**) + integer-hash noise.
// Every stochastic choice in V4 draws from these streams so a seed reproduces
// a drawing bit-exactly (spec §2), and paper grain never needs stored textures.

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number) {
    // splitmix32 expander so consecutive seeds decorrelate.
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  uint32(): number {
    const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.uint32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Symmetric range (-a..a). */
  sym(a: number): number {
    return (this.next() * 2 - 1) * a;
  }

  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }

  /** Approximately normal (sum of 3 uniforms), mean 0, sd 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  state(): number[] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  setState(s: number[]) {
    this.s0 = s[0] >>> 0;
    this.s1 = s[1] >>> 0;
    this.s2 = s[2] >>> 0;
    this.s3 = s[3] >>> 0;
  }

  /** Fork an independent stream (planner vs media vs motor). */
  fork(): Rng {
    return new Rng(this.uint32());
  }
}

/** 2-D integer hash noise in [0,1) — deterministic paper/tooth texture. */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth-ish value noise via bilinear hash interpolation, for grain clumps. */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    fx = x - xi,
    fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx),
    sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed),
    b = hash2(xi + 1, yi, seed),
    c = hash2(xi, yi + 1, seed),
    d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** FNV-style hash over the raw bits of a numeric array (replay/registry
 *  equality checks). Hashes float bits, so 0.3 ≠ 0. */
export function hashBytes(data: ArrayLike<number>, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  for (let i = 0; i < data.length; i++) {
    view.setFloat64(0, data[i]);
    for (let b = 0; b < 8; b += 2) h = Math.imul(h ^ view.getUint16(b), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic PRNG (xoshiro128**) with serializable state.
 * Every stochastic decision in the engine flows through an Rng instance so
 * that a run can be reproduced or restored from a checkpoint (spec §10).
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  /** Number of draws so far — used to harden checkpoint validation. */
  draws: number;
}

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  draws = 0;

  constructor(seed: number) {
    // SplitMix32 seeding — ensures well-distributed state from small seeds.
    let x = seed | 0;
    const next = () => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // Discard a few outputs to escape any low-quality initial state.
    for (let i = 0; i < 8; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.draws++;
    const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return (result >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.min(max, min + Math.floor(this.next() * (max - min + 1)));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Approximately normal noise (sum of uniforms), mean 0, sd ~1. */
  gaussian(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.4142138;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  state(): RngState {
    return { s0: this.s0, s1: this.s1, s2: this.s2, s3: this.s3, draws: this.draws };
  }

  restore(state: RngState) {
    // >>> 0 keeps the unsigned representation identical to the live stream.
    this.s0 = state.s0 >>> 0;
    this.s1 = state.s1 >>> 0;
    this.s2 = state.s2 >>> 0;
    this.s3 = state.s3 >>> 0;
    this.draws = state.draws | 0;
  }
}

/** Stable 32-bit hash for strings — used to derive seeds from metadata. */
export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mix two 32-bit integers into a well-distributed value. */
export function mixHash(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

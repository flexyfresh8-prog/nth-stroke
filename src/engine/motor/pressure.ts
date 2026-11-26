/**
 * Continuous pressure dynamics (spec §5).
 *
 * Pressure is a physical state of the hand, not an opacity value chosen per
 * stroke. It rises from first contact (attack), sustains with slow
 * modulation coupled to pen speed (fast strokes press lighter — less dwell
 * per unit length and less control), and decays before lift-off. A small
 * OU noise rides on top, so the value evolves continuously with no steps.
 */

import { clamp } from '../core/math';
import type { Rng } from '../core/rng';

export interface PressureParams {
  /** Intended steady pressure 0..1. */
  target: number;
  /** Attack ramp duration (ms). */
  attackMs: number;
  /** Release ramp duration (ms). */
  releaseMs: number;
  /** Speed at which the coupling starts reducing force (px/ms). */
  speedKnee: number;
}

export class PressureModel {
  private state = 0;
  private noise = 0;

  /** Advance the pressure state to time dt (ms) with local speed v. */
  step(dt: number, elapsedInStroke: number, strokeDuration: number, v: number, params: PressureParams, rng: Rng): number {
    // Envelope: min-jerk attack, sustained hold, min-jerk release.
    const attack = Math.min(1, elapsedInStroke / Math.max(1, params.attackMs));
    const releaseFrom = Math.max(params.attackMs, strokeDuration - params.releaseMs);
    const release = clamp((strokeDuration - elapsedInStroke) / Math.max(1, params.releaseMs), 0, 1);
    const inRelease = elapsedInStroke > releaseFrom;
    const envelope = inRelease ? release * release : (attack * attack * (3 - 2 * attack));

    // Velocity coupling: pressing hard while moving fast is hard to control.
    const speedFactor = 1 - 0.3 * clamp((v - params.speedKnee) / (params.speedKnee * 2 + 0.05), 0, 1);

    // Slow OU noise on the command.
    this.noise += (-this.noise / 90) * dt + 0.0022 * rng.gaussian() * Math.sqrt(dt);
    this.noise = clamp(this.noise, -0.07, 0.07);

    const target = clamp(params.target * speedFactor + this.noise, 0, 1);
    // Second-order-ish approach: the hand cannot change force instantly.
    const rate = dt / 26;
    this.state += (target * envelope - this.state) * clamp(rate, 0, 1);
    this.state = clamp(this.state, 0, 1);
    return this.state;
  }

  get value(): number {
    return this.state;
  }

  reset() {
    this.state = 0;
    this.noise = 0;
  }
}

/** Suggested attack/release durations for an intent (light construction
 *  strokes attack quicker; heavy tonal strokes lean in more slowly). */
export function pressureTiming(basePressure: number, rng: Rng): { attackMs: number; releaseMs: number } {
  const heavy = basePressure > 0.45;
  return {
    attackMs: (heavy ? 105 : 70) + rng.next() * 55,
    releaseMs: (heavy ? 95 : 60) + rng.next() * 45,
  };
}

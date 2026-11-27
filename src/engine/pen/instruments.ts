// V4 virtual drawing instruments (spec §12). Each instrument is a physical
// deposition model: pressure → (width, density) response curves, speed
// coupling, grain, edge softness and material tint. Changing instrument
// changes the drawing behaviour, not merely the colour.

import type { InstrumentId } from './types';

export type DepositModel = 'graphite' | 'ink' | 'eraser';

export interface Instrument {
  id: InstrumentId;
  name: string;
  model: DepositModel;
  /** Nib scale in working pixels at 1× (before canvas nib scale). */
  nib: number;
  /** Width response: w = nib·(wMin + (wMax−wMin)·p^γw). */
  wMin: number;
  wMax: number;
  gammaW: number;
  /** Density/coverage response: a = aMin + (aMax−aMin)·p^γa. */
  aMin: number;
  aMax: number;
  gammaA: number;
  /** Paper-tooth grain modulation. */
  grain: number;
  /** Kernel softness 0 (crisp) .. 1 (brushy). */
  softness: number;
  /** Speed coupling: graphite deposits more when slow; ink thins when fast. */
  speedCoupling: 'darken' | 'thin' | 'none';
  speedRef: number;
  speedAmount: number;
  /** Extra touch-down blot (dip pens / brush). */
  blot: number;
  /** Per-channel density gains — graphite reads cool, charcoal warm. */
  tint: [number, number, number];
  /** Overall density gain. */
  gain: number;
  /** Eraser efficiencies. */
  eraseGraphite: number;
  eraseInk: number;
  /** Tilt widening (side-of-tip contact) for soft instruments. */
  tiltWiden: number;
}

const def = (o: Partial<Instrument> & Pick<Instrument, 'id' | 'name' | 'model'>): Instrument => ({
  nib: 1.5,
  wMin: 0.45,
  wMax: 2.6,
  gammaW: 0.85,
  aMin: 0.16,
  aMax: 0.62,
  gammaA: 1.1,
  grain: 0.3,
  softness: 0.5,
  speedCoupling: 'darken',
  speedRef: 110,
  speedAmount: 0.8,
  blot: 0,
  tint: [0.95, 0.97, 1.05],
  gain: 1,
  eraseGraphite: 0,
  eraseInk: 0,
  tiltWiden: 0,
  ...o,
});

export const instruments: Record<InstrumentId, Instrument> = {
  // Classic wooden pencil: soft edges, grain, multiplicative density buildup.
  graphite: def({
    id: 'graphite',
    name: 'Graphite pencil',
    model: 'graphite',
    nib: 1.5,
    wMin: 0.5,
    wMax: 2.6,
    gammaW: 0.85,
    aMin: 0.15,
    aMax: 0.6,
    grain: 0.36,
    softness: 0.52,
  }),
  // Hard thin lead: precise construction, low grain, crisp.
  mechanical: def({
    id: 'mechanical',
    name: 'Mechanical pencil',
    model: 'graphite',
    nib: 0.95,
    wMin: 0.42,
    wMax: 1.2,
    gammaW: 0.65,
    aMin: 0.2,
    aMax: 0.5,
    gammaA: 0.9,
    grain: 0.16,
    softness: 0.22,
    speedAmount: 0.45,
  }),
  // Technical pen: near-constant width, full ink coverage, crisp edge.
  fineliner: def({
    id: 'fineliner',
    name: 'Fine liner',
    model: 'ink',
    nib: 0.9,
    wMin: 0.8,
    wMax: 1.06,
    gammaW: 0.45,
    aMin: 0.78,
    aMax: 0.94,
    gammaA: 0.55,
    grain: 0.04,
    softness: 0.1,
    speedCoupling: 'thin',
    speedRef: 260,
    speedAmount: 0.1,
    tint: [1, 1, 1.08],
  }),
  // Manga G-pen: strong pressure response, taper, slight speed thinning.
  dip: def({
    id: 'dip',
    name: 'Manga dip pen',
    model: 'ink',
    nib: 0.85,
    wMin: 0.26,
    wMax: 2.9,
    gammaW: 1.35,
    aMin: 0.5,
    aMax: 0.95,
    gammaA: 1.15,
    grain: 0.07,
    softness: 0.16,
    speedCoupling: 'thin',
    speedRef: 220,
    speedAmount: 0.22,
    blot: 0.4,
    tint: [1, 1, 1.06],
  }),
  // Brush pen: broad, wet, big taper, blot at touch-down.
  brush: def({
    id: 'brush',
    name: 'Brush pen',
    model: 'ink',
    nib: 1.7,
    wMin: 0.4,
    wMax: 4.8,
    gammaW: 1.5,
    aMin: 0.42,
    aMax: 0.95,
    gammaA: 1.25,
    grain: 0.06,
    softness: 0.24,
    speedCoupling: 'thin',
    speedRef: 300,
    speedAmount: 0.3,
    blot: 0.55,
    tiltWiden: 0.35,
    tint: [1, 1, 1.05],
  }),
  // Charcoal: wide, grainy, very soft edges, lighter ceiling.
  charcoal: def({
    id: 'charcoal',
    name: 'Charcoal',
    model: 'graphite',
    nib: 3.4,
    wMin: 1.1,
    wMax: 6.8,
    gammaW: 0.8,
    aMin: 0.2,
    aMax: 0.52,
    gammaA: 1.0,
    grain: 0.55,
    softness: 0.88,
    speedAmount: 0.65,
    tint: [1.07, 1.0, 0.93],
    gain: 0.92,
    tiltWiden: 0.5,
  }),
  // Eraser: removes graphite strongly, ink weakly, width grows with pressure.
  eraser: def({
    id: 'eraser',
    name: 'Eraser',
    model: 'eraser',
    nib: 5.2,
    wMin: 0.35,
    wMax: 0.95,
    gammaW: 0.7,
    aMin: 0,
    aMax: 0,
    grain: 0,
    softness: 0.75,
    speedCoupling: 'none',
    eraseGraphite: 0.95,
    eraseInk: 0.16,
  }),
};

export interface StampParams {
  /** Half-width in px. */
  r: number;
  /** Deposit amount (density for graphite, coverage alpha for ink). */
  a: number;
  /** Kernel σ multiplier. */
  sigma: number;
  /** Grain amount 0..1. */
  grain: number;
}

/**
 * Physical nib response at one instant.
 * @param p      pressure 0..1
 * @param v      pen speed px/s
 * @param tilt   0..1
 * @param side   |cos(azimuth − motion direction)| — side-of-tip contact
 */
export function stampParams(
  inst: Instrument,
  p: number,
  v: number,
  tilt: number,
  side: number,
): StampParams {
  const pr = Math.max(0, Math.min(1, p));
  if (inst.model === 'eraser') {
    // Eraser pressure mostly controls width; removal strength per stamp.
    return { r: (inst.nib * (inst.wMin + (inst.wMax - inst.wMin) * Math.pow(pr, inst.gammaW))) / 2, a: pr, sigma: 0.55 + inst.softness * 0.4, grain: 0 };
  }
  let w = inst.nib * (inst.wMin + (inst.wMax - inst.wMin) * Math.pow(pr, inst.gammaW));
  let a = inst.aMin + (inst.aMax - inst.aMin) * Math.pow(pr, inst.gammaA);
  // Speed coupling — the physical signature of each medium.
  if (inst.speedCoupling === 'darken') a *= 1 / (1 + inst.speedAmount * Math.min(2.5, v / inst.speedRef));
  else if (inst.speedCoupling === 'thin') {
    w *= 1 - inst.speedAmount * 0.5 * Math.min(1, v / inst.speedRef);
    a *= 1 - inst.speedAmount * 0.25 * Math.min(1, v / inst.speedRef);
  }
  // Tilt widens soft instruments when the shaft leans across the motion.
  w *= 1 + inst.tiltWiden * tilt * 0.6 * side;
  // Higher pressure → larger contact patch → softer edge.
  const sigma = 0.4 + inst.softness * (0.35 + 0.4 * pr);
  return { r: w / 2, a: a * inst.gain, sigma, grain: inst.grain };
}

/** Touch-down blot size (dip/brush ink pooling), 0 when none. */
export function blotAmount(inst: Instrument, p: number): number {
  return inst.blot * (0.35 + 0.65 * p);
}

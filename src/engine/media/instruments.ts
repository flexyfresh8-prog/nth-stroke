/**
 * Physical instrument definitions (spec §6). Each instrument is a distinct
 * physical tool — differing in hardness, darkness, saturation limit, grain
 * response, footprint shape, friction and wear — not just size/opacity.
 */

import type { InstrumentClass, InstrumentId } from '../core/types';

export interface InstrumentSpec {
  id: InstrumentId;
  label: string;
  class: InstrumentClass;
  /** Base tip radius in px at zero pressure. */
  baseRadius: number;
  /** Additional radius at full pressure (tip compression). */
  pressureRadius: number;
  /** Deposited darkness per unit length at full force (pencils/charcoal). */
  darkness: number;
  /** Saturation ceiling — maximum density this material reaches on paper. */
  saturation: number;
  /** 0..1 — higher = crisper, skips low grain spots (hard pencil). */
  hardness: number;
  /** Base friction multiplier (affects deposit per unit length). */
  friction: number;
  /** Footprint falloff exponent — higher = harder edge. */
  edge: number;
  /** How strongly the tip wears wider with drawn distance (px width growth). */
  wearRate: number;
  /** Distance drawn before a re-sharpen is sensible (px). */
  sharpenInterval: number;
  /** Graphite smearing when passing over existing marks (0..1). */
  smear: number;
  /** Blender: blending strength at full pressure. */
  blend?: number;
  /** Eraser: maximum lift fraction at full pressure. */
  lift?: number;
  /** Natural drawing speed (px/ms) for this tool. */
  naturalSpeed: number;
  /** Motor gain — coarse tools move slightly slower. */
  speedGain: number;
}

const pencil = (id: InstrumentId, label: string, hardness: number, darkness: number, saturation: number, rank: number): InstrumentSpec => ({
  id,
  label,
  class: 'pencil',
  baseRadius: 0.95 + rank * 0.06,
  pressureRadius: 0.75 + rank * 0.08,
  darkness,
  saturation,
  hardness,
  friction: 0.9 - rank * 0.04,
  edge: 2.1 - rank * 0.12,
  wearRate: 0.05 + rank * 0.03,
  sharpenInterval: 9000 + rank * 2500,
  smear: 0.02 + rank * 0.05,
  naturalSpeed: 0.42 - rank * 0.03,
  speedGain: 1,
});

export const INSTRUMENTS: Record<InstrumentId, InstrumentSpec> = {
  'pencil-2h': pencil('pencil-2h', '2H pencil', 0.92, 0.3, 0.42, 0),
  'pencil-hb': pencil('pencil-hb', 'HB pencil', 0.78, 0.5, 0.6, 1),
  'pencil-2b': pencil('pencil-2b', '2B pencil', 0.62, 0.72, 0.82, 2),
  'pencil-4b': pencil('pencil-4b', '4B pencil', 0.46, 0.98, 1.12, 3),
  // 6B and charcoal ceilings lowered (was 1.42 / 1.62): at k=2.6 those
  // densities composite to ~2% of paper brightness, i.e. flat black masses.
  'pencil-6b': pencil('pencil-6b', '6B pencil', 0.32, 1.28, 1.3, 4),
  mechanical: {
    id: 'mechanical',
    label: 'Mechanical 0.5',
    class: 'pencil',
    baseRadius: 0.62,
    pressureRadius: 0.3,
    darkness: 0.58,
    saturation: 0.58,
    hardness: 0.85,
    friction: 0.82,
    edge: 2.4,
    wearRate: 0,
    sharpenInterval: Infinity,
    smear: 0.03,
    naturalSpeed: 0.5,
    speedGain: 1.05,
  },
  charcoal: {
    id: 'charcoal',
    label: 'Charcoal',
    class: 'charcoal',
    // Smaller footprint and lower deposit per pass (was 3.4 / 3.8 / 1.42):
    // masses now build up over several layers instead of one blob-like pass.
    baseRadius: 2.4,
    pressureRadius: 2.6,
    darkness: 1.05,
    saturation: 1.45,
    hardness: 0.14,
    friction: 1.1,
    edge: 1.0,
    wearRate: 0.16,
    sharpenInterval: 14000,
    smear: 0.32,
    naturalSpeed: 0.34,
    speedGain: 0.8,
  },
  stump: {
    id: 'stump',
    label: 'Blending stump',
    class: 'blender',
    baseRadius: 4.6,
    pressureRadius: 1.6,
    darkness: 0,
    saturation: 0,
    hardness: 0.2,
    friction: 0.4,
    edge: 1.4,
    wearRate: 0,
    sharpenInterval: Infinity,
    smear: 0,
    blend: 0.38,
    naturalSpeed: 0.3,
    speedGain: 0.75,
  },
  'eraser-kneaded': {
    id: 'eraser-kneaded',
    label: 'Kneaded eraser',
    class: 'eraser',
    baseRadius: 5.6,
    pressureRadius: 1.8,
    darkness: 0,
    saturation: 0,
    hardness: 0.3,
    friction: 0.3,
    edge: 1.3,
    wearRate: 0,
    sharpenInterval: Infinity,
    smear: 0,
    lift: 0.62,
    naturalSpeed: 0.55,
    speedGain: 1.15,
  },
  'eraser-precision': {
    id: 'eraser-precision',
    label: 'Precision eraser',
    class: 'eraser',
    baseRadius: 1.7,
    pressureRadius: 0.7,
    darkness: 0,
    saturation: 0,
    hardness: 0.6,
    friction: 0.3,
    edge: 2.6,
    wearRate: 0,
    sharpenInterval: Infinity,
    smear: 0,
    lift: 0.92,
    naturalSpeed: 0.4,
    speedGain: 0.9,
  },
};

export function instrument(id: InstrumentId): InstrumentSpec {
  return INSTRUMENTS[id];
}

/** Effective tip width (full diameter, px) at a pressure, accounting for
 *  broad side-of-tip contact — used by planners to pick hatch spacing. */
export function effectiveTipWidth(spec: InstrumentSpec, pressure: number, broad: boolean): number {
  const r = spec.baseRadius + pressure * spec.pressureRadius;
  return 2 * r * (broad ? 2.1 : 1);
}

/** Pick a pencil by required tone depth (used by the planner). */
export function pencilForTone(targetDensity: number, fidelity: number): InstrumentId {
  if (targetDensity < 0.16) return 'pencil-2h';
  if (targetDensity < 0.3) return fidelity > 0.75 ? 'pencil-hb' : 'pencil-2h';
  if (targetDensity < 0.5) return 'pencil-hb';
  if (targetDensity < 0.75) return 'pencil-2b';
  if (targetDensity < 1.05) return 'pencil-4b';
  return 'pencil-6b';
}

// NTH Stroke V5 — option presets. V5 is the V4 virtual-pen artist plus a
// "human" motor layer (physiological tremor, slow drift, tilt wander) and a
// tuning aimed at fidelity. `human` = 0 reproduces V4 exactly.
import { v4Balanced, v4Presets, type SimOptions } from './types';

export type HumanOptions = Partial<SimOptions> & { human?: number };

export const v5Human: SimOptions & { human: number } = {
  ...v4Balanced,
  preset: 'Human',
  resolution: 1400,
  budget: 20000,
  sensitivity: 0.8,
  continuity: 0.78,
  pressure: 0.72,
  shade: 0.95,
  hatch: 0.7,
  detail: 0.9,
  lineworkTool: 'graphite',
  motor: 1,
  human: 0.8,
};

export const v5Presets: Record<string, HumanOptions> = {
  Fast: { ...v4Presets.Fast, human: 0.6 },
  Human: { ...v5Human },
  Illustrator: { ...v4Presets.Illustrator, shade: 0.95, detail: 0.95, lineworkTool: 'graphite', motor: 1, human: 0.8 },
  Extreme: { ...v4Presets.Extreme, shade: 1, lineworkTool: 'graphite', motor: 1, human: 0.9 },
};

export function humanAmount(o: SimOptions): number {
  const h = (o as { human?: number }).human;
  return typeof h === 'number' && Number.isFinite(h) ? Math.max(0, Math.min(1, h)) : 0;
}

export function withHuman(o: SimOptions, human: number): SimOptions {
  return { ...o, human } as SimOptions;
}

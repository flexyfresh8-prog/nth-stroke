export const stages = [
  'Subject isolation',
  'Structural construction',
  'Primary outlines',
  'Secondary linework',
  'Shading',
  'Fine details',
  'Error correction',
  'Final optimization',
] as const;
export const layers = ['Construction', 'Subject', 'Background', 'Tones', 'Details'] as const;
export type Layer = (typeof layers)[number];
export interface Options {
  seed: number;
  budget: number;
  resolution: number;
  construction: number;
  sensitivity: number;
  continuity: number;
  pressure: number;
  shade: number;
  hatch: number;
  detail: number;
  segmentation: number;
  iterations: number;
  performance: 'Compact' | 'Standard';
  preset: string;
}
export const balanced: Options = {
  preset: 'Balanced',
  seed: 20260101,
  budget: 24000,
  resolution: 2048,
  construction: 0.55,
  sensitivity: 0.65,
  continuity: 0.75,
  pressure: 0.6,
  shade: 0.86,
  hatch: 0.52,
  detail: 0.72,
  segmentation: 0.55,
  iterations: 2,
  performance: 'Standard',
};
export const presets: Record<string, Options> = Object.fromEntries(
  Object.entries({
    Fast: { budget: 2000, resolution: 512, iterations: 1, detail: 0.35 },
    Balanced: {},
    Illustrator: { budget: 85000, resolution: 4096, detail: 0.9, iterations: 3 },
    Extreme: { budget: 1000000, resolution: 16384, detail: 1, iterations: 5 },
  }).map(([name, values]) => [name, { ...balanced, ...values, preset: name }]),
);
export type Hint = { x: number; y: number; subject: boolean };

export function normalize(input: Partial<Options>): Options {
  const options = { ...balanced, ...input };
  const number = (value: number, min: number, max: number, defaultValue: number) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaultValue;
  for (const key of [
    'construction',
    'sensitivity',
    'continuity',
    'pressure',
    'shade',
    'hatch',
    'detail',
    'segmentation',
  ] as const) {
    options[key] = number(options[key], 0, 1, balanced[key]);
  }
  options.budget = Math.round(number(options.budget, 1000, 1000000, balanced.budget));
  options.resolution = Math.round(number(options.resolution, 128, 16384, balanced.resolution));
  options.iterations = Math.round(number(options.iterations, 0, 10, balanced.iterations));
  options.seed = options.seed >>> 0;
  return options;
}

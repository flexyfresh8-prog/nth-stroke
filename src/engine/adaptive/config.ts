import type { EngineConfig } from '../core/types';

export const PRESETS = [
  'Automatic',
  'Graphite portrait',
  'Manga',
  'Anime illustration',
  'Photorealistic graphite',
  'Landscape',
  'Technical sketch',
  'Charcoal',
  'Line art',
] as const;
export type Preset = (typeof PRESETS)[number];
export interface AdaptiveSettings {
  preset: Preset;
  automatic: boolean;
  maxSeconds: number;
  performance?: 'auto' | 'compact' | 'quality';
  structure: number;
  tone: number;
  features: number;
  naturalness: number;
  correction: number;
  pressure: number;
  convergence: number;
}
export const ADAPTIVE_DEFAULTS: AdaptiveSettings = {
  preset: 'Automatic',
  automatic: true,
  maxSeconds: 0,
  structure: 0.78,
  tone: 0.66,
  features: 0.76,
  naturalness: 0.65,
  correction: 0.68,
  pressure: 0.75,
  convergence: 0.45,
};
export interface AdaptiveConfig extends EngineConfig {
  adaptive?: Partial<AdaptiveSettings>;
}
export const PRESET_TUNING: Record<Preset, Partial<AdaptiveSettings>> = {
  Automatic: {},
  'Graphite portrait': { structure: 0.79, tone: 0.84, features: 0.94, naturalness: 0.83 },
  Manga: { structure: 0.97, tone: 0.59, features: 1, naturalness: 0.58 },
  'Anime illustration': { structure: 0.89, tone: 0.69, features: 0.92 },
  'Photorealistic graphite': { tone: 0.94, features: 0.9, naturalness: 0.58 },
  Landscape: { structure: 0.63, tone: 0.84, naturalness: 0.84 },
  'Technical sketch': { structure: 1, tone: 0.55, naturalness: 0.24 },
  Charcoal: { tone: 0.91, naturalness: 0.75 },
  'Line art': { structure: 1, tone: 0.45, features: 0.95, naturalness: 0.38 },
};

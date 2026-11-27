// NTH Stroke V4 — shared types.
// V4 is an autonomous virtual pen artist: a Virtual Eye observes the reference,
// a Virtual Brain plans, a Virtual Hand drives a Virtual Pen through physical
// motion, and the Virtual Canvas is only ever modified through pen contact.

export type P = [number, number];
export type Box = [number, number, number, number];

export type InstrumentId =
  | 'graphite'
  | 'mechanical'
  | 'fineliner'
  | 'dip'
  | 'brush'
  | 'charcoal'
  | 'eraser';

export type LayerId =
  | 'gesture'
  | 'construction'
  | 'sketch'
  | 'line'
  | 'tone'
  | 'detail'
  | 'erasure';

export const instrumentNames: Record<InstrumentId, string> = {
  graphite: 'Graphite pencil',
  mechanical: 'Mechanical pencil',
  fineliner: 'Fine liner',
  dip: 'Manga dip pen',
  brush: 'Brush pen',
  charcoal: 'Charcoal',
  eraser: 'Eraser',
};

/** The human drawing workflow, spec §9 (stages A–H). */
export const stageNames = [
  'Observation',
  'Gesture',
  'Construction',
  'Exploratory sketch',
  'Confident linework',
  'Shading',
  'Detail refinement',
  'Correction',
] as const;
export type StageIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface SimOptions {
  preset: string;
  seed: number;
  /** Simulation frequency in Hz — 120, 180 or 240 (spec §4). */
  frequency: 120 | 180 | 240;
  /** Working-canvas long edge; the reference may be far larger (16K). */
  resolution: number;
  /** Total stroke budget. */
  budget: number;
  /** 0..1 artistic knobs. */
  gesture: number;
  construction: number;
  sensitivity: number;
  continuity: number;
  pressure: number;
  shade: number;
  hatch: number;
  detail: number;
  /** Instrument used for confident linework. */
  lineworkTool: 'fineliner' | 'dip' | 'brush' | 'graphite';
  /** Motor fidelity: gain on corrective submovements and curvature slowdown. */
  motor: number;
  /** Pen-event recorder capacity in samples; 0 disables recording. */
  maxEvents: number;
}

export const v4Balanced: SimOptions = {
  preset: 'Balanced',
  seed: 20260101,
  frequency: 240,
  resolution: 1024,
  budget: 6000,
  gesture: 0.6,
  construction: 0.55,
  sensitivity: 0.62,
  continuity: 0.7,
  pressure: 0.6,
  shade: 0.85,
  hatch: 0.55,
  detail: 0.7,
  lineworkTool: 'fineliner',
  motor: 0.8,
  maxEvents: 8_000_000,
};

export const v4Presets: Record<string, Partial<SimOptions>> = {
  Fast: { frequency: 120, resolution: 512, budget: 900, detail: 0.35, motor: 0.55 },
  Balanced: {},
  Illustrator: { resolution: 1792, budget: 60_000, detail: 0.9, frequency: 240 },
  Extreme: { resolution: 2048, budget: 1_000_000, detail: 1, frequency: 240, maxEvents: 40_000_000 },
};

export function normalizeV4(input: Partial<SimOptions>): SimOptions {
  const o = { ...v4Balanced, ...input };
  const clamp01 = (v: number, d: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  for (const key of [
    'gesture',
    'construction',
    'sensitivity',
    'continuity',
    'pressure',
    'shade',
    'hatch',
    'detail',
    'motor',
  ] as const)
    o[key] = clamp01(o[key], v4Balanced[key]);
  o.budget = Math.round(Math.max(50, Math.min(1_000_000, o.budget)));
  o.resolution = Math.round(Math.max(256, Math.min(2048, o.resolution)));
  o.frequency = (o.frequency === 120 || o.frequency === 180 ? o.frequency : 240) as SimOptions['frequency'];
  o.maxEvents = Math.max(0, Math.round(o.maxEvents));
  o.seed = o.seed >>> 0;
  if (!['fineliner', 'dip', 'brush', 'graphite'].includes(o.lineworkTool)) o.lineworkTool = 'fineliner';
  return o;
}

// ---------------------------------------------------------------------------
// Brain → hand communication: a stroke plan is an artistic intention expressed
// as a physical path plus motor parameters. The hand owns the dynamics.
// ---------------------------------------------------------------------------

export interface PressureIntent {
  /** Entry pressure at touch-down. */
  entry: number;
  /** Sustained level. */
  level: number;
  /** Exit pressure at lift-off. */
  exit: number;
  /** Attack/release as fraction of stroke length (0 = instant). */
  attack: number;
  release: number;
}

export interface StrokePlan {
  id: number;
  /** Flat path [x0,y0,x1,y1,…], arc-length parameterised. */
  pts: Float32Array;
  baseSpeed: number;
  /** Curvature slowdown 2/3-power-law exponent weight (0 = none). */
  powerLaw: number;
  /** Lognormal speed shaping strength 0..1. */
  lognormal: number;
  pressure: PressureIntent;
  instrument: InstrumentId;
  layer: LayerId;
  importance: number;
  confidence: number;
  /** Nib scale multiplier. */
  nib: number;
  /** Task label for the debug channel. */
  task: string;
  reason: string;
}

export type Attention = { x: number; y: number; w: number; h: number };

export interface Decision {
  t: number;
  stage: number;
  action: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Telemetry streamed to the UI (~every tick).
// ---------------------------------------------------------------------------

export interface PenPose {
  x: number;
  y: number;
  z: number;
  contact: boolean;
  down: boolean;
  pressure: number;
  speed: number;
  direction: number;
  tilt: number;
  azimuth: number;
  instrument: InstrumentId;
}

export interface Quality {
  ssim: number;
  mae: number;
  edge: number;
  missing: number;
  excess: number;
}

export interface Telemetry {
  pose: PenPose;
  stage: number;
  stageLabel: string;
  objective: string;
  attention: Attention | null;
  instrument: InstrumentId;
  strokes: number;
  lifts: number;
  travel: number;
  drawn: number;
  simTime: number;
  steps: number;
  quality: Quality | null;
  decisions: Decision[];
  /** Rolling pressure history for the live graph, sampled ~30 Hz. */
  pressureHistory: Float32Array;
  pressureCount: number;
  phase: string;
}

// ---------------------------------------------------------------------------
// Worker protocol. The worker owns the simulation and pushes incremental
// dirty tiles + telemetry; the main thread never simulates (except fallback).
// ---------------------------------------------------------------------------

export type ToWorker =
  | { type: 'open'; file: Blob }
  | { type: 'start'; options: SimOptions; skip?: SerializedResume }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'speed'; value: number }
  | {
      type: 'export';
      kind: 'svg' | 'strokes' | 'events' | 'replay' | 'project' | 'rgba' | 'rgba-transparent';
    };

export interface TileUpdate {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
}

export type FromWorker =
  | { type: 'ready'; w: number; h: number; work: number; preview: Uint8Array; pw: number; ph: number }
  | { type: 'analysis'; phase: string; progress: number }
  | { type: 'tiles'; w: number; h: number; tiles: TileUpdate[] }
  | { type: 'telemetry'; telemetry: Telemetry }
  | { type: 'done'; quality: Quality | null }
  | { type: 'stopped' }
  | { type: 'export'; kind: string; name: string; mime: string; data: ArrayBuffer | string }
  | { type: 'error'; message: string };

/** Serialized resumable state (project files and in-session restarts). */
export interface SerializedResume {
  options: SimOptions;
  stage: number;
  graphite: Float32Array;
  ink: Float32Array;
  registry: SerializedStroke[];
  recorder: SerializedRecorder | null;
  rng: number[];
  simTime: number;
  steps: number;
  strokes: number;
  lifts: number;
  travel: number;
  drawn: number;
  /** Stroke plans not yet executed (hand queue + stage queue). */
  pending: StrokePlan[];
  planId: number;
  pen: { x: number; y: number; z: number; instrument: InstrumentId; travel: number; travelAir: number };
  brainMemory: {
    completedContours: number[];
    hatchPasses: Record<string, number>;
    detailCursor: number;
    componentCursor: number;
    stageEntry: number[];
    formShaded: boolean;
    guidesErased: boolean;
    correctionRounds: number;
  };
  complete: boolean;
}

export interface SerializedStroke {
  instrument: InstrumentId;
  layer: LayerId;
  stage: number;
  importance: number;
  opacity: number;
  pts: Float32Array;
  length: number;
}

export interface SerializedRecorder {
  count: number;
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  p: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  tilt: Float32Array;
  azimuth: Float32Array;
  dir: Float32Array;
  meta: Uint8Array;
  inst: Uint8Array;
}

import type { EngineConfig, EngineSnapshot, InstrumentId, StylusSample } from '../core/types';
import type { Rect } from '../media/graphite';
import type { SessionRecorder } from '../session/recorder';

export type EngineId = 'v1' | 'v2';
export interface DrawingRuntime {
  config: EngineConfig;
  session: SessionRecorder;
  paper: { albedo: Float32Array };
  map: {
    width: number;
    height: number;
    compositeRect(
      paper: Float32Array,
      out: Uint8ClampedArray,
      rect: Rect,
      size: { width: number; height: number },
      stride: number,
    ): void;
  };
  running: boolean;
  done: boolean;
  busy: boolean;
  simTime: number;
  userEditedSinceEval: boolean;
  start(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  advance(target: number): void;
  runOps(count: number, ms?: number): void;
  evaluate(): unknown;
  injectUserStroke(samples: StylusSample[], instrument: InstrumentId): void;
  checkpoint(): unknown;
  snapshot(): EngineSnapshot;
}

/**
 * UI ⇄ engine-worker message protocol (spec §11, §13).
 * The worker owns the canvas (transferred OffscreenCanvas) and the whole
 * engine; the React UI is a thin shell that sends commands and renders
 * snapshots.
 */

import type { EngineId } from '../control/contract';
import type { AdaptiveConfig } from '../adaptive/config';
import type { MapName } from '../adaptive/diagnostics';
import type { Accuracy } from '../adaptive/metrics';
import type { EngineSnapshot, InstrumentId, Stage, StylusSample } from '../core/types';

export type PlaybackSpeed = 0.25 | 0.5 | 1 | 2 | 5 | 10 | 50 | 'max';

export type ToWorker =
  | { type: 'init'; canvas?: OffscreenCanvas; width: number; height: number; basePath: string }
  | { type: 'load'; bitmap: ImageBitmap; pixels?: ImageData; id: number; engine: EngineId; analysisMax?: number; config: Partial<AdaptiveConfig>; referenceDataUrl: string; referenceWidth: number; referenceHeight: number }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'restart' }
  | { type: 'speed'; value: PlaybackSpeed }
  | { type: 'user-stroke'; samples: StylusSample[]; instrument: InstrumentId }
  | { type: 'export'; kind: 'svg' | 'png' | 'jpeg' | 'webp' | 'session' | 'project'; quality?: number }
  | { type: 'checkpoint' }
  | { type: 'refine' }
  | { type: 'replay' }
  | { type: 'seek'; position: number }
  | { type: 'diagnostic'; view: MapName }
  | { type: 'benchmark'; budget: number; config: Partial<AdaptiveConfig> }
  | { type: 'stop-benchmark' }
  | { type: 'restore'; project: unknown; engine: EngineId; bitmap: ImageBitmap; pixels?: ImageData; id: number };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'analysis'; phase: string; progress: number }
  | { type: 'scene'; summary: string[]; width: number; height: number; models: string[]; seed: number }
  | { type: 'snapshot'; data: EngineSnapshot }
  | { type: 'stage'; stage: Stage; reason?: string }
  | { type: 'correction'; reason: string; t: number }
  | { type: 'export-result'; kind: string; blob?: Blob; text?: string; filename: string }
  | { type: 'error'; message: string }
  | { type: 'restored'; summary: string[] }
  | { type: 'patch'; image: ImageData; x:number; y:number; width:number; height:number }
  | { type: 'capture'; kind:'png'|'jpeg'|'webp'; filename:string; quality?:number }
  | { type: 'diagnostic'; view:MapName; rgba:Uint8ClampedArray; width:number; height:number; info: DiagnosticInfo }
  | { type: 'benchmark-status'; value:string }
  | { type: 'benchmark-result'; results:BenchmarkResult[] };

export interface DiagnosticInfo {
  accuracy: Accuracy|null;
  history: Array<{strokes:number;ms:number;ssim:number}>;
  stage: Stage;
  instrument: InstrumentId|null;
  region: {x:number;y:number;w:number;h:number}|null;
  total:number;
  trials: Array<{instrument:InstrumentId;gain:number}>;
}
export interface BenchmarkResult {
  engine: EngineId; accuracy: Accuracy; count:number; corrections:number; computeMs:number;
  memory:number|null; rgba:Uint8ClampedArray; width:number; height:number;
  history:Array<{strokes:number;ms:number;ssim:number}>;
  stages?: Array<{stage:Stage; rgba:Uint8ClampedArray}>;
}

export const SPEED_STEPS: PlaybackSpeed[] = [0.25, 0.5, 1, 2, 5, 10, 50, 'max'];

/** Convert a project dataUrl to an ImageBitmap (main-thread helper). */
export async function bitmapFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

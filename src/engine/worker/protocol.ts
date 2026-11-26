/**
 * UI ⇄ engine-worker message protocol (spec §11, §13).
 * The worker owns the canvas (transferred OffscreenCanvas) and the whole
 * engine; the React UI is a thin shell that sends commands and renders
 * snapshots.
 */

import type { EngineConfig, EngineSnapshot, InstrumentId, Stage, StylusSample } from '../core/types';

export type PlaybackSpeed = 0.25 | 0.5 | 1 | 2 | 5 | 10 | 50 | 'max';

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; basePath: string }
  | { type: 'load'; bitmap: ImageBitmap; config: Partial<EngineConfig>; referenceDataUrl: string; referenceWidth: number; referenceHeight: number }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'restart' }
  | { type: 'speed'; value: PlaybackSpeed }
  | { type: 'user-stroke'; samples: StylusSample[]; instrument: InstrumentId }
  | { type: 'export'; kind: 'svg' | 'png' | 'jpeg' | 'webp' | 'session' | 'project'; quality?: number }
  | { type: 'checkpoint' }
  | { type: 'restore'; project: unknown; bitmap: ImageBitmap };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'analysis'; phase: string; progress: number }
  | { type: 'scene'; summary: string[]; width: number; height: number; models: string[]; seed: number }
  | { type: 'snapshot'; data: EngineSnapshot }
  | { type: 'stage'; stage: Stage; reason?: string }
  | { type: 'correction'; reason: string; t: number }
  | { type: 'export-result'; kind: string; blob?: Blob; text?: string; filename: string }
  | { type: 'error'; message: string }
  | { type: 'restored'; summary: string[] };

export const SPEED_STEPS: PlaybackSpeed[] = [0.25, 0.5, 1, 2, 5, 10, 50, 'max'];

/** Convert a project dataUrl to an ImageBitmap (main-thread helper). */
export async function bitmapFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

/**
 * Browser ML provider: bundled MediaPipe Tasks Vision models running fully
 * locally (spec §3). Models live in /models (repo-bundled, ~12 MB), the
 * WASM runtime in /mediapipe/wasm — no network calls after load. The CPU
 * delegate is used for deterministic inference. Every failure degrades
 * gracefully: null results fall back to classical-only analysis.
 */

import {
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
  PoseLandmarker,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision';
import type {
  FaceObservation,
  MlProvider,
  PoseObservation,
  SegmentationObservation,
} from './provider';
import type { ImageLike } from './provider';
import type { Vec2 } from '../core/types';

const DEEPLAB_CLASSES = 21; // background + 20 object classes

export class BrowserMlProvider implements MlProvider {
  private faceModel: FaceLandmarker | null = null;
  private poseModel: PoseLandmarker | null = null;
  private segModel: ImageSegmenter | null = null;
  private loading: Promise<void> = Promise.resolve();
  private readonly attempted = new Set<'face'|'pose'|'segmentation'>();

  constructor(
    private readonly basePath: string,
    private readonly onStatus?: (message: string) => void,
  ) {}

  /** Serialize model initialization because the WASM glue uses a shared factory. */
  ensureLoaded(selection: 'face' | 'all' = 'all'): Promise<void> {
    this.loading = this.loading.then(async () => {
      const kinds = selection === 'face' ? ['face'] as const : ['face', 'pose', 'segmentation'] as const;
      if (kinds.every(kind => this.attempted.has(kind))) return;
      const inWorker = typeof document === 'undefined';
      const worker = globalThis as typeof globalThis & { importScripts?: (...urls: string[]) => void };
      let moduleWorker = false;
      if (inWorker) {
        try { worker.importScripts?.(); }
        catch { moduleWorker = true; }
      }
      const assets = new URL(`${this.basePath}/`, globalThis.location.origin);
      if (moduleWorker) {
        // The MediaPipe loader clears ModuleFactory after initializing a graph.
        // ESM imports are cached, so restore the module's exported factory on
        // each load rather than depending on its first-load side effects.
        const host = globalThis as typeof globalThis & {
          import?: (url: string) => Promise<unknown>;
          ModuleFactory?: unknown;
        };
        host.import ??= async (url) => {
          const module = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
          host.ModuleFactory = module.default;
        };
      }
      const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', assets).href, moduleWorker);
      for (const kind of kinds) {
        if (this.attempted.has(kind)) continue;
        this.attempted.add(kind);
        try {
          if (kind === 'face') this.faceModel = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', assets).href, delegate: 'CPU' },
            runningMode: 'IMAGE', numFaces: 1,
          });
          else if (kind === 'pose') this.poseModel = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: new URL('models/pose_landmarker_lite.task', assets).href, delegate: 'CPU' },
            runningMode: 'IMAGE', numPoses: 1,
          });
          else this.segModel = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: new URL('models/deeplab_v3.tflite', assets).href, delegate: 'CPU' },
            runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false,
          });
        } catch {
          // Geometry-only analysis remains available if this browser cannot
          // initialize the model's graphics and WASM runtime.
        }
      }
      const loaded = [this.faceModel, this.poseModel, this.segModel].filter(Boolean).length;
      this.onStatus?.(`vision models ready (${loaded}/3)`);
    }).catch(() => this.onStatus?.('vision models unavailable — classical analysis only'));
    return this.loading;
  }

  private toCanvas(input: ImageLike): OffscreenCanvas | HTMLCanvasElement {
    const w = 'width' in input ? input.width : 512;
    const h = 'height' in input ? input.height : 512;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(input as CanvasImageSource, 0, 0);
      return c;
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(input as CanvasImageSource, 0, 0);
    return c;
  }

  async face(input: ImageLike): Promise<FaceObservation | null> {
    try {
      if (!this.faceModel) return null;
      const result = this.faceModel.detect(this.toCanvas(input));
      if (!result.faceLandmarks || result.faceLandmarks.length === 0) return null;
      const lm = result.faceLandmarks[0];
      const landmarks: Vec2[] = lm.map((p) => ({ x: p.x, y: p.y }));
      return { landmarks, score: 1 };
    } catch {
      return null;
    }
  }

  async pose(input: ImageLike): Promise<PoseObservation | null> {
    try {
      if (!this.poseModel) return null;
      const result = this.poseModel.detect(this.toCanvas(input));
      if (!result.landmarks || result.landmarks.length === 0) return null;
      const lm = result.landmarks[0];
      if (lm.length < 33) return null;
      const landmarks: Vec2[] = lm.map((p) => ({ x: p.x, y: p.y }));
      const visible = lm.filter((p) => p.visibility === undefined || p.visibility > 0.4).length;
      return { landmarks, score: visible / lm.length };
    } catch {
      return null;
    }
  }

  async segment(input: ImageLike, width: number, height: number): Promise<SegmentationObservation | null> {
    try {
      if (!this.segModel) return null;
      const canvas = this.toCanvas(input);
      const holder: { classes?: Uint8Array } = {};
      const onResult = (result: ImageSegmenterResult) => {
        const mask = result.categoryMask;
        if (!mask) return;
        const src = mask.getAsUint8Array();
        const sw = mask.width;
        const sh = mask.height;
        // Resample the category mask to the analysis grid.
        const classes = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
          const sy = Math.min(sh - 1, Math.floor(((y + 0.5) / height) * sh));
          for (let x = 0; x < width; x++) {
            const sx = Math.min(sw - 1, Math.floor(((x + 0.5) / width) * sw));
            classes[y * width + x] = src[sy * sw + sx] % DEEPLAB_CLASSES;
          }
        }
        mask.close();
        holder.classes = classes;
      };
      this.segModel.segment(canvas as HTMLCanvasElement, onResult);
      const classes = holder.classes;
      if (!classes) return null;
      let fg = 0;
      for (let i = 0; i < classes.length; i++) if (classes[i] > 0) fg++;
      return { width, height, classes, foregroundRatio: fg / classes.length };
    } catch {
      return null;
    }
  }
}

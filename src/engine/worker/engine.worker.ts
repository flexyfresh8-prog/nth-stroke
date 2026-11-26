/**
 * The engine worker: owns the transferred OffscreenCanvas, the analysis
 * pipeline, the MediaPipe models and the DrawingController (spec §14).
 * The UI stays responsive — planning, deposition physics and evaluation
 * all run here; only lightweight snapshots cross the boundary.
 */

import { analyzeScene, type SceneGraph } from '../analysis/scene';
import { DrawingController } from '../control/controller';
import { DEFAULT_CONFIG, ENGINE_VERSION, type EngineConfig, type InstrumentId, type StylusSample } from '../core/types';
import { BrowserMlProvider } from '../ml/browser';
import { NullMlProvider, type MlProvider, type FaceObservation, type PoseObservation, type SegmentationObservation } from '../ml/provider';
import { buildProjectFile, exportSessionJson, exportSvg, type NthProject } from '../session/exports';
import type { FromWorker, PlaybackSpeed, ToWorker } from './protocol';

const ANALYSIS_MAX = 512;
const CANVAS_MAX = 1280;

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let controller: DrawingController | null = null;
let scene: SceneGraph | null = null;
let provider: MlProvider = new NullMlProvider();
let modelsLoaded: string[] = [];
let basePath = '';
let speed: PlaybackSpeed = 1;
let running = false;
let simTarget = 0;
let lastTick = 0;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let frameImageData: ImageData | null = null;
let pendingRects: Array<{ x: number; y: number; w: number; h: number }> = [];
let lastSnapshotPost = 0;
let loadMeta: { dataUrl: string; width: number; height: number } | null = null;
let engineConfig: EngineConfig = { ...DEFAULT_CONFIG };

const workerSelf = self as unknown as {
  postMessage: (message: FromWorker, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const post = (message: FromWorker, transfer?: Transferable[]) =>
  transfer ? workerSelf.postMessage(message, transfer) : workerSelf.postMessage(message);

function analysisSize(w: number, h: number) {
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(w, h));
  return { width: Math.max(8, Math.round(w * scale)), height: Math.max(8, Math.round(h * scale)) };
}

function canvasSize(w: number, h: number) {
  const scale = Math.min(1, CANVAS_MAX / Math.max(w, h));
  return { width: Math.max(320, Math.round(w * scale)), height: Math.max(240, Math.round(h * scale)) };
}

function rgbaFromBitmap(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, width, height);
  return g.getImageData(0, 0, width, height).data;
}

function composite(rects: Array<{ x: number; y: number; w: number; h: number }>) {
  if (!ctx || !controller) return;
  // Coalesce into a few bounding boxes for cheap putImageData calls.
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const r of rects) {
    const merged = boxes.find(
      (b) =>
        r.x >= b.x - 48 && r.y >= b.y - 48 &&
        r.x + r.w <= b.x + b.w + 48 && r.y + r.h <= b.y + b.h + 48,
    );
    if (merged) {
      const x2 = Math.max(merged.x + merged.w, r.x + r.w);
      const y2 = Math.max(merged.y + merged.h, r.y + r.h);
      merged.x = Math.min(merged.x, r.x);
      merged.y = Math.min(merged.y, r.y);
      merged.w = x2 - merged.x;
      merged.h = y2 - merged.y;
    } else {
      boxes.push({ ...r });
    }
  }
  const map = controller.map;
  const paper = controller.paper;
  for (const box of boxes) {
    const x = Math.max(0, Math.min(map.width - 1, Math.floor(box.x)));
    const y = Math.max(0, Math.min(map.height - 1, Math.floor(box.y)));
    const w = Math.max(1, Math.min(map.width - x, Math.ceil(box.w + (box.x - x))));
    const h = Math.max(1, Math.min(map.height - y, Math.ceil(box.h + (box.y - y))));
    if (!frameImageData || frameImageData.width !== w || frameImageData.height !== h) {
      frameImageData = new ImageData(w, h);
    }
    map.compositeRect(paper.albedo, frameImageData.data, { x, y, w, h }, { width: map.width, height: map.height }, w);
    // The tile image is w×h: place it at (x, y).
    ctx.putImageData(frameImageData, x, y);
  }
}

function buildController(config: Partial<EngineConfig>, seed: number) {
  if (!scene) return;
  engineConfig = { ...DEFAULT_CONFIG, ...config, seed };
  controller = new DrawingController(scene, engineConfig, {
    onDirty: (rects) => {
      pendingRects.push(...rects);
    },
    onSnapshot: (s) => {
      const now = performance.now();
      if (now - lastSnapshotPost > 90 || s.done) {
        lastSnapshotPost = now;
        post({ type: 'snapshot', data: s });
      }
    },
    onStage: (stage, reason) => post({ type: 'stage', stage, reason }),
    onCorrection: (reason) => post({ type: 'correction', reason, t: controller?.simTime ?? 0 }),
  });
}

function tick() {
  if (!controller) return;
  try {
    const now = performance.now();
    const dt = Math.min(100, now - (lastTick || now));
    lastTick = now;
    if (running && !controller.done) {
      if (speed === 'max') {
        controller.runOps(64, 12);
      } else {
        simTarget = Math.min(controller.simTime + dt * speed, controller.simTime + 3200 * speed);
        controller.advance(simTarget);
      }
      if (controller.userEditedSinceEval && !controller.busy) controller.evaluate();
    }
    if (pendingRects.length) {
      composite(pendingRects);
      pendingRects = [];
    }
    const snap = controller.snapshot();
    const t = performance.now();
    if (running && t - lastSnapshotPost > 90) {
      lastSnapshotPost = t;
      post({ type: 'snapshot', data: snap });
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: `engine loop failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}` });
  }
}

async function loadReference(message: Extract<ToWorker, { type: 'load' }>) {
  post({ type: 'analysis', phase: 'decoding', progress: 0.05 });
  const bitmap = message.bitmap;
  const aSize = analysisSize(bitmap.width, bitmap.height);
  const cSize = canvasSize(bitmap.width, bitmap.height);
  loadMeta = { dataUrl: message.referenceDataUrl, width: message.referenceWidth, height: message.referenceHeight };
  const rgba = rgbaFromBitmap(bitmap, aSize.width, aSize.height);
  post({ type: 'analysis', phase: 'classical analysis', progress: 0.3 });

  let face: FaceObservation | null = null;
  let pose: PoseObservation | null = null;
  let segmentation: SegmentationObservation | null = null;
  if (message.config.useModels !== false) {
    post({ type: 'analysis', phase: 'loading vision models', progress: 0.45 });
    await provider.ensureLoaded?.();
    const analysisCanvas = new OffscreenCanvas(aSize.width, aSize.height);
    const g = analysisCanvas.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0, aSize.width, aSize.height);
    post({ type: 'analysis', phase: 'face landmarks', progress: 0.6 });
    face = await provider.face(analysisCanvas);
    post({ type: 'analysis', phase: 'pose landmarks', progress: 0.72 });
    pose = await provider.pose(analysisCanvas);
    post({ type: 'analysis', phase: 'segmentation', progress: 0.85 });
    segmentation = await provider.segment(analysisCanvas, aSize.width, aSize.height);
  }

  scene = analyzeScene({
    rgba,
    width: aSize.width,
    height: aSize.height,
    canvasWidth: cSize.width,
    canvasHeight: cSize.height,
    face,
    pose,
    segmentation,
  });
  post({ type: 'analysis', phase: 'building scene graph', progress: 0.95 });

  if (ctx) {
    ctx.canvas.width = cSize.width;
    ctx.canvas.height = cSize.height;
    frameImageData = null;
  }
  buildController(message.config, message.config.seed ?? DEFAULT_CONFIG.seed);
  simTarget = 0;
  pendingRects = [{ x: 0, y: 0, w: cSize.width, h: cSize.height }];
  composite(pendingRects);
  pendingRects = [];
  post({
    type: 'scene',
    summary: scene.summary,
    width: cSize.width,
    height: cSize.height,
    models: modelsLoaded,
    seed: engineConfig.seed,
  });
  post({ type: 'snapshot', data: controller!.snapshot() });
}

function exportName(kind: string, ext: string) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return `nth-stroke-${stamp}-${kind}.${ext}`;
}

workerSelf.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': {
        basePath = message.basePath;
        const canvas = message.canvas;
        ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
        canvas.width = message.width;
        canvas.height = message.height;
        if (loopTimer !== null) clearInterval(loopTimer);
        provider = new BrowserMlProvider(basePath, (status) => {
          if (status.startsWith('vision models ready')) {
            modelsLoaded = status.match(/\((\d)\/3\)/)?.[1] === '3'
              ? ['face', 'pose', 'segmentation']
              : status.includes('unavailable')
                ? []
                : modelsLoaded;
          }
        });
        lastTick = performance.now();
        loopTimer = setInterval(tick, 16);
        post({ type: 'ready' });
        break;
      }
      case 'load': {
        running = false;
        if (controller) controller.cancel();
        await loadReference(message);
        break;
      }
      case 'start': {
        if (!controller) break;
        simTarget = controller.simTime;
        controller.start();
        running = controller.running;
        break;
      }
      case 'pause': {
        controller?.pause();
        running = false;
        if (controller) post({ type: 'snapshot', data: controller.snapshot() });
        break;
      }
      case 'resume': {
        if (!controller) break;
        simTarget = controller.simTime;
        controller.resume();
        running = controller.running;
        break;
      }
      case 'cancel': {
        controller?.cancel();
        running = false;
        break;
      }
      case 'restart': {
        if (!scene || !controller) break;
        running = false;
        controller.cancel();
        buildController(engineConfig, engineConfig.seed);
        simTarget = 0;
        pendingRects = [{ x: 0, y: 0, w: controller.map.width, h: controller.map.height }];
        composite(pendingRects);
        pendingRects = [];
        post({ type: 'snapshot', data: controller.snapshot() });
        break;
      }
      case 'speed': {
        speed = message.value;
        if (controller) simTarget = controller.simTime;
        break;
      }
      case 'user-stroke': {
        if (controller) {
          controller.injectUserStroke(message.samples as StylusSample[], message.instrument as InstrumentId);
        }
        break;
      }
      case 'export': {
        if (!controller) break;
        if (message.kind === 'png' || message.kind === 'jpeg' || message.kind === 'webp') {
          composite([{ x: 0, y: 0, w: controller.map.width, h: controller.map.height }]);
          const type = message.kind === 'png' ? 'image/png' : message.kind === 'jpeg' ? 'image/jpeg' : 'image/webp';
          const blob = await ctx!.canvas.convertToBlob({ type, quality: message.quality ?? 0.92 });
          post({ type: 'export-result', kind: message.kind, blob, filename: exportName('drawing', message.kind) }, [blob]);
        } else if (message.kind === 'svg') {
          const result = exportSvg(controller.session, controller.map.width, controller.map.height, {
            seed: controller.config.seed,
          });
          const blob = new Blob([result.svg], { type: 'image/svg+xml' });
          post({ type: 'export-result', kind: 'svg', blob, filename: exportName('drawing', 'svg'), text: JSON.stringify({ pathCount: result.pathCount, byteSize: result.byteSize, skippedBlendOps: result.skippedBlendOps }) }, [blob]);
        } else if (message.kind === 'session') {
          const json = exportSessionJson(controller.session);
          const blob = new Blob([json], { type: 'application/json' });
          post({ type: 'export-result', kind: 'session', blob, filename: exportName('session', 'json') }, [blob]);
        } else if (message.kind === 'project') {
          if (!loadMeta) break;
          const blob = await buildProjectFile(
            controller.session,
            controller.checkpoint(),
            controller.config,
            controller.config.seed,
            loadMeta.dataUrl,
            loadMeta.width,
            loadMeta.height,
            controller.map.width,
            controller.map.height,
          );
          post({ type: 'export-result', kind: 'project', blob, filename: exportName('project', 'nth') }, [blob]);
        }
        break;
      }
      case 'checkpoint': {
        if (!controller) break;
        post({ type: 'export-result', kind: 'checkpoint', text: JSON.stringify(controller.checkpoint()), filename: 'checkpoint.json' });
        break;
      }
      case 'restore': {
        const project = message.project as NthProject;
        running = false;
        controller?.cancel();
        post({ type: 'analysis', phase: 'restoring project', progress: 0.2 });
        await loadReference({
          type: 'load',
          bitmap: message.bitmap,
          config: { ...(project.config as Partial<EngineConfig>), seed: project.seed },
          referenceDataUrl: project.reference.dataUrl,
          referenceWidth: project.reference.width,
          referenceHeight: project.reference.height,
        });
        if (controller) {
          controller.restore(project.checkpoint as never);
          post({ type: 'restored', summary: project.session ? ['session restored'] : [] });
          post({ type: 'snapshot', data: controller.snapshot() });
        }
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

void ENGINE_VERSION;

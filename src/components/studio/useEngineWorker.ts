'use client';

/**
 * React hook that owns the engine worker lifecycle (spec §11, §13).
 * The canvas is transferred to the worker (OffscreenCanvas); the UI only
 * renders snapshots and sends commands.
 *
 * The worker is created lazily and kept for the lifetime of the page so
 * that React StrictMode remounts (dev) cannot orphan the canvas transfer.
 */

import { useCallback, useRef, useState } from 'react';
import type { EngineSnapshot, InstrumentId, Stage, StylusSample } from '@/engine/core/types';
import type { FromWorker, PlaybackSpeed, ToWorker } from '@/engine/worker/protocol';

export interface SceneInfo {
  summary: string[];
  width: number;
  height: number;
  models: string[];
  seed: number;
}

export interface EngineWorkerState {
  ready: boolean;
  analysisPhase: string;
  analysisProgress: number;
  scene: SceneInfo | null;
  snapshot: EngineSnapshot | null;
  stage: Stage;
  stageReason?: string;
  corrections: Array<{ reason: string; t: number }>;
  error: string | null;
  speed: PlaybackSpeed;
  timelapseActive: boolean;
}

export function useEngineWorker() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [state, setState] = useState<EngineWorkerState>({
    ready: false,
    analysisPhase: '',
    analysisProgress: 0,
    scene: null,
    snapshot: null,
    stage: 'observation',
    corrections: [],
    error: null,
    speed: 1,
    timelapseActive: false,
  });

  /** Lazily create the singleton worker with its message handler. */
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('../../engine/worker/engine.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      setState((prev) => {
        switch (msg.type) {
          case 'ready':
            return { ...prev, ready: true, error: null };
          case 'analysis':
            return { ...prev, analysisPhase: msg.phase, analysisProgress: msg.progress };
          case 'scene':
            return {
              ...prev,
              scene: { summary: msg.summary, width: msg.width, height: msg.height, models: msg.models, seed: msg.seed },
              analysisProgress: 1,
              analysisPhase: '',
            };
          case 'snapshot':
            return { ...prev, snapshot: msg.data };
          case 'stage':
            return { ...prev, stage: msg.stage, stageReason: msg.reason };
          case 'correction':
            return { ...prev, corrections: [...prev.corrections.slice(-79), { reason: msg.reason, t: msg.t }] };
          case 'restored':
            return { ...prev, corrections: [] };
          case 'error':
            return { ...prev, error: msg.message };
          default:
            return prev;
        }
      });
      if (msg.type === 'export-result' && msg.blob) {
        const url = URL.createObjectURL(msg.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = msg.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
    });
    workerRef.current = worker;
    return worker;
  }, []);

  const send = useCallback((message: ToWorker, transfer?: Transferable[]) => {
    const worker = workerRef.current ?? ensureWorker();
    worker.postMessage(message, transfer ?? []);
  }, [ensureWorker]);

  /** Ref callback for the canvas — transfers control once per canvas element. */
  const attachCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas;
      if (!canvas) return;
      if (typeof canvas.transferControlToOffscreen !== 'function') {
        setState((prev) => ({ ...prev, error: 'This browser does not support OffscreenCanvas — the drawing engine cannot run.' }));
        return;
      }
      try {
        const worker = ensureWorker();
        const off = canvas.transferControlToOffscreen();
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
        worker.postMessage({ type: 'init', canvas: off, width: canvas.width || 900, height: canvas.height || 640, basePath }, [off]);
      } catch {
        // Already transferred (remount) — the worker keeps the first context.
      }
    },
    [ensureWorker],
  );

  const loadReference = useCallback(
    async (file: File, options: { seed: number; opBudget: number; detailLevel: number; fidelity: number; useModels: boolean }) => {
      const bitmap = await createImageBitmap(file);
      const maxDim = 640;
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bitmap.width * scale));
      c.height = Math.max(1, Math.round(bitmap.height * scale));
      c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/png');
      send(
        {
          type: 'load',
          bitmap,
          config: options,
          referenceDataUrl: dataUrl,
          referenceWidth: bitmap.width,
          referenceHeight: bitmap.height,
        },
        [bitmap],
      );
    },
    [send],
  );

  const start = useCallback(() => send({ type: 'start' }), [send]);
  const pause = useCallback(() => send({ type: 'pause' }), [send]);
  const resume = useCallback(() => send({ type: 'resume' }), [send]);
  const cancel = useCallback(() => send({ type: 'cancel' }), [send]);
  const restart = useCallback(() => send({ type: 'restart' }), [send]);
  const setSpeed = useCallback((value: PlaybackSpeed) => {
    send({ type: 'speed', value });
    setState((p) => ({ ...p, speed: value }));
  }, [send]);
  const userStroke = useCallback((samples: StylusSample[], instrument: InstrumentId) => send({ type: 'user-stroke', samples, instrument }), [send]);
  const requestExport = useCallback((kind: 'svg' | 'png' | 'jpeg' | 'webp' | 'session' | 'project') => send({ type: 'export', kind }), [send]);
  const requestCheckpoint = useCallback(() => send({ type: 'checkpoint' }), [send]);

  const restoreProject = useCallback(
    async (file: File) => {
      const buffer = await file.arrayBuffer();
      const blob = new Blob([buffer]);
      let json = '';
      try {
        const ds = new DecompressionStream('gzip');
        json = await new Response(blob.stream().pipeThrough(ds)).text();
      } catch {
        json = await blob.text();
      }
      if (!json.startsWith('{')) json = await blob.text();
      const project = JSON.parse(json) as { reference: { dataUrl: string } };
      const res = await fetch(project.reference.dataUrl);
      const refBlob = await res.blob();
      const bitmap = await createImageBitmap(refBlob);
      send({ type: 'restore', project: JSON.parse(json), bitmap }, [bitmap]);
    },
    [send],
  );

  /** Timelapse recording via MediaRecorder on the visible canvas. */
  const toggleTimelapse = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
      setState((prev) => ({ ...prev, timelapseActive: false }));
      return;
    }
    try {
      const stream = canvas.captureStream(30);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      if (!mime) {
        setState((prev) => ({ ...prev, error: 'Timelapse recording is not supported in this browser.' }));
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'nth-stroke-timelapse.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      };
      recorder.start(500);
      recorderRef.current = recorder;
      setState((prev) => ({ ...prev, timelapseActive: true }));
    } catch {
      setState((prev) => ({ ...prev, error: 'Timelapse recording could not be started.' }));
    }
  }, []);

  return {
    state,
    canvasRef,
    attachCanvas,
    loadReference,
    start,
    pause,
    resume,
    cancel,
    restart,
    setSpeed,
    userStroke,
    requestExport,
    requestCheckpoint,
    restoreProject,
    toggleTimelapse,
  };
}

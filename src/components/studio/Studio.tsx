'use client';

/**
 * NTH Stroke — the studio workspace (spec §13).
 * Premium minimalist monochrome drawing environment: spacious canvas,
 * thin borders, collapsible panels, Apple-style typography, touch/stylus
 * support, live engine telemetry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Square, RotateCcw, Download, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Camera, ImagePlus, FolderOpen, X } from 'lucide-react';
import type { InstrumentId, StylusSample } from '@/engine/core/types';
import { SPEED_STEPS, type PlaybackSpeed } from '@/engine/worker/protocol';
import { useEngineWorker } from './useEngineWorker';
import { DiagnosticsDrawer, InstrumentsPanel, MetricsBar, ReferencePanel, StagePipeline, formatSimTime } from './panels';

const SPEED_LABEL: Record<PlaybackSpeed, string> = {
  0.25: '0.25×',
  0.5: '0.5×',
  1: '1×',
  2: '2×',
  5: '5×',
  10: '10×',
  50: '50×',
  max: 'MAX',
};

export default function Studio() {
  const engine = useEngineWorker();
  const { state, attachCanvas, loadReference, start, pause, resume, cancel, restart, setSpeed: setEngineSpeed, userStroke, requestExport, restoreProject, toggleTimelapse, canvasRef } = engine;
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [diagOpen, setDiagOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [seed, setSeed] = useState(20260101);
  const [budget, setBudget] = useState(2600);
  const [detail, setDetail] = useState(0.6);
  const [fidelity, setFidelity] = useState(0.65);
  const [useModels, setUseModels] = useState(true);
  const [manualInstrument, setManualInstrument] = useState<InstrumentId | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<Array<{ x: number; y: number; p: number; t: number }> | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setReferenceUrl(URL.createObjectURL(file));
      setFileName(file.name);
      await loadReference(file, { seed, opBudget: budget, detailLevel: detail, fidelity, useModels });
    },
    [loadReference, seed, budget, detail, fidelity, useModels],
  );

  // Drag & drop import.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) void handleFile(file);
      if (file && file.name.endsWith('.nth')) void restoreProject(file);
    },
    [handleFile, restoreProject],
  );

  /** Map a pointer event to canvas coordinates (object-contain letterboxing). */
  const pointerToCanvas = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const wrap = canvasWrapRef.current;
    if (!canvas || !wrap || !state.scene) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    // The canvas element fills the wrapper via CSS; content is letterboxed
    // inside the element by object-fit: contain.
    const scale = Math.min(canvasRect.width / state.scene.width, canvasRect.height / state.scene.height);
    const contentW = state.scene.width * scale;
    const contentH = state.scene.height * scale;
    const offsetX = canvasRect.left + (canvasRect.width - contentW) / 2 - wrapRect.left;
    const offsetY = canvasRect.top + (canvasRect.height - contentH) / 2 - wrapRect.top;
    const x = (clientX - wrapRect.left - offsetX) / scale;
    const y = (clientY - wrapRect.top - offsetY) / scale;
    if (x < 0 || y < 0 || x > state.scene.width || y > state.scene.height) return null;
    return { x, y, scale };
  }, [canvasRef, state.scene]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!manualInstrument || !state.scene) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const p = pointerToCanvas(e.clientX, e.clientY);
      if (!p) return;
      strokeRef.current = [{ x: p.x, y: p.y, p: e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.45, t: e.timeStamp }];
    },
    [manualInstrument, pointerToCanvas, state.scene],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!strokeRef.current) return;
      const p = pointerToCanvas(e.clientX, e.clientY);
      if (!p) return;
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = events.length > 1 ? events : [e.nativeEvent];
      for (const ev of points) {
        const cp = events.length > 1 ? pointerToCanvas(ev.clientX, ev.clientY) : p;
        if (!cp) continue;
        const prev = strokeRef.current[strokeRef.current.length - 1];
        const dist = Math.hypot(cp.x - prev.x, cp.y - prev.y);
        if (dist < 1.2) continue;
        // Pressure: stylus pressure when available, otherwise speed-based
        // (a slower hand presses harder) — continuous, never stepped.
        const raw = ev.pressure > 0 && ev.pressure !== 0.5 ? ev.pressure : Math.min(0.75, Math.max(0.22, 0.55 - dist * 0.02));
        strokeRef.current.push({ x: cp.x, y: cp.y, p: (prev.p + raw) * 0.5, t: ev.timeStamp });
      }
    },
    [pointerToCanvas],
  );

  const onPointerUp = useCallback(() => {
    const pts = strokeRef.current;
    strokeRef.current = null;
    if (!pts || pts.length < 2 || !manualInstrument) return;
    const samples: StylusSample[] = pts.map((p, i) => {
      const prev = pts[Math.max(0, i - 1)];
      const dt = Math.max(1, p.t - prev.t);
      return {
        t: p.t - pts[0].t,
        x: p.x,
        y: p.y,
        z: 0,
        pressure: p.p,
        v: Math.hypot(p.x - prev.x, p.y - prev.y) / dt,
        tilt: 0.14,
        azimuth: 0,
      };
    });
    userStroke(samples, manualInstrument);
  }, [userStroke, manualInstrument]);

  const running = state.snapshot?.running ?? false;
  const done = state.snapshot?.done ?? false;
  const busy = running || state.snapshot?.phase === 'travel' || state.snapshot?.phase === 'draw';
  const cursor = state.snapshot?.cursor;
  const progress = state.snapshot?.progress ?? 0;


  return (
    <div
      className="flex h-dvh min-h-[560px] w-full flex-col bg-neutral-50 text-neutral-900 antialiased"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* ---------------- top bar ---------------- */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.22em] text-neutral-900">NTH&nbsp;STROKE</h1>
        <span className="hidden h-4 w-px bg-neutral-200 sm:block" />
        <div className="hidden sm:block">
          <StagePipeline stage={state.stage} />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={projectInputRef}
            type="file"
            accept=".nth,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void restoreProject(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 text-[12px] text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          >
            <ImagePlus size={14} strokeWidth={1.5} /> <span className="hidden sm:inline">Import</span>
          </button>
          <button
            type="button"
            onClick={() => projectInputRef.current?.click()}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 text-[12px] text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          >
            <FolderOpen size={14} strokeWidth={1.5} /> <span className="hidden sm:inline">Open .nth</span>
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportOpen((v) => !v)}
              disabled={!state.scene}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 text-[12px] text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-40"
            >
              <Download size={14} strokeWidth={1.5} /> Export
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
                {([
                  ['png', 'PNG image'],
                  ['jpeg', 'JPEG image'],
                  ['webp', 'WebP image'],
                  ['svg', 'SVG vectors'],
                  ['session', 'Session JSON'],
                  ['project', 'NTH project'],
                ] as const).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className="block w-full px-3 py-2 text-left text-[12px] text-neutral-700 hover:bg-neutral-50"
                    onClick={() => {
                      requestExport(kind);
                      setExportOpen(false);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ---------------- main ---------------- */}
      <div className="flex min-h-0 flex-1">
        {/* left rail */}
        <aside
          className={`${leftOpen ? 'w-60' : 'w-0'} shrink-0 overflow-hidden border-r border-neutral-200 bg-white transition-[width] duration-300 ease-in-out`}
          aria-label="Reference and settings"
        >
          <div className="flex h-full w-60 flex-col gap-5 overflow-y-auto p-4">
            <ReferencePanel referenceUrl={referenceUrl} scene={state.scene} fileName={fileName} />
            <section aria-label="Generation settings">
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">Generation</h2>
              <label className="mb-2 block text-[12px] text-neutral-600">
                Seed
                <div className="mt-1 flex gap-1">
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value) || 0)}
                    className="h-8 w-full rounded-lg border border-neutral-200 px-2 font-mono text-[12px] focus:border-neutral-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setSeed(Math.floor(Math.random() * 1e8))}
                    className="h-8 shrink-0 rounded-lg border border-neutral-200 px-2 text-[11px] hover:bg-neutral-50"
                  >
                    New
                  </button>
                </div>
              </label>
              <RangeRow label="Stroke budget" value={budget} min={400} max={6000} step={100} onChange={setBudget} format={(v) => `${v}`} />
              <RangeRow label="Detail" value={detail} min={0} max={1} step={0.05} onChange={setDetail} format={(v) => v.toFixed(2)} />
              <RangeRow label="Fidelity" value={fidelity} min={0} max={1} step={0.05} onChange={setFidelity} format={(v) => v.toFixed(2)} />
              <label className="mt-1 flex items-center gap-2 text-[12px] text-neutral-600">
                <input type="checkbox" checked={useModels} onChange={(e) => setUseModels(e.target.checked)} className="h-3.5 w-3.5 accent-neutral-900" />
                Use local vision models
              </label>
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">
                Settings apply when the next image is imported or the drawing is restarted.
              </p>
            </section>
            <section aria-label="Timelapse">
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">Timelapse</h2>
              <button
                type="button"
                onClick={toggleTimelapse}
                className={`flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-[12px] transition-colors ${
                  state.timelapseActive
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-200 text-neutral-700 hover:bg-neutral-50'
                }`}
              >
                <Camera size={14} strokeWidth={1.5} />
                {state.timelapseActive ? 'Stop timelapse' : 'Record timelapse'}
              </button>
            </section>
          </div>
        </aside>

        {/* canvas stage */}
        <main className="relative flex min-w-0 flex-1 flex-col bg-neutral-100" aria-label="Drawing canvas">
          <div className="flex items-center justify-between px-2 pt-1.5">
            <button
              type="button"
              onClick={() => setLeftOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
              aria-label={leftOpen ? 'Collapse reference panel' : 'Expand reference panel'}
            >
              {leftOpen ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
            </button>
            <p className="truncate px-2 text-center text-[11.5px] text-neutral-500">
              {state.analysisPhase ? `Analyzing — ${state.analysisPhase}…` : state.snapshot?.objective || 'Import a reference image to begin'}
            </p>
            <button
              type="button"
              onClick={() => setRightOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
              aria-label={rightOpen ? 'Collapse instruments panel' : 'Expand instruments panel'}
            >
              {rightOpen ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
          </div>

          <div
            ref={canvasWrapRef}
            className={`relative m-2 mt-1 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border bg-white transition-colors ${
              dragOver ? 'border-neutral-900 border-dashed' : 'border-neutral-200'
            } ${manualInstrument ? 'cursor-crosshair' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <canvas
              ref={attachCanvas}
              className="h-full w-full object-contain"
              style={{ touchAction: 'none' }}
              aria-label="Drawing canvas — the engine draws here stroke by stroke"
            />
            {/* live pencil cursor */}
            {cursor && state.scene && !done && (
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                <PencilCursor
                  wrapRef={canvasWrapRef}
                  canvasRef={canvasRef}
                  scene={state.scene}
                  cursor={cursor}
                  pressure={state.snapshot?.pressure ?? 0}
                  active={!!state.snapshot?.running}
                />
              </div>
            )}
            {!state.scene && !state.analysisPhase && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <p className="text-[13px] text-neutral-400">Drop a reference image here</p>
                <p className="text-[11.5px] text-neutral-300">portraits · anime · landscapes · architecture · animals · objects</p>
              </div>
            )}
            {state.error && (
              <div className="absolute bottom-2 left-2 right-2 flex items-start justify-between gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[12px] text-neutral-700 shadow-sm">
                <span>{state.error}</span>
                <button type="button" onClick={() => window.location.reload()} className="shrink-0 underline">
                  Reload
                </button>
              </div>
            )}
          </div>

          {/* transport + metrics */}
          <div className="shrink-0 border-t border-neutral-200 bg-white">
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="flex items-center gap-1">
                {!running && !done && (
                  <button
                    type="button"
                    onClick={start}
                    disabled={!state.scene}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
                  >
                    <Play size={14} strokeWidth={2} /> Start
                  </button>
                )}
                {running && (
                  <button
                    type="button"
                    onClick={pause}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-85"
                  >
                    <Pause size={14} strokeWidth={2} /> Pause
                  </button>
                )}
                {!running && busy === false && !done && state.snapshot && state.snapshot.opCount > 0 && (
                  <button
                    type="button"
                    onClick={resume}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-85"
                  >
                    <Play size={14} strokeWidth={2} /> Resume
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancel}
                  disabled={!state.snapshot}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40"
                  aria-label="Cancel drawing"
                >
                  <Square size={13} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={restart}
                  disabled={!state.scene}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40"
                  aria-label="Restart drawing from the same seed"
                >
                  <RotateCcw size={14} strokeWidth={2} />
                </button>
              </div>

              {/* speed stepper */}
              <div className="flex items-center overflow-x-auto rounded-lg border border-neutral-200" role="group" aria-label="Drawing speed">
                {SPEED_STEPS.map((s) => (
                  <button
                    key={String(s)}
                    type="button"
                    onClick={() => setEngineSpeed(s)}
                    className={[
                      'h-8 min-w-[38px] px-1.5 text-[11px] transition-colors',
                      state.speed === s ? 'bg-neutral-900 text-white' : 'text-neutral-500 hover:bg-neutral-50',
                    ].join(' ')}
                  >
                    {SPEED_LABEL[s]}
                  </button>
                ))}
              </div>

              <div className="ml-auto flex min-w-[120px] max-w-[220px] flex-1 items-center gap-2">
                <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-neutral-200">
                  <div className="h-full rounded-full bg-neutral-900 transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
                </div>
                <span className="font-mono text-[11px] text-neutral-500">{Math.round(progress * 100)}%</span>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-neutral-100 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <MetricsBar snapshot={state.snapshot} />
              </div>
              <button
                type="button"
                onClick={() => setDiagOpen((v) => !v)}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] text-neutral-500 hover:bg-neutral-100"
              >
                Diagnostics {diagOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              </button>
            </div>
          </div>
        </main>

        {/* right rail */}
        <aside
          className={`${rightOpen ? 'w-64' : 'w-0'} shrink-0 overflow-hidden border-l border-neutral-200 bg-white transition-[width] duration-300 ease-in-out`}
          aria-label="Instruments"
        >
          <div className="flex h-full w-64 flex-col gap-5 overflow-y-auto p-4">
            <InstrumentsPanel
              activeInstrument={state.snapshot?.instrument ?? null}
              manualInstrument={manualInstrument}
              onManualSelect={(id) => setManualInstrument(id)}
            />
          </div>
        </aside>
      </div>

      {/* diagnostics drawer */}
      <div
        className={`${diagOpen ? 'h-56' : 'h-0'} shrink-0 overflow-hidden border-t border-neutral-200 bg-white transition-[height] duration-300 ease-in-out`}
        aria-label="Engine diagnostics"
      >
        <DiagnosticsDrawer snapshot={state.snapshot} corrections={state.corrections} scene={state.scene} />
      </div>

      {/* mobile stage pipeline */}
      <div className="border-t border-neutral-200 bg-white px-3 py-1.5 sm:hidden">
        <StagePipeline stage={state.stage} />
      </div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <label className="mb-2 block text-[12px] text-neutral-600">
      <span className="flex items-baseline justify-between">
        {label}
        <span className="font-mono text-[11px] text-neutral-400">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-neutral-900"
      />
    </label>
  );
}

/** The live pencil indicator over the canvas (position + pressure ring). */
function PencilCursor({
  wrapRef,
  canvasRef,
  scene,
  cursor,
  pressure,
  active,
}: {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scene: { width: number; height: number };
  cursor: { x: number; y: number; z: number };
  pressure: number;
  active: boolean;
}) {
  const [rect, setRect] = useState<{ left: number; top: number; scale: number } | null>(null);
  useEffect(() => {
    const compute = () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const scale = Math.min(canvasRect.width / scene.width, canvasRect.height / scene.height);
      setRect({
        left: canvasRect.left - wrapRect.left + (canvasRect.width - scene.width * scale) / 2,
        top: canvasRect.top - wrapRect.top + (canvasRect.height - scene.height * scale) / 2,
        scale,
      });
    };
    compute();
    const obs = new ResizeObserver(compute);
    if (wrapRef.current) obs.observe(wrapRef.current);
    return () => obs.disconnect();
  }, [wrapRef, canvasRef, scene.width, scene.height]);

  if (!rect) return null;
  const size = 10 + pressure * 14;
  return (
    <div
      className="absolute"
      style={{
        left: rect.left + cursor.x * rect.scale,
        top: rect.top + cursor.y * rect.scale,
        transform: 'translate(-50%, -50%)',
        opacity: active ? 1 : 0.55,
        transition: 'opacity 200ms',
      }}
    >
      <div
        className="rounded-full border border-neutral-900/70"
        style={{
          width: size,
          height: size,
          background: cursor.z > 0.4 ? 'transparent' : `rgba(0,0,0,${0.12 + pressure * 0.5})`,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.7)`,
        }}
      />
    </div>
  );
}


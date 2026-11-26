'use client';

/**
 * NTH Stroke — the studio workspace (spec §13).
 * Premium minimalist monochrome drawing environment: spacious canvas,
 * thin borders, collapsible panels, Apple-style typography, touch/stylus
 * support, live engine telemetry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import type { EngineId } from '@/engine/control/contract';
import { DEFAULT_CONFIG } from '@/engine/core/types';
import { ADAPTIVE_DEFAULTS, type AdaptiveConfig, type AdaptiveSettings } from '@/engine/adaptive/config';
import type { MapName } from '@/engine/adaptive/diagnostics';
import type { NthProject } from '@/engine/session/exports';
import { AdaptiveControls, AdaptiveDiagnostics, BenchmarkPanel } from './AdaptivePanels';
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
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [engineId, setEngineId] = useState<EngineId>('v2');
  const [profiles, setProfiles] = useState<Record<EngineId,AdaptiveConfig>>({
    v1:{...DEFAULT_CONFIG},
    v2:{...DEFAULT_CONFIG,opBudget:6000,fidelity:.9,detailLevel:.85,paperGrain:.16,useModels:false,adaptive:ADAPTIVE_DEFAULTS},
  });
  const [preferencesReady, setPreferencesReady] = useState(false);
  const {theme,setTheme}=useTheme();
  const [compareOpen,setCompareOpen]=useState(false);
  const [diagnosticView,setDiagnosticView]=useState<MapName>('Residual');
  const referenceFile=useRef<File|null>(null);
  const referenceObject=useRef<string|null>(null);
  const profile=profiles[engineId];
  const {seed,opBudget:budget,detailLevel:detail,fidelity,useModels,paperGrain}=profile;
  const adaptive={...ADAPTIVE_DEFAULTS,...profile.adaptive};
  function updateProfile(next:Partial<AdaptiveConfig>){
    setProfiles(prev=>({...prev,[engineId]:{...prev[engineId],...next}}));
  }
  useEffect(()=>{
    setRightOpen(matchMedia('(min-width: 1001px)').matches);
    setLeftOpen(matchMedia('(min-width: 671px)').matches);
    try{
      if(localStorage.getItem('nth-engine')==='v1')setEngineId('v1');
      const saved=JSON.parse(localStorage.getItem('nth-profiles')??'null') as Partial<Record<EngineId,AdaptiveConfig>>|null;
      if(saved)setProfiles(prev=>({v1:{...prev.v1,...saved.v1},v2:{...prev.v2,...saved.v2}}));
    }catch{ /* memory-only preferences */ }
    setPreferencesReady(true);
    return ()=>{if(referenceObject.current)URL.revokeObjectURL(referenceObject.current);};
  },[]);
  useEffect(()=>{
    if(!preferencesReady)return;
    try{localStorage.setItem('nth-engine',engineId);localStorage.setItem('nth-profiles',JSON.stringify(profiles));}catch{ /* storage unavailable */ }
  },[engineId,profiles,preferencesReady]);
  useEffect(()=>{
    if(engineId!=='v2'||!diagOpen||!state.scene)return;
    engine.inspect(diagnosticView);
    const timer=setInterval(()=>engine.inspect(diagnosticView),650);
    return ()=>clearInterval(timer);
  },[engineId,diagOpen,state.scene,diagnosticView,engine.inspect]);
  const [manualInstrument, setManualInstrument] = useState<InstrumentId | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<Array<{ x: number; y: number; p: number; t: number }> | null>(null);

  const showReference=useCallback((file:File)=>{
    if(referenceObject.current)URL.revokeObjectURL(referenceObject.current);
    referenceFile.current=file;
    referenceObject.current=URL.createObjectURL(file);
    setReferenceUrl(referenceObject.current);
    setFileName(file.name);
  },[]);
  const handleFile=useCallback(async(file:File)=>{
    showReference(file);
    await loadReference(file,profile,engineId);
  },[loadReference,profile,engineId,showReference]);
  const openProject=useCallback((file:File)=>restoreProject(file,(project:NthProject,id:EngineId,image:File)=>{
    showReference(image);setEngineId(id);setCompareOpen(false);setManualInstrument(null);
    setProfiles(prev=>({...prev,[id]:{...prev[id],...(project.config as Partial<AdaptiveConfig>),seed:project.seed}}));
  }),[restoreProject,showReference]);
  function switchEngine(id:EngineId){
    if(engineId===id)return;
    setEngineId(id);setCompareOpen(false);setManualInstrument(null);strokeRef.current=null;
    if(referenceFile.current)void loadReference(referenceFile.current,profiles[id],id);
    else cancel();
  }
  function applySettings(){
    if(referenceFile.current)void loadReference(referenceFile.current,profile,engineId);
    else restart();
  }

  // Drag & drop import.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) void handleFile(file);
      if (file && /\.(nth|json)$/i.test(file.name)) void openProject(file);
    },
    [handleFile, openProject],
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
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-3 py-1.5">
        <h1 className="text-[14px] font-semibold tracking-[-.025em] text-neutral-900">NTH Stroke</h1>
        <select aria-label="Drawing engine" value={engineId} onChange={e=>switchEngine(e.target.value as EngineId)}>
          <option value="v2">V2 · Adaptive</option><option value="v1">V1 · Legacy</option>
        </select>
        <select aria-label="Theme" value={preferencesReady ? theme ?? 'dark' : 'dark'} onChange={e=>setTheme(e.target.value)}>
          <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
        </select>
        <span className="hidden h-4 w-px bg-neutral-200 sm:block" />
        <div className="hidden xl:block">
          <StagePipeline stage={state.stage} />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" className="studio-button" disabled={!state.scene}
            onClick={()=>setCompareOpen(true)}>Compare</button>
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
              if (f) void openProject(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()} aria-label="Import reference"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 text-[12px] text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          >
            <ImagePlus size={14} strokeWidth={1.5} /> <span className="hidden sm:inline">Import</span>
          </button>
          <button
            type="button"
            onClick={() => projectInputRef.current?.click()} aria-label="Open .nth project"
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
              <div className="studio-menu absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
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
      <div className="studio-body relative flex min-h-0 flex-1 overflow-hidden">
        {/* left rail */}
        <aside
          data-open={leftOpen} className={`studio-rail studio-left ${leftOpen ? 'w-60' : 'w-0'} shrink-0 overflow-hidden border-r border-neutral-200 bg-white transition-[width] duration-300 ease-in-out`}
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
                    onChange={(e) => updateProfile({seed:Number(e.target.value)||0})}
                    className="h-8 w-full rounded-lg border border-neutral-200 px-2 font-mono text-[12px] focus:border-neutral-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => updateProfile({seed:Math.floor(Math.random()*1e8)})}
                    className="h-8 shrink-0 rounded-lg border border-neutral-200 px-2 text-[11px] hover:bg-neutral-50"
                  >
                    New
                  </button>
                </div>
              </label>
              {engineId==='v2'?<label className="studio-field">
                {adaptive.automatic?'Maximum strokes':'Manual stroke budget'}
                <input type="number" min={1000} max={100000} step={1000} value={budget}
                  onChange={e=>updateProfile({opBudget:Number(e.target.value)})}
                  onBlur={()=>updateProfile({opBudget:Math.max(1000,Math.min(100000,budget||1000))})}/>
              </label>:<RangeRow label="Stroke budget" value={budget} min={400} max={6000} step={100} onChange={v=>updateProfile({opBudget:v})} format={String}/>}
              <RangeRow label="Detail" value={detail} min={0} max={1} step={.05} onChange={v=>updateProfile({detailLevel:v})} format={v=>v.toFixed(2)}/>
              <RangeRow label="Fidelity" value={fidelity} min={0} max={1} step={.05} onChange={v=>updateProfile({fidelity:v})} format={v=>v.toFixed(2)}/>
              <RangeRow label="Paper texture" value={paperGrain} min={0} max={1} step={.05} onChange={v=>updateProfile({paperGrain:v})} format={v=>v.toFixed(2)}/>
              <label className="studio-check"><input type="checkbox" checked={useModels} onChange={e=>updateProfile({useModels:e.target.checked})}/> Use local vision models</label>
              {engineId==='v2'&&<AdaptiveControls settings={adaptive} onChange={(v:AdaptiveSettings)=>updateProfile({adaptive:v})}/>}
              <button type="button" className="studio-button w-full" disabled={!referenceFile.current} onClick={applySettings}>Apply and clear drawing</button>
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
              onClick={() => {setLeftOpen(!leftOpen);if(!leftOpen&&matchMedia('(max-width: 670px)').matches)setRightOpen(false);}}
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
              onClick={() => {setRightOpen(!rightOpen);if(!rightOpen&&matchMedia('(max-width: 670px)').matches)setLeftOpen(false);}}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
              aria-label={rightOpen ? 'Collapse instruments panel' : 'Expand instruments panel'}
            >
              {rightOpen ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
          </div>

          <div
            ref={canvasWrapRef}
            className={`relative m-2 mt-1 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border paper-surface transition-colors ${
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
                <p className="paper-label text-[13px]">Drop a reference image here</p>
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
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="flex items-center gap-1">
                {!running && !done && (!state.snapshot || state.snapshot.stage==='observation') && (
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
                {!running && !done && state.snapshot && state.snapshot.stage!=='observation' && (
                  <button
                    type="button"
                    onClick={resume}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-85"
                  >
                    <Play size={14} strokeWidth={2} /> Resume
                  </button>
                )}
                {engineId==='v2'&&done&&<button type="button" className="studio-button strong" onClick={engine.refine}>Continue refining</button>}
                {engineId==='v2'&&!!state.snapshot?.recorded&&<button type="button" className="studio-button" onClick={engine.replay}>Replay</button>}
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
                  onClick={applySettings}
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
            {engineId==='v2'&&!!state.snapshot?.recorded&&<label className="flex items-center gap-3 px-3 pb-1 text-[11px] text-neutral-500">
              <span>Timeline</span><input className="min-w-0 flex-1" type="range" aria-label="Recorded stroke timeline" min={0}
                max={state.snapshot.recorded} value={state.snapshot.position??state.snapshot.recorded}
                onChange={e=>engine.seek(Number(e.target.value))}/>
              <span>{state.snapshot.position??state.snapshot.recorded} / {state.snapshot.recorded}</span>
            </label>}
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
          {compareOpen&&<BenchmarkPanel reference={referenceUrl} status={state.benchmarkStatus}
            results={state.benchmark} run={value=>engine.compare(value,profiles.v2)} cancel={engine.stopBenchmark}
            close={()=>{engine.stopBenchmark();setCompareOpen(false);}}/>}
        </main>

        {/* right rail */}
        <aside
          data-open={rightOpen} className={`studio-rail studio-right ${rightOpen ? 'w-64' : 'w-0'} shrink-0 overflow-hidden border-l border-neutral-200 bg-white transition-[width] duration-300 ease-in-out`}
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
        className={`${diagOpen ? 'h-56 overflow-y-auto' : 'h-0 overflow-hidden'} shrink-0 border-t border-neutral-200 bg-white transition-[height] duration-300 ease-in-out`}
        aria-label="Engine diagnostics"
      >
        {diagOpen&&(engineId==='v2'?<AdaptiveDiagnostics data={state.diagnostics} view={diagnosticView} onView={setDiagnosticView}/>
          :<DiagnosticsDrawer snapshot={state.snapshot} corrections={state.corrections} scene={state.scene}/>)}
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
        className="rounded-full border"
        style={{
          width: size,
          height: size,
          borderColor: '#000b',
          background: cursor.z > 0.4 ? 'transparent' : `rgba(0,0,0,${0.12 + pressure * 0.5})`,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.7)`,
        }}
      />
    </div>
  );
}


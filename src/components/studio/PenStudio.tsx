'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  instrumentNames,
  normalizeV4,
  stageNames,
  v4Balanced,
  v4Presets,
  type FromWorker,
  type SimOptions,
  type Telemetry,
  type ToWorker,
} from '@/engine/pen/types';
import type { Version } from './Workspace';

type Props = {
  file: File | null;
  project: File | null;
  select: (v: Version) => void;
  importFile: (f: File) => void;
  restoredFile: (f: File) => void;
  open: (f: File) => void;
};
type Status =
  | 'Import a reference'
  | 'Reading reference'
  | 'Analyzing'
  | 'Drawing'
  | 'Paused'
  | 'Complete'
  | 'Canceled'
  | 'Error';
type ExportKind = 'svg' | 'strokes' | 'events' | 'replay' | 'project' | 'rgba' | 'rgba-transparent';

function tileImage(rgba: Uint8ClampedArray, w: number, h: number) {
  return new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h);
}

const CONTROLS: Partial<Record<keyof SimOptions, string>> = {
  gesture: 'Gesture energy',
  construction: 'Construction guides',
  sensitivity: 'Contour sensitivity',
  continuity: 'Stroke continuity',
  pressure: 'Pressure response',
  shade: 'Shading intensity',
  hatch: 'Hatching density',
  detail: 'Detail refinement',
  motor: 'Motor fidelity',
};

const SPEEDS: [string, number][] = [
  ['0.5×', 0.5],
  ['1×', 1],
  ['2×', 2],
  ['4×', 4],
  ['8×', 8],
  ['MAX', Infinity],
];

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function preview(gray: Uint8Array, w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const im = ctx.createImageData(w, h);
  for (let i = 0; i < gray.length; i++) {
    im.data.fill(gray[i], 4 * i, 4 * i + 3);
    im.data[4 * i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c.toDataURL();
}

const km = (px: number) => (px > 12000 ? (px / 1000).toFixed(1) + 'k px' : Math.round(px) + ' px');

export default function PenStudio({ file, project, select, importFile, restoredFile, open }: Props) {
  const { theme, setTheme } = useTheme();
  const [opt, setOpt] = useState<SimOptions>(v4Balanced);
  const [speed, setSpeed] = useState(2);
  const [revision, restart] = useState(0);
  const [status, setStatus] = useState<Status>('Import a reference');
  const [error, setError] = useState('');
  const [ref, setRef] = useState('');
  const [size, setSize] = useState<[number, number]>([1, 1]);
  const dims = useRef<[number, number]>([1, 1]);
  const [zoom, setZoom] = useState(1);
  const [showPen, setShowPen] = useState(true);
  const [showTrails, setShowTrails] = useState(false);
  const [showAttention, setShowAttention] = useState(true);
  const [debug, setDebug] = useState(false);
  const [panel, setPanel] = useState<Telemetry | null>(null);
  const [decisions, setDecisions] = useState<{ t: number; stage: number; action: string; reason: string }[]>([]);
  const [downloading, setDownloading] = useState('');

  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const graph = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const send = useRef<(m: ToWorker) => void>(() => {});
  const telemetry = useRef<Telemetry | null>(null);
  const trails = useRef<{ x: number; y: number; z: number }[]>([]);
  const stats = useRef({ stepsPerSec: 0, lastSteps: 0, lastAt: 0 });

  useEffect(() => {
    try {
      const s = localStorage.getItem('nth-v4-options');
      if (s) setOpt(normalizeV4(JSON.parse(s)));
    } catch {}
  }, []);
  const change = useCallback((next: SimOptions) => {
    setOpt(next);
    try {
      localStorage.setItem('nth-v4-options', JSON.stringify(next));
    } catch {}
  }, []);

  // --- worker lifecycle -----------------------------------------------------
  useEffect(() => {
    let active = true;
    let worker: Worker | undefined;
    const generation = ++gen.current;
    telemetry.current = null;
    trails.current = [];
    setStatus(file ? 'Reading reference' : 'Import a reference');
    setError('');
    setRef('');
    setPanel(null);
    setDecisions([]);
    if (!file) return;

    function handle(r: FromWorker) {
      if (!active || generation !== gen.current) return;
      if (r.type === 'error') {
        setError(r.message);
        setStatus('Error');
        return;
      }
      if (r.type === 'ready') {
        dims.current = [r.w, r.h];
        setSize([r.w, r.h]);
        setRef(preview(r.preview, r.pw, r.ph));
        setStatus('Analyzing');
        send.current({ type: 'start', options: optRef.current });
        return;
      }
      if (r.type === 'analysis') {
        setError('');
        setStatus('Analyzing');
        return;
      }
      if (r.type === 'tiles') {
        const c = canvas.current;
        if (!c) return;
        if (c.width !== r.w || c.height !== r.h) {
          c.width = r.w;
          c.height = r.h;
          const o = overlay.current;
          if (o) {
            o.width = r.w;
            o.height = r.h;
          }
        }
        const ctx = c.getContext('2d')!;
        for (const t of r.tiles) ctx.putImageData(tileImage(t.rgba, t.w, t.h), t.x, t.y);
        if (r.tiles.length && statusRef.current === 'Analyzing') setStatus('Drawing');
        return;
      }
      if (r.type === 'telemetry') {
        telemetry.current = r.telemetry;
        const p = r.telemetry.pose;
        if (!p.contact) {
          const tr = trails.current;
          tr.push({ x: p.x, y: p.y, z: p.z });
          if (tr.length > 900) tr.shift();
        }
        if (statusRef.current === 'Analyzing' && r.telemetry.phase !== 'idle') setStatus('Drawing');
        return;
      }
      if (r.type === 'done') {
        setStatus('Complete');
        return;
      }
      if (r.type === 'stopped') {
        setStatus((s) => (s === 'Drawing' || s === 'Paused' ? 'Canceled' : s));
        return;
      }
      if (r.type === 'export') {
        if (r.kind === 'rgba' || r.kind === 'rgba-transparent') {
          if (typeof r.data === 'string') return;
          const rgba = new Uint8ClampedArray(r.data);
          const [w, h] = dims.current;
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
          c.toBlob((b) => {
            if (b) save(b, r.kind === 'rgba' ? 'nth-stroke-v4.png' : 'nth-stroke-v4-transparent.png');
            setDownloading('');
          });
          return;
        }
        save(new Blob([r.data], { type: r.mime }), r.name);
        setDownloading('');
        return;
      }
    }

    if (typeof Worker !== 'undefined') {
      worker = new Worker(new URL('../../engine/pen/pen.worker.ts', import.meta.url));
      worker.onmessage = ({ data }: { data: FromWorker }) => handle(data);
      send.current = (m) => worker!.postMessage(m);
      send.current({ type: 'open', file });
    } else {
      // Main-thread fallback: identical protocol, rAF-driven budget.
      import('./penFallback').then(({ createFallback }) => {
        if (!active) return;
        send.current = createFallback(handle);
        send.current({ type: 'open', file });
      });
    }
    return () => {
      active = false;
      worker?.terminate();
      send.current = () => {};
    };
  }, [file, revision, project]);

  const gen = useRef(0);
  const optRef = useRef(opt);
  const statusRef = useRef<Status>('Import a reference');
  optRef.current = opt;
  statusRef.current = status;

  // --- overlay render loop (pen, trails, attention, pressure graph) ----------
  useEffect(() => {
    let raf = 0;
    let lastDecisions = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = telemetry.current;
      const o = overlay.current;
      if (o && o.width) {
        const ctx = o.getContext('2d')!;
        ctx.clearRect(0, 0, o.width, o.height);
        const k = o.width / 900;
        if (t) {
          // attention region
          if (showAttention && t.attention) {
            ctx.strokeStyle = 'rgba(59,130,246,.5)';
            ctx.setLineDash([6 * k, 5 * k]);
            ctx.lineWidth = 1.2 * k;
            ctx.strokeRect(t.attention.x, t.attention.y, t.attention.w, t.attention.h);
            ctx.setLineDash([]);
          }
          // pen-up travel paths
          if (showTrails && trails.current.length > 1) {
            ctx.strokeStyle = 'rgba(56,189,248,.28)';
            ctx.lineWidth = 1.1 * k;
            ctx.beginPath();
            const start = Math.max(0, trails.current.length - 700);
            ctx.moveTo(trails.current[start].x, trails.current[start].y);
            for (let i = start + 1; i < trails.current.length; i++) ctx.lineTo(trails.current[i].x, trails.current[i].y);
            ctx.stroke();
          }
          const p = t.pose;
          if (showPen) {
            // pen body — leans opposite the azimuth, angle from tilt
            const bodyAngle = p.azimuth + Math.PI;
            const lean = 0.45 + p.tilt * 0.85;
            const len = o.height * 0.34 * (0.6 + 0.4 * lean);
            const bx = p.x + Math.cos(bodyAngle) * len * 0.42,
              by = p.y + Math.sin(bodyAngle) * len * 0.42 - len * 0.8;
            const grad = ctx.createLinearGradient(p.x, p.y, bx, by);
            grad.addColorStop(0, p.contact ? '#d3a35c' : '#8a8f98');
            grad.addColorStop(1, 'rgba(30,32,38,0)');
            ctx.strokeStyle = grad;
            ctx.lineWidth = 3.4 * k;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(bx, by);
            ctx.stroke();
            // nib
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(2, p.pressure * 5.5 * k + 1.6 * k), 0, Math.PI * 2);
            ctx.fillStyle = p.contact ? '#1c1d22' : 'rgba(120,125,135,.9)';
            ctx.fill();
            ctx.strokeStyle = p.contact ? '#f5b942' : 'rgba(148,163,184,.8)';
            ctx.lineWidth = 1.4 * k;
            ctx.stroke();
            // pressure arc
            if (p.contact) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, 10 * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.pressure);
              ctx.strokeStyle = '#f5b942';
              ctx.lineWidth = 2 * k;
              ctx.stroke();
            }
          }
        }
      }
      // pressure graph
      const g = graph.current;
      if (g && t) {
        const ctx = g.getContext('2d')!;
        const W = g.width,
          H = g.height;
        ctx.clearRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(148,163,184,.25)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(0, (H * i) / 4);
          ctx.lineTo(W, (H * i) / 4);
          ctx.stroke();
        }
        const n = Math.min(t.pressureCount, t.pressureHistory.length);
        if (n > 1) {
          const start = t.pressureCount > t.pressureHistory.length ? t.pressureCount % t.pressureHistory.length : 0;
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const v = t.pressureHistory[(start + i) % t.pressureHistory.length];
            const x = (i / (n - 1)) * W;
            const y = H - 2 - v * (H - 6);
            if (!i) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = '#f5b942';
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.lineTo(W, H);
          ctx.lineTo(0, H);
          ctx.closePath();
          ctx.fillStyle = 'rgba(245,185,66,.12)';
          ctx.fill();
        }
      }
      // throttled panel updates (4 Hz) — runs inside the rAF callback, not render
      const now = performance.now();
      if (t && now - stats.current.lastAt > 250) {
        const dt = (now - stats.current.lastAt) / 1000;
        stats.current.stepsPerSec = Math.round((t.steps - stats.current.lastSteps) / Math.max(0.001, dt));
        stats.current.lastSteps = t.steps;
        stats.current.lastAt = now;
        setPanel({ ...t });
        if (t.decisions.length !== lastDecisions) {
          lastDecisions = t.decisions.length;
          setDecisions(t.decisions.slice(-14).reverse());
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [showAttention, showTrails, showPen]);

  // --- transport ---------------------------------------------------------------
  function begin() {
    restart((r) => r + 1);
  }
  function pause() {
    send.current({ type: 'pause' });
    setStatus('Paused');
  }
  function resume() {
    send.current({ type: 'resume' });
    setStatus('Drawing');
  }
  function cancel() {
    send.current({ type: 'stop' });
    setStatus('Canceled');
  }
  function setRate(v: number) {
    setSpeed(v);
    send.current({ type: 'speed', value: v });
  }
  function request(kind: ExportKind) {
    setDownloading(String(kind));
    send.current({ type: 'export', kind });
  }

  const running = status === 'Drawing';
  const pose = panel?.pose;

  return (
    <div
      className="structural"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) open(f);
      }}
    >
      <header>
        <h1>NTH Stroke</h1>
        <select aria-label="Drawing engine" value="v4" onChange={(e) => select(e.target.value as Version)}>
          <option value="v4">V4 · Virtual Pen Artist</option>
          <option value="v3">V3 · Structural</option>
          <option value="v2">V2 · Adaptive</option>
          <option value="v1">V1 · Legacy</option>
        </select>
        <select aria-label="Theme" value={theme ?? 'dark'} onChange={(e) => setTheme(e.target.value)}>
          {['dark', 'light', 'system'].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <small>
          {status}
          {status === 'Analyzing' ? ' — the eye is observing the reference' : ''}
        </small>
        {running ? (
          <button onClick={pause}>Pause</button>
        ) : status === 'Paused' ? (
          <button className="strong" onClick={resume}>
            Resume
          </button>
        ) : null}
        {status === 'Drawing' || status === 'Paused' ? <button onClick={cancel}>Cancel</button> : null}
        <div className="pen-speed" role="group" aria-label="Playback speed">
          {SPEEDS.map(([label, v]) => (
            <button key={label} className={speed === v ? 'strong' : ''} onClick={() => setRate(v)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <main>
        <aside>
          <h2>Reference</h2>
          <button className="strong" onClick={() => input.current?.click()}>
            {file ? 'Replace reference' : 'Import reference'}
          </button>{' '}
          <button onClick={() => projectInput.current?.click()}>Open project</button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={projectInput}
            type="file"
            accept=".nth4,.nth3,.nth,application/octet-stream"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) open(f);
              e.target.value = '';
            }}
          />
          {ref && (
            <div className="v3ref">
              <img src={ref} alt="Reference" />
            </div>
          )}
          <small>
            {size[0]} × {size[1]} px source · working canvas {panel ? 'auto' : '—'}
          </small>

          <h2>Artist</h2>
          <label>
            Preset
            <select
              value={opt.preset}
              onChange={(e) => change(normalizeV4({ ...opt, ...v4Presets[e.target.value], preset: e.target.value }))}
            >
              {['Fast', 'Balanced', 'Illustrator', 'Extreme'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input
              type="number"
              value={opt.seed}
              onChange={(e) => change(normalizeV4({ ...opt, seed: +e.target.value || 1 }))}
            />
          </label>
          <label>
            Simulation rate
            <select
              value={opt.frequency}
              onChange={(e) => change(normalizeV4({ ...opt, frequency: +e.target.value as SimOptions['frequency'] }))}
            >
              <option value={120}>120 Hz</option>
              <option value={180}>180 Hz</option>
              <option value={240}>240 Hz</option>
            </select>
          </label>
          <label>
            Working resolution
            <select value={opt.resolution} onChange={(e) => change(normalizeV4({ ...opt, resolution: +e.target.value }))}>
              {[512, 768, 1024, 1400, 1792, 2048].map((r) => (
                <option key={r} value={r}>
                  {r} px
                </option>
              ))}
            </select>
          </label>
          <label>
            Stroke budget
            <input
              type="number"
              min={50}
              max={1000000}
              value={opt.budget}
              onChange={(e) => change(normalizeV4({ ...opt, budget: +e.target.value || 6000 }))}
            />
          </label>
          <label>
            Linework tool
            <select
              value={opt.lineworkTool}
              onChange={(e) => change(normalizeV4({ ...opt, lineworkTool: e.target.value as SimOptions['lineworkTool'] }))}
            >
              <option value="fineliner">Fine liner</option>
              <option value="dip">Manga dip pen</option>
              <option value="brush">Brush pen</option>
              <option value="graphite">Graphite pencil</option>
            </select>
          </label>
          <details open>
            <summary>Motor &amp; media</summary>
            {(Object.keys(CONTROLS) as (keyof SimOptions)[]).map((key) => (
              <label key={key}>
                {CONTROLS[key]}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={opt[key] as number}
                  onChange={(e) => change(normalizeV4({ ...opt, [key]: +e.target.value }))}
                />
              </label>
            ))}
            <label>
              Pen-event recording
              <select value={opt.maxEvents} onChange={(e) => change(normalizeV4({ ...opt, maxEvents: +e.target.value }))}>
                <option value={8000000}>Full (8M samples)</option>
                <option value={2000000}>Compact (2M)</option>
                <option value={0}>Off</option>
              </select>
            </label>
          </details>
          <button className="strong" style={{ width: '100%', marginTop: 10 }} onClick={begin} disabled={!file}>
            {status === 'Complete' ? 'Draw again' : 'Start drawing'}
          </button>
          {error && (
            <p role="alert" style={{ color: '#f87171' }}>
              {error}
            </p>
          )}

          <h2>Live pen</h2>
          <div className="pen-readout">
            <div>
              <span>Instrument</span>
              <strong>{pose ? instrumentNames[pose.instrument] : '—'}</strong>
            </div>
            <div>
              <span>Nib state</span>
              <strong className={pose?.contact ? 'pen-down' : 'pen-up'}>
                {pose ? (pose.contact ? 'pen down' : pose.down ? 'descending' : 'pen up') : '—'}
              </strong>
            </div>
            <div>
              <span>Pressure</span>
              <strong>{pose ? pose.pressure.toFixed(2) : '—'}</strong>
            </div>
            <div>
              <span>Speed</span>
              <strong>{pose ? Math.round(pose.speed) + ' px/s' : '—'}</strong>
            </div>
            <div>
              <span>Height</span>
              <strong>{pose ? pose.z.toFixed(2) + ' mm' : '—'}</strong>
            </div>
            <div>
              <span>Hand phase</span>
              <strong>{panel?.phase ?? '—'}</strong>
            </div>
          </div>
          <canvas ref={graph} width={196} height={56} className="pen-graph" aria-label="Live pressure" />
          <label className="v3check">
            <input type="checkbox" checked={showPen} onChange={(e) => setShowPen(e.target.checked)} /> Pen &amp; nib
          </label>
          <label className="v3check">
            <input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} /> Pen-up travel
          </label>
          <label className="v3check">
            <input type="checkbox" checked={showAttention} onChange={(e) => setShowAttention(e.target.checked)} /> Attention region
          </label>
          <label className="v3check">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Debug: decision log
          </label>
        </aside>

        <section>
          <div className="v3stage">
            <strong>
              {panel ? String.fromCharCode(65 + (panel.stage ?? 0)) + ' · ' + (panel.stageLabel ?? '') : 'Stage A · Observation'}
            </strong>
            <small>{panel?.objective ?? 'Waiting for the artist'}</small>
            <span className="spacer" />
            <label>
              Zoom
              <input type="range" min={0.4} max={5} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} />{' '}
              <small>{Math.round(zoom * 100)}%</small>
            </label>
          </div>
          <div className="v3viewport">
            <div className="v3paper" style={{ width: zoom * 100 + '%', height: zoom * 100 + '%' }}>
              <canvas ref={canvas} width={2} height={2} />
              <canvas ref={overlay} width={2} height={2} className="pen-overlay" />
            </div>
          </div>
          <div className="v3metrics">
            <span>
              Strokes <b>{panel?.strokes ?? 0}</b>
            </span>
            <span>
              Lifts <b>{panel?.lifts ?? 0}</b>
            </span>
            <span>
              Travel <b>{panel ? km(panel.travel) : '—'}</b>
            </span>
            <span>
              In contact <b>{panel ? km(panel.drawn) : '—'}</b>
            </span>
            <span>
              SSIM <b>{panel?.quality ? panel.quality.ssim.toFixed(3) : '—'}</b>
            </span>
            <span>
              Edge <b>{panel?.quality ? panel.quality.edge.toFixed(2) : '—'}</b>
            </span>
            <span>
              Missing <b>{panel?.quality ? (panel.quality.missing * 100).toFixed(1) + '%' : '—'}</b>
            </span>
            <span>
              Excess <b>{panel?.quality ? (panel.quality.excess * 100).toFixed(1) + '%' : '—'}</b>
            </span>
            <span>
              Sim <b>{panel ? Math.round(panel.simTime) + 's @ ' + Math.round(stats.current.stepsPerSec) + '/s' : '—'}</b>
            </span>
            <span className="spacer" />
            {(['svg', 'strokes', 'events', 'replay', 'project', 'rgba', 'rgba-transparent'] as const).map((kind) => (
              <button key={kind} disabled={!panel || downloading === kind} onClick={() => request(kind)}>
                {downloading === kind
                  ? '…'
                  : kind === 'svg'
                    ? 'SVG'
                    : kind === 'strokes'
                      ? 'Strokes JSON'
                      : kind === 'events'
                        ? 'Pen events'
                        : kind === 'replay'
                          ? 'Replay file'
                          : kind === 'project'
                            ? 'Project'
                            : kind === 'rgba'
                              ? 'PNG'
                              : 'PNG α'}
              </button>
            ))}
          </div>
          {debug && (
            <div className="pen-log" aria-label="Virtual artist decisions">
              <h2 style={{ margin: '0 0 6px' }}>Decision log — what the artist is thinking</h2>
              {decisions.length === 0 && <small>No decisions yet.</small>}
              {decisions.map((d, i) => (
                <div key={i} className="pen-decision">
                  <span className="pen-when">
                    {d.t.toFixed(1)}s · {String.fromCharCode(65 + d.stage)}
                  </span>
                  <span className="pen-what">{d.action}</span>
                  <span className="pen-why">{d.reason}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      <footer>
        <label>
          Stage:{' '}
          {stageNames.map((s, i) => (
            <span key={s} className={'pen-stage' + (panel && panel.stage === i ? ' active' : '')}>
              {String.fromCharCode(65 + i)}
            </span>
          ))}
        </label>
        <span className="spacer" />
        <small>
          V4 draws through a physically simulated pen — every mark comes from nib contact, pressure and motion.
        </small>
      </footer>
    </div>
  );
}

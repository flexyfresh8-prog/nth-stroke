'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  balanced,
  normalize,
  presets,
  layers,
  stages,
  type Options,
  type Hint,
  type Layer,
} from '@/engine/structural/settings';
import { apply, paint, svg, type Action, type Placed } from '@/engine/structural/geometry';
import { pack, unpack, type Checkpoint } from '@/engine/structural/project';
import type { Request, Reply } from '@/engine/structural/driver';
import type { Step } from '@/engine/structural/engine';
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
  | 'Ready'
  | 'Drawing'
  | 'Paused'
  | 'Complete'
  | 'Error'
  | 'Restoring';
const controls: Partial<Record<keyof Options, string>> = {
  construction: 'Construction strength',
  sensitivity: 'Contour sensitivity',
  continuity: 'Stroke continuity',
  pressure: 'Pressure variation',
  shade: 'Shading intensity',
  hatch: 'Hatching density',
  detail: 'Detail preservation',
  segmentation: 'Segmentation sensitivity',
};
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
  const ctx = c.getContext('2d')!,
    im = ctx.createImageData(w, h);
  for (let i = 0; i < gray.length; i++) {
    im.data.fill(gray[i], 4 * i, 4 * i + 3);
    im.data[4 * i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c.toDataURL();
}
export default function StructuralStudio({ file, project, select, importFile, restoredFile, open }: Props) {
  const { theme, setTheme } = useTheme(),
    [opt, setOpt] = useState<Options>(balanced),
    [speed, setSpeed] = useState(8),
    [revision, restart] = useState(0);
  const [status, setStatus] = useState<Status>('Import a reference'),
    [error, setError] = useState(''),
    [ref, setRef] = useState(''),
    [size, setSize] = useState([1, 1]),
    [count, setCount] = useState(0),
    [stats, setStats] = useState<Step>({ stage: 0, progress: 0 }),
    [eta, setEta] = useState('—');
  const [mask,setMask]=useState(''),[showMask,setShowMask]=useState(false);
  const [zoom, setZoom] = useState(1),
    [overlay, setOverlay] = useState(0),
    [hidden, setHidden] = useState<Layer[]>([]),
    [hints, setHints] = useState<Hint[]>([]),
    [hint, setHint] = useState('Off'),
    [replaying, setReplay] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    input = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null);
  const history = useRef<Action[]>([]),
    placed = useRef<Placed[]>([]),
    cursor = useRef(0),
    send = useRef<(m: Request) => void>(() => {}),
    running = useRef(false),
    waiting = useRef(false),
    batch = useRef<Step[]>([]),
    finished = useRef(false),
    doneFlag = useRef(false),
    session = useRef<Checkpoint | null>(null);
  const source = useRef<File | null>(null),
    settings = useRef(opt),
    saved = useRef<Awaited<ReturnType<typeof unpack>> | null>(null),
    loaded = useRef(false);
  const clock = useRef(0),
    pace = useRef(speed),
    hide = useRef(hidden),
    dims = useRef(size),
    stepInfo = useRef<Step>({ stage: 0, progress: 0 });
  const tip = useRef<SVGPathElement>(null);
  const replayAt = useRef(-1),
    generation = useRef(0);
  pace.current = speed;
  hide.current = hidden;
  settings.current = opt;
  useEffect(() => {
    try {
      const s = localStorage.getItem('nth-v3-options');
      if (s) setOpt(normalize(JSON.parse(s)));
    } catch {}
  }, []);
  function change(next: Options) {
    setOpt(next);
    try {
      localStorage.setItem('nth-v3-options', JSON.stringify(next));
    } catch {}
  }
  const visible = (v: Placed) =>
    !hide.current.includes(v.mark.layer) &&
    (!hide.current.includes('Background') || v.mark.subject) &&
    (!hide.current.includes('Subject') || !v.mark.subject);
  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.resetTransform();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(c.width / dims.current[0], 0, 0, c.height / dims.current[1], 0, 0);
    for (const v of placed.current) if (visible(v)) paint(ctx, v);
  }, []);
  useEffect(redraw, [hidden, size, redraw]);
  useEffect(() => {
    if (!project) return;
    let active = true;
    unpack(project)
      .then((v) => {
        if (active) {
          saved.current = v;
          change(v.state.options);
          setHints(v.state.hints);
          restoredFile(v.ref);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [project, restoredFile]);
  useEffect(() => {
    const token = ++generation.current;
    let active = true,
      worker: Worker | undefined,
      frame = 0,
      tick = 0,
      last = 0,
      usingFallback = false;
    const restore = project && saved.current?.ref === file ? saved.current : null;
    source.current = file;
    running.current = false;
    waiting.current = false;
    finished.current = false;
    doneFlag.current = false;
    loaded.current = false;
    session.current = null;
    batch.current = [];
    history.current = [];
    placed.current = [];
    cursor.current = 0;
    replayAt.current = -1;
    setReplay(false);
    setStatus(file ? 'Reading reference' : 'Import a reference');
    setRef('');setMask('');setShowMask(false);
    setCount(0);
    setZoom(1);
    setOverlay(0);
    setError('');
    setEta('—');
    stepInfo.current = { stage: 0, progress: 0 };
    setStats(stepInfo.current);
    if (!restore) setHints([]);
    redraw();
    if (tip.current) tip.current.style.visibility = 'hidden';
    if (!file) return;
    let drawingUntil = 0;
    function consume(a: Action) {
      apply(placed.current, a);
      if (a.kind !== 'add') {
        redraw();
        return;
      }
      const last = placed.current.at(-1)!;
      if (visible(last)) paint(canvas.current!.getContext('2d')!, last);
    }
    function reply(r: Reply) {
      if (!active || token !== generation.current) return;
      if (r.type === 'error') {
        running.current = false;
        setError(r.message);
        setStatus('Error');
        return;
      }
      if (r.type === 'ready') {
        dims.current = [r.w, r.h];
        setSize(dims.current);
        setRef(preview(r.preview, r.pw, r.ph));
        const c = canvas.current!;
        const k = Math.min(1, 1600 / Math.max(r.w, r.h));
        c.width = Math.max(1, Math.round(r.w * k));
        c.height = Math.max(1, Math.round(r.h * k));
        loaded.current = true;
        setStatus('Ready');
        if (restore) {
          history.current = restore.history;
          for (const a of restore.history) apply(placed.current, a);
          cursor.current = restore.state.steps;
          session.current = restore.state;
          setCount(placed.current.length);
          doneFlag.current = restore.state.complete;
          setStatus(restore.state.complete ? 'Complete' : 'Restoring');
          if (!restore.state.complete)
            send.current({
              type: 'start',
              options: restore.state.options,
              hints: restore.state.hints,
              skip: cursor.current,
            });
        }
        redraw();
        return;
      }
      if (r.type === 'started') {
        setMask(preview(r.mask.map(v=>v?235:42),r.w,r.h));
        waiting.current = false;
        setStatus(running.current ? 'Drawing' : 'Paused');
        return;
      }
      batch.current.push(...r.steps);
      finished.current = r.done;
      waiting.current = false;
    }
    async function fallback() {
      worker?.terminate();
      usingFallback = true;
      const { driver } = await import('@/engine/structural/driver');
      if (!active) return;
      const receive = driver(reply);
      send.current = (m) => {
        setTimeout(() => {
          if (active) void receive(m);
        }, 0);
      };
      send.current({ type: 'open', file: file! });
    }
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') void fallback();
    else {
      worker = new Worker(new URL('../../engine/structural/structural.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = ({ data: r }: MessageEvent<Reply>) => {
        if (r.type === 'error' && !loaded.current && !usingFallback) {
          void fallback();
        } else reply(r);
      };
      worker.onerror = (e) => {
        if (!loaded.current && !usingFallback) {
          e.preventDefault();
          void fallback();
        } else reply({ type: 'error', message: e.message || 'Drawing worker stopped.' });
      };
      send.current = (m) => worker!.postMessage(m);
      send.current({ type: 'open', file });
    }
    function loop(now: number) {
      if (!active) return;
      if (replayAt.current >= 0) {
        for (let n = 0; n < pace.current && replayAt.current < history.current.length; n++)
          consume(history.current[replayAt.current++]);
        setCount(placed.current.length);
        if (replayAt.current >= history.current.length) {
          replayAt.current = -1;
          setReplay(false);
        }
      } else if (running.current && now - last >= Math.max(0, 75 / pace.current - 1)) {
        last = now;
        let n = 0;
        while (batch.current.length && n++ < pace.current) {
          const next = batch.current[0],
            m = next.action?.kind === 'add' ? next.action.mark : null;
          if (m?.axis && pace.current <= 8 && tip.current) {
            if (!drawingUntil) {
              const duration =
                Math.max(32, Math.min(700, (1000 * m.length * 384) / Math.max(...dims.current) / m.speed)) /
                Math.sqrt(pace.current);
              drawingUntil = now + duration;
              const path = tip.current;
              path.getAnimations().forEach((a) => a.cancel());
              path.setAttribute('d', m.axis);
              path.setAttribute('stroke-width', String(m.width));
              path.setAttribute('opacity', String(m.opacity));
              path.style.visibility = 'visible';
              path.animate([{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], {
                duration,
                easing: 'ease-in-out',
                fill: 'forwards',
              });
              break;
            }
            if (now < drawingUntil) break;
          }
          drawingUntil = 0;
          if (tip.current) tip.current.style.visibility = 'hidden';
          const step = batch.current.shift()!;
          cursor.current++;
          if (step.action) {
            history.current.push(step.action);
            consume(step.action);
          }
          stepInfo.current = { ...step, quality: step.quality ?? stepInfo.current.quality };
        }
        if (!batch.current.length && finished.current) {
          running.current = false;
          doneFlag.current = true;
          setStatus('Complete');
        }
        if (!batch.current.length && running.current && !waiting.current) {
          waiting.current = true;
          send.current({ type: 'next', count: Math.max(1, pace.current) });
        }
        if (now - tick > 100 || !running.current) {
          tick = now;
          setStats({ ...stepInfo.current });
          setCount(placed.current.length);
          const progress = stepInfo.current.progress;
          setEta(
            progress > 0.015 && progress < 1
              ? Math.ceil((((now - clock.current) / 1000) * (1 - progress)) / progress) + 's'
              : '—',
          );
        }
      }
      frame = requestAnimationFrame(loop);
    }
    frame = requestAnimationFrame(loop);
    return () => {
      active = false;
      running.current = false;
      worker?.terminate();
      cancelAnimationFrame(frame);
      send.current = () => {};
    };
  }, [file, project, revision, redraw]);
  const locked = !!session.current,
    ready = loaded.current;
  function play() {
    if (!ready || replaying) return;
    if (running.current) {
      running.current = false;
      tip.current?.getAnimations().forEach((a) => a.pause());
      setStatus('Paused');
      return;
    }
    if (doneFlag.current) return;
    if (!session.current) {
      const options = normalize(opt);
      session.current = { options, hints: [...hints], steps: 0, complete: false };
      waiting.current = true;
      send.current({ type: 'start', options, hints, skip: 0 });
      clock.current = performance.now();
    }
    tip.current?.getAnimations().forEach((a) => a.play());
    running.current = true;
    setStatus('Drawing');
  }
  async function output(kind: string) {
    if (!source.current || replaying) return;
    const name = 'nth-stroke-v3',
      all = placed.current.filter(visible),
      [w, h] = dims.current;
    try {
      if (kind === 'svg') save(new Blob([svg(all, w, h)], { type: 'image/svg+xml' }), name + '.svg');
      else if (kind === 'project')
        save(
          pack(
            source.current,
            {
              options: session.current?.options ?? opt,
              hints: session.current?.hints ?? hints,
              steps: cursor.current,
              complete: doneFlag.current,
            },
            history.current,
          ),
          name + '.nth',
        );
      else if (kind === 'json')
        save(
          new Blob(
            [
              '{"application":"NTH Stroke V3","size":',
              JSON.stringify([w, h]),
              ',"actions":[',
              ...history.current.map((a, i) => (i ? ',' : '') + JSON.stringify(a)),
              ']}',
            ],
            { type: 'application/json' },
          ),
          name + '.json',
        );
      else {
        let blob: Blob;
        if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
          const writer = new Worker(new URL('../../engine/structural/export.worker.ts', import.meta.url), {
            type: 'module',
          });
          try {
            blob = await new Promise<Blob>((resolve, reject) => {
              writer.onmessage = ({ data }) => (data.error ? reject(Error(data.error)) : resolve(data.blob));
              writer.onerror = (e) => reject(Error(e.message));
              writer.postMessage({ marks: all, w, h, white: kind === 'png' });
            });
          } finally {
            writer.terminate();
          }
        } else {
          const { exportPng } = await import('@/engine/structural/export-png');
          blob = await exportPng(all, w, h, kind === 'png');
        }
        save(blob, name + (kind === 'png' ? '.png' : '-transparent.png'));
      }
    } catch (e) {
      setError(String(e));
    }
  }
  function picked(f: File) {
    if (/\.(nth|json)$/i.test(f.name)) open(f);
    else importFile(f);
  }
  return (
    <div
      className="structural"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) picked(e.dataTransfer.files[0]);
      }}
    >
      <header>
        <h1>NTH Stroke</h1>
        <select aria-label="Drawing engine" value="v3" onChange={(e) => select(e.target.value as Version)}>
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
        <button onClick={() => input.current?.click()}>Import</button>
        <button onClick={() => projectInput.current?.click()}>Open .nth</button>
        <select
          aria-label="Export"
          value=""
          disabled={!ready || replaying}
          onChange={(e) => void output(e.target.value)}
        >
          <option value="">Export</option>
          <option value="svg">Layered SVG</option>
          <option value="png">PNG · paper</option>
          <option value="transparent">Transparent PNG</option>
          <option value="json">Stroke sequence JSON</option>
          <option value="project">Resumable project</option>
        </select>
        <input
          hidden
          type="file"
          accept="image/*"
          ref={input}
          onChange={(e) => {
            if (e.target.files?.[0]) importFile(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <input
          hidden
          type="file"
          accept=".nth,.json"
          ref={projectInput}
          onChange={(e) => {
            if (e.target.files?.[0]) open(e.target.files[0]);
            e.target.value = '';
          }}
        />
      </header>
      <main>
        <aside>
          <h2>Reference</h2>
          {ref ? (
            <div
              className="v3ref"
              onClick={(e) => {
                if (hint === 'Off' || locked) return;
                const b = e.currentTarget.getBoundingClientRect();
                setHints([
                  ...hints,
                  {
                    x: (e.clientX - b.left) / b.width,
                    y: (e.clientY - b.top) / b.height,
                    subject: hint === 'Foreground',
                  },
                ]);
              }}
            >
              <img src={showMask&&mask?mask:ref} alt={showMask?"Subject mask":"Reference"} />
              {hints.map((p, i) => (
                <i key={i} style={{ left: p.x * 100 + '%', top: p.y * 100 + '%' }}>
                  {p.subject ? '+' : '−'}
                </i>
              ))}
            </div>
          ) : (
            <button onClick={() => input.current?.click()}>Choose image</button>
          )}
          {file && (
            <small>
              {file.name}
              {ready ? ' · ' + size.join(' × ') : ''}
            </small>
          )}
          {mask&&<label className="v3check"><input type="checkbox" checked={showMask} onChange={e=>setShowMask(e.target.checked)}/>Subject mask</label>}
          <h2>Generation</h2>
          <fieldset disabled={locked}>
            <label>
              Preset
              <select
                aria-label="Preset"
                value={opt.preset}
                onChange={(e) => change({ ...presets[e.target.value], seed: opt.seed })}
              >
                {Object.keys(presets).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Stroke budget
              <input
                type="number"
                min="1000"
                max="1000000"
                value={opt.budget}
                onChange={(e) => change({ ...opt, budget: Number(e.target.value) })}
                onBlur={() => change({ ...opt, budget: Math.min(1000000, Math.max(1000, opt.budget)) })}
              />
            </label>
            <details>
              <summary>Advanced settings</summary>
              <label>
                Seed
                <input
                  type="number"
                  value={opt.seed}
                  onChange={(e) => change({ ...opt, seed: Number(e.target.value) })}
                />
              </label>
              <label>
                Maximum resolution
                <select
                  value={opt.resolution}
                  onChange={(e) => change({ ...opt, resolution: Number(e.target.value) })}
                >
                  {[128, 256, 512, 1024, 2048, 4096, 8192, 16384].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              {Object.entries(controls).map(([k, title]) => (
                <label key={k}>
                  {title}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value={Number(opt[k as keyof Options])}
                    onChange={(e) => change({ ...opt, [k]: Number(e.target.value) })}
                  />
                </label>
              ))}
              <label>
                Optimization passes
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={opt.iterations}
                  onChange={(e) =>
                    change({ ...opt, iterations: Math.min(10, Math.max(0, Number(e.target.value))) })
                  }
                />
              </label>
              <label>
                Performance
                <select
                  value={opt.performance}
                  onChange={(e) => change({ ...opt, performance: e.target.value as Options['performance'] })}
                >
                  <option>Standard</option>
                  <option>Compact</option>
                </select>
              </label>
              <label>
                Tap reference to mark
                <select value={hint} onChange={(e) => setHint(e.target.value)}>
                  <option>Off</option>
                  <option>Foreground</option>
                  <option>Background</option>
                </select>
              </label>
              {!!hints.length && <button onClick={() => setHints([])}>Clear hints</button>}
            </details>
          </fieldset>
          <details>
            <summary>Layers & comparison</summary>
            {layers.map((l) => (
              <label className="v3check" key={l}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(l)}
                  onChange={() =>
                    setHidden(hidden.includes(l) ? hidden.filter((v) => v !== l) : [...hidden, l])
                  }
                />
                {l}
              </label>
            ))}
            <label>
              Reference overlay
              <input
                type="range"
                min="0"
                max="1"
                step=".01"
                value={overlay}
                onChange={(e) => setOverlay(+e.target.value)}
              />
            </label>
          </details>
        </aside>
        <section>
          <div className="v3stage">
            <span>{status}</span>
            <strong>{ready && session.current ? stages[stats.stage] : ''}</strong>
            <span>{Math.round(stats.progress * 100)}%</span>
          </div>
          <div className="v3viewport">
            <div className="v3paper" style={{ width: zoom * 100 + '%', height: zoom * 100 + '%' }}>
              <canvas ref={canvas} aria-label="Structural drawing" />
              <svg className="v3tip" viewBox={'0 0 ' + size.join(' ')} aria-hidden="true">
                <path
                  ref={tip}
                  fill="none"
                  stroke="black"
                  strokeLinecap="round"
                  pathLength="1"
                  strokeDasharray="1 1"
                />
              </svg>
              {overlay > 0 && ref && (
                <img src={ref} alt="Reference comparison" style={{ opacity: overlay }} />
              )}
            </div>
          </div>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button
              className="strong"
              disabled={!ready || status === 'Complete' || status === 'Restoring' || replaying}
              onClick={play}
            >
              {status === 'Drawing' ? 'Pause' : status === 'Paused' ? 'Resume' : 'Start'}
            </button>
            <button
              disabled={!file}
              onClick={() => {
                saved.current = null;
                restart((n) => n + 1);
              }}
            >
              Reset
            </button>
            <button
              disabled={status === 'Drawing' || replaying || !count}
              onClick={() => {
                placed.current = [];
                redraw();
                replayAt.current = 0;
                setReplay(true);
              }}
            >
              Replay
            </button>
            <label>
              Speed
              <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                {[1, 4, 8, 32, 256].map((n) => (
                  <option value={n} key={n}>
                    {n === 256 ? 'Max' : n + '×'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Zoom
              <select aria-label="Zoom" value={zoom} onChange={(e) => setZoom(+e.target.value)}>
                {[1, 2, 4, 8].map((n) => (
                  <option value={n} key={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
          </footer>
          <div className="v3metrics">
            <span>{count.toLocaleString()} marks</span>
            <span>SSIM {stats.quality?.ssim.toFixed(3) ?? '—'}</span>
            <span>Edge accuracy {stats.quality ? (stats.quality.edges * 100).toFixed(1) + '%' : '—'}</span>
            <span>ETA {status === 'Drawing' ? eta : '—'}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

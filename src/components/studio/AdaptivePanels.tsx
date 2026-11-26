'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ADAPTIVE_DEFAULTS,
  PRESETS,
  PRESET_TUNING,
  type AdaptiveSettings,
  type Preset,
} from '@/engine/adaptive/config';
import { MAPS, type MapName } from '@/engine/adaptive/diagnostics';
import type { Accuracy } from '@/engine/adaptive/metrics';
import type { BenchmarkResult, FromWorker } from '@/engine/worker/protocol';

const knobs: Array<
  [
    keyof Pick<
      AdaptiveSettings,
      'structure' | 'tone' | 'features' | 'naturalness' | 'correction' | 'pressure' | 'convergence'
    >,
    string,
  ]
> = [
  ['structure', 'Structural priority'],
  ['tone', 'Tonal priority'],
  ['features', 'Feature preservation'],
  ['naturalness', 'Stroke naturalness'],
  ['correction', 'Correction intensity'],
  ['pressure', 'Pressure sensitivity'],
  ['convergence', 'Convergence threshold'],
];

export function AdaptiveControls({
  settings,
  onChange,
}: {
  settings: AdaptiveSettings;
  onChange: (s: AdaptiveSettings) => void;
}) {
  return (
    <>
      <label className="studio-field">
        Drawing preset
        <select
          value={settings.preset}
          onChange={(event) => {
            const preset = event.target.value as Preset;
            onChange({
              ...settings,
              ...ADAPTIVE_DEFAULTS,
              ...PRESET_TUNING[preset],
              preset,
              automatic: settings.automatic,
              maxSeconds: settings.maxSeconds,
            });
          }}
        >
          {PRESETS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={settings.automatic}
          onChange={(event) => onChange({ ...settings, automatic: event.target.checked })}
        />{' '}
        Stop at convergence
      </label>
      <details className="studio-disclosure">
        <summary>Adaptive controls</summary>
        <div className="space-y-2 pt-2">
          <label className="studio-field">
            Performance
            <select
              value={settings.performance ?? 'auto'}
              onChange={(e) =>
                onChange({ ...settings, performance: e.target.value as AdaptiveSettings['performance'] })
              }
            >
              <option value="auto">Automatic</option>
              <option value="compact">Compact canvas</option>
              <option value="quality">Full detail</option>
            </select>
          </label>
          <label className="studio-field">
            Compute limit in seconds
            <input
              type="number"
              min={0}
              max={1200}
              step={5}
              value={settings.maxSeconds}
              onChange={(e) =>
                onChange({ ...settings, maxSeconds: Math.min(1200, Math.max(0, Number(e.target.value))) })
              }
            />
            <small>0 uses the stroke budget alone.</small>
          </label>
          {knobs.map(([key, label]) => (
            <label className="studio-field" key={key}>
              <span className="flex justify-between">
                {label}
                <output>{Math.round(settings[key] * 100)}%</output>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings[key]}
                onChange={(e) => onChange({ ...settings, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </details>
    </>
  );
}

type ImageDataView = { rgba: Uint8ClampedArray; width: number; height: number };
function RenderedImage({
  image,
  label,
  className,
}: {
  image: ImageDataView;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    const data = context.createImageData(image.width, image.height);
    data.data.set(image.rgba);
    context.putImageData(data, 0, 0);
  }, [image]);
  return <canvas ref={ref} aria-label={label} className={className ?? 'h-full w-full object-contain'} />;
}

const format = (v: number) => v.toFixed(3);
const measures: Array<[keyof Accuracy, string]> = [
  ['ssim', 'SSIM'],
  ['msSsim', 'MS-SSIM'],
  ['mae', 'Luminance MAE'],
  ['precision', 'Edge precision'],
  ['recall', 'Edge recall'],
  ['alignment', 'Contour alignment'],
  ['contrast', 'Contrast error'],
  ['features', 'Feature preservation'],
];

export function AccuracyPlot({ series }: { series: BenchmarkResult['history'][] }) {
  const max = Math.max(1, ...series.flat().map((p) => p.ms));
  return (
    <figure className="studio-plot">
      <svg
        viewBox="0 0 440 108"
        preserveAspectRatio="none"
        role="img"
        aria-label="SSIM over measured computation time"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <line key={i} x1={0} x2={440} y1={8 + 23 * i} y2={8 + 23 * i} stroke="currentColor" opacity={0.2} />
        ))}
        {series.map((rows, i) => (
          <polyline
            key={i}
            fill="none"
            strokeWidth={i ? 2.6 : 1.8}
            strokeDasharray={series.length > 1 && !i ? '5 4' : undefined}
            stroke="currentColor"
            opacity={series.length > 1 && !i ? 0.55 : 1}
            points={rows.map((p) => `${(p.ms / max) * 438},${8 + 92 * (1 - p.ssim)}`).join(' ')}
          />
        ))}
      </svg>
      <figcaption>
        <span>SSIM 0–1 · compute time</span>
        <span>{(max / 1000).toFixed(1)} s</span>
      </figcaption>
    </figure>
  );
}

export function AdaptiveDiagnostics({
  data,
  view,
  onView,
}: {
  data: Extract<FromWorker, { type: 'diagnostic' }> | null;
  view: MapName;
  onView: (v: MapName) => void;
}) {
  return (
    <div className="studio-diagnostics">
      <label className="studio-field">
        Analysis view
        <select value={view} onChange={(event) => onView(event.target.value as MapName)}>
          {MAPS.map((map) => (
            <option key={map}>{map}</option>
          ))}
        </select>
      </label>
      {data && (
        <>
          <div className="diagnostic-image">
            <RenderedImage image={data} label={data.view} />
          </div>
          <section>
            <p className="text-sm">
              {data.info.stage} · {data.info.instrument ?? 'rest'}
            </p>
            {data.info.region && (
              <p className="text-xs">
                Active region {data.info.region.x}, {data.info.region.y} · {data.info.region.w} ×{' '}
                {data.info.region.h}
              </p>
            )}
            {data.view === 'Facial landmarks' && (
              <p className="text-xs">
                Crosshairs indicate detected landmarks when local vision finds a face.
              </p>
            )}
            {data.view === 'Residual' && (
              <p className="text-xs">Lighter than midpoint needs pigment. Darker needs lifting.</p>
            )}
            {['Candidates', 'Rejected strokes'].includes(data.view) && (
              <ul className="mt-2 space-y-1 text-xs">
                {data.info.trials.slice(-8).map((trial, i) => (
                  <li key={i}>
                    {trial.instrument} · estimated gain {trial.gain.toFixed(4)}
                  </li>
                ))}
              </ul>
            )}
            {data.info.accuracy && (
              <dl className="diagnostic-metrics">
                {measures.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{format(data.info.accuracy![key])}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <AccuracyPlot series={[data.info.history]} />
        </>
      )}
    </div>
  );
}

export function BenchmarkPanel({
  reference,
  status,
  results,
  run,
  cancel,
  close,
}: {
  reference: string | null;
  status: string;
  results: BenchmarkResult[];
  run: (budget: number) => void;
  cancel: () => void;
  close: () => void;
}) {
  const [budget, setBudget] = useState(6000);
  const [divider, setDivider] = useState(50);
  const v1 = results.find((r) => r.engine === 'v1'),
    v2 = results.find((r) => r.engine === 'v2');
  return (
    <section className="benchmark-panel" aria-label="Engine benchmark">
      <header>
        <div>
          <h2>Compare engines</h2>
          <p>Same reference and stroke budget. Local models are disabled for both runs.</p>
        </div>
        <button className="studio-button" type="button" onClick={close}>
          Close
        </button>
      </header>
      <div className="benchmark-actions">
        <label className="studio-field">
          Stroke budget
          <input
            type="number"
            min={1000}
            max={100000}
            step={1000}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>
        {status ? (
          <button className="studio-button" onClick={cancel}>
            Stop benchmark
          </button>
        ) : (
          <button
            className="studio-button strong"
            onClick={() => run(Math.max(1000, Math.min(100000, budget || 6000)))}
            disabled={!reference}
          >
            Run benchmark
          </button>
        )}
        <span role="status">{status}</span>
      </div>
      <div className="benchmark-images">
        <figure>
          {reference && <img src={reference} alt="Original benchmark reference" />}
          <figcaption>Reference</figcaption>
        </figure>
        {[v1, v2].map((image, i) => (
          <figure key={i}>
            {image && <RenderedImage image={image} label={`V${i + 1} result`} />}
            <figcaption>
              V{i + 1} {i ? 'Adaptive' : 'Legacy'}
            </figcaption>
          </figure>
        ))}
      </div>
      {v1 && v2 && (
        <>
          <div className="benchmark-results">
            <table>
              <thead>
                <tr>
                  <th>Measure</th>
                  <th>V1</th>
                  <th>V2</th>
                </tr>
              </thead>
              <tbody>
                {measures.map(([key, label]) => (
                  <tr key={key}>
                    <th>{label}</th>
                    <td>{format(v1.accuracy[key])}</td>
                    <td>{format(v2.accuracy[key])}</td>
                  </tr>
                ))}
                <tr>
                  <th>Strokes</th>
                  <td>{v1.count}</td>
                  <td>{v2.count}</td>
                </tr>
                <tr>
                  <th>Compute time</th>
                  <td>{(v1.computeMs / 1000).toFixed(2)} s</td>
                  <td>{(v2.computeMs / 1000).toFixed(2)} s</td>
                </tr>
                <tr>
                  <th>Corrections</th>
                  <td>{v1.corrections}</td>
                  <td>{v2.corrections}</td>
                </tr>
                <tr>
                  <th>Peak heap</th>
                  <td>{v1.memory ? `${(v1.memory / 1048576).toFixed(1)} MiB` : 'Unavailable'}</td>
                  <td>{v2.memory ? `${(v2.memory / 1048576).toFixed(1)} MiB` : 'Unavailable'}</td>
                </tr>
              </tbody>
            </table>
            <div>
              <AccuracyPlot series={[v1.history, v2.history]} />
              <small>V1 dashed · V2 solid</small>
            </div>
          </div>
          <details className="studio-disclosure">
            <summary>Before and after divider</summary>
            <div className="benchmark-divider" style={{ aspectRatio: `${v2.width} / ${v2.height}` }}>
              <RenderedImage image={v1} label="Legacy result" />
              <div style={{ clipPath: `inset(0 ${100 - divider}% 0 0)` }}>
                <RenderedImage image={v2} label="Adaptive result" />
              </div>
              <i style={{ left: `${divider}%` }} />
            </div>
            <input
              aria-label="V2 before and after division"
              type="range"
              min={0}
              max={100}
              value={divider}
              onChange={(e) => setDivider(Number(e.target.value))}
            />
          </details>
        </>
      )}
    </section>
  );
}

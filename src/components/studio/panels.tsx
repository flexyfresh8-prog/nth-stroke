'use client';

/** Secondary studio panels: reference, instruments, metrics, diagnostics. */

import { useState } from 'react';
import { INSTRUMENT_IDS, type InstrumentId, type Stage, STAGE_ORDER } from '@/engine/core/types';
import { INSTRUMENTS } from '@/engine/media/instruments';
import type { EngineSnapshot } from '@/engine/core/types';
import type { SceneInfo } from './useEngineWorker';

export const STAGE_LABELS: Record<Stage, string> = {
  observation: 'A · Observe',
  construction: 'B · Construct',
  refinement: 'C · Refine',
  tonal: 'D · Block tone',
  shading: 'E · Shade',
  detail: 'F · Detail',
  correction: 'G · Correct',
  complete: 'Done',
};

export function StagePipeline({ stage }: { stage: Stage }) {
  const active = STAGE_ORDER.indexOf(stage);
  return (
    <div className="flex items-center gap-1 overflow-x-auto" aria-label="Artistic stage pipeline">
      {STAGE_ORDER.filter((s) => s !== 'observation').map((s) => {
        const idx = STAGE_ORDER.indexOf(s);
        const isActive = idx === active;
        const isDone = idx < active;
        return (
          <span
            key={s}
            className={[
              'whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] tracking-wide transition-colors duration-300',
              isActive
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : isDone
                  ? 'border-neutral-300 bg-neutral-100 text-neutral-500'
                  : 'border-neutral-200 text-neutral-400',
            ].join(' ')}
          >
            {STAGE_LABELS[s]}
          </span>
        );
      })}
    </div>
  );
}

export function ReferencePanel({
  referenceUrl,
  scene,
  fileName,
}: {
  referenceUrl: string | null;
  scene: SceneInfo | null;
  fileName: string | null;
}) {
  return (
    <section aria-label="Reference">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">Reference</h2>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {referenceUrl ? (
          <img src={referenceUrl} alt="Reference image" className="block max-h-56 w-full object-contain" />
        ) : (
          <div className="flex h-32 items-center justify-center text-[12px] text-neutral-300">No image imported</div>
        )}
      </div>
      {fileName && <p className="mt-1.5 truncate text-[11px] text-neutral-400">{fileName}</p>}
      {scene && (
        <div className="mt-2 flex flex-wrap gap-1">
          {scene.summary.map((s) => (
            <span key={s} className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10.5px] text-neutral-500">
              {s}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function InstrumentsPanel({
  activeInstrument,
  manualInstrument,
  onManualSelect,
}: {
  activeInstrument: InstrumentId | null;
  manualInstrument: InstrumentId | null;
  onManualSelect: (id: InstrumentId | null) => void;
}) {
  return (
    <section aria-label="Instruments">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">Instruments</h2>
      <div className="grid grid-cols-2 gap-1">
        {INSTRUMENT_IDS.map((id) => {
          const spec = INSTRUMENTS[id];
          const isActive = id === activeInstrument;
          const isManual = id === manualInstrument;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onManualSelect(isManual ? null : id)}
              className={[
                'flex min-h-[44px] flex-col items-start justify-center rounded-lg border px-2.5 py-1.5 text-left transition-all duration-200',
                isManual
                  ? 'border-neutral-900 bg-neutral-900 text-white'
                  : isActive
                    ? 'border-neutral-400 bg-neutral-50'
                    : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50',
              ].join(' ')}
              title={isManual ? 'Selected for drawing on the canvas yourself' : 'Choose to draw on the canvas yourself'}
            >
              <span className="text-[12px] font-medium leading-tight">{spec.label}</span>
              <span className={['text-[10px]', isManual ? 'text-neutral-300' : 'text-neutral-400'].join(' ')}>
                {isActive && !isManual ? 'in use · engine' : isManual ? 'in use · you' : spec.class}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-neutral-400">
        {manualInstrument
          ? 'Manual mode — draw directly on the canvas; the engine will observe and adapt.'
          : 'The engine chooses instruments itself. Select one to draw on the canvas yourself.'}
      </p>
    </section>
  );
}

function MetricBar({ label, value, invert = false }: { label: string; value: number; invert?: boolean }) {
  const good = invert ? 1 - value : value;
  return (
    <div className="min-w-[86px] flex-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-neutral-400">{label}</span>
        <span className="font-mono text-[11px] text-neutral-600">{(value * 100).toFixed(0)}</span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-neutral-200">
        <div className="h-full rounded-full bg-neutral-800 transition-[width] duration-500" style={{ width: `${Math.max(2, good * 100)}%` }} />
      </div>
    </div>
  );
}

export function MetricsBar({ snapshot }: { snapshot: EngineSnapshot | null }) {
  const m = snapshot?.metrics;
  return (
    <div className="flex w-full items-center gap-4 overflow-x-auto">
      <MetricBar label="SSIM" value={m?.ssim ?? 0} />
      <MetricBar label="Tone err" value={m?.toneError ?? 1} invert />
      <MetricBar label="Edges" value={m?.edgeAlignment ?? 0} />
      <MetricBar label="Contrast" value={m?.contrastError ?? 1} invert />
      <MetricBar label="Structure" value={m?.structureError ?? 1} invert />
      <div className="flex min-w-[130px] flex-col items-end">
        <span className="font-mono text-[11px] text-neutral-500">{snapshot ? `${snapshot.opCount} strokes` : '—'}</span>
        <span className="font-mono text-[11px] text-neutral-400">
          {snapshot ? formatSimTime(snapshot.simTimeMs) : '--:--'}
        </span>
      </div>
    </div>
  );
}

export function formatSimTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function DiagnosticsDrawer({
  snapshot,
  corrections,
  scene,
}: {
  snapshot: EngineSnapshot | null;
  corrections: Array<{ reason: string; t: number }>;
  scene: SceneInfo | null;
}) {
  const [tab, setTab] = useState<'corrections' | 'engine'>('corrections');
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 px-3 py-1.5">
        {(['corrections', 'engine'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={[
              'rounded-full px-2.5 py-1 text-[11px] capitalize transition-colors',
              tab === key ? 'bg-neutral-900 text-white' : 'text-neutral-400 hover:text-neutral-600',
            ].join(' ')}
          >
            {key === 'corrections' ? `Corrections (${corrections.length})` : 'Engine'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px] leading-relaxed">
        {tab === 'corrections' ? (
          corrections.length === 0 ? (
            <p className="text-neutral-400">No corrections yet. When the engine finds a mistake it will record why here.</p>
          ) : (
            <ol className="space-y-1.5">
              {[...corrections].reverse().map((c, i) => (
                <li key={i} className="rounded border border-neutral-200 bg-white px-2 py-1.5">
                  <span className="mr-1.5 font-mono text-[10px] text-neutral-400">{formatSimTime(c.t)}</span>
                  <span className="text-neutral-700">{c.reason}</span>
                </li>
              ))}
            </ol>
          )
        ) : (
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-neutral-400">Objective</dt>
            <dd className="text-neutral-700">{snapshot?.objective ?? '—'}</dd>
            <dt className="text-neutral-400">Phase</dt>
            <dd className="font-mono text-neutral-700">{snapshot?.phase ?? '—'}</dd>
            <dt className="text-neutral-400">Sim pressure</dt>
            <dd className="font-mono text-neutral-700">{snapshot ? snapshot.pressure.toFixed(2) : '—'}</dd>
            <dt className="text-neutral-400">Canvas</dt>
            <dd className="font-mono text-neutral-700">{scene ? `${scene.width}×${scene.height}` : '—'}</dd>
            <dt className="text-neutral-400">Vision models</dt>
            <dd className="text-neutral-700">{scene?.models.length ? scene.models.join(', ') : 'classical only'}</dd>
            <dt className="text-neutral-400">Seed</dt>
            <dd className="font-mono text-neutral-700">{scene?.seed ?? '—'}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

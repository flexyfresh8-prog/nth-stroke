'use client';

/**
 * Main-thread fallback driver for browsers without Worker support. It speaks
 * the exact same protocol as pen.worker.ts, running the identical Simulation
 * on rAF budget ticks. Determinism is unaffected: the step sequence only
 * depends on the fixed dt, not on who schedules it.
 */

import { decodeSource, reduce } from '@/engine/structural/source';
import { Simulation } from '@/engine/pen/sim';
import { eventsJSON, packProject, strokesJSON, svgExport, unpackProject } from '@/engine/pen/exporters';
import { normalizeV4, type FromWorker, type SimOptions, type ToWorker } from '@/engine/pen/types';

export function createFallback(handle: (r: FromWorker) => void) {
  let source: Awaited<ReturnType<typeof decodeSource>> | undefined;
  let refFile: Blob | undefined;
  let stashed: Awaited<ReturnType<typeof unpackProject>> | undefined;
  let sim: Simulation | undefined;
  let speed = 1;
  let carry = 0;
  let telemetryTick = 0;
  let raf = 0;
  const sizeBox = { w: 1, h: 1 };

  function tick() {
    if (!sim || sim.state !== 'running') return;
    const freq = sim.options.frequency;
    if (speed === Infinity) sim.run(1_000_000, 10);
    else {
      carry += speed * 0.016 * freq;
      const steps = Math.floor(carry);
      carry -= steps;
      if (steps > 0) sim.run(steps, 10);
    }
    const tiles = sim.collectTiles(140);
    if (tiles.length) handle({ type: 'tiles', w: sim.work.w, h: sim.work.h, tiles });
    if ((telemetryTick++ & 1) === 0) handle({ type: 'telemetry', telemetry: sim.telemetry() });
    const st: string = sim.state;
    if (st === 'done') handle({ type: 'done', quality: sim.quality });
    else raf = requestAnimationFrame(tick);
  }

  async function receive(m: ToWorker) {
    try {
      if (m.type === 'open') {
        cancelAnimationFrame(raf);
        sim = undefined;
        stashed = undefined;
        refFile = m.file;
        const head = new Uint8Array(await m.file.slice(0, 5).arrayBuffer());
        if (new TextDecoder().decode(head) === 'NTH4\n') {
          stashed = await unpackProject(m.file);
          source = await decodeSource(new Blob([stashed.ref]));
        } else source = await decodeSource(m.file);
        if (!source.gray.some((v) => v < 254)) throw Error('This reference has no visible marks after decoding.');
        const p = reduce(source, 384);
        sizeBox.w = source.w;
        sizeBox.h = source.h;
        handle({ type: 'ready', w: source.w, h: source.h, work: stashed?.workW ?? 0, preview: p.gray.slice(), pw: p.w, ph: p.h });
        return;
      }
      if (m.type === 'start') {
        if (!source) throw Error('Open a reference first.');
        const options: SimOptions = stashed ? normalizeV4({ ...m.options, ...stashed.resume.options }) : normalizeV4(m.options);
        sim = new Simulation(source, options);
        if (stashed) {
          sim.restore({ ...stashed.resume, options });
          if (sim.state !== 'done') sim.start();
        } else {
          sim.analyze((phase, progress) => handle({ type: 'analysis', phase, progress }));
          sim.start();
        }
        speed = 1;
        carry = 0;
        const tiles = sim.allTiles();
        handle({ type: 'tiles', w: sim.work.w, h: sim.work.h, tiles });
        handle({ type: 'telemetry', telemetry: sim.telemetry() });
        raf = requestAnimationFrame(tick);
        return;
      }
      if (m.type === 'speed') {
        speed = m.value <= 0 ? 1 : m.value >= 1000 ? Infinity : m.value;
        return;
      }
      if (m.type === 'pause') return sim?.pause();
      if (m.type === 'resume') {
        if (sim && sim.state === 'paused') {
          sim.resume();
          raf = requestAnimationFrame(tick);
        }
        return;
      }
      if (m.type === 'stop') {
        sim?.cancel();
        cancelAnimationFrame(raf);
        handle({ type: 'stopped' });
        return;
      }
      if (m.type === 'export' && sim) {
        const meta = {
          seed: sim.options.seed,
          simTime: sim.simTime,
          strokes: sim.strokes,
          lifts: sim.lifts,
          travel: sim.pen.travelTotal,
          quality: sim.quality ?? undefined,
        };
        if (m.kind === 'svg') handle({ type: 'export', kind: 'svg', name: 'nth-stroke-v4.svg', mime: 'image/svg+xml', data: svgExport(sim.paper, meta) });
        else if (m.kind === 'strokes')
          handle({ type: 'export', kind: 'strokes', name: 'nth-stroke-v4-strokes.json', mime: 'application/json', data: strokesJSON(sim.paper, meta) });
        else if (m.kind === 'events' || m.kind === 'replay')
          handle({
            type: 'export',
            kind: m.kind,
            name: `nth-stroke-v4${m.kind === 'replay' ? '-replay' : '-pen-events'}.json`,
            mime: 'application/json',
            data: eventsJSON(sim.recorder, meta, sim.options, m.kind === 'replay' ? 'replay' : 'events'),
          });
        else if (m.kind === 'project' && refFile) {
          const blob = await packProject(refFile, sim.serialize(), sim.work.w, sim.work.h, sim.nibScale);
          handle({ type: 'export', kind: 'project', name: 'nth-stroke-v4.nth4', mime: 'application/octet-stream', data: await blob.arrayBuffer() });
        } else if (m.kind === 'rgba' || m.kind === 'rgba-transparent') {
          const rgba = sim.paper.compositeAll(m.kind === 'rgba-transparent');
          handle({ type: 'export', kind: m.kind, name: m.kind, mime: '', data: rgba.buffer as ArrayBuffer });
        }
      }
    } catch (e) {
      handle({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (m: ToWorker) => void receive(m);
}

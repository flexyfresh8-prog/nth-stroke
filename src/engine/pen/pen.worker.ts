// V4 simulation worker. Owns the Simulation and drives it on a wall-clock
// interval: simulation frequency (120–240 Hz, fixed dt) is fully decoupled
// from display rate; the speed multiplier only changes HOW MANY deterministic
// steps run per tick, never the step content. Dirty tiles and telemetry are
// pushed to the UI thread; commands come back through onmessage.
// V5: createSimulation() returns the human-motor simulation when options.human > 0.

import { packProject, eventsJSON, strokesJSON, svgExport, unpackProject } from './exporters';
import { createSimulation } from './human';
import type { Simulation } from './sim';
import { decodeSource, reduce } from '../structural/source';
import { normalizeV4, type FromWorker, type SimOptions, type ToWorker } from './types';

let source: Awaited<ReturnType<typeof decodeSource>> | undefined;
let refFile: Blob | undefined;
let stashed: Awaited<ReturnType<typeof unpackProject>> | undefined;
let sim: Simulation | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let speed = 1;
let carry = 0;
let telemetryTick = 0;

const workerSelf = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void };
const post = (message: FromWorker, transfer?: Transferable[]) =>
  transfer ? workerSelf.postMessage(message, transfer) : workerSelf.postMessage(message);

function stopLoop() {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function tick() {
  if (!sim || sim.state !== 'running') {
    stopLoop();
    return;
  }
  const freq = sim.options.frequency;
  if (speed === Infinity) {
    sim.run(1_000_000, 12);
  } else {
    carry += speed * 0.016 * freq;
    const steps = Math.floor(carry);
    carry -= steps;
    if (steps > 0) sim.run(steps, 12);
  }
  const tiles = sim.collectTiles();
  if (tiles.length) {
    post(
      { type: 'tiles', w: sim.work.w, h: sim.work.h, tiles },
      tiles.map((t) => t.rgba.buffer),
    );
  }
  if ((telemetryTick++ & 1) === 0) post({ type: 'telemetry', telemetry: sim.telemetry() });
  const st: string = sim.state;
  if (st === 'done') {
    stopLoop();
    post({ type: 'done', quality: sim.quality });
  }
}

function startLoop() {
  stopLoop();
  timer = setInterval(tick, 16);
}

async function receive(m: ToWorker) {
  try {
    if (m.type === 'open') {
      stopLoop();
      sim = undefined;
      stashed = undefined;
      refFile = m.file;
      const head = new Uint8Array(await m.file.slice(0, 5).arrayBuffer());
      if (new TextDecoder().decode(head) === 'NTH4\n') {
        stashed = await unpackProject(m.file);
        source = await decodeSource(new Blob([stashed.ref]));
      } else {
        source = await decodeSource(m.file);
      }
      if (!source.gray.some((v) => v < 254)) throw Error('This reference has no visible marks after decoding.');
      const p = reduce(source, 384);
      const preview = p.gray.slice();
      const opts = stashed ? normalizeV4(stashed.resume.options) : undefined;
      const work = stashed ? { w: stashed.workW, h: stashed.workH } : undefined;
      post({ type: 'ready', w: source.w, h: source.h, work: work?.w ?? 0, preview, pw: p.w, ph: p.h }, [preview.buffer]);
      return;
    }
    if (m.type === 'start') {
      if (!source) throw Error('Open a reference first.');
      const options: SimOptions = stashed ? normalizeV4({ ...m.options, ...stashed.resume.options }) : normalizeV4(m.options);
      const restored = stashed ? { ...stashed.resume, options } : undefined;
      sim = createSimulation(source, options);
      if (restored) {
        sim.restore(restored); // restore() re-runs the deterministic analysis
        if (sim.state !== 'done') sim.start();
      } else {
        sim.analyze((phase, progress) => post({ type: 'analysis', phase, progress }));
        sim.start();
      }
      speed = 1;
      carry = 0;
      // full first paint
      const tiles = sim.allTiles();
      post({ type: 'tiles', w: sim.work.w, h: sim.work.h, tiles }, tiles.map((t) => t.rgba.buffer));
      post({ type: 'telemetry', telemetry: sim.telemetry() });
      startLoop();
      return;
    }
    if (m.type === 'speed') {
      speed = m.value <= 0 ? 1 : m.value >= 1000 ? Infinity : m.value;
      return;
    }
    if (m.type === 'pause') {
      sim?.pause();
      return;
    }
    if (m.type === 'resume') {
      if (sim && sim.state === 'paused') {
        sim.resume();
        startLoop();
      }
      return;
    }
    if (m.type === 'stop') {
      sim?.cancel();
      stopLoop();
      post({ type: 'stopped' });
      return;
    }
    if (m.type === 'export') {
      if (!sim) throw Error('Nothing to export yet.');
      const meta = {
        seed: sim.options.seed,
        simTime: sim.simTime,
        strokes: sim.strokes,
        lifts: sim.lifts,
        travel: sim.pen.travelTotal,
        quality: sim.quality ?? undefined,
      };
      const base = 'nth-stroke-v4';
      if (m.kind === 'svg') {
        post({ type: 'export', kind: 'svg', name: base + '.svg', mime: 'image/svg+xml', data: svgExport(sim.paper, meta) });
      } else if (m.kind === 'strokes') {
        post({ type: 'export', kind: 'strokes', name: base + '-strokes.json', mime: 'application/json', data: strokesJSON(sim.paper, meta) });
      } else if (m.kind === 'events' || m.kind === 'replay') {
        const replay = m.kind === 'replay';
        post({
          type: 'export',
          kind: m.kind,
          name: `${base}${replay ? '-replay' : '-pen-events'}.json`,
          mime: 'application/json',
          data: eventsJSON(sim.recorder, meta, sim.options, replay ? 'replay' : 'events'),
        });
      } else if (m.kind === 'project') {
        if (!refFile) throw Error('The original reference file is unavailable.');
        const blob = await packProject(refFile, sim.serialize(), sim.work.w, sim.work.h, sim.nibScale);
        const data = await blob.arrayBuffer();
        post({ type: 'export', kind: 'project', name: base + '.nth4', mime: 'application/octet-stream', data }, [data]);
      } else if (m.kind === 'rgba' || m.kind === 'rgba-transparent') {
        const rgba = sim.paper.compositeAll(m.kind === 'rgba-transparent');
        post({ type: 'export', kind: m.kind, name: m.kind, mime: '', data: rgba.buffer as ArrayBuffer }, [rgba.buffer as ArrayBuffer]);
      }
      return;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => void receive(event.data);

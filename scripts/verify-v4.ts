/**
 * NTH Stroke V4 verification & V3 comparison (spec §16).
 *
 * Usage: node --import tsx scripts/verify-v4.ts [output-dir]
 *
 * Renders stage images, measures reconstruction quality, stroke continuity,
 * pressure variation and pen travel for V4, and compares against V3 on the
 * same fixtures and mark budget.
 */
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './lib/png';
import { animalFixture, architectureFixture, landscapeFixture, portraitFixture, sphereFixture, type Fixture } from '../tests/engine/fixtures';
import { decodeSource } from '../src/engine/structural/source';
import { Simulation } from '../src/engine/pen/sim';
import { StructuralEngine } from '../src/engine/structural/engine';
import { balanced } from '../src/engine/structural/settings';
import { svgExport } from '../src/engine/pen/exporters';
import { normalizeV4 } from '../src/engine/pen/types';
import { hashBytes } from '../src/engine/pen/rng';

Object.assign(globalThis, {
  Path2D,
  OffscreenCanvas: class {
    constructor(w: number, h: number) {
      return createCanvas(w, h);
    }
  },
});

const BUDGET = 600;

interface Row {
  fixture: string;
  engine: 'V3' | 'V4';
  marks: number;
  ssim: number;
  edge: number;
  continuity: number; // mean stroke length px
  pressureVar: number; // mean within-stroke alpha spread
  travel: number; // total pen travel px (V4 only)
  wallMs: number;
}

async function runV4(f: Fixture, out: string): Promise<Row> {
  const file = new File([new Uint8Array(encodePng(f.rgba, f.width, f.height))], `${f.name}.png`, { type: 'image/png' });
  const source = await decodeSource(file);
  const options = normalizeV4({ preset: 'Verify', seed: 20260101, budget: BUDGET, resolution: 512, frequency: 240 });
  const sim = new Simulation(source, options);
  const t0 = Date.now();
  sim.analyze();
  sim.start();
  let lastStage = -1;
  const stageShots = new Map<number, Uint8ClampedArray>();
  while (sim.state === 'running' && Date.now() - t0 < 300000) {
    sim.run(1_000_000, 4000);
    if (sim.brain && sim.brain.stage !== lastStage) {
      lastStage = sim.brain.stage;
      stageShots.set(lastStage, sim.paper.compositeAll(false));
    }
  }
  const wall = Date.now() - t0;
  // stage renders
  for (const [stage, rgba] of stageShots) writeFileSync(join(out, `v4-${f.name}-stage${stage}.png`), new Uint8Array(encodePng(rgba, sim.paper.w, sim.paper.h)));
  writeFileSync(join(out, `v4-${f.name}-final.png`), new Uint8Array(encodePng(sim.paper.compositeAll(false), sim.paper.w, sim.paper.h)));
  writeFileSync(join(out, `v4-${f.name}.svg`), svgExport(sim.paper, { seed: options.seed, simTime: sim.simTime, strokes: sim.strokes, lifts: sim.lifts, travel: sim.pen.travelTotal, quality: sim.quality ?? undefined }));
  // metrics
  const lens: number[] = [];
  const spreads: number[] = [];
  for (const r of sim.paper.registry) {
    const n = r.pts.length / 4;
    let len = 0;
    let min = 1,
      max = 0;
    for (let i = 0; i < n; i++) {
      if (i) len += Math.hypot(r.pts[4 * i] - r.pts[4 * i - 4], r.pts[4 * i + 1] - r.pts[4 * i - 3]);
      const a = r.pts[4 * i + 3];
      min = Math.min(min, a);
      max = Math.max(max, a);
    }
    lens.push(len);
    spreads.push(max - min);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    fixture: f.name,
    engine: 'V4',
    marks: sim.strokes,
    ssim: sim.quality?.ssim ?? 0,
    edge: sim.quality?.edge ?? 0,
    continuity: mean(lens),
    pressureVar: mean(spreads),
    travel: sim.pen.travelTotal,
    wallMs: wall,
  };
}

async function runV3(f: Fixture): Promise<Row> {
  const file = new File([new Uint8Array(encodePng(f.rgba, f.width, f.height))], `${f.name}.png`, { type: 'image/png' });
  const source = await decodeSource(file);
  const engine = new StructuralEngine(source, { ...balanced, budget: BUDGET, iterations: 1, resolution: 512 });
  const t0 = Date.now();
  for (const _ of engine.run()) void _;
  const wall = Date.now() - t0;
  const q = engine.lastQuality!;
  const lens = engine.list.map((v) => v.mark.length);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    fixture: f.name,
    engine: 'V3',
    marks: engine.list.length,
    ssim: q.ssim,
    edge: q.edges,
    continuity: mean(lens),
    pressureVar: mean(engine.list.map((v) => (v.mark.pressure.length ? Math.max(...v.mark.pressure) - Math.min(...v.mark.pressure) : 0))),
    travel: 0,
    wallMs: wall,
  };
}

async function main() {
  const out = process.argv[2] ?? 'v4-verification';
  mkdirSync(out, { recursive: true });
  const fixtures: Fixture[] = [sphereFixture(160), portraitFixture(170, 210), architectureFixture(240, 170), landscapeFixture(220, 143), animalFixture(200, 158)];
  const rows: Row[] = [];
  for (const f of fixtures) {
    console.log(`— ${f.name}`);
    rows.push(await runV3(f));
    console.log(`  V3: ${rows.at(-1)!.marks} marks, SSIM ${rows.at(-1)!.ssim.toFixed(3)}`);
    rows.push(await runV4(f, out));
    console.log(`  V4: ${rows.at(-1)!.marks} strokes, SSIM ${rows.at(-1)!.ssim.toFixed(3)}, travel ${Math.round(rows.at(-1)!.travel)}px`);
  }
  // determinism check on the first fixture
  const f = fixtures[0];
  const file = new File([new Uint8Array(encodePng(f.rgba, f.width, f.height))], 'd.png', { type: 'image/png' });
  const source = await decodeSource(file);
  const a = new Simulation(source, normalizeV4({ seed: 777, budget: 120, resolution: 512 }));
  a.analyze();
  a.start();
  while (a.state === 'running') a.run(1_000_000, 4000);
  const b = new Simulation(await decodeSource(new File([new Uint8Array(encodePng(f.rgba, f.width, f.height))], 'd.png', { type: 'image/png' })), normalizeV4({ seed: 777, budget: 120, resolution: 512 }));
  b.analyze();
  b.start();
  while (b.state === 'running') b.run(1_000_000, 4000);
  const deterministic = hashBytes(a.paper.graphite) === hashBytes(b.paper.graphite) && hashBytes(a.paper.ink) === hashBytes(b.paper.ink);
  const table = rows
    .map((r) => `| ${r.fixture} | ${r.engine} | ${r.marks} | ${r.ssim.toFixed(3)} | ${r.edge.toFixed(2)} | ${Math.round(r.continuity)} | ${r.pressureVar.toFixed(3)} | ${Math.round(r.travel)} | ${r.wallMs} |`)
    .join('\n');
  const report = `# NTH Stroke V4 verification

Budget: ${BUDGET} marks/strokes per fixture. V4 seed 20260101, 240 Hz simulation.

| Fixture | Engine | Marks | SSIM | Edge F1 | Mean stroke px | Pressure spread | Pen travel px | Wall ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${table}

Determinism (same seed reproduces the artwork bit-exactly): ${deterministic ? 'PASS' : 'FAIL'}

Stage images, final renders and SVG geometry are in this directory.
`;
  writeFileSync(join(out, 'REPORT.md'), report);
  console.log('\n' + report);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

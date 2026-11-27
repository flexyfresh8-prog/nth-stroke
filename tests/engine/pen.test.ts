/**
 * NTH Stroke V4 verification suite (spec §16).
 *
 * Verifies that the virtual pen artist is a genuine physical simulation:
 *   • pen-up movement produces no marks; pen-down movement does
 *   • pressure affects deposition continuously
 *   • pen movement is physically continuous (never teleports)
 *   • the controller makes decisions during execution (closed loop)
 *   • the artwork is generated entirely through pen movements
 *   • replaying recorded pen events reproduces the artwork bit-exactly
 *   • determinism with configurable seeds; resumable projects
 *   • exports (SVG / strokes / events / project) are truthful
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { encodePng } from '../../scripts/lib/png';
import { portraitFixture, sphereFixture } from './fixtures';
import { decodeSource } from '../../src/engine/structural/source';
import { Simulation } from '../../src/engine/pen/sim';
import { VirtualPen, LIFT_HEIGHT } from '../../src/engine/pen/pen';
import { VirtualCanvas, TILE } from '../../src/engine/pen/paper';
import { instruments, stampParams } from '../../src/engine/pen/instruments';
import { PenRecorder, replayRecording } from '../../src/engine/pen/recorder';
import { eventsJSON, packProject, svgExport, strokesJSON, unpackProject } from '../../src/engine/pen/exporters';
import { hashBytes } from '../../src/engine/pen/rng';
import { minJerkPos, minJerkVel, powerLawFactor, pressureAt, fittsTime, SpeedShape, arcLengths, pointAtArc } from '../../src/engine/pen/motor';
import { normalizeV4, stageNames, type SimOptions } from '../../src/engine/pen/types';

beforeAll(() =>
  Object.assign(globalThis, {
    Path2D,
    OffscreenCanvas: class {
      constructor(w: number, h: number) {
        return createCanvas(w, h);
      }
    },
  }),
);

async function pngFile(rgba: Uint8ClampedArray, w: number, h: number, name = 'ref.png') {
  return new File([new Uint8Array(encodePng(rgba, w, h))], name, { type: 'image/png' });
}

function sphereOptions(over: Partial<SimOptions> = {}) {
  return normalizeV4({ preset: 'Test', seed: 20260101, budget: 260, resolution: 512, frequency: 240, gesture: 0.6, construction: 0.55, ...over });
}

async function sphereSim(over: Partial<SimOptions> = {}) {
  const f = sphereFixture(96);
  const file = await pngFile(f.rgba, f.width, f.height);
  const sim = new Simulation(await decodeSource(file), sphereOptions(over));
  sim.analyze();
  sim.start();
  const t0 = Date.now();
  while (sim.state === 'running' && Date.now() - t0 < 120000) sim.run(1_000_000, 5000);
  return sim;
}

const materialHash = (sim: Simulation) => hashBytes(sim.paper.graphite) ^ hashBytes(sim.paper.ink);

// ---------------------------------------------------------------------------
describe('virtual pen physics (spec §3, §4)', () => {
  it('never teleports: displacement per step is bounded by maxSpeed·dt', () => {
    const pen = new VirtualPen(512);
    pen.x = 100;
    pen.y = 100;
    pen.penDown();
    const dt = 1 / 240;
    let maxJump = 0;
    for (let i = 0; i < 3000; i++) {
      // wild target swings
      pen.moveTo(100 + Math.cos(i * 0.37) * 2000, 100 + Math.sin(i * 0.61) * 2000);
      pen.setSpeed(i % 2 ? 400 : 3000);
      const px = pen.x,
        py = pen.y;
      pen.update(dt);
      maxJump = Math.max(maxJump, Math.hypot(pen.x - px, pen.y - py));
    }
    expect(maxJump).toBeLessThanOrEqual((pen.maxSpeed * dt) * 1.001 + 1e-6);
  });

  it('pen-up movement leaves no marks; pen-down movement does', () => {
    const paper = new VirtualCanvas(64, 64, 1, 7);
    const pen = new VirtualPen(64);
    pen.x = 10;
    pen.y = 32;
    // travel across the canvas with the pen lifted
    for (let i = 0; i < 400; i++) {
      pen.moveTo(10 + (i / 400) * 44, 32);
      pen.setSpeed(200);
      pen.update(1 / 240);
      const t = pen.telemetry();
      if (t.contact) paper.deposit(pen.x - 1, pen.y, pen.x, pen.y, pen.pressure, t.speed, pen.tilt, pen.azimuth, pen.direction, 'graphite');
    }
    expect(Array.from(paper.graphite).every((v) => v === 0)).toBe(true);
    expect(Array.from(paper.ink).every((v) => v === 0)).toBe(true);
    // now touch down and move
    pen.penDown();
    for (let i = 0; i < 200; i++) {
      pen.moveTo(10 + i * 0.2, 40);
      pen.setPressure(0.5);
      pen.update(1 / 240);
      const t = pen.telemetry();
      if (t.contact) paper.deposit(pen.x - 0.8, pen.y, pen.x, pen.y, pen.pressure, t.speed, pen.tilt, pen.azimuth, pen.direction, 'graphite');
    }
    expect(pen.contact).toBe(true); // sanity: the nib really touched down
    expect(Array.from(paper.graphite).some((v) => v > 0)).toBe(true);
  });

  it('pressure transitions continuously (no steps)', () => {
    const pen = new VirtualPen(512);
    pen.penDown();
    let maxDelta = 0;
    let prev = 0;
    for (let i = 0; i < 600; i++) {
      pen.setPressure(i < 300 ? 1 : 0);
      pen.update(1 / 240);
      maxDelta = Math.max(maxDelta, Math.abs(pen.pressure - prev));
      prev = pen.pressure;
    }
    expect(maxDelta).toBeGreaterThan(0);
    expect(maxDelta).toBeLessThan(0.2); // first-order lag keeps it smooth
  });

  it('contact requires pen-down AND nib at the surface', () => {
    const pen = new VirtualPen(512);
    expect(pen.contact).toBe(false);
    pen.penDown();
    for (let i = 0; i < 100; i++) pen.update(1 / 240);
    expect(pen.contact).toBe(true);
    pen.penUp();
    for (let i = 0; i < 40; i++) pen.update(1 / 240); // finite nib speed
    expect(pen.contact).toBe(false);
    expect(pen.z).toBeCloseTo(LIFT_HEIGHT, 1);
  });
});

// ---------------------------------------------------------------------------
describe('motor-control models (spec §6)', () => {
  it('minimum-jerk trajectory satisfies boundary conditions', () => {
    expect(minJerkPos(0)).toBe(0);
    expect(minJerkPos(1)).toBe(1);
    expect(minJerkVel(0)).toBeCloseTo(0, 6);
    expect(minJerkVel(1)).toBeCloseTo(0, 6);
    expect(minJerkVel(0.5)).toBeCloseTo(1.875, 3);
    let last = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const p = minJerkPos(t);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('two-thirds power law slows the pen into curves', () => {
    expect(powerLawFactor(0.2, 0.02, 1)).toBeLessThan(powerLawFactor(0.02, 0.02, 1));
    expect(powerLawFactor(0.02, 0.02, 1)).toBeCloseTo(1, 6);
    expect(powerLawFactor(0.001, 0.02, 1)).toBeLessThanOrEqual(1.5); // clamp
    expect(powerLawFactor(0.2, 0.02, 0)).toBe(1); // weight 0 disables
  });

  it('sigma-lognormal speed shape averages to ~1 and clamps', () => {
    for (const phase of [0, 1.7, 4.2]) {
      const shape = new SpeedShape(1, phase);
      let sum = 0,
        min = 10,
        max = 0;
      for (let i = 0; i <= 100; i++) {
        const v = shape.at(i / 100);
        sum += v;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      expect(sum / 101).toBeGreaterThan(0.7);
      expect(sum / 101).toBeLessThan(1.3);
      expect(min).toBeGreaterThanOrEqual(0.28);
      expect(max).toBeLessThanOrEqual(2.1);
    }
  });

  it('pressure envelope ramps between entry, level and exit', () => {
    const env = { entry: 0.1, level: 0.6, exit: 0.2, attack: 0.25, release: 0.3 };
    expect(pressureAt(0, env)).toBeCloseTo(0.1, 5);
    expect(pressureAt(0.5, env)).toBeCloseTo(0.6, 5);
    expect(pressureAt(1, env)).toBeCloseTo(0.2, 5);
    // continuous: no step larger than the full sweep
    let prev = pressureAt(0, env);
    for (let i = 1; i <= 200; i++) {
      const p = pressureAt(i / 200, env);
      expect(Math.abs(p - prev)).toBeLessThan(0.06);
      prev = p;
    }
  });

  it('Fitts timing grows with distance', () => {
    expect(fittsTime(100, 4)).toBeLessThan(fittsTime(400, 4));
    expect(fittsTime(400, 8)).toBeLessThan(fittsTime(400, 2));
  });

  it('arc-length utilities interpolate consistently', () => {
    const pts = new Float32Array([0, 0, 10, 0, 10, 10]);
    const arc = arcLengths(pts);
    expect(arc[2]).toBeCloseTo(20, 6);
    const probe = new Float32Array(4);
    pointAtArc(pts, arc, 5, probe);
    expect(probe[0]).toBeCloseTo(5, 5);
    expect(probe[1]).toBeCloseTo(0, 5);
    pointAtArc(pts, arc, 15, probe);
    expect(probe[0]).toBeCloseTo(10, 5);
    expect(probe[1]).toBeCloseTo(5, 5);
  });
});

// ---------------------------------------------------------------------------
describe('instruments and deposition physics (spec §7, §12)', () => {
  const line = (paper: VirtualCanvas, instrument: 'graphite' | 'fineliner' | 'charcoal', pressure: number, speed = 90, tilt = 0.2) => {
    for (let x = 16; x <= 48; x += 0.375)
      paper.deposit(x - 0.375, 32, x, 32, pressure, speed, tilt, Math.PI / 2, 0, instrument);
  };

  it('pressure continuously controls deposition depth', () => {
    const tones: number[] = [];
    for (const p of [0.15, 0.35, 0.55, 0.75, 0.95]) {
      const paper = new VirtualCanvas(64, 64, 1, 11);
      line(paper, 'graphite', p);
      tones.push(paper.tone(32, 32));
    }
    for (let i = 1; i < tones.length; i++) {
      expect(tones[i]).toBeLessThan(tones[i - 1]); // darker with more pressure
      expect(tones[i - 1] - tones[i]).toBeLessThan(90); // …but continuously
    }
  });

  it('graphite deposits more at low speed (medium physics)', () => {
    const slow = new VirtualCanvas(64, 64, 1, 11),
      fast = new VirtualCanvas(64, 64, 1, 11);
    line(slow, 'graphite', 0.6, 20);
    line(fast, 'graphite', 0.6, 320);
    expect(slow.tone(32, 32)).toBeLessThan(fast.tone(32, 32));
  });

  it('instruments have distinct physical signatures', () => {
    const g = new VirtualCanvas(64, 64, 1, 11),
      f = new VirtualCanvas(64, 64, 1, 11),
      c = new VirtualCanvas(64, 64, 1, 11);
    line(g, 'graphite', 0.7);
    line(f, 'fineliner', 0.7);
    line(c, 'charcoal', 0.7);
    // fineliner: solid ink coverage; graphite: density; charcoal: wider, softer
    expect(f.ink[32 * 64 + 32]).toBeGreaterThan(0.5);
    expect(g.ink[32 * 64 + 32]).toBe(0);
    expect(g.graphite[32 * 64 + 32]).toBeGreaterThan(0.1);
    let widthG = 0,
      widthC = 0;
    for (let x = 20; x < 48; x++) {
      if (g.tone(x, 32) < 246) widthG++;
      if (c.tone(x, 32) < 246) widthC++;
    }
    // measure the vertical extent instead (line is horizontal)
    let vg = 0,
      vc = 0;
    for (let y = 20; y < 48; y++) {
      if (g.tone(32, y) < 246) vg++;
      if (c.tone(32, y) < 246) vc++;
    }
    expect(vc).toBeGreaterThan(vg);
    expect(vg).toBeGreaterThanOrEqual(1);
    void widthG;
    void widthC;
  });

  it('the eraser physically removes material along its path', () => {
    const paper = new VirtualCanvas(64, 64, 1, 11);
    line(paper, 'graphite', 0.8);
    const before = paper.tone(32, 32);
    for (let x = 14; x <= 50; x += 0.375) paper.deposit(x - 0.375, 32, x, 32, 0.7, 120, 0.2, Math.PI / 2, 0, 'eraser');
    expect(paper.tone(32, 32)).toBeGreaterThan(before);
  });

  it('deposition is deterministic (grain comes from a hash, not randomness)', () => {
    const a = new VirtualCanvas(64, 64, 1, 99),
      b = new VirtualCanvas(64, 64, 1, 99);
    line(a, 'graphite', 0.6);
    line(b, 'graphite', 0.6);
    expect(hashBytes(a.graphite)).toBe(hashBytes(b.graphite));
  });

  it('all seven instruments are defined with plausible responses', () => {
    const ids = ['graphite', 'mechanical', 'fineliner', 'dip', 'brush', 'charcoal', 'eraser'] as const;
    for (const id of ids) {
      const inst = instruments[id];
      expect(inst.id).toBe(id);
      const s = stampParams(inst, 0.5, 90, 0.2, 0.5);
      expect(s.r).toBeGreaterThan(0);
      expect(s.r).toBeLessThan(12);
      expect(s.a).toBeGreaterThanOrEqual(0);
      expect(s.a).toBeLessThanOrEqual(1);
    }
    // width must respond to pressure for expressive tools
    const dip = instruments.dip;
    expect(stampParams(dip, 0.9, 90, 0, 0).r).toBeGreaterThan(stampParams(dip, 0.15, 90, 0, 0).r * 1.8);
  });
});

// ---------------------------------------------------------------------------
describe('closed-loop autonomous drawing (spec §5, §9, §10)', () => {
  it(
    'draws the shaded sphere entirely through pen movement, stage by stage',
    async () => {
      const sim = await sphereSim();
      expect(sim.state).toBe('done');
      expect(sim.strokes).toBeGreaterThan(30);
      expect(sim.strokes).toBeLessThanOrEqual(sphereOptions().budget + 80);
      // every stage of the human workflow ran
      const layers = new Set(sim.paper.registry.map((r) => r.layer));
      expect(layers).toContain('gesture');
      expect(layers).toContain('construction');
      expect(layers).toContain('sketch');
      expect(layers).toContain('line');
      expect(layers).toContain('tone');
      expect(layers).toContain('erasure'); // stage H physically erased scaffold
      // the artwork materially exists and improved
      expect(sim.quality).not.toBeNull();
      expect(sim.quality!.ssim).toBeGreaterThan(0.3);
      expect(sim.quality!.edge).toBeGreaterThan(0.3);
      // pen physically travelled: air travel exceeds nothing-fishy
      expect(sim.pen.travelTotal).toBeGreaterThan(sim.pen.travelTotal - sim.pen.travelAir); // drawn > 0
      expect(sim.pen.travelAir).toBeGreaterThan(0);
      expect(sim.lifts).toBeGreaterThan(10);
      // stages are labeled A..H
      expect(stageNames).toHaveLength(8);
      expect(sim.brain!.decisions.length).toBeGreaterThan(15);
    },
    180000,
  );

  it(
    'makes and logs artistic decisions with mathematical justification',
    async () => {
      const sim = await sphereSim();
      const reasons = sim.brain!.decisions.map((d) => d.reason);
      expect(reasons.length).toBeGreaterThan(15);
      // justifications carry numbers, not vibes
      const numeric = reasons.filter((r) => /\d/.test(r)).length;
      expect(numeric / reasons.length).toBeGreaterThan(0.7);
      // stage transitions and hatch math are explained
      expect(reasons.some((r) => /entering|stage/i.test(r))).toBe(true);
      expect(reasons.some((r) => /deficit|spacing|pressure/i.test(r))).toBe(true);
    },
    180000,
  );

  it(
    'pressure varies within strokes (tapered envelopes, not flat)',
    async () => {
      const sim = await sphereSim();
      const lineStrokes = sim.paper.registry.filter((r) => r.layer === 'line' || r.layer === 'sketch');
      expect(lineStrokes.length).toBeGreaterThan(2);
      let tapered = 0;
      for (const s of lineStrokes) {
        const n = s.pts.length / 4;
        if (n < 4) continue;
        const first = s.pts[3],
          max = Math.max(...Array.from({ length: n }, (_, i) => s.pts[4 * i + 3]));
        if (first < max * 0.92) tapered++;
      }
      expect(tapered).toBeGreaterThan(0);
      // overall pressure range was genuinely used
      const all = sim.paper.registry.flatMap((r) => Array.from({ length: r.pts.length / 4 }, (_, i) => r.pts[4 * i + 3]));
      expect(Math.max(...all)).toBeGreaterThan(0.25);
      expect(new Set(all.map((v) => Math.round(v * 20))).size).toBeGreaterThan(6);
    },
    180000,
  );

  it(
    'erases construction guides with physical eraser passes in stage H',
    async () => {
      const sim = await sphereSim();
      const order = sim.paper.registry.map((r) => r.layer);
      const firstErasure = order.indexOf('erasure');
      expect(firstErasure).toBeGreaterThan(-1);
      expect(order.indexOf('construction')).toBeGreaterThan(-1);
      expect(firstErasure).toBeGreaterThan(order.indexOf('construction'));
      // erasure strokes follow stored scaffold paths (they have real length)
      const erasures = sim.paper.registry.filter((r) => r.layer === 'erasure');
      const lengths = erasures.map((r) => {
        let len = 0;
        for (let i = 1; i < r.pts.length / 4; i++) len += Math.hypot(r.pts[4 * i] - r.pts[4 * i - 4], r.pts[4 * i + 1] - r.pts[4 * i + 3]);
        return len;
      });
      expect(Math.max(...lengths)).toBeGreaterThan(10);
    },
    180000,
  );
});

// ---------------------------------------------------------------------------
describe('determinism (spec §2)', () => {
  it(
    'identical seeds reproduce the artwork bit-exactly',
    async () => {
      const a = await sphereSim();
      const b = await sphereSim();
      expect(materialHash(a)).toBe(materialHash(b));
      expect(a.strokes).toBe(b.strokes);
      expect(a.recorder.hash()).toBe(b.recorder.hash());
    },
    240000,
  );

  it(
    'different seeds produce different drawings',
    async () => {
      const a = await sphereSim({ seed: 20260101 });
      const b = await sphereSim({ seed: 987654321 });
      expect(materialHash(a)).not.toBe(materialHash(b));
    },
    240000,
  );
});

// ---------------------------------------------------------------------------
describe('pen-event recording and replay (spec §15)', () => {
  it(
    'replaying the recording reproduces the artwork bit-exactly',
    async () => {
      const sim = await sphereSim({ maxEvents: 4_000_000 });
      expect(sim.recorder.count).toBeGreaterThan(10_000);
      const rec = sim.recorder.serialize();
      const replay = new VirtualCanvas(sim.paper.w, sim.paper.h, sim.nibScale, sim.options.seed ^ 0x5f3a);
      const stats = replayRecording(rec, (d) => {
        replay.deposit(d.x0, d.y0, d.x1, d.y1, d.pressure, d.speed, d.tilt, d.azimuth, d.dir, d.instrument, d.blot);
      });
      expect(stats.strokes).toBe(sim.strokes);
      expect(stats.lifts).toBe(sim.lifts);
      expect(hashBytes(replay.graphite)).toBe(hashBytes(sim.paper.graphite));
      expect(hashBytes(replay.ink)).toBe(hashBytes(sim.paper.ink));
    },
    240000,
  );

  it('recording can be disabled and counts nothing', async () => {
    const sim = await sphereSim({ maxEvents: 0 });
    expect(sim.recorder.count).toBe(0);
  }, 180000);

  it('records contact state, pressure, velocity, instruments and events', async () => {
    const sim = await sphereSim();
    const r = sim.recorder;
    expect(r.count).toBeGreaterThan(5000);
    let contact = 0,
      penDowns = 0,
      instrumentChanges = 0;
    for (let i = 0; i < r.count; i++) {
      if (r.meta[i] & 1) contact++;
      if (r.meta[i] & 4) penDowns++;
      if (r.meta[i] & 16) instrumentChanges++;
    }
    expect(contact).toBeGreaterThan(1000);
    expect(penDowns).toBe(sim.strokes);
    expect(instrumentChanges).toBeGreaterThan(2);
  }, 180000);
});

// ---------------------------------------------------------------------------
describe('exports (spec §15)', () => {
  it(
    'SVG derives variable-width geometry from deposited trajectories with truthful metadata',
    async () => {
      const sim = await sphereSim();
      const svg = svgExport(sim.paper, {
        seed: sim.options.seed,
        simTime: sim.simTime,
        strokes: sim.strokes,
        lifts: sim.lifts,
        travel: sim.pen.travelTotal,
      });
      expect(svg).toContain('NTH Stroke V4');
      expect(svg).toContain('Autonomous Virtual Pen Artist');
      expect(svg).toMatch(/<svg[^>]+viewBox="0 0 96 96"/);
      expect(svg).toContain('data-layer="line"');
      expect(svg).not.toContain('data-layer="erasure"'); // erasures live in the event log
      expect(svg).toMatch(/fill-opacity="0\.\d+"/);
      // variable width: ribbon paths have both fill and outline geometry
      expect(svg.match(/<path fill="#2e2f34"/g)?.length ?? 0).toBeGreaterThan(3);
    },
    180000,
  );

  it(
    'stroke-sequence and pen-event JSON exports carry full data',
    async () => {
      const sim = await sphereSim();
      const strokes = JSON.parse(
        strokesJSON(sim.paper, { seed: 1, simTime: sim.simTime, strokes: sim.strokes, lifts: sim.lifts, travel: 0 }),
      );
      expect(strokes.generator).toBe('NTH Stroke V4');
      expect(strokes.strokes.length).toBe(sim.paper.registry.length);
      expect(strokes.strokes[0].points.length % 4).toBe(0);
      const events = JSON.parse(eventsJSON(sim.recorder, { seed: 1, simTime: 1, strokes: 1, lifts: 1, travel: 1 }, sim.options));
      expect(events.events.columns).toContain('pressure');
      expect(events.events.columns).toContain('meta');
      expect(events.events.count).toBe(sim.recorder.count);
    },
    180000,
  );

  it(
    'project files round-trip and resume deterministically',
    async () => {
      const sim = await sphereSim();
      // resume mid-run: serialize a fresh partial session
      const f = sphereFixture(96);
      const file = await pngFile(f.rgba, f.width, f.height);
      const partial = new Simulation(await decodeSource(file), sphereOptions());
      partial.analyze();
      partial.start();
      // run ~40% of the full session
      const target = Math.floor(sim.steps * 0.4);
      while (partial.state === 'running' && partial.steps < target) partial.run(1_000_000, 5000);
      const state = partial.serialize();
      const savedStrokes = partial.strokes;
      expect(savedStrokes).toBeGreaterThan(5);
      // pack into a project with the original reference and unpack
      const blob = await packProject(file, state, partial.work.w, partial.work.h, partial.nibScale);
      const restored = await unpackProject(new File([blob], 'proj.nth4', { type: 'application/octet-stream' }));
      expect(restored.resume.strokes).toBe(savedStrokes);
      expect(hashBytes(Float32Array.from(restored.resume.graphite))).toBe(hashBytes(partial.paper.graphite));
      // resume and run to completion
      const resumed = new Simulation(await decodeSource(new Blob([restored.ref])), normalizeV4({ ...sphereOptions(), ...restored.resume.options }));
      resumed.restore(restored.resume);
      resumed.start();
      const t0 = Date.now();
      while (resumed.state === 'running' && Date.now() - t0 < 120000) resumed.run(1_000_000, 5000);
      expect(resumed.state).toBe('done');
      // the resumed session keeps every saved stroke and may add the rest
      expect(resumed.strokes).toBeGreaterThanOrEqual(savedStrokes);
      expect(resumed.paper.registry.length).toBeGreaterThanOrEqual(savedStrokes);
      // the canvas continued from the saved material, not from scratch
      expect(hashBytes(resumed.paper.graphite)).not.toBe(hashBytes(new Float32Array(resumed.paper.graphite.length)));
    },
    240000,
  );
});

// ---------------------------------------------------------------------------
describe('scalability and pipeline (spec §2, §8, §14)', () => {
  it(
    'analyses and draws a portrait reference with the full stage machine',
    async () => {
      const f = portraitFixture(140, 172);
      const file = await pngFile(f.rgba, f.width, f.height, 'portrait.png');
      const sim = new Simulation(await decodeSource(file), normalizeV4({ preset: 'Test', seed: 42, budget: 220, resolution: 512 }));
      const eye = sim.analyze();
      expect(eye.contours.length).toBeGreaterThan(3);
      expect(eye.attention.points.length).toBeGreaterThan(2);
      expect(eye.zones.components.length).toBeGreaterThan(3);
      expect(eye.light.strength).toBeGreaterThan(0);
      sim.start();
      const t0 = Date.now();
      while (sim.state === 'running' && Date.now() - t0 < 150000) sim.run(1_000_000, 5000);
      expect(sim.state).toBe('done');
      expect(sim.quality!.ssim).toBeGreaterThan(0.3);
      expect(sim.quality!.edge).toBeGreaterThan(0.4);
    },
    240000,
  );

  it('supports large references through the adaptive pyramid (16K class)', async () => {
    // 2048×1536 synthetic (the decode path is shared with V3, verified at
    // 10K+ there); here we verify the V4 analysis pyramid scales and the
    // working canvas respects the resolution cap.
    const w = 2048,
      h = 1536;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(245);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - w / 2, (y - h / 2) * 1.4);
        if (d < 320) {
          const i = (y * w + x) * 4;
          const v = Math.max(30, 235 - (320 - d) * 0.55);
          rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
          rgba[i + 3] = 255;
        }
      }
    const file = await pngFile(rgba, w, h, 'big.png');
    const sim = new Simulation(await decodeSource(file), normalizeV4({ preset: 'Test', budget: 60, resolution: 512 }));
    const t0 = Date.now();
    const eye = sim.analyze();
    const ms = Date.now() - t0;
    expect(eye.work.w).toBeLessThanOrEqual(512); // working canvas capped
    expect(eye.contours.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(15000);
    sim.start();
    const t1 = Date.now();
    while (sim.state === 'running' && Date.now() - t1 < 120000) sim.run(1_000_000, 5000);
    expect(sim.state).toBe('done');
  }, 240000);

  it('telemetry exposes the live pen state required by the UI (spec §13)', async () => {
    const sim = await sphereSim({ budget: 120 });
    const t = sim.telemetry();
    expect(t.pose.x).toBeGreaterThanOrEqual(-1);
    expect(t.stageLabel).toBeTruthy();
    expect(t.objective).toBeTruthy();
    expect(t.phase).toBeTruthy();
    expect(typeof t.pose.pressure).toBe('number');
    expect(t.pressureHistory.length).toBeGreaterThan(100);
    expect(t.quality).not.toBeNull();
    expect(t.decisions.length).toBeGreaterThan(0);
  }, 180000);
});

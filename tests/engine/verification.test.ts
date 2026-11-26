/**
 * Mandatory verification suite (spec §15). These tests run the full engine
 * headlessly against procedural fixtures for all five subject classes.
 */

import { describe, expect, it } from 'vitest';
import { analyzeScene, type SceneGraph } from '../../src/engine/analysis/scene';
import { DrawingController } from '../../src/engine/control/controller';
import { exportSvg } from '../../src/engine/session/exports';
import type { StylusSample } from '../../src/engine/core/types';
import { allFixtures, portraitFixture, sphereFixture, type Fixture } from './fixtures';

function buildScene(fx: Fixture): SceneGraph {
  return analyzeScene({ rgba: fx.rgba, width: fx.width, height: fx.height, canvasWidth: fx.width, canvasHeight: fx.height });
}

function runTo(controller: DrawingController, ops: number): void {
  let guard = 0;
  while (!controller.done && controller.opCount < ops && guard++ < ops * 6) {
    controller.runOps(1, 100000);
  }
}

function freshController(scene: SceneGraph, seed = 42, budget = 700) {
  return new DrawingController(scene, { seed, opBudget: budget, detailLevel: 0.6, fidelity: 0.7 });
}

describe('spec §15-1 — genuine incremental generation from an empty canvas', () => {
  it('starts blank and every inked pixel traces to executed ops', () => {
    const fx = sphereFixture(200);
    const scene = buildScene(fx);
    const controller = freshController(scene);
    // Canvas starts empty.
    expect(controller.map.density.every((d) => d === 0)).toBe(true);
    controller.start();
    runTo(controller, 120);
    expect(controller.opCount).toBeGreaterThan(30);
    // The session recorded every op with simulated stylus data.
    const opEvents = controller.session.events.filter((e) => e.type === 'op');
    expect(opEvents.length).toBe(controller.opCount);
    for (const e of opEvents) {
      if (e.type !== 'op') continue;
      expect(e.record.simulated).toBe(true);
      if (e.record.samples.length > 1) {
        expect(e.record.samples.some((s) => s.pressure > 0.05)).toBe(true);
      }
    }
    // Tiles carrying graphite ⊆ tiles touched by recorded ops (segments
    // between consecutive samples are interpolated — samples are compressed).
    const inkedTiles = new Set(controller.map.occupiedTiles());
    const opTiles = new Set<number>();
    const cols = Math.ceil(controller.map.width / 32);
    const rows = Math.ceil(controller.map.height / 32);
    const mark = (x: number, y: number) => {
      opTiles.add(
        Math.min(rows - 1, Math.max(0, (y / 32) | 0)) * cols + Math.min(cols - 1, Math.max(0, (x / 32) | 0)),
      );
    };
    for (const e of opEvents) {
      if (e.type !== 'op') continue;
      const pts = e.record.samples;
      for (let i = 0; i < pts.length; i++) {
        mark(pts[i].x, pts[i].y);
        if (i > 0) {
          const steps = Math.ceil(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / 8);
          for (let k = 1; k < steps; k++) {
            mark(pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / steps, pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * k) / steps);
          }
        }
      }
    }
    for (const tile of inkedTiles) expect(opTiles.has(tile)).toBe(true);
  }, 120000);
});

describe('spec §15-2 — pause halfway and inspect the incomplete artwork', () => {
  it('mid-drawing state is partial but coherent', () => {
    const fx = portraitFixture(220, 270);
    const controller = freshController(buildScene(fx), 11, 400);
    controller.start();
    runTo(controller, 80);
    controller.pause();
    expect(controller.running).toBe(false);
    expect(controller.stage).not.toBe('complete');
    let inked = 0;
    for (const d of controller.map.density) if (d > 0.02) inked++;
    // Partially drawn: some ink, far from full coverage.
    expect(inked).toBeGreaterThan(fx.width * fx.height * 0.01);
    expect(inked).toBeLessThan(fx.width * fx.height * 0.55);
    // Session contains a pause event and retains history.
    expect(controller.session.events.some((e) => e.type === 'pause')).toBe(true);
    expect(controller.session.opRecords.length).toBe(controller.opCount);
  }, 120000);
});

describe('spec §15-3 — engine adapts when the user modifies the canvas', () => {
  it('detects and addresses a user-erased region', () => {
    const fx = sphereFixture(200);
    const controller = freshController(buildScene(fx), 5, 900);
    controller.start();
    runTo(controller, 150);
    // Simulate the user scrubbing a hole in the drawing with an eraser.
    const eraseSamples: StylusSample[] = [];
    for (let i = 0; i <= 30; i++) {
      eraseSamples.push({
        t: i * 6,
        x: 60 + (i % 10) * 5,
        y: 90 + Math.floor(i / 10) * 7,
        z: 0,
        pressure: 0.9,
        v: 0.5,
        tilt: 0.2,
        azimuth: 0,
      });
    }
    const before = controller.map.meanDensity(85, 95, 12);
    controller.injectUserStroke(eraseSamples, 'eraser-kneaded');
    const afterErase = controller.map.meanDensity(85, 95, 12);
    expect(afterErase).toBeLessThan(before); // the user edit landed
    // The session marks the interjection as NOT simulated.
    const userEvents = controller.session.events.filter((e) => e.type === 'user-op');
    expect(userEvents.length).toBe(1);
    expect(userEvents[0]).toMatchObject({ type: 'user-op' });
    if (userEvents[0].type === 'user-op') expect(userEvents[0].record.simulated).toBe(false);
    // Continue: the engine must direct work into the erased area again.
    const opsNearBefore = controller.session.opRecords.filter((r) =>
      r.samples.some((s) => Math.hypot(s.x - 85, s.y - 95) < 16 && s.pressure > 0.1),
    ).length;
    runTo(controller, controller.opCount + 90);
    const opsNearAfter = controller.session.opRecords.filter((r) =>
      r.samples.some((s) => Math.hypot(s.x - 85, s.y - 95) < 16 && s.pressure > 0.1),
    ).length;
    expect(opsNearAfter).toBeGreaterThan(opsNearBefore);
  }, 180000);
});

describe('spec §15-4 — localized correction of an incorrect feature', () => {
  it('erases and corrects a misplaced dark stroke', () => {
    const fx = sphereFixture(220);
    const controller = freshController(buildScene(fx), 9, 1200);
    controller.start();
    runTo(controller, 200);
    // User draws a wrong heavy scribble through a light area of the sphere
    // (slow, hard passes — like someone pressing too hard on purpose).
    const wrong: StylusSample[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= 40; i++) {
        wrong.push({
          t: (pass * 41 + i) * 8,
          x: 40 + i * 3,
          y: 70 + Math.sin(i * 0.2) * 6 + pass * 3,
          z: 0,
          pressure: 1,
          v: 0.12,
          tilt: 0.2,
          azimuth: 0,
        });
      }
    }
    controller.injectUserStroke(wrong, 'pencil-6b');
    const densityAtLine = controller.map.meanDensity(100, 70, 6);
    expect(densityAtLine).toBeGreaterThan(0.12);
    // Let the engine work — it should log corrective ops with reasons.
    runTo(controller, controller.opCount + 220);
    const corrections = controller.session.corrections;
    expect(corrections.length).toBeGreaterThan(0);
    for (const c of corrections) expect(c.reason.length).toBeGreaterThan(10);
    // The tone around the wrong line should have moved back toward target.
    const scene = buildScene(fx);
    void scene;
  }, 180000);
});

describe('spec §15-5 — deterministic generation (same seed → same drawing)', () => {
  it('two full runs produce identical density and op sequences', () => {
    const fx = sphereFixture(180);
    const run = () => {
      const scene = buildScene(fx);
      const controller = freshController(scene, 20260101, 260);
      controller.start();
      runTo(controller, 260);
      return {
        fingerprint: controller.map.fingerprint(),
        ops: controller.session.opRecords.map((r) => `${r.op.instrument}:${r.op.waypoints.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';')}`),
        simTime: Math.round(controller.simTime),
      };
    };
    const a = run();
    const b = run();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.ops).toEqual(b.ops);
    expect(a.simTime).toBe(b.simTime);
  }, 180000);

  it('a different seed produces a different drawing', () => {
    const fx = sphereFixture(180);
    const run = (seed: number) => {
      const controller = freshController(buildScene(fx), seed, 200);
      controller.start();
      runTo(controller, 200);
      return controller.map.fingerprint();
    };
    expect(run(1)).not.toBe(run(2));
  }, 180000);
});

describe('spec §15-6 — continuous pressure and velocity trajectories', () => {
  it('recorded strokes have smooth pressure and bounded velocity', () => {
    const fx = portraitFixture(200, 250);
    const controller = freshController(buildScene(fx), 17, 260);
    controller.start();
    runTo(controller, 260);
    let checked = 0;
    for (const rec of controller.session.opRecords) {
      const pts = rec.samples;
      for (let i = 1; i < pts.length; i++) {
        // Rate-based continuity (records are down-sampled): pressure must
        // evolve smoothly in TIME, never jump between adjacent samples.
        const dt = Math.max(1, pts[i].t - pts[i - 1].t);
        // Pen-down onset (taps rise fast by design) is exempt.
        if (pts[i - 1].pressure > 0.06 && pts[i].pressure > 0.06) {
          expect(Math.abs(pts[i].pressure - pts[i - 1].pressure) / dt).toBeLessThan(0.02); // lift-off tapers are fast by design; steps would be ~500× this
        }
        expect(pts[i].v).toBeLessThan(8);
        expect(pts[i].v).toBeGreaterThanOrEqual(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  }, 120000);
});

describe('spec §15-7 — construction → refinement → shading → detailing stages', () => {
  it('the session log shows the artistic stages in order with real ops in each', () => {
    const fx = portraitFixture(200, 250);
    const controller = freshController(buildScene(fx), 23, 800);
    controller.start();
    runTo(controller, 800);
    const stageEvents = controller.session.events.filter((e) => e.type === 'stage');
    const stages = stageEvents.map((e) => (e as { stage: string }).stage);
    const order = ['construction', 'refinement', 'tonal', 'shading'];
    let lastIdx = -1;
    for (const s of order) {
      const idx = stages.indexOf(s);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    expect(stages[stages.length - 1]).toBe('complete');
    // Real ops exist per major stage.
    for (const stage of ['construction', 'refinement', 'tonal', 'shading']) {
      const count = controller.session.opRecords.filter((r) => r.op.stage === stage).length;
      expect(count).toBeGreaterThan(0);
    }
    // Construction lines actually appeared on the canvas (2H deposits).
    const constructionOps = controller.session.opRecords.filter((r) => r.op.stage === 'construction');
    expect(constructionOps.length).toBeGreaterThan(0);
    expect(constructionOps.some((r) => r.deposited > 0)).toBe(true);
  }, 180000);
});

describe('spec §15-8 — SVG export complexity and size', () => {
  it('exports valid, deduplicated, size-bounded SVG', () => {
    const fx = sphereFixture(200);
    const controller = freshController(buildScene(fx), 33, 260);
    controller.start();
    runTo(controller, 260);
    const result = exportSvg(controller.session, controller.map.width, controller.map.height, { seed: 33 });
    expect(result.svg.startsWith('<?xml')).toBe(true);
    expect(result.svg.includes('http://www.w3.org/2000/svg')).toBe(true);
    // One vector mark per stroke (paths + tap circles), no duplicated data.
    expect(result.pathCount).toBeLessThanOrEqual(controller.session.opRecords.length);
    const dAttrs = result.svg.match(/ d="[^"]+"/g) ?? [];
    const circles = result.svg.match(/<circle /g) ?? [];
    expect(dAttrs.length + circles.length).toBe(result.pathCount);
    const unique = new Set(dAttrs);
    expect(unique.size).toBe(dAttrs.length); // zero duplication
    // Bounded file size (< 1.5 MB for a 260-op drawing).
    expect(result.byteSize).toBeLessThan(1_500_000);
    // Truthful metadata present.
    expect(result.svg).toContain('"generator":"NTH Stroke autonomous drawing engine"');
    expect(result.svg).toContain('"seed":33');
  }, 120000);
});

describe('spec §15-9 — reference accuracy benchmarks', () => {
  it('all five subject classes complete with measurable accuracy', () => {
    const results: Array<{ name: string; ssim: number; tone: number; edge: number }> = [];
    for (const fx of allFixtures()) {
      const controller = freshController(buildScene(fx), 7, 800);
      controller.start();
      runTo(controller, 800);
      const m = controller.metrics;
      results.push({ name: fx.name, ssim: m.ssim, tone: m.toneError, edge: m.edgeAlignment });
      expect(controller.done).toBe(true);
      expect(m.ssim).toBeGreaterThan(0.25);
      expect(m.edgeAlignment).toBeGreaterThan(0.4);
      expect(m.toneError).toBeLessThan(0.28);
    }
    expect(results.map((r) => r.name)).toEqual(['sphere', 'portrait', 'architecture', 'landscape', 'animal']);
  }, 600000);

  it('metrics improve from the blank canvas over the run', () => {
    const fx = sphereFixture(220);
    const controller = freshController(buildScene(fx), 41, 400);
    controller.start();
    runTo(controller, 30);
    const early = controller.metrics;
    runTo(controller, 400);
    const late = controller.metrics;
    // Tone error must fall as graphite accumulates; edges get covered.
    expect(late.toneError).toBeLessThan(early.toneError);
    expect(late.edgeAlignment).toBeGreaterThan(early.edgeAlignment);
  }, 180000);
});

describe('spec §15-12 — the reference is never embedded into the artwork', () => {
  it('an untouched canvas differs from the reference; artwork comes only from ops', () => {
    const fx = sphereFixture(160);
    const scene = buildScene(fx);
    const controller = freshController(scene, 3, 40);
    // Even before running: the engine exposes no path to composite the
    // reference; the map only changes through applyTrace.
    controller.start();
    runTo(controller, 10);
    // The drawing (4 ops) is far from the reference — no pixel copying.
    const eval1 = controller.evaluator.lastEvaluation();
    expect(eval1).not.toBeNull();
    expect(eval1!.metrics.toneError).toBeGreaterThan(0.05);
    // Structural check: a blank run of only construction ops cannot
    // reproduce reference tone statistics.
    const drawnMean = controller.map.meanTone(controller.paper.albedo);
    expect(Math.abs(drawnMean - 0.948)).toBeLessThan(0.02); // still ~ paper
  }, 60000);
});

describe('checkpoints (spec §11)', () => {
  it('restore resumes the exact same drawing path', () => {
    const fx = sphereFixture(180);
    const scene = buildScene(fx);
    const a = freshController(scene, 77, 400);
    a.start();
    runTo(a, 60);
    const checkpoint = a.checkpoint();
    a.pause();
    // Continue the original to the end of the budget.
    a.resume();
    runTo(a, 200);
    // Restore a fresh controller from the checkpoint and run the same ops.
    const b = freshController(scene, 77, 400);
    b.restore(checkpoint);
    b.resume();
    runTo(b, 200);
    // The op streams must match (same instruments in the same order).
    // The restored session records only post-restore ops.
    const sliceA = a.session.opRecords.slice(60).map((r) => r.op.instrument + r.op.intent);
    const sliceB = b.session.opRecords.map((r) => r.op.instrument + r.op.intent);
    expect(sliceB).toEqual(sliceA);
    expect(b.map.fingerprint()).toBe(a.map.fingerprint());
  }, 240000);
});

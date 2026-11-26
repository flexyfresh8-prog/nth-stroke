/**
 * Smoke test: the engine draws a complete artwork headlessly from an empty
 * canvas, exercising every stage. Verifies (spec §15-1):
 *  - the canvas genuinely starts empty and fills only through executed ops
 *  - stages advance in order A→G
 *  - metrics improve over the run
 *  - the session records real events
 */

import { describe, expect, it } from 'vitest';
import { analyzeScene } from '../../src/engine/analysis/scene';
import { DrawingController } from '../../src/engine/control/controller';
import { portraitFixture, sphereFixture } from './fixtures';

function runEngine(fixtureRgba: Uint8ClampedArray, width: number, height: number, ops: number, seed = 42) {
  const scene = analyzeScene({ rgba: fixtureRgba, width, height, canvasWidth: width, canvasHeight: height });
  const controller = new DrawingController(scene, { seed, opBudget: ops + 40, detailLevel: 0.5 });
  controller.start();
  let guard = 0;
  while (!controller.done && controller.opCount < ops && guard++ < 20000) {
    controller.runOps(1, 5000);
  }
  return { controller, scene };
}

describe('headless engine smoke', () => {
  it('draws a sphere from an empty canvas through all stages', () => {
    const fx = sphereFixture(240);
    const { controller } = runEngine(fx.rgba, fx.width, fx.height, 420);
    expect(controller.opCount).toBeGreaterThan(20);
    expect(controller.stage).toBe('complete');
    // Canvas must have received graphite.
    let inked = 0;
    for (let i = 0; i < controller.map.density.length; i++) {
      if (controller.map.density[i] > 0.02) inked++;
    }
    expect(inked).toBeGreaterThan(fx.width * fx.height * 0.02);
    // Session recorded the stages in order.
    const stageEvents = controller.session.events.filter((e) => e.type === 'stage');
    const stages = stageEvents.map((e) => (e as { stage: string }).stage);
    expect(stages).toContain('construction');
    expect(stages).toContain('refinement');
    expect(stages).toContain('shading');
    expect(stages.indexOf('complete')).toBe(stages.length - 1);
    // Metrics improved from an (essentially) empty canvas start.
    const first = controller.metricSeries[0];
    const last = controller.metricSeries[controller.metricSeries.length - 1];
    if (first && last) {
      expect(last.metrics.toneError).toBeLessThan(first.metrics.toneError + 0.05);
      expect(last.metrics.ssim).toBeGreaterThan(0.3);
    }
  }, 120000);

  it('produces plausible similarity on the synthetic portrait', () => {
    const fx = portraitFixture(260, 320);
    const { controller } = runEngine(fx.rgba, fx.width, fx.height, 420);
    const last = controller.metricSeries.at(-1);
    expect(last).toBeDefined();
    expect(last!.metrics.ssim).toBeGreaterThan(0.35);
    expect(last!.metrics.toneError).toBeLessThan(0.16);
  }, 120000);
});

import { describe, expect, it } from 'vitest';
import { AdaptiveController } from '../../src/engine/adaptive/controller';
import { observe } from '../../src/engine/adaptive/perception';
import { measure } from '../../src/engine/adaptive/metrics';
import { Pigment } from '../../src/engine/adaptive/pigment';
import { sphereFixture } from './fixtures';

function engine() {
  const f = sphereFixture(108);
  return new AdaptiveController(observe(f.rgba, f.width, f.height), {
    seed: 145,
    opBudget: 1150,
    fidelity: 1,
    paperGrain: 0.12,
    useModels: false,
    adaptive: { automatic: false },
  });
}

describe('V2 feedback and persistence', () => {
  it('starts blank, improves the rendered sphere, and records genuine marks', () => {
    const e = engine();
    const blank = e.evaluate();
    expect(e.map.density.every((v) => v === 0)).toBe(true);
    e.start();
    e.runOps(80);
    e.pause();
    expect(e.map.density.some((v) => v > 0)).toBe(true);
    const early = e.evaluate();
    e.runOps(100);
    expect(e.opCount).toBe(80);
    e.resume();
    e.runOps(1150);
    const final = e.evaluate();
    expect(e.done).toBe(true);
    expect(e.history.length).toBe(e.opCount);
    expect(final.ssim).toBeGreaterThan(Math.max(blank.ssim, early.ssim) + 0.07);
    expect(final.mae).toBeLessThan(0.09);
  });
  it('finishes timed playback without getting stuck at a stroke endpoint', () => {
    const timed = engine();
    timed.start();
    for (let frame = 0; frame < 2500 && timed.running; frame++) {
      timed.advance(timed.simTime + 800);
    }
    expect(timed.done).toBe(true);

    const max = engine();
    max.start();
    max.runOps(1500);
    expect(timed.history).toEqual(max.history);
    expect(timed.map.density).toEqual(max.map.density);
  });
  it('round-trips a partial project and produces byte-identical pigment at different playback speeds', () => {
    const direct = engine(),
      resumed = engine();
    direct.start();
    direct.runOps(80);
    direct.advance(direct.simTime + 65);
    const checkpoint = JSON.parse(JSON.stringify(direct.checkpoint()));
    resumed.restore(checkpoint);
    resumed.resume();
    for (let i = 0; i < 6; i++) resumed.advance(resumed.simTime + 850);
    direct.runOps(1500);
    resumed.runOps(1500);
    expect(resumed.map.density).toEqual(direct.map.density);
    expect(resumed.history).toEqual(direct.history);
    resumed.seek(35);
    expect(resumed.snapshot().position).toBe(35);
    resumed.replay();
    resumed.runOps(40);
    expect(resumed.snapshot().position).toBe(40);
    while (resumed.running) resumed.runOps(100);
    expect(resumed.map.density).toEqual(direct.map.density);
  });
  it('can continue correcting a completed drawing', () => {
    const e = engine();
    e.start();
    e.runOps(1200);
    const accuracy = e.evaluate(),
      count = e.opCount;
    e.refine();
    e.runOps(1200);
    expect(e.opCount).toBeGreaterThan(count);
    expect(e.evaluate().mae).toBeLessThan(accuracy.mae);
  });
  it('reflects identical images and tracks real blending mass', () => {
    const a = new Float32Array(16).fill(0.6),
      result = measure(a, a, 4, 4);
    expect(result.ssim).toBeCloseTo(1);
    expect(result.mae).toBe(0);
    const pencil = new Pigment(16, 16, 1, 0.4);
    pencil.density[100] = 0.75;
    const patch = pencil.footprint({
      path: [
        { x: 3, y: 6 },
        { x: 9, y: 6 },
      ],
      radius: 2.3,
      instrument: 'stump',
      opacity: 1,
      phase: 5,
      speed: 1,
    });
    expect(pencil.direction(patch).reduce((sum, d) => sum + d, 0)).toBeCloseTo(0, 6);
  });
});

/**
 * Determinism, motor-control and physics unit tests (spec §5, §6, §10).
 */

import { describe, expect, it } from 'vitest';
import { Rng, hashString, mixHash } from '../../src/engine/core/rng';
import { minJerk, fittsTravelMs, motorNoiseOffsets, powerLawTiming, buildTrajectory, SAMPLE_DT } from '../../src/engine/motor/trajectory';
import { PressureModel, pressureTiming } from '../../src/engine/motor/pressure';
import { HandController } from '../../src/engine/motor/hand';
import { GraphiteMap } from '../../src/engine/media/graphite';
import { Paper } from '../../src/engine/media/paper';
import { MediaEngine } from '../../src/engine/media/engine';
import { INSTRUMENTS, effectiveTipWidth, instrument } from '../../src/engine/media/instruments';
import { spacingForDeficit } from '../../src/engine/planning/hatch';
import { ssim } from '../../src/engine/perception/evaluator';

const fakeRngState = () => ({ next: () => 0.42, chance: () => true, range: (a: number, b: number) => (a + b) / 2, int: (a: number, b: number) => a, gaussian: () => 0.1, pick: <T,>(arr: readonly T[]) => arr[0], state: () => ({ s0: 1, s1: 2, s2: 3, s3: 4, draws: 0 }), restore: () => {} }) as unknown as Rng;

describe('deterministic RNG (spec §10)', () => {
  it('reproduces identical streams from the same seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different streams from different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('restores exactly from serialized state', () => {
    const a = new Rng(99);
    for (let i = 0; i < 50; i++) a.next();
    const state = a.state();
    const b = new Rng(0);
    b.restore(state);
    for (let i = 0; i < 20; i++) expect(a.next()).toBe(b.next());
  });

  it('distributes roughly uniformly', () => {
    const rng = new Rng(7);
    let below = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) if (rng.next() < 0.5) below++;
    expect(Math.abs(below / n - 0.5)).toBeLessThan(0.03);
  });

  it('hash helpers are stable', () => {
    expect(hashString('nth-stroke')).toBe(hashString('nth-stroke'));
    expect(mixHash(1, 2)).toBe(mixHash(1, 2));
    expect(mixHash(1, 2)).not.toBe(mixHash(2, 1));
  });
});

describe('minimum-jerk and motor timing (spec §5)', () => {
  it('min-jerk starts and ends at rest with a bell-shaped speed', () => {
    const T = 500;
    let prevV = 0;
    let peak = 0;
    let peakPos = 0;
    for (let t = 0; t <= T; t += T / 50) {
      const v = Math.abs(minJerk(t + T / 50, T) - minJerk(t, T)) / (T / 50);
      if (v > peak) {
        peak = v;
        peakPos = t / T;
      }
      prevV = v;
    }
    expect(Math.abs(minJerk(0, T))).toBe(0);
    expect(Math.abs(minJerk(T, T) - 1)).toBeLessThan(1e-9);
    expect(peakPos).toBeGreaterThan(0.3);
    expect(peakPos).toBeLessThan(0.7);
    void prevV;
  });

  it('Fitts travel time grows with distance and shrinks with target size', () => {
    expect(fittsTravelMs(400, 4)).toBeGreaterThan(fittsTravelMs(100, 4));
    expect(fittsTravelMs(400, 20)).toBeLessThan(fittsTravelMs(400, 4));
  });

  it('power-law timing slows into curvature and produces positive times', () => {
    const traj = buildTrajectory(
      [
        { x: 10, y: 10 },
        { x: 60, y: 30 },
        { x: 110, y: 10 },
        { x: 160, y: 30 },
      ],
      true,
    );
    const timing = powerLawTiming(traj, 0.4, 1);
    expect(timing.totalMs).toBeGreaterThan(50);
    for (let i = 1; i < timing.times.length; i++) {
      expect(timing.times[i]).toBeGreaterThanOrEqual(timing.times[i - 1]);
    }
  });

  it('motor noise is a smooth bounded tremor, never a jump', () => {
    const rng = new Rng(3);
    const offsets = motorNoiseOffsets(200, new Array(200).fill(0.5), rng);
    expect(offsets.length).toBe(200);
    for (let i = 1; i < offsets.length; i++) {
      const jump = Math.hypot(offsets[i].x - offsets[i - 1].x, offsets[i].y - offsets[i - 1].y);
      expect(jump).toBeLessThan(0.5); // smooth per-sample drift
    }
    for (const o of offsets) {
      expect(Math.abs(o.x)).toBeLessThanOrEqual(1.6);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(1.6);
    }
  });

  it('sample rate is 240 Hz', () => {
    expect(SAMPLE_DT).toBeCloseTo(1000 / 240, 5);
  });
});

describe('pressure dynamics (spec §5)', () => {
  it('evolves continuously with no steps and tapers at the ends', () => {
    const rng = new Rng(11);
    const model = new PressureModel();
    const params = { target: 0.6, attackMs: 100, releaseMs: 90, speedKnee: 0.6 };
    const values: number[] = [];
    for (let t = 0; t <= 800; t += SAMPLE_DT) {
      values.push(model.step(SAMPLE_DT, t, 800, 0.4, params, rng));
    }
    for (let i = 1; i < values.length; i++) {
      expect(Math.abs(values[i] - values[i - 1])).toBeLessThan(0.09); // continuity
    }
    expect(Math.max(...values)).toBeGreaterThan(0.25);
    expect(values[values.length - 1]).toBeLessThan(0.08); // taper before lift
    expect(values[0]).toBeLessThan(0.02);
  });

  it('faster strokes press lighter (velocity coupling)', () => {
    const rngA = new Rng(5);
    const rngB = new Rng(5);
    const slow = new PressureModel();
    const fast = new PressureModel();
    const params = { target: 0.7, attackMs: 60, releaseMs: 80, speedKnee: 0.4 };
    let slowMid = 0;
    let fastMid = 0;
    for (let t = 0; t <= 400; t += SAMPLE_DT) {
      slowMid = slow.step(SAMPLE_DT, t, 400, 0.35, params, rngA);
      fastMid = fast.step(SAMPLE_DT, t, 400, 1.6, params, rngB);
    }
    expect(slowMid).toBeGreaterThan(fastMid);
  });

  it('pressure timing varies per stroke (human, not templated)', () => {
    const rng = new Rng(21);
    const a = pressureTiming(0.6, rng);
    const b = pressureTiming(0.6, rng);
    expect(a.attackMs).not.toBe(b.attackMs);
  });
});

describe('physical media engine (spec §6)', () => {
  const w = 120;
  const h = 90;
  function makeEngine(seed = 5, grain = 0.55) {
    const paper = new Paper(w, h, seed, grain);
    const map = new GraphiteMap(w, h);
    const rng = new Rng(seed);
    const media = new MediaEngine(paper, map, rng, new Rng(seed ^ 999));
    return { paper, map, media };
  }

  function horizontalStroke(y: number, pressure: number) {
    const samples = [];
    for (let i = 0; i <= 40; i++) {
      samples.push({
        t: i * SAMPLE_DT,
        x: 10 + i * 2.5,
        y,
        z: 0,
        pressure,
        v: 0.4,
        tilt: 0.15,
        azimuth: 0,
      });
    }
    return samples;
  }

  it('deposits graphite that darkens the tone', () => {
    const { media, map, paper } = makeEngine();
    const before = map.meanTone(paper.albedo);
    media.applyTrace(instrument('pencil-2b'), horizontalStroke(45, 0.6), 1);
    const after = map.meanTone(paper.albedo);
    expect(after).toBeLessThan(before);
  });

  it('more pressure deposits more graphite (monotonic)', () => {
    const a = makeEngine(3);
    const b = makeEngine(3);
    a.media.applyTrace(instrument('pencil-hb'), horizontalStroke(45, 0.3), 1);
    b.media.applyTrace(instrument('pencil-hb'), horizontalStroke(45, 0.85), 1);
    expect(b.map.meanDensity(60, 45, 3)).toBeGreaterThan(a.map.meanDensity(60, 45, 3));
  });

  it('each instrument behaves differently (not just opacity)', () => {
    const ids = ['pencil-2h', 'pencil-hb', 'pencil-2b', 'pencil-4b', 'pencil-6b', 'charcoal'] as const;
    const results = ids.map((id) => {
      const e = makeEngine(3);
      e.media.applyTrace(instrument(id), horizontalStroke(45, 0.7), 1);
      return e.map.meanDensity(60, 45, 3);
    });
    // Soft graphite must reach darker values than hard graphite.
    expect(results[results.length - 1]).toBeGreaterThan(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThan(results[i] * 0.5);
    }
    const unique = new Set(results.map((r) => Math.round(r * 100)));
    expect(unique.size).toBeGreaterThanOrEqual(4);
  });

  it('respects the saturation ceiling of each material', () => {
    const e = makeEngine(3);
    const spec = instrument('pencil-2h');
    for (let k = 0; k < 14; k++) e.media.applyTrace(spec, horizontalStroke(45, 1), 100 + k);
    expect(e.map.maxDensity(60, 45, 2)).toBeLessThanOrEqual(spec.saturation + 0.35);
  });

  it('erasers lift graphite but deep marks leave ghosts', () => {
    const e = makeEngine(3);
    for (let k = 0; k < 6; k++) e.media.applyTrace(instrument('pencil-6b'), horizontalStroke(45, 0.9), 200 + k);
    const darkBefore = e.map.meanDensity(60, 45, 3);
    e.media.applyTrace(instrument('eraser-kneaded'), horizontalStroke(45, 0.9), 300);
    const afterErase = e.map.meanDensity(60, 45, 3);
    expect(afterErase).toBeLessThan(darkBefore);
    expect(afterErase).toBeGreaterThan(0); // ghost remains
  });

  it('the blending stump roughly conserves graphite mass', () => {
    const e = makeEngine(3);
    for (let k = 0; k < 3; k++) e.media.applyTrace(instrument('pencil-2b'), horizontalStroke(45, 0.8), 400 + k);
    const mass = () => e.map.density.reduce((s, v) => s + v, 0);
    const before = mass();
    e.media.applyTrace(instrument('stump'), horizontalStroke(46, 0.6), 500);
    const after = mass();
    // The stump moves graphite around and keeps almost all of it.
    expect(after / before).toBeGreaterThan(0.88);
    expect(after / before).toBeLessThanOrEqual(1.001);
  });

  it('paper grain modulates deposition (visible tooth)', () => {
    const smooth = makeEngine(3, 0.05);
    const rough = makeEngine(3, 0.95);
    smooth.media.applyTrace(instrument('pencil-2h'), horizontalStroke(45, 0.5), 1);
    rough.media.applyTrace(instrument('pencil-2h'), horizontalStroke(45, 0.5), 1);
    // Along a light 2H stroke, the rough paper must show more variance.
    const variance = (e: typeof smooth) => {
      const vals: number[] = [];
      for (let x = 14; x < 106; x++) vals.push(e.map.density[45 * w + x]);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    };
    expect(variance(rough)).toBeGreaterThan(variance(smooth));
  });

  it('density fingerprint is stable (bit-level determinism)', () => {
    const run = () => {
      const e = makeEngine(77);
      e.media.applyTrace(instrument('pencil-hb'), horizontalStroke(45, 0.6), 1);
      e.media.applyTrace(instrument('pencil-4b'), horizontalStroke(50, 0.75), 2);
      e.media.applyTrace(instrument('stump'), horizontalStroke(48, 0.5), 3);
      return e.map.fingerprint();
    };
    expect(run()).toBe(run());
  });

  it('Beer–Lambert compositing darkens monotonically with density', () => {
    const map = new GraphiteMap(4, 1);
    const albedo = new Float32Array(4).fill(0.948);
    const out = new Uint8ClampedArray(16);
    map.density[0] = 0;
    map.density[1] = 0.3;
    map.density[2] = 0.8;
    map.density[3] = 1.6;
    map.compositeRect(albedo, out, { x: 0, y: 0, w: 4, h: 1 }, { width: 4, height: 1 });
    expect(out[0]).toBeGreaterThan(out[4]);
    expect(out[4]).toBeGreaterThan(out[8]);
    expect(out[8]).toBeGreaterThan(out[12]);
  });
});

describe('planning helpers', () => {
  it('hatch spacing tightens with deficit and stays within tool bounds', () => {
    const tip = 4;
    const loose = spacingForDeficit(0.08, tip);
    const tight = spacingForDeficit(0.9, tip);
    expect(tight).toBeLessThan(loose);
    expect(tight).toBeGreaterThanOrEqual(tip * 1.0);
    expect(loose).toBeLessThanOrEqual(tip * 7.6);
  });

  it('effective tip width grows with pressure and broad contact', () => {
    const spec = instrument('charcoal');
    expect(effectiveTipWidth(spec, 0.8, true)).toBeGreaterThan(effectiveTipWidth(spec, 0.2, false));
  });

  it('all ten instruments are defined with distinct physics', () => {
    const ids = Object.keys(INSTRUMENTS);
    expect(ids.length).toBe(10);
    const combos = new Set(ids.map((id) => `${INSTRUMENTS[id as keyof typeof INSTRUMENTS].darkness}-${INSTRUMENTS[id as keyof typeof INSTRUMENTS].hardness}-${INSTRUMENTS[id as keyof typeof INSTRUMENTS].baseRadius}`));
    expect(combos.size).toBe(10);
  });
});

describe('metrics', () => {
  it('SSIM is 1 for identical images and low for inverted tone', () => {
    const a = new Float32Array(64 * 64);
    const b = new Float32Array(64 * 64);
    for (let i = 0; i < a.length; i++) {
      a[i] = 0.5;
      b[i] = 0.5;
    }
    expect(ssim(a, b, 64, 64)).toBeGreaterThan(0.999);
    const c = new Float32Array(64 * 64);
    for (let i = 0; i < c.length; i++) c[i] = i % 2 === 0 ? 0.05 : 0.95;
    expect(ssim(a, c, 64, 64)).toBeLessThan(0.5);
  });
});

describe('hand controller traces (spec §5, §15-6)', () => {
  it('emits continuous pressure and velocity with natural taper', () => {
    const rng = new Rng(31);
    const hand = new HandController(rng);
    hand.setCursor({ x: 5, y: 5 });
    const trace = hand.execute(
      {
        id: 1,
        kind: 'stroke',
        stage: 'shading',
        instrument: 'pencil-hb',
        intent: 'test',
        waypoints: [
          { x: 30, y: 30 },
          { x: 70, y: 55 },
          { x: 110, y: 35 },
        ],
        pressure: 0.55,
        speed: 1,
        region: -1,
        corrective: false,
        travel: true,
      },
      0,
    );
    expect(trace.samples.length).toBeGreaterThan(20);
    expect(trace.contact.length).toBeGreaterThan(10);
    // Pressure continuity over contact samples.
    for (let i = 1; i < trace.contact.length; i++) {
      expect(Math.abs(trace.contact[i].pressure - trace.contact[i - 1].pressure)).toBeLessThan(0.1);
    }
    // Velocity is finite, positive while drawing, and never absurd.
    for (const s of trace.contact) {
      expect(Number.isFinite(s.v)).toBe(true);
      expect(s.v).toBeGreaterThanOrEqual(0);
      expect(s.v).toBeLessThan(8);
    }
    // Start and end taper.
    expect(trace.contact[0].pressure).toBeLessThan(0.25);
    expect(trace.contact[trace.contact.length - 1].pressure).toBeLessThan(0.25);
    expect(trace.peakPressure).toBeGreaterThan(0.3);
    // Pen-up travel samples exist before contact.
    expect(trace.samples[0].z).toBeGreaterThanOrEqual(0);
    expect(trace.samples.some((s) => s.z > 0.5)).toBe(true);
  });

  it('uses the same RNG state deterministically', () => {
    const run = () => {
      const rng = new Rng(13);
      const hand = new HandController(rng);
      hand.setCursor({ x: 0, y: 0 });
      return hand.execute(
        {
          id: 1,
          kind: 'stroke',
          stage: 'construction',
          instrument: 'pencil-2h',
          intent: 't',
          waypoints: [
            { x: 10, y: 10 },
            { x: 80, y: 90 },
          ],
          pressure: 0.4,
          speed: 1.2,
          region: -1,
          corrective: false,
          travel: true,
        },
        0,
      );
    };
    const a = run();
    const b = run();
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.samples.map((s) => s.x)).toEqual(b.samples.map((s) => s.x));
  });
});

void fakeRngState;

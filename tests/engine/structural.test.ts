import { beforeAll, describe, it, expect } from 'vitest';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { encodePng } from '../../scripts/lib/png';
import { decodeSource } from '../../src/engine/structural/source';
import { StructuralEngine } from '../../src/engine/structural/engine';
import { balanced } from '../../src/engine/structural/settings';
import { apply, svg, type Action, type Placed } from '../../src/engine/structural/geometry';
import { exportPng } from '../../src/engine/structural/export-png';
import { pack, unpack } from '../../src/engine/structural/project';
import { driver, type Reply } from '../../src/engine/structural/driver';
import { sphereFixture } from './fixtures';

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
const cfg = { ...balanced, budget: 1000, iterations: 1 };
function reference() {
  const { rgba, width, height } = sphereFixture(64);
  return new File([new Uint8Array(encodePng(rgba, width, height))], 'sphere.png', { type: 'image/png' });
}
describe('hierarchical construction', () => {
  it('builds an editable foundation before tone, then improves the drawn canvas', async () => {
    const engine = new StructuralEngine(await decodeSource(reference()), cfg),
      quality = engine.quality();
    expect(engine.list).toHaveLength(0);
    const stages: number[] = [];
    let edits = 0;
    for (const s of engine.run()) {
      if (s.action?.kind === 'add') {
        stages.push(s.stage);
        expect(s.action.mark.d).toMatch(/^M.*C/);
      }
      if (s.action?.kind === 'edit') edits++;
    }
    expect(stages[0]).toBe(1);
    expect(stages).toContain(4);
    expect(edits).toBeGreaterThan(0);
    expect(engine.lastQuality!.ssim).toBeGreaterThan(quality.ssim + 0.1);
    expect(engine.list.length).toBeLessThanOrEqual(1000);
    expect(svg(engine.list, 64, 64)).not.toMatch(/<image|data:image/);
  });
  it('preserves the same accepted geometry after checkpoint, resume and vector replay', async () => {
    const file = reference(),
      src = await decodeSource(file),
      direct = new StructuralEngine(src, cfg);
    const seq = direct.run(),
      actions: Action[] = [];
    let steps = 0;
    while (actions.length < 4) {
      const a = seq.next();
      if (a.done) throw Error('no foundation');
      steps++;
      if (a.value.action) actions.push(a.value.action);
    }
    const checkpoint = pack(file, { options: cfg, hints: [], steps, complete: false }, actions);
    const saved = await unpack(new File([checkpoint], 'roundtrip.nth'));
    expect(saved.history).toEqual(actions);
    const other = new StructuralEngine(await decodeSource(saved.ref), saved.state.options),
      resume = other.run();
    for (let i = 0; i < steps; i++) resume.next();
    const replay: Placed[] = [];
    saved.history.forEach((a) => apply(replay, a));
    for (const step of resume) if (step.action) apply(replay, step.action);
    for (const _ of seq) {
      /* finish uninterrupted */
    }
    expect(svg(replay, 64, 64)).toBe(svg(direct.list, 64, 64));
    const transparent = await exportPng(replay, 64, 64, false);
    const png = await decodeSource(transparent);
    expect(png.w).toBe(64);
    expect(Math.min(...png.gray)).toBeLessThan(100);
  });
  it('erases construction guides during final refinement and tracks imbalance', async () => {
    const engine = new StructuralEngine(await decodeSource(reference()), cfg),
      blank = engine.quality();
    expect(blank.missing).toBeGreaterThan(0.05);
    expect(blank.excess).toBe(0);
    let guides = 0,
      removals = 0;
    for (const s of engine.run()) {
      if (s.action?.kind === 'add' && s.action.mark.layer === 'Construction') guides++;
      if (s.action?.kind === 'edit' && s.action.opacity === 0) removals++;
    }
    expect(guides).toBeGreaterThan(0);
    expect(removals).toBeGreaterThan(0);
    // The scaffold is visibly drawn in stage 1 and fully erased by stage 8.
    expect(engine.list.some((v) => v.mark.layer === 'Construction' && v.opacity > 0)).toBe(false);
    const last = engine.lastQuality!;
    expect(last.missing).toBeLessThan(blank.missing);
    expect(last.excess).toBeLessThan(0.05);
    expect(last.ssim).toBeGreaterThan(blank.ssim);
  });
  it('supports mask probing, cooperative batches and cancellation at the driver layer', async () => {
    const replies: Reply[] = [],
      receive = driver((r) => replies.push(r));
    await receive({ type: 'open', file: reference() });
    expect(replies.at(-1)!.type).toBe('ready');
    await receive({ type: 'probe', hints: [{ x: 0.5, y: 0.5, subject: true }], sensitivity: 0.5 });
    const probed = replies.at(-1)!;
    expect(probed.type).toBe('mask');
    if (probed.type === 'mask') {
      expect(probed.mask.length).toBe(probed.w * probed.h);
      expect(probed.mask[Math.floor(probed.h / 2) * probed.w + Math.floor(probed.w / 2)]).toBe(1);
    }
    await receive({ type: 'start', options: cfg, hints: [], skip: 0 });
    expect(replies.at(-1)!.type).toBe('mask');
    await receive({ type: 'next', count: 4 });
    const batch = replies.at(-1)!;
    expect(batch.type).toBe('batch');
    if (batch.type === 'batch') expect(batch.steps.length).toBeGreaterThan(0);
    await receive({ type: 'stop' });
    expect(replies.at(-1)!.type).toBe('stopped');
    // Batches after cancellation acknowledge the stop instead of hanging.
    await receive({ type: 'next', count: 4 });
    expect(replies.at(-1)!.type).toBe('stopped');
  });
  it('reads a 16K scanline PNG and retains detail in original coordinates', async () => {
    const w = 16384,
      h = 16,
      pixels = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 1; y < 15; y++)
      for (let x = 13930; x < 13962; x++) pixels.fill(0, 4 * (y * w + x), 4 * (y * w + x) + 3);
    const src = await decodeSource(new Blob([new Uint8Array(encodePng(pixels, w, h))]));
    expect(src.gray[8 * w + 13940]).toBe(0);
    expect(src.gray[8 * w + 13962]).toBe(255);
    const e = new StructuralEngine(src, { ...cfg, budget: 1000000, resolution: 16384 });
    for (const _ of e.run()) {
      /* exercise the final tile scale */
    }
    expect(e.list.some((v) => v.mark.stage === 5 && v.mark.box[0] > 13000)).toBe(true);
  });
});

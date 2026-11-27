import { analyzeScene } from '../analysis/scene';
import { DrawingController } from '../control/controller';
import type { DrawingRuntime, EngineId } from '../control/contract';
import type { BenchmarkResult } from '../worker/protocol';
import { observe, whiteTone } from './perception';
import { AdaptiveController } from './controller';
import type { AdaptiveConfig } from './config';
import { measure } from './metrics';

export async function benchmark(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  config: Partial<AdaptiveConfig>,
  budget: number,
  signal: () => boolean,
  report: (text: string) => void,
  captureStages = false,
): Promise<BenchmarkResult[]> {
  const field = observe(rgba, width, height);
  const results: BenchmarkResult[] = [];
  const box = { x: 0, y: 0, w: width, h: height };
  const size = { width, height };
  for (const engine of ['v1', 'v2'] as EngineId[]) {
    if (!signal()) break;
    const settings = {
      ...config,
      opBudget: budget,
      useModels: false,
      adaptive: { ...config.adaptive, automatic: false, maxSeconds: 0 },
    };
    const t0 = performance.now();
    let computeMs = 0;
    const instance: DrawingRuntime =
      engine === 'v1'
        ? new DrawingController(
            analyzeScene({ rgba, width, height, canvasWidth: width, canvasHeight: height }),
            settings,
          )
        : new AdaptiveController(field, settings);
    computeMs += performance.now() - t0;
    const buffer = new Uint8ClampedArray(width * height * 4);
    const history: BenchmarkResult['history'] = [];
    const stages: NonNullable<BenchmarkResult['stages']> = [];
    let lastStage = instance.snapshot().stage,
      lastSample = -1,
      nextSample = 0;
    let peak: number | null = null;
    instance.start();
    while (signal()) {
      const start = performance.now();
      // V1 refreshes its evaluator at the end of each call. A single-op
      // cadence makes benchmark output independent of machine speed.
      if (engine === 'v1' || captureStages) {
        for (let step = 0; step < 36 && !instance.done && instance.running; step++) {
          instance.runOps(1, Infinity);
          if ((captureStages && instance.snapshot().stage !== lastStage) || performance.now() - start >= 20)
            break;
        }
      } else instance.runOps(36, 20);
      computeMs += performance.now() - start;
      const snap = instance.snapshot();
      if (snap.opCount >= nextSample || instance.done || !instance.running) {
        instance.map.compositeRect(instance.paper.albedo, buffer, box, size, width);
        if (snap.opCount !== lastSample) {
          const accuracy = measure(whiteTone(buffer), field.tone, width, height, field.importance);
          history.push({ strokes: snap.opCount, ms: Math.round(computeMs), ssim: accuracy.ssim });
          lastSample = snap.opCount;
        }
        report(`V${engine === 'v1' ? 1 : 2} · ${snap.opCount.toLocaleString()} strokes`);
        nextSample = snap.opCount + Math.max(60, Math.round(budget / 18));
      }
      if (captureStages && snap.stage !== lastStage) {
        instance.map.compositeRect(instance.paper.albedo, buffer, box, size, width);
        stages.push({ stage: snap.stage, rgba: buffer.slice() });
        lastStage = snap.stage;
      }
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize;
      if (memory) peak = Math.max(peak ?? 0, memory);
      if (instance.done || !instance.running) {
        const accuracy = measure(whiteTone(buffer), field.tone, width, height, field.importance);
        results.push({
          engine,
          accuracy,
          count: snap.opCount,
          corrections: instance.session.corrections.length,
          meanLength: instance.session.opRecords.reduce((sum,op)=>sum+op.drawPx,0)/(instance.session.opRecords.length||1),
          computeMs,
          memory: peak,
          rgba: buffer,
          width,
          height,
          history,
          stages,
        });
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return results;
}

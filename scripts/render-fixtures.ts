/**
 * Render engine output for every fixture to PNG for visual inspection,
 * plus a reference composite for comparison (verification tooling).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { analyzeScene } from '../src/engine/analysis/scene';
import { DrawingController } from '../src/engine/control/controller';
import { GraphiteMap } from '../src/engine/media/graphite';
import { allFixtures } from '../tests/engine/fixtures';
import { encodePng } from './lib/png';

const OUT = '/home/z/my-project/download/renders';
mkdirSync(OUT, { recursive: true });

function render(controller: DrawingController): Buffer {
  const { width, height } = controller.map;
  const rgba = new Uint8ClampedArray(width * height * 4);
  controller.map.compositeRect(controller.paper.albedo, rgba, { x: 0, y: 0, w: width, h: height }, { width, height });
  return encodePng(rgba, width, height);
}

function refPng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  return encodePng(rgba, width, height);
}

const budget = Number(process.argv[2] ?? 400);
for (const fx of allFixtures()) {
  const t0 = Date.now();
  const scene = analyzeScene({ rgba: fx.rgba, width: fx.width, height: fx.height, canvasWidth: fx.width, canvasHeight: fx.height });
  const controller = new DrawingController(scene, { seed: 7, opBudget: budget, detailLevel: 0.6, fidelity: 0.7 });
  controller.start();
  let guard = 0;
  while (!controller.done && controller.opCount < budget && guard++ < budget * 4) {
    controller.runOps(1, 100000);
  }
  const wall = Date.now() - t0;
  writeFileSync(`${OUT}/${fx.name}-drawing.png`, render(controller));
  writeFileSync(`${OUT}/${fx.name}-reference.png`, refPng(fx.rgba, fx.width, fx.height));
  const m = controller.metrics;
  console.log(
    `${fx.name}: ops=${controller.opCount} stage=${controller.stage} wall=${(wall / 1000).toFixed(1)}s sim=${(controller.simTime / 60000).toFixed(1)}min ssim=${m.ssim.toFixed(3)} toneErr=${m.toneError.toFixed(3)} edge=${m.edgeAlignment.toFixed(3)}`,
  );
  // Mid-drawing snapshot info for the report.
  const stages = controller.session.events.filter((e) => e.type === 'stage').map((e) => (e as { stage: string }).stage);
  console.log(`  stages: ${stages.join(' → ')}`);
}
void GraphiteMap;

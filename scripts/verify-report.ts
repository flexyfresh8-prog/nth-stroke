/**
 * Verification report generator (spec §15: report actual measured results).
 * Runs the engine on every fixture, times it, measures accuracy and export
 * sizes, checks determinism, and prints a markdown summary.
 */

import { analyzeScene, type SceneGraph } from '../src/engine/analysis/scene';
import { DrawingController } from '../src/engine/control/controller';
import { exportSvg, exportSessionJson } from '../src/engine/session/exports';
import { allFixtures, type Fixture } from '../tests/engine/fixtures';

interface Row {
  name: string;
  ops: number;
  wallMs: number;
  simMin: number;
  ssim: number;
  tone: number;
  edge: number;
  contrast: number;
  structure: number;
  svgKB: number;
  svgPaths: number;
  sessionKB: number;
  stages: string[];
}

function buildScene(fx: Fixture): SceneGraph {
  return analyzeScene({ rgba: fx.rgba, width: fx.width, height: fx.height, canvasWidth: fx.width, canvasHeight: fx.height });
}

const rows: Row[] = [];
for (const fx of allFixtures()) {
  const scene = buildScene(fx);
  const controller = new DrawingController(scene, { seed: 7, opBudget: 900, detailLevel: 0.6, fidelity: 0.7 });
  controller.start();
  const t0 = Date.now();
  let guard = 0;
  while (!controller.done && controller.opCount < 900 && guard++ < 6000) {
    controller.runOps(1, 100000);
  }
  const wall = Date.now() - t0;
  const svg = exportSvg(controller.session, controller.map.width, controller.map.height, { seed: 7 });
  const session = exportSessionJson(controller.session);
  const stages = controller.session.events
    .filter((e) => e.type === 'stage')
    .map((e) => (e as { stage: string }).stage);
  rows.push({
    name: fx.name,
    ops: controller.opCount,
    wallMs: wall,
    simMin: controller.simTime / 60000,
    ssim: controller.metrics.ssim,
    tone: controller.metrics.toneError,
    edge: controller.metrics.edgeAlignment,
    contrast: controller.metrics.contrastError,
    structure: controller.metrics.structureError,
    svgKB: svg.byteSize / 1024,
    svgPaths: svg.pathCount,
    sessionKB: session.length / 1024,
    stages,
  });
}

// Determinism spot check
const fx = allFixtures()[0];
const run = () => {
  const c = new DrawingController(buildScene(fx), { seed: 99, opBudget: 300, detailLevel: 0.6, fidelity: 0.7 });
  c.start();
  let g = 0;
  while (!c.done && c.opCount < 300 && g++ < 2000) c.runOps(1, 100000);
  return c.map.fingerprint();
};
const fp1 = run();
const fp2 = run();

console.log('| fixture | ops | wall (s) | sim time (min) | SSIM | tone err | edge align | contrast err | structure err | SVG (KB) | SVG paths | session (KB) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.ops} | ${(r.wallMs / 1000).toFixed(1)} | ${r.simMin.toFixed(1)} | ${r.ssim.toFixed(3)} | ${r.tone.toFixed(3)} | ${r.edge.toFixed(3)} | ${r.contrast.toFixed(3)} | ${r.structure.toFixed(3)} | ${r.svgKB.toFixed(0)} | ${r.svgPaths} | ${r.sessionKB.toFixed(0)} |`,
  );
}
console.log(`\nDeterminism (sphere, seed 99, two runs): ${fp1 === fp2 ? 'IDENTICAL' : 'DIFFER'} (${fp1} / ${fp2})`);
for (const r of rows) console.log(`${r.name} stages: ${r.stages.join(' → ')}`);

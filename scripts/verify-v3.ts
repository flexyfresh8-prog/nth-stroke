// npx tsx scripts/verify-v3.ts output-dir [manga.png] [portrait.png]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import sharp from 'sharp';
import { StructuralEngine } from '../src/engine/structural/engine';
import { decodeSource } from '../src/engine/structural/source';
import { balanced } from '../src/engine/structural/settings';
import { benchmark } from '../src/engine/adaptive/benchmark';
import {
  sphereFixture,
  architectureFixture,
  landscapeFixture,
  portraitFixture,
  type Fixture,
} from '../tests/engine/fixtures';
Object.assign(globalThis, {
  Path2D,
  OffscreenCanvas: class {
    constructor(w: number, h: number) {
      return createCanvas(w, h);
    }
  },
});
async function main() {
  const [dir = 'v3-verification', ...files] = process.argv.slice(2);
  await mkdir(dir, { recursive: true });
  const examples = [
    sphereFixture(144),
    architectureFixture(168, 120),
    landscapeFixture(168, 120),
    portraitFixture(120, 156),
  ];
  for (const name of ['hair', 'ink', 'faint']) {
    const c = createCanvas(156, 132),
      ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 156, 132);
    if (name === 'ink') {
      ctx.fillStyle = 'black';
      ctx.fillRect(18, 18, 120, 96);
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.arc(78, 66, 33, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = name === 'faint' ? '#dfdfdf' : '#343434';
      ctx.lineWidth = 0.95;
      for (let i = 0; i < 22; i++) {
        ctx.beginPath();
        ctx.moveTo(20 + i * 3, 10);
        ctx.bezierCurveTo(88 + i, 40, 20 + i * 2, 85, 79 + i * 2, 120);
        ctx.stroke();
      }
    }
    examples.push({
      name,
      width: 156,
      height: 132,
      rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, 156, 132).data),
    });
  }
  for (const [i, file] of files.entries()) {
    const { data, info } = await sharp(file, { limitInputPixels: false })
      .resize({ width: 192, height: 192, fit: 'inside' })
      .flatten({ background: 'white' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    examples.push({
      name: i ? 'glasses-portrait' : 'manga-panel',
      rgba: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height,
    });
  }
  const rows: object[] = [];
  for (const f of examples) {
    const { width, height, rgba, name } = f,
      raw = { width, height, channels: 4 as const };
    const png = await sharp(Buffer.from(rgba), { raw }).png().toBuffer(),
      src = await decodeSource(new Blob([new Uint8Array(png)]));
    await writeFile(join(dir, name + '-reference.png'), png);
    const legacy = await benchmark(
      rgba,
      width,
      height,
      { seed: balanced.seed, fidelity: 1, detailLevel: 1 },
      1000,
      () => true,
      () => {},
    );
    for (const r of legacy) {
      rows.push({
        name,
        engine: r.engine,
        marks: r.count,
        ssim: r.accuracy.ssim,
        edges: (r.accuracy.precision + r.accuracy.recall) / 2,
        ms: r.computeMs,
        meanLength: r.meanLength,
      });
      await sharp(Buffer.from(r.rgba), { raw })
        .png()
        .toFile(join(dir, name + '-' + r.engine + '.png'));
    }
    const start = performance.now(),
      engine = new StructuralEngine(src, { ...balanced, budget: 1000, resolution: 512 });
    let stage = 0;
    for (const step of engine.run())
      if (step.quality) {
        const d = engine.view.ctx.getImageData(0, 0, width, height).data;
        await sharp(Buffer.from(d), { raw })
          .png()
          .toFile(join(dir, name + '-stage-' + stage++ + '.png'));
      }
    const ms = performance.now() - start,
      q = engine.lastQuality!,
      lines = engine.list.filter((v) => v.mark.axis && v.opacity),
      fills = engine.list.filter((v) => !v.mark.axis && v.opacity),
      guides = engine.list.filter((v) => v.mark.layer === 'Construction' && v.opacity > 0);
    rows.push({
      name,
      engine: 'v3',
      marks: engine.list.length,
      ssim: q.ssim,
      edges: q.edges,
      missing: q.missing,
      excess: q.excess,
      ms,
      lines: lines.length,
      fills: fills.length,
      constructionVisible: guides.length,
      meanLength: lines.reduce((s, l) => s + l.mark.length, 0) / (lines.length || 1),
      processPeakKiB: process.resourceUsage().maxRSS,
    });
    console.log(
      name,
      rows
        .slice(-3)
        .map((r) => JSON.stringify(r))
        .join(' '),
    );
    await writeFile(join(dir, 'results.json'), JSON.stringify(rows, null, 2));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

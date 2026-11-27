import sharp from 'sharp';
import { join } from 'node:path';

const dir = process.argv[2] || 'v3-verification';
const names = process.argv.slice(3);

async function main() {
  for (const n of names) {
    const imgs = [n + '-reference.png', ...Array.from({ length: 8 }, (_, s) => `${n}-stage-${s}.png`)];
    const metas = await Promise.all(imgs.map((f) => sharp(join(dir, f)).metadata()));
    const w = metas[0].width!;
    const h = metas[0].height!;
    const bufs = await Promise.all(imgs.map((f) => sharp(join(dir, f)).removeAlpha().raw().toBuffer()));
    await sharp({ create: { width: w * imgs.length, height: h, channels: 3, background: '#fff' } })
      .composite(
        imgs.map((_, i) => ({
          input: bufs[i],
          raw: { width: w, height: h, channels: 3 as const },
          left: i * w,
          top: 0,
        })),
      )
      .jpeg({ quality: 82 })
      .toFile(`/tmp/${n}-strip.jpg`);
    console.log(n, 'strip ok', imgs.length * w, 'x', h);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

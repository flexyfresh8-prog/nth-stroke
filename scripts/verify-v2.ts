/** Run with npx tsx scripts/verify-v2.ts output-directory [portrait] [manga] [budget]. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { sphereFixture, landscapeFixture, portraitFixture, type Fixture } from '../tests/engine/fixtures';
import type { Stage } from '../src/engine/core/types';
import type { BenchmarkResult } from '../src/engine/worker/protocol';
import { benchmark } from '../src/engine/adaptive/benchmark';

async function raster(name: string, input: Buffer | string): Promise<Fixture> {
  const { data, info } = await sharp(input)
    .resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { name, width: info.width, height: info.height, rgba: new Uint8ClampedArray(data) };
}
const svg = (content: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384"><rect width="384" height="384" fill="white"/>${content}</svg>`,
  );
function cube() {
  return svg(`<defs><linearGradient id="side" x2="1" y2="1"><stop stop-color="#777"/><stop offset="1" stop-color="#242424"/></linearGradient><radialGradient id="shadow"><stop stop-color="#555" stop-opacity=".7"/><stop offset="1" stop-color="#555" stop-opacity="0"/></radialGradient></defs>
<ellipse cx="218" cy="298" rx="140" ry="39" fill="url(#shadow)"/><path fill="#e9e9e9" d="M86 112 198 56 311 113 198 167Z"/><path fill="#adadad" d="M86 112 198 167 198 309 86 250Z"/><path fill="url(#side)" d="M198 167 311 113 311 252 198 309Z"/>`);
}
function illustration() {
  const skyline = Array.from({ length: 22 }, (_, i) => {
    const x = i * 19,
      y = 198 + ((i * 73) % 87);
    return `<path fill="hsl(${188 + i * 3} 31% ${30 + (i % 8) * 4}%)" d="M${x} 384V${y}h17v384Z"/>
      <path stroke="#d6c992" stroke-dasharray="2 5" stroke-width="4" d="M${x + 5} ${y + 7}V365m6 -${365 - y - 7}V365"/>`;
  }).join('');
  const hair = Array.from({ length: 24 }, (_, i) => {
    const x = 88 + i * 8,
      y = 135 - (i % 4) * 6;
    return `<path fill="none" stroke="${i % 3 ? '#b97187' : '#251b31'}" stroke-width="${i % 3 ? 1.2 : 2.8}" d="M${x} ${y} Q${x + 37} ${y + 40} ${x + (i % 2 ? 14 : 27)} ${245 + ((i * 29) % 40)}"/>`;
  }).join('');
  return svg(`<rect width="384" height="384" fill="#b5c8c7"/><circle cx="294" cy="80" r="54" fill="#f4e3b0"/>${skyline}
  <g stroke="#241b2a" stroke-linejoin="round"><path fill="#804860" stroke-width="4" d="M65 310 Q80 253 73 177 Q63 78 151 66 Q220 43 261 116 Q283 160 278 262 L321 333 176 345Z"/>
  <path fill="#f2c8ad" stroke-width="3" d="M103 152 Q147 129 177 96 Q195 134 249 150 L245 205 Q219 259 184 278 Q132 264 104 216Z"/>
  <path fill="#f2c8ad" stroke-width="3" d="M160 250 155 296 215 308 209 247"/><path fill="#32293b" stroke-width="4" d="M66 384 Q61 332 154 293 L188 310 215 293 Q295 305 319 384Z"/>
  <path fill="#f5f0e5" stroke-width="3" d="M116 178 Q135 149 166 175 Q155 199 129 195Z M187 172 Q208 148 235 169 Q221 196 198 190Z"/>
  <ellipse cx="142" cy="177" rx="11" ry="15" fill="#527a8d" stroke-width="4"/><ellipse cx="212" cy="173" rx="11" ry="15" fill="#527a8d" stroke-width="4"/>
  <path d="M117 156 Q138 146 156 151 M190 148 Q214 138 230 148 M173 179 Q167 209 158 214 L171 218 M150 235 Q176 224 198 231 Q174 246 150 235" fill="none" stroke-width="3"/>
  <path fill="#b17186" stroke-width="3" d="M83 173 Q74 100 145 74 L186 71 Q175 125 111 166 L104 232 87 270Z M183 72 Q267 81 260 157 L248 224 234 245 Q254 154 219 140 Q183 116 183 72Z"/>${hair}
  <path d="M131 305 180 354 204 347 238 307 M180 354l-15 30m39-37 30 37" fill="none" stroke="#d5c4ae" stroke-width="4"/>
  </g><g fill="#fff"><circle cx="138" cy="172" r="4"/><circle cx="208" cy="166" r="4"/></g>`);
}
function detailedLines() {
  return svg(
    Array.from({ length: 10 }, (_, i) => {
      const a = (i * Math.PI) / 5,
        x = 192 + 144 * Math.cos(a),
        y = 192 + 144 * Math.sin(a);
      return `<path d="M192 192 Q${x - 60} ${y + 45} ${x} ${y} Q${x + 35} ${y - 42} 192 192Z" stroke="#272727" fill="none" stroke-width="2.3"/>`;
    }).join('') +
      Array.from(
        { length: 12 },
        (_, i) =>
          `<circle cx="192" cy="192" r="${10 + i * 12}" fill="none" stroke="#3c3c3c" stroke-width="${i % 4 === 0 ? 2.9 : 1.2}" stroke-dasharray="${i % 3 === 0 ? '4 6' : '0'}"/>`,
      ).join(''),
  );
}

async function main() {
  const [folder = 'v2-renders', photo, manga, requested] = process.argv.slice(2);
  const budget = Number(requested ?? 6000);
  await mkdir(folder, { recursive: true });
  const fixtures = [
    sphereFixture(320),
    await raster('cube', cube()),
    photo ? await raster('real-portrait', photo) : portraitFixture(312, 384),
    ...(manga ? [await raster('manga-glasses', manga)] : []),
    await raster('complex-anime', illustration()),
    landscapeFixture(384, 256),
    await raster('line-art', detailedLines()),
    await raster(
      'high-contrast',
      svg(
        '<path fill="#000" d="M51 47h282v282H51z"/><path fill="#fff" d="M62 290 191 60 317 290 191 241z"/><circle fill="#000" cx="191" cy="194" r="30"/><path fill="#fff" d="M194 174h14v17h-14z"/>',
      ),
    ),
  ];
  const all: Array<{
    name: string;
    width: number;
    height: number;
    results: Array<Omit<BenchmarkResult, 'rgba' | 'stages'> & { stages?: Stage[] }>;
  }> = [];
  const filter = process.env.NTH_FIXTURE_FILTER;
  for (const fixture of fixtures.filter((f) => !filter || f.name === filter)) {
    const { name, width, height, rgba } = fixture,
      raw = { width, height, channels: 4 as const };
    await sharp(Buffer.from(rgba), { raw })
      .png()
      .toFile(join(folder, `${name}-reference.png`));
    const results = await benchmark(
      rgba,
      width,
      height,
      { seed: 20260101, detailLevel: 1, fidelity: 1, paperGrain: 0.16 },
      budget,
      () => true,
      () => {},
      true,
    );
    for (const r of results) {
      await sharp(Buffer.from(r.rgba), { raw })
        .png()
        .toFile(join(folder, `${name}-${r.engine}.png`));
      for (const [i, stage] of (r.stages ?? []).entries())
        await sharp(Buffer.from(stage.rgba), { raw })
          .png()
          .toFile(join(folder, `${name}-${r.engine}-${i}-${stage.stage}.png`));
    }
    const summary = results.map(({ rgba: _pixels, stages, ...values }) => ({
      ...values,
      stages: stages?.map((s) => s.stage),
    }));
    all.push({ name, width, height, results: summary });
    console.log(
      name,
      summary.map((r) => [r.engine, r.accuracy.ssim.toFixed(3), r.count, Math.round(r.computeMs)]),
    );
    await writeFile(join(folder, 'results.json'), JSON.stringify({ budget, fixtures: all }, null, 2));
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

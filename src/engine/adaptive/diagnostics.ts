import type { AdaptiveController } from './controller';
export const MAPS = [
  'Luminance',
  'Fine edges',
  'Coarse edges',
  'Segmentation',
  'Facial landmarks',
  'Structural landmarks',
  'Feature importance',
  'Saliency',
  'Flow',
  'Residual',
  'Pigment',
  'Saturation',
  'Candidates',
  'Rejected strokes',
  'Active region',
] as const;
export type MapName = (typeof MAPS)[number];

export function diagnostic(engine: AdaptiveController, view: MapName) {
  const f = engine.field,
    d = engine.map.density,
    { width, height } = f;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const dot = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
  };
  for (let p = 0; p < d.length; p++) {
    const r = 1 - f.tone[p] - d[p];
    let v = f.tone[p];
    switch (view) {
      case 'Fine edges':
        v = f.edge[p] * 3;
        break;
      case 'Coarse edges':
        v = f.coarseEdge[p] * 5;
        break;
      case 'Segmentation':
        v = (((Math.imul(f.regions[p], 2654435761) >>> 17) % 217) + 28) / 255;
        break;
      case 'Feature importance':
        v = f.importance[p];
        break;
      case 'Saliency':
        v = f.saliency[p];
        break;
      case 'Residual':
        v = 0.5 + r * 0.5;
        break;
      case 'Pigment':
        v = d[p];
        break;
      case 'Saturation':
        v = d[p] > 0.94 ? 1 : 0;
        break;
      case 'Candidates':
      case 'Rejected strokes':
      case 'Active region':
        v = (1 - d[p]) * 0.65 + 0.2;
        break;
      case 'Flow':
        v = 0.18 + 0.31 * f.coherence[p];
        break;
    }
    const i = p * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v * 255;
    rgba[i + 3] = 255;
  }
  if (view === 'Facial landmarks')
    for (const p of f.landmarks)
      for (let i = -3; i <= 3; i++) {
        dot(p.x + i, p.y, 0);
        dot(p.x, p.y + i, 0);
      }
  if (view === 'Structural landmarks')
    for (let y = 4; y < height - 4; y += 12)
      for (let x = 4; x < width - 4; x += 12) {
        let interest = 0,
          px = x,
          py = y;
        for (let j = y; j < Math.min(height, y + 9); j++)
          for (let i = x; i < Math.min(width, x + 9); i++) {
            const p = j * width + i,
              score = f.edge[p] * (0.18 + f.contrast[p]) * (1 - f.coherence[p]);
            if (score > interest) {
              interest = score;
              px = i;
              py = j;
            }
          }
        if (interest > 0.018)
          for (let j = -2; j <= 2; j++) {
            dot(px + j, py, 0);
            dot(px, py + j, 0);
          }
      }
  if (view === 'Flow')
    for (let y = 5; y < height - 4; y += 9)
      for (let x = 5; x < width - 4; x += 9) {
        const i = y * width + x,
          a = f.angle[i],
          length = 2 + f.coherence[i] * 3;
        for (let j = -length; j <= length; j += 0.5) dot(x + Math.cos(a) * j, y + Math.sin(a) * j, 235);
      }
  if (view === 'Candidates' || view === 'Rejected strokes') {
    const trials = engine.optimizer.trials.filter((t) =>
      view === 'Candidates' ? t.gain > 0 : t.gain <= 0.00018,
    );
    for (const trial of trials)
      for (let i = 1; i < trial.mark.path.length; i++) {
        const a = trial.mark.path[i - 1],
          b = trial.mark.path[i],
          len = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
        for (let j = 0; j <= len; j++) dot(a.x + ((b.x - a.x) * j) / len, a.y + ((b.y - a.y) * j) / len, 15);
      }
  }
  if (view === 'Active region') {
    const r = engine.activeRegion;
    if (r)
      for (let j = 0; j < Math.max(r.w, r.h); j++) {
        if (j < r.w) {
          dot(r.x + j, r.y, 0);
          dot(r.x + j, r.y + r.h - 1, 0);
        }
        if (j < r.h) {
          dot(r.x, r.y + j, 0);
          dot(r.x + r.w - 1, r.y + j, 0);
        }
      }
  }
  return { rgba, width, height };
}

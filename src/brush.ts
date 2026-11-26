import type { Point, Stroke } from './engine';

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);

export function surface(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Deterministic per-stroke randomness so partial playback renders exactly
// like the committed artwork while every stroke stays unique.
function strokeSeed(stroke: Stroke) {
  return (Math.imul(stroke.order + 1, 0x9e3779b1) ^ 0x7c1d51e5) >>> 0;
}

function hash01(i: number, salt: number, seed: number) {
  let t = (Math.imul(i + 0x9e3779b1, 0x85ebca6b) ^ Math.imul(salt + 0x165667b1, 0xc2b2ae35) ^ seed) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

export function measurePath(stroke: Stroke, width: number, height: number) {
  const lengths = [0];
  const { path } = stroke;
  for (let i = 1; i < path.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot((path[i].x - path[i - 1].x) * width, (path[i].y - path[i - 1].y) * height));
  }
  return lengths;
}

function positionOnPath(stroke: Stroke, lengths: number[], fraction: number) {
  const distance = lengths[lengths.length - 1] * fraction;
  let index = 1;
  while (index < lengths.length - 1 && lengths[index] < distance) index++;
  const segment = lengths[index] - lengths[index - 1];
  const t = segment > 0 ? (distance - lengths[index - 1]) / segment : 0;
  const a = stroke.path[index - 1];
  const b = stroke.path[index];
  return { point: { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) }, index, t };
}

export function tip(stroke: Stroke, lengths: number[], fraction: number): Point {
  if (fraction >= 1) return stroke.end;
  return positionOnPath(stroke, lengths, fraction).point;
}

// A real nib leaves elliptical footprints: elongated along the motion,
// rotated with the hand, and never twice the same width.
interface Dab extends Point { rx: number; ry: number; rot: number }

function outline(stroke: Stroke, lengths: number[], fraction: number, width: number, height: number, scale: number) {
  if (fraction <= 0) return [];
  const last = positionOnPath(stroke, lengths, fraction);
  const dabs: Dab[] = [];
  const seed = strokeSeed(stroke);
  const phase1 = (seed >>> 3) % 6.28318;
  const phase2 = (seed >>> 13) % 6.28318;
  const phase3 = (seed >>> 23) % 6.28318;
  const tangentAt = (i: number) => {
    const a = stroke.path[Math.max(0, i - 1)], b = stroke.path[Math.min(stroke.path.length - 1, i + 1)];
    return Math.atan2((b.y - a.y) * height, (b.x - a.x) * width);
  };
  const dab = (p: Point, pressure: number, i: number, tangent: number) => {
    const base = Math.max(0.05, stroke.size * scale * (stroke.material === 'pencil' || stroke.feature !== undefined ? 0.045 + pressure * 0.60 : 0.17 + pressure * 0.43));
    const wobble = 1 + 0.05 * Math.sin(i * 1.31 + phase3) + 0.06 * (hash01(i, 3, seed) - 0.5);
    const elong = clamp(0.16 + 0.14 * Math.sin(i * 0.83 + phase1) + 0.10 * Math.sin(i * 2.17 + phase2) + 0.14 * (hash01(i, 5, seed) - 0.5), 0, 0.44);
    const rot = tangent + (hash01(i, 7, seed) - 0.5) * 0.26;
    return {
      x: p.x * width, y: p.y * height,
      rx: Math.max(0.05, base * wobble * (1 + elong)),
      ry: Math.max(0.05, base * wobble * (1 - elong * 0.55)),
      rot,
    };
  };
  for (let i = 0; i < last.index; i++) dabs.push(dab(stroke.path[i], stroke.pressure[i] ?? 0.65, i, tangentAt(i)));
  const a = stroke.path[last.index - 1], b = stroke.path[Math.min(last.index, stroke.path.length - 1)];
  const midTangent = Math.atan2((b.y - a.y) * height, (b.x - a.x) * width);
  dabs.push(dab(last.point, mix(stroke.pressure[last.index - 1] ?? 0.65, stroke.pressure[last.index] ?? 0.65, last.t), last.index, midTangent));
  return dabs;
}

function ribbon(a: Dab, b: Dab) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!length) return [];
  const nx = (a.y - b.y) / length;
  const ny = (b.x - a.x) / length;
  return [
    { x: a.x + nx * a.ry, y: a.y + ny * a.ry },
    { x: a.x - nx * a.ry, y: a.y - ny * a.ry },
    { x: b.x - nx * b.ry, y: b.y - ny * b.ry },
    { x: b.x + nx * b.ry, y: b.y + ny * b.ry },
  ];
}

// Long edges of the connecting ribbon sag slightly — hand strokes never
// have perfectly straight sides between footprints.
function bow(a: Point, b: Point, i: number, salt: number, seed: number) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 0.4) return null;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
  const amount = length * (0.05 + 0.12 * hash01(i, salt, seed)) * (Math.sin(i * 1.13 + salt * 2.1 + (seed >>> 6) % 6.28318) > 0 ? 1 : -1);
  return { x: mx + nx * amount, y: my + ny * amount };
}

// A pencil laid on its side leaves a soft base with darker, uneven filaments.
function pencilLayers(stroke: Stroke, dabs: Dab[]) {
  if (stroke.material !== 'pencil' || dabs.length < 2) return [{ dabs, alpha: stroke.opacity }];
  const seed = strokeSeed(stroke);
  const layers = [{ dabs, alpha: stroke.opacity * 0.53 }];
  for (let strand = 0; strand < 3; strand++) {
    let nx = 0, ny = 1;
    const line = dabs.map((dab, i) => {
      const a = dabs[Math.max(0, i - 1)], b = dabs[Math.min(dabs.length - 1, i + 1)];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > 0) { nx = (a.y - b.y) / length; ny = (b.x - a.x) / length; }
      const grain = Math.sin(2.3 * i + strand * 1.8 + (seed >>> (4 + strand * 5)) % 6.28318);
      const offset = dab.ry * ((strand - 1) * 0.62 + grain * 0.09);
      const radius = Math.max(0.04, dab.ry * (0.17 + 0.07 * grain));
      return { x: dab.x + nx * offset, y: dab.y + ny * offset, rx: radius * (1 + grain * 0.16), ry: radius, rot: dab.rot + grain * 0.12 };
    });
    layers.push({ dabs: line, alpha: stroke.opacity * (0.35 + 0.07 * strand) });
  }
  return layers;
}

export function paintBrush(
  ctx: CanvasRenderingContext2D, stroke: Stroke, lengths: number[], fraction: number, scale = 1,
) {
  const dabs = outline(stroke, lengths, fraction, ctx.canvas.width, ctx.canvas.height, scale);
  if (!dabs.length) return;
  ctx.fillStyle = stroke.color;
  const seed = strokeSeed(stroke);
  for (const layer of pencilLayers(stroke, dabs)) {
    ctx.globalAlpha = layer.alpha;
    paintDabs(ctx, layer.dabs, seed);
  }
  ctx.globalAlpha = 1;
}

function paintDabs(ctx: CanvasRenderingContext2D, dabs: Dab[], seed: number) {
  ctx.beginPath();
  for (let i = 0; i < dabs.length; i++) {
    const { x, y, rx, ry, rot } = dabs[i];
    ctx.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    if (!i) continue;
    const vertices = ribbon(dabs[i - 1], dabs[i]);
    if (!vertices.length) continue;
    const [p0, p1, p2, p3] = vertices;
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    const c12 = bow(p1, p2, i, 11, seed);
    if (c12) ctx.quadraticCurveTo(c12.x, c12.y, p2.x, p2.y); else ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    const c30 = bow(p3, p0, i, 13, seed);
    if (c30) ctx.quadraticCurveTo(c30.x, c30.y, p0.x, p0.y); else ctx.lineTo(p0.x, p0.y);
    ctx.closePath();
  }
  ctx.fill();
}

export function brushSvg(stroke: Stroke, width: number, height: number) {
  const dabs = outline(stroke, measurePath(stroke, width, height), 1, width, height, 1);
  const seed = strokeSeed(stroke);
  return pencilLayers(stroke, dabs).map(layer => dabsSvg(layer.dabs, stroke.color, layer.alpha, seed)).join('');
}

function dabsSvg(dabs: Dab[], color: string, opacity: number, seed: number) {
  const n = (v: number) => v.toFixed(3);
  const deg = (r: number) => ((r * 180 / Math.PI) % 360).toFixed(3);
  const parts = dabs.map(({ x, y, rx, ry, rot }, i) => {
    const cx = Math.cos(rot), sx = Math.sin(rot);
    const arc = `M${n(x + rx * cx)} ${n(y + rx * sx)}A${n(rx)} ${n(ry)} ${deg(rot)} 1 1 ${n(x - rx * cx)} ${n(y - rx * sx)}A${n(rx)} ${n(ry)} ${deg(rot)} 1 1 ${n(x + rx * cx)} ${n(y + rx * sx)}Z`;
    const vertices = i ? ribbon(dabs[i - 1], dabs[i]) : [];
    let quad = '';
    if (vertices.length) {
      const [p0, p1, p2, p3] = vertices;
      const c12 = bow(p1, p2, i, 11, seed), c30 = bow(p3, p0, i, 13, seed);
      quad = `M${n(p0.x)} ${n(p0.y)}L${n(p1.x)} ${n(p1.y)} `
        + (c12 ? `Q${n(c12.x)} ${n(c12.y)} ` : 'L') + `${n(p2.x)} ${n(p2.y)} `
        + `L${n(p3.x)} ${n(p3.y)} `
        + (c30 ? `Q${n(c30.x)} ${n(c30.y)} ` : 'L') + `${n(p0.x)} ${n(p0.y)}Z`;
    }
    return arc + quad;
  });
  return `<path d="${parts.join('')}" fill="${color}" opacity="${opacity.toFixed(4)}"/>`;
}

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

interface Dab extends Point { radius: number }

function outline(stroke: Stroke, lengths: number[], fraction: number, width: number, height: number, scale: number) {
  if (fraction <= 0) return [];
  const last = positionOnPath(stroke, lengths, fraction);
  const dabs: Dab[] = [];
  const dab = (p: Point, pressure: number) => ({
    x: p.x * width,
    y: p.y * height,
    radius: Math.max(0.05, stroke.size * scale * (stroke.material === 'pencil' || stroke.feature !== undefined ? 0.045 + pressure * 0.60 : 0.17 + pressure * 0.43)),
  });
  for (let i = 0; i < last.index; i++) dabs.push(dab(stroke.path[i], stroke.pressure[i] ?? 0.65));
  dabs.push(dab(last.point, mix(stroke.pressure[last.index - 1] ?? 0.65, stroke.pressure[last.index] ?? 0.65, last.t)));
  return dabs;
}

function ribbon(a: Dab, b: Dab) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!length) return [];
  const nx = (a.y - b.y) / length;
  const ny = (b.x - a.x) / length;
  return [
    { x: a.x + nx * a.radius, y: a.y + ny * a.radius },
    { x: a.x - nx * a.radius, y: a.y - ny * a.radius },
    { x: b.x - nx * b.radius, y: b.y - ny * b.radius },
    { x: b.x + nx * b.radius, y: b.y + ny * b.radius },
  ];
}

// A pencil laid on its side leaves a soft base with darker, uneven filaments.
function pencilLayers(stroke: Stroke, dabs: Dab[]) {
  if (stroke.material !== 'pencil' || dabs.length < 2) return [{ dabs, alpha: stroke.opacity }];
  const layers = [{ dabs, alpha: stroke.opacity * 0.53 }];
  for (let strand = 0; strand < 3; strand++) {
    let nx = 0, ny = 1;
    const line = dabs.map((dab, i) => {
      const a = dabs[Math.max(0, i - 1)], b = dabs[Math.min(dabs.length - 1, i + 1)];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > 0) { nx = (a.y - b.y) / length; ny = (b.x - a.x) / length; }
      const grain = Math.sin(2.3 * i + strand * 1.8 + stroke.order * 3.1);
      const offset = dab.radius * ((strand - 1) * 0.62 + grain * 0.09);
      return { x: dab.x + nx * offset, y: dab.y + ny * offset, radius: dab.radius * (0.17 + 0.07 * grain) };
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
  for (const layer of pencilLayers(stroke, dabs)) {
    ctx.globalAlpha = layer.alpha;
    paintDabs(ctx, layer.dabs);
  }
  ctx.globalAlpha = 1;
}

function paintDabs(ctx: CanvasRenderingContext2D, dabs: Dab[]) {
  ctx.beginPath();
  for (let i = 0; i < dabs.length; i++) {
    const { x, y, radius } = dabs[i];
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.closePath();
    if (!i) continue;
    const vertices = ribbon(dabs[i - 1], dabs[i]);
    if (!vertices.length) continue;
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (const vertex of vertices.slice(1)) ctx.lineTo(vertex.x, vertex.y);
    ctx.closePath();
  }
  ctx.fill();
}

export function brushSvg(stroke: Stroke, width: number, height: number) {
  const dabs = outline(stroke, measurePath(stroke, width, height), 1, width, height, 1);
  return pencilLayers(stroke, dabs).map(layer => dabsSvg(layer.dabs, stroke.color, layer.alpha)).join('');
}

function dabsSvg(dabs: Dab[], color: string, opacity: number) {
  const n = (v: number) => v.toFixed(3);
  const parts = dabs.map(({ x, y, radius: r }, i) => {
    const arc = `M${n(x + r)} ${n(y)}a${n(r)} ${n(r)} 0 1 1 ${n(-2 * r)} 0a${n(r)} ${n(r)} 0 1 1 ${n(2 * r)} 0Z`;
    const vertices = i ? ribbon(dabs[i - 1], dabs[i]) : [];
    return arc + (vertices.length ? `M${vertices.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}Z` : '');
  });
  return `<path d="${parts.join('')}" fill="${color}" opacity="${opacity.toFixed(4)}"/>`;
}

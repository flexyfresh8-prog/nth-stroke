import type { Layer } from './settings';
export type P = [number, number];
export type Box = [number, number, number, number];
export interface Mark {
  d: string;
  axis?: string;
  points?: P[];
  layer: Layer;
  subject: boolean;
  opacity: number;
  width: number;
  pressure: number[];
  speed: number;
  importance: number;
  box: Box;
  length: number;
  stage: number;
}
export type Action =
  { kind: 'add'; mark: Mark } | {kind:'reshape';index:number;mark:Mark;merged?:number} | { kind: 'edit'; index: number; opacity: number; dx?: number; dy?: number };
export interface Placed {
  mark: Mark;
  opacity: number;
  dx: number;
  dy: number;
}
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const xy = (p: P) => num(p[0]) + ' ' + num(p[1]);
export const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function simplify(p: P[], tolerance: number) {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length),
    stack = [0, p.length - 1];
  keep[0] = keep[p.length - 1] = 1;
  while (stack.length) {
    const end = stack.pop()!,
      start = stack.pop()!,
      a = p[start],
      b = p[end],
      vx = b[0] - a[0],
      vy = b[1] - a[1],
      den = vx * vx + vy * vy;
    let high = tolerance * tolerance,
      split = -1;
    for (let i = start + 1; i < end; i++) {
      const x = p[i][0] - a[0],
        y = p[i][1] - a[1],
        u = den ? Math.max(0, Math.min(1, (x * vx + y * vy) / den)) : 0;
      const err = (x - u * vx) ** 2 + (y - u * vy) ** 2;
      if (err > high) {
        high = err;
        split = i;
      }
    }
    if (split >= 0) {
      keep[split] = 1;
      stack.push(start, split, split, end);
    }
  }
  return p.filter((_, i) => keep[i]);
}
function spline(p: P[], closed = false) {
  if (!p.length) return '';
  const n = p.length,
    last = closed ? n : n - 1;
  let d = 'M' + xy(p[0]);
  const at = (i: number) => p[closed ? (i + n) % n : Math.min(n - 1, Math.max(0, i))];
  for (let i = 0; i < last; i++) {
    const a = at(i),
      b = at(i + 1),
      l = at(i - 1),
      r = at(i + 2);
    // Bounded chord-length tangents avoid loops at short segments and preserve cusps.
    const handle = (q: P, u: P, v: P, len: number, sign: number): P => {
      const norm = distance(u, v) || 1,
        k = (Math.min(len / 3, norm / 6) * sign) / norm;
      const clamp = (n: number, i: number) =>
        Math.min(Math.max(a[i], b[i]), Math.max(Math.min(a[i], b[i]), n));
      return [clamp(q[0] + (v[0] - u[0]) * k, 0), clamp(q[1] + (v[1] - u[1]) * k, 1)];
    };
    const len = distance(a, b);
    d += 'C' + xy(handle(a, l, b, len, 1)) + ' ' + xy(handle(b, a, r, len, -1)) + ' ' + xy(b);
  }
  return d + (closed ? 'Z' : '');
}
export function bounds(p: P[], margin = 0): Box {
  let x = Infinity,
    y = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const [i, j] of p) {
    x = Math.min(x, i);
    r = Math.max(r, i);
    y = Math.min(y, j);
    b = Math.max(b, j);
  }
  return [x - margin, y - margin, r + margin, b + margin];
}
export function stroke(
  points: P[],
  width: number,
  variation: number,
): Pick<Mark, 'd' | 'axis' | 'pressure' | 'length' | 'width' | 'box' | 'points'> {
  let p = points;
  if (p.length === 2) p = [p[0], [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2], p[1]];
  const lens = [0];
  for (let i = 1; i < p.length; i++) lens.push(lens[i - 1] + distance(p[i], p[i - 1]));
  const length = lens.at(-1)!,
    left: P[] = [],
    right: P[] = [],
    pressure: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(i - 1, 0)],
      b = p[Math.min(i + 1, p.length - 1)],
      l = distance(a, b) || 1;
    const t = lens[i] / (length || 1),
      k = 1 - variation * 0.88 + variation * 0.88 * Math.sin(Math.PI * t) ** 0.55;
    const dx = (-(b[1] - a[1]) * k * width) / (2 * l),
      dy = ((b[0] - a[0]) * k * width) / (2 * l);
    left.push([p[i][0] + dx, p[i][1] + dy]);
    right.push([p[i][0] - dx, p[i][1] - dy]);
    pressure.push(+k.toFixed(3));
  }
  return {
    d: spline(left.concat(right.reverse()), true),
    axis: spline(p),
    points: p,
    pressure,
    length,
    width,
    box: bounds(p, width * 2),
  };
}
export function ink(rings: P[][]): Pick<Mark, 'd' | 'pressure' | 'length' | 'width' | 'box'> {
  const box = bounds(rings[0]);
  let length = 0;
  for (const r of rings) for (let i = 0; i < r.length; i++) length += distance(r[i], r[(i + 1) % r.length]);
  return { d: rings.map((r) => spline(r, true)).join(''), box, length, pressure: [], width: 0 };
}
export type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const paths = new Map<string, Path2D>();
export function paint(ctx: Context, v: Placed) {
  if (v.opacity <= 0) return;
  let path = paths.get(v.mark.d);
  if (!path) {
    path = new Path2D(v.mark.d);
    if (paths.size >= 1024) paths.delete(paths.keys().next().value!);
    paths.set(v.mark.d, path);
  }
  ctx.save();
  ctx.translate(v.dx, v.dy);
  ctx.globalAlpha = v.opacity;
  ctx.fillStyle = '#000';
  ctx.fill(path, 'evenodd');
  ctx.restore();
}
export function apply(list: Placed[], a: Action) {
  if (a.kind === 'add') list.push({ mark: a.mark, opacity: a.mark.opacity, dx: 0, dy: 0 });
  else if(a.kind==='reshape'){
    if(list[a.index])list[a.index]={mark:a.mark,opacity:a.mark.opacity,dx:0,dy:0};
    if(a.merged!==undefined&&list[a.merged])list[a.merged].opacity=0;
  }
  else if (list[a.index]) Object.assign(list[a.index], { opacity: a.opacity, dx: a.dx ?? 0, dy: a.dy ?? 0 });
}
export function svg(list: Placed[], w: number, h: number, paper = false) {
  // Interleaved layers retain chronological compositing.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    w +
    ' ' +
    h +
    '" width="' +
    w +
    '" height="' +
    h +
    '"><title>NTH Stroke V3</title><metadata>NTH Stroke V3 · Hierarchical Structural Drawing Engine</metadata>' +
    (paper ? '<rect width="100%" height="100%" fill="white"/>' : '') +
    list
      .filter((v) => v.opacity > 0)
      .map(
        (v) =>
          '<g data-layer="' +
          v.mark.layer +
          '" data-subject="' +
          v.mark.subject +
          '"><path fill-rule="evenodd" fill-opacity="' +
          num(v.opacity) +
          '" transform="translate(' +
          num(v.dx) +
          ' ' +
          num(v.dy) +
          ')" d="' +
          v.mark.d +
          '"/></g>',
      )
      .join('') +
    '</svg>'
  );
}

/** Small vector / geometry helpers shared across the engine. */

import type { Vec2 } from './types';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const smootherstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

export const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function addVec(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subVec(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scaleVec(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function normVec(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
}

export function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Polyline length. */
export function pathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Cumulative arclength at each vertex (length points.length, first = 0). */
export function cumulativeLengths(points: readonly Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + dist(points[i - 1], points[i]));
  return out;
}

/** Point at normalized arclength t in [0,1] along a polyline. */
export function pointAtFraction(points: readonly Vec2[], t: number): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const total = pathLength(points);
  const target = clamp(t, 0, 1) * total;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (acc + seg >= target || i === points.length - 1) {
      const f = seg > 0 ? (target - acc) / seg : 0;
      return lerpVec(points[i - 1], points[i], clamp(f, 0, 1));
    }
    acc += seg;
  }
  return { ...points[points.length - 1] };
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxSq = 0;
    let index = -1;
    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
      t = clamp(t, 0, 1);
      const px = a.x + t * dx - p.x;
      const py = a.y + t * dy - p.y;
      const sq = px * px + py * py;
      if (sq > maxSq) {
        maxSq = sq;
        index = i;
      }
    }
    if (index >= 0 && maxSq > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Resample a polyline to (approximately) uniform spacing. */
export function resample(points: readonly Vec2[], spacing: number): Vec2[] {
  if (points.length < 2 || spacing <= 0) return [...points];
  const out: Vec2[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    let seg = dist(points[i - 1], points[i]);
    let t = 0;
    while (carry + seg >= spacing) {
      const need = spacing - carry;
      t += need / seg;
      if (t > 1) t = 1;
      out.push(lerpVec(points[i - 1], points[i], t));
      seg -= need;
      carry = 0;
      if (t >= 1) break;
    }
    carry += seg;
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > spacing * 0.35) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Local curvature radius at vertex i (Infinity on straight segments). */
export function curvatureRadius(points: readonly Vec2[], i: number): number {
  const a = points[Math.max(0, i - 1)];
  const b = points[i];
  const c = points[Math.min(points.length - 1, i + 1)];
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  if (area < 1e-9) return Infinity;
  return (ab * bc * ca) / (4 * area);
}

/** Catmull-Rom interpolation over a control polyline, sampled per segment. */
export function catmullRom(points: readonly Vec2[], samplesPerSegment: number): Vec2[] {
  if (points.length < 3) return [...points];
  const pts = [points[0], ...points, points[points.length - 1]];
  const out: Vec2[] = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2];
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

/** Angle of the tangent at vertex i. */
export function tangentAngle(points: readonly Vec2[], i: number): number {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

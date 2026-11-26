/**
 * Contour chain extraction: turns the edge field into drawable polylines
 * with importance scores (spec §4-C). Chains follow non-maximum-suppressed
 * edges, are simplified, and carry saliency/tone contrast so the refinement
 * planner can order them like an artist: big structural silhouettes first.
 */

import { clamp, simplify } from '../core/math';
import type { Vec2 } from '../core/types';
import type { ClassicalFields } from './classical';

export interface ContourChain {
  id: number;
  /** Analysis-resolution coordinates. */
  points: Vec2[];
  length: number;
  /** Mean edge strength 0..1. */
  strength: number;
  /** Mean saliency 0..1. */
  saliency: number;
  /** Tone jump across the contour 0..1. */
  contrast: number;
  closed: boolean;
  bbox: { x: number; y: number; w: number; h: number };
}

export function extractContours(fields: ClassicalFields, minChainLength = 6, maxChains = 220): ContourChain[] {
  const { width, height, edges, gradDir, saliency, lum } = fields;
  const visited = new Uint8Array(width * height);
  const chains: ContourChain[] = [];
  const DIRS = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ] as const;

  // Follow an edge from a strong seed in both directions.
  const follow = (sx: number, sy: number): Vec2[] => {
    const pts: Vec2[] = [];
    const walk = (x0: number, y0: number, dx0: number, dy0: number, reverse: boolean) => {
      let x = x0;
      let y = y0;
      let pdx = dx0;
      let pdy = dy0;
      for (let guard = 0; guard < 4096; guard++) {
        const i = y * width + x;
        if (visited[i] || edges[i] < 0.35) break;
        visited[i] = 1;
        pts.push({ x: x + 0.5, y: y + 0.5 });
        // Choose the next pixel: strongest unvisited neighbour most aligned
        // with the local contour direction (gradient ⊥).
        const contourDir = gradDir[i] + Math.PI / 2;
        let bestScore = -Infinity;
        let nx = x;
        let ny = y;
        for (const [dx, dy] of DIRS) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const j = yy * width + xx;
          if (visited[j] || edges[j] < 0.35) continue;
          const align = (dx * Math.cos(contourDir) + dy * Math.sin(contourDir)) * 0.7 + (dx * pdx + dy * pdy) * 0.3;
          const score = edges[j] + align * 0.9;
          if (score > bestScore) {
            bestScore = score;
            nx = xx;
            ny = yy;
          }
        }
        if (nx === x && ny === y) break;
        pdx = nx - x;
        pdy = ny - y;
        x = nx;
        y = ny;
      }
    };
    const contourDir = gradDir[sy * width + sx] + Math.PI / 2;
    const cdx = Math.cos(contourDir);
    const cdy = Math.sin(contourDir);
    walk(sx, sy, cdx, cdy, false);
    const first = pts[0];
    walk(sx, sy, -cdx, -cdy, true);
    // Reorder: reverse of second walk + first walk.
    const ordered = pts.length > 1 && pts[0] === first ? pts.slice().reverse() : pts;
    return ordered;
  };

  // Seeds: strongest edges first.
  const seeds: Array<{ i: number; v: number }> = [];
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] >= 0.5) seeds.push({ i, v: edges[i] });
  }
  seeds.sort((a, b) => b.v - a.v);

  let nextId = 0;
  for (const seed of seeds) {
    if (chains.length >= maxChains) break;
    if (visited[seed.i]) continue;
    const x = seed.i % width;
    const y = (seed.i / width) | 0;
    const pts = follow(x, y);
    if (pts.length < minChainLength) continue;
    const simple = simplify(pts, 1.1);
    let length = 0;
    let salSum = 0;
    let strengthSum = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let k = 0; k < simple.length; k++) {
      const p = simple[k];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      const pi = clamp(p.y | 0, 0, height - 1) * width + clamp(p.x | 0, 0, width - 1);
      salSum += saliency[pi];
      strengthSum += edges[pi];
      if (k > 0) length += Math.hypot(simple[k].x - simple[k - 1].x, simple[k].y - simple[k - 1].y);
    }
    // Tone contrast: sample luminance either side of the chain midpoint.
    const mid = simple[Math.floor(simple.length / 2)];
    const gdir = gradDir[clamp(mid.y | 0, 0, height - 1) * width + clamp(mid.x | 0, 0, width - 1)];
    const lx = lum[clamp((mid.y | 0) + Math.round(Math.sin(gdir) * 3), 0, height - 1) * width + clamp((mid.x | 0) + Math.round(Math.cos(gdir) * 3), 0, width - 1)];
    const rx = lum[clamp((mid.y | 0) - Math.round(Math.sin(gdir) * 3), 0, height - 1) * width + clamp((mid.x | 0) - Math.round(Math.cos(gdir) * 3), 0, width - 1)];
    const closed =
      simple.length > 8 &&
      Math.hypot(simple[0].x - simple[simple.length - 1].x, simple[0].y - simple[simple.length - 1].y) < 4;
    chains.push({
      id: nextId++,
      points: simple,
      length,
      strength: strengthSum / simple.length,
      saliency: salSum / simple.length,
      contrast: Math.abs(lx - rx),
      closed,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    });
  }
  chains.sort((a, b) => b.length * (0.3 + b.saliency) * (0.4 + b.contrast) - a.length * (0.3 + a.saliency) * (0.4 + a.contrast));
  return chains;
}

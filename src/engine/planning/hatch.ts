/**
 * Hatching utilities (spec §4-E). Hatches follow the form: direction comes
 * from the scene's structure-tensor orientation field, spacing from how much
 * tone is still missing, and lines stop at object boundaries so shading
 * never bleeds across contours.
 */

import { clamp } from '../core/math';
import type { Vec2 } from '../core/types';
import type { SceneGraph } from '../analysis/scene';

export interface HatchLine {
  points: Vec2[];
}

/** Edge strength above which a hatch stroke stops (thin line art scores low). */
const EDGE_STOP = 0.38;
/** Edge strength at a row start above which the row is skipped. */
const EDGE_SKIP = 0.52;

/**
 * Sample the scene orientation field at a canvas position (radians).
 */
export function orientationAt(scene: SceneGraph, x: number, y: number): { angle: number; coherence: number } {
  const fx = clamp((x / scene.scale) | 0, 0, scene.width - 1);
  const fy = clamp((y / scene.scale) | 0, 0, scene.height - 1);
  const i = fy * scene.width + fx;
  return { angle: scene.fields.orientation[i], coherence: scene.fields.coherence[i] };
}

/** Reference tone at a canvas position. */
export function refToneAt(scene: SceneGraph, x: number, y: number): number {
  const fx = clamp((x / scene.scale) | 0, 0, scene.width - 1);
  const fy = clamp((y / scene.scale) | 0, 0, scene.height - 1);
  return scene.fields.lum[fy * scene.width + fx];
}

/** Edge strength at a canvas position (analysis-res, dilated look-up). */
export function edgeStrengthAt(scene: SceneGraph, x: number, y: number): number {
  const fx = clamp((x / scene.scale) | 0, 0, scene.width - 1);
  const fy = clamp((y / scene.scale) | 0, 0, scene.height - 1);
  let m = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = clamp(fx + dx, 0, scene.width - 1);
      const yy = clamp(fy + dy, 0, scene.height - 1);
      m = Math.max(m, scene.fields.edges[yy * scene.width + xx]);
    }
  }
  return m;
}

/**
 * Generate one hatch stroke through a point: starts at `angle` but then
 * traces the scene's orientation field so the stroke curves around the
 * underlying form (surface-following shading, spec §4-E). Straight lines
 * only where the form is flat (low coherence). Clipped at reference
 * boundaries so graphite never bleeds across contours.
 */
export function hatchStroke(scene: SceneGraph, cx: number, cy: number, angle: number, length: number): Vec2[] {
  const step = 3;
  const grow = (dir: number): Vec2[] => {
    let p = { x: cx, y: cy };
    let a = angle;
    const pts: Vec2[] = [];
    for (let d = 0; d <= length / 2; d += step) {
      pts.push(p);
      const { angle: fieldA, coherence } = orientationAt(scene, p.x, p.y);
      if (coherence > 0.07) {
        // Follow the form: pick the field direction closest to the current
        // heading and ease toward it — strokes bend around surfaces.
        let diff = fieldA - a;
        while (diff > Math.PI / 2) diff -= Math.PI;
        while (diff < -Math.PI / 2) diff += Math.PI;
        a += clamp(diff, -0.5, 0.5) * 0.5;
      }
      const nx = p.x + Math.cos(a) * step * dir;
      const ny = p.y + Math.sin(a) * step * dir;
      if (nx < 2 || ny < 2 || nx > scene.canvasWidth - 2 || ny > scene.canvasHeight - 2) break;
      if (edgeStrengthAt(scene, nx, ny) > EDGE_STOP) break;
      p = { x: nx, y: ny };
    }
    return pts;
  };
  const a = grow(-1).reverse();
  const b = grow(1);
  if (a.length + b.length < 2) return [];
  const pts = [...a, ...b];
  // A hatch stroke should have some minimum presence on the paper.
  let plen = 0;
  for (let i = 1; i < pts.length; i++) plen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return plen < 4 ? [] : pts;
}

/**
 * A band of parallel hatch strokes covering a disc around (cx, cy).
 * `spacing` controls density; the band is clipped by reference boundaries.
 */
export function hatchBand(
  scene: SceneGraph,
  cx: number,
  cy: number,
  radius: number,
  angle: number,
  spacing: number,
  strokeLength: number,
): HatchLine[] {
  const lines: HatchLine[] = [];
  const perp = angle + Math.PI / 2;
  const px = Math.cos(perp);
  const py = Math.sin(perp);
  const rows = Math.max(1, Math.round((radius * 2) / spacing));
  for (let r = -rows / 2; r <= rows / 2; r++) {
    const lx = cx + px * r * spacing;
    const ly = cy + py * r * spacing;
    if (lx < 2 || ly < 2 || lx > scene.canvasWidth - 2 || ly > scene.canvasHeight - 2) continue;
    if (edgeStrengthAt(scene, lx, ly) > EDGE_SKIP) continue; // hole in the form
    const pts = hatchStroke(scene, lx, ly, angle, strokeLength);
    if (pts.length) lines.push({ points: pts });
  }
  return lines;
}

/** Join hatch rows into one continuous path with smooth U-turns at the
 *  row ends — the way a hand shades back and forth without lifting. */
export function serpentine(lines: HatchLine[]): Vec2[] {
  if (!lines.length) return [];
  const path: Vec2[] = [];
  lines.forEach((line, i) => {
    let pts = line.points;
    if (i % 2 === 1) pts = [...pts].reverse();
    if (i > 0) {
      // U-turn: swing out from the previous row end into the next row,
      // instead of a straight perpendicular jump (which reads as scribble).
      const prevEnd = path[path.length - 1];
      const nextStart = pts[0];
      const nextDir = pts.length > 1 ? Math.atan2(pts[1].y - nextStart.y, pts[1].x - nextStart.x) : 0;
      const out = 4;
      path.push({
        x: prevEnd.x + Math.cos(nextDir) * out * 0.4 + (nextStart.x - prevEnd.x) * 0.35,
        y: prevEnd.y + Math.sin(nextDir) * out * 0.4 + (nextStart.y - prevEnd.y) * 0.35,
      });
      path.push(nextStart);
      path.push(...pts.slice(1));
    } else {
      path.push(...pts);
    }
  });
  return path;
}

/** Spacing (px) needed to reach a tone deficit with one hatch layer.
 *  A pass beneath a hatch line deposits ≈ lineDarkness (≈0.2×instrument
 *  darkness); covering a band with spacing s adds ≈ lineDarkness·w/s.
 *  Multiple light layers build dark values — real graphite practice. */
export function spacingForDeficit(deficit: number, tipWidth: number, lineDarkness = 0.24): number {
  return clamp((tipWidth * lineDarkness) / Math.max(0.04, deficit), tipWidth * 1.05, tipWidth * 7.5);
}

/** Suggested hatch direction near a point, form-following when coherent. */
export function hatchDirection(scene: SceneGraph, x: number, y: number, layer: number, globalAngle: number): number {
  const { angle, coherence } = orientationAt(scene, x, y);
  const base = coherence > 0.08 ? angle : globalAngle;
  // Cross-hatch layers rotate; the second layer is conventionally ~60° off.
  return base + (layer > 0 ? (layer % 2 === 1 ? Math.PI / 3 : -Math.PI / 3.5) : 0);
}

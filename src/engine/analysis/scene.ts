/**
 * SceneGraph — the internal scene representation (spec §3): what the image
 * contains (regions, subjects, faces, pose, light, tone structure) rather
 * than a grid of pixels. Assembled from classical fields + optional ML
 * evidence; the planner and evaluator work exclusively against this graph.
 */

import { analyzeClassical, type ClassicalFields } from './classical';
import { extractContours, type ContourChain } from './contours';
import { dominantEdgeDirections, segmentRegions, type SceneRegion } from './regions';
import {
  mapGesture,
  mapLoomisHead,
  type FaceObservation,
  type GestureFigure,
  type LoomisHead,
  type PoseObservation,
  type SegmentationObservation,
} from '../ml/provider';
import type { Vec2 } from '../core/types';

export interface SceneGraph {
  /** Analysis resolution (long edge ≤ 512). */
  width: number;
  height: number;
  /** Canvas resolution (scale = canvas / analysis). */
  canvasWidth: number;
  canvasHeight: number;
  scale: number;
  /** Classical fields at analysis resolution. */
  fields: ClassicalFields;
  regions: SceneRegion[];
  /** Region ids of likely subjects, most important first. */
  subjects: number[];
  /** Dominant straight-edge directions (perspective cues). */
  directions: Array<{ angle: number; weight: number }>;
  contours: ContourChain[];
  face: { observation: FaceObservation; loomis: LoomisHead } | null;
  pose: { observation: PoseObservation; gesture: GestureFigure } | null;
  segmentation: SegmentationObservation | null;
  /** Scene summary shown in the UI. */
  summary: string[];
}

export interface SceneInput {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  face?: FaceObservation | null;
  pose?: PoseObservation | null;
  segmentation?: SegmentationObservation | null;
}

export function analyzeScene(input: SceneInput): SceneGraph {
  const { rgba, width, height, canvasWidth, canvasHeight } = input;
  const fields = analyzeClassical(rgba, width, height);
  const { regions } = segmentRegions(fields);
  const directions = dominantEdgeDirections(fields);
  const contours = extractContours(fields);

  // Segmentation evidence refines the subject/background split.
  let subjects = regions.filter((r) => !r.background).map((r) => r.id);
  if (input.segmentation && input.segmentation.foregroundRatio > 0.02 && input.segmentation.foregroundRatio < 0.92) {
    const seg = input.segmentation;
    const scored = regions.map((r) => {
      let fg = 0;
      let total = 0;
      const cols = r.mask.cols;
      const rows = r.mask.rows;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          if (!r.mask.cells[cy * cols + cx]) continue;
          const sx = Math.min(seg.width - 1, Math.round(((cx + 0.5) / cols) * seg.width));
          const sy = Math.min(seg.height - 1, Math.round(((cy + 0.5) / rows) * seg.height));
          if (seg.classes[sy * seg.width + sx] > 0) fg++;
          total++;
        }
      }
      return { id: r.id, fgRatio: total ? fg / total : 0, region: r };
    });
    const enriched = scored.map((s) => ({
      ...s,
      subjectScore: s.fgRatio * 0.65 + (1 - (s.region.background ? 1 : 0)) * 0.35 + s.region.saliency * 0.3,
    }));
    enriched.sort((a, b) => b.subjectScore - a.subjectScore);
    subjects = enriched.filter((s) => s.subjectScore > 0.45).map((s) => s.id);
    if (subjects.length === 0) subjects = enriched.slice(0, 3).map((s) => s.id);
  }
  if (subjects.length === 0) subjects = regions.slice(0, 3).map((r) => r.id);

  const face = input.face ? { observation: input.face, loomis: mapLoomisHead(input.face) } : null;
  const pose = input.pose ? { observation: input.pose, gesture: mapGesture(input.pose) } : null;

  const summary: string[] = [];
  if (face) summary.push('portrait face');
  if (pose) summary.push('figure pose');
  if (input.segmentation && input.segmentation.foregroundRatio > 0.02) {
    summary.push(input.segmentation.foregroundRatio > 0.5 ? 'full-frame subject' : 'isolated subject');
  }
  summary.push(`${regions.length} regions`);
  summary.push(`${contours.length} contours`);
  if (fields.light) {
    const deg = Math.round((Math.atan2(fields.light.y, -fields.light.x) * 180) / Math.PI);
    summary.push(`light ${((deg % 360) + 360) % 360}°`);
  }

  return {
    width,
    height,
    canvasWidth,
    canvasHeight,
    scale: canvasWidth / width,
    fields,
    regions,
    subjects,
    directions,
    contours,
    face,
    pose,
    segmentation: input.segmentation ?? null,
    summary,
  };
}

/** Field lookups in scene coordinates with canvas scaling helpers. */
export function sceneToCanvas(p: Vec2, scale: number): Vec2 {
  return { x: p.x * scale, y: p.y * scale };
}

export function canvasToScene(p: Vec2, scale: number): Vec2 {
  return { x: p.x / scale, y: p.y / scale };
}

/** Target graphite density for a reference tone (inverse Beer–Lambert). */
export function densityForTone(tone: number, albedo = 0.948): number {
  const t = Math.max(0.02, Math.min(1, tone / albedo));
  return Math.max(0, -Math.log(t) / 2.6);
}

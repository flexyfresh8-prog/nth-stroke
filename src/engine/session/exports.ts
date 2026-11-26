/**
 * Exports (spec §12): SVG vector re-render of the recorded strokes, native
 * .nth project files (checkpoints + reference + full session log), session
 * JSON, and canvas encodes. Metadata is truthful: simulated stylus data is
 * labelled as such and the origin of the artwork is preserved.
 *
 * SVG strategy: one <path> per stroke (variable-width outline built from
 * the executed pressure trajectory — never duplicated geometry), eraser
 * ops as paper-coloured strokes whose z-order reproduces the compositing
 * semantics, and an honest note that blending ops have no vector
 * equivalent (the .nth project file is the lossless record).
 */

import { ENGINE_VERSION, type DrawOp } from '../core/types';
import { MEDIA, type Mark } from '../adaptive/pigment';
import { instrument } from '../media/instruments';
import type { OpRecord, SessionRecorder, UserOpRecord } from './recorder';

interface StrokeSpec {
  color: string;
  widthAt: (pressure: number) => number;
  maxOpacity: number;
}

function strokeSpecFor(op: DrawOp): StrokeSpec {
  const spec = instrument(op.instrument);
  if (spec.class === 'eraser') {
    return {
      color: '#f4f2ee',
      widthAt: (p) => (spec.baseRadius + p * spec.pressureRadius) * 2,
      maxOpacity: 0.92,
    };
  }
  const dark = spec.class === 'charcoal' ? '#141210' : '#232120';
  return {
    color: dark,
    widthAt: (p) => (spec.baseRadius + p * spec.pressureRadius * (op.broad ? 2.1 : 1)) * 2,
    maxOpacity: spec.class === 'charcoal' ? 0.82 : 0.72,
  };
}

function samplePoints(record: OpRecord | UserOpRecord): Array<{ x: number; y: number; p: number }> {
  return record.samples
    .filter((s) => s.z <= 0.35 && s.pressure > 0.01)
    .map((s) => ({ x: s.x, y: s.y, p: s.pressure }));
}

function variableWidthPath(points: Array<{ x: number; y: number; p: number }>, spec: StrokeSpec): string {
  if (points.length < 2) return '';
  const simple = simplifyPressure(points, 0.55);
  if (simple.length < 2) return '';
  const left: string[] = [];
  const right: string[] = [];
  const n = simple.length;
  for (let i = 0; i < n; i++) {
    const a = simple[Math.max(0, i - 1)];
    const b = simple[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const half = Math.max(0.28, spec.widthAt(simple[i].p) / 2);
    const x = simple[i].x;
    const y = simple[i].y;
    if (i === 0) {
      left.push(`M${q(x + nx * half)} ${q(y + ny * half)}`);
      right.push(`${q(x - nx * half)} ${q(y - ny * half)}`);
    } else {
      left.push(`L${q(x + nx * half)} ${q(y + ny * half)}`);
      right.push(`${q(x - nx * half)} ${q(y - ny * half)}`);
    }
  }
  return `${left.join('')}L${right.reverse().join('')}Z`;
}

const q = (v: number) => (Math.round(v * 10) / 10).toString();

/** RDP simplification that carries the pressure channel along. */
function simplifyPressure(points: Array<{ x: number; y: number; p: number }>, tolerance: number): Array<{ x: number; y: number; p: number }> {
  if (points.length <= 2) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = points[first];
    const b = points[last];
    let maxSq = 0;
    let index = -1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a.x + t * dx - p.x;
      const ey = a.y + t * dy - p.y;
      const sq = ex * ex + ey * ey;
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
  const out: Array<{ x: number; y: number; p: number }> = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export interface SvgExportResult {
  svg: string;
  pathCount: number;
  byteSize: number;
  skippedBlendOps: number;
}

export function exportSvg(
  recorder: SessionRecorder,
  width: number,
  height: number,
  meta: { seed: number; title?: string; adaptive?: readonly Mark[] },
): SvgExportResult {
  const paths: string[] = [];
  let count = 0;
  let blendOps = 0;
  const emit = (record: OpRecord | UserOpRecord, op: DrawOp) => {
    const spec = strokeSpecFor(op);
    if (instrument(op.instrument).class === 'blender') {
      blendOps++;
      return;
    }
    const pts = samplePoints(record);
    if (pts.length === 1) {
      // A tap: small circle.
      const r = Math.max(0.5, spec.widthAt(pts[0].p) / 2);
      paths.push(
        `<circle cx="${q(pts[0].x)}" cy="${q(pts[0].y)}" r="${q(r)}" fill="${spec.color}" fill-opacity="${(spec.maxOpacity * pts[0].p).toFixed(2)}"/>`,
      );
      count++;
      return;
    }
    const d = variableWidthPath(pts, spec);
    if (!d) return;
    const meanP = pts.reduce((s, p) => s + p.p, 0) / pts.length;
    paths.push(`<path d="${d}" fill="${spec.color}" fill-opacity="${Math.min(0.95, spec.maxOpacity * (0.45 + meanP)).toFixed(2)}"/>`);
    count++;
  };
  if(meta.adaptive){
    for (const mark of meta.adaptive) {
      const medium=MEDIA[mark.instrument];
      if(medium.mode==='blend'){blendOps++;continue;}
      const path=mark.path.map((p,i)=>`${i?'L':'M'}${q(p.x)} ${q(p.y)}`).join('');
      paths.push(`<path d="${path}" stroke="${medium.mode==='lift'?'#fff':'#000'}" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="${q(mark.radius*1.48)}" stroke-opacity="${mark.opacity.toFixed(3)}"/>`);
      count++;
    }
  }else for (const event of recorder.events) {
    if (event.type === 'op') emit(event.record, event.record.op);
    else if (event.type === 'user-op') {
      emit(event.record, {
        id: -1,
        kind: 'stroke',
        stage: 'detail',
        instrument: event.record.instrument,
        intent: 'user stroke',
        waypoints: [],
        pressure: 0.5,
        speed: 1,
        region: -1,
        corrective: false,
        travel: false,
      });
    }
  }
  const info = {
    generator: 'NTH Stroke autonomous drawing engine',
    version: meta.adaptive ? '2.0.0' : ENGINE_VERSION,
    seed: meta.seed,
    strokes: count,
    note: 'Strokes are simulated stylus trajectories generated autonomously; user-drawn strokes are included. Blending-stump operations have no vector equivalent and are omitted; the .nth project file is the lossless record.',
  };
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<metadata>${JSON.stringify(info)}</metadata>` +
    `<rect width="100%" height="100%" fill="${meta.adaptive ? '#fff' : '#f4f2ee'}"/>` +
    paths.join('') +
    `</svg>`;
  return { svg, pathCount: count, byteSize: svg.length, skippedBlendOps: blendOps };
}

/* ------------------------------------------------------------------ */
/* .nth project format                                                  */
/* ------------------------------------------------------------------ */

export interface NthProject {
  format: 'nth-project';
  version: string;
  created: string;
  seed: number;
  config: unknown;
  engineVersion: string;
  reference: {
    width: number;
    height: number;
    /** PNG data URL of the reference (downscaled for storage). */
    dataUrl: string;
  };
  canvas: { width: number; height: number };
  checkpoint: unknown;
  session: unknown;
  notes: string;
}

export async function buildProjectFile(
  recorder: SessionRecorder,
  checkpoint: unknown,
  config: unknown,
  seed: number,
  referenceDataUrl: string,
  referenceWidth: number,
  referenceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  engineVersion = ENGINE_VERSION,
): Promise<Blob> {
  const project: NthProject = {
    format: 'nth-project',
    version: '1',
    created: new Date().toISOString(),
    seed,
    config,
    engineVersion,
    reference: { width: referenceWidth, height: referenceHeight, dataUrl: referenceDataUrl },
    canvas: { width: canvasWidth, height: canvasHeight },
    checkpoint,
    session: recorder.export(),
    notes:
      'NTH Stroke project. The artwork originates entirely from executed drawing operations by the autonomous engine (plus any recorded user strokes). No reference pixels are composited into the artwork.',
  };
  const json = JSON.stringify(project);
  try {
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      return await new Response(stream).blob();
    }
  } catch {
    /* fall through to plain JSON */
  }
  return new Blob([json], { type: 'application/json' });
}

export async function readProjectFile(blob: Blob): Promise<NthProject> {
  let data = blob;
  try {
    if (typeof DecompressionStream !== 'undefined' && blob.type !== 'application/json') {
      const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
      data = await new Response(stream).blob();
      const text = await data.text();
      if (text.startsWith('{')) return JSON.parse(text) as NthProject;
    }
  } catch {
    /* try plain */
  }
  return JSON.parse(await blob.text()) as NthProject;
}

/** Serialize the session log. */
export function exportSessionJson(recorder: SessionRecorder): string {
  return JSON.stringify(recorder.export());
}

// V4 exports (spec §15). SVG geometry is derived from the ACTUAL deposited
// pen trajectories (the stroke registry records real nib positions, widths
// and deposit alphas); variable-width strokes export as vector outlines.
// Project files (.nth4) are fully resumable: canvas material, registry,
// pending plans, brain memory, RNG states and the pen-event recording.

import { instruments } from './instruments';
import type { StrokeRecord, VirtualCanvas } from './paper';
import type { PenRecorder } from './recorder';
import type { InstrumentId, LayerId, SerializedRecorder, SimOptions, StrokePlan } from './types';

const LAYERS: LayerId[] = ['gesture', 'construction', 'sketch', 'line', 'tone', 'detail', 'erasure'];
const INSTS: InstrumentId[] = ['graphite', 'mechanical', 'fineliner', 'dip', 'brush', 'charcoal', 'eraser'];

const n = (v: number) => Math.round(v * 1000) / 1000;

export interface ExportMeta {
  seed: number;
  simTime: number;
  strokes: number;
  lifts: number;
  travel: number;
  quality?: { ssim: number; mae: number; edge: number };
}

/** Ribbon outline path for one variable-width stroke sample run. */
function ribbonPath(pts: Float32Array): string {
  const count = pts.length / 4;
  if (count < 2) return '';
  const left: string[] = [],
    right: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = pts[4 * i],
      y = pts[4 * i + 1],
      w = pts[4 * i + 2];
    const a = Math.max(0, i - 1),
      b = Math.min(count - 1, i + 1);
    const dx = pts[4 * b] - pts[4 * a],
      dy = pts[4 * b + 1] - pts[4 * a + 1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l,
      ny = dx / l;
    left.push(`${n(x + nx * w)} ${n(y + ny * w)}`);
    right.push(`${n(x - nx * w)} ${n(y - ny * w)}`);
  }
  return `M${left[0]}L${left.slice(1).join('L')}L${right.reverse().join('L')}Z`;
}

function centerlinePath(pts: Float32Array): string {
  const count = pts.length / 4;
  let d = '';
  for (let i = 0; i < count; i++) d += (i ? 'L' : 'M') + `${n(pts[4 * i])} ${n(pts[4 * i + 1])}`;
  return d;
}

/** Layered SVG from deposited trajectories. Erasures are documented, not
 *  faked: the raster exports remain the ground truth for tone. */
export function svgExport(paper: VirtualCanvas, meta: ExportMeta): string {
  const { w, h } = paper;
  const groups = new Map<LayerId, string[]>();
  let meanW = 0,
    samples = 0;
  for (const r of paper.registry) {
    if (r.layer === 'erasure') continue; // eraser events live in the event log
    const inst = instruments[r.instrument];
    const count = r.pts.length / 4;
    let wSum = 0;
    for (let i = 0; i < count; i++) wSum += r.pts[4 * i + 2];
    const mw = count ? wSum / count : 0;
    meanW += wSum;
    samples += count;
    const opacity = inst.model === 'ink' ? Math.min(1, r.alpha * 1.05) : Math.min(1, 1 - Math.exp(-1.9 * r.alpha));
    const fill = inst.model === 'ink' ? '#1a1a1f' : '#2e2f34';
    const thin = mw < 0.42;
    const path = thin
      ? `<path fill="none" stroke="${fill}" stroke-opacity="${n(opacity)}" stroke-width="${n(Math.max(0.5, mw * 2))}" stroke-linecap="round" d="${centerlinePath(r.pts)}"/>`
      : `<path fill="${fill}" fill-opacity="${n(opacity)}" fill-rule="nonzero" d="${ribbonPath(r.pts)}"/>`;
    if (!groups.has(r.layer)) groups.set(r.layer, []);
    groups.get(r.layer)!.push(path);
  }
  let body = '';
  for (const layer of LAYERS) {
    const g = groups.get(layer);
    if (!g?.length) continue;
    body += `<g data-layer="${layer}">${g.join('')}</g>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<title>NTH Stroke V4</title>` +
    `<metadata>{"generator":"NTH Stroke V4","engine":"Autonomous Virtual Pen Artist","seed":${meta.seed},"strokes":${meta.strokes},"lifts":${meta.lifts},"travelPx":${Math.round(meta.travel)},"simTimeSeconds":${n(meta.simTime)}${meta.quality ? `,"ssim":${n(meta.quality.ssim)}` : ''},"meanNibPx":${n(samples ? meanW / samples : 0)},"note":"Geometry derives from deposited pen trajectories; eraser passes are recorded in the pen-event log."}</metadata>` +
    `<rect width="100%" height="100%" fill="#fcfaf5"/>${body}</svg>`
  );
}

/** Human-readable stroke-sequence JSON. */
export function strokesJSON(paper: VirtualCanvas, meta: ExportMeta): string {
  const strokes = paper.registry.map((r, i) => ({
    index: i,
    instrument: r.instrument,
    layer: r.layer,
    stage: r.stage,
    importance: n(r.importance),
    meanAlpha: n(r.alpha),
    lengthSamples: r.length,
    points: Array.from(r.pts, (v) => n(v)),
  }));
  return JSON.stringify({
    generator: 'NTH Stroke V4',
    kind: 'stroke-sequence',
    canvas: { width: paper.w, height: paper.h },
    session: { seed: meta.seed, simTime: n(meta.simTime), strokes: meta.strokes, lifts: meta.lifts, travelPx: Math.round(meta.travel) },
    strokes,
  });
}

/** Complete pen-event recording as JSON (spec §15). */
export function eventsJSON(rec: PenRecorder | null, meta: ExportMeta, options: SimOptions, kind: 'events' | 'replay' = 'events'): string {
  if (!rec)
    return JSON.stringify({
      generator: 'NTH Stroke V4',
      kind,
      error: 'recording disabled (maxEvents = 0)',
      session: { seed: meta.seed },
    });
  return JSON.stringify({
    generator: 'NTH Stroke V4',
    kind,
    replay: kind === 'replay',
    options,
    session: {
      seed: meta.seed,
      simTime: n(meta.simTime),
      strokes: meta.strokes,
      lifts: meta.lifts,
      travelPx: Math.round(meta.travel),
      truncated: rec.truncated,
    },
    events: {
      count: rec.count,
      // samples are [t, x, y, z, pressure, vx, vy, tilt, azimuth, direction, meta, instrument]
      columns: ['t', 'x', 'y', 'z', 'pressure', 'vx', 'vy', 'tilt', 'azimuth', 'direction', 'meta', 'instrument'],
      metaBits: { contact: 1, down: 2, eventPenDown: 4, eventPenUp: 8, eventInstrumentChange: 16 },
      t: Array.from(rec.t.subarray(0, rec.count)),
      x: Array.from(rec.x.subarray(0, rec.count)),
      y: Array.from(rec.y.subarray(0, rec.count)),
      z: Array.from(rec.z.subarray(0, rec.count)),
      pressure: Array.from(rec.p.subarray(0, rec.count)),
      vx: Array.from(rec.vx.subarray(0, rec.count)),
      vy: Array.from(rec.vy.subarray(0, rec.count)),
      tilt: Array.from(rec.tilt.subarray(0, rec.count)),
      azimuth: Array.from(rec.azimuth.subarray(0, rec.count)),
      direction: Array.from(rec.dir.subarray(0, rec.count)),
      meta: Array.from(rec.meta.subarray(0, rec.count)),
      instrument: Array.from(rec.inst.subarray(0, rec.count)),
    },
  });
}

// --- binary plan + registry packing -------------------------------------------

export function packPlans(plans: StrokePlan[]): ArrayBuffer {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const head = new DataView(new ArrayBuffer(4));
  head.setUint32(0, plans.length, true);
  parts.push(new Uint8Array(head.buffer));
  for (const p of plans) {
    const scalars = new DataView(new ArrayBuffer(52));
    let o = 0;
    const f = (v: number) => {
      scalars.setFloat32(o, v, true);
      o += 4;
    };
    scalars.setUint8(o++, INSTS.indexOf(p.instrument));
    scalars.setUint8(o++, LAYERS.indexOf(p.layer));
    o = 4;
    f(p.id);
    f(p.baseSpeed);
    f(p.powerLaw);
    f(p.lognormal);
    f(p.importance);
    f(p.confidence);
    f(p.nib);
    f(p.pressure.entry);
    f(p.pressure.level);
    f(p.pressure.exit);
    f(p.pressure.attack);
    f(p.pressure.release);
    parts.push(new Uint8Array(scalars.buffer));
    const cnt = new DataView(new ArrayBuffer(4));
    cnt.setUint32(0, p.pts.length, true);
    parts.push(new Uint8Array(cnt.buffer), new Uint8Array(p.pts.buffer, p.pts.byteOffset, p.pts.byteLength));
    const task = enc.encode(p.task),
      reason = enc.encode(p.reason);
    const lens = new DataView(new ArrayBuffer(4));
    lens.setUint16(0, task.length, true);
    lens.setUint16(2, reason.length, true);
    parts.push(new Uint8Array(lens.buffer), task, reason);
  }
  return concat(parts);
}

export function unpackPlans(buf: ArrayBuffer): StrokePlan[] {
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  const dec = new TextDecoder();
  let o = 4;
  const plans: StrokePlan[] = [];
  for (let k = 0; k < count; k++) {
    const inst = dv.getUint8(o),
      layer = dv.getUint8(o + 1);
    o += 4;
    const id = dv.getFloat32(o, true),
      baseSpeed = dv.getFloat32(o + 4, true),
      powerLaw = dv.getFloat32(o + 8, true),
      lognormal = dv.getFloat32(o + 12, true),
      importance = dv.getFloat32(o + 16, true),
      confidence = dv.getFloat32(o + 20, true),
      nib = dv.getFloat32(o + 24, true),
      entry = dv.getFloat32(o + 28, true),
      level = dv.getFloat32(o + 32, true),
      exit = dv.getFloat32(o + 36, true),
      attack = dv.getFloat32(o + 40, true),
      release = dv.getFloat32(o + 44, true);
    o += 48;
    const ptsLen = dv.getUint32(o, true);
    o += 4;
    const pts = new Float32Array(buf.slice(o, o + ptsLen * 4));
    o += ptsLen * 4;
    const taskLen = dv.getUint16(o, true),
      reasonLen = dv.getUint16(o + 2, true);
    o += 4;
    const task = dec.decode(new Uint8Array(buf, o, taskLen));
    o += taskLen;
    const reason = dec.decode(new Uint8Array(buf, o, reasonLen));
    o += reasonLen;
    plans.push({
      id,
      pts,
      baseSpeed,
      powerLaw,
      lognormal,
      pressure: { entry, level, exit, attack, release },
      instrument: INSTS[inst] ?? 'graphite',
      layer: LAYERS[layer] ?? 'sketch',
      importance,
      confidence,
      nib,
      task,
      reason,
    });
  }
  return plans;
}

export function packRegistry(registry: StrokeRecord[]): ArrayBuffer {
  const parts: Uint8Array[] = [];
  const head = new DataView(new ArrayBuffer(4));
  head.setUint32(0, registry.length, true);
  parts.push(new Uint8Array(head.buffer));
  for (const r of registry) {
    const h = new DataView(new ArrayBuffer(16));
    h.setUint8(0, INSTS.indexOf(r.instrument));
    h.setUint8(1, LAYERS.indexOf(r.layer));
    h.setUint8(2, r.stage);
    h.setFloat32(4, r.importance, true);
    h.setFloat32(8, r.alpha, true);
    h.setUint32(12, r.pts.length, true);
    parts.push(new Uint8Array(h.buffer), new Uint8Array(r.pts.buffer, r.pts.byteOffset, r.pts.byteLength));
  }
  return concat(parts);
}

export function unpackRegistry(buf: ArrayBuffer): StrokeRecord[] {
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  let o = 4;
  const out: StrokeRecord[] = [];
  for (let k = 0; k < count; k++) {
    const inst = dv.getUint8(o),
      layer = dv.getUint8(o + 1),
      stage = dv.getUint8(o + 2);
    const importance = dv.getFloat32(o + 4, true),
      alpha = dv.getFloat32(o + 8, true),
      ptsLen = dv.getUint32(o + 12, true);
    o += 16;
    const pts = new Float32Array(buf.slice(o, o + ptsLen * 4));
    o += ptsLen * 4;
    out.push({ instrument: INSTS[inst] ?? 'graphite', layer: LAYERS[layer] ?? 'sketch', stage, importance, alpha, pts, length: ptsLen / 4 });
  }
  return out;
}

export function packRecorder(rec: SerializedRecorder): ArrayBuffer {
  const total = 4 + rec.count * (8 + 4 * 9 + 1 + 1);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, rec.count, true);
  let o = 4;
  for (let i = 0; i < rec.count; i++) {
    dv.setFloat64(o, rec.t[i], true);
    o += 8;
  }
  const f32 = (arr: Float32Array) => {
    for (let i = 0; i < rec.count; i++) {
      dv.setFloat32(o, arr[i], true);
      o += 4;
    }
  };
  f32(rec.x);
  f32(rec.y);
  f32(rec.z);
  f32(rec.p);
  f32(rec.vx);
  f32(rec.vy);
  f32(rec.tilt ?? new Float32Array(rec.count));
  f32(rec.azimuth ?? new Float32Array(rec.count).fill(1.57));
  f32(rec.dir ?? new Float32Array(rec.count));
  for (let i = 0; i < rec.count; i++) dv.setUint8(o++, rec.meta[i]);
  for (let i = 0; i < rec.count; i++) dv.setUint8(o++, rec.inst[i]);
  return buf;
}

export function unpackRecorder(buf: ArrayBuffer): SerializedRecorder {
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  let o = 4;
  const t = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    t[i] = dv.getFloat64(o, true);
    o += 8;
  }
  const f32 = () => {
    const a = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      a[i] = dv.getFloat32(o, true);
      o += 4;
    }
    return a;
  };
  const x = f32(),
    y = f32(),
    z = f32(),
    p = f32(),
    vx = f32(),
    vy = f32(),
    tilt = f32(),
    azimuth = f32(),
    dir = f32();
  const meta = new Uint8Array(count),
    inst = new Uint8Array(count);
  for (let i = 0; i < count; i++) meta[i] = dv.getUint8(o++);
  for (let i = 0; i < count; i++) inst[i] = dv.getUint8(o++);
  return { count, t, x, y, z, p, vx, vy, tilt, azimuth, dir, meta, inst };
}

export function concat(parts: Uint8Array[]): ArrayBuffer {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

export { LAYERS, INSTS };

// --- resumable project files (.nth4) --------------------------------------------

import type { SerializedResume } from './types';

export interface ProjectHeader extends Record<string, unknown> {
  version: '4.0';
  refSize: number;
  refName: string;
  refType: string;
  workW: number;
  workH: number;
  nibScale: number;
  resume: Omit<SerializedResume, 'graphite' | 'ink' | 'registry' | 'recorder' | 'pending'>;
}

/**
 * Project layout: "NTH4\n" + JSON header + "\n" + reference file bytes +
 * pending plans + registry + recorder + graphite + ink (little-endian f32).
 */
export async function packProject(
  ref: Blob,
  resume: SerializedResume,
  workW: number,
  workH: number,
  nibScale: number,
): Promise<Blob> {
  const { graphite, ink, registry, recorder, pending, ...rest } = resume;
  const header: ProjectHeader = {
    version: '4.0',
    refSize: ref.size,
    refName: (ref as File).name ?? 'reference',
    refType: ref.type || 'image/png',
    workW,
    workH,
    nibScale,
    resume: rest,
  };
  const body = concat([
    new Uint8Array(packPlans(pending ?? [])),
    new Uint8Array(packRegistry((registry ?? []).map((r) => ({ ...r, alpha: r.opacity })))),
    new Uint8Array(recorder ? packRecorder(recorder) : new ArrayBuffer(4)),
    new Uint8Array(graphite.buffer, graphite.byteOffset, graphite.byteLength),
    new Uint8Array(ink.buffer, ink.byteOffset, ink.byteLength),
  ]);
  return new Blob(['NTH4\n', JSON.stringify(header), '\n', ref, body], { type: 'application/octet-stream' });
}

export async function unpackProject(file: Blob): Promise<{ ref: Blob; resume: SerializedResume; workW: number; workH: number; nibScale: number }> {
  const buf = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (new TextDecoder().decode(buf.slice(0, 5)) !== 'NTH4\n') throw Error('Not an NTH Stroke V4 project.');
  const line = buf.indexOf(10, 5);
  if (line < 0) throw Error('Invalid V4 project header.');
  const header = JSON.parse(new TextDecoder().decode(buf.slice(5, line))) as ProjectHeader;
  if (header.version !== '4.0' || !Number.isSafeInteger(header.refSize) || header.refSize < 1)
    throw Error('Invalid V4 project header.');
  const refStart = line + 1,
    refEnd = refStart + header.refSize;
  if (refEnd > file.size) throw Error('Truncated V4 project.');
  const ref = file.slice(refStart, refEnd);
  const body = new Uint8Array(await file.slice(refEnd).arrayBuffer());
  // pending plans
  const planCount = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
  let o = 4;
  const plansEnd = scanPlans(body, planCount);
  const pending = unpackPlans(body.buffer.slice(body.byteOffset, body.byteOffset + plansEnd));
  o = plansEnd;
  // registry
  const regCount = new DataView(body.buffer, body.byteOffset + o).getUint32(0, true);
  o += 4;
  const regStart = o;
  o += scanRegistry(body, regCount, o);
  const strokeRecords = unpackRegistry(body.buffer.slice(body.byteOffset + regStart - 4, body.byteOffset + o));
  const registry = strokeRecords.map((r) => ({
    instrument: r.instrument,
    layer: r.layer,
    stage: r.stage,
    importance: r.importance,
    opacity: r.alpha,
    pts: r.pts,
    length: r.length,
  }));
  // recorder
  const recCount = new DataView(body.buffer, body.byteOffset + o).getUint32(0, true);
  o += 4;
  const recStart = o;
  o += recCount * (8 + 36 + 2);
  const recorder = recCount ? unpackRecorder(body.buffer.slice(body.byteOffset + recStart - 4, body.byteOffset + o)) : null;
  // material planes
  const n = header.workW * header.workH;
  if (o + n * 8 > body.length) throw Error('Truncated V4 material planes.');
  const graphite = new Float32Array(body.buffer.slice(body.byteOffset + o, body.byteOffset + o + n * 4));
  o += n * 4;
  const ink = new Float32Array(body.buffer.slice(body.byteOffset + o, body.byteOffset + o + n * 4));
  const resume: SerializedResume = {
    ...(header.resume as SerializedResume),
    graphite,
    ink,
    registry,
    recorder,
    pending,
  };
  return { ref, resume, workW: header.workW, workH: header.workH, nibScale: header.nibScale };
}

function scanPlans(body: Uint8Array, count: number): number {
  const dv = new DataView(body.buffer, body.byteOffset);
  let o = 4;
  for (let k = 0; k < count; k++) {
    o += 52; // 3 bytes ids + pad + 12 floats
    const ptsLen = dv.getUint32(o, true);
    o += 4 + ptsLen * 4;
    const taskLen = dv.getUint16(o, true),
      reasonLen = dv.getUint16(o + 2, true);
    o += 4 + taskLen + reasonLen;
  }
  return o;
}

function scanRegistry(body: Uint8Array, count: number, start: number): number {
  const dv = new DataView(body.buffer, body.byteOffset);
  let o = start;
  for (let k = 0; k < count; k++) {
    const ptsLen = dv.getUint32(o + 12, true);
    o += 16 + ptsLen * 4;
  }
  return o - start;
}

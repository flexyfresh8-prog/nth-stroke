// V4 pen-event recorder (spec §15). Records the complete physical pen event
// stream — simulation timestamps, coordinates, contact state, pressure,
// velocity, instrument changes, pen lifts and eraser movements — in
// structure-of-arrays typed buffers. Replaying the recording through the
// deposition pipeline reproduces the artwork exactly (verified in tests).

import type { VirtualPen } from './pen';
import type { InstrumentId, SerializedRecorder } from './types';

/** meta bits */
export const BIT_CONTACT = 1;
export const BIT_DOWN = 2;
export const BIT_EVENT_DOWN = 4;
export const BIT_EVENT_UP = 8;
export const BIT_EVENT_INSTRUMENT = 16;
export const BIT_BLOT = 32; // this sample carried a touch-down ink blot

const CHUNK = 1 << 18; // 262144 samples per growth step

export class PenRecorder {
  count = 0;
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  p: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  tilt: Float32Array;
  azimuth: Float32Array;
  dir: Float32Array;
  meta: Uint8Array;
  inst: Uint8Array;
  /** true once maxEvents was hit (recording stopped, playback continues) */
  truncated = false;

  constructor(private maxEvents: number) {
    const n = Math.min(CHUNK, Math.max(0, maxEvents));
    this.t = new Float64Array(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.p = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.tilt = new Float32Array(n);
    this.azimuth = new Float32Array(n);
    this.dir = new Float32Array(n);
    this.meta = new Uint8Array(n);
    this.inst = new Uint8Array(n);
  }

  private grow() {
    const cap = this.t.length * 2;
    const t = new Float64Array(cap);
    t.set(this.t);
    this.t = t;
    for (const key of ['x', 'y', 'z', 'p', 'vx', 'vy', 'tilt', 'azimuth', 'dir'] as const) {
      const next = new Float32Array(cap);
      next.set(this[key]);
      this[key] = next;
    }
    const meta = new Uint8Array(cap);
    meta.set(this.meta);
    this.meta = meta;
    const inst = new Uint8Array(cap);
    inst.set(this.inst);
    this.inst = inst;
  }

  append(pen: VirtualPen, simTime: number, events: string[], blot = 0): void {
    if (this.maxEvents <= 0) return;
    if (this.count >= this.maxEvents) {
      if (!this.truncated) this.truncated = true;
      return;
    }
    if (this.count >= this.t.length) this.grow();
    const i = this.count++;
    this.t[i] = simTime;
    this.x[i] = pen.x;
    this.y[i] = pen.y;
    this.z[i] = pen.z;
    this.p[i] = pen.pressure;
    this.vx[i] = pen.vx;
    this.vy[i] = pen.vy;
    this.tilt[i] = pen.tilt;
    this.azimuth[i] = pen.azimuth;
    this.dir[i] = pen.direction;
    let m = 0;
    if (pen.contact) m |= BIT_CONTACT;
    if (pen.down) m |= BIT_DOWN;
    for (const e of events) {
      if (e === 'down') m |= BIT_EVENT_DOWN;
      else if (e === 'up') m |= BIT_EVENT_UP;
      else if (e === 'instrument') m |= BIT_EVENT_INSTRUMENT;
    }
    if (blot > 0) m |= BIT_BLOT;
    this.meta[i] = m;
    this.inst[i] = instrumentIndex(pen.instrumentId);
  }

  /** Deterministic hash of the full event stream (replay equality tests). */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v & 0xffffffff), 0x01000193) >>> 0;
      h = Math.imul(h ^ ((v * 1024) & 0xffffffff), 0x01000193) >>> 0;
    };
    for (let i = 0; i < this.count; i++) {
      mix(this.x[i]);
      mix(this.y[i]);
      mix(this.p[i]);
      mix(this.meta[i]);
    }
    return h >>> 0;
  }

  serialize(): SerializedRecorder {
    return {
      count: this.count,
      t: this.t.slice(0, this.count),
      x: this.x.slice(0, this.count),
      y: this.y.slice(0, this.count),
      z: this.z.slice(0, this.count),
      p: this.p.slice(0, this.count),
      vx: this.vx.slice(0, this.count),
      vy: this.vy.slice(0, this.count),
      tilt: this.tilt.slice(0, this.count),
      azimuth: this.azimuth.slice(0, this.count),
      dir: this.dir.slice(0, this.count),
      meta: this.meta.slice(0, this.count),
      inst: this.inst.slice(0, this.count),
    };
  }

  static restore(s: SerializedRecorder, maxEvents: number): PenRecorder {
    const r = new PenRecorder(Math.max(maxEvents, s.count));
    r.count = s.count;
    r.t = Float64Array.from(s.t);
    r.x = Float32Array.from(s.x);
    r.y = Float32Array.from(s.y);
    r.z = Float32Array.from(s.z);
    r.p = Float32Array.from(s.p);
    r.vx = Float32Array.from(s.vx);
    r.vy = Float32Array.from(s.vy);
    r.tilt = Float32Array.from(s.tilt ?? new Float32Array(s.count));
    r.azimuth = Float32Array.from(s.azimuth ?? new Float32Array(s.count));
    r.dir = Float32Array.from(s.dir ?? new Float32Array(s.count));
    r.meta = Uint8Array.from(s.meta);
    r.inst = Uint8Array.from(s.inst);
    return r;
  }
}

const ORDER: InstrumentId[] = ['graphite', 'mechanical', 'fineliner', 'dip', 'brush', 'charcoal', 'eraser'];
export const instrumentIndex = (id: InstrumentId) => ORDER.indexOf(id);
export const instrumentByIndex = (i: number): InstrumentId => ORDER[i] ?? 'graphite';

export interface ReplayStats {
  samples: number;
  contactSamples: number;
  strokes: number;
  lifts: number;
  instrumentChanges: number;
  distanceContact: number;
  distanceAir: number;
}

/**
 * Replay a recording through the SAME deposition code the live simulation
 * uses — the artwork is rebuilt purely from physical pen events.
 */
export interface ReplayDeposit {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pressure: number;
  speed: number;
  instrument: InstrumentId;
  tilt: number;
  azimuth: number;
  dir: number;
  blot: number;
}

export function replayRecording(rec: SerializedRecorder, deposit: (d: ReplayDeposit) => void): ReplayStats {
  const stats: ReplayStats = {
    samples: rec.count,
    contactSamples: 0,
    strokes: 0,
    lifts: 0,
    instrumentChanges: 0,
    distanceContact: 0,
    distanceAir: 0,
  };
  let prevX = rec.count ? rec.x[0] : 0,
    prevY = rec.count ? rec.y[0] : 0,
    prevContact = false;
  for (let i = 0; i < rec.count; i++) {
    const contact = (rec.meta[i] & BIT_CONTACT) !== 0;
    const instrument = instrumentByIndex(rec.inst[i]);
    const x = rec.x[i],
      y = rec.y[i];
    const speed = Math.hypot(rec.vx[i], rec.vy[i]);
    const moved = Math.hypot(x - prevX, y - prevY);
    if (contact) {
      stats.contactSamples++;
      stats.distanceContact += moved;
      if (!prevContact) stats.strokes++;
      const blot = (rec.meta[i] & BIT_BLOT) !== 0 ? 1 : 0;
      // match the live deposit condition exactly: stationary contact without
      // a blot deposits nothing
      if (moved > 1e-6 || blot > 0) {
        deposit({
          x0: prevX,
          y0: prevY,
          x1: x,
          y1: y,
          pressure: rec.p[i],
          speed,
          instrument,
          tilt: rec.tilt[i] || 0.18,
          azimuth: rec.azimuth[i] || Math.PI / 2,
          dir: rec.dir[i],
          blot,
        });
      }
    } else {
      stats.distanceAir += moved;
      if (prevContact) stats.lifts++;
    }
    if (rec.meta[i] & BIT_EVENT_INSTRUMENT) stats.instrumentChanges++;
    prevX = x;
    prevY = y;
    prevContact = contact;
  }
  return stats;
}

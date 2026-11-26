/**
 * Session recording (spec §12). Every generation event is recorded as it
 * really happens: op parameters, executed trajectories, simulated stylus
 * telemetry, utility ops, corrections with reasons, stage transitions,
 * metrics and user interjections. Simulated stylus data is explicitly
 * marked as such and kept distinct from physical human input.
 */

import { ENGINE_VERSION, type DrawOp, type InstrumentId, type LiveMetrics, type Stage, type StylusSample } from '../core/types';

export interface OpRecord {
  opId: number;
  op: DrawOp;
  /** Downsampled contact samples of the executed trace. */
  samples: StylusSample[];
  durationMs: number;
  travelPx: number;
  drawPx: number;
  meanPressure: number;
  peakPressure: number;
  deposited: number;
  sharpened: boolean;
  /** Wall-clock timestamp of when execution finished. */
  wallTime: number;
  simulated: true;
}

export interface UserOpRecord {
  instrument: InstrumentId;
  samples: StylusSample[];
  wallTime: number;
  simulated: false;
}

export type SessionEvent =
  | { type: 'engine-start'; t: number; wallTime: number; version: string; seed: number; config: unknown }
  | { type: 'stage'; t: number; wallTime: number; stage: Stage; reason?: string }
  | { type: 'op'; t: number; record: OpRecord }
  | { type: 'user-op'; t: number; record: UserOpRecord }
  | { type: 'metrics'; t: number; wallTime: number; metrics: LiveMetrics }
  | { type: 'correction'; t: number; wallTime: number; opId: number; reason: string }
  | { type: 'pause' | 'resume' | 'cancel' | 'checkpoint' | 'restore' | 'complete'; t: number; wallTime: number; note?: string };

export class SessionRecorder {
  readonly events: SessionEvent[] = [];
  readonly opRecords: OpRecord[] = [];
  readonly corrections: Array<{ t: number; opId: number; reason: string }> = [];
  private t0 = Date.now();
  private version = ENGINE_VERSION;

  reset(seed: number, config: unknown, version = ENGINE_VERSION) {
    this.version = version;
    this.events.length = 0;
    this.opRecords.length = 0;
    this.corrections.length = 0;
    this.t0 = Date.now();
    this.events.push({ type: 'engine-start', t: 0, wallTime: this.t0, version: this.version, seed, config });
  }

  wallTime(t: number): number {
    return this.t0 + t;
  }

  stage(t: number, stage: Stage, reason?: string) {
    this.events.push({ type: 'stage', t, wallTime: this.wallTime(t), stage, reason });
  }

  op(t: number, record: OpRecord) {
    this.events.push({ type: 'op', t, record });
    this.opRecords.push(record);
    if (record.op.reason) {
      this.corrections.push({ t, opId: record.opId, reason: record.op.reason });
      this.events.push({ type: 'correction', t, wallTime: this.wallTime(t), opId: record.opId, reason: record.op.reason });
    }
  }

  userOp(t: number, record: UserOpRecord) {
    this.events.push({ type: 'user-op', t, record });
  }

  metrics(t: number, metrics: LiveMetrics) {
    this.events.push({ type: 'metrics', t, wallTime: this.wallTime(t), metrics });
  }

  simple(t: number, type: 'pause' | 'resume' | 'cancel' | 'checkpoint' | 'restore' | 'complete', note?: string) {
    this.events.push({ type, t, wallTime: this.wallTime(t), note });
  }

  /** Rehydrate the exported, quantized event log without changing the artwork checkpoint. */
  restore(log: unknown) {
    if (!log || typeof log !== 'object' || !('events' in log) || !Array.isArray(log.events)) return;
    this.events.length = 0;
    this.opRecords.length = 0;
    this.corrections.length = 0;
    function sample(values: number[]): StylusSample {
      const [t,x,y,z,pressure,v,tilt,azimuth] = values;
      return {t,x,y,z,pressure,v,tilt,azimuth};
    }
    for (const item of log.events.slice(0, 400000)) {
      if (!item || typeof item.type !== 'string') continue;
      if (item.type === 'op' && item.op && Array.isArray(item.samples)) {
        const record: OpRecord = {...item,samples:item.samples.map(sample),simulated:true};
        this.opRecords.push(record);
        this.events.push({type:'op',t:item.t,record});
      } else if (item.type === 'user-op' && Array.isArray(item.samples)) {
        this.events.push({type:'user-op',t:item.t,record:{instrument:item.instrument,samples:item.samples.map(sample),wallTime:item.wallTime,simulated:false}});
      } else if (item.type !== 'op' && item.type !== 'user-op') {
        const event=item as SessionEvent;
        this.events.push(event);
        if(event.type==='engine-start'){this.t0=event.wallTime;this.version=event.version;}
        if(event.type==='correction')this.corrections.push({t:event.t,opId:event.opId,reason:event.reason});
      }
    }
  }

  /** Downsample contact samples for compact storage. */
  static compressSamples(samples: StylusSample[], max = 72): StylusSample[] {
    if (samples.length <= max) return samples;
    const step = samples.length / max;
    const out: StylusSample[] = [];
    for (let i = 0; i < max; i++) {
      out.push(samples[Math.min(samples.length - 1, Math.floor(i * step))]);
    }
    return out;
  }

  /** Full session export as plain JSON (quantized samples, base64 blobs). */
  export(): object {
    return {
      format: 'nth-session',
      version: this.version,
      generated: new Date().toISOString(),
      note: 'All stylus trajectories are simulated data produced by the NTH Stroke engine; they are not human stylus recordings.',
      events: this.events.map((e) => {
        if (e.type === 'op') {
          return {
            type: 'op',
            t: round(e.t),
            opId: e.record.opId,
            op: e.record.op,
            simulated: true,
            durationMs: round(e.record.durationMs),
            travelPx: round(e.record.travelPx),
            drawPx: round(e.record.drawPx),
            meanPressure: round(e.record.meanPressure, 4),
            peakPressure: round(e.record.peakPressure, 4),
            deposited: round(e.record.deposited, 3),
            sharpened: e.record.sharpened,
            wallTime: e.record.wallTime,
            samples: e.record.samples.map((s) => [
              round(s.t, 1), round(s.x, 1), round(s.y, 1), round(s.z, 1),
              round(s.pressure, 3), round(s.v, 3), round(s.tilt, 3), round(s.azimuth, 3),
            ]),
          };
        }
        if (e.type === 'user-op') {
          return {
            type: 'user-op',
            t: round(e.t),
            simulated: false,
            instrument: e.record.instrument,
            wallTime: e.record.wallTime,
            samples: e.record.samples.map((s) => [
              round(s.t, 1), round(s.x, 1), round(s.y, 1), round(s.z, 1),
              round(s.pressure, 3), round(s.v, 3), round(s.tilt, 3), round(s.azimuth, 3),
            ]),
          };
        }
        return e;
      }),
    };
  }
}

function round(v: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

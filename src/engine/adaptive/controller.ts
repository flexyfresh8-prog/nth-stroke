import type { ControllerCallbacks } from '../control/controller';
import { clamp } from '../core/math';
import {
  DEFAULT_CONFIG,
  type DrawOp,
  type EngineSnapshot,
  type InstrumentId,
  type Stage,
  type StylusSample,
  type Vec2,
} from '../core/types';
import { base64ToBytes, bytesToBase64, type Rect } from '../media/graphite';
import { SessionRecorder } from '../session/recorder';
import type { AdaptiveConfig } from './config';
import { measure, type Accuracy } from './metrics';
import type { Field } from './perception';
import { MEDIA, Pigment, type Mark, type Patch } from './pigment';
import { Optimizer } from './solver';

const STAGES: Stage[] = ['construction', 'refinement', 'tonal', 'shading', 'detail', 'correction'];
interface Active {
  mark: Mark;
  patch: Patch;
  delta: Float32Array;
  start: number;
  travel: number;
  duration: number;
  last: number;
  base: Float32Array;
  from: Vec2;
}

export class AdaptiveController {
  readonly config: AdaptiveConfig;
  readonly map: Pigment;
  readonly paper = { albedo: new Float32Array(0) };
  readonly session = new SessionRecorder();
  readonly history: Array<{ mark: Mark; manual?: StylusSample[] }> = [];
  readonly accuracyHistory: Array<{ strokes: number; ms: number; ssim: number }> = [];
  readonly optimizer: Optimizer;
  stage: Stage = 'observation';
  running = false;
  done = false;
  opCount = 0;
  simTime = 0;
  computeMs = 0;
  corrected = 0;
  private active: Active | null = null;
  private cursor: Vec2;
  private pressure = 0;
  private accuracy: Accuracy | null = null;
  private previousAccuracy = 0;
  private stagnation = 0;
  private limit: number;
  private reason = 'Reference analyzed';
  private replayDensity: Float32Array | null = null;
  private replayAccuracy: Accuracy | null = null;
  private replayIndex: number | null = null;
  private replaying = false;
  private replayCredit = 0;
  private replayStart = 0;

  constructor(
    readonly field: Field,
    config: Partial<AdaptiveConfig>,
    private readonly callbacks: ControllerCallbacks = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.opBudget = clamp(Math.round(this.config.opBudget), 1, 100000);
    this.map = new Pigment(field.width, field.height, this.config.seed, this.config.paperGrain);
    this.optimizer = new Optimizer(field, this.map, this.config);
    this.cursor = { x: field.width * 0.5, y: field.height * 0.5 };
    this.limit = this.config.opBudget;
    this.session.reset(this.config.seed, this.config, '2.0.0');
  }
  get busy() {
    return !!this.active;
  }
  get userEditedSinceEval() {
    return false;
  }
  start() {
    this.resume();
  }
  pause() {
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) this.refreshVisibleAccuracy();
    this.session.simple(this.simTime, 'pause');
  }
  cancel() {
    this.running = false;
    this.replaying = false;
    this.session.simple(this.simTime, 'cancel');
    this.reason = 'Canceled';
  }
  resume() {
    if (this.replayIndex !== null) {
      this.replaying = true;
      this.running = true;
      return;
    }
    if (this.done) return;
    this.running = true;
    this.session.simple(this.simTime, 'resume');
  }
  refine() {
    if (this.replayIndex !== null) this.seek(this.history.length);
    if (!this.done) {
      this.resume();
      return;
    }
    this.done = false;
    this.limit = Math.min(100000, this.opCount + Math.max(1000, Math.round(this.config.opBudget * 0.5)));
    this.optimizer.setPhase(5, this.opCount);
    this.stagnation = 0;
    this.running = true;
  }
  private refreshVisibleAccuracy() {
    this.accuracy = measure(
      this.map.tone(),
      this.field.tone,
      this.field.width,
      this.field.height,
      this.field.importance,
    );
    return this.accuracy;
  }
  evaluate() {
    const accuracy = this.refreshVisibleAccuracy();
    this.accuracyHistory.push({ strokes: this.opCount, ms: Math.round(this.computeMs), ssim: accuracy.ssim });
    if (this.accuracyHistory.length > 900) this.accuracyHistory.splice(1, 1);
    this.session.metrics(this.simTime, this.metrics());
    if (this.optimizer.phase >= 4) {
      const current = accuracy.ssim;
      const threshold = 0.000018 + this.optimizer.settings.convergence * 0.00067;
      this.stagnation = current - this.previousAccuracy < threshold ? this.stagnation + 1 : 0;
      this.previousAccuracy = current;
    }
    return accuracy;
  }
  private metrics() {
    const a = this.accuracy;
    return {
      ssim: a?.ssim ?? 0,
      toneError: a?.mae ?? 1,
      edgeAlignment: a?.alignment ?? 0,
      contrastError: a?.contrast ?? 1,
      structureError: 1 - (a?.features ?? 0),
    };
  }
  snapshot(): EngineSnapshot {
    return {
      stage: this.stage,
      objective: this.reason,
      instrument: this.active?.mark.instrument ?? this.history.at(-1)?.mark.instrument ?? null,
      recorded: this.history.length,
      position: this.replayIndex ?? this.history.length,
      opCount: this.replayIndex ?? this.opCount,
      simTimeMs: this.simTime,
      wallTimeMs: this.computeMs,
      cursor: { ...this.cursor, z: this.pressure ? 0 : 4 },
      pressure: this.pressure,
      phase: this.active ? (this.pressure ? 'draw' : 'travel') : 'idle',
      running: this.running,
      done: this.done && !this.replaying,
      metrics: this.metrics(),
      progress: this.replaying
        ? (this.replayIndex ?? 0) / Math.max(1, this.history.length)
        : this.done
          ? 1
          : Math.min(0.99, this.opCount / this.limit),
    };
  }
  runOps(count: number, ms = Infinity) {
    if (this.replaying) {
      this.replayStep(Math.max(1, Math.min(count, 64)));
      return;
    }
    const start = performance.now();
    for (let i = 0; i < count && this.running && !this.done; i++) {
      if (!this.active && !this.plan()) break;
      const op = this.active!;
      this.simTime = op.start + op.travel + op.duration;
      this.apply(op, 1);
      this.finish(op);
      if (performance.now() - start >= ms) break;
    }
  }
  advance(target: number) {
    if (this.replaying && this.running) {
      this.replayCredit += target - this.simTime;
      this.simTime = target;
      const count = Math.floor(this.replayCredit / 75);
      if (count) {
        this.replayCredit -= count * 75;
        this.replayStep(count);
      }
      return;
    }
    if (!this.running || this.done) return;
    const start = performance.now();
    for (let i = 0; i < 32 && this.running && performance.now() - start < 11; i++) {
      if (!this.active && !this.plan()) break;
      const op = this.active!;
      const end = op.start + op.travel + op.duration;
      // Test the absolute endpoint before normalizing. Rounding in the
      // subtraction below can leave a completed stroke just short of 1.
      if (target >= end) {
        this.simTime = end;
        this.apply(op, 1);
        this.finish(op);
        if (target === end) break;
        continue;
      }
      this.simTime = target;
      const t = (target - op.start - op.travel) / op.duration;
      if (t < 0) {
        const f = clamp((this.simTime - op.start) / op.travel, 0, 1);
        const eased = f * f * f * (10 + f * (-15 + f * 6));
        this.cursor = {
          x: op.from.x + (op.mark.path[0].x - op.from.x) * eased,
          y: op.from.y + (op.mark.path[0].y - op.from.y) * eased,
        };
        this.pressure = 0;
        break;
      }
      this.apply(op, t * t * (3 - 2 * t));
      break;
    }
  }
  private plan() {
    const seconds = this.optimizer.settings.maxSeconds;
    if (this.opCount >= this.limit || (seconds > 0 && this.computeMs >= seconds * 1000)) {
      this.complete(this.opCount >= this.limit ? 'Stroke budget reached' : 'Compute time limit reached');
      return false;
    }
    const start = performance.now();
    const chosen = this.optimizer.next(this.opCount);
    this.computeMs += performance.now() - start;
    if (!chosen) {
      this.complete('No improving stroke found');
      return false;
    }
    const { mark, patch, delta } = chosen;
    const stage = STAGES[mark.phase];
    if (stage !== this.stage) {
      this.stage = stage;
      this.session.stage(this.simTime, stage);
      this.callbacks.onStage?.(stage);
    }
    const lastTool = this.history.at(-1)?.mark.instrument;
    this.reason =
      MEDIA[mark.instrument].mode === 'lift'
        ? 'Lift excess graphite'
        : MEDIA[mark.instrument].mode === 'blend'
          ? 'Redistribute pigment'
          : stage === 'construction'
            ? 'Establish a measured boundary'
            : stage === 'refinement'
              ? 'Resolve a structural edge'
              : stage === 'tonal'
                ? 'Build a broad tonal mass'
                : 'Reduce a local tonal or edge residual';
    const traced = mark.path.reduce(
      (sum, p, i) => (i ? sum + Math.hypot(p.x - mark.path[i - 1].x, p.y - mark.path[i - 1].y) : sum),
      0,
    );
    const distance = Math.hypot(this.cursor.x - mark.path[0].x, this.cursor.y - mark.path[0].y);
    const travel =
      26 +
      Math.sqrt(distance) * 10 +
      (lastTool !== mark.instrument ? 75 : 0) +
      (distance > this.field.width * 0.22 ? 65 : 0);
    this.active = {
      mark,
      patch,
      delta,
      start: this.simTime,
      travel,
      duration: 47 + (traced * 5.1) / mark.speed,
      last: -1,
      base: Float32Array.from(patch.indices, (p) => this.map.density[p]),
      from: this.cursor,
    };
    return true;
  }
  private apply(op: Active, progress: number) {
    const start = performance.now();
    for (let j = 0; j < op.patch.indices.length; j++) {
      const t = op.patch.arrival[j];
      if (t > progress || t <= op.last) continue;
      this.map.density[op.patch.indices[j]] = clamp(op.base[j] + op.mark.opacity * op.delta[j], 0, 1);
    }
    op.last = progress;
    const path = op.mark.path,
      f = clamp(progress, 0, 1) * (path.length - 1),
      i = Math.min(path.length - 2, Math.floor(f)),
      u = f - i;
    this.cursor = {
      x: path[i].x + (path[i + 1].x - path[i].x) * u,
      y: path[i].y + (path[i + 1].y - path[i].y) * u,
    };
    this.pressure = progress < 1 ? Math.sin(Math.PI * progress) ** 0.6 * op.mark.opacity : 0;
    this.callbacks.onDirty?.([op.patch.box], progress === 1);
    this.computeMs += performance.now() - start;
  }
  private finish(op: Active) {
    this.opCount++;
    const mode = MEDIA[op.mark.instrument].mode;
    const correction = mode !== 'deposit' || op.mark.phase === 5;
    const { mark } = op;
    const event: DrawOp = {
      id: this.opCount,
      kind: 'stroke',
      stage: this.stage,
      instrument: mark.instrument,
      intent: this.reason,
      waypoints: mark.path,
      pressure: mark.opacity,
      speed: mark.speed,
      region: -1,
      corrective: correction,
      travel: true,
      reason: correction ? this.reason : undefined,
    };
    const samples = mark.path.map((p, i) => ({
      x: p.x,
      y: p.y,
      z: 0,
      t: op.start + op.travel + (i / (mark.path.length - 1)) * op.duration,
      pressure: mark.opacity * (0.55 + 0.45 * Math.sin((Math.PI * i) / (mark.path.length - 1))),
      v: mark.speed,
      tilt: 0.35,
      azimuth: 0,
    }));
    this.session.op(this.simTime, {
      opId: this.opCount,
      op: event,
      samples,
      durationMs: op.travel + op.duration,
      travelPx: Math.hypot(op.from.x - mark.path[0].x, op.from.y - mark.path[0].y),
      drawPx: mark.path.reduce(
        (sum, p, i) => (i ? sum + Math.hypot(p.x - mark.path[i - 1].x, p.y - mark.path[i - 1].y) : sum),
        0,
      ),
      meanPressure: mark.opacity * 0.77,
      peakPressure: mark.opacity,
      deposited: op.delta.reduce((s, d) => s + d * mark.opacity, 0),
      sharpened: false,
      wallTime: Date.now(),
      simulated: true,
    });
    if (correction) {
      this.corrected++;
      if (this.corrected <= 15 || this.corrected % 16 === 0) this.callbacks.onCorrection?.(this.reason);
    }
    this.history.push({ mark });
    this.optimizer.last = this.cursor;
    this.optimizer.dirty(op.patch.box);
    this.active = null;
    if (this.opCount % Math.max(80, Math.round(this.limit / 24)) === 0) {
      const start = performance.now();
      this.evaluate();
      this.computeMs += performance.now() - start;
      if (this.optimizer.settings.automatic && this.stagnation >= 3) this.complete('Improvement plateau');
    }
  }
  private complete(reason: string) {
    this.running = false;
    this.done = true;
    this.stage = 'complete';
    this.reason = reason;
    this.evaluate();
    this.callbacks.onStage?.('complete', reason);
    this.callbacks.onSnapshot?.(this.snapshot());
    this.session.simple(this.simTime, 'complete', reason);
  }
  private stamp(mark: Mark) {
    const patch = this.map.footprint(mark);
    const delta = this.map.direction(patch);
    for (let i = 0; i < patch.indices.length; i++)
      this.map.density[patch.indices[i]] = clamp(
        this.map.density[patch.indices[i]] + mark.opacity * delta[i],
        0,
        1,
      );
    return patch.box;
  }
  injectUserStroke(samples: StylusSample[], instrument: InstrumentId) {
    if (!samples.length) return;
    if (this.replayIndex !== null) this.seek(this.history.length);
    if (this.active) {
      this.apply(this.active, 1);
      this.finish(this.active);
    }
    const path = samples.map(({ x, y }) => ({ x, y }));
    if (path.length === 1) path.push(path[0]);
    const force = samples.reduce((s, p) => s + p.pressure, 0) / samples.length;
    const mark = {
      path,
      radius: MEDIA[instrument].radius * (0.7 + force * 0.85),
      instrument,
      opacity: force * MEDIA[instrument].strength,
      phase: 4,
      speed: 1,
    };
    const box = this.stamp(mark);
    this.history.push({ mark, manual: samples });
    this.session.userOp(this.simTime, { instrument, samples, wallTime: Date.now(), simulated: false });
    this.optimizer.dirty(box);
    this.callbacks.onDirty?.([box], true);
    this.evaluate();
  }
  replay() {
    if (!this.history.length) return;
    this.seek(0);
    this.replaying = true;
    this.running = true;
    this.replayCredit = 0;
  }
  private replayStep(count: number) {
    const from = this.replayIndex ?? 0,
      to = Math.min(this.history.length, from + count);
    const boxes: Rect[] = [];
    for (let i = from; i < to; i++) boxes.push(this.stamp(this.history[i].mark));
    this.replayIndex = to;
    this.callbacks.onDirty?.(boxes, true);
    if (to % 96 < count) this.refreshVisibleAccuracy();
    if (to === this.history.length) {
      this.seek(to);
      this.reason = 'Replay complete';
    }
  }
  seek(index: number) {
    this.replaying = false;
    if (this.replayIndex === null) {
      this.replayDensity = this.map.density.slice();
      this.replayAccuracy = this.accuracy;
      this.replayStart = this.simTime;
    }
    this.running = false;
    this.replayIndex = clamp(Math.round(index), 0, this.history.length);
    if (this.replayIndex === this.history.length) {
      this.map.density.set(this.replayDensity!);
      this.accuracy = this.replayAccuracy;
      this.simTime = this.replayStart;
      this.replayIndex = null;
      this.replayDensity = null;
    } else {
      this.map.density.fill(0);
      for (let i = 0; i < this.replayIndex; i++) this.stamp(this.history[i].mark);
      this.refreshVisibleAccuracy();
    }
    this.callbacks.onDirty?.([{ x: 0, y: 0, w: this.map.width, h: this.map.height }], true);
  }
  get activeRegion() {
    return this.active?.patch.box ?? null;
  }
  diagnostics() {
    return {
      history: this.accuracyHistory,
      accuracy: this.refreshVisibleAccuracy(),
      trials: this.optimizer.trials,
      instrument: this.active?.mark.instrument ?? this.history.at(-1)?.mark.instrument ?? null,
      stage: this.stage,
      region: this.active?.patch.box ?? null,
      total: this.history.length,
    };
  }
  historyForExport() {
    return this.replayIndex === null ? this.history : this.history.slice(0, this.replayIndex);
  }
  checkpoint() {
    const data = this.replayDensity ?? this.map.density;
    return {
      version: '2.0.0',
      landmarks: this.field.landmarks,
      width: this.map.width,
      height: this.map.height,
      opCount: this.opCount,
      done: this.done,
      stage: this.stage,
      time: this.simTime,
      cursor: this.cursor,
      corrected: this.corrected,
      limit: this.limit,
      computeMs: this.computeMs,
      optimizer: this.optimizer.serial(),
      history: this.history,
      metrics: this.accuracyHistory,
      accuracy: this.accuracy,
      previousAccuracy: this.previousAccuracy,
      stagnation: this.stagnation,
      reason: this.reason,
      density: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      active: this.active && {
        ...this.active,
        patch: {
          ...this.active.patch,
          indices: Array.from(this.active.patch.indices),
          coverage: Array.from(this.active.patch.coverage),
          arrival: Array.from(this.active.patch.arrival),
        },
        delta: Array.from(this.active.delta),
        base: Array.from(this.active.base),
      },
    };
  }
  restore(data: ReturnType<AdaptiveController['checkpoint']>) {
    if (
      data.version !== '2.0.0' ||
      data.width !== this.map.width ||
      data.height !== this.map.height ||
      data.history.length > 110000
    )
      throw new Error('V2 project dimensions or version are unsupported.');
    const bytes = base64ToBytes(data.density);
    if (bytes.length < this.map.density.byteLength) throw new Error('Incomplete pigment checkpoint.');
    this.map.density.set(new Float32Array(bytes.buffer, 0, this.map.density.length));
    this.opCount = data.opCount;
    this.done = data.done;
    this.stage = data.stage;
    this.simTime = data.time;
    this.cursor = data.cursor;
    this.computeMs = data.computeMs;
    this.corrected = data.corrected;
    this.limit = data.limit;
    this.optimizer.restore(data.optimizer);
    this.history.length = 0;
    for (const mark of data.history) this.history.push(mark);
    this.accuracyHistory.push(...data.metrics);
    if (data.active) {
      const op = data.active;
      this.active = {
        ...op,
        patch: {
          ...op.patch,
          indices: Int32Array.from(op.patch.indices),
          coverage: Float32Array.from(op.patch.coverage),
          arrival: Float32Array.from(op.patch.arrival),
        },
        delta: Float32Array.from(op.delta),
        base: Float32Array.from(op.base),
      };
    }
    this.accuracy = data.accuracy;
    this.previousAccuracy = data.previousAccuracy ?? 0;
    this.stagnation = data.stagnation ?? 0;
    this.reason = data.reason ?? 'Session restored';
    this.callbacks.onDirty?.([{ x: 0, y: 0, w: this.map.width, h: this.map.height }], true);
  }
}

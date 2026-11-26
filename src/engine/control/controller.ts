/**
 * DrawingController — the closed-loop autonomous artist (spec §7):
 *
 *   OBSERVE → PLAN → DRAW → EVALUATE → CORRECT → REPEAT
 *
 * The controller owns the paper, the graphite map, the media engine, the
 * virtual hand, the evaluator and the planner. Nothing is precomputed: each
 * next operation is planned from the *current* canvas state, so pausing,
 * user edits, erasures and checkpoints all redirect the engine naturally.
 *
 * The host (worker / Node test) drives simulated time:
 *   - realtime pacing: advance(toSimTime) applies contact samples up to a
 *     simulated instant, so strokes form live on the canvas;
 *   - max computation speed: runOps(n) executes whole ops unrendered.
 */

import type { SceneGraph } from '../analysis/scene';
import { Rng, mixHash } from '../core/rng';
import { clamp } from '../core/math';
import {
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  type DrawOp,
  type EngineConfig,
  type EngineSnapshot,
  type InstrumentId,
  type LiveMetrics,
  type OpTrace,
  type Stage,
  type StylusSample,
  type Vec2,
} from '../core/types';
import { GraphiteMap } from '../media/graphite';
import { Paper } from '../media/paper';
import { MediaEngine } from '../media/engine';
import { instrument } from '../media/instruments';
import { HandController } from '../motor/hand';
import { Evaluator, type Evaluation } from '../perception/evaluator';
import { Planner } from '../planning/planner';
import { SessionRecorder, type OpRecord } from '../session/recorder';

const STAGES: Stage[] = ['construction', 'refinement', 'tonal', 'shading', 'detail', 'correction', 'complete'];

/** Everything required to pause now and resume later, bit-exactly. */
export interface ControllerCheckpoint {
  version: string;
  stage: Stage;
  running: boolean;
  done: boolean;
  opCount: number;
  simTime: number;
  nextOpId: number;
  planAt: number;
  evalEvery: number;
  opsSinceEval: number;
  finishReason: string;
  rng: ReturnType<Rng['state']>;
  handCursor: Vec2;
  map: ReturnType<GraphiteMap['encode']>;
  planner: ReturnType<Planner['serialize']> | null;
  /** In-flight stroke at checkpoint time (null when between ops). */
  current: { op: DrawOp; trace: OpTrace; applied: number; startSim: number } | null;
  media: { tipLoad: number; drawnSinceSharpen: number };
}

export interface DirtyListener {
  (rects: Array<{ x: number; y: number; w: number; h: number }>, complete: boolean): void;
}

export interface ControllerCallbacks {
  onDirty?: DirtyListener;
  onSnapshot?: (snapshot: EngineSnapshot) => void;
  onStage?: (stage: Stage, reason?: string) => void;
  onCorrection?: (reason: string) => void;
}

export class DrawingController {
  readonly config: EngineConfig;
  readonly paper: Paper;
  readonly map: GraphiteMap;
  readonly media: MediaEngine;
  readonly hand: HandController;
  readonly evaluator = new Evaluator();
  readonly session = new SessionRecorder();
  planner: Planner | null = null;

  stage: Stage = 'observation';
  running = false;
  done = false;
  opCount = 0;
  simTime = 0;
  wallClockStart = 0;
  private rng: Rng;
  private evaluation: Evaluation | null = null;
  private userRng: Rng;
  private current: { op: DrawOp; trace: OpTrace; applied: number; startSim: number } | null = null;
  private planAt = 0;
  private opRegistry = new Map<number, Vec2[]>();
  private nextOpId = 1;
  private evalEvery = 6;
  private opsSinceEval = 0;
  private metricHistory: Array<{ t: number; metrics: LiveMetrics }> = [];
  private lastUserEdits = 0;
  private objective = 'observing reference';
  private finishReason = '';

  constructor(
    private readonly scene: SceneGraph | null,
    config: Partial<EngineConfig> = {},
    private readonly callbacks: ControllerCallbacks = {},
    seedExtra = 0,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const w = scene?.canvasWidth ?? 640;
    const h = scene?.canvasHeight ?? 480;
    this.rng = new Rng(mixHash(this.config.seed, seedExtra));
    this.userRng = new Rng(mixHash(this.config.seed, 0x5eed1e ^ seedExtra));
    this.paper = new Paper(w, h, this.config.seed, this.config.paperGrain);
    this.map = new GraphiteMap(w, h);
    this.media = new MediaEngine(this.paper, this.map, this.rng, this.userRng);
    this.hand = new HandController(this.rng);
    this.hand.setCursor({ x: w * 0.5, y: h + 14 });
    if (scene) {
      this.planner = new Planner(scene, this.config, this.rng);
      this.planner.registerOps(this.opRegistry);
    }
  }

  /* -------------------------------------------------------------- */
  /* lifecycle                                                       */
  /* -------------------------------------------------------------- */

  start() {
    if (this.done || this.running || !this.planner) return;
    if (this.stage === 'observation' && this.opCount === 0) {
      this.session.reset(this.config.seed, this.config);
      this.enterStage('construction', 'analysis complete');
    }
    this.running = true;
    if (this.wallClockStart === 0) this.wallClockStart = Date.now();
    this.session.simple(this.simTime, 'resume', 'start');
    this.emitSnapshot();
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    this.session.simple(this.simTime, 'pause');
    this.emitSnapshot();
  }

  resume() {
    if (this.done || this.running) return;
    this.running = true;
    this.session.simple(this.simTime, 'resume');
    this.emitSnapshot();
  }

  cancel() {
    this.running = false;
    this.session.simple(this.simTime, 'cancel');
    this.emitSnapshot();
  }

  /** True when the engine is mid-op. */
  get busy(): boolean {
    return this.current !== null;
  }

  get currentOp(): DrawOp | null {
    return this.current?.op ?? null;
  }

  get metrics(): LiveMetrics {
    return (
      this.evaluation?.metrics ?? { ssim: 0, toneError: 1, edgeAlignment: 0, contrastError: 1, structureError: 1 }
    );
  }

  get metricSeries(): Array<{ t: number; metrics: LiveMetrics }> {
    return this.metricHistory;
  }

  /* -------------------------------------------------------------- */
  /* the loop                                                        */
  /* -------------------------------------------------------------- */

  /**
   * Advance to a simulated instant, applying contact samples as sim time
   * passes so strokes form progressively on the canvas.
   */
  advance(toSimTime: number) {
    if (!this.running || !this.planner) return;
    let guard = 0;
    while (this.simTime < toSimTime && this.running && guard++ < 4000) {
      if (this.current) {
        const { trace, startSim, applied } = this.current;
        const endSim = startSim + trace.durationMs;
        if (toSimTime >= endSim) {
          this.applySamples(trace, applied, trace.contact.length);
          this.finishOp();
          this.simTime = endSim;
        } else {
          let i = applied;
          while (i < trace.contact.length && trace.contact[i].t <= toSimTime) i++;
          if (i > applied) {
            this.applySamples(trace, applied, i);
            this.current.applied = i;
          }
          this.simTime = toSimTime;
          break;
        }
      } else if (this.simTime >= this.planAt) {
        this.planNext();
        if (!this.running) break;
      } else {
        this.simTime = toSimTime;
        break;
      }
    }
    if (this.opsSinceEval >= this.evalEvery && !this.current) this.evaluate();
  }

  /** Max-computation-speed mode: execute whole ops without rendering. */
  runOps(count: number, maxMs = 24): number {
    if (!this.running || !this.planner) return 0;
    const t0 = Date.now();
    let executed = 0;
    for (let i = 0; i < count; i++) {
      if (Date.now() - t0 > maxMs) break;
      if (this.current) {
        this.applySamples(this.current.trace, this.current.applied, this.current.trace.contact.length);
        this.simTime = this.current.startSim + this.current.trace.durationMs;
        this.finishOp();
        executed++;
        continue;
      }
      if (this.done || !this.running) break;
      this.planNext();
      if (!this.current) break;
    }
    if (this.opsSinceEval >= this.evalEvery) this.evaluate();
    return executed;
  }

  private planNext() {
    if (!this.planner || this.done) return;
    const ctx = {
      stage: this.stage,
      evaluation: this.evaluation,
      map: this.map,
      media: this.media,
      cursor: this.hand.cursor,
      opCount: this.opCount,
    };
    this.objective = this.planner.objective(ctx);
    const result = this.planner.planOp(ctx);
    if ('advance' in result) {
      const idx = STAGES.indexOf(this.stage);
      if (this.stage === 'correction' && result.reason === 'correction pass complete') {
        // Stay in correction until problems are resolved or rounds exhaust.
        this.evaluate();
        const still = (this.evaluation?.problems ?? []).length > 0;
        if (still && this.opCount < this.config.opBudget) {
          this.planAt = this.simTime + 120 + this.rng.next() * 160;
          return;
        }
      }
      if (idx >= STAGES.length - 1) {
        this.complete(result.reason);
        return;
      }
      this.enterStage(STAGES[idx + 1], result.reason);
      this.planAt = this.simTime;
      return;
    }
    // Assign the definitive id and register the footprint for spatial queries.
    const op: DrawOp = { ...result.op, id: this.nextOpId++ };
    this.opRegistry.set(op.id, op.waypoints);
    const trace = this.hand.execute(op, this.simTime);
    this.current = { op, trace, applied: 0, startSim: this.simTime };
    this.objective = `${this.planner.objective(ctx)} — ${op.intent}`;
  }

  private applySamples(trace: OpTrace, from: number, to: number) {
    if (to <= from) return;
    const contact = trace.contact.slice(from, to);
    if (contact.length) {
      this.media.applyTrace(
        instrument(this.current!.op.instrument),
        contact,
        this.current!.op.id,
        this.current!.op.broad ?? false,
        from > 0,
      );
    }
    this.flushDirty();
  }

  private finishOp() {
    if (!this.current) return;
    const { op, trace } = this.current;
    const result = this.media.lastResult;
    const record: OpRecord = {
      opId: op.id,
      op,
      samples: SessionRecorder.compressSamples(trace.contact),
      durationMs: trace.durationMs,
      travelPx: trace.travelPx,
      drawPx: trace.drawPx,
      meanPressure: trace.meanPressure,
      peakPressure: trace.peakPressure,
      deposited: result?.deposited ?? 0,
      sharpened: result?.sharpened ?? false,
      wallTime: Date.now(),
      simulated: true,
    };
    this.session.op(this.simTime, record);
    if (op.reason && this.callbacks.onCorrection) this.callbacks.onCorrection(op.reason);
    this.opCount++;
    this.opsSinceEval++;
    this.current = null;
    // A brief look at the paper before the next mark (natural rhythm).
    this.planAt = this.simTime + 30 + this.rng.next() * (op.corrective ? 260 : 120);
    if (this.opCount >= this.config.opBudget * 1.3) {
      this.complete('operation budget reached');
    }
  }

  evaluate() {
    if (!this.scene || !this.planner) return;
    this.evaluation = this.evaluator.evaluate(this.scene, this.map, this.paper.albedo);
    this.metricHistory.push({ t: this.simTime, metrics: this.evaluation.metrics });
    if (this.metricHistory.length > 2000) this.metricHistory.shift();
    this.session.metrics(this.simTime, this.evaluation.metrics);
    this.opsSinceEval = 0;
    this.lastUserEdits = this.map.edits;
  }

  private enterStage(stage: Stage, reason?: string) {
    this.stage = stage;
    this.session.stage(this.simTime, stage, reason);
    this.callbacks.onStage?.(stage, reason);
    if (stage === 'shading' || stage === 'detail') this.evalEvery = 8;
    if (stage === 'correction') this.evalEvery = 4;
    if (stage === 'complete') this.complete(reason ?? 'all stages complete');
  }

  private complete(reason: string) {
    if (this.done) return;
    this.done = true;
    this.running = false;
    this.stage = 'complete';
    this.finishReason = reason;
    this.evaluate();
    this.session.simple(this.simTime, 'complete', reason);
    this.callbacks.onStage?.('complete', reason);
    this.emitSnapshot();
  }

  /* -------------------------------------------------------------- */
  /* user interjection (spec §7: interrupt / modify / erase)          */
  /* -------------------------------------------------------------- */

  /** Apply a user-drawn stroke (samples already ordered). */
  injectUserStroke(samples: StylusSample[], instrumentId: InstrumentId) {
    if (!samples.length) return;
    this.media.applyTrace(instrument(instrumentId), samples, -1, false, false, true);
    this.session.userOp(this.simTime, {
      instrument: instrumentId,
      samples: SessionRecorder.compressSamples(samples, 96),
      wallTime: Date.now(),
      simulated: false,
    });
    this.flushDirty();
    // The next observation will see the user's marks and adapt. Force an
    // early evaluation and let any in-flight op finish first.
    this.opsSinceEval = this.evalEvery;
  }

  /** Check whether the user changed the canvas since the last evaluation. */
  get userEditedSinceEval(): boolean {
    return this.map.edits !== this.lastUserEdits;
  }

  /* -------------------------------------------------------------- */
  /* snapshot & checkpoints                                          */
  /* -------------------------------------------------------------- */

  snapshot(): EngineSnapshot {
    let sample: StylusSample | null = null;
    if (this.current) {
      for (const s of this.current.trace.samples) {
        if (s.t <= this.simTime) sample = s;
        else break;
      }
    }
    const stageIdx = STAGES.indexOf(this.stage);
    const quality =
      0.45 * this.metrics.ssim + 0.2 * this.metrics.edgeAlignment + 0.2 * (1 - this.metrics.toneError) + 0.15 * (1 - this.metrics.structureError);
    const progress = this.done ? 1 : clamp((stageIdx + quality) / STAGES.length, 0, 0.99);
    return {
      stage: this.stage,
      objective: this.objective,
      instrument: this.current?.op.instrument ?? null,
      opCount: this.opCount,
      simTimeMs: this.simTime,
      wallTimeMs: this.wallClockStart ? Date.now() - this.wallClockStart : 0,
      cursor: sample ? { x: sample.x, y: sample.y, z: sample.z } : { x: this.hand.cursor.x, y: this.hand.cursor.y, z: 3 },
      pressure: sample?.pressure ?? 0,
      phase: this.done ? 'idle' : this.current ? (sample && sample.z > 0.4 ? 'travel' : 'draw') : this.running ? 'thinking' : 'idle',
      running: this.running,
      done: this.done,
      metrics: this.metrics,
      progress,
    };
  }

  private emitSnapshot() {
    this.callbacks.onSnapshot?.(this.snapshot());
  }

  /** Notify the host of newly dirtied regions. */
  private flushDirty() {
    const tiles = this.media.grid.takeDirtyTiles();
    if (!tiles.length) return;
    const cols = this.media.grid.cols;
    const rects = tiles.map((t) => ({
      x: (t % cols) * 32,
      y: Math.floor(t / cols) * 32,
      w: 32,
      h: 32,
    }));
    this.callbacks.onDirty?.(rects, false);
  }

  /** Serialize everything needed to resume exactly, including an
   *  in-flight stroke (spec §11). */
  checkpoint(): ControllerCheckpoint {
    return {
      version: ENGINE_VERSION,
      stage: this.stage,
      running: this.running,
      done: this.done,
      opCount: this.opCount,
      simTime: this.simTime,
      nextOpId: this.nextOpId,
      planAt: this.planAt,
      evalEvery: this.evalEvery,
      opsSinceEval: this.opsSinceEval,
      finishReason: this.finishReason,
      rng: this.rng.state(),
      handCursor: this.hand.cursor,
      map: this.map.encode(),
      planner: this.planner?.serialize() ?? null,
      current: this.current
        ? { op: this.current.op, trace: this.current.trace, applied: this.current.applied, startSim: this.current.startSim }
        : null,
      media: this.media.serialize(),
    };
  }

  restore(data: ControllerCheckpoint) {
    this.stage = data.stage;
    this.running = false; // restore pauses; host resumes explicitly
    this.done = data.done;
    this.opCount = data.opCount;
    this.simTime = data.simTime;
    this.nextOpId = data.nextOpId;
    this.planAt = data.planAt;
    this.evalEvery = data.evalEvery;
    this.opsSinceEval = data.opsSinceEval;
    this.finishReason = data.finishReason ?? '';
    this.rng.restore(data.rng);
    this.hand.setCursor(data.handCursor);
    const restored = GraphiteMap.decode(data.map);
    this.map.density.set(restored.density);
    this.map.edits = 1;
    if (this.planner && data.planner) this.planner.restore(data.planner);
    this.current = data.current
      ? { op: data.current.op, trace: data.current.trace, applied: data.current.applied, startSim: data.current.startSim }
      : null;
    if (data.media) this.media.restoreMedia(data.media);
    this.session.simple(this.simTime, 'restore');
    this.emitSnapshot();
    this.callbacks.onDirty?.([{ x: 0, y: 0, w: this.map.width, h: this.map.height }], true);
  }

  /** Evaluation cadence is deliberately independent of playback speed so
   *  that changing speed never changes drawing decisions (spec §11). */
}

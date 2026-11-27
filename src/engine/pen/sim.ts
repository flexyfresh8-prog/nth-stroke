// The V4 simulation orchestrator (spec §4, §14). A fixed-timestep,
// deterministic loop that separates simulation frequency from display rate.
// Every step: brain decisions → hand commands → pen physics → deposition →
// recorder → feedback. The canvas can ONLY change through pen contact here.

import { analyzeEye, type EyeResult } from './eye';
import { Feedback } from './feedback';
import { VirtualHand } from './hand';
import { TILE, VirtualCanvas, type StrokeRecord } from './paper';
import { VirtualPen } from './pen';
import { PenRecorder } from './recorder';
import { Rng } from './rng';
import { VirtualBrain, currentPlanId, setPlanId, type HandApi } from './brain';
import type { Source } from '../structural/source';
import { fit } from '../structural/source';
import {
  instrumentNames,
  stageNames,
  type InstrumentId,
  type LayerId,
  type Quality,
  type SerializedResume,
  type SimOptions,
  type StageIndex,
  type Telemetry,
  type TileUpdate,
} from './types';

export type SimState = 'analyzing' | 'ready' | 'running' | 'paused' | 'done' | 'canceled';

const LAYER_STAGE: Record<LayerId, number> = {
  gesture: 1,
  construction: 2,
  sketch: 3,
  line: 4,
  tone: 5,
  detail: 6,
  erasure: 7,
};

export class Simulation {
  readonly options: SimOptions;
  readonly work: { w: number; h: number };
  readonly nibScale: number;
  readonly pen: VirtualPen;
  readonly paper: VirtualCanvas;
  readonly hand: VirtualHand;
  eye: EyeResult | null = null;
  feedback: Feedback | null = null;
  brain: VirtualBrain | null = null;
  state: SimState = 'analyzing';
  simTime = 0;
  steps = 0;
  strokes = 0;
  lifts = 0;
  quality: Quality | null = null;
  analysisPhase = 'Decoding reference';
  analysisProgress = 0;
  recorder: PenRecorder;

  private plannerRng: Rng;
  private handRng: Rng;
  private dt: number;
  private prevX = 0;
  private prevY = 0;
  private blotPending = 0;
  private sampleCount = 0;
  private pendingTiles = new Set<number>();
  private pressureRing = new Float32Array(480);
  private pressureCount = 0;
  private lastFull = 0;

  constructor(readonly source: Source, options: SimOptions) {
    this.options = options;
    const fitWH = fit(source.w, source.h, options.resolution);
    this.work = fitWH;
    this.nibScale = Math.max(0.55, Math.min(2.4, fitWH.w / 720));
    this.dt = 1 / options.frequency;
    this.pen = new VirtualPen(Math.min(fitWH.w, fitWH.h));
    this.pen.nibScale = this.nibScale;
    this.pen.x = fitWH.w / 2;
    this.pen.y = -fitWH.h * 0.08; // start above the sheet, pen lifted
    this.paper = new VirtualCanvas(fitWH.w, fitWH.h, this.nibScale, options.seed ^ 0x5f3a);
    this.plannerRng = new Rng(options.seed ^ 0x9e3779b9);
    this.handRng = new Rng(options.seed ^ 0x85ebca6b);
    this.hand = new VirtualHand(this.pen, this.handRng, options.motor);
    this.recorder = new PenRecorder(options.maxEvents);
    this.hand.hooks = {
      onStrokeStart: (plan) => {
        this.strokes++;
        this.sampleCount = 0;
        this.paper.beginStroke(plan.layer, LAYER_STAGE[plan.layer], plan.importance);
        this.brain?.onStrokeStart(plan, this.simTime);
      },
      onStrokeEnd: (outcome) => {
        const record = this.paper.endStroke(outcome.plan.instrument);
        this.brain?.onStrokeEnd(outcome.plan, outcome, record, this.simTime);
        // periodic full-quality evaluation at stroke cadence, independent of
        // playback speed (spec §10)
        if (this.strokes - this.lastFull >= 8) {
          this.lastFull = this.strokes;
          this.quality = this.feedback ? this.feedback.full(this.paper) : null;
        }
      },
    };
  }

  // --- analysis -------------------------------------------------------------
  analyze(onProgress?: (phase: string, progress: number) => void) {
    this.analysisPhase = 'Observing the reference';
    this.eye = analyzeEye(this.source, this.options, this.work, (phase, progress) => {
      this.analysisPhase = phase;
      this.analysisProgress = progress;
      onProgress?.(phase, progress);
    });
    this.feedback = new Feedback(this.eye.tonePlane, this.work.w, this.work.h);
    const hand = this.hand;
    const handApi: HandApi = {
      submit: (p) => hand.submit(p),
      submitAll: (ps) => hand.submitAll(ps),
      observe: (pts, dwell) => hand.observe(pts, dwell),
      abort: () => hand.abort(),
      get busy() {
        return hand.busy;
      },
      get phase() {
        return hand.phase;
      },
      get queueLength() {
        return hand.queue.length;
      },
    };
    this.brain = new VirtualBrain(
      {
        eye: this.eye,
        paper: this.paper,
        feedback: this.feedback,
        pen: this.pen,
        options: this.options,
        work: this.work,
      },
      handApi,
      this.plannerRng,
    );
    this.state = 'ready';
    return this.eye;
  }

  start(resume?: SerializedResume) {
    if (this.state === 'ready' || this.state === 'paused' || this.state === 'canceled') {
      if (resume) this.restore(resume);
      else if (this.state === 'ready') this.brain?.enterStage(0);
      this.state = 'running';
    }
  }

  pause() {
    if (this.state === 'running') this.state = 'paused';
  }
  resume() {
    if (this.state === 'paused') this.state = 'running';
  }
  cancel() {
    this.hand.clear();
    this.state = 'canceled';
  }

  // --- the fixed-timestep loop ------------------------------------------------
  step(): void {
    if (this.state !== 'running' || !this.brain) return;
    const dt = this.dt;

    // 1. The brain pumps work only when the hand AND its queue are free —
    //    stages must not advance while queued strokes remain undrawn.
    if (!this.hand.busy && this.hand.queue.length === 0) {
      if (this.brain.done) {
        this.finish();
        return;
      }
      this.brain.pump(this.simTime);
      if (this.brain.done && !this.hand.busy && this.hand.queue.length === 0) {
        this.finish();
        return;
      }
    }

    // 2. Hand → commands.
    this.hand.step(dt, (blot) => {
      this.blotPending = blot;
    });

    // 3. Pen physics.
    this.prevX = this.pen.x;
    this.prevY = this.pen.y;
    this.pen.update(dt);

    // 4. Deposition — ONLY through pen contact. Inputs are float32-quantised
    //    inside paper.deposit so the recorder replay is bit-exact.
    let blotUsed = 0;
    if (this.pen.contact) {
      const moved = Math.hypot(this.pen.x - this.prevX, this.pen.y - this.prevY);
      if (moved > 1e-6 || this.blotPending > 0) {
        blotUsed = this.blotPending;
        // speed is computed from float32-quantised velocity components so the
        // recorder's float32 values reproduce the identical arithmetic
        this.paper.deposit(
          this.prevX,
          this.prevY,
          this.pen.x,
          this.pen.y,
          this.pen.pressure,
          Math.hypot(Math.fround(this.pen.vx), Math.fround(this.pen.vy)),
          this.pen.tilt,
          this.pen.azimuth,
          this.pen.direction,
          this.pen.instrumentId,
          this.blotPending,
        );
        this.blotPending = 0;
      }
      this.sampleCount++;
      // closed-loop mid-stroke interrupt (spec §10)
      if (this.sampleCount % 96 === 0 && this.hand.current && this.feedback) {
        const box: [number, number, number, number] = [
          this.pen.x - 14,
          this.pen.y - 14,
          this.pen.x + 14,
          this.pen.y + 14,
        ];
        const err = this.feedback.boxError(this.paper, box);
        if (this.brain.checkInterrupt(this.hand.current, this.sampleCount, err, this.simTime)) this.hand.abort();
      }
    }

    // 5. Recorder (drains pen events: down/up/instrument + blot flag).
    const events = this.pen.drainEvents();
    if (events.includes('up')) this.lifts++;
    this.recorder.append(this.pen, this.simTime, events, blotUsed);

    // 6. Pressure history for the live graph (~30 Hz at 240 Hz sim).
    if (this.steps % 8 === 0) {
      this.pressureRing[this.pressureCount % this.pressureRing.length] = this.pen.pressure;
      this.pressureCount++;
    }

    this.simTime += dt;
    this.steps++;
  }

  private finish() {
    if (this.feedback) {
      this.feedback.refreshAll(this.paper);
      this.quality = this.feedback.full(this.paper);
    }
    this.state = 'done';
  }

  /** Run up to `steps` steps within a wall-time budget (ms). */
  run(steps: number, budgetMs: number): number {
    if (this.state !== 'running') return 0;
    const t0 = performance.now();
    let n = 0;
    while (n < steps) {
      this.step();
      n++;
      if ((n & 31) === 0 && performance.now() - t0 > budgetMs) break;
    }
    return n;
  }

  // --- incremental tiles ------------------------------------------------------
  collectTiles(max = 220): TileUpdate[] {
    for (const ti of this.paper.takeDirtyTiles()) this.pendingTiles.add(ti);
    const out: TileUpdate[] = [];
    for (const ti of this.pendingTiles) {
      if (out.length >= max) break;
      const rgba = new Uint8ClampedArray(TILE * TILE * 4);
      this.paper.compositeTile(ti, rgba);
      out.push({
        x: (ti % this.paper.cols) * TILE,
        y: ((ti / this.paper.cols) | 0) * TILE,
        w: TILE,
        h: TILE,
        rgba,
      });
      this.pendingTiles.delete(ti);
    }
    return out;
  }

  hasPendingTiles() {
    return this.pendingTiles.size > 0;
  }

  /** Whole-canvas tile list (initial paint / rescale). */
  allTiles(): TileUpdate[] {
    const out: TileUpdate[] = [];
    for (let ti = 0; ti < this.paper.cols * this.paper.rows; ti++) {
      const rgba = new Uint8ClampedArray(TILE * TILE * 4);
      this.paper.compositeTile(ti, rgba);
      out.push({ x: (ti % this.paper.cols) * TILE, y: ((ti / this.paper.cols) | 0) * TILE, w: TILE, h: TILE, rgba });
    }
    return out;
  }

  // --- telemetry ----------------------------------------------------------------
  telemetry(): Telemetry {
    const p = this.pen.telemetry();
    return {
      pose: {
        x: p.x,
        y: p.y,
        z: p.z,
        contact: p.contact,
        down: this.pen.down,
        pressure: p.pressure,
        speed: p.speed,
        direction: p.direction,
        tilt: p.tilt,
        azimuth: p.azimuth,
        instrument: p.instrument,
      },
      stage: this.brain?.stage ?? 0,
      stageLabel: stageNames[this.brain?.stage ?? 0],
      objective: this.brain?.objective ?? this.analysisPhase,
      attention: this.brain?.attention ?? null,
      instrument: this.pen.instrumentId,
      strokes: this.strokes,
      lifts: this.lifts,
      travel: this.pen.travelTotal,
      drawn: this.pen.travelTotal - this.pen.travelAir,
      simTime: this.simTime,
      steps: this.steps,
      quality: this.quality,
      decisions: (this.brain?.decisions ?? []).slice(-40),
      pressureHistory: this.pressureRing,
      pressureCount: this.pressureCount,
      phase: this.hand.phase,
    };
  }

  instrumentName(): string {
    return instrumentNames[this.pen.instrumentId as InstrumentId];
  }

  // --- resumable state ------------------------------------------------------------
  serialize(complete = false): SerializedResume {
    // Flush any in-flight stroke so the registry matches the canvas. The
    // hand finishes lifting on the next steps; the flushed record stands.
    if (this.hand.phase === 'draw') this.hand.abort();
    this.paper.endStroke(this.pen.instrumentId);
    const pending = [...this.hand.queue, ...(this.brain?.pendingPlans() ?? [])];
    return {
      options: this.options,
      stage: this.brain?.stage ?? 0,
      graphite: this.paper.graphite.slice(),
      ink: this.paper.ink.slice(),
      registry: this.paper.registry.map((r) => ({
        instrument: r.instrument,
        layer: r.layer,
        stage: r.stage,
        importance: r.importance,
        opacity: r.alpha,
        pts: r.pts.slice(),
        length: r.length,
      })),
      recorder: this.recorder.count ? this.recorder.serialize() : null,
      rng: [...this.plannerRng.state(), ...this.handRng.state()],
      simTime: this.simTime,
      steps: this.steps,
      strokes: this.strokes,
      lifts: this.lifts,
      travel: this.pen.travelTotal,
      drawn: this.pen.travelTotal - this.pen.travelAir,
      pending,
      planId: currentPlanId(),
      pen: {
        x: this.pen.x,
        y: this.pen.y,
        z: this.pen.z,
        instrument: this.pen.instrumentId,
        travel: this.pen.travelTotal,
        travelAir: this.pen.travelAir,
      },
      brainMemory: this.brain?.serializeMemory() ?? {
        completedContours: [],
        hatchPasses: {},
        detailCursor: 0,
        componentCursor: 0,
        stageEntry: [],
        formShaded: false,
        guidesErased: false,
        correctionRounds: 0,
      },
      complete: complete || this.state === 'done',
    };
  }

  restore(s: SerializedResume) {
    this.simTime = s.simTime;
    this.steps = s.steps;
    this.strokes = s.strokes;
    this.lifts = s.lifts;
    this.paper.graphite.set(s.graphite);
    this.paper.ink.set(s.ink);
    this.paper.registry = s.registry.map((r) => ({
      instrument: r.instrument,
      layer: r.layer,
      stage: r.stage,
      importance: r.importance,
      alpha: r.opacity,
      pts: Float32Array.from(r.pts),
      length: r.length,
    }));
    this.paper.registryPoints = this.paper.registry.reduce((a, r) => a + r.pts.length / 4, 0);
    if (s.recorder && s.recorder.count) this.recorder = PenRecorder.restore(s.recorder, this.options.maxEvents);
    this.plannerRng.setState(s.rng.slice(0, 4));
    this.handRng.setState(s.rng.slice(4, 8));
    setPlanId(s.planId || 1);
    // Re-run analysis deterministically (same source + options), then overlay
    // the saved brain state. The stage queues are replaced by the serialized
    // pending plans, so resumed work continues exactly where it stopped.
    this.analyze();
    this.brain!.stage = Math.min(7, Math.max(0, s.stage)) as StageIndex;
    this.brain!.restoreMemory(s.brainMemory);
    this.brain!.clearQueues();
    this.brain!.objective = 'Resumed session';
    for (const plan of s.pending ?? []) this.hand.submit(plan);
    if (s.complete) {
      this.brain!.markDone('Resumed — complete');
      this.state = 'done';
    }
    this.pen.x = s.pen?.x ?? this.work.w / 2;
    this.pen.y = s.pen?.y ?? this.work.h / 2;
    this.pen.travelTotal = s.pen?.travel ?? s.travel ?? 0;
    this.pen.travelAir = s.pen?.travelAir ?? (s.travel ?? 0) - (s.drawn ?? 0);
    this.pen.penUp();
  }

  strokeRecords(): StrokeRecord[] {
    return this.paper.registry;
  }
}

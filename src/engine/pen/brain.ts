// The V4 Virtual Brain (spec §5): a hierarchical task planner with persistent
// memory that decides where the pen goes, when it lifts, how hard it presses,
// how fast it moves, when to revisit, when to erase and when to stop.
//
// Hierarchy:
//   strategy — the stage machine A…H (human workflow, spec §9)
//   tasks    — per-stage work items (contours, hatch passes, corrections)
//              chosen by structural importance, geometric confidence,
//              reconstruction error and stroke efficiency
//   actions  — concrete stroke plans + observation moves handed to the hand
//
// Every decision is recorded with its mathematical justification for the
// debug channel. The brain never touches the canvas — only the pen does.

import { detailChains, type ContourInfo, type EyeResult } from './eye';
import type { Feedback, Problem } from './feedback';
import type { VirtualCanvas } from './paper';
import type { VirtualPen } from './pen';
import type { Rng } from './rng';
import type { Attention, Decision, LayerId, SimOptions, StageIndex, StrokePlan } from './types';

export interface HandApi {
  submit(plan: StrokePlan): void;
  submitAll(plans: StrokePlan[]): void;
  observe(points: [number, number][], dwell?: number): void;
  abort(): void;
  busy: boolean;
  phase: string;
  queueLength: number;
}

export interface BrainContext {
  eye: EyeResult;
  paper: VirtualCanvas;
  feedback: Feedback;
  pen: VirtualPen;
  options: SimOptions;
  work: { w: number; h: number };
}

const layerOf = (stage: StageIndex): LayerId =>
  stage === 1 ? 'gesture' : stage === 2 ? 'construction' : stage === 3 ? 'sketch' : stage === 4 ? 'line' : stage === 5 ? 'tone' : 'detail';

let planId = 1;
export const currentPlanId = () => planId;
export const setPlanId = (v: number) => {
  planId = Math.max(1, v | 0);
};

export class VirtualBrain {
  stage: StageIndex = 0;
  objective = 'Observing the reference';
  attention: Attention | null = null;
  decisions: Decision[] = [];
  done = false;
  qualityGate = 0;

  // per-stage planning state
  private contourDone: Uint8Array;
  private hatchPasses = new Map<string, number>();
  private componentCursor = 0;
  private detailList: ContourInfo[] | null = null;
  private detailCursor = 0;
  private gestureQueue: StrokePlan[] = [];
  private constructionQueue: StrokePlan[] = [];
  private exploreQueue: StrokePlan[] = [];
  private lineQueue: StrokePlan[] = [];
  private correctionRounds = 0;
  private sinceReassess = 0;
  private stageStrokes: number[] = new Array(8).fill(0);
  private stageStartRegistry = 0;
  private observationT = 0;
  private observing = false;
  private problems: Problem[] = [];
  private pressureAdapt = new Map<string, number>();
  private lastQualitySsim = 0;
  private formShaded = false;
  private guidesErased = false;
  private patchedBoxes = new Map<string, number>();

  constructor(
    private ctx: BrainContext,
    private hand: HandApi,
    private rng: Rng,
  ) {
    this.contourDone = new Uint8Array(ctx.eye.contours.length);
  }

  // --- decision log --------------------------------------------------------
  private decide(action: string, reason: string, t: number) {
    this.decisions.push({ t, stage: this.stage, action, reason });
    if (this.decisions.length > 80) this.decisions.splice(0, this.decisions.length - 80);
  }

  // --- helpers -------------------------------------------------------------
  private get strokes() {
    return this.ctx.paper.registry.length;
  }

  private get stageQuota() {
    const b = this.ctx.options.budget;
    const q = [0.02, 0.05, 0.07, 0.17, 0.26, 0.32, 0.13, 0.04];
    return Math.max(2, Math.round(b * q[this.stage]));
  }

  private speedScale() {
    return Math.max(0.55, this.ctx.work.w / 1024);
  }

  private basePlan(
    pts: Float32Array,
    layer: LayerId,
    o: {
      instrument: StrokePlan['instrument'];
      level: number;
      entry?: number;
      exit?: number;
      attack?: number;
      release?: number;
      speed: number;
      importance: number;
      confidence: number;
      task: string;
      reason: string;
      powerLaw?: number;
      lognormal?: number;
    },
  ): StrokePlan {
    const adapt = this.pressureAdapt.get(o.task.split(' ')[0]) ?? 1;
    return {
      id: planId++,
      pts,
      baseSpeed: Math.max(14, o.speed * this.speedScale()),
      powerLaw: o.powerLaw ?? 0.8,
      lognormal: o.lognormal ?? 0.55,
      pressure: {
        entry: o.entry ?? o.level * 0.7,
        level: Math.max(0.03, Math.min(0.97, o.level * adapt * (0.72 + 0.28 * this.ctx.options.pressure))),
        exit: o.exit ?? o.level * 0.55,
        attack: o.attack ?? 0.16,
        release: o.release ?? 0.22,
      },
      instrument: o.instrument,
      layer,
      importance: o.importance,
      confidence: o.confidence,
      nib: 1,
      task: o.task,
      reason: o.reason,
    };
  }

  // --- stage entry ---------------------------------------------------------
  enterStage(t: number) {
    const { eye, options } = this.ctx;
    this.stageStartRegistry = this.strokes;
    switch (this.stage) {
      case 0: {
        // A — Observation: the pen stays lifted while the eye scans.
        this.objective = 'Observing the composition';
        this.decide('observe', `subject ${Math.round(eye.coverage * 100)}% of frame; axes ${(eye.axes.major * 180) / Math.PI}°; ${eye.attention.points.length} attention foci; light from ${((Math.atan2(eye.light.dy, eye.light.dx) * 180) / Math.PI).toFixed(0)}°`, t);
        this.decide('observe', eye.symmetry.score > 0.7 ? `symmetry detected (score ${eye.symmetry.score.toFixed(2)}, axis ${(eye.symmetry.angle * 180) / Math.PI}°) — construction will mirror` : 'no dominant symmetry — free construction', t);
        this.hand.observe(eye.attention.points.map((p) => [p[0], p[1]]), 0.32);
        this.observationT = t;
        this.observing = true;
        this.attention = { x: eye.work.w * 0.25, y: eye.work.h * 0.25, w: eye.work.w * 0.5, h: eye.work.h * 0.5 };
        break;
      }
      case 1: {
        // B — Gesture: long, light strokes for movement and composition.
        this.objective = 'Gesture: movement and placement';
        this.buildGesture(t);
        break;
      }
      case 2: {
        // C — Structural construction (temporary scaffold).
        this.objective = 'Constructing underlying geometry';
        this.buildConstruction(t);
        break;
      }
      case 3: {
        // D — Exploratory sketch.
        this.objective = 'Exploring important forms';
        this.buildExploratory(t);
        break;
      }
      case 4: {
        // E — Confident linework.
        this.objective = 'Committing confident contours';
        this.buildLinework(t);
        break;
      }
      case 5: {
        // F — Shading.
        this.objective = 'Developing tonal values';
        this.componentCursor = 0;
        this.ctx.feedback.refreshAll(this.ctx.paper);
        this.lastQualitySsim = this.ctx.feedback.full(this.ctx.paper).ssim;
        this.decide('stage', `shading begins: ${this.ctx.eye.zones.components.length} tonal components, SSIM ${this.lastQualitySsim.toFixed(3)}`, t);
        break;
      }
      case 6: {
        // G — Detail refinement.
        this.objective = 'Refining fine details';
        if (!this.detailList) this.detailList = [];
        this.ctx.feedback.refreshAll(this.ctx.paper);
        this.problems = this.ctx.feedback.problems(this.ctx.eye.attention.at, 12);
        this.decide('stage', `detail pass: ${this.problems.length} ranked problems, detail knob ${options.detail.toFixed(2)}`, t);
        break;
      }
      case 7: {
        // H — Correction.
        this.objective = 'Inspecting and correcting';
        this.correctionRounds = 0;
        this.ctx.feedback.refreshAll(this.ctx.paper);
        break;
      }
    }
  }

  // --- stage work builders ---------------------------------------------------
  private buildGesture(t: number) {
    const { eye, options, work } = this.ctx;
    const q: StrokePlan[] = [];
    const n = Math.max(3, Math.round((5 + 13 * options.gesture) * (eye.gesture.axisStrokes.length + eye.gesture.envelopes.length ? 1 : 0.5)));
    this.decide('gesture', `${n} gesture strokes from PCA axes (λ-ratio spread ${eye.axes.spread.toFixed(0)}px) and medial flow`, t);
    const sources: Float32Array[] = [];
    // axis strokes through the subject
    if (eye.gesture.axisStrokes.length) sources.push(...eye.gesture.axisStrokes);
    // longest medial branches as flow lines
    for (const b of eye.skeleton.slice(0, 3)) sources.push(b.pts);
    // silhouette envelopes
    for (const e of eye.gesture.envelopes.slice(0, 2)) sources.push(e);
    for (let i = 0; i < sources.length && q.length < n; i++) {
      const pts = extendEnds(sources[i], work.w * 0.012, work.w * 0.014);
      q.push(
        this.basePlan(pts, 'gesture', {
          instrument: 'graphite',
          level: 0.13 + this.rng.sym(0.02),
          entry: 0.09,
          exit: 0.06,
          attack: 0.2,
          release: 0.34,
          speed: 250 + this.rng.range(0, 90),
          importance: 400 - i * 20,
          confidence: 0.5,
          task: 'gesture',
          reason: `long axis stroke ${i + 1}: PCA direction ${(eye.axes.major * 180) / Math.PI}°, light pressure 0.13, overshoot 1.3%`,
          lognormal: 0.7,
          powerLaw: 0.5,
        }),
      );
    }
    this.gestureQueue = q;
  }

  private buildConstruction(t: number) {
    const { eye, options, work } = this.ctx;
    const q: StrokePlan[] = [];
    const k = options.construction;
    if (k < 0.12) {
      this.decide('construct', 'construction skipped (knob < 0.12) — clean-line workflow', t);
      this.constructionQueue = q;
      return;
    }
    // 1. envelope ellipses / silhouettes
    for (const e of eye.gesture.envelopes.slice(0, 3)) {
      q.push(
        this.basePlan(e, 'construction', {
          instrument: 'mechanical',
          level: 0.12 + 0.05 * k,
          speed: 150,
          importance: 300,
          confidence: 0.6,
          task: 'construct',
          reason: 'envelope ellipse fitted to silhouette (medial chord fit)',
        }),
      );
    }
    // 2. ellipses at medial branch clusters (skeleton nodes)
    const nodes = medialNodes(eye);
    for (const node of nodes.slice(0, 5)) {
      const pts = ellipsePts(node.x, node.y, node.rx, node.ry, node.angle, Math.max(14, Math.round(node.rx / 2.2)));
      q.push(
        this.basePlan(pts, 'construction', {
          instrument: 'mechanical',
          level: 0.11 + 0.05 * k,
          speed: 140,
          importance: 260,
          confidence: 0.55,
          task: 'construct',
          reason: `medial ellipse r=${node.rx.toFixed(0)}×${node.ry.toFixed(0)}px at node (${node.x.toFixed(0)}, ${node.y.toFixed(0)})`,
        }),
      );
    }
    // 3. proportion ticks on the subject bounds
    const box = subjectBounds(eye, work);
    const tick = work.w * 0.016;
    for (let i = 1; i <= 2; i++) {
      const x = box[0] + ((box[2] - box[0]) * i) / 3;
      q.push(this.basePlan(new Float32Array([x, box[1] - tick, x, box[1] - tick * 0.25]), 'construction', { instrument: 'mechanical', level: 0.1 + 0.04 * k, speed: 90, importance: 90, confidence: 0.9, task: 'construct', reason: `proportion tick at ${((i / 3) * 100) | 0}% width` }));
      const y = box[1] + ((box[3] - box[1]) * i) / 3;
      q.push(this.basePlan(new Float32Array([box[0] - tick, y, box[0] - tick * 0.25, y]), 'construction', { instrument: 'mechanical', level: 0.1 + 0.04 * k, speed: 90, importance: 90, confidence: 0.9, task: 'construct', reason: `proportion tick at ${((i / 3) * 100) | 0}% height` }));
    }
    // 4. symmetry echo
    if (eye.symmetry.score > 0.7) {
      const a = eye.symmetry.angle;
      const cx = eye.axes.cx,
        cy = eye.axes.cy,
        r = eye.axes.spread * 1.1;
      q.push(
        this.basePlan(new Float32Array([cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r]), 'construction', {
          instrument: 'mechanical',
          level: 0.1,
          speed: 170,
          importance: 120,
          confidence: 0.8,
          task: 'construct',
          reason: `symmetry axis at ${(a * 180) / Math.PI}° (mirror match ${(eye.symmetry.score * 100) | 0}%)`,
        }),
      );
    }
    this.decide('construct', `${q.length} construction guides: envelope, medial ellipses, proportion ticks${eye.symmetry.score > 0.7 ? ', symmetry axis' : ''}`, t);
    this.constructionQueue = q;
  }

  private buildExploratory(t: number) {
    const { eye } = this.ctx;
    const q: StrokePlan[] = [];
    const contours = eye.contours;
    let taken = 0;
    const limit = Math.min(contours.length, Math.max(8, Math.round(this.stageQuota * 0.85)));
    for (let i = 0; i < contours.length && taken < limit; i++) {
      if (this.contourDone[i]) continue;
      const c = contours[i];
      const parts = c.confidence < 0.55 ? splitPath(c.pts, 2 + (this.rng.next() < 0.4 ? 1 : 0)) : [c.pts];
      for (let p = 0; p < parts.length; p++) {
        const pts = maybeReverse(parts[p], this.ctx.pen);
        q.push(
          this.basePlan(pts, 'sketch', {
            instrument: 'graphite',
            level: 0.2 + 0.1 * c.confidence + this.rng.sym(0.025),
            entry: 0.14,
            exit: 0.1,
            attack: 0.22,
            release: 0.34,
            speed: 130 + this.rng.range(0, 40),
            importance: c.importance,
            confidence: c.confidence,
            task: 'explore',
            reason: `exploratory pass on contour ${i} (${p + 1}/${parts.length}): confidence ${c.confidence.toFixed(2)} ${c.confidence < 0.55 ? '— segmented for searching' : ''}`,
            lognormal: 0.75,
          }),
        );
      }
      // searching double-pass on uncertain forms
      if (c.confidence < 0.45 && this.rng.next() < 0.6) {
        q.push(
          this.basePlan(offsetNormal(c.pts, 1.1), 'sketch', {
            instrument: 'graphite',
            level: 0.15,
            speed: 120,
            importance: c.importance * 0.7,
            confidence: c.confidence,
            task: 'explore',
            reason: `searching second pass beside contour ${i} (+1.1px offset, lighter)`,
          }),
        );
      }
      this.contourDone[i] = 1;
      taken++;
    }
    this.decide('explore', `${taken} forms explored (${limit} planned); uncertain contours segmented and re-passed`, t);
    this.exploreQueue = q;
  }

  private buildLinework(t: number) {
    const { eye, options } = this.ctx;
    const q: StrokePlan[] = [];
    const tool = options.lineworkTool;
    const contours = eye.contours;
    const limit = Math.min(contours.length, Math.max(6, this.stageQuota));
    for (let i = 0; i < limit; i++) {
      const c = contours[i];
      const imp = Math.min(1, c.importance / 260);
      const pts = maybeReverse(c.pts, this.ctx.pen);
      q.push(
        this.basePlan(pts, 'line', {
          instrument: tool,
          level: 0.34 + 0.4 * imp,
          entry: 0.2 + 0.12 * imp,
          exit: 0.14 + 0.1 * imp,
          attack: 0.12,
          release: 0.16,
          speed: 120 + 30 * c.confidence,
          importance: c.importance,
          confidence: c.confidence,
          task: 'line',
          reason: `committed contour ${i}: importance ${c.importance.toFixed(0)} → pressure ${((0.34 + 0.4 * imp) * 100) | 0}%, ${tool} nib`,
          powerLaw: 0.95,
          lognormal: 0.45,
        }),
      );
    }
    this.decide('line', `${q.length} contour commitments with ${tool}; pressure scales with importance (0.34 + 0.4·imp)`, t);
    this.lineQueue = q;
  }

  // --- shading (stage F): closed-loop per component -------------------------
  /** Work-space box of a zone component. */
  private componentBox(comp: { box: [number, number, number, number] }): [number, number, number, number] {
    const { plane } = this.ctx.eye.zones;
    const kx = this.ctx.work.w / plane.w,
      ky = this.ctx.work.h / plane.h;
    return [comp.box[0] * kx, comp.box[1] * ky, comp.box[2] * kx, comp.box[3] * ky];
  }

  /** Signed mean deficit (ref − drawn) over the component's OWN zone pixels —
   * the hatched region, not the bounding box that also contains highlights. */
  private measureComponent(comp: { zone: number; box: [number, number, number, number] }): number {
    const { eye, paper } = this.ctx;
    const { plane } = eye.zones;
    const kx = eye.work.w / plane.w,
      ky = eye.work.h / plane.h;
    const wx0 = comp.box[0] * kx,
      wy0 = comp.box[1] * ky,
      wx1 = comp.box[2] * kx,
      wy1 = comp.box[3] * ky;
    const stepX = Math.max(1.5, (wx1 - wx0) / 26),
      stepY = Math.max(1.5, (wy1 - wy0) / 26);
    // Median (not mean): committed contour lines run through shading regions
    // and must not fool the artist into thinking a zone is already dark.
    const samples: number[] = [];
    for (let y = wy0; y < wy1; y += stepY)
      for (let x = wx0; x < wx1; x += stepX) {
        if (x >= paper.w || y >= paper.h) continue;
        const z = eye.zones.zoneAt(x, y);
        const ok = comp.zone === 0 ? z === 0 && eye.subjectAt(x, y) : z >= comp.zone;
        if (!ok) continue;
        const rx = Math.min(plane.w - 1, ((x / paper.w) * plane.w) | 0),
          ry = Math.min(plane.h - 1, ((y / paper.h) * plane.h) | 0);
        // positive deficit = drawn too LIGHT = needs more graphite
        samples.push(paper.tone(x, y) - plane.gray[ry * plane.w + rx]);
      }
    if (!samples.length) return 0;
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];
  }

  private hatchComponent(idx: number, t: number): StrokePlan[] {
    const { eye, paper } = this.ctx;
    const comp = eye.zones.components[idx];
    if (!comp) return [];
    const key = `${comp.zone}:${idx}`;
    const pass = this.hatchPasses.get(key) ?? 0;
    const isFlat = comp.zone > 0 && regionFlatness(eye, comp) < 0.055;
    const maxPass = comp.zone === 0 ? 4 : isFlat ? 7 : 4;
    if (pass >= maxPass) return [];
    // measure the component's own region as it exists on the canvas
    const deficit = this.measureComponent(comp);
    // zone 0 only veils genuinely toned areas — near-white paper stays clean
    if (deficit < (comp.zone === 0 ? 20 : 8)) return []; // already matches
    const { plane } = eye.zones;
    const kx = eye.work.w / plane.w;
    // Direction: FLAT areas (graphic tones, walls, skies) get the classic
    // uniform 45°/135° manga hatching; FORMED areas (gradient volume) follow
    // the structure tensor or run across the light gradient.
    const wx = (comp.cx + 0.5) * kx,
      wy = (comp.cy + 0.5) * (eye.work.h / plane.h);
    const ori = eye.orientationAt(wx, wy);
    const perpLight = Math.atan2(eye.light.dy, eye.light.dx) + Math.PI / 2;
    const theta = isFlat ? Math.PI / 4 : ori.coherence > 0.42 ? ori.theta : perpLight;
    const angle = isFlat ? theta + (pass % 2) * (Math.PI / 2) : theta + [0, 1.35, 0.7, 2.1, 1.05][pass % 5];
    const d = Math.max(8, deficit);
    const level = comp.zone === 0 ? Math.max(0.12, Math.min(0.35, 0.14 + (d / 255) * 0.9)) : Math.max(0.15, Math.min(0.68, 0.2 + (d / 255) * 1.15));
    // Spacing targets ~55% of the remaining deficit per pass (calibrated:
    // one pass deposits ≈ 1.1·level of mean density at unit spacing), so the
    // loop converges in a few measured passes instead of crawling.
    const spacing = comp.zone === 0 ? Math.max(3.2, Math.min(13, (1.1 * level) / Math.max(0.02, (d / 250) * 0.55))) : Math.max(2.2, Math.min(14, (1.1 * level) / Math.max(0.02, (d / 250) * 0.55)));
    const finalSpacing = spacing * (0.85 + 0.3 * (1 - this.ctx.options.hatch));
    const instrument = comp.zone >= 6 && pass >= 1 ? 'charcoal' : 'graphite';
    const segs = hatchSegments(eye, comp, angle, finalSpacing / kx, 5).slice(0, 48);
    const q: StrokePlan[] = [];
    for (const seg of segs) {
      q.push(
        this.basePlan(seg, 'tone', {
          instrument,
          level,
          entry: level * 0.6,
          exit: level * 0.5,
          attack: 0.3,
          release: 0.42,
          speed: 165,
          importance: 80 + comp.area * 0.4,
          confidence: 0.75,
          task: `hatch z${comp.zone}`,
          reason: `hatch pass ${pass + 1} zone ${comp.zone}: deficit ${deficit.toFixed(0)}/255 → pressure ${level.toFixed(2)}, spacing ${finalSpacing.toFixed(1)}px, θ=${((angle * 180) / Math.PI) | 0}° ${pass > 0 ? '(cross-hatch)' : ''} ${isFlat ? 'flat tone, uniform angle' : ori.coherence > 0.42 ? 'following structure tensor' : 'across light gradient'}`,
          powerLaw: 0.3,
          lognormal: 0.35,
        }),
      );
    }
    this.hatchPasses.set(key, pass + 1);
    if (q.length)
      this.decide(
        'hatch',
        `zone ${comp.zone} component ${idx} pass ${pass + 1}: deficit ${deficit.toFixed(0)}/255 over its own region, ${q.length} strokes at ${finalSpacing.toFixed(1)}px — re-measure after the pass`,
        t,
      );
    return q;
  }

  private contourShading(t: number): StrokePlan[] {
    // form-following strokes just inside the strongest closed contours
    const { eye } = this.ctx;
    const q: StrokePlan[] = [];
    const closed = eye.contours.filter((c) => c.closed).slice(0, 8);
    for (const c of closed) {
      if (c.importance < 90) continue;
      for (const off of [2.6, 5.4]) {
        const pts = offsetInward(c.pts, eye, off);
        if (pts.length >= 8) {
          q.push(
            this.basePlan(pts, 'tone', {
              instrument: 'graphite',
              level: 0.3 - off * 0.02,
              attack: 0.34,
              release: 0.5,
              speed: 120,
              importance: c.importance * 0.5,
              confidence: 0.7,
              task: 'formshade',
              reason: `contour-following shading at ${off}px inside a major form (distance-transform offset)`,
              powerLaw: 0.9,
            }),
          );
        }
      }
    }
    if (q.length) this.decide('formshade', `${q.length} form-following strokes hugging major contours`, t);
    return q;
  }

  // --- detail (stage G) -------------------------------------------------------
  private detailWork(t: number): StrokePlan[] {
    const { eye, paper, feedback, options } = this.ctx;
    const q: StrokePlan[] = [];
    // refresh the problem list each pump: cells update cheaply, and stale
    // hotspots would otherwise be re-patched forever
    feedback.refreshAll(paper);
    this.problems = feedback.problems(eye.attention.at, 12);
    if (!this.detailList) this.detailList = [];
    if (this.detailList.length === 0 && this.detailCursor === 0 && options.detail > 0.05) {
      // lazily pull higher-scale chains once
      const chains = eyeDetail(this.ctx, options);
      this.detailList = chains;
      this.decide('detail', `pulled ${chains.length} high-scale edge chains (≤${Math.round(Math.min(1024, this.ctx.work.w * 1.2))}px analysis)`, t);
    }
    // first: edge-deficit problems; then unseen detail chains
    for (const p of this.problems.filter((p) => p.kind === 'edge').slice(0, 4)) {
      const segs = chainsInBox(this.detailList, p.box, 3);
      for (const seg of segs) {
        q.push(
          this.basePlan(maybeReverse(seg, this.ctx.pen), 'detail', {
            instrument: 'mechanical',
            level: 0.3,
            speed: 95,
            importance: 100 + p.err * 30,
            confidence: 0.75,
            task: 'detail',
            reason: `edge deficit ${(p.err * 100).toFixed(0)} at (${p.box[0].toFixed(0)}, ${p.box[1].toFixed(0)}): redrawing chain segment`,
          }),
        );
      }
    }
    const limit = Math.max(4, Math.round(this.stageQuota * 0.7));
    let added = 0;
    while (this.detailCursor < this.detailList.length && added < limit && q.length < 64) {
      const c = this.detailList[this.detailCursor++];
      if (c.importance < 6 + 30 * (1 - options.detail)) continue;
      q.push(
        this.basePlan(maybeReverse(c.pts, this.ctx.pen), 'detail', {
          instrument: 'mechanical',
          level: 0.26,
          speed: 90,
          importance: c.importance,
          confidence: 0.7,
          task: 'detail',
          reason: `fine chain ${this.detailCursor}: length ${c.importance.toFixed(0)}px at high analysis scale`,
        }),
      );
      added++;
    }
    // tone-deficit patches — bounded repeats per hotspot, spacing scales
    // with the box so large areas receive open hatching, not black fill
    for (const p of this.problems.filter((p) => p.kind === 'missing').slice(0, 3)) {
      const key = patchKey(p.box);
      const visits = this.patchedBoxes.get(key) ?? 0;
      if (visits >= 2) continue;
      const deficit = feedback.boxError(paper, p.box).signed;
      if (deficit < 12) continue;
      const area = (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
      const spacing = Math.max(4.5, Math.min(10, Math.sqrt(area) / 14));
      const level = Math.max(0.12, Math.min(0.5, (deficit / 255) * 1.3));
      const segs = patchHatch(this.ctx, p.box, spacing);
      this.patchedBoxes.set(key, visits + 1);
      for (const seg of segs)
        q.push(
          this.basePlan(seg, 'detail', {
            instrument: 'graphite',
            level,
            speed: 130,
            importance: 60 + p.err * 20,
            confidence: 0.65,
            task: 'detail',
            reason: `missing tone: deficit ${deficit.toFixed(0)}/255 → hatch at pressure ${level.toFixed(2)}, spacing ${spacing.toFixed(1)}px (${visits + 1}/2)`,
          }),
        );
    }
    return q;
  }

  // --- correction (stage H) ---------------------------------------------------
  private correctionWork(t: number): StrokePlan[] {
    const { paper, feedback, eye } = this.ctx;
    const q: StrokePlan[] = [];
    // 1. erase the scaffold (gesture + construction) with physical passes
    const guides = this.guidesErased ? [] : paper.registry.filter((r) => r.layer === 'construction' || r.layer === 'gesture');
    if (guides.length) {
      this.guidesErased = true;
      for (const g of guides) {
        const path = new Float32Array(g.pts.length / 2);
        for (let i = 0, j = 0; i < g.pts.length; i += 4, j += 2) {
          path[j] = g.pts[i];
          path[j + 1] = g.pts[i + 1];
        }
        q.push(
          this.basePlan(path, 'erasure', {
            instrument: 'eraser',
            level: 0.55,
            speed: 240,
            importance: 10,
            confidence: 1,
            task: 'erase',
            reason: `erasing construction guide (${(g.pts.length / 4) | 0} pts) — scaffold removal`,
            powerLaw: 0.1,
          }),
        );
      }
      this.decide('erase', `${guides.length} scaffold strokes (gesture + construction) scheduled for physical erasure`, t);
      return q;
    }
    // 2. problem-driven corrections — cells are ALWAYS refreshed first so
    //    patches respond to the canvas as it exists now, never to ghosts
    feedback.refreshAll(paper);
    this.problems = feedback.problems(eye.attention.at, 8);
    let fixes = 0;
    for (const p of this.problems) {
      if (p.err < 0.32) continue;
      const key = patchKey(p.box);
      const visits = this.patchedBoxes.get(key) ?? 0;
      if (visits >= 2) continue;
      if (p.kind === 'excess') {
        this.patchedBoxes.set(key, visits + 1);
        q.push(
          this.basePlan(eraserSweep(p.box, Math.max(7, 5.5 * this.ctx.paper.nibScale)), 'erasure', {
            instrument: 'eraser',
            level: 0.35 + Math.min(0.3, p.err * 0.25),
            speed: 250,
            importance: 40,
            confidence: 1,
            task: 'erase',
            reason: `excess tone (score ${(p.err * 100) | 0}): gentle eraser sweep over ${(p.box[2] - p.box[0]).toFixed(0)}×${(p.box[3] - p.box[1]).toFixed(0)}px`,
            powerLaw: 0.1,
          }),
        );
      } else {
        // conservative deficit-driven shading: cover about half the measured
        // tone deficit per visit, then re-measure
        const deficit = feedback.boxError(paper, p.box).signed;
        if (deficit < 12) continue;
        this.patchedBoxes.set(key, visits + 1);
        const level = Math.max(0.12, Math.min(0.5, (deficit / 255) * 1.3));
        const area = (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
        const spacing = Math.max(4.5, Math.min(10, Math.sqrt(area) / 14));
        for (const seg of patchHatch(this.ctx, p.box, spacing))
          q.push(
            this.basePlan(seg, 'tone', {
              instrument: 'graphite',
              level,
              speed: 140,
              importance: 50,
              confidence: 0.7,
              task: 'correct',
              reason: `missing tone: deficit ${deficit.toFixed(0)}/255 → hatch at pressure ${level.toFixed(2)}, spacing ${spacing.toFixed(1)}px (${visits + 1}/2)`,
            }),
          );
      }
      if (++fixes >= 4) break;
    }
    if (q.length) this.decide('correct', `correction round ${this.correctionRounds + 1}: ${q.length} localized fixes from ranked problems`, t);
    return q;
  }

  // --- main pump (called when the hand is idle) -------------------------------
  pump(t: number): void {
    if (this.done) return;
    const { paper, options } = this.ctx;
    if (this.strokes >= options.budget) {
      this.finish('stroke budget reached', t);
      return;
    }
    // periodic global reassessment (spec §11)
    if (this.sinceReassess >= 34 && this.stage >= 3 && this.stage <= 6) {
      this.sinceReassess = 0;
      this.ctx.feedback.refreshAll(paper);
      this.problems = this.ctx.feedback.problems(this.ctx.eye.attention.at, 10);
      if (this.problems.length) {
        this.decide('reassess', `global reassessment: ${this.problems.length} hot regions (worst err ${(this.problems[0].err * 100).toFixed(0)}, kind ${this.problems[0].kind})`, t);
      }
    }
    switch (this.stage) {
      case 0:
        if (this.observing) {
          if (!this.hand.busy) {
            this.observing = false;
            this.advance(t);
          }
          break;
        }
        this.advance(t);
        break;
      case 1:
        this.feedQueue(this.gestureQueue, t);
        break;
      case 2:
        this.feedQueue(this.constructionQueue, t);
        break;
      case 3:
        this.feedQueue(this.exploreQueue, t);
        break;
      case 4:
        this.feedQueue(this.lineQueue, t);
        break;
      case 5: {
        if (!this.formShaded) {
          // form-following strokes first, then closed-loop zone hatching
          this.formShaded = true;
          const q = this.contourShading(t);
          if (q.length) {
            this.hand.submitAll(q);
            break;
          }
        }
        const comps = this.ctx.eye.zones.components;
        // leave budget for detail and correction: shading is the biggest
        // consumer, but an artist never spends the whole session on tone
        if (this.strokes - this.stageStartRegistry > Math.max(12, this.ctx.options.budget * 0.55)) {
          this.decide('stage', 'shading budget share reached — moving to detail while tone is fresh', t);
          this.advance(t);
          break;
        }
        while (this.componentCursor < comps.length) {
          const idx = this.componentCursor;
          const q = this.hatchComponent(idx, t);
          if (q.length) {
            this.hand.submitAll(q);
            const b = this.componentBox(comps[idx]);
            this.attention = { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
            break; // wait for the pass, then re-measure this component
          }
          this.componentCursor++; // matched or exhausted — next component
        }
        if (this.componentCursor >= comps.length) this.advance(t);
        break;
      }
      case 6: {
        const q = this.detailWork(t);
        if (q.length) {
          this.hand.submitAll(q);
          break;
        }
        this.advance(t);
        break;
      }
      case 7: {
        const q = this.correctionWork(t);
        if (q.length) {
          this.correctionRounds++;
          this.hand.submitAll(q);
          break;
        }
        // nothing correctable remains — final inspection, then accept
        this.ctx.feedback.refreshAll(paper);
        const quality = this.ctx.feedback.full(paper);
        this.finish(
          `artwork accepted after ${this.correctionRounds} correction rounds: SSIM ${quality.ssim.toFixed(3)}, missing ${(quality.missing * 100).toFixed(1)}%, excess ${(quality.excess * 100).toFixed(1)}%`,
          t,
        );
        break;
      }
    }
  }

  private feedQueue(queue: StrokePlan[], t: number) {
    if (queue.length) {
      // hand pulls from its own queue; top it up a batch at a time
      const batch = queue.splice(0, 24);
      this.hand.submitAll(batch);
      this.sinceReassess += batch.length;
      this.attention = planAttention(batch[0], this.ctx.work);
      return;
    }
    // stage budget guard
    if (this.strokes - this.stageStartRegistry >= this.stageQuota && this.stage < 7) {
      this.decide('stage', `stage quota reached (${this.stageQuota} strokes) before natural exhaustion`, t);
      this.advance(t);
      return;
    }
    this.advance(t);
  }

  private advance(t: number) {
    if (this.stage >= 7) {
      this.finish('workflow complete', t);
      return;
    }
    this.stage = (this.stage + 1) as StageIndex;
    this.decide('stage', `entering ${['A Observation', 'B Gesture', 'C Construction', 'D Exploratory', 'E Linework', 'F Shading', 'G Detail', 'H Correction'][this.stage]}`, t);
    this.enterStage(t);
    // immediately produce work for the new stage
    this.pump(t);
  }

  private finish(reason: string, t: number) {
    if (this.done) return;
    this.done = true;
    this.objective = 'Finished';
    this.decide('finish', reason, t);
  }

  // --- closed-loop reactions (called by the sim) ------------------------------
  onStrokeStart(plan: StrokePlan, t: number) {
    this.stageStrokes[this.stage]++;
    this.objective = objectiveFor(plan);
    this.attention = planAttention(plan, this.ctx.work);
  }

  onStrokeEnd(plan: StrokePlan, outcome: { drawn: number; meanPressure: number; maxDeviation: number; aborted: boolean }, record: { pts: Float32Array } | null, t: number) {
    const { paper, feedback } = this.ctx;
    if (!record || !record.pts.length) return;
    const box = boundsOf(record.pts);
    const after = feedback.boxError(paper, box);
    // pressure adaptation per task family (spec §10 feedback → pressure)
    const family = plan.task.split(' ')[0];
    if (after.excess > 0.22 && plan.instrument !== 'eraser') {
      const cur = this.pressureAdapt.get(family) ?? 1;
      this.pressureAdapt.set(family, Math.max(0.6, cur * 0.92));
      this.decide('adapt', `${family}: excess ${(after.excess * 100) | 0}% after stroke — pressure scale ×0.92 → ${(Math.max(0.6, cur * 0.92) * 100) | 0}%`, t);
    } else if (after.missing > 0.4 && plan.layer === 'tone') {
      const cur = this.pressureAdapt.get(family) ?? 1;
      this.pressureAdapt.set(family, Math.min(1.3, cur * 1.05));
    }
    if (outcome.aborted) this.decide('interrupt', `stroke ${plan.id} aborted at ${outcome.drawn.toFixed(0)}px (controller interrupt)`, t);
  }

  /** Mid-stroke interrupt check (spec §10). Returns true to abort. */
  checkInterrupt(plan: StrokePlan, sampleCount: number, errNow: { err: number }, t: number): boolean {
    // Interrupts apply to committed contour work, where a drifting line is
    // actively harmful; tone building large deficits is the shading stage's
    // job, not a mistake.
    if (plan.layer !== 'line' && plan.layer !== 'sketch') return false;
    if (sampleCount < 128 || sampleCount % 128 !== 0) return false;
    if (errNow.err > 64) {
      this.decide('interrupt', `interrupting stroke ${plan.id}: local error ${errNow.err.toFixed(1)} > 64 after ${sampleCount} samples — contour is drifting`, t);
      return true;
    }
    return false;
  }

  serializeMemory() {
    const completed: number[] = [];
    this.contourDone.forEach((v, i) => v && completed.push(i));
    return {
      completedContours: completed,
      hatchPasses: Object.fromEntries(this.hatchPasses),
      detailCursor: this.detailCursor,
      componentCursor: this.componentCursor,
      stageEntry: this.stageStrokes,
      formShaded: this.formShaded,
      guidesErased: this.guidesErased,
      correctionRounds: this.correctionRounds,
    };
  }

  restoreMemory(m: {
    completedContours?: number[];
    hatchPasses?: Record<string, number>;
    detailCursor?: number;
    componentCursor?: number;
    stageEntry?: number[];
    formShaded?: boolean;
    guidesErased?: boolean;
    correctionRounds?: number;
  }) {
    for (const i of m.completedContours ?? []) if (i < this.contourDone.length) this.contourDone[i] = 1;
    for (const [k, v] of Object.entries(m.hatchPasses ?? {})) this.hatchPasses.set(k, v);
    this.detailCursor = m.detailCursor ?? 0;
    this.componentCursor = m.componentCursor ?? 0;
    if (m.stageEntry) this.stageStrokes = m.stageEntry.slice();
    this.formShaded = m.formShaded ?? false;
    this.guidesErased = m.guidesErased ?? false;
    this.correctionRounds = m.correctionRounds ?? 0;
  }

  /** Remaining stage work + hand queue, in execution order (for resume). */
  pendingPlans(): StrokePlan[] {
    const stageQueue =
      this.stage === 1 ? this.gestureQueue : this.stage === 2 ? this.constructionQueue : this.stage === 3 ? this.exploreQueue : this.stage === 4 ? this.lineQueue : [];
    return stageQueue.slice();
  }

  /** Drop every stage queue (restored sessions supply pending plans directly). */
  clearQueues() {
    this.gestureQueue.length = 0;
    this.constructionQueue.length = 0;
    this.exploreQueue.length = 0;
    this.lineQueue.length = 0;
  }

  markDone(objective = 'Finished') {
    this.done = true;
    this.objective = objective;
  }
}

// --- geometry helpers ---------------------------------------------------------

function boundsOf(pts: Float32Array): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return [x0, y0, x1, y1];
}

function extendEnds(pts: Float32Array, a: number, b: number): Float32Array {
  const n = pts.length / 2;
  if (n < 2) return pts;
  const out = pts.slice();
  const d0x = pts[2] - pts[0],
    d0y = pts[3] - pts[1];
  const l0 = Math.hypot(d0x, d0y) || 1;
  out[0] = pts[0] - (d0x / l0) * a;
  out[1] = pts[1] - (d0y / l0) * a;
  const lx = pts[2 * n - 2],
    ly = pts[2 * n - 1],
    px = pts[2 * n - 4],
    py = pts[2 * n - 3];
  const l1 = Math.hypot(lx - px, ly - py) || 1;
  out[2 * n - 2] = lx + ((lx - px) / l1) * b;
  out[2 * n - 1] = ly + ((ly - py) / l1) * b;
  return out;
}

function maybeReverse(pts: Float32Array, pen: { x: number; y: number }): Float32Array {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const dStart = Math.hypot(pts[0] - pen.x, pts[1] - pen.y);
  const dEnd = Math.hypot(pts[2 * n - 2] - pen.x, pts[2 * n - 1] - pen.y);
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  if (dEnd + len * 0.35 < dStart) {
    const out = new Float32Array(pts.length);
    for (let i = 0; i < n; i++) {
      out[2 * i] = pts[2 * (n - 1 - i)];
      out[2 * i + 1] = pts[2 * (n - 1 - i) + 1];
    }
    return out;
  }
  return pts;
}

function splitPath(pts: Float32Array, parts: number): Float32Array[] {
  const n = pts.length / 2;
  if (n < 6 || parts <= 1) return [pts];
  const out: Float32Array[] = [];
  const per = Math.floor(n / parts);
  for (let p = 0; p < parts; p++) {
    const start = Math.max(0, p * per - 1),
      end = p === parts - 1 ? n : Math.min(n, (p + 1) * per + 1);
    out.push(pts.slice(2 * start, 2 * end));
  }
  return out.filter((s) => s.length >= 4);
}

function offsetNormal(pts: Float32Array, offset: number): Float32Array {
  const n = pts.length / 2;
  const out = new Float32Array(pts.length);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1),
      b = Math.min(n - 1, i + 1);
    const dx = pts[2 * b] - pts[2 * a],
      dy = pts[2 * b + 1] - pts[2 * a + 1];
    const l = Math.hypot(dx, dy) || 1;
    out[2 * i] = pts[2 * i] - (dy / l) * offset;
    out[2 * i + 1] = pts[2 * i + 1] + (dx / l) * offset;
  }
  return out;
}

function offsetInward(pts: Float32Array, eye: EyeResult, offsetPx: number): Float32Array {
  const { field, w, h } = eye.distance;
  const kx = w / eye.work.w,
    ky = h / eye.work.h;
  const n = pts.length / 2;
  const out = new Float32Array(pts.length);
  const at = (x: number, y: number) => {
    const ix = Math.max(0, Math.min(w - 1, x * kx | 0)),
      iy = Math.max(0, Math.min(h - 1, y * ky | 0));
    return field[iy * w + ix];
  };
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i],
      y = pts[2 * i + 1];
    const gx = at(x + 2, y) - at(x - 2, y),
      gy = at(x, y + 2) - at(x, y - 2);
    const l = Math.hypot(gx, gy);
    if (l < 1e-4) {
      out[2 * i] = x;
      out[2 * i + 1] = y;
    } else {
      out[2 * i] = x + (gx / l) * offsetPx;
      out[2 * i + 1] = y + (gy / l) * offsetPx;
    }
  }
  return out;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, angle: number, n: number): Float32Array {
  const pts = new Float32Array(2 * (n + 1));
  const ca = Math.cos(angle),
    sa = Math.sin(angle);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ex = Math.cos(t) * rx,
      ey = Math.sin(t) * ry;
    pts[2 * i] = cx + ex * ca - ey * sa;
    pts[2 * i + 1] = cy + ex * sa + ey * ca;
  }
  return pts;
}

function medialNodes(eye: EyeResult) {
  // cluster skeleton endpoints; an ellipse per cluster summarises the local mass
  const pts: { x: number; y: number; r: number }[] = [];
  for (const b of eye.skeleton) {
    pts.push({ x: b.pts[0], y: b.pts[1], r: b.radius });
    pts.push({ x: b.pts[b.pts.length - 2], y: b.pts[b.pts.length - 1], r: b.radius });
    if (b.pts.length >= 4) {
      const mid = (b.pts.length >> 2) << 1; // middle point, always in range
      pts.push({ x: b.pts[mid], y: b.pts[mid + 1], r: b.radius });
    }
  }
  const usable = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const nodes: { x: number; y: number; rx: number; ry: number; angle: number }[] = [];
  const minDist = Math.max(18, eye.work.w * 0.045);
  for (const p of usable) {
    let owner = -1;
    for (let i = 0; i < nodes.length; i++)
      if (Math.hypot(nodes[i].x - p.x, nodes[i].y - p.y) < minDist) {
        owner = i;
        break;
      }
    if (owner < 0) nodes.push({ x: p.x, y: p.y, rx: p.r, ry: p.r, angle: eye.axes.minor });
    else {
      const n = nodes[owner];
      n.x = (n.x + p.x) / 2;
      n.y = (n.y + p.y) / 2;
      n.rx = Math.max(n.rx, p.r);
      n.ry = Math.max(n.ry, p.r * 0.8);
    }
  }
  return nodes.filter((n) => n.rx > 8).map((n) => ({ ...n, rx: n.rx * 1.25, ry: n.ry * 1.35 }));
}

function subjectBounds(eye: EyeResult, work: { w: number; h: number }): [number, number, number, number] {
  let x0 = work.w,
    y0 = work.h,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < eye.maskH; y++)
    for (let x = 0; x < eye.maskW; x++)
      if (eye.subjectMask[y * eye.maskW + x]) {
        const wx = (x / eye.maskW) * work.w,
          wy = (y / eye.maskH) * work.h;
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy;
        if (wy > y1) y1 = wy;
      }
  return [x0, y0, x1, y1];
}

function hatchSegments(eye: EyeResult, comp: { box: [number, number, number, number]; zone: number }, angle: number, spacingPlane: number, minRun: number): Float32Array[] {
  const { plane } = eye.zones;
  const kx = eye.work.w / plane.w,
    ky = eye.work.h / plane.h;
  const [bx0, by0, bx1, by1] = comp.box;
  const cx = (bx0 + bx1) / 2,
    cy = (by0 + by1) / 2;
  const R = Math.hypot(bx1 - bx0, by1 - by0) / 2 + 2;
  const u = [Math.cos(angle), Math.sin(angle)],
    v = [-u[1], u[0]];
  const out: Float32Array[] = [];
  const zone = eye.zones.zoneAt;
  for (let t = -R; t <= R; t += Math.max(1.2, spacingPlane)) {
    let runStart = -1;
    for (let s = -R; s <= R; s += 1) {
      const px = cx + u[0] * s + v[0] * t,
        py = cy + u[1] * s + v[1] * t;
      const inside = px >= bx0 - 1 && px < bx1 + 1 && py >= by0 - 1 && py < by1 + 1 && zone(px * kx, py * ky) >= comp.zone;
      if (inside && runStart < 0) runStart = s;
      else if (!inside && runStart >= 0) {
        pushRun(out, cx, cy, u, v, t, runStart, s, kx, ky, minRun);
        runStart = -1;
      }
    }
    if (runStart >= 0) pushRun(out, cx, cy, u, v, t, runStart, R, kx, ky, minRun);
  }
  return out;
}

function pushRun(out: Float32Array[], cx: number, cy: number, u: number[], v: number[], t: number, s0: number, s1: number, kx: number, ky: number, minRun: number) {
  const len = s1 - s0;
  if (len < minRun) return;
  // long runs split into hand-scale strokes with a small gap
  const maxLen = 210;
  for (let a = s0; a < s1; a += maxLen + 6) {
    const b = Math.min(s1, a + maxLen);
    if (b - a < minRun) break;
    const pts = new Float32Array(4);
    pts[0] = (cx + u[0] * a + v[0] * t) * kx;
    pts[1] = (cy + u[1] * a + v[1] * t) * ky;
    pts[2] = (cx + u[0] * b + v[0] * t) * kx;
    pts[3] = (cy + u[1] * b + v[1] * t) * ky;
    out.push(pts);
  }
}

function chainsInBox(chains: ContourInfo[], box: [number, number, number, number], max: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const c of chains) {
    if (out.length >= max) break;
    const b = boundsOf(c.pts);
    if (b[0] > box[2] || b[2] < box[0] || b[1] > box[3] || b[3] < box[1]) continue;
    out.push(c.pts);
  }
  return out;
}

function patchHatch(ctx: BrainContext, box: [number, number, number, number], spacing: number): Float32Array[] {
  const out: Float32Array[] = [];
  const angle = Math.atan2(ctx.eye.light.dy, ctx.eye.light.dx) + Math.PI / 2;
  const u = [Math.cos(angle), Math.sin(angle)],
    v = [-u[1], u[0]];
  const cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  const R = Math.hypot(box[2] - box[0], box[3] - box[1]) / 2;
  for (let t = -R; t <= R; t += spacing) {
    const pts = new Float32Array(4);
    pts[0] = cx + u[0] * -R + v[0] * t;
    pts[1] = cy + u[1] * -R + v[1] * t;
    pts[2] = cx + u[0] * R + v[0] * t;
    pts[3] = cy + u[1] * R + v[1] * t;
    out.push(pts);
  }
  return out;
}

/** Mean |∇darkness| over a component's own zone pixels — low means the
 *  region is a flat graphic tone (wall, sky, shadow mass) rather than a
 *  rendered form, and wants uniform hatching, not structure-following. */
function regionFlatness(eye: EyeResult, comp: { box: [number, number, number, number]; zone: number }): number {
  const { plane } = eye.zones;
  const kx = eye.work.w / plane.w,
    ky = eye.work.h / plane.h;
  const step = Math.max(2, ((comp.box[2] - comp.box[0]) * kx) / 22);
  let sum = 0,
    n = 0;
  for (let y = comp.box[1] * ky; y < comp.box[3] * ky; y += step)
    for (let x = comp.box[0] * kx; x < comp.box[2] * kx; x += step) {
      const x0 = Math.min(plane.w - 1, ((x / eye.work.w) * plane.w) | 0),
        y0 = Math.min(plane.h - 1, ((y / eye.work.h) * plane.h) | 0);
      if (eye.zones.zoneAt(x, y) < comp.zone) continue;
      const i = y0 * plane.w + x0;
      const gx = plane.gray[i + 1 < plane.gray.length ? i + 1 : i] - plane.gray[i - 1 >= 0 ? i - 1 : i];
      const gy = plane.gray[i + plane.w < plane.gray.length ? i + plane.w : i] - plane.gray[i - plane.w >= 0 ? i - plane.w : i];
      sum += Math.abs(gx) + Math.abs(gy);
      n++;
    }
  return n ? sum / n / 255 / 2 : 1;
}

/** Coarse quantised key so grown rectangles of the same hotspot share a cap. */
function patchKey(box: [number, number, number, number]): string {
  const q = 48;
  return `${(box[0] / q) | 0},${(box[1] / q) | 0},${(box[2] / q) | 0},${(box[3] / q) | 0}`;
}

function eraserSweep(box: [number, number, number, number], spacing: number): Float32Array {
  // physical zig-zag sweep with the eraser kept in contact
  const pts: number[] = [];
  const x0 = box[0] + 1,
    x1 = box[2] - 1,
    y0 = box[1] + 1,
    y1 = box[3] - 1;
  let row = 0;
  for (let y = y0; y <= y1; y += spacing, row++) {
    if (row % 2 === 0) pts.push(x0, y, x1, y);
    else pts.push(x1, y, x0, y);
  }
  return new Float32Array(pts);
}

function planAttention(plan: StrokePlan, work: { w: number; h: number }): Attention {
  const b = boundsOf(plan.pts);
  const pad = Math.max(24, work.w * 0.03);
  return { x: b[0] - pad, y: b[1] - pad, w: b[2] - b[0] + 2 * pad, h: b[3] - b[1] + 2 * pad };
}

function boxAttention(eye: EyeResult, boxPlane: [number, number, number, number]): Attention {
  const kx = eye.work.w / eye.zones.plane.w;
  return { x: boxPlane[0] * kx, y: boxPlane[1] * (eye.work.h / eye.zones.plane.h), w: (boxPlane[2] - boxPlane[0]) * kx, h: (boxPlane[3] - boxPlane[1]) * (eye.work.h / eye.zones.plane.h) };
}

function objectiveFor(plan: StrokePlan): string {
  const labels: Record<string, string> = {
    gesture: 'Gesture: placing major movement',
    construct: 'Constructing guide geometry',
    explore: 'Exploring uncertain forms',
    line: 'Committing confident contour',
    hatch: 'Hatching tonal zone',
    formshade: 'Shading along the form',
    detail: 'Rendering fine detail',
    erase: 'Erasing with physical strokes',
    correct: 'Correcting a local error',
  };
  return labels[plan.task.split(' ')[0]] ?? 'Drawing';
}

function eyeDetail(ctx: BrainContext, options: SimOptions): ContourInfo[] {
  return detailChains(ctx.eye.source, options, ctx.eye.work, Math.min(1024, Math.round(ctx.work.w * 1.15)));
}

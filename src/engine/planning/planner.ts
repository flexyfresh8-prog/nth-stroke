/**
 * The artistic planner (spec §4, §7-8). Each stage is a generator of
 * concrete drawing operations derived from the SceneGraph *and* the current
 * canvas state — never from a precomputed plan of the finished artwork.
 * Every call re-observes the canvas, so user edits and interruptions
 * naturally redirect the next decision.
 *
 * Stage A (observation) happens in the analysis pipeline; B–G live here.
 */

import { densityForTone, type SceneGraph } from '../analysis/scene';
import { clamp, simplify } from '../core/math';
import type { Rng } from '../core/rng';
import type { DrawOp, EngineConfig, InstrumentId, Stage, Vec2 } from '../core/types';
import type { Evaluation, Problem } from '../perception/evaluator';
import type { GraphiteMap } from '../media/graphite';
import type { MediaEngine } from '../media/engine';
import { instrument, effectiveTipWidth } from '../media/instruments';
import {
  hatchBand,
  hatchDirection,
  orientationAt,
  refToneAt,
  serpentine,
  spacingForDeficit,
  type HatchLine,
} from './hatch';

export interface PlanContext {
  stage: Stage;
  evaluation: Evaluation | null;
  map: GraphiteMap;
  media: MediaEngine;
  cursor: Vec2;
  opCount: number;
}

export type PlanResult = { op: DrawOp } | { advance: true; reason: string };

interface TonalBlob {
  x: number;
  y: number;
  radius: number;
  meanTone: number;
  saliency: number;
  orientation: number;
}

export class Planner {
  /** --- serializable planning state (checkpointable) --- */
  private constructionQueue: DrawOp[] = [];
  /** Construction strokes already placed — candidates for later cleanup. */
  private constructionHistory: Array<{ waypoints: Vec2[]; intent: string }> = [];
  private constructionBuilt = false;
  private eraseQueue: Array<{ waypoints: Vec2[]; intent: string }> = [];
  private refinementIndex = 0;
  private explored = new Set<number>();
  private eraseBuilt = false;
  private tonalBlobs: TonalBlob[] = [];
  private tonalBuilt = false;
  private tonalIndex = 0;
  private tonalAnchors: Array<{ x: number; y: number; radius: number; orientation: number }> = [];
  private hatchVisits = new Map<string, { visits: number; layer: number; last: number }>();
  private correctionVisits = new Map<string, number>();
  private blendedCells = new Set<string>();
  private softened = new Set<string>();
  private softenedCells = 0;
  private stumpOps = 0;
  private detailQueue: Array<{ waypoints: Vec2[]; instrument: InstrumentId; pressure: number; intent: string; broad?: boolean; tap?: boolean }> = [];
  private detailBuilt = false;
  private detailPlanned = 0;
  private correctionRound = 0;
  private correctionOps = 0;
  private redoChains: number[] = [];
  /** Contours to redraw once their misplaced predecessors are erased. */
  private pendingRedraws: Array<{ waypoints: Vec2[]; intent: string }> = [];

  constructor(
    private readonly scene: SceneGraph,
    private readonly config: EngineConfig,
    private readonly rng: Rng,
  ) {}

  /** Human-readable current objective for the diagnostics panel. */
  objective(ctx: PlanContext): string {
    switch (ctx.stage) {
      case 'construction':
        return `placing construction scaffolding (${this.constructionQueue.length} remaining)`;
      case 'refinement':
        return `refining contours (${this.refinementIndex}/${this.scene.contours.length} chains)`;
      case 'tonal':
        return `blocking shadow masses (${this.tonalIndex}/${this.tonalBlobs.length} masses)`;
      case 'shading': {
        const light = (ctx.evaluation?.problems ?? []).filter((p) => p.signedError > 0.08).length;
        return `building tone — ${light} areas still light`;
      }
      case 'detail':
        return `detailing focal regions (${this.detailPlanned} strokes planned)`;
      case 'correction':
        return `correcting (${this.correctionOps} corrections in round ${this.correctionRound + 1})`;
      case 'complete':
        return 'drawing complete';
      default:
        return 'observing reference';
    }
  }

  /** The next operation for the current stage, or a request to advance. */
  planOp(ctx: PlanContext): PlanResult {
    switch (ctx.stage) {
      case 'construction':
        return this.planConstruction(ctx);
      case 'refinement':
        return this.planRefinement(ctx);
      case 'tonal':
        return this.planTonal(ctx);
      case 'shading':
        return this.planShading(ctx);
      case 'detail':
        return this.planDetail(ctx);
      case 'correction':
        return this.planCorrection(ctx);
      default:
        return { advance: true, reason: 'nothing left to plan' };
    }
  }

  /** Re-queue a contour chain after it was erased by a correction. */
  requeueChain(chainId: number) {
    if (!this.redoChains.includes(chainId)) this.redoChains.push(chainId);
  }

  // ------------------------------------------------------------------ //
  // Stage B — Construction (Loomis / Reilly / bounding shapes)          //
  // ------------------------------------------------------------------ //

  private planConstruction(ctx: PlanContext): PlanResult {
    if (!this.constructionBuilt) {
      this.constructionQueue = this.buildConstruction();
      this.constructionBuilt = true;
    }
    while (this.constructionQueue.length) {
      const op = this.constructionQueue.shift()!;
      if (this.alreadyDrawn(ctx, op.waypoints)) continue; // resume / user drew it
      this.constructionHistory.push({ waypoints: op.waypoints, intent: op.intent });
      return { op };
    }
    return { advance: true, reason: 'construction scaffolding placed' };
  }

  private buildConstruction(): DrawOp[] {
    const ops: DrawOp[] = [];
    let id = 1;
    const S = this.scene.scale;
    const push = (waypoints: Vec2[], intent: string, pressure = 0.16, speed = 1.35) => {
      if (waypoints.length < 2) return;
      ops.push({
        id: id++,
        kind: 'stroke',
        stage: 'construction',
        instrument: this.pickInstrument('pencil-2h'),
        intent,
        waypoints,
        pressure,
        speed,
        region: -1,
        corrective: false,
        travel: true,
      });
    };

    const face = this.scene.face;
    if (face) {
      const L = face.loomis;
      const c = { x: L.center.x * this.scene.canvasWidth, y: L.center.y * this.scene.canvasHeight };
      const r = L.radius * Math.max(this.scene.canvasWidth, this.scene.canvasHeight);
      // Loomis cranial ball (two light arcs).
      push(arcPoints(c, r, -Math.PI * 0.95, Math.PI * 0.08, 14), 'Loomis cranial ball');
      push(arcPoints(c, r, Math.PI * 0.05, Math.PI * 1.02, 14), 'Loomis cranial ball');
      // Head axis + feature guide lines.
      push([
        { x: L.foreheadTop.x * this.scene.canvasWidth - (L.chin.y - L.foreheadTop.y) * S * 0.15, y: (L.foreheadTop.y - 0.03) * this.scene.canvasHeight },
        { x: L.chin.x * this.scene.canvasWidth, y: Math.min(L.chin.y * this.scene.canvasHeight + r * 0.12, this.scene.canvasHeight - 2) },
      ], 'head centerline', 0.14);
      const lines: Array<[string, { y: number; left: Vec2; right: Vec2 }]> = [
        ['brow line', L.browLine],
        ['eye line', L.eyeLine],
        ['nose line', L.noseLine],
        ['mouth line', L.mouthLine],
      ];
      for (const [label, line] of lines) {
        push([
          { x: line.left.x * this.scene.canvasWidth, y: line.left.y * this.scene.canvasHeight },
          { x: line.right.x * this.scene.canvasWidth, y: line.right.y * this.scene.canvasHeight },
        ], label, 0.13, 1.5);
      }
      push(
        L.jawline.map((p) => ({ x: p.x * this.scene.canvasWidth, y: p.y * this.scene.canvasHeight })),
        'jaw construction',
        0.15,
      );
      push([
        { x: L.earLeft.x * this.scene.canvasWidth, y: (L.earLeft.y - 0.03) * this.scene.canvasHeight },
        { x: L.earLeft.x * this.scene.canvasWidth, y: (L.earLeft.y + 0.06) * this.scene.canvasHeight },
      ], 'ear placement L', 0.14);
      push([
        { x: L.earRight.x * this.scene.canvasWidth, y: (L.earRight.y - 0.03) * this.scene.canvasHeight },
        { x: L.earRight.x * this.scene.canvasWidth, y: (L.earRight.y + 0.06) * this.scene.canvasHeight },
      ], 'ear placement R', 0.14);
    }

    const pose = this.scene.pose;
    if (pose) {
      const g = pose.gesture;
      const P = (p: Vec2) => ({ x: p.x * this.scene.canvasWidth, y: p.y * this.scene.canvasHeight });
      push(g.spine.map(P), 'gesture — line of action', 0.2, 1.2);
      push([P(g.shoulders[0]), P(g.shoulders[1])], 'shoulder line', 0.16);
      push([P(g.hips[0]), P(g.hips[1])], 'hip line', 0.16);
      for (const limb of g.limbs) {
        const a = P(limb.from);
        const b = P(limb.to);
        // Gesture lines bow slightly — rhythm over anatomy.
        const mx = (a.x + b.x) / 2 + (this.rng.next() - 0.5) * 14;
        const my = (a.y + b.y) / 2 + (this.rng.next() - 0.5) * 14;
        push([a, { x: mx, y: my }, b], `gesture — ${limb.label}`, 0.17, 1.25);
      }
      push(arcPoints(P(g.headCenter), g.headRadius * this.scene.canvasWidth, 0, Math.PI * 1.9, 12), 'head mass', 0.15);
    }

    if (!face && !pose) {
      // Bounding envelopes of the leading subject regions.
      const subjects = this.scene.regions.filter((r) => !r.background).slice(0, 3);
      const list = subjects.length ? subjects : this.scene.regions.slice(0, 3);
      for (const region of list) {
        const cx = (region.bbox.x + region.bbox.w / 2) * S;
        const cy = (region.bbox.y + region.bbox.h / 2) * S;
        const rx = (region.bbox.w / 2) * S;
        const ry = (region.bbox.h / 2) * S;
        push(ellipsePoints(cx, cy, rx, ry, 16), `bounding envelope (region ${region.id})`, 0.14, 1.4);
        // Main axis — the region's gesture.
        const a = region.orientation;
        push([
          { x: cx - Math.cos(a) * rx * 0.8, y: cy - Math.sin(a) * ry * 0.8 },
          { x: cx + Math.cos(a) * rx * 0.8, y: cy + Math.sin(a) * ry * 0.8 },
        ], `main axis (region ${region.id})`, 0.13, 1.5);
      }
    }

    // Perspective guides: two dominant straight-edge directions.
    const strong = this.scene.directions.filter((d) => d.weight > 0.16);
    if (strong.length >= 2 && !face) {
      const cx = this.scene.canvasWidth / 2;
      const cy = this.scene.canvasHeight / 2;
      const R = Math.hypot(this.scene.canvasWidth, this.scene.canvasHeight) / 2;
      for (const dir of strong.slice(0, 2)) {
        push([
          { x: cx - Math.cos(dir.angle) * R, y: cy - Math.sin(dir.angle) * R },
          { x: cx + Math.cos(dir.angle) * R, y: cy + Math.sin(dir.angle) * R },
        ], 'perspective guide', 0.1, 1.6);
      }
    }
    return ops;
  }

  // ------------------------------------------------------------------ //
  // Stage C — Refinement (accurate contours, exploratory strokes,       //
  // erasing obsolete construction marks)                                //
  // ------------------------------------------------------------------ //

  private planRefinement(ctx: PlanContext): PlanResult {
    // Corrections may re-queue specific chains — serve them first.
    while (this.redoChains.length) {
      const chainId = this.redoChains.shift()!;
      const chain = this.scene.contours.find((c) => c.id === chainId);
      if (chain && !this.contourCovered(ctx, chain.points, chain.bbox)) {
        return { op: this.contourOp(chain.points, `redraw corrected contour`, 0.5, this.instrumentForChain(chain)) };
      }
    }
    const contours = this.scene.contours;
    while (this.refinementIndex < contours.length) {
      const chain = contours[this.refinementIndex];
      const canvasPts = chain.points.map((p) => ({ x: p.x * this.scene.scale, y: p.y * this.scene.scale }));
      if (this.contourCovered(ctx, canvasPts, chain.bbox)) {
        this.refinementIndex++;
        continue;
      }
      const important = chain.saliency > 0.5 && chain.length > 60 * this.scene.scale;
      if (important && !this.explored.has(chain.id)) {
        // First touch: a light exploratory search stroke with overshoot.
        this.explored.add(chain.id);
        return { op: this.contourOp(overshoot(canvasPts, 0.06), `exploratory pass — ${chainLabel(chain)}`, 0.3, this.instrumentForChain(chain)) };
      }
      this.refinementIndex++;
      return { op: this.contourOp(canvasPts, `committed contour — ${chainLabel(chain)}`, clamp(0.34 + chain.contrast * 0.4, 0.3, 0.62), this.instrumentForChain(chain)) };
    }
    // All contours handled — clean up construction marks that no longer
    // serve the drawing (no reference edge supports them).
    if (!this.eraseBuilt) {
      this.eraseQueue = this.buildEraseQueue();
      this.eraseBuilt = true;
    }
    while (this.eraseQueue.length) {
      const item = this.eraseQueue.shift()!;
      if (!this.hasGraphiteAlong(ctx, item.waypoints, 0.05)) continue;
      return {
        op: {
          id: 900000 + this.eraseQueue.length,
          kind: 'utility',
          stage: 'refinement',
          instrument: 'eraser-kneaded',
          intent: item.intent,
          waypoints: item.waypoints,
          pressure: 0.3,
          speed: 1.4,
          region: -1,
          corrective: false,
          reason: 'obsolete construction mark',
          travel: true,
        },
      };
    }
    return { advance: true, reason: 'contours refined' };
  }

  private buildEraseQueue(): Array<{ waypoints: Vec2[]; intent: string }> {
    const queue: Array<{ waypoints: Vec2[]; intent: string }> = [];
    for (const stroke of this.constructionHistory) {
      // A construction mark is obsolete when no reference edge supports it.
      let supported = 0;
      let total = 0;
      for (let i = 0; i < stroke.waypoints.length; i += Math.max(1, Math.floor(stroke.waypoints.length / 10))) {
        const p = stroke.waypoints[i];
        total++;
        const edge = this.edgeStrengthNear(p, 3);
        if (edge > 0.3) supported++;
      }
      if (total === 0 || supported / total > 0.3) continue; // still useful
      queue.push({ waypoints: simplify(stroke.waypoints, 2.5), intent: `clean construction mark (${stroke.intent})` });
    }
    return queue;
  }

  private edgeStrengthNear(p: Vec2, radiusScenePx: number): number {
    const fx = clamp((p.x / this.scene.scale) | 0, 0, this.scene.width - 1);
    const fy = clamp((p.y / this.scene.scale) | 0, 0, this.scene.height - 1);
    let m = 0;
    for (let dy = -radiusScenePx; dy <= radiusScenePx; dy++) {
      for (let dx = -radiusScenePx; dx <= radiusScenePx; dx++) {
        const xx = clamp(fx + dx, 0, this.scene.width - 1);
        const yy = clamp(fy + dy, 0, this.scene.height - 1);
        m = Math.max(m, this.scene.fields.edges[yy * this.scene.width + xx]);
      }
    }
    return m;
  }

  private instrumentForChain(chain: { contrast: number; saliency: number; length: number; closed: boolean }): InstrumentId {
    if (chain.contrast > 0.45) return this.pickInstrument('pencil-2b');
    if (chain.saliency > 0.6 && chain.length < 34 * this.scene.scale) return this.pickInstrument('mechanical');
    return this.pickInstrument('pencil-hb');
  }

  private contourOp(points: Vec2[], intent: string, pressure: number, instrumentId: InstrumentId): DrawOp {
    let waypoints = simplify(points, 1.15);
    if (waypoints.length < 2) waypoints = points.slice(0, 2);
    return {
      id: 400000 + this.refinementIndex * 10 + Math.floor(this.rng.next() * 9),
      kind: 'stroke',
      stage: 'refinement',
      instrument: instrumentId,
      intent,
      waypoints,
      pressure,
      speed: clamp(1.2 - pressure * 0.5, 0.6, 1.3),
      region: this.regionAt(waypoints[0]),
      corrective: false,
      travel: true,
    };
  }

  private contourCovered(ctx: PlanContext, canvasPts: Vec2[], bbox: { x: number; y: number; w: number; h: number }): boolean {
    if (canvasPts.length < 2) return true;
    const step = Math.max(1, Math.floor(canvasPts.length / 9));
    let hits = 0;
    let total = 0;
    for (let i = 0; i < canvasPts.length; i += step) {
      const p = canvasPts[i];
      total++;
      if (ctx.map.meanDensity(p.x, p.y, 3.5) > 0.045) hits++;
    }
    return total > 0 && hits / total >= 0.62;
  }

  private alreadyDrawn(ctx: PlanContext, waypoints: Vec2[]): boolean {
    return this.contourCovered(ctx, waypoints, { x: 0, y: 0, w: 0, h: 0 });
  }

  private hasGraphiteAlong(ctx: PlanContext, waypoints: Vec2[], threshold: number): boolean {
    let hits = 0;
    let total = 0;
    for (let i = 0; i < waypoints.length; i += Math.max(1, Math.floor(waypoints.length / 8))) {
      total++;
      if (ctx.map.meanDensity(waypoints[i].x, waypoints[i].y, 4) > threshold) hits++;
    }
    return total > 0 && hits / total > 0.5;
  }

  // ------------------------------------------------------------------ //
  // Stage D — Tonal blocking (shadow masses before detail)             //
  // ------------------------------------------------------------------ //

  private planTonal(ctx: PlanContext): PlanResult {
    if (!this.tonalBuilt) {
      this.tonalBlobs = this.buildTonalBlobs();
      this.tonalBuilt = true;
      this.tonalIndex = 0;
      this.tonalAnchors = [];
    }
    // Anchor patches inside each shadow mass — tone is blocked patch by
    // patch with the LOCAL reference value, never one flat blob average.
    while (this.tonalAnchors.length || this.tonalIndex < this.tonalBlobs.length) {
      if (!this.tonalAnchors.length) {
        const blob = this.tonalBlobs[this.tonalIndex++];
        const grid = Math.max(1, Math.round(blob.radius / (20 * Math.max(0.6, this.scene.scale))));
        for (let gy = -grid; gy <= grid; gy++) {
          for (let gx = -grid; gx <= grid; gx++) {
            const fx = blob.x + (gx / (grid + 0.5)) * blob.radius * 0.8;
            const fy = blob.y + (gy / (grid + 0.5)) * blob.radius * 0.8;
            if (fx < 4 || fy < 4 || fx > this.scene.canvasWidth - 4 || fy > this.scene.canvasHeight - 4) continue;
            if (gx * gx + gy * gy > (grid + 0.4) * (grid + 0.4)) continue;
            this.tonalAnchors.push({ x: fx, y: fy, radius: (blob.radius * 0.8) / (grid * 2 + 1) + 6, orientation: blob.orientation });
          }
        }
        continue;
      }
      const anchor = this.tonalAnchors.shift()!;
      const blobRadiusCache = anchor.radius * 3.1;
      const refTone = refToneAt(this.scene, anchor.x, anchor.y);
      const target = densityForTone(refTone);
      // Darkest of five spots sets the blocking value (terminator cells).
      let deficit = target - ctx.map.meanDensity(anchor.x, anchor.y, anchor.radius * 0.7);
      for (const [ox, oy] of [[0.55, 0], [-0.55, 0], [0, 0.55], [0, -0.55]] as const) {
        const sx = anchor.x + ox * anchor.radius;
        const sy = anchor.y + oy * anchor.radius;
        const st = densityForTone(refToneAt(this.scene, sx, sy)) - ctx.map.meanDensity(sx, sy, anchor.radius * 0.45);
        if (st > deficit) deficit = st;
      }
      if (deficit < 0.14) continue;
      const instrumentId = this.pickInstrument(target > 1.15 ? 'charcoal' : target > 0.62 ? 'pencil-4b' : 'pencil-2b');
      const spec = instrument(instrumentId);
      const spacing = spacingForDeficit(deficit, effectiveTipWidth(spec, 0.5, true), 0.11 * spec.darkness);
      const angle = anchor.orientation + (this.rng.chance(0.5) ? 0 : 0.22);
      // Long sweeping strokes across the form (clipped by edges), spaced by
      // the missing value — the look of broad side-of-pencil blocking.
      const strokeLength = Math.max(64, blobRadiusCache * 1.6);
      let lines = hatchBand(this.scene, anchor.x, anchor.y, anchor.radius, angle, spacing, strokeLength);
      lines = this.filterHighlightIslands(lines);
      lines = lines.slice(0, 9);
      const serp = serpentine(lines);
      if (serp.length < 3) continue;
      const op: DrawOp = {
        id: 500000 + this.tonalIndex * 97 + this.tonalAnchors.length,
        kind: 'stroke',
        stage: 'tonal',
        instrument: instrumentId,
        intent: `block shadow value ${refTone.toFixed(2)} (deficit ${deficit.toFixed(2)})`,
        waypoints: serp,
        pressure: clamp(0.3 + deficit * 0.24, 0.28, 0.52),
        speed: 0.9,
        region: this.regionAt(anchor),
        corrective: false,
        travel: true,
        broad: true,
      };
      return { op };
    }
    return { advance: true, reason: 'shadow masses blocked' };
  }

  private buildTonalBlobs(): TonalBlob[] {
    const { fields, width, height } = this.scene;
    const cell = 14;
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const shadow = new Uint8Array(cols * rows);
    const threshold = fields.tonePercentiles.p20 + 0.015;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < cell; dy++) {
          const sy = y * cell + dy;
          if (sy >= height) break;
          for (let dx = 0; dx < cell; dx++) {
            const sx = x * cell + dx;
            if (sx >= width) break;
            sum += fields.lum[sy * width + sx];
            n++;
          }
        }
        if (n && sum / n < threshold) shadow[y * cols + x] = 1;
      }
    }
    // Connected components.
    const seen = new Uint8Array(cols * rows);
    const blobs: TonalBlob[] = [];
    for (let i = 0; i < shadow.length; i++) {
      if (!shadow[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      const cells: number[] = [];
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        const cx = c % cols;
        const cy = (c / cols) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const xx = cx + dx;
          const yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
          const j = yy * cols + xx;
          if (shadow[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (cells.length < 3) continue;
      let sx = 0;
      let sy = 0;
      let sal = 0;
      let tone = 0;
      for (const c of cells) {
        const cx = (c % cols) + 0.5;
        const cy = ((c / cols) | 0) + 0.5;
        sx += cx;
        sy += cy;
        const fi = Math.min(fields.saliency.length - 1, ((cy * cell) | 0) * width + (cx * cell) | 0);
        sal += fields.saliency[fi];
        tone += fields.lum[fi];
      }
      const n = cells.length;
      const cxScene = (sx / n) * cell;
      const cyScene = (sy / n) * cell;
      const orient = orientationAt(this.scene, cxScene * this.scene.scale, cyScene * this.scene.scale);
      blobs.push({
        x: cxScene * this.scene.scale,
        y: cyScene * this.scene.scale,
        radius: Math.sqrt(n) * cell * 0.62 * this.scene.scale,
        meanTone: tone / n,
        saliency: sal / n,
        orientation: orient.coherence > 0.2 ? orient.angle : 0.9,
      });
    }
    blobs.sort((a, b) => b.saliency * Math.sqrt(b.radius) - a.saliency * Math.sqrt(a.radius));
    return blobs.slice(0, 26);
  }

  private filterHighlightIslands(lines: HatchLine[]): HatchLine[] {
    const p85 = this.scene.fields.tonePercentiles.p85;
    return lines.filter((line) => {
      const mid = line.points[Math.floor(line.points.length / 2)];
      return refToneAt(this.scene, mid.x, mid.y) < p85 + 0.02;
    });
  }

  // ------------------------------------------------------------------ //
  // Stage E — Shading (directional hatching, cross-hatch, layering,     //
  // blending on smooth forms, pressure variation)                       //
  // ------------------------------------------------------------------ //

  private planShading(ctx: PlanContext): PlanResult {
    const evaluation = ctx.evaluation;
    if (!evaluation) return { advance: true, reason: 'no evaluation available' };
    // Problems ranked by absolute mismatch; the local measurement at each
    // problem decides whether graphite is actually missing there.
    const light = evaluation.problems;
    if (!light.length) return { advance: true, reason: 'tone targets reached' };

    for (const problem of light.slice(0, 10)) {
      const key = `${problem.cell.cx},${problem.cell.cy}`;
      const visit = this.hatchVisits.get(key) ?? { visits: 0, layer: 0, last: -1 };
      if (visit.last === ctx.opCount) continue;
      if (visit.visits >= 8) continue; // leave persistent cells to correction
      const refTone = refToneAt(this.scene, problem.x, problem.y);
      const target = densityForTone(refTone);
      // Measure the deficit at the darkest of five sample points — a cell
      // straddling the terminator must be treated by its deepest value, the
      // way an artist darkens the shadow side of a form first.
      let deficit = target - ctx.map.meanDensity(problem.x, problem.y, problem.radius * 0.7);
      for (const [ox, oy] of [[0.55, 0], [-0.55, 0], [0, 0.55], [0, -0.55]] as const) {
        const sx = problem.x + ox * problem.radius;
        const sy = problem.y + oy * problem.radius;
        const st = densityForTone(refToneAt(this.scene, sx, sy)) - ctx.map.meanDensity(sx, sy, problem.radius * 0.45);
        if (st > deficit) deficit = st;
      }
      if (deficit < 0.09) continue;

      const layer = visit.layer;
      const direction = hatchDirection(this.scene, problem.x, problem.y, layer, this.globalHatchAngle());
      // Instrument follows the DEFICIT (how much value is still missing),
      // not the absolute target — small touch-ups use hard pencils, deep
      // value gaps need soft graphite.
      const instrumentId = this.pickInstrument(this.instrumentForDeficit(deficit));
      const spec = instrument(instrumentId);
      const spacing = spacingForDeficit(deficit, effectiveTipWidth(spec, 0.45, false), 0.2 * spec.darkness);
      let lines = hatchBand(this.scene, problem.x, problem.y, problem.radius * 1.15, direction, spacing, problem.radius * 2.6);
      lines = this.filterHighlightIslands(lines);
      if (!lines.length) continue;

      // Blend once after several hatch layers on a smooth form, then keep
      // layering graphite on top — never alternate endlessly.
      const smooth = this.regionTextureAt(problem.x, problem.y) < 0.28;
      if (smooth && visit.visits >= 3 && !this.blendedCells.has(key)) {
        this.blendedCells.add(key);
        this.stumpOps++;
        this.hatchVisits.set(key, { visits: visit.visits + 1, layer: visit.layer, last: ctx.opCount + 1 });
        if (this.stumpOps <= 90) {
          return {
            op: {
              id: 600000 + (this.hatchVisits.size * 31) % 899999,
              kind: 'utility',
              stage: 'shading',
              instrument: 'stump',
              intent: `blend shading on smooth form (layer ${visit.layer + 1})`,
              waypoints: serpentine(lines.slice(0, 4)),
              pressure: 0.35,
              speed: 1.1,
              region: this.regionAt(problem),
              corrective: false,
              travel: true,
            },
          };
        }
      }

      // One short, lifted hatch stroke per op; the row is chosen from the
      // whole band so repeated visits cover the area instead of one edge.
      const line = lines[Math.floor(this.rng.next() * lines.length)];
      this.hatchVisits.set(key, { visits: visit.visits + 1, layer: layer + 1, last: ctx.opCount + 1 });
      return {
        op: {
          id: 610000 + (this.hatchVisits.size * 17) % 899999,
          kind: 'stroke',
          stage: 'shading',
          instrument: instrumentId,
          intent: `hatch ${layer > 0 ? `layer ${layer + 1} (cross-hatch)` : 'layer 1'} — deficit ${(deficit).toFixed(2)}`,
          waypoints: line.points,
          pressure: clamp(0.3 + deficit * 0.35 + this.rng.next() * 0.1, 0.25, 0.7),
          speed: clamp(1.15 - deficit * 0.4, 0.7, 1.3),
          region: this.regionAt(problem),
          corrective: false,
          travel: true,
        },
      };
    }
    return { advance: true, reason: 'no reachable light areas' };
  }

  private globalHatchAngle(): number {
    const light = this.scene.fields.light;
    const base = light ? Math.atan2(light.y, light.x) + Math.PI / 2 : 2.05;
    return base + (this.rng.next() - 0.5) * 0.25;
  }

  /** Instrument choice for how much value is still missing. */
  private instrumentForDeficit(deficit: number): InstrumentId {
    if (deficit < 0.08) return 'pencil-2h';
    if (deficit < 0.2) return 'pencil-hb';
    if (deficit < 0.45) return 'pencil-2b';
    if (deficit < 0.75) return 'pencil-4b';
    return 'pencil-6b';
  }

  private regionTextureAt(x: number, y: number): number {
    const fx = clamp((x / this.scene.scale) | 0, 0, this.scene.width - 1);
    const fy = clamp((y / this.scene.scale) | 0, 0, this.scene.height - 1);
    return this.scene.fields.texture[fy * this.scene.width + fx];
  }

  // ------------------------------------------------------------------ //
  // Stage F — Detailing (focal priority: eyes, lashes, hair, texture)   //
  // ------------------------------------------------------------------ //

  private planDetail(ctx: PlanContext): PlanResult {
    if (!this.detailBuilt) {
      this.detailQueue = this.buildDetailQueue();
      this.detailBuilt = true;
    }
    const budget = this.detailBudget();
    while (this.detailQueue.length && this.detailPlanned < budget) {
      const item = this.detailQueue.shift()!;
      if (item.tap) {
        // Verify the accent is still missing (user may have added it).
        if (ctx.map.meanDensity(item.waypoints[0].x, item.waypoints[0].y, 2.5) > 0.3) continue;
      } else if (this.contourCovered(ctx, item.waypoints, { x: 0, y: 0, w: 0, h: 0 })) {
        continue;
      }
      this.detailPlanned++;
      return {
        op: {
          id: 700000 + this.detailPlanned,
          kind: item.tap ? 'stroke' : 'stroke',
          stage: 'detail',
          instrument: item.instrument,
          intent: item.intent,
          waypoints: item.waypoints,
          pressure: item.pressure,
          speed: 1.1,
          region: this.regionAt(item.waypoints[0]),
          corrective: false,
          travel: true,
          broad: item.broad,
        },
      };
    }
    return { advance: true, reason: this.detailPlanned >= budget ? 'detail budget reached' : 'no more focal details' };
  }

  private detailBudget(): number {
    const base = this.scene.face ? 90 : 46;
    return Math.round(base + 240 * this.config.detailLevel);
  }

  private buildDetailQueue(): Planner['detailQueue'] {
    const queue: Planner['detailQueue'] = [];
    const W = this.scene.canvasWidth;
    const H = this.scene.canvasHeight;
    const face = this.scene.face;
    if (face) {
      const L = face.loomis;
      const P = (p: Vec2) => ({ x: p.x * W, y: p.y * H });
      const scale = Math.max(W, H);
      // Eyelashes: short curved strokes along the upper lids.
      for (const eye of [L.eyes.left, L.eyes.right]) {
        const a = P(eye.inner);
        const b = P(eye.outer);
        const t = P(eye.top);
        for (let k = 0; k < 4; k++) {
          const f = 0.2 + k * 0.2;
          const base = {
            x: a.x + (b.x - a.x) * f,
            y: (a.y + (b.y - a.y) * f + t.y) / 2,
          };
          const outward = k < 2 ? -1 : 1;
          queue.push({
            waypoints: [
              base,
              { x: base.x + outward * scale * 0.004, y: base.y - scale * (0.006 + this.rng.next() * 0.004) },
            ],
            instrument: this.pickInstrument('mechanical'),
            pressure: 0.42,
            intent: 'eyelash',
          });
        }
        // Iris accent: a firm short arc at the eye centre.
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (t.y - (a.y + b.y) / 2) * 0.2 };
        queue.push({
          waypoints: [
            { x: c.x - scale * 0.006, y: c.y + scale * 0.001 },
            { x: c.x, y: c.y + scale * 0.002 },
            { x: c.x + scale * 0.006, y: c.y + scale * 0.001 },
          ],
          instrument: this.pickInstrument('pencil-4b'),
          pressure: 0.6,
          intent: 'iris accent',
        });
      }
      // Nostrils, mouth line, lip accents.
      queue.push({
        waypoints: [P(L.nostrils.left), { x: (P(L.nostrils.left).x + P(L.noseTip).x) / 2, y: P(L.noseTip).y }, P(L.noseTip)],
        instrument: this.pickInstrument('pencil-2b'),
        pressure: 0.42,
        intent: 'nostril hint',
      });
      queue.push({
        waypoints: [P(L.mouthCorners.left), P(L.lips.top), P(L.mouthCorners.right)],
        instrument: this.pickInstrument('pencil-2b'),
        pressure: 0.45,
        intent: 'mouth line',
      });
      // Eyebrows: rhythmic short strokes.
      const browL = P(L.eyes.left.inner);
      const browR = P(L.eyes.right.inner);
      for (const [inner, outer, dir] of [
        [browL, P(L.eyes.left.outer), -1],
        [browR, P(L.eyes.right.outer), 1],
      ] as const) {
        for (let k = 0; k < 5; k++) {
          const f = 0.12 + k * 0.18;
          const x = inner.x + (outer.x - inner.x) * f;
          const y = inner.y + (outer.y - inner.y) * f - H * 0.018;
          queue.push({
            waypoints: [
              { x, y },
              { x: x + dir * scale * 0.006, y: y - scale * 0.0035 },
            ],
            instrument: this.pickInstrument('pencil-2b'),
            pressure: 0.34,
            intent: 'eyebrow stroke',
          });
        }
      }
      // Hair: streamlines above the hairline.
      const hairSeeds = this.hairSeeds(P(L.hairline));
      for (const seed of hairSeeds) {
        const strand = this.traceStrand(seed);
        if (strand.length > 1) {
          queue.push({
            waypoints: strand,
            instrument: this.pickInstrument('pencil-2b'),
            pressure: 0.3 + this.rng.next() * 0.18,
            intent: 'hair strand',
          });
        }
      }
    } else {
      // Fine contours not drawn during refinement + texture accents.
      const fine = this.scene.contours.filter(
        (c) => c.length < 30 * this.scene.scale && c.saliency > 0.4,
      );
      for (const chain of fine.slice(0, 40 * (0.4 + this.config.detailLevel))) {
        queue.push({
          waypoints: chain.points.map((p) => ({ x: p.x * this.scene.scale, y: p.y * this.scene.scale })),
          instrument: this.pickInstrument('mechanical'),
          pressure: 0.4,
          intent: 'fine contour detail',
        });
      }
      // Texture accents: short strokes along the orientation field where
      // the reference is textured.
      const { texture, width, height } = this.scene.fields;
      let placed = 0;
      const target = Math.round(34 * this.config.detailLevel);
      for (let y = 2; y < height - 2 && placed < target; y += 3) {
        for (let x = 2; x < width - 2 && placed < target; x += 3) {
          const i = y * width + x;
          if (texture[i] < 0.55 || this.scene.fields.saliency[i] < 0.35) continue;
          const cx = x * this.scene.scale;
          const cy = y * this.scene.scale;
          const { angle } = orientationAt(this.scene, cx, cy);
          const len = 5 + this.rng.next() * 9;
          queue.push({
            waypoints: [
              { x: cx - Math.cos(angle) * len, y: cy - Math.sin(angle) * len },
              { x: cx + Math.cos(angle) * len, y: cy + Math.sin(angle) * len },
            ],
            instrument: this.pickInstrument('pencil-hb'),
            pressure: 0.24 + this.rng.next() * 0.14,
            intent: 'texture accent',
          });
          placed++;
        }
      }
    }
    return queue;
  }

  private hairSeeds(hairlineTop: Vec2): Vec2[] {
    const seeds: Vec2[] = [];
    const count = Math.round(10 + 14 * this.config.detailLevel);
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(hairlineTop.x - this.scene.canvasWidth * 0.18, hairlineTop.x + this.scene.canvasWidth * 0.18);
      const y = this.rng.range(Math.max(4, hairlineTop.y - this.scene.canvasHeight * 0.14), hairlineTop.y + this.scene.canvasHeight * 0.02);
      const fx = clamp((x / this.scene.scale) | 0, 0, this.scene.width - 1);
      const fy = clamp((y / this.scene.scale) | 0, 0, this.scene.height - 1);
      // Only seed where the reference is actually hair (darker than skin tones).
      if (this.scene.fields.lum[fy * this.scene.width + fx] < 0.62) seeds.push({ x, y });
    }
    return seeds;
  }

  private traceStrand(seed: Vec2): Vec2[] {
    const pts: Vec2[] = [seed];
    let p = seed;
    const maxLen = this.scene.canvasHeight * (0.1 + this.rng.next() * 0.16);
    let dir = orientationAt(this.scene, p.x, p.y).angle + (this.rng.chance(0.5) ? 0 : Math.PI);
    for (let i = 0; i < 30; i++) {
      const { angle } = orientationAt(this.scene, p.x, p.y);
      // Smoothly follow the form; hair flows, it doesn't zig-zag.
      let d = angle;
      let diff = d - dir;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      dir += diff * 0.3;
      const nx = p.x + Math.cos(dir) * 4;
      const ny = p.y + Math.sin(dir) * 4;
      if (nx < 2 || ny < 2 || nx > this.scene.canvasWidth - 2 || ny > this.scene.canvasHeight - 2) break;
      const fi = clamp((ny / this.scene.scale) | 0, 0, this.scene.height - 1) * this.scene.width + clamp((nx / this.scene.scale) | 0, 0, this.scene.width - 1);
      if (this.scene.fields.lum[fi] > 0.85) break; // flew off the hair mass
      p = { x: nx, y: ny };
      pts.push(p);
      if (pts.length * 4 > maxLen) break;
    }
    return pts;
  }

  // ------------------------------------------------------------------ //
  // Stage G — Correction (localized, reasoned, non-destructive)         //
  // ------------------------------------------------------------------ //

  private planCorrection(ctx: PlanContext): PlanResult {
    const evaluation = ctx.evaluation;
    if (!evaluation) return { advance: true, reason: 'no evaluation' };
    const problems = evaluation.problems;

    // An artist corrects the worst faults, then stops — endless polishing
    // would destroy what is already right (spec §4-G).
    if (this.correctionOps >= 70) {
      return { advance: true, reason: 'correction pass complete — remaining deviations accepted' };
    }

    // 1) Too dark → kneaded eraser lift (localized: small radius, gentle).
    const dark = problems.find((p) => p.signedError < -0.12);
    if (dark) {
      const key = `erase,${dark.cell.cx},${dark.cell.cy}`;
      const visits = this.correctionVisits.get(key) ?? 0;
      this.correctionVisits.set(key, visits + 1);
      if (visits < 2) {
        this.correctionOps++;
        return {
          op: {
            id: 800000 + this.correctionOps,
            kind: 'utility',
            stage: 'correction',
            instrument: 'eraser-kneaded',
            intent: `lighten overshoot (${(-dark.signedError).toFixed(2)} too dark)`,
            waypoints: this.discSweep(dark.x, dark.y, Math.min(dark.radius * 1.1, 9 * this.scene.scale + 6)),
            pressure: clamp(0.3 + (-dark.signedError) * 1.2, 0.3, 0.55),
            speed: 1.2,
            region: this.regionAt(dark),
            corrective: true,
            reason: `area at (${dark.x | 0}, ${dark.y | 0}) is ${(-dark.signedError * 100) | 0}% too dark versus the reference — lifting with the kneaded eraser`,
            travel: true,
          },
        };
      }
      // After two lifts the area keeps its value — accepted as artist's
      // judgement rather than fighting the paper forever.
    }

    // 2) Harsh transitions → stump softening (each area softened once).
    if (evaluation.harshCells.length > 3 && this.softenedCells < 60) {
      const cell = evaluation.harshCells.find((c) => !this.softened.has(`${(c.x / 8) | 0},${(c.y / 8) | 0}`));
      if (cell) {
        this.softened.add(`${(cell.x / 8) | 0},${(cell.y / 8) | 0}`);
        this.softenedCells++;
        this.correctionOps++;
        return {
          op: {
            id: 810000 + this.correctionOps,
            kind: 'utility',
            stage: 'correction',
            instrument: 'stump',
            intent: 'soften overly hard edge',
            waypoints: this.discSweep(cell.x, cell.y, Math.min(9 * this.scene.scale + 6, 14)),
            pressure: 0.3,
            speed: 1.0,
            region: this.regionAt(cell),
            corrective: true,
            reason: `edge at (${cell.x | 0}, ${cell.y | 0}) is harder than in the reference — softening with the blending stump`,
            travel: true,
          },
        };
      }
    }

    // 3) Persistent light spots the shading stage could not resolve.
    const stubborn = problems.find((p) => {
      const key = `${p.cell.cx},${p.cell.cy}`;
      const visit = this.hatchVisits.get(key);
      const corrected = this.correctionVisits.get(`fix,${key}`) ?? 0;
      return p.signedError > 0.14 && visit && visit.visits >= 5 && corrected < 2;
    });
    if (stubborn) {
      const skey = `fix,${stubborn.cell.cx},${stubborn.cell.cy}`;
      this.correctionVisits.set(skey, (this.correctionVisits.get(skey) ?? 0) + 1);
      this.correctionOps++;
      const refTone = refToneAt(this.scene, stubborn.x, stubborn.y);
      const target = densityForTone(refTone);
      const current = ctx.map.meanDensity(stubborn.x, stubborn.y, stubborn.radius);
      const spec6b = instrument('pencil-6b');
      const deepenPath = serpentine(
        hatchBand(
          this.scene,
          stubborn.x,
          stubborn.y,
          stubborn.radius,
          this.globalHatchAngle() + Math.PI / 4,
          spacingForDeficit(Math.max(0.12, target - current), effectiveTipWidth(spec6b, 0.6, false), 0.2 * spec6b.darkness),
          stubborn.radius * 2.2,
        ).slice(0, 4),
      );
      if (deepenPath.length < 2) {
        this.correctionVisits.set(skey, 99); // unreachable spot — stop trying
      } else {
        return {
          op: {
            id: 820000 + this.correctionOps,
            kind: 'stroke',
            stage: 'correction',
            instrument: this.pickInstrument('pencil-6b'),
            intent: 'deepen stubborn light area',
            waypoints: deepenPath,
            pressure: 0.55,
            speed: 0.75,
            region: this.regionAt(stubborn),
            corrective: true,
            reason: `light area at (${stubborn.x | 0}, ${stubborn.y | 0}) stayed light after ${this.hatchVisits.get(`${stubborn.cell.cx},${stubborn.cell.cy}`)?.visits ?? 0} hatch layers — deepening with 6B`,
            travel: true,
          },
        };
      }
    }

    // 4) Uncovered strong edges where the engine itself drew a misplaced
    //    stroke: erase the offending stroke, then requeue the contour.
    //    First serve any redraw waiting for its predecessor to be erased.
    while (this.pendingRedraws.length) {
      const redo = this.pendingRedraws[0];
      const clean = !this.hasGraphiteAlong(ctx, redo.waypoints, 0.09);
      if (!clean) {
        // Erase pass not effective yet — repeat it.
        this.pendingRedraws.shift();
        this.correctionOps++;
        return {
          op: {
            id: 835000 + this.correctionOps,
            kind: 'utility',
            stage: 'correction',
            instrument: 'eraser-precision',
            intent: 'complete erase of misplaced contour',
            waypoints: redo.waypoints,
            pressure: 0.72,
            speed: 0.85,
            region: -1,
            corrective: true,
            reason: 'residual marks from the misplaced contour — erasing again before redrawing',
            travel: true,
          },
        };
      }
      this.pendingRedraws.shift();
      this.correctionOps++;
      return {
        op: {
          id: 836000 + this.correctionOps,
          kind: 'stroke',
          stage: 'correction',
          instrument: this.pickInstrument('pencil-hb'),
          intent: 'redraw corrected contour',
          waypoints: redo.waypoints,
          pressure: 0.48,
          speed: 0.9,
          region: -1,
          corrective: true,
          reason: 'misplaced contour erased — redrawing at the reference edge',
          travel: true,
        },
      };
    }
    const uncovered = evaluation.uncoveredEdges.filter((e) => e.strength > 0.6).slice(0, 12);
    for (const edge of uncovered) {
      const near = ctx.media.grid.opsNear(edge.x, edge.y, 7 * this.scene.scale);
      const wrongId = [...near].find((id) => this.opStraysFromRef(ctx, id, edge));
      if (wrongId !== undefined) {
        const waypoints = this.opWaypoints(wrongId);
        if (waypoints) {
          // Queue the corrected contour (nearest reference chain to the edge).
          const chain = this.nearestChain(edge.x, edge.y);
          if (chain) {
            this.pendingRedraws.push({
              waypoints: chain.points.map((p) => ({ x: p.x * this.scene.scale, y: p.y * this.scene.scale })),
              intent: 'redraw corrected contour',
            });
          }
          this.correctionOps++;
          return {
            op: {
              id: 830000 + this.correctionOps,
              kind: 'utility',
              stage: 'correction',
              instrument: 'eraser-precision',
              intent: 'erase misplaced contour',
              waypoints,
              pressure: 0.55,
              speed: 0.9,
              region: -1,
              corrective: true,
              reason: `contour near (${edge.x | 0}, ${edge.y | 0}) misses the reference edge — erasing the misplaced line before redrawing`,
              travel: true,
            },
          };
        }
      }
    }

    // Everything resolved?
    if (problems.length === 0) {
      return { advance: true, reason: 'no remaining problems' };
    }
    this.correctionRound++;
    if (this.correctionRound >= 3) {
      return { advance: true, reason: 'correction rounds exhausted' };
    }
    // Nothing actionable at the moment — ask the controller for a fresh
    // evaluation and try again.
    return { advance: true, reason: 'correction pass complete' };
  }

  /** Zig-zag sweep covering a disc (eraser / blender coverage pattern). */
  private discSweep(cx: number, cy: number, radius: number): Vec2[] {
    const pts: Vec2[] = [];
    const rows = Math.max(2, Math.round((radius * 2) / Math.max(3, radius * 0.45)));
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const y = cy - radius + 2 * radius * t;
      const half = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) * radius;
      const left = { x: cx - half, y };
      const right = { x: cx + half, y };
      const row = r % 2 === 0 ? [left, right] : [right, left];
      pts.push(...row);
    }
    return pts;
  }

  private opStraysFromRef(ctx: PlanContext, opId: number, edge: { x: number; y: number }): boolean {
    const waypoints = this.opWaypoints(opId);
    if (!waypoints) return false;
    // The stroke passes near the reference edge but never lands on it.
    let passesNear = false;
    for (const p of waypoints) {
      const d = Math.hypot(p.x - edge.x, p.y - edge.y);
      if (d < 5 * this.scene.scale) passesNear = true;
      if (d < 2.2 * this.scene.scale) return false; // actually aligned
    }
    if (!passesNear) return false;
    return ctx.map.meanDensity(edge.x, edge.y, 2.5) < 0.04;
  }

  private nearestChain(x: number, y: number): { points: Vec2[] } | null {
    let best: { points: Vec2[] } | null = null;
    let bestD = Infinity;
    for (const chain of this.scene.contours) {
      for (const p of chain.points) {
        const d = Math.hypot(p.x * this.scene.scale - x, p.y * this.scene.scale - y);
        if (d < bestD) {
          bestD = d;
          best = chain;
        }
      }
    }
    return best && bestD < 26 * this.scene.scale ? best : null;
  }

  private opWaypoints(opId: number): Vec2[] | null {
    // Controller registers op footprints; the planner asks the spatial index.
    return this.opRegistry?.get(opId) ?? null;
  }

  private opRegistry: Map<number, Vec2[]> | null = null;

  /** The controller injects its op registry so corrections can find strokes. */
  registerOps(registry: Map<number, Vec2[]>) {
    this.opRegistry = registry;
  }

  // ------------------------------------------------------------------ //
  // helpers                                                             //
  // ------------------------------------------------------------------ //

  private regionAt(p: Vec2): number {
    const fx = p.x / this.scene.scale;
    const fy = p.y / this.scene.scale;
    for (const region of this.scene.regions) {
      if (
        fx >= region.bbox.x && fx <= region.bbox.x + region.bbox.w &&
        fy >= region.bbox.y && fy <= region.bbox.y + region.bbox.h
      ) {
        return region.id;
      }
    }
    return -1;
  }

  private pickInstrument(id: InstrumentId): InstrumentId {
    if (this.config.preferredInstrument !== 'auto' && instrument(id).class === instrument(this.config.preferredInstrument).class) {
      return this.config.preferredInstrument;
    }
    return id;
  }

  /** Serializable planning state for checkpoints (spec §11). */
  serialize() {
    return {
      constructionQueue: this.constructionQueue,
      constructionHistory: this.constructionHistory,
      constructionBuilt: this.constructionBuilt,
      eraseQueue: this.eraseQueue,
      refinementIndex: this.refinementIndex,
      explored: [...this.explored],
      eraseBuilt: this.eraseBuilt,
      tonalBlobs: this.tonalBlobs,
      tonalBuilt: this.tonalBuilt,
      tonalIndex: this.tonalIndex,
      hatchVisits: [...this.hatchVisits.entries()],
      detailQueue: this.detailQueue,
      detailBuilt: this.detailBuilt,
      detailPlanned: this.detailPlanned,
      correctionRound: this.correctionRound,
      correctionOps: this.correctionOps,
      redoChains: this.redoChains,
    };
  }

  restore(data: ReturnType<Planner['serialize']>) {
    this.constructionQueue = data.constructionQueue ?? [];
    this.constructionHistory = data.constructionHistory ?? [];
    this.constructionBuilt = data.constructionBuilt ?? false;
    this.eraseQueue = data.eraseQueue ?? [];
    this.refinementIndex = data.refinementIndex ?? 0;
    this.explored = new Set(data.explored ?? []);
    this.eraseBuilt = data.eraseBuilt ?? false;
    this.tonalBlobs = data.tonalBlobs ?? [];
    this.tonalBuilt = data.tonalBuilt ?? false;
    this.tonalIndex = data.tonalIndex ?? 0;
    this.hatchVisits = new Map(data.hatchVisits ?? []);
    this.detailQueue = data.detailQueue ?? [];
    this.detailBuilt = data.detailBuilt ?? false;
    this.detailPlanned = data.detailPlanned ?? 0;
    this.correctionRound = data.correctionRound ?? 0;
    this.correctionOps = data.correctionOps ?? 0;
    this.redoChains = data.redoChains ?? [];
  }
}

/* ---------------------------------------------------------------- */
/* geometry helpers                                                   */
/* ---------------------------------------------------------------- */

function arcPoints(c: Vec2, r: number, a0: number, a1: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return pts;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * 2 * i) / n;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

function overshoot(points: Vec2[], fraction: number): Vec2[] {
  if (points.length < 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  const ext = (p: Vec2, q: Vec2): Vec2 => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const grow = len * fraction;
    return { x: p.x - (dx / len) * grow, y: p.y - (dy / len) * grow };
  };
  return [ext(a, b), ...points, ext(b, a)];
}

function chainLabel(chain: { closed: boolean; length: number }): string {
  return `${chain.closed ? 'closed silhouette' : 'open contour'}, ${Math.round(chain.length)}px`;
}

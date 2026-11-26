import type { InstrumentId, Vec2 } from '../core/types';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import { ADAPTIVE_DEFAULTS, PRESET_TUNING, type AdaptiveConfig } from './config';
import { MEDIA, Pigment, type Mark, type Patch } from './pigment';
import type { Field } from './perception';

interface Choice {
  mark: Mark;
  patch: Patch;
  delta: Float32Array;
  gain: number;
}
export interface Trial {
  mark: Mark;
  gain: number;
}
const CELL = 12;

export class Optimizer {
  readonly settings;
  readonly target: Float32Array;
  readonly trials: Trial[] = [];
  phase = 0;
  phaseStart = 0;
  last: Vec2 | null = null;
  private readonly priority: Float64Array;
  private readonly anchors: Int32Array;
  private readonly nx: number;
  private readonly ny: number;
  private readonly rng: Rng;
  private readonly widthScale: number;
  private readonly weight: Float32Array;
  private readonly lineArt: boolean;
  private readonly goal: Float32Array;
  private readonly trialChange: Float32Array;
  private structuralDone = 0;

  constructor(
    readonly field: Field,
    readonly pigment: Pigment,
    readonly config: AdaptiveConfig,
  ) {
    const overrides = config.adaptive ?? {};
    const preset = overrides.preset ?? 'Automatic';
    const inferred =
      field.kind === 'portrait'
        ? 'Graphite portrait'
        : field.kind === 'line'
          ? 'Manga'
          : field.kind === 'tone'
            ? 'Photorealistic graphite'
            : 'Landscape';
    const tuned = { ...overrides };
    if (preset === 'Automatic') {
      for (const key of ['structure', 'tone', 'features', 'naturalness'] as const)
        if (tuned[key] === ADAPTIVE_DEFAULTS[key]) delete tuned[key];
    }
    this.settings = {
      ...ADAPTIVE_DEFAULTS,
      ...PRESET_TUNING[preset === 'Automatic' ? inferred : preset],
      ...tuned,
    };
    this.lineArt = field.kind === 'line' || ['Manga', 'Line art', 'Technical sketch'].includes(preset);
    this.target = Float32Array.from(field.tone, (t) => 1 - t);
    this.goal = new Float32Array(this.target.length);
    this.trialChange = new Float32Array(this.target.length);
    this.weight = Float32Array.from(
      field.importance,
      (f, i) =>
        0.53 +
        this.settings.tone * 0.58 +
        f * (0.47 + 1.7 * this.settings.features) +
        field.edge[i] * this.settings.structure,
    );
    this.nx = Math.ceil(field.width / CELL);
    this.ny = Math.ceil(field.height / CELL);
    this.priority = new Float64Array(this.nx * this.ny);
    this.anchors = new Int32Array(this.priority.length);
    this.rng = new Rng(config.seed);
    this.widthScale = clamp(Math.max(field.width, field.height) / 340, 0.45, 1.7);
    this.refresh();
  }

  private refresh() {
    const phase = this.phase;
    const key = phase === 2 ? 2 : phase === 3 ? 1 : 0;
    const blur = phase === 2 ? 0.67 : phase === 3 ? 0.25 : 0;
    const factor = phase === 2 ? 0.79 : phase === 3 ? 0.96 : 1;
    for (let i = 0; i < this.goal.length; i++) {
      const edgeGuard = this.field.highlights[i] || this.field.importance[i] > 0.55 ? 0.45 : 1;
      this.goal[i] =
        factor * (this.target[i] + blur * edgeGuard * (1 - this.field.levels[key][i] - this.target[i]));
    }
    this.dirty({ x: 0, y: 0, w: this.field.width, h: this.field.height });
  }

  setPhase(phase: number, count: number) {
    this.phase = phase;
    this.phaseStart = count;
    this.refresh();
  }

  dirty(box: { x: number; y: number; w: number; h: number }) {
    const { width: w, height: h } = this.field,
      d = this.pigment.density;
    const x0 = Math.max(0, Math.floor((box.x - 1) / CELL)),
      y0 = Math.max(0, Math.floor((box.y - 1) / CELL));
    const x1 = Math.min(this.nx, Math.ceil((box.x + box.w + 1) / CELL)),
      y1 = Math.min(this.ny, Math.ceil((box.y + box.h + 1) / CELL));
    for (let by = y0; by < y1; by++)
      for (let bx = x0; bx < x1; bx++) {
        const id = by * this.nx + bx;
        let priority = 0,
          max = 0,
          anchor = 0,
          n = 0;
        for (let y = by * CELL; y < Math.min(h, (by + 1) * CELL); y++)
          for (let x = bx * CELL; x < Math.min(w, (bx + 1) * CELL); x++) {
            const i = y * w + x,
              r = this.goal[i] - d[i];
            const focus =
              this.phase === 1
                ? this.field.edge[i] * 1.9 + this.field.contrast[i] * 2.1
                : this.phase === 2
                  ? 0.66 + 0.52 * this.field.shadows[i]
                  : 0.7 + this.field.importance[i] * 0.57;
            const score = Math.abs(r) * this.weight[i] * focus;
            priority += score * Math.abs(r);
            n++;
            if (score > max) {
              max = score;
              anchor = i;
            }
          }
        this.anchors[id] = anchor;
        const peakWeight = this.phase >= 4 ? 0.58 : this.phase === 1 ? 0.74 : 0.28;
        this.priority[id] = peakWeight * max + (1 - peakWeight) * Math.sqrt(priority / Math.max(1, n));
      }
  }

  serial() {
    return {
      phase: this.phase,
      phaseStart: this.phaseStart,
      last: this.last,
      structuralDone: this.structuralDone,
      rng: this.rng.state(),
      priority: Array.from(this.priority),
      anchors: Array.from(this.anchors),
    };
  }
  restore(data: ReturnType<Optimizer['serial']>) {
    this.setPhase(data.phase, data.phaseStart);
    this.last = data.last;
    this.structuralDone = data.structuralDone;
    this.rng.restore(data.rng);
    this.priority.set(data.priority);
    this.anchors.set(data.anchors);
  }

  private path(x: number, y: number, angle: number, length: number, sign: number, flow: number) {
    const { width: w, height: h, angle: field, coherence } = this.field;
    const points: Vec2[] = [];
    const strides = Math.max(1, Math.min(9, Math.ceil(length / 2.8)));
    let px = x,
      py = y,
      heading = angle;
    const base = this.goal[Math.round(y) * w + Math.round(x)];
    for (let j = 0; j < strides; j++) {
      const ox = px,
        oy = py;
      px = clamp(px + ((Math.cos(heading) * length) / strides) * sign, 0, w - 1);
      py = clamp(py + ((Math.sin(heading) * length) / strides) * sign, 0, h - 1);
      if (Math.hypot(px - ox, py - oy) < 0.12) break;
      const k = Math.round(py) * w + Math.round(px);
      if (j && Math.abs(this.goal[k] - base) > (this.phase <= 2 ? 0.27 : 0.38)) break;
      points.push({ x: px, y: py });
      const angleDelta = field[k] - heading;
      heading += flow * coherence[k] * 0.5 * Math.atan2(Math.sin(2 * angleDelta), Math.cos(2 * angleDelta));
    }
    return points;
  }

  private proposal(p: number, radius: number, length: number, theta: number, instrument: InstrumentId): Mark {
    const x = p % this.field.width,
      y = Math.floor(p / this.field.width);
    const flow = 0.33 + this.settings.naturalness * 0.49;
    const path = [
      ...this.path(x, y, theta, length / 2, -1, flow).reverse(),
      { x, y },
      ...this.path(x, y, theta, length / 2, 1, flow),
    ];
    if (path.length === 1) path.push({ x, y });
    if (this.last) {
      const a = path[0],
        b = path.at(-1)!;
      if (Math.hypot(this.last.x - b.x, this.last.y - b.y) < Math.hypot(this.last.x - a.x, this.last.y - a.y))
        path.reverse();
    }
    return { path, radius, instrument, opacity: 0, phase: this.phase, speed: 0.88 + this.rng.next() * 0.27 };
  }

  private test(mark: Mark, maxStrength?: number): Choice | null {
    const patch = this.pigment.footprint(mark),
      direction = this.pigment.direction(patch);
    const density = this.pigment.density,
      w = this.field.width;
    const edgeBias = this.settings.structure * (this.phase === 1 ? 0.65 : 0.32);
    let dot = 0,
      norm = 0,
      leak = 0;
    for (let i = 0; i < patch.indices.length; i++) this.trialChange[patch.indices[i]] = direction[i];
    for (let j = 0; j < patch.indices.length; j++) {
      const i = patch.indices[j],
        change = direction[j],
        r = this.goal[i] - density[i],
        wt = this.weight[i];
      dot += wt * r * change;
      norm += wt * change * change;
      if (change > 0 && r < 0)
        leak -= r * change * (0.2 + this.config.fidelity * (this.field.highlights[i] ? 1.45 : 0.6));
      if (edgeBias > 0 && this.field.edge[i] > 0.034) {
        const nx = Math.cos(this.field.angle[i] + Math.PI / 2),
          ny = Math.sin(this.field.angle[i] + Math.PI / 2);
        const x = i % w,
          y = Math.floor(i / w),
          a = clamp(y + Math.round(ny), 0, this.field.height - 1) * w + clamp(x + Math.round(nx), 0, w - 1);
        const contrastError = r - (this.goal[a] - density[a]);
        const contrastChange = change - this.trialChange[a];
        dot += edgeBias * contrastChange * contrastError;
        norm += edgeBias * contrastChange * contrastChange;
      }
    }
    for (const i of patch.indices) this.trialChange[i] = 0;
    const cap = (maxStrength ?? MEDIA[mark.instrument].strength) * (0.69 + 0.31 * this.settings.pressure);
    const opacity = clamp((dot - leak) / (norm + 1e-9), 0, cap);
    const gain = 2 * opacity * (dot - leak) - opacity * opacity * norm;
    mark.opacity = opacity;
    this.trials.push({ mark, gain });
    if (opacity < 0.008 || gain < 0.00018) return null;
    return { mark, patch, delta: direction, gain };
  }

  next(count: number): Choice | null {
    const budget = this.config.opBudget;
    let window = count - this.phaseStart;
    this.trials.length = 0;
    if (this.phase === 0) {
      const cap = Math.min(this.lineArt ? 14 : 9, Math.floor(budget * 0.04));
      while (this.structuralDone < Math.min(cap, this.field.contours.length)) {
        const path = this.field.contours[this.structuralDone++];
        const mark = {
          path,
          radius: Math.max(0.6, this.widthScale * 0.8),
          instrument: 'pencil-2h' as const,
          opacity: 0,
          phase: 0,
          speed: 1,
        };
        const candidate = this.test(mark, 0.22);
        if (candidate) return candidate;
      }
      this.setPhase(1, count);
      window = 0;
    }
    const min = Math.max(24, Math.round(Math.max(this.field.width, this.field.height) * 0.21));
    if (
      this.phase === 1 &&
      window >=
        Math.min(Math.round(budget * (this.lineArt ? 0.15 : 0.08)), min * (0.72 + this.config.detailLevel))
    )
      this.setPhase(2, count);
    else if (this.phase === 2 && window >= Math.max(25, Math.min(budget * 0.21, this.priority.length * 0.54)))
      this.setPhase(3, count);
    else if (this.phase === 3 && window >= Math.max(38, Math.min(budget * 0.3, this.priority.length * 0.9)))
      this.setPhase(4, count);
    else if (this.phase === 4 && window >= Math.max(50, budget * 0.65)) this.setPhase(5, count);
    const failCap = this.phase >= 4 ? 14 : 10;
    for (let fail = 0; fail < failCap; fail++) {
      let bestTile = -1,
        rank = 0;
      for (let i = 0; i < this.priority.length; i++) {
        const p = this.anchors[i];
        const d = this.last
          ? Math.abs((p % this.field.width) - this.last.x) +
            Math.abs(Math.floor(p / this.field.width) - this.last.y)
          : 0;
        const preference = 1 + (this.settings.naturalness * 0.23) / (1 + d / 24);
        const score = this.priority[i] * preference;
        if (score > rank) {
          rank = score;
          bestTile = i;
        }
      }
      if (bestTile < 0) break;
      const target = this.anchors[bestTile],
        r = this.goal[target] - this.pigment.density[target];
      const minimum = (0.006 + 0.024 * this.settings.convergence) * (1.48 - 0.68 * this.config.fidelity);
      if (rank < minimum && this.phase >= 4) break;
      const theta =
        this.field.coherence[target] > 0.16
          ? this.field.angle[target]
          : -0.66 + (Math.floor(count / 11) % 4 === 3 ? 1.13 : 0);
      const unit = this.widthScale;
      const maxRadius =
        (this.phase === 1 ? 2.0 : this.phase === 2 ? 19 : this.phase === 3 ? 9.5 : 5.6) * unit;
      const minRadius = Math.max(
        0.48,
        (this.phase <= 1 ? 0.54 : this.phase === 2 ? 3 : this.phase === 3 ? 1.35 : 0.53) * unit,
      );
      const deepShadow = this.field.levels[1][target] < 0.22;
      const instrument: InstrumentId =
        r < 0
          ? this.phase >= 4
            ? 'eraser-precision'
            : 'eraser-kneaded'
          : this.phase === 1 || this.phase >= 4
            ? 'mechanical'
            : this.settings.preset === 'Charcoal'
              ? 'charcoal'
              : deepShadow
                ? 'pencil-6b'
                : this.phase === 2
                  ? 'pencil-4b'
                  : this.field.tone[target] > 0.68
                    ? 'pencil-hb'
                    : 'pencil-2b';
      const reach = (this.phase === 2 ? 7.2 : this.phase === 3 ? 6.2 : 4.8) + this.settings.naturalness * 3.2;
      const specs: Array<[number, number, number, InstrumentId]> = [
        [maxRadius, maxRadius * reach, theta, instrument],
        [maxRadius * 0.59, maxRadius * 0.59 * (reach + 1), theta + 0.12, instrument],
        [
          Math.max(minRadius, maxRadius * 0.3),
          Math.max(minRadius, maxRadius * 0.3) * reach,
          theta - 0.31,
          instrument,
        ],
        [minRadius, Math.max(1.8, minRadius * 4), theta, instrument],
        [Math.max(0.48, minRadius * 0.73), Math.max(0.62, minRadius * 1.1), theta + Math.PI / 2, instrument],
      ];
      if (this.phase >= 3 && this.field.coarseEdge[target] < 0.085 && this.field.contrast[target] < 0.24) {
        const wide = 10.5 * unit;
        specs.push([wide, wide * 4.8, theta, r < 0 ? 'eraser-kneaded' : 'pencil-4b']);
      }
      if (this.phase >= 3 && Math.abs(r) < 0.22 && this.settings.correction > 0.35)
        specs.push([maxRadius * 0.53, maxRadius * 2.1, theta, 'stump']);
      let best: Choice | null = null,
        value = 0;
      for (const [radius, length, angle, tool] of specs) {
        const candidate = this.test(
          this.proposal(target, radius, length, angle, tool),
          r < 0 && tool !== 'stump'
            ? MEDIA[tool].strength * (0.53 + 0.47 * this.settings.correction)
            : undefined,
        );
        if (!candidate) continue;
        const merit =
          candidate.gain /
          Math.pow(Math.max(1, candidate.patch.indices.length), this.phase === 1 ? 0.46 : 0.18);
        if (merit > value) {
          best = candidate;
          value = merit;
        }
      }
      if (best) return best;
      this.priority[bestTile] = 0;
    }
    if (this.phase < 5) {
      this.setPhase(this.phase + 1, count);
      return this.next(count);
    }
    return null;
  }
}

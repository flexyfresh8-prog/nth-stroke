import { brushSvg, clamp, ease, measurePath, mix, paintBrush, surface, tip } from './brush';
import { LiveBrush, type ReferenceAnalysis } from './drawing';
import { nibLength, nibTip, PixelRefinement, type PixelNib } from './pixels';

export type BrushStyle =
  | 'graphite' | 'mechanical' | 'charcoal' | 'ballpoint' | 'fineliner' | 'hatching'
  | 'anime' | 'colored-pencil' | 'digital' | 'oil' | 'watercolor' | 'photorealistic';

export const stages = [
  'Construction', 'Rough sketch', 'Refined linework', 'Base colors', 'Shading', 'Fine details', 'Iterative refinement',
] as const;
export type StageName = typeof stages[number];

export interface Point { x: number; y: number }

export interface Stroke {
  id: string;
  stage: StageName;
  layer: string;
  order: number;
  start: Point;
  end: Point;
  path: Point[];
  controls: [Point, Point];
  brush: BrushStyle;
  size: number;
  color: string;
  opacity: number;
  pressure: number[];
  velocity: number;
  detail?: PixelNib;
  feature?: number;
  material?: 'pencil';
}

export interface DrawingConfig {
  style: BrushStyle;
  strokeBudget: number;
  minBrushSize: number;
  maxBrushSize: number;
  colorAccuracy: number;
  edgePreservation: number;
  textureDetail: number;
  strokeComplexity: number;
  shadingAccuracy: number;
  refinementIterations: number;
  artisticSimplification: number;
  fidelity?: 'exact' | 'artistic';
}

type Phase = 'travel' | 'touch' | 'draw' | 'lift' | 'idle';

export interface DrawingSnapshot {
  completed: number;
  recorded: number;
  progress: number;
  stage: StageName | 'Ready';
  phase: Phase;
  cursor: Point;
  pressure: number;
  currentBrushSize: number;
  elapsedMs: number;
  strokesPerSecond: number;
  running: boolean;
  done: boolean;
  replaying: boolean;
  similarity: number | null;
  exactMetric: boolean;
  counts: Record<StageName, number>;
}

interface Gesture {
  stroke: Stroke;
  lengths: number[];
  travel: number;
  hover: number;
  timing: number[];
  touch: number;
  draw: number;
  lift: number;
  total: number;
  elapsed: number;
  advanced: number;
}

const rest: Point = { x: 0.51, y: 0.54 };

export class DrawingEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlay: CanvasRenderingContext2D;
  private readonly miniature: CanvasRenderingContext2D;
  private analysis: ReferenceAnalysis | null = null;
  private planner: LiveBrush | null = null;
  private referenceStyle: BrushStyle = 'graphite';
  private fidelity: DrawingConfig['fidelity'] = 'exact';
  private exact: PixelRefinement | null = null;
  private legacy = false;
  private history: Stroke[] = [];
  private historyFinished = false;
  private index = 0;
  private active: Gesture | null = null;
  private phase: Phase = 'idle';
  private cursor = rest;
  private pressure = 0;
  private speed = 1;
  private running = false;
  private frame = 0;
  private lastTick = 0;
  private timeCredit = 0;
  private elapsedMs = 0;
  private played = 0;
  private lastMeasure = -Infinity;
  private similarity: number | null = null;
  private samplePaint: ImageData | null = null;
  private sampleScale = 1;
  private overlayScale = 1;
  private counts = this.emptyCounts();
  private onUpdate: (snapshot: DrawingSnapshot) => void = () => undefined;

  constructor(private readonly canvas: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.overlay = overlay.getContext('2d')!;
    this.miniature = surface(1, 1).getContext('2d', { willReadFrequently: true })!;
    this.resetArtwork();
  }

  setUpdateHandler(handler: (snapshot: DrawingSnapshot) => void) {
    this.onUpdate = handler;
  }

  prepare(reference: ReferenceAnalysis | null, config: DrawingConfig, history: Stroke[] = [], finished = false, legacy = false) {
    this.pause(false);
    this.analysis = reference;
    this.fidelity = config.fidelity ?? 'exact';
    this.referenceStyle = config.style;
    this.planner = reference && !legacy ? new LiveBrush(reference, config) : null;
    this.history = [...history];
    this.historyFinished = finished;
    this.legacy = legacy;
    const width = reference?.width ?? 888;
    const height = reference?.height ?? 600;
    const { canvas } = this.overlay;
    this.canvas.width = width;
    this.canvas.height = height;
    this.overlayScale = Math.min(1, 1400 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * this.overlayScale));
    canvas.height = Math.max(1, Math.round(height * this.overlayScale));
    this.miniature.canvas.width = reference?.sample.width ?? 1;
    this.miniature.canvas.height = reference?.sample.height ?? 1;
    this.sampleScale = reference ? Math.max(reference.sample.width, reference.sample.height) / Math.max(width, height) : 1;
    this.resetArtwork();
    this.emit();
  }

  get strokes(): readonly Stroke[] { return this.history; }
  get finished() { return this.historyFinished; }
  get isRunning() { return this.running; }
  get isLegacy() { return this.legacy; }

  get exactPixels() {
    return this.exact?.artwork;
  }

  setSpeed(value: number) {
    this.speed = clamp(value, 0.25, 250);
    this.timeCredit = 0;
  }

  startFresh() {
    if (!this.analysis) return;
    this.pause(false);
    if (!this.legacy) {
      this.history = [];
      this.historyFinished = false;
    }
    this.resetArtwork();
    this.play();
  }

  play() {
    if (this.running || !this.analysis) return;
    if (this.historyFinished && this.index === this.history.length) this.resetArtwork();
    this.running = true;
    this.lastTick = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(update = true) {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.timeCredit = 0;
    if (update) this.emit();
  }

  stop() {
    this.seek(0);
  }

  seek(position: number) {
    this.pause(false);
    const target = clamp(Math.round(position), 0, this.history.length);
    if (target < this.index || (this.active?.advanced ?? 0) > 0 || (target === 0 && this.exact)) this.resetArtwork();
    this.clearOverlay();
    this.active = null;
    while (this.index < target) this.commit(this.history[this.index]);
    this.phase = 'idle';
    this.pressure = 0;
    this.cursor = this.history[this.index - 1]?.end ?? rest;
    this.measure();
    if (this.historyFinished && !this.legacy && this.fidelity === 'exact' && target === this.history.length && this.analysis) {
      this.exact ??= new PixelRefinement(this.ctx, this.analysis);
    }
    this.emit();
  }

  step(direction: number) {
    if (direction < 0 || this.index < this.history.length || this.historyFinished) {
      this.seek(this.index + direction);
      return;
    }
    if (!this.analysis) return;
    this.pause(false);
    const stroke = this.active?.stroke ?? this.choose();
    if (stroke) this.commit(stroke, this.active?.advanced);
    else this.historyFinished = true;
    this.active = null;
    this.phase = 'idle';
    this.clearOverlay();
    this.measure();
    this.emit();
  }

  snapshot(): DrawingSnapshot {
    const completed = this.index;
    const done = this.historyFinished && completed === this.history.length;
    const stroke = this.active?.stroke ?? this.history[completed - 1];
    const replaying = completed < this.history.length || this.historyFinished;
    const budget = this.planner?.budget ?? Math.max(1, this.history.length);
    const artProgress = clamp((completed + (this.active ? this.active.elapsed / this.active.total : 0)) / budget, 0, 0.99);
    const fineProgress = this.exact
      ? 1 - (1 - this.exact.match) * this.exact.artwork.width * this.exact.artwork.height / Math.max(1, this.exact.initialDifference)
      : 0;
    const progress = done ? 1 : this.exact ? 0.76 + 0.235 * fineProgress
      : replaying && this.historyFinished ? Math.min(0.99, completed / Math.max(1, this.history.length))
      : artProgress * (this.fidelity === 'exact' ? 0.76 : 1);
    return {
      completed, recorded: this.history.length, progress, stage: stroke?.stage ?? 'Ready', phase: this.phase,
      cursor: this.cursor, pressure: this.pressure, currentBrushSize: stroke?.size ?? 0, elapsedMs: this.elapsedMs,
      strokesPerSecond: this.elapsedMs > 0 ? this.played / (this.elapsedMs / 1000) : 0,
      running: this.running, done, replaying, similarity: this.exact?.match ?? this.similarity,
      exactMetric: Boolean(this.exact), counts: { ...this.counts },
    };
  }

  private tick = (now: number) => {
    if (!this.running) return;
    const elapsed = clamp(now - this.lastTick, 0, 80);
    this.lastTick = now;
    this.elapsedMs += elapsed;
    this.timeCredit = Math.min(this.timeCredit + elapsed * this.speed, this.speed * 160);
    const frameStarted = performance.now();
    while (this.timeCredit > 0 && performance.now() - frameStarted < 11) {
      if (!this.active) {
        const stroke = this.choose();
        if (!stroke) {
          this.historyFinished = true;
          this.running = false;
          this.phase = 'idle';
          this.pressure = 0;
          this.measure();
          break;
        }
        this.active = this.gesture(stroke);
      }
      const active = this.active;
      const spent = Math.min(this.timeCredit, active.total - active.elapsed);
      active.elapsed += spent;
      this.timeCredit -= spent;
      if (active.elapsed < active.total) break;
      this.commit(active.stroke, active.advanced);
      this.played++;
      this.active = null;
    }
    if (this.active) this.render(this.active);
    else this.clearOverlay();
    if (!this.exact && now - this.lastMeasure >= 300 && (this.index > 0 || this.active)) {
      this.measure();
      this.lastMeasure = now;
    }
    this.emit();
    if (this.running) this.frame = requestAnimationFrame(this.tick);
  };

  private choose() {
    if (this.index < this.history.length) return this.history[this.index];
    if (this.historyFinished || !this.analysis || !this.planner) return;
    if (!this.exact) {
      const stroke = this.planner.next(this.readMiniature(), this.history);
      if (stroke) return stroke;
      if (this.fidelity !== 'exact') return;
      this.exact = new PixelRefinement(this.ctx, this.analysis);
    }
    return this.exact.next(this.cursor, this.index, this.referenceStyle);
  }

  private gesture(stroke: Stroke): Gesture {
    const { width, height } = this.canvas;
    const normalizer = Math.max(width, height);
    const lengths = measurePath(stroke, width, height);
    const distance = Math.hypot(this.cursor.x - stroke.start.x, this.cursor.y - stroke.start.y);
    const previous = this.history[this.index - 1];
    const turnTime = [0];
    let dx = 0, dy = 0;
    for (let i = 1; i < lengths.length; i++) {
      const length = lengths[i] - lengths[i - 1];
      const a = stroke.path[i - 1], b = stroke.path[i];
      const tx = (b.x - a.x) * width / (length || 1), ty = (b.y - a.y) * height / (length || 1);
      const turn = i > 1 ? Math.acos(clamp(tx * dx + ty * dy, -1, 1)) : 0;
      turnTime.push(turnTime[i - 1] + length * (1 + Math.min(2, turn * 1.9)));
      dx = tx; dy = ty;
    }
    const rhythm = 0.5 + 0.5 * Math.sin(stroke.order * 2.39996 + stroke.velocity * 2.1);
    const newArea = !previous || previous.stage !== stroke.stage || distance > 0.21;
    const hover = newArea ? 70 + rhythm * 115 : rhythm * 14;
    const travel = hover + 20 + Math.min(320, Math.sqrt(distance) * 270);
    const velocity = clamp(stroke.velocity, 0.2, 3);
    const touch = (stroke.feature !== undefined ? 15 : 8) + (1 - rhythm) * 17;
    const draw = clamp(turnTime.at(-1)! / normalizer * 2320 / velocity, 63 + 24 * rhythm, 1900);
    const lift = 10 + rhythm * 27;
    return { stroke, lengths, timing: turnTime, travel, hover, touch, draw, lift, total: travel + touch + draw + lift, elapsed: 0, advanced: 0 };
  }

  private render(active: Gesture) {
    this.clearOverlay();
    const { stroke, elapsed, travel, touch, draw, lengths } = active;
    const from = this.history[this.index - 1]?.end ?? rest;
    this.pressure = 0;
    if (elapsed < travel) {
      const t = ease(clamp((elapsed - active.hover) / (travel - active.hover), 0, 1));
      const arc = Math.sin(Math.PI * t) * Math.min(0.033, Math.hypot(stroke.start.x - from.x, stroke.start.y - from.y) * 0.20);
      this.phase = 'travel';
      this.cursor = {
        x: clamp(mix(from.x, stroke.start.x, t) - arc * (stroke.start.y - from.y), 0, 1),
        y: clamp(mix(from.y, stroke.start.y, t) - arc, 0, 1),
      };
      return;
    }
    const t = clamp((elapsed - travel - touch) / draw, 0, 1);
    this.phase = elapsed < travel + touch ? 'touch' : t < 1 ? 'draw' : 'lift';
    const clock = ease(t) * active.timing.at(-1)!;
    let i = 1;
    while (i < active.timing.length - 1 && active.timing[i] < clock) i++;
    const segment = active.timing[i] - active.timing[i - 1];
    const along = segment > 0 ? clamp((clock - active.timing[i - 1]) / segment, 0, 1) : t;
    const fraction = lengths.at(-1)! > 0 ? clamp(mix(lengths[i - 1], lengths[i], along) / lengths.at(-1)!, 0, 1) : t;
    this.pressure = this.phase === 'draw' ? mix(stroke.pressure[i - 1] ?? 0.6, stroke.pressure[i] ?? 0.6, along) : 0;
    if (stroke.detail) {
      const length = nibLength(stroke.detail);
      const brushProgress = stroke.detail.track ? (i - 1 + along) / (length - 1) : fraction;
      const until = Math.floor(brushProgress * length);
      this.ensureExact()?.paintNib(stroke.detail, active.advanced, until);
      active.advanced = until;
      this.cursor = nibTip(stroke.detail, this.canvas.width, this.canvas.height, brushProgress);
    } else {
      paintBrush(this.overlay, stroke, lengths, fraction, this.overlayScale);
      this.cursor = tip(stroke, lengths, fraction);
    }
  }

  private commit(stroke: Stroke, advanced = 0) {
    if (stroke.detail) {
      this.ensureExact()?.paintNib(stroke.detail, advanced, nibLength(stroke.detail));
    } else {
      const lengths = measurePath(stroke, this.canvas.width, this.canvas.height);
      paintBrush(this.ctx, stroke, lengths, 1);
      paintBrush(this.miniature, stroke, lengths, 1, this.sampleScale);
      this.samplePaint = null;
    }
    if (this.index === this.history.length) this.history.push(stroke);
    this.index++;
    this.counts[stroke.stage]++;
    this.cursor = stroke.end;
    this.pressure = 0;
    this.phase = 'lift';
  }

  private ensureExact() {
    if (this.analysis) this.exact ??= new PixelRefinement(this.ctx, this.analysis);
    return this.exact;
  }

  private readMiniature() {
    const { width, height } = this.miniature.canvas;
    return this.samplePaint ??= this.miniature.getImageData(0, 0, width, height);
  }

  private measure() {
    if (!this.analysis || this.exact) return;
    const actual = this.readMiniature().data;
    const target = this.analysis.sample.data;
    let error = 0;
    for (let i = 0; i < target.length; i += 4) {
      error += Math.abs(actual[i] - target[i]) + Math.abs(actual[i + 1] - target[i + 1]) + Math.abs(actual[i + 2] - target[i + 2]);
    }
    this.similarity = 1 - error / (target.length * 0.75 * 255);
  }

  private clearOverlay() {
    this.overlay.clearRect(0, 0, this.overlay.canvas.width, this.overlay.canvas.height);
  }

  private resetArtwork() {
    this.index = 0;
    this.active = null;
    this.exact = null;
    this.phase = 'idle';
    this.cursor = rest;
    this.pressure = 0;
    this.timeCredit = 0;
    this.elapsedMs = 0;
    this.played = 0;
    this.lastMeasure = -Infinity;
    this.similarity = null;
    this.samplePaint = null;
    this.counts = this.emptyCounts();
    this.ctx.fillStyle = this.legacy ? '#eee8dc' : '#fff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.miniature.fillStyle = '#fff';
    this.miniature.fillRect(0, 0, this.miniature.canvas.width, this.miniature.canvas.height);
    this.clearOverlay();
  }

  private emptyCounts() {
    return Object.fromEntries(stages.map((stage) => [stage, 0])) as Record<StageName, number>;
  }

  private emit() { this.onUpdate(this.snapshot()); }
}

export function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const min = Math.floor(seconds / 60);
  return `${String(min).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function exportStrokeSvg(strokes: readonly Stroke[], width: number, height: number, legacy = false) {
  const paths = strokes.filter((stroke) => !stroke.detail).map((stroke) => brushSvg(stroke, width, height)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>NTH Stroke brushwork</title><rect width="100%" height="100%" fill="${legacy ? '#eee8dc' : '#fff'}"/>${paths}</svg>`;
}

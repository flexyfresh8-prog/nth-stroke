import { ContourPicker } from './contours';
import { clamp, mix, surface } from './brush';
import type { BrushStyle, DrawingConfig, Point, StageName, Stroke } from './engine';

const SKETCH: StageName[] = [
  'Construction', 'Rough sketch', 'Refined linework', 'Base colors', 'Shading', 'Fine details', 'Iterative refinement',
];
const BRUSHES: Record<BrushStyle, { width: number; opacity: number; speed: number; hatch: number }> = {
  graphite: { width: 1, opacity: 0.84, speed: 1, hatch: 0.18 },
  mechanical: { width: 0.8, opacity: 0.88, speed: 1.1, hatch: 0.15 },
  charcoal: { width: 1.28, opacity: 0.81, speed: 0.83, hatch: 0.32 },
  ballpoint: { width: 0.89, opacity: 0.84, speed: 1.13, hatch: 0.5 },
  fineliner: { width: 0.85, opacity: 0.95, speed: 1.13, hatch: 0.12 },
  hatching: { width: 0.97, opacity: 0.79, speed: 1.1, hatch: 1 },
  anime: { width: 0.9, opacity: 0.96, speed: 1.12, hatch: 0.08 },
  'colored-pencil': { width: 0.95, opacity: 0.83, speed: 1, hatch: 0.36 },
  digital: { width: 1.18, opacity: 0.96, speed: 1.05, hatch: 0.1 },
  oil: { width: 1.38, opacity: 0.93, speed: 0.8, hatch: 0.1 },
  watercolor: { width: 1.42, opacity: 0.69, speed: 0.82, hatch: 0.08 },
  photorealistic: { width: 1, opacity: 0.95, speed: 1, hatch: 0.04 },
};

const PASSES = [
  { end: 0.025, width: 0.42, length: 4.6, opacity: 0.23, contrast: 0.22 },
  { end: 0.075, width: 0.51, length: 3.7, opacity: 0.42, contrast: 0.21 },
  { end: 0.13, width: 0.58, length: 2.6, opacity: 0.76, contrast: 0.23 },
  { end: 0.50, width: 3.9, length: 4.6, opacity: 1, contrast: 0.18 },
  { end: 0.72, width: 1.9, length: 3.2, opacity: 0.89, contrast: 0.17 },
  { end: 0.93, width: 1.12, length: 2.3, opacity: 0.93, contrast: 0.20 },
  { end: 1, width: 0.75, length: 1.15, opacity: 1, contrast: 0.22 },
];

const gray = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

function randomFrom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ReferenceAnalysis {
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  pixels: ImageData;
  sample: ImageData;
  tone: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
  edge: Float32Array;
  strength: number;
  colors: number;
  seed: string;
}

export function analysisSize(originalWidth: number, originalHeight: number) {
  const scale = Math.min(1, 4096 / Math.max(originalWidth, originalHeight), Math.sqrt(8_388_608 / (originalWidth * originalHeight)));
  return { width: Math.max(1, Math.floor(originalWidth * scale)), height: Math.max(1, Math.floor(originalHeight * scale)) };
}

export function analyzeReference(image: HTMLImageElement, config: DrawingConfig, straight?: ImageData): ReferenceAnalysis {
  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;
  const { width, height } = analysisSize(originalWidth, originalHeight);
  const source = surface(width, height);
  const ctx = source.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = straight ?? ctx.getImageData(0, 0, width, height);
  const sampleScale = Math.min(1, 192 / Math.max(width, height));
  const sw = Math.max(1, Math.round(width * sampleScale));
  const sh = Math.max(1, Math.round(height * sampleScale));
  const low = surface(sw, sh);
  const lowCtx = low.getContext('2d', { willReadFrequently: true })!;
  lowCtx.fillStyle = '#fff';
  lowCtx.fillRect(0, 0, sw, sh);
  lowCtx.drawImage(source, 0, 0, sw, sh);
  const sample = lowCtx.getImageData(0, 0, sw, sh);
  // Release the large temporary canvas as soon as its pixel data has been read.
  source.width = 1;
  source.height = 1;

  const tone = new Float32Array(sw * sh);
  const gx = new Float32Array(tone.length);
  const gy = new Float32Array(tone.length);
  const edge = new Float32Array(tone.length);
  const palette = new Set<number>();
  let hash = 2166136261;
  for (let i = 0; i < pixels.data.length; i++) hash = Math.imul(hash ^ pixels.data[i], 16777619);
  for (const char of JSON.stringify([width, height, config])) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);

  for (let i = 0; i < tone.length; i++) {
    const [r, g, b] = [sample.data[i * 4], sample.data[i * 4 + 1], sample.data[i * 4 + 2]];
    tone[i] = gray(r, g, b) / 255;
    palette.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4));
  }

  let totalEdge = 0;
  for (let i = 0; i < tone.length; i++) {
    const x = i % sw;
    const y = Math.floor(i / sw);
    const left = x > 0 ? i - 1 : i;
    const right = x < sw - 1 ? i + 1 : i;
    const top = y > 0 ? i - sw : i;
    const bottom = y < sh - 1 ? i + sw : i;
    gx[i] = tone[right] - tone[left];
    gy[i] = tone[bottom] - tone[top];
    // Follow the strongest color-channel edge when luminance is nearly flat.
    let magnitude = Math.hypot(gx[i], gy[i]);
    for (let c = 0; c < 3; c++) {
      const dx = (sample.data[right * 4 + c] - sample.data[left * 4 + c]) / 330;
      const dy = (sample.data[bottom * 4 + c] - sample.data[top * 4 + c]) / 330;
      const colorEdge = Math.hypot(dx, dy);
      if (colorEdge <= magnitude) continue;
      gx[i] = dx;
      gy[i] = dy;
      magnitude = colorEdge;
    }
    edge[i] = clamp(magnitude * 1.8, 0, 1);
    totalEdge += edge[i];
  }

  return {
    width, height, originalWidth, originalHeight, pixels, sample, tone, gx, gy, edge,
    strength: totalEdge / edge.length, colors: palette.size, seed: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

interface Candidate {
  path: Point[];
  size: number;
  rgb: number[];
  score: number;
}

export class LiveBrush {
  readonly budget: number;
  private readonly contours: ContourPicker;

  constructor(private readonly reference: ReferenceAnalysis, private readonly config: DrawingConfig) {
    this.contours = new ContourPicker(reference);
    this.budget = clamp(Math.round(config.strokeBudget), 1, 12000);
  }

  next(work: ImageData, history: readonly Stroke[]): Stroke | undefined {
    const order = history.length;
    const previous = history.at(-1);
    const { sample, edge, seed } = this.reference;
    const { width, height, data } = sample;
    const current = work.data;
    const rng = randomFrom((parseInt(seed, 16) ^ Math.imul(order + 1, 0x9e3779b1)) >>> 0);
    const style = BRUSHES[this.config.style];
    const pixelCount = width * height;
    const unit = clamp(Math.sqrt(pixelCount / (Math.min(5000, this.budget) * 0.8)), 0.95, 8);
    const nativeScale = Math.max(this.reference.width, this.reference.height) / Math.max(width, height);
    const last = previous?.end;
    const passStart = previous?.stage ? SKETCH.indexOf(previous.stage) : 0;

    for (let passIndex = Math.max(0, passStart); passIndex < PASSES.length; passIndex++) {
      const pass = PASSES[passIndex];
      if (order >= Math.max(passIndex + 1, Math.round(this.budget * pass.end))) continue;
      if (passIndex < 3) {
        const maximum = Math.min(Math.round(this.budget * pass.end), [12, 54, 130][passIndex]);
        if (order < maximum) {
          const line = this.contours.choose(passIndex, work, history, rng, this.config.style);
          if (line) return line;
        }
        continue;
      }
      const pencil = ['graphite', 'mechanical', 'colored-pencil', 'ballpoint', 'fineliner', 'hatching', 'anime'].includes(this.config.style);
      const hatchAngle = -0.7 + Math.sin(order * 0.31) * 0.24 + (rng() - 0.5) * 0.52 + (passIndex > 3 && rng() < 0.22 ? 1.18 : 0);
      const stayNearby = last && rng() < 0.84;
      let best: Candidate | undefined;
      const anchors: { i: number; score: number }[] = [];
      const offset = Math.floor(rng() * pixelCount);
      const stride = Math.max(1, Math.floor(pixelCount / 180));
      const limit = Math.min(pixelCount, 180);
      for (let i = 0; i < limit + (last ? 58 : 0); i++) {
        let index = (offset + i * stride + Math.floor(rng() * stride)) % pixelCount;
        if (i >= limit && last) {
          const reach = unit * 9;
          const x = clamp(Math.floor(last.x * width + (rng() - 0.5) * reach * 2), 0, width - 1);
          const y = clamp(Math.floor(last.y * height + (rng() - 0.5) * reach * 2), 0, height - 1);
          index = x + y * width;
        }

        const p = index * 4;
        const error = (Math.abs(data[p] - current[p]) + Math.abs(data[p + 1] - current[p + 1]) + Math.abs(data[p + 2] - current[p + 2])) / 765;
        const lightPaper = pencil && this.reference.tone[index] > 0.92 && edge[index] < 0.08;
        if (error < (lightPaper ? 0.085 : 0.025)) continue;
        let locality = 0;
        if (last) {
          const distance = Math.hypot(index % width + 0.5 - last.x * width, Math.floor(index / width) + 0.5 - last.y * height);
          locality = (stayNearby ? 8 : 0.45) * Math.exp(-distance / Math.max(4, unit * 7));
        }
        const edgeWeight = 1 + edge[index] * this.config.edgePreservation * 0.45;
        anchors.push({ i: index, score: error * edgeWeight * (1 + locality) });
      }
      anchors.sort((a, b) => b.score - a.score);
      for (const anchor of anchors.slice(0, 15)) {
        const angle = pencil && edge[anchor.i] < 0.42 ? hatchAngle : this.angleAt(anchor.i, passIndex, order, style.hatch);
        const edgeFactor = passIndex < 3 ? 1 : 1 - edge[anchor.i] * this.config.edgePreservation * 0.57;
        const pencilWidth = passIndex === 3 ? 0.57 : 0.47;
        const size = Math.max(0.46, unit * pass.width * style.width * edgeFactor * (pencil ? pencilWidth : 1) * mix(0.85, 1.18, rng()));
        const length = unit * pass.length * (pencil ? 1.85 : 1.35) * mix(0.72, 1.35, this.config.strokeComplexity) * mix(0.73, 1.25, rng());
        const path = this.trace(anchor.i, angle, length, passIndex, pass.contrast, rng);
        const opacity = pass.opacity * style.opacity;
        const candidate = this.fit(path, current, size, opacity, passIndex, anchor.score);
        if (candidate && (!best || candidate.score > best.score)) best = candidate;
      }
      if (!best) continue;
      const { path, size, rgb } = best;
      const weight = 0.63 + rng() * 0.31;
      const attack = mix(0.06, 0.20, rng());
      const release = mix(0.11, 0.34, rng());
      const attackPow = mix(0.55, 0.95, rng());
      const releasePow = mix(0.50, 0.85, rng());
      const driftFreq = 1.2 + rng() * 2.4;
      const driftPhase = rng() * 6.28318;
      const driftAmp = 0.05 + rng() * 0.11;
      const dip = 0.08 + rng() * 0.16;
      const dipPos = 0.25 + rng() * 0.5;
      const dipWidth = 0.06 + rng() * 0.14;
      let wobble = 0, wobbleTarget = 0;
      const normalized = path.map(({ x, y }) => ({ x: x / width, y: y / height }));
      if (last && Math.hypot((last.x - normalized[0].x) * width, (last.y - normalized[0].y) * height) >
        Math.hypot((last.x - normalized.at(-1)!.x) * width, (last.y - normalized.at(-1)!.y) * height)) normalized.reverse();
      const start = normalized[0];
      const end = normalized.at(-1)!;
      const stage = SKETCH[passIndex];
      return {
        id: `s-${order + 1}`, order, stage, layer: stage.toLowerCase(), start, end, path: normalized, controls: [start, end],
        material: pencil ? 'pencil' : undefined,
        brush: this.config.style, size: size * nativeScale, color: hex(rgb), opacity: pass.opacity * style.opacity,
        pressure: normalized.map((_, i) => {
          const t = i / (normalized.length - 1);
          if (i % 3 === 0) wobbleTarget = (rng() - 0.5) * 0.12;
          wobble += (wobbleTarget - wobble) * 0.5;
          // Human pressure: slow asymmetric attack, wandering body, quick lift.
          const envelope = t < attack ? Math.pow(t / attack, attackPow)
            : t > 1 - release ? Math.pow(Math.max(0, (1 - t) / release), releasePow) : 1;
          const drift = Math.sin(t * driftFreq * Math.PI + driftPhase) * driftAmp;
          const hesitation = dip * Math.exp(-((t - dipPos) ** 2) / (2 * dipWidth * dipWidth + 1e-6));
          return clamp(0.10 + weight * envelope + drift + wobble - hesitation, 0.05, 1);
        }),
        velocity: style.speed * mix(0.72, 1.52, rng()),
      };
    }
  }

  private angleAt(index: number, pass: number, order: number, hatch: number) {
    const { gx, gy, edge } = this.reference;
    const jitter = ((Math.imul(index + 1, 0x85ebca6b) >>> 16) / 65536 - 0.5) * 0.42;
    const sweep = -0.48 + Math.sin(order * 0.37) * 0.2 + jitter;
    if (edge[index] < 0.065) return sweep;
    const tangent = Math.atan2(gy[index], gx[index]) + Math.PI / 2;
    return pass === 4 ? tangent + hatch * (Math.sin(order * 1.7) > 0 ? -0.65 : 0.65) + jitter * 0.6 : tangent + jitter * 0.6;
  }

  private trace(index: number, angle: number, length: number, pass: number, contrast: number, rng: () => number): Point[] {
    const { sample, tone, gx, gy, edge } = this.reference;
    const { width, height, data } = sample;
    const center = { x: index % width + 0.5, y: Math.floor(index / width) + 0.5 };
    const stepBase = clamp(length / 8, 0.55, 2.6);
    // A hand never moves in uniform strides: vary the step length, let the
    // direction drift smoothly, and let the whole line wander sideways.
    const wobbleAmp = (pass < 3 ? 0.34 : 0.20) * stepBase;
    let wob = 0;
    let wobTarget = (rng() - 0.5) * wobbleAmp;
    const driftFreq = 0.5 + rng() * 1.1;
    const driftPhase = rng() * 6.28318;
    const driftAmp = 0.04 + rng() * 0.07;
    const traceSide = (direction: number) => {
      const points: Point[] = [];
      let point = center;
      let dx = Math.cos(angle) * direction;
      let dy = Math.sin(angle) * direction;
      for (let i = 0; i < Math.ceil(length / stepBase / 2) + 1; i++) {
        const step = stepBase * (0.62 + rng() * 0.76);
        if (i % 2 === 0) wobTarget = (rng() - 0.5) * wobbleAmp;
        wob += (wobTarget - wob) * 0.42;
        const turn = Math.sin(i * driftFreq + driftPhase) * driftAmp * (i > 1 ? 1 : 0.4) + (rng() - 0.5) * 0.05;
        const cos = Math.cos(turn), sin = Math.sin(turn);
        const rx = dx * cos - dy * sin;
        const ry = dx * sin + dy * cos;
        const norm = Math.hypot(rx, ry) || 1;
        const ux = rx / norm, uy = ry / norm;
        const next = { x: point.x + ux * step - uy * wob, y: point.y + uy * step + ux * wob };
        if (next.x < 0.18 || next.y < 0.18 || next.x > width - 0.18 || next.y > height - 0.18) break;
        const j = Math.floor(next.x) + Math.floor(next.y) * width;
        if (pass < 3 && i > 0 && edge[j] < 0.085) break;
        if (pass >= 3) {
          const delta = Math.max(...[0, 1, 2].map((c) => Math.abs(data[index * 4 + c] - data[j * 4 + c]))) / 255;
          if (delta > contrast || Math.abs(tone[j] - tone[index]) > contrast * 0.8) break;
        }
        points.push(next);
        point = next;
        if (edge[j] < 0.09 || (pass === 3 && edge[j] < 0.22)) continue;
        const orientation = Math.atan2(gy[j], gx[j]) + Math.PI / 2;
        const tx = Math.cos(orientation);
        const ty = Math.sin(orientation);
        const sign = tx * ux + ty * uy < 0 ? -1 : 1;
        const steer = pass < 3 ? 0.62 : 0.36;
        const vx = mix(ux, tx * sign, steer);
        const vy = mix(uy, ty * sign, steer);
        const vnorm = Math.hypot(vx, vy);
        dx = vx / vnorm;
        dy = vy / vnorm;
      }
      return points;
    };
    const path = [...traceSide(-1).reverse(), center, ...traceSide(1)];
    if (path.length < 2) path.push({ x: center.x + 0.12, y: center.y });
    return path;
  }

  private fit(path: Point[], current: Uint8ClampedArray, size: number, opacity: number, pass: number, priority: number): Candidate | undefined {
    const { sample } = this.reference;
    const { width, height, data } = sample;
    const sites: number[] = [];
    const rgb = [0, 0, 0];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const neighbor = path[i === 0 ? 1 : i - 1];
      const distance = Math.hypot(p.x - neighbor.x, p.y - neighbor.y) || 1;
      const nx = (p.y - neighbor.y) / distance;
      const ny = (neighbor.x - p.x) / distance;
      for (const offset of size > 1.6 ? [-0.36, 0, 0.36] : [0]) {
        const x = clamp(Math.floor(p.x + nx * offset * size), 0, width - 1);
        const y = clamp(Math.floor(p.y + ny * offset * size), 0, height - 1);
        const index = (x + y * width) * 4;
        sites.push(index);
        for (let c = 0; c < 3; c++) rgb[c] += data[index + c];
      }
    }
    for (let c = 0; c < 3; c++) rgb[c] /= sites.length;
    if (this.config.fidelity === 'artistic' && ['graphite', 'charcoal', 'mechanical', 'fineliner', 'hatching', 'ballpoint'].includes(this.config.style)) {
      const graphite = gray(rgb[0], rgb[1], rgb[2]);
      for (let c = 0; c < 3; c++) rgb[c] = graphite;
    }
    let gain = 0;
    for (const index of sites) {
      for (let c = 0; c < 3; c++) {
        const before = current[index + c];
        const target = data[index + c];
        const after = mix(before, rgb[c], opacity);
        gain += Math.abs(target - before) - Math.abs(target - after);
      }
    }
    if (gain < sites.length * (pass < 3 ? 0.9 : 1.6)) return;
    return { path, size, rgb, score: gain / Math.sqrt(sites.length) * (0.5 + priority) };
  }
}

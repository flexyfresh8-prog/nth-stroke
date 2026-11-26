import { gaussian, gradient } from './perception';

export interface Accuracy {
  ssim: number;
  msSsim: number;
  mae: number;
  precision: number;
  recall: number;
  alignment: number;
  contrast: number;
  features: number;
}

export function resample(data: Float32Array, w: number, h: number, width: number, height: number) {
  if (w === width && h === height) return data;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * w) / width),
        y0 = Math.floor((y * h) / height);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / width)),
        y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / height));
      let sum = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) sum += data[j * w + i];
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  return out;
}

function similarity(a: Float32Array, b: Float32Array, w: number, h: number) {
  const n = a.length,
    aa = new Float32Array(n),
    bb = new Float32Array(n),
    ab = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    aa[i] = a[i] * a[i];
    bb[i] = b[i] * b[i];
    ab[i] = a[i] * b[i];
  }
  const [ma, mb, va, vb, cov] = [a, b, aa, bb, ab].map((v) => gaussian(gaussian(v, w, h, 1), w, h, 1));
  let s = 0,
    l = 0,
    c = 0;
  for (let i = 0; i < n; i++) {
    const u = ma[i],
      v = mb[i];
    const luminance = (2 * u * v + 0.0001) / (u * u + v * v + 0.0001);
    const structure =
      (2 * (cov[i] - u * v) + 0.0009) / (Math.max(0, va[i] - u * u) + Math.max(0, vb[i] - v * v) + 0.0009);
    s += luminance * structure;
    l += luminance;
    c += structure;
  }
  return { ssim: s / n, luminance: l / n, structure: c / n };
}

export function measure(
  actual: Float32Array,
  target: Float32Array,
  w: number,
  h: number,
  importance?: Float32Array,
): Accuracy {
  const aEdge = gradient(actual, w, h),
    bEdge = gradient(target, w, h);
  function matching(source: Float32Array, other: Float32Array) {
    let count = 0,
      match = 0,
      deviation = 0;
    for (let p = 0; p < source.length; p++) {
      if (source[p] < 0.08) continue;
      count++;
      const x = p % w,
        y = Math.floor(p / w);
      let d = 3;
      for (let j = Math.max(0, y - 2); j <= Math.min(h - 1, y + 2); j++)
        for (let i = Math.max(0, x - 2); i <= Math.min(w - 1, x + 2); i++)
          if (other[j * w + i] >= 0.08) d = Math.min(d, Math.hypot(i - x, j - y));
      if (d <= 2) {
        match++;
        deviation += d;
      } else deviation += 3;
    }
    return { rate: count ? match / count : 1, distance: count ? deviation / (3 * count) : 0 };
  }
  const p = matching(aEdge, bEdge),
    r = matching(bEdge, aEdge);
  let mae = 0,
    contrast = 0,
    weighted = 0,
    weight = 0;
  for (let i = 0; i < actual.length; i++) {
    const error = Math.abs(actual[i] - target[i]),
      focus = importance?.[i] ?? bEdge[i];
    mae += error;
    contrast += Math.abs(aEdge[i] - bEdge[i]);
    weight += focus;
    weighted += error * focus;
  }
  const first = similarity(actual, target, w, h);
  let ms = 1;
  let a = actual,
    b = target;
  const weights = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];
  for (let i = 0; i < weights.length; i++) {
    const score = i ? similarity(a, b, w, h) : first;
    const last = i === weights.length - 1 || Math.min(w, h) < 4;
    const exp = last ? weights.slice(i).reduce((sum, v) => sum + v, 0) : weights[i];
    ms *= Math.max(0, score.structure) ** exp;
    if (last) {
      ms *= Math.max(0, score.luminance) ** exp;
      break;
    }
    const width = Math.ceil(w / 2),
      height = Math.ceil(h / 2);
    a = resample(gaussian(a, w, h, 1), w, h, width, height);
    b = resample(gaussian(b, w, h, 1), w, h, width, height);
    w = width;
    h = height;
  }
  return {
    ssim: Math.max(0, Math.min(1, first.ssim)),
    msSsim: Math.min(1, ms),
    mae: mae / actual.length,
    precision: p.rate,
    recall: r.rate,
    alignment: 1 - (p.distance + r.distance) / 2,
    contrast: contrast / actual.length,
    features: 1 - (weight > 0 ? weighted / weight : mae / actual.length),
  };
}

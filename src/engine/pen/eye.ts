// The V4 Virtual Eye (spec §8): a multiscale observation system built from
// classical computer vision only — no learning, no models. It inspects the
// composition globally before local details and maintains the structural map
// the brain draws from.
//
// Pipeline (each phase yields so the worker stays responsive):
//   1. subject isolation — region-graph segmentation with border/seeds
//      classification (Felzenszwalb–Huttenlocher style, shared with V3)
//   2. composition — PCA axes, symmetry sweep, dominant directions, masses
//   3. contours — level-set regions (marching squares) + hysteresis edge
//      chains at two scales, with confidence and importance
//   4. structure — distance transform, skeleton (medial branches + radii),
//      structure-tensor orientation field, light direction estimate
//   5. tone — darkness percentiles → five tonal zones, hatching masks
//   6. attention — saliency (centre–surround + edge energy) → attention map

import { darkness, edgeChains, isolate, regions, structure as structureRegion } from '../structural/analysis';
import { reduce, type Plane, type Source } from '../structural/source';
import type { P, SimOptions } from './types';

export interface ContourInfo {
  /** Flat polyline in WORKING-canvas coordinates. */
  pts: Float32Array;
  importance: number;
  confidence: number;
  closed: boolean;
  meanTone: number;
  scale: number;
}

export interface SkeletonBranch {
  pts: Float32Array; // work coords
  radius: number; // mean medial radius (work px)
}

export interface ZoneComponent {
  zone: number; // 1 lightest shade .. 4 darkest
  box: [number, number, number, number]; // hatch-plane px
  cx: number;
  cy: number;
  area: number;
}

export interface EyeResult {
  source: Source;
  work: { w: number; h: number };
  /** Subject mask (128-plane) + query in work coords. */
  subjectMask: Uint8Array;
  maskW: number;
  maskH: number;
  subjectAt: (x: number, y: number) => boolean;
  coverage: number;
  axes: { major: number; minor: number; cx: number; cy: number; spread: number };
  symmetry: { angle: number; score: number };
  light: { dx: number; dy: number; strength: number };
  masses: { cx: number; cy: number; weight: number }[];
  contours: ContourInfo[];
  detailContours: ContourInfo[];
  skeleton: SkeletonBranch[];
  distance: { field: Float32Array; w: number; h: number }; // analysis plane
  orientationAt: (x: number, y: number) => { theta: number; coherence: number };
  tonePlane: Plane; // evaluation-resolution reference tone
  zones: { cuts: number[]; plane: Plane; components: ZoneComponent[]; zoneAt: (x: number, y: number) => number };
  attention: { points: P[]; at: (x: number, y: number) => number };
  gesture: { axisStrokes: Float32Array[]; envelopes: Float32Array[] };
  summary: string[];
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Connected-component labelling (4-connected, iterative flood). */
export function label(mask: Uint8Array | Int32Array, w: number, h: number, test: (v: number) => boolean) {
  const labels = new Int32Array(w * h).fill(0);
  const comps: { id: number; area: number; cx: number; cy: number; box: [number, number, number, number] }[] = [];
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || !test(mask[start])) continue;
    const id = next++;
    let area = 0,
      sx = 0,
      sy = 0,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w,
        y = (i / w) | 0;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const visit = (j: number) => {
        if (!labels[j] && test(mask[j])) {
          labels[j] = id;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    comps.push({ id, area, cx: sx / area, cy: sy / area, box: [x0, y0, x1 + 1, y1 + 1] });
  }
  return { labels, comps };
}

/** Two-pass chamfer distance transform (weights 1, √2), inside mask. */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) v = Math.min(v, d[i - w] + 1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + D2);
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + D2);
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) v = Math.min(v, d[i + w] + 1);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + D2);
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + D2);
      d[i] = v;
    }
  return d;
}

/** Zhang–Suen thinning; returns the skeleton mask. */
export function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const m = Uint8Array.from(mask);
  let changed = true;
  const neighbours = (i: number, x: number, y: number) => {
    const p = [
      m[i - w],
      x < w - 1 ? m[i - w + 1] : 0,
      x < w - 1 ? m[i + 1] : 0,
      y < h - 1 ? m[i + w + 1] : 0,
      y < h - 1 ? m[i + w] : 0,
      x > 0 && y < h - 1 ? m[i + w - 1] : 0,
      x > 0 ? m[i - 1] : 0,
      x > 0 && y > 0 ? m[i - w - 1] : 0,
    ];
    let sum = 0,
      trans = 0;
    for (let k = 0; k < 8; k++) {
      if (p[k]) sum++;
      if (p[k] && !p[(k + 1) % 8]) trans++;
    }
    return { sum, trans, p };
  };
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const del: number[] = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const { sum, trans, p } = neighbours(i, x, y);
          if (sum < 2 || sum > 6 || trans !== 1) continue;
          if (step === 0) {
            if (p[0] && p[2] && p[4]) continue;
            if (p[2] && p[4] && p[6]) continue;
          } else {
            if (p[0] && p[2] && p[6]) continue;
            if (p[0] && p[4] && p[6]) continue;
          }
          del.push(i);
        }
      if (del.length) {
        changed = true;
        for (const i of del) m[i] = 0;
      }
    }
  }
  return m;
}

/** Trace medial branches between junctions/endpoints; prune short spurs. */
function skeletonBranches(skel: Uint8Array, dist: Float32Array, w: number, h: number, minLen: number) {
  const deg = new Uint8Array(w * h);
  const idx = (x: number, y: number) => y * w + x;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      if (!skel[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && skel[idx(x + dx, y + dy)]) n++;
      deg[i] = n;
    }
  const visited = new Uint8Array(w * h);
  const branches: { pts: P[]; radius: number }[] = [];
  const trace = (sx: number, sy: number, fx: number, fy: number) => {
    const pts: P[] = [[fx + 0.5, fy + 0.5]];
    let cx = fx,
      cy = fy,
      px = sx,
      py = sy;
    let rSum = dist[idx(cx, cy)],
      n = 1;
    while (true) {
      pts.push([cx + 0.5, cy + 0.5]);
      visited[idx(cx, cy)] = 1;
      rSum += dist[idx(cx, cy)];
      n++;
      let nx = -1,
        ny = -1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const ax = cx + dx,
            ay = cy + dy;
          if (ax === px && ay === py) continue;
          const j = idx(ax, ay);
          if (skel[j] && !visited[j] && deg[j] <= 2) {
            nx = ax;
            ny = ay;
          }
        }
      if (nx < 0) break;
      px = cx;
      py = cy;
      cx = nx;
      cy = ny;
      if (pts.length > 4000) break;
    }
    return { pts, radius: rSum / n };
  };
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      if (!skel[i] || visited[i]) continue;
      if (deg[i] === 1) {
        // endpoint: walk inward
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const j = idx(x + dx, y + dy);
            if ((dx || dy) && skel[j] && !visited[j]) branches.push(trace(x, y, x + dx, y + dy));
          }
      } else if (deg[i] === 2) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const j = idx(x + dx, y + dy);
            if ((dx || dy) && skel[j] && !visited[j]) branches.push(trace(x, y, x + dx, y + dy));
          }
      }
      visited[i] = 1;
    }
  return branches.filter((b) => b.pts.length >= minLen);
}

export function analyzeEye(
  source: Source,
  options: SimOptions,
  work: { w: number; h: number },
  onProgress?: (phase: string, progress: number) => void,
) {
  const summary: string[] = [];
  const kw = work.w,
    kh = work.h; // working canvas scale factors
  const toWorkX = (planeW: number) => kw / planeW;
  const toWorkY = (planeH: number) => kh / planeH;

  // ---- phase 1: subject isolation -----------------------------------------
  onProgress?.('Isolating the subject', 0.05);
  const seg = isolate(source, options.sensitivity, []);
  let coverage = 0;
  for (const v of seg.mask) coverage += v;
  coverage /= seg.mask.length;
  const subjectOk = coverage > 0.012 && coverage < 0.85;
  const subjectMask = subjectOk ? seg.mask : new Uint8Array(seg.mask.length).fill(1);
  if (!subjectOk) summary.push('subject isolation ambiguous — treating the full frame as subject');
  else summary.push(`subject ${Math.round(coverage * 100)}% of frame, ${seg.component} regions`);
  const subjectAt = (x: number, y: number) => {
    const sx = (x * source.w) / kw,
      sy = (y * source.h) / kh;
    return seg.subject(sx, sy);
  };

  // ---- phase 2: composition ------------------------------------------------
  const maskPlane: Plane = { w: seg.w, h: seg.h, gray: new Uint8Array(seg.w * seg.h) };
  for (let i = 0; i < subjectMask.length; i++) maskPlane.gray[i] = subjectMask[i] ? 255 : 0;
  let n = 0,
    sx = 0,
    sy = 0,
    xx = 0,
    yy = 0,
    xy = 0;
  for (let y = 0; y < seg.h; y++)
    for (let x = 0; x < seg.w; x++)
      if (subjectMask[y * seg.w + x]) {
        n++;
        sx += x;
        sy += y;
      }
  const cx = n ? sx / n : seg.w / 2,
    cy = n ? sy / n : seg.h / 2;
  for (let y = 0; y < seg.h; y++)
    for (let x = 0; x < seg.w; x++)
      if (subjectMask[y * seg.w + x]) {
        xx += (x - cx) ** 2;
        yy += (y - cy) ** 2;
        xy += (x - cx) * (y - cy);
      }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const axes = { major: theta, minor: theta + Math.PI / 2, cx, cy, spread: n ? Math.sqrt((xx + yy) / n) : seg.w / 4 };

  // symmetry sweep on a 64-plane
  const symPlane = reduce(maskPlane, 64);
  let symScore = 0,
    symAngle = 0;
  {
    let m = 0,
      mx = 0,
      my = 0;
    for (let y = 0; y < symPlane.h; y++)
      for (let x = 0; x < symPlane.w; x++)
        if (symPlane.gray[y * symPlane.w + x] > 127) {
          m++;
          mx += x;
          my += y;
        }
    if (m > 8) {
      mx /= m;
      my /= m;
      let best = 0;
      for (let a = 0; a < Math.PI; a += Math.PI / 36) {
        const u = Math.cos(a),
          v = Math.sin(a);
        let hit = 0,
          total = 0;
        for (let y = 0; y < symPlane.h; y++)
          for (let x = 0; x < symPlane.w; x++)
            if (symPlane.gray[y * symPlane.w + x] > 127) {
              total++;
              // mirror of (x,y) about line through (mx,my) direction (u,v)
              const dx = x - mx,
                dy = y - my;
              const along = dx * u + dy * v;
              const px = dx - along * u,
                py = dy - along * v;
              const qx = Math.round(mx + along * u - px),
                qy = Math.round(my + along * v - py);
              if (qx >= 0 && qy >= 0 && qx < symPlane.w && qy < symPlane.h && symPlane.gray[qy * symPlane.w + qx] > 127) hit++;
            }
        const score = total ? hit / total : 0;
        if (score > best) {
          best = score;
          symAngle = a;
        }
      }
      symScore = best;
    }
  }
  if (symScore > 0.7) summary.push(`symmetry axis ${(symAngle * 180) / Math.PI}° score ${symScore.toFixed(2)}`);

  // ---- phase 3: analysis planes & contours --------------------------------
  onProgress?.('Observing structure', 0.3);
  const analysisLimit = Math.min(384, Math.max(192, Math.round(kw / 3)));
  const plane = reduce(source, analysisLimit);
  const dark = darkness(plane, true);
  const kxa = toWorkX(plane.w),
    kya = toWorkY(plane.h);

  // tonal percentiles inside the subject for level selection
  const hist = new Uint32Array(256);
  let inside = 0;
  for (let i = 0; i < dark.length; i++) {
    const ax = i % plane.w,
      ay = (i / plane.w) | 0;
    const mx = clamp(((ax * seg.w) / plane.w) | 0, 0, seg.w - 1),
      my = clamp(((ay * seg.h) / plane.h) | 0, 0, seg.h - 1);
    if (subjectMask[my * seg.w + mx]) {
      hist[Math.min(255, (dark[i] * 255) | 0)]++;
      inside++;
    }
  }
  const pct = (p: number) => {
    let acc = 0,
      v = 0;
    const target = inside * p;
    while (v < 255 && acc < target) acc += hist[v++];
    return v / 255;
  };
  const p85 = pct(0.85),
    p60 = pct(0.6),
    p40 = pct(0.4),
    p20 = pct(0.2);
  // eight cumulative shading levels (percentiles of subject darkness)
  const zoneCuts = [0.14, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86].map((q) => pct(q));

  const contours: ContourInfo[] = [];
  const pushRegion = (level: number, scaleBias: number) => {
    const shapes = regions(dark, plane.w, plane.h, level, 0.35 + 0.5 * options.continuity);
    for (const r of shapes.slice(0, 26)) {
      if (r.area < 3 || r.perimeter < 14) continue;
      const ring = r.pts[0];
      const pts = new Float32Array(ring.length * 2 + 2);
      for (let i = 0; i < ring.length; i++) {
        pts[2 * i] = ring[i][0] * kxa;
        pts[2 * i + 1] = ring[i][1] * kya;
      }
      pts[ring.length * 2] = ring[0][0] * kxa;
      pts[ring.length * 2 + 1] = ring[0][1] * kya;
      contours.push({
        pts,
        importance: r.perimeter * (0.35 + level) * scaleBias,
        confidence: Math.min(1, 0.4 + level),
        closed: true,
        meanTone: 1 - level,
        scale: analysisLimit,
      });
    }
  };
  pushRegion(Math.max(0.2, p60), 1.15);
  pushRegion(Math.max(0.45, p85), 1.35);
  pushRegion(Math.max(0.08, p20), 0.8);

  const chains = edgeChains(plane, options.sensitivity);
  for (const chain of chains) {
    if (chain.length < 10) continue;
    const pts = new Float32Array(chain.length * 2);
    for (let i = 0; i < chain.length; i++) {
      pts[2 * i] = chain[i][0] * kxa;
      pts[2 * i + 1] = chain[i][1] * kya;
    }
    contours.push({
      pts,
      importance: chain.length * 1.6,
      confidence: Math.min(1, chain.length / 40),
      closed: false,
      meanTone: 0.4,
      scale: analysisLimit,
    });
  }
  contours.sort((a, b) => b.importance - a.importance);
  summary.push(`${contours.length} structural contours at ${plane.w}×${plane.h}`);

  // ---- phase 4: skeleton, distance, orientation, light --------------------
  onProgress?.('Measuring form', 0.55);
  const skelPlane = reduce(maskPlane, 200);
  const skelMask = new Uint8Array(skelPlane.w * skelPlane.h);
  for (let i = 0; i < skelMask.length; i++) skelMask[i] = skelPlane.gray[i] > 127 ? 1 : 0;
  const dist = distanceTransform(skelMask, skelPlane.w, skelPlane.h);
  const skel = thin(skelMask, skelPlane.w, skelPlane.h);
  const rawBranches = skeletonBranches(skel, dist, skelPlane.w, skelPlane.h, 7);
  const ksx = toWorkX(skelPlane.w),
    ksy = toWorkY(skelPlane.h);
  const skeleton: SkeletonBranch[] = rawBranches
    .sort((a, b) => b.pts.length - a.pts.length)
    .slice(0, 24)
    .map((b) => ({
      pts: new Float32Array(b.pts.flat().map((v, i) => (i % 2 ? v * ksy : v * ksx))),
      radius: b.radius * ((ksx + ksy) / 2),
    }));
  summary.push(`${skeleton.length} medial branches`);

  // structure-tensor orientation field on the analysis plane (grid step 4)
  const step = 4,
    ow = Math.ceil(plane.w / step),
    oh = Math.ceil(plane.h / step);
  const oTheta = new Float32Array(ow * oh),
    oCoh = new Float32Array(ow * oh);
  for (let gy = 0; gy < oh; gy++)
    for (let gx = 0; gx < ow; gx++) {
      const px = gx * step,
        py = gy * step;
      let jxx = 0,
        jyy = 0,
        jxy = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = clamp(px + dx, 1, plane.w - 2),
            y = clamp(py + dy, 1, plane.h - 2);
          const i = y * plane.w + x;
          const gxv = dark[i + 1] - dark[i - 1],
            gyv = dark[i + plane.w] - dark[i - plane.w];
          jxx += gxv * gxv;
          jyy += gyv * gyv;
          jxy += gxv * gyv;
        }
      const tr = jxx + jyy;
      const t = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
      oTheta[gy * ow + gx] = t + Math.PI / 2; // stroke direction ≡ ⊥ gradient
      oCoh[gy * ow + gx] = tr > 1e-6 ? Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * 2) / tr : 0;
    }
  const orientationAt = (x: number, y: number) => {
    const ax = clamp((x / kxa / step) | 0, 0, ow - 1),
      ay = clamp((y / kya / step) | 0, 0, oh - 1);
    const i = ay * ow + ax;
    return { theta: oTheta[i], coherence: oCoh[i] };
  };

  // light direction: mean darkness gradient, negated (light travels this way)
  let lgx = 0,
    lgy = 0;
  for (let y = 1; y < plane.h - 1; y += 2)
    for (let x = 1; x < plane.w - 1; x += 2) {
      const i = y * plane.w + x;
      if (dark[i] < 0.12) continue;
      lgx += dark[i + 1] - dark[i - 1];
      lgy += dark[i + plane.w] - dark[i - plane.w];
    }
  const lgMag = Math.hypot(lgx, lgy) || 1;
  const light = { dx: -lgx / lgMag, dy: -lgy / lgMag, strength: Math.min(1, lgMag / 900) };

  // dark masses
  const masses: { cx: number; cy: number; weight: number }[] = [];
  {
    const heavy = regions(dark, plane.w, plane.h, Math.max(0.5, p85), 0.5).slice(0, 6);
    for (const r of heavy)
      if (r.area > 8) masses.push({ cx: r.center[0] * kxa, cy: r.center[1] * kya, weight: r.area });
    masses.sort((a, b) => b.weight - a.weight);
  }

  // ---- phase 5: tone planes, zones, hatching labels ------------------------
  const tonePlane = reduce(source, 256);
  onProgress?.('Mapping tones', 0.75);
  const hatchLimit = Math.min(512, Math.max(220, Math.round(kw / 2)));
  const hatchPlane = reduce(source, hatchLimit);
  const hatchDark = darkness(hatchPlane, false);
  const cuts = zoneCuts.map((v) => clamp(v, 0.03, 0.95));
  const Z = cuts.length; // number of cumulative shading zones
  const zoneOf = new Uint8Array(hatchPlane.w * hatchPlane.h);
  for (let i = 0; i < zoneOf.length; i++) {
    let z = 0;
    while (z < Z && hatchDark[i] >= cuts[z]) z++;
    zoneOf[i] = z;
  }
  const components: ZoneComponent[] = [];
  // zone 0 "veil" components: the lightest subject areas receive one gentle
  // base tone (the paper highlight), never the background
  {
    const mask = new Uint8Array(zoneOf.length);
    for (let y = 0; y < hatchPlane.h; y++)
      for (let x = 0; x < hatchPlane.w; x++) {
        const i = y * hatchPlane.w + x;
        const mx = Math.min(seg.w - 1, ((x * seg.w) / hatchPlane.w) | 0),
          my = Math.min(seg.h - 1, ((y * seg.h) / hatchPlane.h) | 0);
        mask[i] = zoneOf[i] === 0 ? 1 : 0;
      }
    const { comps } = label(mask, hatchPlane.w, hatchPlane.h, (v) => v === 1);
    // a few meaningful highlights, not confetti
    comps.sort((a, b) => b.area - a.area);
    for (const c of comps.slice(0, 6)) if (c.area >= hatchPlane.w * hatchPlane.h * 0.006) components.push({ zone: 0, box: c.box, cx: c.cx, cy: c.cy, area: c.area });
  }
  for (let z = 1; z <= Z; z++) {
    // zones are cumulative for hatching: zone z = darkness ≥ cuts[z-1]
    const mask = new Uint8Array(zoneOf.length);
    for (let i = 0; i < mask.length; i++) mask[i] = zoneOf[i] >= z ? 1 : 0;
    const { comps } = label(mask, hatchPlane.w, hatchPlane.h, (v) => v === 1);
    // the largest masses per zone; dark zones keep more components because
    // accents (windows, pupils, folds) are small and numerous
    comps.sort((a, b) => b.area - a.area);
    const keep = 10 + z * 3;
    for (const c of comps.slice(0, keep)) if (c.area >= hatchPlane.w * hatchPlane.h * 0.003) components.push({ zone: z, box: c.box, cx: c.cx, cy: c.cy, area: c.area });
  }
  // light zones first: layered graphite builds from light to dark
  components.sort((a, b) => a.zone - b.zone || b.area - a.area);
  const zoneAt = (x: number, y: number) => {
    const hx = clamp(((x / kw) * hatchPlane.w) | 0, 0, hatchPlane.w - 1),
      hy = clamp(((y / kh) * hatchPlane.h) | 0, 0, hatchPlane.h - 1);
    return zoneOf[hy * hatchPlane.w + hx];
  };

  // ---- phase 6: saliency & attention --------------------------------------
  onProgress?.('Finding attention', 0.9);
  const salPlane = reduce(source, 96);
  const salDark = darkness(salPlane, true);
  const sal = new Float32Array(salPlane.w * salPlane.h);
  let smax = 1e-6;
  for (let y = 1; y < salPlane.h - 1; y++)
    for (let x = 1; x < salPlane.w - 1; x++) {
      const i = y * salPlane.w + x;
      // centre–surround difference + local edge energy
      let surround = 0,
        cnt = 0;
      for (let dy = -4; dy <= 4; dy += 2)
        for (let dx = -4; dx <= 4; dx += 2) {
          const j = clamp(y + dy, 0, salPlane.h - 1) * salPlane.w + clamp(x + dx, 0, salPlane.w - 1);
          surround += salDark[j];
          cnt++;
        }
      const centre = salDark[i];
      const dog = Math.abs(centre - surround / cnt);
      const edge = Math.abs(salDark[i + 1] - salDark[i - 1]) + Math.abs(salDark[i + salPlane.w] - salDark[i - salPlane.w]);
      sal[i] = dog + 0.55 * edge + 0.35 * centre;
      if (sal[i] > smax) smax = sal[i];
    }
  for (let i = 0; i < sal.length; i++) sal[i] /= smax;
  const attentionAt = (x: number, y: number) => {
    const ax = clamp(((x / kw) * salPlane.w) | 0, 0, salPlane.w - 1),
      ay = clamp(((y / kh) * salPlane.h) | 0, 0, salPlane.h - 1);
    return sal[ay * salPlane.w + ax];
  };
  const points: P[] = [];
  for (let k = 0; k < 40 && points.length < 10; k++) {
    let best = 0.32 - k * 0.004,
      bi = -1;
    for (let i = 0; i < sal.length; i++) {
      if (sal[i] < best) continue;
      let far = true;
      const x = i % salPlane.w,
        y = (i / salPlane.w) | 0;
      for (const p of points)
        if (Math.hypot((p[0] / kw) * salPlane.w - x, (p[1] / kh) * salPlane.h - y) < 9) {
          far = false;
          break;
        }
      if (far) {
        best = sal[i];
        bi = i;
      }
    }
    if (bi >= 0) points.push([((bi % salPlane.w) / salPlane.w) * kw, (((bi / salPlane.w) | 0) / salPlane.h) * kh]);
    else break;
  }
  summary.push(`attention: ${points.length} foci, light from ${((Math.atan2(light.dy, light.dx) * 180) / Math.PI).toFixed(0)}°`);

  // ---- gesture / construction material ------------------------------------
  const gesture: { axisStrokes: Float32Array[]; envelopes: Float32Array[] } = { axisStrokes: [], envelopes: [] };
  {
    const silhouettes = regions(Uint8Array.from(subjectMask, (v) => (v ? 255 : 0)), seg.w, seg.h, 128, 1.6).filter((r) => r.area > seg.w * seg.h * 0.01).slice(0, 4);
    for (const r of silhouettes) {
      const paths = structureRegion(r); // [shell (ellipse/ring), axis?]
      paths.forEach((path, pi) => {
        if (path.length < 3) return;
        const pts = new Float32Array(path.length * 2);
        for (let i = 0; i < path.length; i++) {
          pts[2 * i] = (path[i][0] / seg.w) * kw;
          pts[2 * i + 1] = (path[i][1] / seg.h) * kh;
        }
        (pi === 0 ? gesture.envelopes : gesture.axisStrokes).push(pts);
      });
    }
  }

  return {
    source,
    work,
    subjectMask,
    maskW: seg.w,
    maskH: seg.h,
    subjectAt,
    coverage,
    axes: { ...axes, cx: (axes.cx / seg.w) * kw, cy: (axes.cy / seg.h) * kh, spread: (axes.spread / seg.w) * kw },
    symmetry: { angle: symAngle, score: symScore },
    light,
    masses,
    contours: contours.slice(0, 140),
    detailContours: [], // filled lazily in the detail stage (higher scale)
    skeleton,
    distance: { field: dist, w: skelPlane.w, h: skelPlane.h },
    orientationAt,
    tonePlane,
    zones: { cuts, plane: hatchPlane, components, zoneAt },
    attention: { points, at: attentionAt },
    gesture,
    summary,
  } satisfies EyeResult;
}

/**
 * Higher-scale edge chains for the detail stage — computed lazily when the
 * brain first enters stage G so the initial analysis stays fast.
 */
export function detailChains(source: Source, options: SimOptions, work: { w: number; h: number }, limit: number): ContourInfo[] {
  const plane = reduce(source, Math.max(384, Math.min(1024, limit)));
  const chains = edgeChains(plane, Math.min(0.95, options.sensitivity + 0.12));
  const kx = work.w / plane.w,
    ky = work.h / plane.h;
  const out: ContourInfo[] = [];
  for (const chain of chains) {
    if (chain.length < 8) continue;
    const pts = new Float32Array(chain.length * 2);
    for (let i = 0; i < chain.length; i++) {
      pts[2 * i] = chain[i][0] * kx;
      pts[2 * i + 1] = chain[i][1] * ky;
    }
    out.push({ pts, importance: chain.length, confidence: 0.6, closed: false, meanTone: 0.5, scale: plane.w });
  }
  return out.sort((a, b) => b.importance - a.importance);
}

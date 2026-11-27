import { contours } from 'd3-contour';
import { simplify, type P } from './geometry';
import { reduce, type Source, type Plane } from './source';
import type { Hint } from './settings';
export interface Region {
  pts: P[][];
  area: number;
  perimeter: number;
  center: P;
}
export function regions(
  values: Float32Array | Uint8Array,
  w: number,
  h: number,
  level: number,
  tolerance: number,
): Region[] {
  const poly = contours().size([w, h]).contour(values, level);
  const result: Region[] = [];
  for (const polygon of poly.coordinates as P[][][]) {
    const pts = polygon.map((r) => simplify(r, tolerance).slice(0, -1)).filter((r) => r.length >= 3);
    if (!pts.length) continue;
    let area = 0,
      perimeter = 0;
    const outer = pts[0];
    let sx = 0,
      sy = 0;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i],
        b = outer[(i + 1) % outer.length];
      area += a[0] * b[1] - a[1] * b[0];
      perimeter += Math.hypot(a[0] - b[0], a[1] - b[1]);
      sx += a[0];
      sy += a[1];
    }
    result.push({ pts, area: Math.abs(area) / 2, perimeter, center: [sx / outer.length, sy / outer.length] });
  }
  return result.sort((a, b) => b.area - a.area);
}
export function darkness(p: Plane, blur = false) {
  const out = new Float32Array(p.gray.length);
  for (let i = 0; i < out.length; i++) {
    const v = p.gray[i],
      x = i % p.w;
    let sum = v * 2,
      wt = 2;
    if (blur)
      for (const j of [x ? i - 1 : i, x + 1 < p.w ? i + 1 : i, i - p.w, i + p.w]) {
        if (j >= 0 && j < out.length && Math.abs(p.gray[j] - v) < 28) {
          sum += p.gray[j];
          wt++;
        }
      }
    out[i] = 1 - sum / (wt * 255);
  }
  return out;
}
// Grow color-coherent components, classify their contact with the frame, and
// propagate user seeds through the same adjacency graph. Ambiguous components
// remain available to every contour pass.
export function isolate(s: Source, sensitivity: number, hints: Hint[]) {
  const p=reduce(s,128),{w,h}=p,n=w*h;
  const parent=Int32Array.from({length:n},(_,i)=>i),area=new Uint32Array(n).fill(1);
  const internal=new Float32Array(n),seed=new Int8Array(n),border=new Uint16Array(n),total=Float32Array.from(p.gray);
  const edges:{a:number;b:number;weight:number}[]=[];
  const root=(i:number)=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i]}return i};
  for(const hint of hints){
    const x=Math.min(w-1,Math.max(0,Math.floor(hint.x*w))),y=Math.min(h-1,Math.max(0,Math.floor(hint.y*h)));
    seed[y*w+x]=hint.subject?1:-1;
  }
  for(let i=0;i<n;i++){
    const x=i%w,y=Math.floor(i/w);border[i]=+(!x||!y||x===w-1||y===h-1);
    for(const j of [x+1<w?i+1:-1,y+1<h?i+w:-1]){
      if(j<0)continue;
      const color=Math.hypot(s.colors[i*3]-s.colors[j*3],s.colors[i*3+1]-s.colors[j*3+1],s.colors[i*3+2]-s.colors[j*3+2]);
      edges.push({a:i,b:j,weight:.45*color+.35*Math.abs(p.gray[i]-p.gray[j])});
    }
  }
  edges.sort((a,b)=>a.weight-b.weight);
  for(const k of [20,60+180*sensitivity]){
    for(const e of edges){
      let a=root(e.a),b=root(e.b);if(a===b||seed[a]*seed[b]<0)continue;
      if(e.weight>Math.min(internal[a]+k/area[a],internal[b]+k/area[b]))continue;
      if(area[a]<area[b])[a,b]=[b,a];
      parent[b]=a;area[a]+=area[b];total[a]+=total[b];border[a]+=border[b];seed[a]=seed[a]||seed[b];
      internal[a]=Math.max(internal[a],internal[b],e.weight);
    }
  }
  let component=0,ambiguous=0;const mask=new Uint8Array(n);
  for(let i=0;i<n;i++){
    const r=root(i);
    if(i===r){component++;if(!seed[r]&&border[r]>0&&border[r]<Math.sqrt(area[r]))ambiguous++}
    mask[i]=+(seed[r]?seed[r]>0:border[r]===0||(border[r]<Math.sqrt(area[r])*.45&&total[r]/area[r]<160));
  }
  return {
    mask,
    w,
    h,
    ambiguous,
    component,
    subject: (x: number, y: number) =>
      !!mask[
        Math.max(0, Math.min(h - 1, Math.floor((y * h) / s.h))) * w +
          Math.max(0, Math.min(w - 1, Math.floor((x * w) / s.w)))
      ],
  };
}
export function structure(r: Region): P[][] {
  const ring = r.pts[0],
    [cx, cy] = r.center;
  let xx = 0,
    xy = 0,
    yy = 0;
  for (const [x, y] of ring) {
    xx += (x - cx) ** 2;
    yy += (y - cy) ** 2;
    xy += (x - cx) * (y - cy);
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy),
    u = Math.cos(theta),
    v = Math.sin(theta);
  const uv = ring.map(([x, y]) => [(x - cx) * u + (y - cy) * v, -(x - cx) * v + (y - cy) * u]);
  const xs = uv.map((p) => p[0]),
    lo = Math.min(...xs),
    hi = Math.max(...xs),
    axis: P[] = [];
  // Midpoints of the widest interior chords approximate a medial branch.
  for (let k = 1; k < 12; k++) {
    const x = lo + ((hi - lo) * k) / 12,
      ys: number[] = [];
    for (let i = 0; i < uv.length; i++) {
      const a = uv[i],
        b = uv[(i + 1) % uv.length];
      if (a[0] <= x !== b[0] <= x) ys.push(a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
    }
    ys.sort((a, b) => a - b);
    let span = 0,
      m = 0;
    for (let i = 1; i < ys.length; i += 2)
      if (ys[i] - ys[i - 1] > span) {
        span = ys[i] - ys[i - 1];
        m = (ys[i] + ys[i - 1]) / 2;
      }
    if (span) axis.push([cx + x * u - m * v, cy + x * v + m * u]);
  }
  const ys = uv.map((p) => p[1]),
    yl = Math.min(...ys),
    yh = Math.max(...ys);
  const rx = (hi - lo) / 2,
    ry = (yh - yl) / 2,
    ox = (hi + lo) / 2,
    oy = (yh + yl) / 2;
  const mismatch =
    uv.reduce((e, [x, y]) => e + Math.abs(Math.hypot((x - ox) / (rx || 1), (y - oy) / (ry || 1)) - 1), 0) /
    uv.length;
  const shell: P[] =
    mismatch < 0.085 && ring.length >= 8
      ? Array.from({ length: 25 }, (_, i) => {
          const a = (i * Math.PI) / 12,
            x = ox + rx * Math.cos(a),
            y = oy + ry * Math.sin(a);
          return [cx + x * u - y * v, cy + x * v + y * u] as P;
        })
      : [...ring, ring[0]];
  return [shell, ...(axis.length > 2 ? [axis] : [])];
}
export function tangent(p: Plane, x: number, y: number) {
  let xx = 0,
    xy = 0,
    yy = 0;
  const at = (i: number, j: number) =>
    p.gray[Math.max(0, Math.min(p.h - 1, j)) * p.w + Math.max(0, Math.min(p.w - 1, i))];
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const a = Math.floor(x) + i,
        b = Math.floor(y) + j,
        gx = at(a + 1, b) - at(a - 1, b),
        gy = at(a, b + 1) - at(a, b - 1);
      xx += gx * gx;
      xy += gx * gy;
      yy += gy * gy;
    }
  return xx + yy < 16 ? -0.7 : Math.atan2(2 * xy, xx - yy) * 0.5 + Math.PI / 2;
}

/** Hysteresis on non-maximum-suppressed gradients. Follow the straightest
 * continuation at a junction and leave other branches for their own paths. */
export function edgeChains(p: Plane, sensitivity: number): P[][] {
  const { w, h } = p,
    n = w * h,
    gx = new Float32Array(n),
    gy = new Float32Array(n),
    mag = new Float32Array(n),
    edge = new Uint8Array(n);
  const fine = darkness(p, true);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = fine[i + 1] - fine[i - 1];
      gy[i] = fine[i + w] - fine[i - w];
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
  const high = 0.075 + 0.22 * (1 - sensitivity),
    strong: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x,
        m = mag[i];
      if (m < high * 0.42) continue;
      const dx = Math.round(gx[i] / m),
        dy = Math.round(gy[i] / m),
        d = dy * w + dx;
      if (m < mag[i - d] || m <= mag[i + d]) continue;
      edge[i] = 1;
      if (m >= high) strong.push(i);
    }
  const lines: P[][] = [];
  for (const i of strong) {
    if (!edge[i]) continue;
    edge[i] = 0;
    const arms: P[][] = [];
    for (const sign of [1, -1]) {
      const arm: P[] = [];
      let j = i,
        ux = (-gy[i] / mag[i]) * sign,
        uy = (gx[i] / mag[i]) * sign;
      while (true) {
        let best = 0.05,
          next = -1;
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) {
            const k = j + y * w + x;
            if (!edge[k]) continue;
            const dot = (ux * x + uy * y) / Math.hypot(x, y);
            if (dot > best) {
              best = dot;
              next = k;
            }
          }
        if (next < 0) break;
        const x = next % w,
          y = Math.floor(next / w),
          len = Math.hypot(x - (j % w), y - Math.floor(j / w));
        ux = (x - (j % w)) / len;
        uy = (y - Math.floor(j / w)) / len;
        edge[next] = 0;
        j = next;
        arm.push([x + 0.5, y + 0.5]);
      }
      arms.push(arm);
    }
    const line: P[] = [...arms[0].reverse(), [(i % w) + 0.5, Math.floor(i / w) + 0.5], ...arms[1]];
    if (line.length >= 7) lines.push(line);
  }
  return lines.sort((a, b) => b.length - a.length);
}

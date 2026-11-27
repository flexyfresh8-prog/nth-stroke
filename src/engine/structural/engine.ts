import { darkness, edgeChains, isolate, regions, structure, tangent } from './analysis';
import {
  apply,
  paint,
  simplify,
  stroke,
  ink,
  type P,
  type Box,
  type Mark,
  type Placed,
  type Action,
  type Context,
} from './geometry';
import { reduce, surface, type Plane, type Source } from './source';
import { stages, type Options, type Hint } from './settings';
import { measure } from '../adaptive/metrics';
export type Step = {
  stage: number;
  progress: number;
  action?: Action;
  quality?: { ssim: number; mae: number; edges: number; missing: number; excess: number };
  note?: string;
};
type Raster = { ctx: Context; target: Plane; kx: number; ky: number; ox: number; oy: number };
function raster(target: Plane, w: number, h: number, ox = 0, oy = 0): Raster {
  const ctx = surface(target.w, target.h).getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, target.w, target.h);
  const kx = target.w / w,
    ky = target.h / h;
  ctx.setTransform(kx, 0, 0, ky, -ox * kx, -oy * ky);
  return { ctx, target, kx, ky, ox, oy };
}
function clipped(r: Raster, b: Box): Box {
  return [
    Math.max(0, Math.floor((b[0] - r.ox) * r.kx) - 2),
    Math.max(0, Math.floor((b[1] - r.oy) * r.ky) - 2),
    Math.min(r.target.w, Math.ceil((b[2] - r.ox) * r.kx) + 2),
    Math.min(r.target.h, Math.ceil((b[3] - r.oy) * r.ky) + 2),
  ];
}
function loss(data: Uint8ClampedArray, p: Plane, x: number, y: number, w: number) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const j = i / 4,
      k = (y + Math.floor(j / w)) * p.w + x + (j % w),
      e = data[i] - p.gray[k];
    sum += e * e * (e < 0 ? 1.08 : 1);
    if (j >= w) sum += .08*(data[i]-data[i-4*w]-p.gray[k]+p.gray[k-p.w])**2;
    if (j % w) sum += 0.08 * Math.abs(data[i] - data[i - 4] - (p.gray[k] - p.gray[k - 1])) ** 2;
  }
  return sum;
}
class Index {
  cells = new Map<number, number[]>();
  cols: number;
  size: number;
  constructor(w: number, h: number) {
    this.size = Math.max(32, Math.max(w, h) / 32);
    this.cols = Math.ceil(w / this.size) + 2;
  }
  keys(b: Box) {
    const keys: number[] = [];
    for (let y = Math.max(0, Math.floor(b[1] / this.size)); y <= Math.floor(b[3] / this.size); y++)
      for (let x = Math.max(0, Math.floor(b[0] / this.size)); x <= Math.floor(b[2] / this.size); x++)
        keys.push(y * this.cols + x);
    return keys;
  }
  add(i: number, b: Box) {
    for (const k of this.keys(b)) {
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k)!.push(i);
    }
  }
  near(b: Box) {
    const ids = new Set<number>();
    for (const k of this.keys(b)) for (const i of this.cells.get(k) ?? []) ids.add(i);
    return [...ids].sort((a, b) => a - b);
  }
}
export class StructuralEngine {
  list: Placed[] = [];
  index: Index;
  view: Raster;
  working: Plane;
  stage = 0;
  progress = 0;
  rng: number;
  segmentation: ReturnType<typeof isolate>;
  active: Raster | null = null;
  lastQuality: Step['quality'];
  constructor(
    public source: Source,
    public opt: Options,
    hints: Hint[] = [],
  ) {
    this.working = reduce(source, Math.min(opt.resolution, opt.performance === 'Compact' ? 384 : 640));
    this.view = raster(this.working, source.w, source.h);
    this.index = new Index(source.w, source.h);
    this.rng = opt.seed >>> 0;
    this.segmentation = isolate(source, opt.segmentation, hints);
  }
  random() {
    this.rng = (Math.imul(1664525, this.rng) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }
  quality() {
    const { ctx, target } = this.view,
      { w, h } = target;
    const bytes = ctx.getImageData(0, 0, w, h).data;
    const a = Float32Array.from(target.gray, (_, i) => bytes[i * 4] / 255),
      b = Float32Array.from(target.gray, (v) => v / 255);
    const m = measure(a, b, w, h);
    // Missing-detail and excessive-ink detection: pixels where the render is
    // meaningfully lighter (missing) or darker (excess) than the reference.
    let missing = 0,
      excess = 0;
    for (let i = 0; i < target.gray.length; i++) {
      const d = bytes[i * 4] - target.gray[i];
      if (d > 15) missing++;
      else if (d < -15) excess++;
    }
    return (this.lastQuality = {
      ssim: m.ssim,
      mae: m.mae,
      edges: (m.precision + m.recall) / 2,
      missing: missing / target.gray.length,
      excess: excess / target.gray.length,
    });
  }
  step(action?: Action): Step {
    return {
      stage: this.stage,
      progress: (this.stage + Math.min(0.99, this.progress)) / stages.length,
      action,
    };
  }
  draw(mark: Mark, force = false): Action | undefined {
    if (this.list.length >= this.opt.budget) return;
    const placed = { mark, opacity: mark.opacity, dx: 0, dy: 0 },
      r = this.active ?? this.view;
    const [x, y, x1, y1] = clipped(r, mark.box),
      w = x1 - x,
      h = y1 - y;
    if (w <= 0 || h <= 0) return;
    if (force) paint(r.ctx, placed);
    else {
      const old = r.ctx.getImageData(x, y, w, h);
      paint(r.ctx, placed);
      const after = r.ctx.getImageData(x, y, w, h);
      if (loss(after.data, r.target, x, y, w) >= loss(old.data, r.target, x, y, w) - 1) {
        r.ctx.putImageData(old, x, y);
        return;
      }
    }
    if (r !== this.view) paint(this.view.ctx, placed);
    const pad = this.source.w / this.view.target.w;
    this.index.add(this.list.length, [
      mark.box[0] - pad,
      mark.box[1] - pad,
      mark.box[2] + pad,
      mark.box[3] + pad,
    ]);
    this.list.push(placed);
    return { kind: 'add', mark };
  }
  line(p: P[], width: number, opacity: number, importance: number, scale = 1): Mark {
    const points = p.map(([x, y]): P => [x * scale, y * scale]);
    const mid = points[Math.floor(points.length / 2)],
      subject = this.segmentation.subject(...mid);
    return {
      ...stroke(points, width * scale, this.opt.pressure),
      layer:
        this.stage === 1
          ? 'Construction'
          : this.stage === 4
            ? 'Tones'
            : this.stage > 4
              ? 'Details'
              : subject
                ? 'Subject'
                : 'Background',
      subject,
      stage: this.stage,
      importance,
      opacity,
      speed: 120 + this.stage * 28,
    };
  }
  *outline(limit: number, construction = false): Generator<Step> {
    const { source, opt } = this,
      p = reduce(source, limit),
      s = source.w / p.w,
      values = darkness(p, true);
    const histogram = new Uint32Array(256);
    for (const d of values) histogram[Math.min(255, Math.round(d * 255))]++;
    let upper = 255,
      seen = 0;
    while (upper > 1 && seen < values.length * 0.003) seen += histogram[upper--];
    const range = Math.min(1, (upper + 1) / 190);
    const levels = (
      construction
        ? [0.14, 0.48]
        : this.stage === 2
          ? [0.24 + 0.18 * (1 - opt.sensitivity)]
          : [0.62, 0.13 + 0.13 * (1 - opt.sensitivity)]
    ).map((t) => t * range);
    const floor = construction ? 12 : this.stage === 2 ? Math.max(10, p.w * 0.045) : 3;
    for (const level of levels) {
      const shapes = regions(values, p.w, p.h, level, construction ? 1.6 : 0.18 + 0.7 * opt.continuity);
      for (let i = 0; i < shapes.length; i++) {
        const r = shapes[i];
        this.progress = i / shapes.length;
        if (this.list.length >= opt.budget * 0.36) return;
        if (r.perimeter < floor || r.area < (construction ? 10 : 0.7)) continue;
        if (construction && i > 9) break;
        const paths = construction ? structure(r) : r.pts.map((ring) => [...ring, ring[0]]);
        for (const path of paths)
          if (path.length >= 3) {
            const mark = this.line(
              path.map(([x,y]):P=>[x,y*source.h/p.h/s]),
              construction ? 0.56 : 0.65 + opt.sensitivity * 0.45,
              construction
                ? (0.09 + opt.construction * 0.18) * Math.max(0.22, range)
                : this.stage === 2
                  ? 0.56
                  : 0.4,
              r.perimeter,
              s,
            );
            yield this.step(this.draw(mark, construction));
          }
      }
    }
    if (!construction) {
      const chains = edgeChains(p, opt.sensitivity);
      for (const chain of chains) {
        if (chain.length < (this.stage === 2 ? 24 : 9) || this.list.length >= opt.budget * 0.36) break;
        const pts = simplify(chain, 0.35 + 0.55 * opt.continuity);
        yield this.step(this.draw(this.line(pts.map(([x,y]):P=>[x,y*source.h/p.h/s]), 0.9, 0.4, chain.length, s)));
      }
    }
  }
  *tones(): Generator<Step> {
    const p = reduce(this.source, Math.min(512, this.opt.resolution)),
      s = this.source.w / p.w,
      field = darkness(p, true);
    let sharp = 0, index=0, soft = 0,
      dark = 0;
    for (const v of field) {
      if (v > 0.03) dark++;
      if(index%p.w && Math.abs(v-field[index-1])>.12)sharp++;
      index++;
      if (v > 0.08 && v < 0.87) soft++;
    }
    const n = 5 + Math.round((soft / (dark || 1) > 0.5 && sharp/(dark||1)<.13 ? 26 : 8) * this.opt.shade);
    for (let k = 1; k <= n; k++) {
      const level = (k - 0.45) / n,
        opacity = Math.min(0.96, (1 / (n + 1 - k)) * (0.8 + 0.2 * this.opt.shade));
      const shapes = regions(field, p.w, p.h, level, 0.28);
      for (let i = 0; i < shapes.length; i++) {
        if (this.list.length >= this.opt.budget * 0.78) return;
        this.progress = (k - 1 + i / shapes.length) / n;
        const r = shapes[i];
        if (r.area < 1.4) continue;
        const rings = r.pts.map((ring) => ring.map(([x, y]): P => [x * s, (y * this.source.h) / p.h]));
        const subject = this.segmentation.subject(r.center[0] * s, r.center[1]*this.source.h/p.h);
        yield this.step(
          this.draw({
            ...ink(rings),
            opacity,
            importance: r.area,
            stage: 4,
            layer: 'Tones',
            subject,
            speed: 180,
          }),
        );
      }
    }
  }
  // Trace in the global orientation field. A tile owns the seed, while the halo
  // permits the curve and its error measurement to cross the tile boundary.
  *details(limit: number, pass: number): Generator<Step> {
    const { source, opt } = this,
      p = reduce(source, limit),
      s = source.w / p.w,
      sy = source.h / p.h;
    const tile = opt.performance === 'Compact' ? 128 : 192,
      halo = 32,
      step = Math.max(3, Math.round((this.stage === 4 ? 10 : 8) - 4 * opt.hatch));
    const tiles: { x: number; y: number; contrast: number }[] = [];
    for (let y = 0; y < p.h; y += tile)
      for (let x = 0; x < p.w; x += tile) {
        let contrast = 0;
        for (let j = y; j < Math.min(y + tile, p.h - 1); j += 7)
          for (let i = x; i < Math.min(x + tile, p.w - 1); i += 7) {
            const k = j * p.w + i;
            contrast += Math.abs(p.gray[k] - p.gray[k + 1]) + Math.abs(p.gray[k] - p.gray[k + p.w]);
          }
        tiles.push({ x, y, contrast });
      }
    tiles.sort((a, b) => b.contrast - a.contrast);
    for (let t = 0; t < tiles.length; t++) {
      this.progress = t / tiles.length;
      yield this.step();
      if (this.list.length >= opt.budget) return;
      const { x, y, contrast } = tiles[t];
      if (!contrast && limit > 1024) continue;
      const left = Math.max(0, x - halo),
        top = Math.max(0, y - halo),
        w = Math.min(p.w, x + tile + halo) - left,
        h = Math.min(p.h, y + tile + halo) - top;
      const gray = new Uint8Array(w * h);
      for (let j = 0; j < h; j++)
        gray.set(p.gray.subarray((top + j) * p.w + left, (top + j) * p.w + left + w), j * w);
      const box: Box = [left * s, top * sy, (left + w) * s, (top + h) * sy];
      const r = (this.active = raster({ gray, w, h }, w * s, h * sy, box[0], box[1]));
      for (const i of this.index.near(box)) paint(r.ctx, this.list[i]);
      const rendered = r.ctx.getImageData(0, 0, w, h).data;
      const candidates: { i: number; j: number; err: number }[] = [];
      for (let j = y; j < Math.min(y + tile, p.h); j += step)
        for (let i = x; i < Math.min(x + tile, p.w); i += step) {
          let best = 5 + (1 - opt.detail) * 18,
            bx = 0,
            by = 0;
          for (let v = j; v < Math.min(j + step, p.h); v++)
            for (let u = i; u < Math.min(i + step, p.w); u++) {
              const q = (v - top) * w + u - left,
                d = rendered[q * 4] - gray[q];
              if (d > best) {
                best = d;
                bx = u;
                by = v;
              }
            }
          if (best > 5 + (1 - opt.detail) * 18) candidates.push({ i: bx, j: by, err: best });
        }
      candidates.sort((a, b) => b.err - a.err);
      for (let c = 0; c < candidates.length; c++) {
        const { i, j, err } = candidates[c],
          seed = p.gray[j * p.w + i],
          points: P[] = [[i + 0.5, j + 0.5]];
        let theta = tangent(p, i, j) + (pass % 2 && seed < 110 ? 0.92 : 0);
        if (this.random() < 0.5) theta += Math.PI;
        for (const side of [-1, 1]) {
          let a = theta + (side === -1 ? Math.PI : 0),
            cx = i + 0.5,
            cy = j + 0.5;
          for (let l = 0; l < 4 + Math.round(7 * opt.continuity); l++) {
            let wanted = tangent(p, cx, cy) + (pass % 2 && seed < 110 ? 0.92 : 0);
            if (Math.cos(wanted - a) < 0) wanted += Math.PI;
            a += 0.45 * Math.atan2(Math.sin(wanted - a), Math.cos(wanted - a));
            cx += 1.3 * Math.cos(a);
            cy += 1.3 * Math.sin(a);
            if (
              cx < left ||
              cy < top ||
              cx >= left + w ||
              cy >= top + h ||
              p.gray[Math.floor(cy) * p.w + Math.floor(cx)] > seed + 35
            )
              break;
            const pt: P = [cx, (cy * sy) / s];
            if (side === -1) points.unshift(pt);
            else points.push(pt);
          }
        }
        if (points.length < 3) continue;
        const mark = this.line(points, 0.8 + err / 130, Math.min(0.92, err / 255 + 0.1), err, s);
        const a = this.draw(mark);
        if (a || c % 48 === 0) yield this.step(a);
        if (this.list.length >= opt.budget) break;
      }
      this.active = null;
    }
  }
  *optimize(): Generator<Step> {
    const r = this.view,
      // Construction guides are processed first and beyond the iteration cap:
      // a human artist always erases the scaffold before finishing.
      guides = this.list.filter((v) => v.mark.layer === 'Construction' && v.opacity > 0).length,
      selected = this.list
        .map((v, i) => ({ i, key: v.mark.layer === 'Construction' ? 1e9 : v.mark.importance }))
        .sort((a, b) => b.key - a.key);
    const count = Math.min(selected.length, guides + 32 * this.opt.iterations);
    for (let k = 0; k < count; k++) {
      this.progress = k / count;
      const i = selected[k].i,
        v = this.list[i],
        b = v.mark.box,
        offset = (this.source.w / r.target.w) * 0.55;
      const guide = v.mark.layer === 'Construction' && v.opacity > 0;
      const area: Box = [b[0] - 2 * offset, b[1] - 2 * offset, b[2] + 2 * offset, b[3] + 2 * offset],
        [x, y, x1, y1] = clipped(r, area);
      const w = x1 - x,
        h = y1 - y;
      if (!w || !h) continue;
      const original = r.ctx.getImageData(x, y, w, h),
        ids = this.index.near(area);
      let best = loss(original.data, r.target, x, y, w),
        winner: Action | undefined,
        after = original;
      const base = { ...v };
      // A guide is only erased when its removal does not explode the local
      // error, so a load-bearing construction stroke survives as structure.
      const trials: [number, number, number][] = guide
        ? [[0, 0, 0]]
        : [
            [0, 0, 0],
            [v.opacity * 0.65, 0, 0],
            [Math.min(1, v.opacity * 1.2), 0, 0],
            [v.opacity, offset, 0],
            [v.opacity, 0, -offset],
          ];
      for (const [opacity, dx, dy] of trials) {
        Object.assign(v, { opacity, dx, dy });
        r.ctx.save();
        r.ctx.resetTransform();
        r.ctx.beginPath();
        r.ctx.rect(x, y, w, h);
        r.ctx.clip();
        r.ctx.fillStyle = 'white';
        r.ctx.fillRect(x, y, w, h);
        r.ctx.setTransform(r.kx, 0, 0, r.ky, 0, 0);
        for (const id of ids) paint(r.ctx, this.list[id]);
        r.ctx.restore();
        const image = r.ctx.getImageData(x, y, w, h),
          score = loss(image.data, r.target, x, y, w);
        if (guide ? score < best * 1.05 + 48 : score + 1 < best) {
          best = score;
          winner = { kind: 'edit', index: i, opacity, dx, dy };
          after = image;
        }
      }
      Object.assign(v, base);
      r.ctx.putImageData(after, x, y);
      if (winner) apply(this.list, winner);
      yield this.step(winner);
    }
  }
  *refit():Generator<Step>{
    const r=this.view,unit=this.source.w/r.target.w;
    let trials=0;
    for(let i=this.list.length-1;i>=0&&trials<48*this.opt.iterations;i--){
      const v=this.list[i],pts=v.mark.points;
      if(!v.opacity||!pts||pts.length<3||v.dx||v.dy)continue;
      const end=pts.at(-1)!,tangent=pts.at(-2)!;
      let joined=pts,merged:number|undefined;
      const reach=2*unit+v.mark.width;
      for(const j of this.index.near([end[0]-reach,end[1]-reach,end[0]+reach,end[1]+reach])){
        const q=this.list[j],points=q.mark.points;
        if(i===j||!points||q.opacity===0||q.dx||q.dy||q.mark.layer!==v.mark.layer||
            q.mark.subject!==v.mark.subject||Math.abs(v.opacity-q.opacity)>.12||Math.abs(v.mark.width-q.mark.width)>unit)continue;
        for(const reverse of [false,true]){
          const a=reverse?points.at(-1)!:points[0],b=reverse?points.at(-2)!:points[1];
          if(Math.hypot(a[0]-end[0],a[1]-end[1])>reach)continue;
          const dx=end[0]-tangent[0],dy=end[1]-tangent[1],ux=b[0]-a[0],uy=b[1]-a[1];
          if(dx*ux+dy*uy<.82*Math.hypot(dx,dy)*Math.hypot(ux,uy))continue;
          joined=pts.concat(reverse?[...points].reverse():points);merged=j;break;
        }
        if(merged!==undefined)break;
      }
      const smooth=simplify(joined,unit*.4);
      if(smooth.length<2||(merged===undefined&&smooth.length===pts.length))continue;
      const mark={...v.mark,...stroke(smooth,v.mark.width,this.opt.pressure),opacity:v.opacity};
      const boxes=[v.mark.box,mark.box];if(merged!==undefined)boxes.push(this.list[merged].mark.box);
      const area:Box=[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
      const [x,y,right,bottom]=clipped(r,area),w=right-x,h=bottom-y;if(w<1||h<1)continue;
      trials++;const old=r.ctx.getImageData(x,y,w,h);
      r.ctx.save();r.ctx.resetTransform();r.ctx.beginPath();r.ctx.rect(x,y,w,h);r.ctx.clip();r.ctx.fillStyle='white';r.ctx.fillRect(x,y,w,h);
      r.ctx.setTransform(r.kx,0,0,r.ky,0,0);
      for(const j of this.index.near(area))if(j!==merged)paint(r.ctx,j===i?{mark,opacity:mark.opacity,dx:0,dy:0}:this.list[j]);
      r.ctx.restore();
      const now=r.ctx.getImageData(x,y,w,h);
      let action:Action|undefined;
      if(loss(now.data,r.target,x,y,w)<=loss(old.data,r.target,x,y,w)){
        action={kind:'reshape',index:i,mark,merged};apply(this.list,action);this.index.add(i,area);
      }else r.ctx.putImageData(old,x,y);
      yield this.step(action);
    }
  }
  *run(): Generator<Step> {
    const native = Math.min(this.opt.resolution, Math.max(this.source.w, this.source.h));
    for (this.stage = 0; this.stage < stages.length; this.stage++) {
      this.progress = 0;
      yield {
        ...this.step(),
        note: this.stage === 0 ? this.segmentation.component + ' connected regions' : undefined,
      };
      switch (this.stage) {
        case 1:
          if(this.opt.construction){
            const {mask,w,h}=this.segmentation,coverage=mask.reduce((a,b)=>a+b,0)/mask.length;
            if(coverage>.015&&coverage<.82){
              const silhouettes=regions(mask,w,h,.5,1.8).filter(r=>r.area>w*h*.012).slice(0,5);
              for(const r of silhouettes)for(const path of structure(r)){
                const pts=path.map(([x,y]):P=>[x*this.source.w/w,y*this.source.h/h]);
                yield this.step(this.draw(this.line(pts,.5*this.source.w/w,.11*this.opt.construction,r.area),true));
              }
            }
            yield* this.outline(128,true);
          }
          break;
        case 2:
          yield* this.outline(Math.min(native, 256));
          break;
        case 3:
          yield* this.outline(Math.min(native, 512));
          break;
        case 4:
          if (this.opt.shade) {
            yield* this.tones();
            if (this.opt.hatch) yield* this.details(Math.min(native, 512), 0);
          }
          break;
        case 5: {
          const max = Math.max(512, native);
          for (let lim = 1024; ; lim *= 2) {
            yield* this.details(Math.min(native, lim), 0);
            if (lim >= max || this.list.length >= this.opt.budget) break;
          }
          break;
        }
        case 6:
          // Correction passes stop early once no meaningful detail is missing:
          // the engine optimizes fidelity, not stroke count.
          for (let i = 0; i < this.opt.iterations && this.list.length < this.opt.budget; i++) {
            yield* this.details(Math.min(native, 1024), i + 1);
            if (this.quality().missing < 0.008) break;
          }
          break;
        case 7:
          yield* this.optimize();
          yield* this.refit();
          break;
      }
      yield { ...this.step(), progress: (this.stage + 1) / 8, quality: this.quality() };
    }
  }
}

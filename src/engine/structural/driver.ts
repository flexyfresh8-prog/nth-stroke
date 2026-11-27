import { decodeSource, reduce, type Source } from './source';
import { StructuralEngine, type Step } from './engine';
import type { Options, Hint } from './settings';
export type Request =
  | { type: 'open'; file: Blob }
  | { type: 'start'; options: Options; hints: Hint[]; skip: number }
  | { type: 'next'; count: number };
export type Reply =
  | { type: 'ready'; w: number; h: number; preview: Uint8Array; pw: number; ph: number }
  | { type: 'batch'; steps: Step[]; done: boolean }
  | { type: 'error'; message: string }
  | { type: 'started'; mask:Uint8Array; w:number;h:number };
export function driver(post: (r: Reply) => void) {
  let source: Source | undefined, iterator: Generator<Step> | undefined;
  return async (m: Request) => {
    try {
      if (m.type === 'open') {
        source = await decodeSource(m.file);
        if (!source.gray.some((v) => v < 254))
          throw Error('This reference has no visible marks after decoding.');
        const p = reduce(source, 384);
        post({ type: 'ready', w: source.w, h: source.h, preview: p.gray, pw: p.w, ph: p.h });
        return;
      }
      if (m.type === 'start' && source) {
        const engine=new StructuralEngine(source,m.options,m.hints);
        iterator=engine.run();
        for (let n = 0; n < m.skip; n++) {
          if (iterator.next().done) throw Error('Project position exceeds this drawing sequence.');
          if (n % 64 === 63) await new Promise((r) => setTimeout(r, 0));
        }
        const {mask,w,h}=engine.segmentation;post({type:'started',mask,w,h});
        return;
      }
      if (m.type === 'next' && iterator) {
        const steps: Step[] = [],
          start = performance.now();
        while (steps.length < m.count) {
          const v = iterator.next();
          if (v.done) {
            post({ type: 'batch', steps, done: true });
            return;
          }
          steps.push(v.value);
          if (performance.now() - start > 20) break;
        }
        post({ type: 'batch', steps, done: false });
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };
}

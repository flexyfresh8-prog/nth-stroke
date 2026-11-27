import type { Action } from './geometry';
import { normalize, layers, type Options, type Hint } from './settings';
export interface Checkpoint {
  options: Options;
  hints: Hint[];
  steps: number;
  complete: boolean;
}
export function pack(file: File, state: Checkpoint, history: Action[]) {
  const header = JSON.stringify({
    ...state,
    version: '3.0',
    size: file.size,
    name: file.name,
    type: file.type,
  });
  return new Blob(['NTH3\n', header, '\n', file, ...history.map((a) => JSON.stringify(a) + '\n')], {
    type: 'application/octet-stream',
  });
}
export async function unpack(file: File) {
  const buf = new Uint8Array(await file.slice(0, 65536).arrayBuffer()),
    line = buf.indexOf(10, 5);
  if (line < 0 || new TextDecoder().decode(buf.slice(0, 5)) !== 'NTH3\n') throw Error('Invalid V3 project.');
  const header = JSON.parse(new TextDecoder().decode(buf.slice(5, line)));
  if (
    header.version !== '3.0' ||
    !Number.isSafeInteger(header.size) ||
    header.size < 1 ||
    line + 1 + header.size > file.size ||
    !Number.isSafeInteger(header.steps) ||
    header.steps < 0 ||
    !header.options ||
    !Array.isArray(header.hints)
  )
    throw Error('Invalid V3 checkpoint.');
  header.options = normalize(header.options);
  if (
    header.hints.length > 4096 ||
    header.hints.some((h: Hint) => !h || !Number.isFinite(h.x) || !Number.isFinite(h.y))
  )
    throw Error('Invalid segmentation hints.');
  const end = line + 1 + header.size,
    ref = new File([file.slice(line + 1, end)], header.name, { type: header.type });
  const reader = file.slice(end).stream().getReader(),
    decoder = new TextDecoder(),
    history: Action[] = [];
  let partial = '';
  while (true) {
    const part = await reader.read();
    partial += decoder.decode(part.value, { stream: !part.done });
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines)
      if (line) {
        const action = JSON.parse(line) as Action;
        if (action.kind === 'add' || action.kind==='reshape') {
          const m = action.mark;
          if (
            !m ||
            typeof m.d !== 'string' ||
            !/^[MmCcLlZz0-9.,eE+\s-]+$/.test(m.d) ||
            typeof m.subject!=='boolean' || !layers.includes(m.layer) ||
            !Array.isArray(m.box) ||
            m.box.length !== 4 ||
            !m.box.every(Number.isFinite) ||
            !Number.isFinite(m.opacity)
          )
            throw Error('Invalid vector mark.');
        } else if (
          action.kind !== 'edit' ||
          !Number.isInteger(action.index) ||
          action.index < 0 ||
          !Number.isFinite(action.opacity)
        )
          throw Error('Invalid vector edit.');
        history.push(action);
      }
    if (part.done) break;
  }
  if (partial) throw Error('Incomplete V3 history.');
  return { ref, history, state: header as Checkpoint };
}

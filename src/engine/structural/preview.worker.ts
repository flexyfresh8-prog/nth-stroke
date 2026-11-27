import { decodeSource, reduce } from './source';
self.onmessage = async ({ data }) => {
  try {
    const source = await decodeSource(data.file),
      p = reduce(source, data.limit);
    self.postMessage(
      { gray: p.gray, w: p.w, h: p.h, width: source.w, height: source.h },
      { transfer: [p.gray.buffer] },
    );
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};

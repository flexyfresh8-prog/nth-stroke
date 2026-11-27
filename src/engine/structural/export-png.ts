import { paint, type Placed } from './geometry';
import { surface } from './source';
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let k = 0; k < 8; k++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  return n >>> 0;
});
function chunk(name: string, data: Uint8Array): Blob {
  const head = new Uint8Array(8),
    tail = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(new TextEncoder().encode(name), 4);
  let crc = 0xffffffff;
  for (const b of head.subarray(4)) crc = (crc >>> 8) ^ table[(crc ^ b) & 255];
  for (const b of data) crc = (crc >>> 8) ^ table[(crc ^ b) & 255];
  new DataView(tail.buffer).setUint32(0, (crc ^ 0xffffffff) >>> 0);
  return new Blob([head, new Uint8Array(data), tail]);
}
/** Export at original dimensions with one 64-row band of RGBA in memory. */
export async function exportPng(marks: Placed[], w: number, h: number, white: boolean) {
  const c = surface(w, Math.min(h, 64)),
    ctx = c.getContext('2d', { willReadFrequently: true })!;
  const blocks: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const head = new Uint8Array(13),
    dv = new DataView(head.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  head[8] = 8;
  head[9] = 6;
  blocks.push(chunk('IHDR', head), chunk('tEXt', new TextEncoder().encode('Software\0NTH Stroke V3')));
  let y = 0;
  const sorted = marks
    .map((v, id) => ({ v, id }))
    .filter((v) => v.v.opacity > 0)
    .sort((a, b) => a.v.mark.box[1] + a.v.dy - b.v.mark.box[1] - b.v.dy);
  let cursor = 0,
    active: typeof sorted = [];
  const raw = new ReadableStream<BufferSource>({
    pull(controller) {
      if (y >= h) {
        controller.close();
        return;
      }
      const rows = Math.min(64, h - y);
      ctx.resetTransform();
      ctx.clearRect(0, 0, w, rows);
      if (white) {
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, w, rows);
      }
      ctx.translate(0, -y);
      while (cursor < sorted.length && sorted[cursor].v.mark.box[1] + sorted[cursor].v.dy < y + rows)
        active.push(sorted[cursor++]);
      active = active.filter(({ v }) => v.mark.box[3] + v.dy >= y).sort((a, b) => a.id - b.id);
      for (const { v } of active) paint(ctx, v);
      const data = ctx.getImageData(0, 0, w, rows).data,
        band = new Uint8Array((w * 4 + 1) * rows);
      for (let j = 0; j < rows; j++) band.set(data.subarray(j * w * 4, (j + 1) * w * 4), j * (w * 4 + 1) + 1);
      controller.enqueue(band);
      y += rows;
    },
  });
  const reader = raw.pipeThrough(new CompressionStream('deflate')).getReader();
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    blocks.push(chunk('IDAT', r.value));
  }
  blocks.push(chunk('IEND', new Uint8Array()));
  return new Blob(blocks, { type: 'image/png' });
}

// Full-resolution luminance is one byte per sample. Detailed passes request bounded
// windows from this plane. Only the small composition plane retains RGB.
export interface Plane {
  w: number;
  h: number;
  gray: Uint8Array;
}
export interface Source extends Plane {
  colors: Uint8ClampedArray;
  cw: number;
  ch: number;
}
export const fit = (w: number, h: number, limit: number) => {
  const k = Math.min(1, limit / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
};
export function reduce(source: Plane, limit: number): Plane {
  const { w, h } = fit(source.w, source.h, limit);
  if (w === source.w && h === source.h) return source;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const left = Math.floor((x * source.w) / w),
        right = Math.floor(((x + 1) * source.w) / w);
      const top = Math.floor((y * source.h) / h),
        bottom = Math.floor(((y + 1) * source.h) / h);
      let sum = 0;
      for (let j = top; j < bottom; j++)
        for (let i = left; i < right; i++) sum += source.gray[j * source.w + i];
      gray[y * w + x] = sum / ((right - left) * (bottom - top)) + 0.5;
    }
  return { w, h, gray };
}
function allocate(w: number, h: number): Source {
  if (w < 1 || h < 1 || Math.max(w, h) > 16384)
    throw Error('Choose an image up to 16,384 pixels on its longest side.');
  const { w: cw, h: ch } = fit(w, h, 128);
  return { w, h, gray: new Uint8Array(w * h), cw, ch, colors: new Uint8ClampedArray(cw * ch * 3) };
}
export function surface(w: number, h: number) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function write(s: Source, x: number, y: number, r: number, g: number, b: number, a: number) {
  const fade = 255 - a;
  s.gray[y * s.w + x] = Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) * a) / 255 + fade);
  const col = Math.floor((x * s.cw) / s.w),
    row = Math.floor((y * s.ch) / s.h);
  if (x === Math.floor(((col + 0.5) * s.w) / s.cw) && y === Math.floor(((row + 0.5) * s.h) / s.ch)) {
    const i = 3 * (row * s.cw + col);
    s.colors[i] = (r * a) / 255 + fade;
    s.colors[i + 1] = (g * a) / 255 + fade;
    s.colors[i + 2] = (b * a) / 255 + fade;
  }
}
async function nativeSource(file: Blob) {
  let bitmap: ImageBitmap | HTMLImageElement, release: () => void;
  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(file),
      img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
    bitmap = img;
    release = () => URL.revokeObjectURL(url);
  } else {
    const img = await createImageBitmap(file);
    bitmap = img;
    release = () => img.close();
  }
  try {
    const s = allocate(bitmap.width, bitmap.height),
      c = surface(512, 512),
      ctx = c.getContext('2d', { willReadFrequently: true })!;
    for (let y = 0; y < s.h; y += 512)
      for (let x = 0; x < s.w; x += 512) {
        const w = Math.min(512, s.w - x),
          h = Math.min(512, s.h - y);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++) {
            const p = 4 * (j * w + i);
            write(s, x + i, y + j, data[p], data[p + 1], data[p + 2], data[p + 3]);
          }
      }
    return s;
  } finally {
    release();
  }
}
const adam = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
export async function decodeSource(file: Blob): Promise<Source> {
  const header = new DataView(await file.slice(0, 33).arrayBuffer());
  if (
    header.byteLength < 33 ||
    header.getUint32(0) !== 0x89504e47 ||
    header.getUint32(4) !== 0x0d0a1a0a ||
    typeof DecompressionStream === 'undefined'
  )
    return nativeSource(file);
  const s = allocate(header.getUint32(16), header.getUint32(20)),
    depth = header.getUint8(24),
    type = header.getUint8(25);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw Error('Unsupported PNG encoding.');
  const blocks: Blob[] = [];
  let palette = new Uint8Array(0),
    alpha = new Uint8Array(0);
  for (let off = 33; off + 12 <= file.size;) {
    const v = new DataView(await file.slice(off, off + 8).arrayBuffer()),
      len = v.getUint32(0),
      name = v.getUint32(4);
    if (off + 12 + len > file.size) throw Error('Incomplete PNG.');
    const part = file.slice(off + 8, off + 8 + len);
    if (name === 0x49444154) blocks.push(part);
    if (name === 0x504c5445 && len <= 768) palette = new Uint8Array(await part.arrayBuffer());
    if (name === 0x74524e53 && len <= 256) alpha = new Uint8Array(await part.arrayBuffer());
    if (name === 0x49454e44) break;
    off += 12 + len;
  }
  const key = new DataView(alpha.buffer),
    max = 2 ** depth - 1,
    stride = Math.ceil((depth * channels) / 8);
  const reader = new Blob(blocks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    pos = 0;
  try {
    for (const [ox, oy, dx, dy] of header.getUint8(28) ? adam : [[0, 0, 1, 1]]) {
      if (ox >= s.w || oy >= s.h) continue;
      let row = new Uint8Array(1 + Math.ceil((Math.ceil((s.w - ox) / dx) * channels * depth) / 8)),
        prev = new Uint8Array(row.length);
      function sample(k: number) {
        if (depth === 8) return row[k + 1];
        if (depth === 16) return row[k * 2 + 1] * 256 + row[k * 2 + 2];
        return (row[1 + ((k * depth) >> 3)] >> (8 - depth - ((k * depth) & 7))) & max;
      }
      for (let y = oy; y < s.h; y += dy) {
        for (let n = 0; n < row.length;) {
          if (pos === buf.length) {
            const read = await reader.read();
            if (read.done) throw Error('Incomplete PNG scanline.');
            buf = read.value;
            pos = 0;
          }
          const count = Math.min(buf.length - pos, row.length - n);
          row.set(buf.subarray(pos, pos + count), n);
          n += count;
          pos += count;
        }
        const filter = row[0];
        if (filter > 4) throw Error('Invalid PNG scanline.');
        for (let i = 1; filter && i < row.length; i++) {
          const a = i > stride ? row[i - stride] : 0,
            b = prev[i],
            c = i > stride ? prev[i - stride] : 0;
          const pa = Math.abs(b - c),
            pb = Math.abs(a - c),
            pc = Math.abs(a + b - 2 * c);
          row[i] +=
            filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? (a + b) >> 1
                  : pa <= pb && pa <= pc
                    ? a
                    : pb <= pc
                      ? b
                      : c;
        }
        for (let x = ox, k = 0; x < s.w; x += dx, k += channels) {
          const v = sample(k);
          let r = v,
            g = v,
            b = v,
            a = 255;
          if (type === 3) {
            r = palette[3 * v];
            g = palette[3 * v + 1];
            b = palette[3 * v + 2];
            a = alpha[v] ?? 255;
          } else {
            if (type === 2 || type === 6) {
              g = sample(k + 1);
              b = sample(k + 2);
            }
            if (type === 4 || type === 6) a = (sample(k + channels - 1) * 255) / max;
            if (
              (type === 0 && alpha.length === 2 && v === key.getUint16(0)) ||
              (type === 2 &&
                alpha.length === 6 &&
                r === key.getUint16(0) &&
                g === key.getUint16(2) &&
                b === key.getUint16(4))
            )
              a = 0;
            r = (r * 255) / max;
            g = (g * 255) / max;
            b = (b * 255) / max;
          }
          write(s, x, y, r, g, b, a);
        }
        [prev, row] = [row, prev];
      }
    }
    if (pos !== buf.length || !(await reader.read()).done) throw Error('Invalid PNG scanline count.');
    return s;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

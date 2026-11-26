// Canvas can round RGB when it converts translucent pixels to premultiplied
// alpha. Encode the committed straight-alpha paint buffer directly for PNG.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(name: string, data = new Uint8Array()) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(name), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

export async function encodePng(image: ImageData) {
  const { width, height, data } = image;
  const rowSize = width * 4;
  const rows = new Uint8Array((rowSize + 1) * height);
  // Sub filtering preserves every byte and makes flat and textured areas compress well.
  for (let y = 0; y < height; y++) {
    rows[y * (rowSize + 1)] = 1;
    for (let x = 0; x < rowSize; x++) {
      const index = y * rowSize + x;
      rows[y * (rowSize + 1) + x + 1] = data[index] - (x >= 4 ? data[index - 4] : 0);
    }
  }
  const stream = new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('sRGB', new Uint8Array([0])),
    chunk('IDAT', compressed),
    chunk('IEND'),
  ], { type: 'image/png' });
}

const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(left: number, above: number, corner: number) {
  const predictor = left + above - corner;
  const a = Math.abs(predictor - left);
  const b = Math.abs(predictor - above);
  const c = Math.abs(predictor - corner);
  return a <= b && a <= c ? left : b <= c ? above : corner;
}

/** Preserve RGB under low or zero alpha for ordinary, unscaled 8-bit sRGB PNG inputs. */
export async function readStraightPng(url: string, width: number, height: number) {
  if (!/^data:image\/png[;,]/i.test(url) || typeof DecompressionStream === 'undefined') return;
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const view = new DataView(bytes.buffer);
    if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
      || view.getUint32(16) !== width || view.getUint32(20) !== height || bytes[24] !== 8 || bytes[28] !== 0) return;
    const type = bytes[25];
    const channels = channelsByType[type];
    if (!channels) return;
    let palette: Uint8Array | undefined;
    let alpha: Uint8Array | undefined;
    let standard = false;
    let customColor = false;
    const compressed: Uint8Array[] = [];
    for (let i = 8; i + 12 <= bytes.length;) {
      const length = view.getUint32(i);
      const tag = view.getUint32(i + 4);
      const next = i + length + 12;
      if (next > bytes.length) return;
      const data = bytes.subarray(i + 8, next - 4);
      switch (tag) {
        case 0x49444154: compressed.push(data); break; // IDAT
        case 0x504c5445: palette = data; break; // PLTE
        case 0x74524e53: alpha = data; break; // tRNS
        case 0x73524742: standard = true; break; // sRGB
        case 0x67414d41: customColor ||= length !== 4 || view.getUint32(i + 8) !== 45455; break; // gAMA
        case 0x6348524d: customColor = true; break; // cHRM
        case 0x69434350: case 0x63494350: case 0x6163544c: return; // ICC, CICP, APNG
      }
      i = next;
    }
    if ((!standard && customColor) || !compressed.length || (type === 3 && !palette)) return;

    const rowBytes = width * channels;
    const filtered = new Uint8Array((rowBytes + 1) * height);
    const reader = new Blob(compressed).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let used = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (used + value.length > filtered.length) { await reader.cancel(); return; }
      filtered.set(value, used);
      used += value.length;
    }
    if (used !== filtered.length) return;

    for (let y = 0; y < height; y++) {
      const row = y * (rowBytes + 1);
      const filter = filtered[row];
      if (filter === 0) continue;
      if (filter > 4) return;
      for (let x = 0; x < rowBytes; x++) {
        const i = row + x + 1;
        const left = x >= channels ? filtered[i - channels] : 0;
        const above = y ? filtered[i - rowBytes - 1] : 0;
        const corner = y && x >= channels ? filtered[i - rowBytes - 1 - channels] : 0;
        const value = filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >>> 1 : paeth(left, above, corner);
        filtered[i] += value;
      }
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    const transparent = alpha && new DataView(alpha.buffer, alpha.byteOffset, alpha.byteLength);
    const red = transparent && alpha!.length >= 2 ? transparent.getUint16(0) : -1;
    const green = transparent && alpha!.length >= 6 ? transparent.getUint16(2) : -1;
    const blue = transparent && alpha!.length >= 6 ? transparent.getUint16(4) : -1;
    for (let y = 0; y < height; y++) {
      const first = y * (rowBytes + 1) + 1;
      if (type === 6) {
        rgba.set(filtered.subarray(first, first + rowBytes), y * width * 4);
        continue;
      }
      for (let x = 0; x < width; x++) {
        const from = first + x * channels;
        const to = (y * width + x) * 4;
        const v = filtered[from];
        if (type === 3 && palette) {
          if (v * 3 + 2 >= palette.length) return;
          rgba[to] = palette[v * 3];
          rgba[to + 1] = palette[v * 3 + 1];
          rgba[to + 2] = palette[v * 3 + 2];
          rgba[to + 3] = alpha?.[v] ?? 255;
        } else if (type === 2) {
          const g = filtered[from + 1];
          const b = filtered[from + 2];
          rgba[to] = v;
          rgba[to + 1] = g;
          rgba[to + 2] = b;
          rgba[to + 3] = v === red && g === green && b === blue ? 0 : 255;
        } else {
          rgba[to] = rgba[to + 1] = rgba[to + 2] = v;
          rgba[to + 3] = type === 4 ? filtered[from + 1] : v === red ? 0 : 255;
        }
      }
    }
    return new ImageData(rgba, width, height);
  } catch {
    return;
  }
}

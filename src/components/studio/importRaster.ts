import type { EngineId } from '@/engine/control/contract';
export async function importRaster(
  file: Blob,
  engine: EngineId,
  limit: number,
  size?: { width: number; height: number },
) {
  const url = URL.createObjectURL(file),
    img = new Image(),
    head = new DataView(await file.slice(0, 24).arrayBuffer());
  const png = head.byteLength >= 24 && head.getUint32(0) === 0x89504e47;
  try {
    let width = png ? head.getUint32(16) : 0,
      height = png ? head.getUint32(20) : 0;
    const canvas = document.createElement('canvas'),
      ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    function resize() {
      const scale = Math.min(1, limit / Math.max(width, height)),
        min = engine === 'v2' ? 1 : 8;
      canvas.width = size?.width ?? Math.max(min, Math.round(width * scale));
      canvas.height = size?.height ?? Math.max(min, Math.round(height * scale));
    }
    let pixels: ImageData | undefined;
    if (!png || Math.max(width, height) <= 4096) {
      try {
        img.src = url;
        await img.decode();
        width = img.naturalWidth;
        height = img.naturalHeight;
        resize();
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (e) {
        if (!png) throw e;
      }
    }
    const hasInk = (p: ImageData) =>
      p.data.some((v, i) => i % 4 < 3 && v < 255 && p.data[i - (i % 4) + 3] > 0);
    if (png && (!pixels || !hasInk(pixels))) {
      const worker = new Worker(new URL('../../engine/structural/preview.worker.ts', import.meta.url), {
        type: 'module',
      });
      try {
        const p = await new Promise<{ gray: Uint8Array; w: number; h: number }>((resolve, reject) => {
          worker.onmessage = ({ data }) => (data.error ? reject(Error(data.error)) : resolve(data));
          worker.onerror = (e) => reject(Error(e.message));
          worker.postMessage({ file, limit: size ? Math.max(size.width, size.height) : limit });
        });
        resize();
        pixels = ctx.createImageData(canvas.width, canvas.height);
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++) {
            const i = 4 * (y * canvas.width + x),
              v = p.gray[Math.floor((y * p.h) / canvas.height) * p.w + Math.floor((x * p.w) / canvas.width)];
            pixels.data.set([v, v, v, 255], i);
          }
        ctx.putImageData(pixels, 0, 0);
      } finally {
        worker.terminate();
      }
    }
    if (!pixels || (!size && !hasInk(pixels)))
      throw Error('The reference has no visible marks after decoding.');
    return { bitmap: await createImageBitmap(canvas), pixels, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

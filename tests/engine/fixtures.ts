/**
 * Synthetic reference fixtures for the headless verification suite
 * (spec §15-10: portraits, architecture, landscapes, animals, objects).
 * Procedurally generated, fully deterministic, no external assets.
 */

export interface Fixture {
  name: string;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export const GRAY = (v: number) => [v, v, v, 255] as const;

function canvas(width: number, height: number): { rgba: Uint8ClampedArray; set: (x: number, y: number, r: number, g: number, b: number) => void } {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 245;
    rgba[i * 4 + 1] = 243;
    rgba[i * 4 + 2] = 238;
    rgba[i * 4 + 3] = 255;
  }
  return {
    rgba,
    set(x, y, r, g, b) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    },
  };
}

/** A lit sphere on a light ground — classic form-shading exercise. */
export function sphereFixture(size = 320): Fixture {
  const c = canvas(size, size);
  const cx = size * 0.5;
  const cy = size * 0.55;
  const r = size * 0.3;
  const light = { x: -0.55, y: -0.6, z: 0.58 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / r;
      const dy = (y - cy) / r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const dz = Math.sqrt(1 - d2);
      const shade = Math.max(0.08, dx * light.x + dy * light.y + dz * light.z);
      const v = Math.round(28 + shade * 205);
      // Specular highlight.
      const spec = Math.max(0, dx * light.x + dy * light.y + dz * light.z - 0.965) * 22 * 255;
      c.set(x, y, Math.min(255, v + spec), Math.min(255, v + spec), Math.min(255, v + spec * 0.96));
    }
  }
  // Cast shadow.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x - (cx + r * 0.85);
      const sy = y - (cy + r * 0.8);
      const d = Math.hypot(sx * 0.8, sy * 0.5);
      if (d < r * 0.75 && Math.hypot(x - cx, y - cy) > r) {
        const k = 1 - d / (r * 0.75);
        const i = (y * size + x) * 4;
        const v = 245 - k * 150;
        c.rgba[i] = v;
        c.rgba[i + 1] = v;
        c.rgba[i + 2] = v;
      }
    }
  }
  return { name: 'sphere', rgba: c.rgba, width: size, height: size };
}

/** A synthetic portrait: head oval, eyes, brows, nose, mouth, hair mass. */
export function portraitFixture(w = 340, h = 420): Fixture {
  const c = canvas(w, h);
  const cx = w / 2;
  const cy = h * 0.46;
  const rx = w * 0.27;
  const ry = h * 0.33;
  const light = { x: -0.45, y: -0.35, z: 0.82 };
  const inEllipse = (x: number, y: number, k = 1) => ((x - cx) / (rx * k)) ** 2 + ((y - cy) / (ry * k)) ** 2 <= 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inEllipse(x, y)) continue;
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const shade = Math.max(0.35, nx * light.x + ny * light.y + nz * light.z);
      const v = Math.round(150 + shade * 85);
      c.set(x, y, v + 12, v + 3, v - 4);
    }
  }
  // Hair mass: darker top of the head.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hair = inEllipse(x, y, 1.06) && y < cy - ry * 0.28;
      if (hair) {
        const k = y < cy - ry * 0.75 ? 1 : 0.85;
        c.set(x, y, 62 * k + 20, 48 * k + 18, 38 * k + 16);
      }
    }
  }
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    // Integer bounds — typed arrays silently ignore fractional indices.
    const ix0 = Math.round(x0);
    const iy0 = Math.round(y0);
    const ix1 = Math.round(x1);
    const iy1 = Math.round(y1);
    for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) c.set(x, y, v, v, v);
  };
  // Eyes (white sclera + dark iris), brows, nose shadow, lips.
  const eyeY = cy - ry * 0.12;
  const eyeDx = rx * 0.42;
  for (const side of [-1, 1]) {
    const ex = cx + side * eyeDx;
    fill(ex - 16, eyeY - 7, ex + 16, eyeY + 7, 235);
    fill(ex - 6, eyeY - 6, ex + 6, eyeY + 6, 52);
    fill(ex - 2, eyeY - 2, ex + 2, eyeY + 2, 12);
    fill(ex - 15, eyeY - 12 - side * 0, ex + 15, eyeY - 9, 90); // brow
  }
  // Nose shadow + tip.
  fill(cx - 4, cy + ry * 0.05, cx + 3, cy + ry * 0.28, 168);
  fill(cx - 5, cy + ry * 0.3, cx + 5, cy + ry * 0.34, 120);
  // Mouth.
  fill(cx - 26, cy + ry * 0.52, cx + 26, cy + ry * 0.62, 172);
  fill(cx - 14, cy + ry * 0.54, cx + 14, cy + ry * 0.6, 128);
  // Jaw shading.
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!inEllipse(x, y)) continue;
      const edge = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (edge > 0.72) {
        const i = (y * w + x) * 4;
        const k = (edge - 0.72) / 0.28;
        c.rgba[i] = c.rgba[i] * (1 - k * 0.5);
        c.rgba[i + 1] = c.rgba[i + 1] * (1 - k * 0.5);
        c.rgba[i + 2] = c.rgba[i + 2] * (1 - k * 0.5);
      }
    }
  }
  // Neck + shoulders.
  fill(cx - rx * 0.5, cy + ry * 0.96, cx + rx * 0.5, h - 1, 178);
  for (let x = 0; x < w; x++) {
    const shoulderY = h * 0.86 + Math.abs(x - cx) * 0.14;
    for (let y = Math.max(0, shoulderY | 0); y < h; y++) c.set(x, y, 96, 88, 84);
  }
  return { name: 'portrait', rgba: c.rgba, width: w, height: h };
}

/** Two-point-perspective-ish building mass (architecture). */
export function architectureFixture(w = 420, h = 300): Fixture {
  const c = canvas(w, h);
  const horizon = h * 0.52;
  // Sky.
  for (let y = 0; y < horizon; y++) {
    const v = 235 - (y / horizon) * 30;
    for (let x = 0; x < w; x++) c.set(x, y, v, v + 1, v + 4);
  }
  // Ground.
  for (let y = Math.floor(horizon); y < h; y++) {
    const v = 215 - ((y - horizon) / (h - horizon)) * 45;
    for (let x = 0; x < w; x++) c.set(x, y, v, v - 2, v - 6);
  }
  // Main block: front face lighter, side face darker (light from left).
  const block = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, front: number, side: number) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Front quad: (x0,y0)-(x1,y1) tall; side quad offset.
        const inFront = x >= x0 && x <= x1 && y >= y0 && y <= y2;
        const inSide = x > x1 && x <= x2 && y >= y0 + (x - x1) * 0.45 && y <= y2 + (x - x1) * 0.45;
        if (inFront) c.set(x, y, front, front, front);
        else if (inSide) c.set(x, y, side, side, side);
      }
    }
    // Windows on the front face.
    for (let wy = y0 + 14; wy < y2 - 10; wy += 22) {
      for (let wx = x0 + 10; wx < x1 - 8; wx += 18) {
        for (let y = wy; y < wy + 12; y++) {
          for (let x = wx; x < wx + 10; x++) c.set(x, y, 70, 74, 82);
        }
      }
    }
  };
  block(70, 60, 210, 230, 300, 230, 205, 130);
  block(215, 100, 330, 230, 395, 230, 190, 120);
  return { name: 'architecture', rgba: c.rgba, width: w, height: h };
}

/** Layered hills under a bright sky (landscape). */
export function landscapeFixture(w = 400, h = 260): Fixture {
  const c = canvas(w, h);
  for (let y = 0; y < h * 0.62; y++) {
    const v = 232 - (y / (h * 0.62)) * 18;
    for (let x = 0; x < w; x++) c.set(x, y, v, v, Math.min(255, v + 8));
  }
  const hill = (base: number, amp: number, freq: number, phase: number, tone: number) => {
    for (let x = 0; x < w; x++) {
      const top = base - Math.sin(x * freq + phase) * amp - Math.sin(x * freq * 2.7 + phase * 1.7) * amp * 0.35;
      for (let y = Math.max(0, top | 0); y < h; y++) {
        const shade = tone + (y - top) * 0.12;
        c.set(x, y, Math.min(255, shade), Math.min(255, shade + 3), Math.min(255, shade + 8));
      }
    }
  };
  hill(h * 0.62, 26, 0.012, 1.2, 176);
  hill(h * 0.74, 20, 0.019, 4.0, 138);
  hill(h * 0.88, 14, 0.03, 2.2, 96);
  return { name: 'landscape', rgba: c.rgba, width: w, height: h };
}

/** Sitting cat silhouette (animal). */
export function animalFixture(w = 380, h = 300): Fixture {
  const c = canvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) c.set(x, y, 236, 234, 228);
  }
  const inside = (x: number, y: number): number => {
    // Body: seated cat composed of ellipses.
    const body = ((x - w * 0.46) / (w * 0.21)) ** 2 + ((y - h * 0.62) / (h * 0.26)) ** 2;
    const head = ((x - w * 0.42) / (w * 0.13)) ** 2 + ((y - h * 0.3) / (h * 0.13)) ** 2;
    const earL = Math.abs((x - w * 0.345) * 0.8 + (y - h * 0.22) * 1.1) < w * 0.035 && y < h * 0.24 ? 0.5 : 9;
    const earR = Math.abs((x - w * 0.5) * 0.8 - (y - h * 0.22) * 1.1) < w * 0.035 && y < h * 0.24 ? 0.5 : 9;
    const tail = Math.abs(y - (h * 0.78 + Math.sin(x * 0.03) * h * 0.06)) < h * 0.035 && x > w * 0.6 ? 0.6 : 9;
    return Math.min(body, head, earL, earR, tail);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = inside(x, y);
      if (d > 1) continue;
      // Light from upper left.
      const shade = d < 0.6 ? 0.55 : x < w * 0.44 ? 0.95 : 0.7;
      const v = Math.round(40 + shade * 60);
      c.set(x, y, v + 14, v + 8, v);
    }
  }
  // Eye glints.
  c.set(Math.round(w * 0.4), Math.round(h * 0.29), 235, 235, 230);
  c.set(Math.round(w * 0.4) + 1, Math.round(h * 0.29), 235, 235, 230);
  return { name: 'animal', rgba: c.rgba, width: w, height: h };
}

/** All fixtures used by the verification suite (spec §15-10). */
export function allFixtures(): Fixture[] {
  return [sphereFixture(), portraitFixture(), architectureFixture(), landscapeFixture(), animalFixture()];
}

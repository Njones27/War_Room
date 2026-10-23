// BF6-style pixelated digital camo, generated once into a small texture and
// tiled across the terrain with nearest-neighbor sampling so it stays blocky.
import { CanvasTexture, NearestFilter, RepeatWrapping, SRGBColorSpace } from "three";

// Sampled from the deploy-screen reference shots (dark navy slate tones),
// weighted toward the mid tones the way BF6's camo is.
export const CAMO_PALETTE = ["#070e14", "#0c161d", "#131c22", "#162027", "#1f292f", "#29333a"];
const THRESHOLDS = [0.16, 0.33, 0.5, 0.66, 0.82];

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  const u = s(xf);
  const v = s(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fbm: sample on a torus so the texture repeats seamlessly. */
function fbm(x: number, y: number, size: number, period: number, seed: number): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    const p = period * freq;
    const nx = (x / size) * p;
    const ny = (y / size) * p;
    // Wrap by blending the four periodic copies (cheap seamless tiling).
    const fx = nx / p;
    const fy = ny / p;
    const n00 = valueNoise(nx, ny, seed + o);
    const n10 = valueNoise(nx - p, ny, seed + o);
    const n01 = valueNoise(nx, ny - p, seed + o);
    const n11 = valueNoise(nx - p, ny - p, seed + o);
    const n = n00 * (1 - fx) * (1 - fy) + n10 * fx * (1 - fy) + n01 * (1 - fx) * fy + n11 * fx * fy;
    total += n * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / 0.9375;
}

export function createCamoTexture(size = 256): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const rgb = CAMO_PALETTE.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Two quantization scales: coarse blocks over fine "digital" pixels.
      const cx = Math.floor(x / 4) * 4;
      const cy = Math.floor(y / 4) * 4;
      const fx = Math.floor(x / 2) * 2;
      const fy = Math.floor(y / 2) * 2;
      const coarse = fbm(cx, cy, size, 5, 11);
      const fine = fbm(fx, fy, size, 11, 29);
      const mixed = hash(cx, cy, 7) > 0.5 ? coarse * 0.75 + fine * 0.25 : coarse * 0.45 + fine * 0.55;
      // fbm piles up around 0.5; stretch it so every tone shows up.
      const n = Math.min(1, Math.max(0, (mixed - 0.5) * 2.6 + 0.5));
      let idx = 0;
      while (idx < THRESHOLDS.length && n > THRESHOLDS[idx]!) idx++;
      const [r, g, b] = rgb[idx]!;
      const i = (y * size + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Faint topographic contour lines (white on transparent) for the playable terrain. */
export function createContourTexture(size = 512): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, size, 3, 101) * 14;
      const d = Math.abs(n - Math.round(n));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = d < 0.05 ? 30 : d < 0.08 ? 12 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

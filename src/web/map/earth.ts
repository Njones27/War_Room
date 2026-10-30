// The orbit view's Earth: Natural Earth coastlines (public domain, from the
// world-atlas package) rasterized into textures, city lights, the network
// shell, and the mascot satellite sprites.
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NearestFilter, SRGBColorSpace } from "three";
import { ARM_L, ARM_R, BODY, EYES, GEAR, LEGS_A, toRects, type Rect } from "../sprites/art";

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

interface Topology {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: { land: { geometries: { type: string; arcs: number[][][] | number[][] }[] } };
}

/** Natural Earth land (public domain, via world-atlas) as rings of [lon, lat]. */
function landRings(topo: Topology): [number, number][][][] {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as [number, number];
    });
  });
  const ring = (ids: number[]) => {
    const out: [number, number][] = [];
    for (const id of ids) {
      const arc = id < 0 ? [...arcs[~id]!].reverse() : arcs[id]!;
      out.push(...(out.length ? arc.slice(1) : arc));
    }
    return out;
  };
  const polys: [number, number][][][] = [];
  for (const g of topo.objects.land.geometries) {
    if (g.type === "Polygon") polys.push((g.arcs as number[][]).map(ring));
    else if (g.type === "MultiPolygon") for (const p of g.arcs as number[][][]) polys.push(p.map(ring));
  }
  return polys;
}

/**
 * Make a ring's longitudes continuous across the date line (no 360° jumps,
 * which would smear a band across the map). A ring that circles a pole
 * (Antarctica) is closed through that pole.
 */
function unwrap(r: [number, number][]): [number, number][] {
  const out: [number, number][] = [r[0]!];
  for (let i = 1; i < r.length; i++) {
    let [lon, lat] = r[i]!;
    const prev = out[out.length - 1]![0];
    while (lon - prev > 180) lon -= 360;
    while (prev - lon > 180) lon += 360;
    out.push([lon, lat]);
  }
  if (Math.abs(out[out.length - 1]![0] - out[0]![0]) > 180) {
    const pole = out.reduce((sum, p) => sum + p[1], 0) / out.length < 0 ? -90 : 90;
    out.push([out[out.length - 1]![0], pole], [out[0]![0], pole]);
  }
  return out;
}

export interface EarthTextures {
  land: CanvasTexture;
  lights: CanvasTexture;
}

/**
 * Equirectangular textures from real coastlines: `land` (white = land, soft
 * edges) and `lights` (warm city lights, clustered, for the night side).
 */
let earth: Promise<EarthTextures> | null = null;

/** Built once and shared; call early (when idle) so the trip to orbit doesn't stall on it. */
export function loadEarthTextures(): Promise<EarthTextures> {
  // A failed load (e.g. the data chunk didn't arrive) isn't kept, so the next call tries again.
  earth ??= buildEarthTextures().catch((err: unknown) => {
    earth = null;
    throw err;
  });
  return earth;
}

async function buildEarthTextures(): Promise<EarthTextures> {
  const topo = (await import("world-atlas/land-50m.json")).default as unknown as Topology;
  const w = 4096;
  const h = 2048;
  const land = document.createElement("canvas");
  land.width = w;
  land.height = h;
  const c = land.getContext("2d", { willReadFrequently: true })!;
  c.fillStyle = "#000";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#fff";
  for (const poly of landRings(topo)) {
    const rings = poly.map(unwrap);
    // Drawn three times so outlines that cross the date line wrap round.
    for (const off of [-360, 0, 360]) {
      c.beginPath();
      for (const r of rings) {
        r.forEach(([lon, lat], i) => {
          const x = ((lon + off + 180) / 360) * w;
          const y = ((90 - lat) / 180) * h;
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.closePath();
      }
      c.fill("evenodd");
    }
  }
  const mask = c.getImageData(0, 0, w, h).data;
  const landAt = (lat: number, lon: number) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
    return mask[(y * w + x) * 4]! > 128;
  };

  // City lights: bright cores with suburbs, denser in the temperate north, a few along coasts.
  const lights = document.createElement("canvas");
  lights.width = w;
  lights.height = h;
  const l = lights.getContext("2d")!;
  l.fillStyle = "#000";
  l.fillRect(0, 0, w, h);
  const r = rng(11);
  let placed = 0;
  for (let tries = 0; placed < 900 && tries < 60000; tries++) {
    const lat = -45 + r() * 110;
    const lon = -180 + r() * 360;
    if (lat > 64 || !landAt(lat, lon)) continue;
    if (lat < 15 && r() < 0.45) continue;
    placed++;
    const cx = ((lon + 180) / 360) * w;
    const cy = ((90 - lat) / 180) * h;
    const size = r() < 0.12 ? 3 : r() < 0.4 ? 2 : 1;
    for (let k = 0; k < 4 + size * 10; k++) {
      const a = r() * Math.PI * 2;
      const d = r() * r() * (3 + size * 6);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (!landAt(90 - (y / h) * 180, (x / w) * 360 - 180)) continue;
      const v = Math.round(90 + r() * 165);
      l.fillStyle = `rgb(${v},${v},${v})`;
      l.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
  }
  // A soft glow around each city.
  const glow = document.createElement("canvas");
  glow.width = w;
  glow.height = h;
  const g = glow.getContext("2d")!;
  g.filter = "blur(3px)";
  g.drawImage(lights, 0, 0);
  l.globalCompositeOperation = "lighter";
  l.globalAlpha = 0.9;
  l.drawImage(glow, 0, 0);

  const tex = (cv: HTMLCanvasElement) => {
    const t = new CanvasTexture(cv);
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.anisotropy = 8;
    return t;
  };
  return { land: tex(land), lights: tex(lights) };
}

/** A blank texture while the coastlines load. */
export function blankTexture(): CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 2;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 2, 2);
  return new CanvasTexture(cv);
}

/**
 * The network shell: circular tracks at mixed inclinations (including polar),
 * so they cross in a loose geodesic net rather than one dense band. Returned
 * as segment pairs.
 */
export function latticePositions(): number[] {
  const out: number[] = [];
  const shells: { inc: number; planes: number; r: number }[] = [
    { inc: 53, planes: 14, r: 1.13 },
    { inc: 70, planes: 10, r: 1.135 },
    { inc: 87, planes: 8, r: 1.14 },
    { inc: 30, planes: 8, r: 1.145 },
  ];
  const seg = 220;
  for (const s of shells) {
    const inc = (s.inc * Math.PI) / 180;
    for (let p = 0; p < s.planes; p++) {
      const node = (p / s.planes) * Math.PI * 2 + (s.inc * Math.PI) / 360;
      const at = (t: number) => {
        const x = Math.cos(t) * s.r;
        const z = Math.sin(t) * s.r;
        const y1 = -z * Math.sin(inc);
        const z1 = z * Math.cos(inc);
        return [x * Math.cos(node) + z1 * Math.sin(node), y1, -x * Math.sin(node) + z1 * Math.cos(node)];
      };
      for (let i = 0; i < seg; i++) out.push(...at((i / seg) * Math.PI * 2), ...at(((i + 1) / seg) * Math.PI * 2));
    }
  }
  return out;
}

/** Pixel mascot satellite: the squad's mascot (with its role gear) on solar wings. */
export function satelliteSprite(accessory: string | null, tone: "own" | "app"): CanvasTexture {
  const px = 4;
  const W = 40;
  const H = 24;
  const cv = document.createElement("canvas");
  cv.width = W * px;
  cv.height = H * px;
  const c = cv.getContext("2d")!;
  const draw = (r: Rect, dx: number, dy: number, fill?: string) => {
    c.fillStyle = fill ?? r.fill;
    c.fillRect((r.x + dx) * px, (r.y + dy) * px, r.w * px, r.h * px);
  };
  const dx = 9;
  const dy = 1;
  // Solar wings: struts from the arms, then panels with cell lines.
  const panel = tone === "app" ? "#5b6b78" : "#3f86b3";
  const cell = tone === "app" ? "#3a4650" : "#22506e";
  c.fillStyle = "#c9d3d8";
  c.fillRect(2 * px, 16 * px, 38 * px - 2 * px, px);
  for (const x0 of [0, 31]) {
    c.fillStyle = panel;
    c.fillRect(x0 * px, 12 * px, 9 * px, 9 * px);
    c.fillStyle = cell;
    for (let k = 1; k < 3; k++) c.fillRect((x0 + k * 3) * px, 12 * px, px / 2, 9 * px);
    c.fillRect(x0 * px, 16 * px + px / 4, 9 * px, px / 2);
  }
  const bodyFill = tone === "app" ? { O: "#8e9aa2", o: "#6f7b83", h: "#a9b4ba" } : null;
  for (const r of toRects(BODY, dx, dy)) draw(r, 0, 0, bodyFill ? (r.fill === "#d97757" ? bodyFill.O : r.fill === "#b8604a" ? bodyFill.o : bodyFill.h) : undefined);
  for (const r of [ARM_L, ARM_R, ...LEGS_A]) draw(r, dx, dy, bodyFill?.O);
  for (const r of EYES) draw(r, dx, dy);
  for (const layer of (accessory && GEAR[accessory]) || []) for (const r of toRects(layer, dx, dy)) draw(r, 0, 0);
  // Antenna with a beacon.
  c.fillStyle = "#c9d3d8";
  c.fillRect((dx + 15) * px, (dy + 6) * px, px, 5 * px);
  c.fillStyle = "#e6e873";
  c.fillRect((dx + 15) * px - px / 2, (dy + 5) * px, px * 2, px);
  const t = new CanvasTexture(cv);
  t.magFilter = NearestFilter;
  t.minFilter = LinearFilter;
  t.colorSpace = SRGBColorSpace;
  return t;
}

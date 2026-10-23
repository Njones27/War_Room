// Code City layout: a squarified treemap where folders become blocks,
// the gaps between them read as roads, and every file is a building.
import type { Block, Building, CityModel, District, Point, Rect, RoofDetail, Tree } from "../../shared/city.js";
import { hash01, prng } from "../util.js";
import type { TreeNode } from "./scan.js";

/** Road width between siblings, indexed by the depth of the children being separated. */
const GAPS = [0, 7.5, 4.2, 2.6, 1.6];
const AREA_PER_WEIGHT = 9;
/** Every asset (an image, font, archive…) is drawn like a file of this many lines, so big ones don't crowd out the code. */
const ASSET_LINES = 12;
const MIN_CITY = { w: 150, h: 96 };

type LNode =
  | { kind: "dir"; path: string; name: string; depth: number; weight: number; children: LNode[]; files: number; lines: number }
  | { kind: "group"; path: string; depth: number; weight: number; files: LFile[] }
  | LFile;

interface LFile {
  kind: "file";
  path: string;
  weight: number;
  lines: number;
  /** The line count its size follows. */
  size: number;
  bytes: number;
  cluster: number;
  asset: boolean;
}

function fileWeight(lines: number, cluster: number): number {
  return 6 + Math.sqrt(lines + 1) * 1.7 + (cluster > 1 ? Math.sqrt(cluster) * 6 : 0);
}

/** Directories hold subdirectories plus at most one "group" of their direct files. */
function toLayoutTree(n: TreeNode): LNode {
  const files: LFile[] = [];
  const dirs: LNode[] = [];
  for (const c of n.children.values()) {
    if (c.children.size === 0 && c.file) {
      const asset = c.file.asset === true;
      const size = asset ? ASSET_LINES : c.file.lines;
      files.push({ kind: "file", path: c.path, weight: fileWeight(size, c.cluster), lines: c.file.lines, size, bytes: c.file.bytes, cluster: c.cluster, asset });
    } else if (c.children.size > 0) dirs.push(toLayoutTree(c));
  }
  const children: LNode[] = [...dirs];
  if (files.length) children.push({ kind: "group", path: n.path, depth: n.depth, weight: files.reduce((s, f) => s + f.weight, 0), files });
  return { kind: "dir", path: n.path, name: n.name, depth: n.depth, weight: children.reduce((s, c) => s + c.weight, 0), children, files: n.files, lines: n.lines };
}

// ── Squarified treemap (Bruls, Huizing & van Wijk) ──────────────────────────

interface Cell<T> {
  rect: Rect;
  item: T;
}

function worst(row: number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = s * s;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

export function squarify<T>(items: { weight: number; item: T }[], rect: Rect): Cell<T>[] {
  const valid = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = valid.reduce((s, i) => s + i.weight, 0);
  if (!valid.length || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const areas = valid.map((i) => ({ a: i.weight * scale, item: i.item }));
  const out: Cell<T>[] = [];
  let r = { ...rect };
  let row: typeof areas = [];

  const flush = () => {
    const s = row.reduce((acc, x) => acc + x.a, 0);
    if (r.w >= r.h) {
      const colW = s / r.h;
      let y = r.y;
      for (const x of row) {
        const h = x.a / colW;
        out.push({ rect: { x: r.x, y, w: colW, h }, item: x.item });
        y += h;
      }
      r = { x: r.x + colW, y: r.y, w: r.w - colW, h: r.h };
    } else {
      const rowH = s / r.w;
      let x0 = r.x;
      for (const x of row) {
        const w = x.a / rowH;
        out.push({ rect: { x: x0, y: r.y, w, h: rowH }, item: x.item });
        x0 += w;
      }
      r = { x: r.x, y: r.y + rowH, w: r.w, h: r.h - rowH };
    }
    row = [];
  };

  let i = 0;
  while (i < areas.length) {
    const side = Math.min(r.w, r.h);
    const next = areas[i]!;
    if (row.length === 0 || worst([...row, next].map((x) => x.a), side) <= worst(row.map((x) => x.a), side)) {
      row.push(next);
      i++;
    } else flush();
  }
  if (row.length) flush();
  return out;
}

/** Inset a rect by d on every side (negative d grows it). Never collapses below 0.1. */
export function shrink(r: Rect, d: number): Rect {
  const dx = Math.min(d, r.w / 2 - 0.05);
  const dy = Math.min(d, r.h / 2 - 0.05);
  return { x: r.x + dx, y: r.y + dy, w: Math.max(0.1, r.w - 2 * dx), h: Math.max(0.1, r.h - 2 * dy) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── Buildings ───────────────────────────────────────────────────────────────

function placeBuilding(f: LFile, lot: Rect, district: string, out: { buildings: Building[]; roofs: RoofDetail[]; trees: Tree[] }): void {
  const h = (k: string) => hash01(`${f.path}#${k}`);
  const margin = clamp(0.4 + 0.06 * Math.min(lot.w, lot.h), 0.5, 2.0);
  const inner = shrink(lot, margin);
  const fw = Math.max(0.8, inner.w * (0.74 + 0.24 * h("w")));
  const fh = Math.max(0.8, inner.h * (0.74 + 0.24 * h("h")));
  const x = inner.x + (inner.w - fw) * (h("ax") < 0.5 ? 0 : h("ax") < 0.75 ? 1 : 0.5);
  const y = inner.y + (inner.h - fh) * (h("ay") < 0.5 ? 0 : h("ay") < 0.75 ? 1 : 0.5);
  const height = clamp(2 + Math.log2(1 + f.size) * 1.6 + (f.cluster > 1 ? 4 : 0) + h("z") * 2, 2.2, 34);

  let tower: Building["tower"] = null;
  if (Math.min(fw, fh) > 13 && f.size > 150) {
    const tw = fw * (0.5 + 0.2 * h("tw"));
    const th = fh * (0.5 + 0.2 * h("th"));
    tower = { x: x + (fw - tw) * h("tx"), y: y + (fh - th) * h("ty"), w: tw, h: th, height: height * 1.5 };
  }
  const podium = tower ? height * 0.5 : height;
  out.buildings.push({ path: f.path, x, y, w: fw, h: fh, height: podium, lines: f.lines, bytes: f.bytes, ...(f.asset ? { asset: true } : {}), district, shade: h("shade"), cluster: f.cluster, tower });

  // Roof clutter (AC units, stairwells) on bigger roofs.
  const roofBase = tower ? tower.height : podium;
  const roofRect = tower ?? { x, y, w: fw, h: fh };
  if (roofRect.w * roofRect.h > 50) {
    const n = 1 + Math.floor(h("rn") * 3);
    for (let i = 0; i < n; i++) {
      const rw = 1.2 + h(`rw${i}`) * 1.6;
      const rd = 1.2 + h(`rd${i}`) * 1.6;
      out.roofs.push({
        x: roofRect.x + 0.8 + (roofRect.w - rw - 1.6) * h(`rx${i}`),
        y: roofRect.y + 0.8 + (roofRect.h - rd - 1.6) * h(`ry${i}`),
        w: rw,
        h: rd,
        height: 0.5 + h(`rh${i}`) * 0.9,
        base: roofBase,
      });
    }
  }

  // A tree in leftover yard space.
  const leftover = inner.w * inner.h - fw * fh;
  if (leftover > 40 && h("tree") > 0.35) {
    const tx = x > inner.x + 0.1 ? inner.x + 1.6 : inner.x + inner.w - 1.6;
    const ty = y > inner.y + 0.1 ? inner.y + 1.6 : inner.y + inner.h - 1.6;
    out.trees.push({ x: tx, y: ty, r: 1.2 + h("tr") * 1.2 });
  }
}

/** Decorative blocks around a small downtown core. Paths start with "@decor" and aren't pickable. */
function addOutskirts(city: Rect, core: Rect, rnd: () => number, out: { buildings: Building[]; trees: Tree[] }, blocks: Block[]): void {
  const cell = 24;
  const keepOut = shrink(core, -GAPS[1]!);
  let n = 0;
  for (let y = city.y; y + cell * 0.6 <= city.y + city.h; y += cell) {
    for (let x = city.x; x + cell * 0.6 <= city.x + city.w; x += cell) {
      const cellRect: Rect = { x, y, w: Math.min(cell, city.x + city.w - x), h: Math.min(cell, city.y + city.h - y) };
      const r = shrink(cellRect, GAPS[2]! / 2);
      const hits = r.x < keepOut.x + keepOut.w && keepOut.x < r.x + r.w && r.y < keepOut.y + keepOut.h && keepOut.y < r.y + r.h;
      if (hits) continue;
      blocks.push({ path: "@decor", rect: r, depth: 1 });
      if (rnd() < 0.18) {
        // A park: trees instead of buildings.
        for (let i = 0; i < 4; i++) out.trees.push({ x: r.x + 2 + rnd() * (r.w - 4), y: r.y + 2 + rnd() * (r.h - 4), r: 1.3 + rnd() * 1.5 });
        continue;
      }
      const lots = squarify(
        Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => ({ weight: 0.5 + rnd(), item: i })),
        r,
      );
      for (const lot of lots) {
        const inner = shrink(lot.rect, 0.8);
        const fw = inner.w * (0.72 + rnd() * 0.25);
        const fh = inner.h * (0.72 + rnd() * 0.25);
        out.buildings.push({
          path: `@decor/${n++}`,
          x: inner.x + (inner.w - fw) * (rnd() < 0.5 ? 0 : 1),
          y: inner.y + (inner.h - fh) * (rnd() < 0.5 ? 0 : 1),
          w: fw,
          h: fh,
          height: 2.5 + rnd() * 9,
          lines: 0,
          bytes: 0,
          district: "@decor",
          shade: rnd() * 0.6,
          cluster: 0,
          tower: null,
        });
      }
    }
  }
}

// ── Boundary + HQ ───────────────────────────────────────────────────────────

function jaggedOutline(r: Rect, rnd: () => number, jitter: number, step: number): Point[] {
  const c = Math.min(r.w, r.h) * 0.1;
  const pts: Point[] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(2, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const off = i === 0 ? 0 : rnd() * jitter;
      pts.push([x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off]);
    }
  };
  const { x, y, w, h } = r;
  edge(x + c, y, x + w - c, y, 0, -1);
  edge(x + w - c, y, x + w, y + c, 0.7, -0.7);
  edge(x + w, y + c, x + w, y + h - c, 1, 0);
  edge(x + w, y + h - c, x + w - c, y + h, 0.7, 0.7);
  edge(x + w - c, y + h, x + c, y + h, 0, 1);
  edge(x + c, y + h, x, y + h - c, -0.7, 0.7);
  edge(x, y + h - c, x, y + c, -1, 0);
  edge(x, y + c, x + c, y, -0.7, -0.7);
  return pts;
}

function roundedRect(r: Rect, radius: number, segs = 6): Point[] {
  const pts: Point[] = [];
  const rad = Math.min(radius, r.w / 2, r.h / 2);
  const corners: [number, number, number][] = [
    [r.x + r.w - rad, r.y + rad, -Math.PI / 2],
    [r.x + r.w - rad, r.y + r.h - rad, 0],
    [r.x + rad, r.y + r.h - rad, Math.PI / 2],
    [r.x + rad, r.y + rad, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
  }
  return pts;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inRect = (p: Point, r: Rect, pad = 0) => p[0] >= r.x - pad && p[0] <= r.x + r.w + pad && p[1] >= r.y - pad && p[1] <= r.y + r.h + pad;

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function layoutCity(tree: TreeNode, meta: { name: string; root: string; fileCount: number; truncated: boolean }): CityModel {
  const rnd = prng(Math.floor(hash01(meta.name || "war-room") * 2 ** 31));
  const lroot = toLayoutTree(tree);
  const out = { buildings: [] as Building[], roofs: [] as RoofDetail[], trees: [] as Tree[] };
  const blocks: Block[] = [];
  const districts: District[] = [];

  const totalWeight = Math.max(1, lroot.weight);
  const naturalArea = totalWeight * AREA_PER_WEIGHT;
  const minArea = MIN_CITY.w * MIN_CITY.h;
  const area = Math.max(naturalArea, minArea);
  const cityW = Math.max(MIN_CITY.w, Math.sqrt(area * 1.55));
  const cityH = Math.max(MIN_CITY.h, area / cityW);
  const city: Rect = { x: 0, y: 0, w: cityW, h: cityH };
  // Small repos keep natural building sizes in a downtown core; the rest of
  // the city is filled with outskirts so the map still reads as a battlefield.
  let core = city;
  if (naturalArea < minArea * 0.8) {
    const s = Math.sqrt(naturalArea / minArea);
    const cw = Math.max(36, cityW * s);
    const ch = Math.max(26, cityH * s);
    core = { x: city.x + (cityW - cw) / 2, y: city.y + (cityH - ch) / 2, w: cw, h: ch };
  }

  const layDir = (node: Extract<LNode, { kind: "dir" }>, rect: Rect, depth: number, district: string) => {
    const gap = GAPS[Math.min(depth + 1, GAPS.length - 1)]!;
    const cells = squarify(
      node.children.map((c) => ({ weight: c.weight, item: c })),
      rect,
    );
    for (const { rect: cellRect, item } of cells) {
      const inner = shrink(cellRect, gap / 2);
      if (item.kind === "dir") {
        const childDistrict = depth === 0 ? item.path : district;
        if (depth === 0) districts.push({ path: item.path, name: item.name, rect: inner, files: item.files, lines: item.lines });
        layDir(item, inner, depth + 1, childDistrict);
      } else if (item.kind === "group") {
        const groupDistrict = depth === 0 ? "" : district;
        if (depth === 0) districts.push({ path: "", name: meta.name, rect: inner, files: item.files.length, lines: item.files.reduce((s, f) => s + f.lines, 0) });
        blocks.push({ path: item.path, rect: inner, depth: item.depth });
        const lots = squarify(
          item.files.map((f) => ({ weight: f.weight, item: f })),
          inner,
        );
        for (const lot of lots) placeBuilding(lot.item, lot.rect, groupDistrict, out);
      }
    }
  };
  if (lroot.kind === "dir") layDir(lroot, core, 0, "");
  if (core !== city) addOutskirts(city, core, rnd, out, blocks);

  // HQ compound west of the city, inside the playable area. Barracks across
  // the top, the HQ badge on the left, staging pads for idle agents below.
  const hqW = clamp(cityH * 0.38, 48, 96);
  const hqH = hqW * 0.85;
  const hq: Rect = { x: city.x - 30 - hqW, y: city.y + cityH * 0.5 - hqH / 2 + (rnd() - 0.5) * cityH * 0.15, w: hqW, h: hqH };
  const hqZone = jaggedOutline(shrink(hq, -4), rnd, 2.5, 7);
  const pads: Point[] = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) pads.push([hq.x + hq.w * (0.14 + c * 0.18), hq.y + hq.h * (0.66 + r * 0.22)]);
  for (let i = 0; i < 3; i++) {
    const bw = hq.w * (0.15 + rnd() * 0.06);
    const bh = hq.h * (0.15 + rnd() * 0.06);
    out.buildings.push({
      path: `@hq/${i}`,
      x: hq.x + hq.w * (0.42 + i * 0.19),
      y: hq.y + hq.h * 0.08,
      w: bw,
      h: bh,
      height: 3 + rnd() * 3,
      lines: 0,
      bytes: 0,
      district: "@hq",
      shade: rnd(),
      cluster: 0,
      tower: null,
    });
  }
  const hqRoad: Point[] = [
    [hq.x + hq.w, hq.y + hq.h * 0.5],
    [city.x - 4, hq.y + hq.h * 0.5],
  ];

  const extent = union(city, hq);
  const margin = 12 + 0.035 * Math.max(extent.w, extent.h);
  const boundary = jaggedOutline(shrink(extent, -margin), rnd, margin * 0.45, 16);
  const ringRoad = roundedRect(shrink(city, -4.5), 10);

  // Forest belt between the city and the boundary.
  const belt = shrink(extent, -margin * 1.5);
  const avoid = (p: Point) => inRect(p, city, 7) || inRect(p, hq, 6) || !pointInPolygon(p, boundary);
  const clusters = Math.round((belt.w + belt.h) / 40);
  for (let i = 0; i < clusters; i++) {
    const cx = belt.x + rnd() * belt.w;
    const cy = belt.y + rnd() * belt.h;
    if (avoid([cx, cy])) continue;
    const n = 3 + Math.floor(rnd() * 7);
    for (let j = 0; j < n; j++) {
      const p: Point = [cx + (rnd() - 0.5) * 18, cy + (rnd() - 0.5) * 18];
      if (!avoid(p)) out.trees.push({ x: p[0], y: p[1], r: 1.4 + rnd() * 1.8 });
    }
  }
  for (let i = 0; i < (belt.w + belt.h) / 6; i++) {
    const p: Point = [belt.x + rnd() * belt.w, belt.y + rnd() * belt.h];
    if (!avoid(p)) out.trees.push({ x: p[0], y: p[1], r: 1.2 + rnd() * 1.5 });
  }

  const bx = boundary.map((p) => p[0]);
  const by = boundary.map((p) => p[1]);
  const bounds: Rect = { x: Math.min(...bx), y: Math.min(...by), w: Math.max(...bx) - Math.min(...bx), h: Math.max(...by) - Math.min(...by) };

  return {
    version: 1,
    root: meta.root,
    name: meta.name,
    bounds,
    boundary,
    ringRoad,
    districts,
    blocks,
    buildings: out.buildings,
    roofs: out.roofs,
    trees: out.trees,
    hq: { rect: hq, zone: hqZone, pads, road: hqRoad },
    fileCount: meta.fileCount,
    truncated: meta.truncated,
    scannedAt: Date.now(),
  };
}

/** Building for a repo path: exact match, else the nearest collapsed ancestor. */
export function buildingFor(city: CityModel, repoPath: string): Building | null {
  let best: Building | null = null;
  for (const b of city.buildings) {
    if (b.path === repoPath) return b;
    if (b.cluster > 1 && repoPath.startsWith(`${b.path}/`) && (!best || b.path.length > best.path.length)) best = b;
  }
  return best;
}

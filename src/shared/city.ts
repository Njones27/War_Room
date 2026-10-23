// Code City model: the repo rendered as a BF6-style battlefield.
// World units; x grows east, y grows south (three.js uses (x, height, y)).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Point = [number, number];

export interface Building {
  /** Repo-relative file path (or directory path for a collapsed cluster). */
  path: string;
  /** Footprint (top-left corner + size). */
  x: number;
  y: number;
  w: number;
  h: number;
  height: number;
  lines: number;
  bytes: number;
  /** An image, font, archive or other binary: drawn at one small size, and it has no lines. */
  asset?: boolean;
  /** Top-level district path ("" for root files). */
  district: string;
  /** 0..1 deterministic variation used for color/roof detail. */
  shade: number;
  /** Number of files folded into this building when the repo is too large. */
  cluster: number;
  /** Optional tower on top of a podium (large lots). */
  tower: Rect & { height: number } | null;
}

/** A directory's ground plate. Gaps between plates read as roads. */
export interface Block {
  path: string;
  rect: Rect;
  depth: number;
}

export interface District {
  path: string;
  name: string;
  rect: Rect;
  files: number;
  lines: number;
}

export interface Tree {
  x: number;
  y: number;
  r: number;
}

export interface RoofDetail {
  x: number;
  y: number;
  w: number;
  h: number;
  height: number;
  base: number;
}

export interface CityModel {
  version: number;
  root: string;
  name: string;
  /** City extent (blocks only). */
  bounds: Rect;
  /** Playable-area outline (white line in BF6). */
  boundary: Point[];
  /** Ring road just inside the boundary. */
  ringRoad: Point[];
  districts: District[];
  blocks: Block[];
  buildings: Building[];
  roofs: RoofDetail[];
  trees: Tree[];
  hq: {
    rect: Rect;
    zone: Point[];
    pads: Point[];
    road: Point[];
  };
  fileCount: number;
  truncated: boolean;
  scannedAt: number;
}

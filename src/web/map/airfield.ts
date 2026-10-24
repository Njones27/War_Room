// The airbase sits outside the playable area, on its own pad south of the
// boundary under HQ: a runway, an apron with stands for the F-35s at its west
// end, and the control tower. The helipads stay at HQ. Jets take off east and
// land westbound along the runway line, which runs outside the boundary, so
// both the climb-out and the approach are over open ground, never the city.
import type { CityModel, Point, Rect } from "../../shared/city";

export interface Airfield {
  runway: { x0: number; x1: number; z: number; width: number };
  /** Helipads at HQ. */
  pads: Point[];
  /** F-35 stands on the apron. */
  stands: Point[];
  apron: Rect;
  tower: { x: number; z: number; height: number };
  /** The airbase's ground, outside the playable boundary. */
  base: Rect;
  /** Ground kept clear of trees. */
  clear: Rect[];
}

/** Clearance between the boundary's southernmost point and the runway centreline. */
const OFFSET = 24;
const LENGTH = 104;

export function airfieldFor(city: CityModel): Airfield {
  const hq = city.hq.rect;
  const south = Math.max(...city.boundary.map((p) => p[1]));
  const z = south + OFFSET;
  const runway = { x0: hq.x - 24, x1: hq.x - 24 + LENGTH, z, width: 8 };
  const apron: Rect = { x: runway.x0 + 2, y: z + runway.width / 2 + 1, w: 30, h: 14 };
  const stands: Point[] = [
    [runway.x0 + 10, apron.y + 8],
    [runway.x0 + 24, apron.y + 8],
  ];
  // Beside the apron, well off the runway centreline.
  const tower = { x: apron.x + apron.w + 9, z: apron.y + apron.h - 2, height: 20 };
  const base: Rect = { x: runway.x0 - 12, y: z - runway.width / 2 - 6, w: LENGTH + 24, h: apron.y + apron.h + 8 - (z - runway.width / 2 - 6) };
  const pads: Point[] = [0.18, 0.5, 0.82].map((f) => [hq.x + hq.w * f, hq.y + hq.h + 12]);
  return {
    runway,
    pads,
    stands,
    apron,
    tower,
    base,
    clear: [base, { x: hq.x - 4, y: hq.y + hq.h, w: hq.w + 8, h: 22 }],
  };
}

/** The whole world worth framing: the city's bounds plus the airbase. */
export function worldExtent(city: CityModel, field: Airfield): Rect {
  const b = city.bounds;
  const f = field.base;
  const x0 = Math.min(b.x, f.x);
  const y0 = Math.min(b.y, f.y);
  return { x: x0, y: y0, w: Math.max(b.x + b.w, f.x + f.w) - x0, h: Math.max(b.y + b.h, f.y + f.h) - y0 };
}

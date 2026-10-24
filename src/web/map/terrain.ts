// What aircraft must clear: a coarse grid holding the tallest structure in
// each cell (buildings, their towers and roof clutter, the control tower).
// Every aircraft flies above the highest point near it and along its path.
import type { CityModel } from "../../shared/city";

export interface Obstacle {
  x: number;
  z: number;
  w: number;
  h: number;
  /** Top, above the ground. */
  top: number;
}

export class HeightField {
  private readonly cells: Float32Array;
  private readonly nx: number;
  private readonly nz: number;
  private readonly x0: number;
  private readonly z0: number;
  /** Tallest structure on the map. */
  readonly top: number;

  constructor(
    city: CityModel,
    extra: Obstacle[] = [],
    private readonly cell = 3,
  ) {
    const b = city.bounds;
    const all: Obstacle[] = [...extra];
    for (const bd of city.buildings) {
      all.push({ x: bd.x, z: bd.y, w: bd.w, h: bd.h, top: bd.height + 0.35 });
      if (bd.tower) all.push({ x: bd.tower.x, z: bd.tower.y, w: bd.tower.w, h: bd.tower.h, top: bd.tower.height + 0.35 });
    }
    for (const r of city.roofs) all.push({ x: r.x, z: r.y, w: r.w, h: r.h, top: r.base + r.height + 0.35 });
    // Cover the city and anything placed outside it.
    let minX = b.x;
    let minZ = b.y;
    let maxX = b.x + b.w;
    let maxZ = b.y + b.h;
    for (const o of extra) {
      minX = Math.min(minX, o.x);
      minZ = Math.min(minZ, o.z);
      maxX = Math.max(maxX, o.x + o.w);
      maxZ = Math.max(maxZ, o.z + o.h);
    }
    this.x0 = minX;
    this.z0 = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    this.cells = new Float32Array(this.nx * this.nz);
    let top = 0;
    for (const o of all) {
      top = Math.max(top, o.top);
      const i0 = this.ix(o.x);
      const i1 = this.ix(o.x + o.w);
      const j0 = this.jz(o.z);
      const j1 = this.jz(o.z + o.h);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.nx + i] = Math.max(this.cells[j * this.nx + i]!, o.top);
    }
    this.top = top;
  }

  private ix(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private jz(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)));
  }

  /** The highest point within `r` of (x, z); 0 over open ground. */
  at(x: number, z: number, r: number): number {
    if (x + r < this.x0 || z + r < this.z0 || x - r > this.x0 + this.nx * this.cell || z - r > this.z0 + this.nz * this.cell) return 0;
    let top = 0;
    const j1 = this.jz(z + r);
    const i1 = this.ix(x + r);
    for (let j = this.jz(z - r); j <= j1; j++) for (let i = this.ix(x - r); i <= i1; i++) top = Math.max(top, this.cells[j * this.nx + i]!);
    return top;
  }

  /** The highest point within `r` of the path from (x, z) running `dist` along (dx, dz). */
  along(x: number, z: number, dx: number, dz: number, dist: number, r: number): number {
    const len = Math.hypot(dx, dz) || 1;
    const steps = Math.max(1, Math.ceil(dist / this.cell));
    let top = 0;
    for (let s = 0; s <= steps; s++) {
      const d = (dist * s) / steps;
      top = Math.max(top, this.at(x + (dx / len) * d, z + (dz / len) * d, r));
    }
    return top;
  }
}

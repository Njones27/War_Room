import { Group, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { layoutCity, pointInPolygon } from "../src/server/repo/layout.js";
import { buildTree, type FileEntry } from "../src/server/repo/scan.js";
import type { StrikeTarget } from "../src/web/map/air";
import type { Aircraft, AircraftKind } from "../src/web/map/aircraft";
import { airfieldFor } from "../src/web/map/airfield";
import { Fighter } from "../src/web/map/fighter";
import { type Flyer, reach, separate, underside } from "../src/web/map/flight";
import type { Fx } from "../src/web/map/fx";
import type { Tracers } from "../src/web/map/guns";
import type { Ordnance } from "../src/web/map/ordnance";
import { HeightField } from "../src/web/map/terrain";

function fakeRepo(n: number): FileEntry[] {
  const files: FileEntry[] = [];
  for (let i = 0; i < n; i++) {
    const dir = ["src", "src/server", "src/web/map", "docs", "test", "scripts/deep/nested/dir"][i % 6];
    files.push({ path: i % 7 === 0 ? `root-${i}.md` : `${dir}/file-${i}.ts`, bytes: 100 + i * 37, lines: 5 + ((i * 53) % 900) });
  }
  return files;
}

const city = layoutCity(buildTree(fakeRepo(240)), { name: "demo", root: "/tmp/demo", fileCount: 240, truncated: false });
const field = airfieldFor(city);
const heights = new HeightField(city, [{ x: field.tower.x - 4, z: field.tower.z - 4, w: 8, h: 8, top: field.tower.height + 1 }]);

function flyer(kind: AircraftKind, length: number): Flyer {
  const ac = { kind, length, root: new Group() } as unknown as Aircraft;
  return { ac, pos: new Vector3(), heading: 0, pitch: 0, bank: 0, spool: 0, scale: 1, fade: 1, motion: new Vector3(), minY: -Infinity, maxY: Infinity };
}

describe("airbase", () => {
  it("sits outside the playable boundary, clear of every building", () => {
    const r = field.runway;
    const corners = (x0: number, z0: number, x1: number, z1: number) => [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ];
    for (const [x, z] of [
      ...corners(r.x0, r.z - r.width / 2, r.x1, r.z + r.width / 2),
      ...corners(field.apron.x, field.apron.y, field.apron.x + field.apron.w, field.apron.y + field.apron.h),
      [field.tower.x, field.tower.z],
    ] as [number, number][]) {
      expect(pointInPolygon([x, z], city.boundary)).toBe(false);
    }
    // The approach and climb-out line runs over open ground.
    expect(heights.along(r.x0 - 50, r.z, 1, 0, r.x1 - r.x0 + 500, 10)).toBe(0);
  });
});

describe("HeightField", () => {
  it("knows how tall things are and sees them coming", () => {
    const tallest = [...city.buildings].sort((a, b) => b.height - a.height)[0]!;
    const cx = tallest.x + tallest.w / 2;
    const cz = tallest.y + tallest.h / 2;
    expect(heights.at(cx, cz, 0.5)).toBeGreaterThanOrEqual(tallest.height);
    expect(heights.top).toBeGreaterThanOrEqual(tallest.height);
    expect(heights.at(field.runway.x0 - 200, field.runway.z, 5)).toBe(0);
    expect(heights.along(cx - 60, cz, 1, 0, 70, 1)).toBeGreaterThanOrEqual(tallest.height);
  });
});

describe("separate", () => {
  it("lifts the higher of two converging aircraft over the lower", () => {
    const a = flyer("lightning", 12.5);
    const b = flyer("lightning", 12.5);
    a.pos.set(0, 30, 0);
    a.motion.set(80, 0, 0);
    b.pos.set(100, 31, 0);
    b.motion.set(-80, 0, 0);
    separate([a, b], [a, b], new Set(), 1);
    expect(b.minY).toBeGreaterThan(a.pos.y + 4);
    expect(a.minY).toBe(-Infinity);
  });

  it("keeps a mover under a fixed orbit instead", () => {
    const jet = flyer("lightning", 12.5);
    const gunship = flyer("gunship", 22);
    jet.pos.set(0, 40, 0);
    gunship.pos.set(5, 44, 0);
    separate([jet], [jet, gunship], new Set([gunship]), 1);
    expect(jet.maxY).toBeLessThan(gunship.pos.y - 4);
  });
});

describe("F-35 sorties", () => {
  it("fly over the buildings, keep apart and land on the centreline", () => {
    const k = Math.max(1, Math.max(city.bounds.w, city.bounds.h) / 320);
    const tall = [...city.buildings].filter((b) => !b.path.startsWith("@")).sort((a, b) => b.height - a.height);
    const targets: StrikeTarget[] = [tall[0]!, tall[5]!, tall[12]!].map((b) => ({ path: b.path, x: b.x + b.w / 2, z: b.y + b.h / 2, w: b.w, h: b.h, height: b.height }));
    const noop = () => {};
    const fired = { rounds: 0, bombs: 0, missiles: 0 };
    const deps = {
      field: () => field,
      city: () => city,
      heights: () => heights,
      k: () => k,
      targets: () => targets,
      standing: () => true,
      runwayBusy: (self: Fighter, depart: boolean) => jets.some((j) => j !== self && (depart ? j.runwayUse() !== "none" : ["departing", "landing"].includes(j.runwayUse()))),
      tracers: { fire: (_f: Vector3, _t: Vector3, _s: unknown, onHit: () => void) => (fired.rounds++, onHit()) } as unknown as Tracers,
      ordnance: {
        drop: (_a: Vector3, _b: Vector3, _c: Vector3, onHit: () => void) => (fired.bombs++, onHit()),
        launch: (_a: Vector3, _b: Vector3, _c: Vector3, onHit: () => void) => (fired.missiles++, onHit()),
      } as unknown as Ordnance,
      fx: { muzzle: noop, impact: noop, explosion: noop, trail: noop } as unknown as Fx,
    };
    const jets = [0, 1].map((i) => new Fighter(flyer("lightning", 12.5), i, deps));
    jets.forEach((j, i) => j.setStand(...(field.stands[i]! as [number, number])));

    const dt = 1 / 60;
    const touchdowns: number[] = [];
    let lowest = Infinity;
    let closest = Infinity;
    const wasAir = [false, false];
    for (let step = 0; step < 60 * 60 * 12; step++) {
      const fs = jets.map((j) => j.f);
      const before = fs.map((f) => f.pos.clone());
      separate(fs, jets.filter((j) => j.airborne).map((j) => j.f), new Set(), k);
      jets.forEach((j, i) => {
        j.update(dt);
        const f = j.f;
        f.motion.copy(f.pos).sub(before[i]!).divideScalar(dt);
        if (j.airborne) {
          // Clearance between the airframe's lowest point and the roofs beneath it.
          lowest = Math.min(lowest, f.pos.y - underside(f, f.bank) - heights.at(f.pos.x, f.pos.z, reach(f) * 0.5));
        }
        if (wasAir[i] && !j.airborne) touchdowns.push(f.pos.z - field.runway.z);
        wasAir[i] = j.airborne;
      });
      if (jets.every((j) => j.airborne)) {
        const [a, b] = fs as [Flyer, Flyer];
        const horiz = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
        if (horiz < reach(a) + reach(b)) closest = Math.min(closest, Math.abs(a.pos.y - b.pos.y));
      }
    }
    expect(touchdowns.length).toBeGreaterThanOrEqual(6);
    for (const z of touchdowns) expect(Math.abs(z)).toBeLessThan(1);
    expect(lowest).toBeGreaterThan(0);
    // Whenever they overlap in plan, they're stacked well apart.
    expect(closest).toBeGreaterThan(3);
    // Attack passes deliver: gun bursts, bombs and missiles all get used.
    expect(fired.rounds).toBeGreaterThan(0);
    expect(fired.bombs + fired.missiles).toBeGreaterThan(0);
  });
});

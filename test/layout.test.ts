import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildingFor, layoutCity, pointInPolygon, squarify } from "../src/server/repo/layout.js";
import { buildTree, collapseTree, scanRepo, type FileEntry } from "../src/server/repo/scan.js";

function fakeRepo(n: number): FileEntry[] {
  const files: FileEntry[] = [];
  for (let i = 0; i < n; i++) {
    const dir = ["src", "src/server", "src/web/map", "docs", "test", "scripts/deep/nested/dir"][i % 6];
    files.push({ path: i % 7 === 0 ? `root-${i}.md` : `${dir}/file-${i}.ts`, bytes: 100 + i * 37, lines: 5 + ((i * 53) % 900) });
  }
  return files;
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

describe("squarify", () => {
  it("fills the rect with areas proportional to weight", () => {
    const rect = { x: 0, y: 0, w: 120, h: 80 };
    const cells = squarify(
      [5, 3, 2, 1, 1].map((w, i) => ({ weight: w, item: i })),
      rect,
    );
    expect(cells).toHaveLength(5);
    const total = cells.reduce((s, c) => s + c.rect.w * c.rect.h, 0);
    expect(total).toBeCloseTo(120 * 80, 3);
    const byItem = Object.fromEntries(cells.map((c) => [c.item, c.rect.w * c.rect.h]));
    expect(byItem[0]! / byItem[4]!).toBeCloseTo(5, 3);
  });
});

describe("layoutCity", () => {
  const files = fakeRepo(240);
  const tree = buildTree(files);
  const city = layoutCity(tree, { name: "demo", root: "/tmp/demo", fileCount: files.length, truncated: false });
  const fileBuildings = city.buildings.filter((b) => !b.path.startsWith("@"));

  it("places every file exactly once", () => {
    expect(fileBuildings).toHaveLength(files.length);
    expect(new Set(fileBuildings.map((b) => b.path)).size).toBe(files.length);
  });

  it("never overlaps two buildings", () => {
    for (let i = 0; i < fileBuildings.length; i++) {
      for (let j = i + 1; j < fileBuildings.length; j++) {
        expect(overlap(fileBuildings[i]!, fileBuildings[j]!), `${fileBuildings[i]!.path} vs ${fileBuildings[j]!.path}`).toBe(false);
      }
    }
  });

  it("keeps the city and HQ inside the playable boundary", () => {
    for (const b of fileBuildings) {
      expect(pointInPolygon([b.x + b.w / 2, b.y + b.h / 2], city.boundary)).toBe(true);
    }
    const hq = city.hq.rect;
    expect(pointInPolygon([hq.x + hq.w / 2, hq.y + hq.h / 2], city.boundary)).toBe(true);
  });

  it("is deterministic for the same repo", () => {
    const again = layoutCity(buildTree(files), { name: "demo", root: "/tmp/demo", fileCount: files.length, truncated: false });
    expect(again.buildings.map((b) => [b.path, b.x, b.y])).toEqual(city.buildings.map((b) => [b.path, b.x, b.y]));
  });

  it("finds buildings for paths", () => {
    expect(buildingFor(city, "src/server/file-1.ts")?.path).toBe("src/server/file-1.ts");
    expect(buildingFor(city, "nope.ts")).toBeNull();
  });
});

describe("assets", () => {
  it("draws every image or binary as one small building, however big the file", () => {
    const files: FileEntry[] = [
      { path: "app/main.ts", bytes: 6000, lines: 200 },
      { path: "app/Assets/LaunchSplash.png", bytes: 1_747_000, lines: 0, asset: true },
      { path: "app/Assets/icon.png", bytes: 900, lines: 0, asset: true },
    ];
    const city = layoutCity(buildTree(files), { name: "app", root: "/a", fileCount: 3, truncated: false });
    const at = (p: string) => city.buildings.find((b) => b.path === p)!;
    const code = at("app/main.ts");
    const splash = at("app/Assets/LaunchSplash.png");
    const icon = at("app/Assets/icon.png");
    expect(splash).toMatchObject({ asset: true, lines: 0 });
    expect(splash.w * splash.h).toBeLessThan(code.w * code.h);
    expect(splash.height).toBeLessThan(code.height);
    // Size doesn't matter: the 1.7 MB splash and the tiny icon get the same lot (footprints vary a little per file).
    const ratio = (splash.w * splash.h) / (icon.w * icon.h);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1 / 0.6);
  });

  it("finds assets by extension and by content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-scan-"));
    try {
      fs.writeFileSync(path.join(dir, "main.ts"), "a\nb\nc\n");
      fs.writeFileSync(path.join(dir, "splash.png"), Buffer.alloc(400_000, 7));
      fs.writeFileSync(path.join(dir, "blob.dat"), Buffer.concat([Buffer.from([1, 0, 2]), Buffer.alloc(3_000_000, 10)]));
      const { tree } = await scanRepo(dir);
      const file = (p: string) => tree.children.get(p)!.file!;
      expect(file("main.ts")).toEqual({ path: "main.ts", bytes: 6, lines: 3 });
      expect(file("splash.png")).toMatchObject({ lines: 0, asset: true });
      // No known extension and too big to count, but a NUL byte up front gives it away.
      expect(file("blob.dat")).toMatchObject({ lines: 0, asset: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("small repos", () => {
  it("keep natural building sizes and add non-overlapping outskirts", () => {
    const files = [
      { path: "README.md", bytes: 100, lines: 10 },
      { path: "src/a.js", bytes: 300, lines: 40 },
      { path: "src/b.js", bytes: 300, lines: 40 },
      { path: "test/a.test.js", bytes: 300, lines: 30 },
    ];
    const city = layoutCity(buildTree(files), { name: "tiny", root: "/t", fileCount: 4, truncated: false });
    const real = city.buildings.filter((b) => !b.path.startsWith("@"));
    const decor = city.buildings.filter((b) => b.path.startsWith("@decor"));
    expect(real).toHaveLength(4);
    expect(decor.length).toBeGreaterThan(10);
    for (const b of real) expect(Math.max(b.w, b.h)).toBeLessThan(40);
    const all = [...real, ...decor];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!)).toBe(false);
  });
});

describe("collapseTree", () => {
  it("folds deep folders until the building count fits", () => {
    const tree = buildTree(fakeRepo(600));
    collapseTree(tree, 120);
    const city = layoutCity(tree, { name: "big", root: "/tmp/big", fileCount: 600, truncated: true });
    const buildings = city.buildings.filter((b) => !b.path.startsWith("@"));
    expect(buildings.length).toBeLessThanOrEqual(120);
    expect(buildings.reduce((s, b) => s + Math.max(1, b.cluster), 0)).toBe(600);
    // A file inside a collapsed folder resolves to its cluster building.
    const cluster = buildings.find((b) => b.cluster > 1)!;
    expect(buildingFor(city, `${cluster.path}/anything.ts`)?.path).toBe(cluster.path);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CityModel } from "../src/shared/city.js";
import type { ServerMsg, StrikeView } from "../src/shared/protocol.js";
import { Bus } from "../src/server/bus.js";
import { Demolition, inMainCheckout, MASS_CHANGE } from "../src/server/demolition.js";
import type { Store } from "../src/server/store.js";

const cityOf = (paths: string[]) => ({ buildings: paths.map((p) => ({ path: p })) }) as unknown as CityModel;
const engineer = { id: "ag_1", letter: "C", callsign: "Hammer" };

describe("Demolition", () => {
  let root: string;
  let city: CityModel;
  let strikes: StrikeView[];
  let comms: string[];
  let restored: number;
  let demo: Demolition;

  const write = (p: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), "x");
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-demo-"));
    const files = ["a.ts", "src/b.ts", "src/c.ts", "d.ts", "e.ts"];
    for (const p of files) write(p);
    city = cityOf([...files, "@hq/0"]);
    strikes = [];
    comms = [];
    restored = 0;
    const bus = new Bus();
    bus.on((m: ServerMsg) => m.t === "strike" && strikes.push(m.strike));
    const store = { comms: (_t: string, _a: string | null, _k: string, text: string) => comms.push(text) } as unknown as Store;
    demo = new Demolition({ store, bus, city: () => city, theater: () => ({ id: "th", root, name: "t", branch: null, isGit: false }), restored: () => restored++ });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("strikes the city's files a command deleted, once", async () => {
    await demo.prime();
    fs.rmSync(path.join(root, "src"), { recursive: true });
    await demo.check(engineer);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.agentId).toBe("ag_1");
    expect(strikes[0]!.paths.sort()).toEqual(["src/b.ts", "src/c.ts"]);
    expect(comms[0]).toContain("C·Hammer deleted src/");
    expect(demo.destroyed().sort()).toEqual(["src/b.ts", "src/c.ts"]);
    await demo.check(engineer);
    expect(strikes).toHaveLength(1);
  });

  it("needs a census before it can tell what vanished", async () => {
    fs.rmSync(path.join(root, "a.ts"));
    await demo.check(null);
    expect(strikes).toHaveLength(0);
    write("a.ts");
    fs.rmSync(path.join(root, "a.ts"));
    await demo.check(null);
    expect(strikes).toHaveLength(0); // a.ts was already missing at the first census
  });

  it("rebuilds the city when struck files come back", async () => {
    await demo.prime();
    fs.rmSync(path.join(root, "a.ts"));
    await demo.check(null);
    expect(demo.destroyed()).toEqual(["a.ts"]);
    write("a.ts");
    await demo.check(null);
    expect(restored).toBe(1);
    expect(demo.destroyed()).toEqual([]);
  });

  it("leaves the demo's pretend strikes alone", async () => {
    await demo.prime();
    demo.strike(engineer, ["a.ts"], true);
    await demo.check(null);
    expect(restored).toBe(0);
    expect(demo.destroyed()).toEqual(["a.ts"]);
  });

  it("ignores a missing checkout instead of striking the whole city", async () => {
    await demo.prime();
    fs.rmSync(root, { recursive: true, force: true });
    await demo.check(null);
    expect(strikes).toHaveLength(0);
  });

  it("ignores most of a small repo vanishing at once", async () => {
    await demo.prime();
    for (const p of ["a.ts", "d.ts", "e.ts"]) fs.rmSync(path.join(root, p));
    await demo.check(null);
    expect(strikes).toHaveLength(0);
  });

  it("ignores a branch switch or mass move", async () => {
    const many = Array.from({ length: MASS_CHANGE * 3 }, (_, i) => `gen/f${i}.ts`);
    for (const p of many) write(p);
    city = cityOf(many);
    await demo.prime();
    for (const p of many.slice(0, MASS_CHANGE + 1)) fs.rmSync(path.join(root, p));
    await demo.check(null);
    expect(strikes).toHaveLength(0);
  });

  it("starts over after a rescan", async () => {
    await demo.prime();
    fs.rmSync(path.join(root, "a.ts"));
    city = cityOf(["src/b.ts", "src/c.ts"]);
    demo.reset();
    await demo.check(null);
    expect(strikes).toHaveLength(0);
    expect(demo.destroyed()).toEqual([]);
  });
});

describe("inMainCheckout", () => {
  it("tells the main checkout from an agent worktree", () => {
    const wt = path.join("/repo", ".claude", "worktrees", "warroom-c-engineer");
    expect(inMainCheckout(path.join("/repo", "src"), "/repo")).toBe(true);
    expect(inMainCheckout(path.join(wt, "src", "web"), "/repo")).toBe(false);
    expect(inMainCheckout("/elsewhere", "/repo")).toBe(false);
  });
});

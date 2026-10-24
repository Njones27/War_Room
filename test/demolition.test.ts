import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CityModel } from "../src/shared/city.js";
import type { ServerMsg, StrikeView } from "../src/shared/protocol.js";
import { Bus } from "../src/server/bus.js";
import { Demolition, MASS_CHANGE, workspaceRootOf } from "../src/server/demolition.js";
import type { Store } from "../src/server/store.js";

const cityOf = (paths: string[]) => ({ buildings: paths.map((p) => ({ path: p })) }) as unknown as CityModel;
const engineer = { id: "ag_1", letter: "C", callsign: "Hammer" };

describe("Demolition", () => {
  let root: string;
  let city: CityModel;
  let strikes: StrikeView[];
  let comms: string[];
  let demo: Demolition;

  const write = (p: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), "x");
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-demo-"));
    for (const p of ["a.ts", "src/b.ts", "src/c.ts"]) write(p);
    city = cityOf(["a.ts", "src/b.ts", "src/c.ts", "@hq/0"]);
    strikes = [];
    comms = [];
    const bus = new Bus();
    bus.on((m: ServerMsg) => m.t === "strike" && strikes.push(m.strike));
    const store = { comms: (_t: string, _a: string | null, _k: string, text: string) => comms.push(text) } as unknown as Store;
    demo = new Demolition({ store, bus, city: () => city, theater: () => ({ id: "th", root, name: "t", branch: null, isGit: false }) });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("strikes the city's files a command deleted, once", async () => {
    await demo.prime(root);
    fs.rmSync(path.join(root, "src"), { recursive: true });
    await demo.check(engineer, root);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.agentId).toBe("ag_1");
    expect(strikes[0]!.paths.sort()).toEqual(["src/b.ts", "src/c.ts"]);
    expect(comms[0]).toContain("C·Hammer deleted src/");
    expect(demo.destroyed().sort()).toEqual(["src/b.ts", "src/c.ts"]);
    await demo.check(engineer, root);
    expect(strikes).toHaveLength(1);
  });

  it("needs a census before it can tell what vanished", async () => {
    fs.rmSync(path.join(root, "a.ts"));
    await demo.check(null, root);
    expect(strikes).toHaveLength(0);
    write("a.ts");
    fs.rmSync(path.join(root, "a.ts"));
    await demo.check(null, root);
    expect(strikes).toHaveLength(0); // a.ts was already missing at the first census
  });

  it("ignores a branch switch or mass move", async () => {
    const many = Array.from({ length: MASS_CHANGE + 1 }, (_, i) => `gen/f${i}.ts`);
    for (const p of many) write(p);
    city = cityOf(many);
    await demo.prime(root);
    fs.rmSync(path.join(root, "gen"), { recursive: true });
    await demo.check(null, root);
    expect(strikes).toHaveLength(0);
  });

  it("starts over after a rescan", async () => {
    await demo.prime(root);
    fs.rmSync(path.join(root, "a.ts"));
    city = cityOf(["src/b.ts", "src/c.ts"]);
    demo.reset();
    await demo.check(null, root);
    expect(strikes).toHaveLength(0);
    expect(demo.destroyed()).toEqual([]);
  });
});

describe("workspaceRootOf", () => {
  it("finds the agent worktree a cwd sits in", () => {
    const wt = path.join("/repo", ".claude", "worktrees", "warroom-c-engineer");
    expect(workspaceRootOf(path.join(wt, "src", "web"), "/repo")).toBe(wt);
    expect(workspaceRootOf(path.join("/repo", "src"), "/repo")).toBe("/repo");
  });
});

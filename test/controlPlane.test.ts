import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, RunContext, RunHooks } from "../src/server/adapters/types.js";
import { Approvals } from "../src/server/approvals.js";
import { Bus } from "../src/server/bus.js";
import { parseArgs, PACKAGE_ROOT } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { cliPermissionMode, HQ, permissionOverrideOf, supplyModeOf } from "../src/server/hq.js";
import { layoutCity } from "../src/server/repo/layout.js";
import { buildTree } from "../src/server/repo/scan.js";
import { Roles } from "../src/server/roles.js";
import { Scheduler } from "../src/server/scheduler.js";
import { CheckoutConflict, Store } from "../src/server/store.js";
import { Toolkit } from "../src/server/toolkit.js";
import type { CommsCheck, ServerMsg, TheaterView } from "../src/shared/protocol.js";

/** An adapter that records sorties and finishes them on demand. */
class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  runs: { ctx: RunContext; hooks: RunHooks; sent: string[]; stopped: boolean }[] = [];
  start(ctx: RunContext, hooks: RunHooks) {
    const run = { ctx, hooks, sent: [] as string[], stopped: false };
    this.runs.push(run);
    hooks.onEvent({ kind: "init", sessionId: `sess-${this.runs.length}`, model: "fake", tools: [], mcpServers: [], permissionMode: ctx.permissionMode, cwd: ctx.cwd });
    return {
      send: (text: string) => {
        run.sent.push(text);
        return true;
      },
      stop: () => {
        run.stopped = true;
        this.finish(this.runs.indexOf(run));
      },
    };
  }
  finish(i: number, totalCostUsd = 0.1) {
    const r = this.runs[i]!;
    r.hooks.onEvent({ kind: "result", subtype: "success", isError: false, totalCostUsd, numTurns: 1, durationMs: 1, resultText: "ok", usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, sessionId: null });
    r.hooks.onExit({ code: 0, signal: null, stderrTail: "" });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("control plane", () => {
  let dir: string;
  let store: Store;
  let hq: HQ;
  let scheduler: Scheduler;
  let adapter: FakeAdapter;
  let approvals: Approvals;
  let toolkit: Toolkit;
  let theater: TheaterView;
  const events: ServerMsg[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-test-"));
    const config = { ...parseArgs(["--demo", "--home", dir, "--max-concurrent", "2"]), projectRoot: dir, dbPath: ":memory:", runDir: path.join(dir, "run") };
    const bus = new Bus();
    bus.on((m) => events.push(m));
    store = new Store(await openDatabase(":memory:"), bus);
    theater = store.ensureTheater(dir, "test", false, null);
    const roles = new Roles(path.join(PACKAGE_ROOT, "roles"), dir);
    approvals = new Approvals(store, 60_000);
    adapter = new FakeAdapter();
    // An API-key login: budgets until the Commander switches.
    const comms: CommsCheck = { claudeFound: true, version: "x", loggedIn: true, authMethod: "api_key", subscription: null, error: null, checkedAt: 0, rateLimit: null };
    const supplyMode = () => supplyModeOf(store, comms);
    const permissionMode = () => cliPermissionMode(permissionOverrideOf(store));
    scheduler = new Scheduler({ store, bus, roles, adapter, approvals, config, theater: () => theater, mcpUrl: () => "http://127.0.0.1:1/mcp", supplyMode, permissionMode });
    const city = layoutCity(buildTree([{ path: "a.ts", bytes: 1, lines: 1 }]), { name: "t", root: dir, fileCount: 1, truncated: false });
    hq = new HQ(store, bus, roles, scheduler, approvals, config, () => theater, {
      city: () => city,
      commsCheck: () => comms,
      supplyMode,
      fronts: () => [],
      externalAgents: () => [],
      takeCommandAvailable: () => false,
      version: "test",
    });
    toolkit = new Toolkit(hq, store, scheduler, approvals);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("wakes the assignee when an objective is assigned, and coalesces wakes", async () => {
    const eng = await hq.deploy({ role: "engineer" });
    hq.createObjective({ title: "One", assignee: eng.id }, "commander");
    hq.createObjective({ title: "Two", assignee: eng.id }, "commander");
    await tick();
    expect(adapter.runs).toHaveLength(1);
    expect(adapter.runs[0]!.ctx.prompt).toContain("#1");
    adapter.finish(0);
    await tick();
    // The second assignment queued during the run becomes the next sortie.
    expect(adapter.runs).toHaveLength(2);
  });

  it("respects the concurrency cap", async () => {
    const agents = await Promise.all([hq.deploy({ role: "recon" }), hq.deploy({ role: "security" }), hq.deploy({ role: "medic" })]);
    for (const a of agents) hq.createObjective({ title: `job for ${a.callsign}`, assignee: a.id }, "commander");
    await tick();
    expect(adapter.runs).toHaveLength(2);
    adapter.finish(0);
    await tick();
    expect(adapter.runs).toHaveLength(3);
  });

  it("checks out objectives atomically and reports conflicts", async () => {
    const a = await hq.deploy({ role: "engineer" });
    const b = await hq.deploy({ role: "medic" });
    const o = hq.createObjective({ title: "Shared", assignee: a.id }, "commander");
    await tick();
    const runA = adapter.runs.find((r) => r.ctx.agentId === a.id)!;
    expect(store.checkout(o.id, a.id, runA.ctx.runId, (id) => scheduler.isRunLive(id)).status).toBe("in_progress");
    expect(() => store.checkout(o.id, b.id, "rn_other", (id) => scheduler.isRunLive(id))).toThrow(CheckoutConflict);
    const viaTool = toolkit.checkout({ agentId: b.id, runId: "rn_other" }, `#${o.number}`);
    expect(viaTool).toMatchObject({ ok: false, conflict: true });
    adapter.finish(adapter.runs.indexOf(runA));
    expect(store.getObjective(o.id)!.checkoutRunId).toBeNull();
  });

  it("streams orders into a live sortie, and wakes idle agents for them", async () => {
    const a = await hq.deploy({ role: "engineer" });
    hq.createObjective({ title: "Work", assignee: a.id }, "commander");
    await tick();
    hq.sendOrder({ to: a.id, body: "Use CSS variables", author: "commander" });
    expect(adapter.runs[0]!.sent.join("\n")).toContain("Use CSS variables");
    adapter.finish(0);
    await tick();
    const idle = await hq.deploy({ role: "recon" });
    hq.sendOrder({ to: idle.id, body: "Scout the API", author: "commander" });
    await tick();
    const run = adapter.runs.find((r) => r.ctx.agentId === idle.id)!;
    expect(run.ctx.prompt).toContain("Scout the API");
  });

  it("pauses an agent that runs out of supply and asks for a resupply", async () => {
    const a = await hq.deploy({ role: "recon", budgetUsd: 1 });
    hq.createObjective({ title: "Expensive", assignee: a.id }, "commander");
    await tick();
    adapter.finish(0, 1.5);
    await tick();
    expect(store.getAgent(a.id)!.status).toBe("paused");
    const ask = store.pendingApprovals(theater.id).find((x) => x.kind === "budget");
    expect(ask).toBeTruthy();
    hq.createObjective({ title: "More", assignee: a.id }, "commander");
    await tick();
    expect(adapter.runs).toHaveLength(1);
    hq.decide(ask!.id, true);
    await tick();
    await tick();
    expect(store.getAgent(a.id)!.budgetUsd).toBeGreaterThan(1);
    expect(adapter.runs).toHaveLength(2);
  });

  it("drops budget caps in usage mode and sends held units back out", async () => {
    const a = await hq.deploy({ role: "recon", budgetUsd: 1 });
    hq.createObjective({ title: "Expensive", assignee: a.id }, "commander");
    await tick();
    expect(adapter.runs[0]!.ctx.maxBudgetUsd).toBe(1);
    adapter.finish(0, 1.5);
    await tick();
    hq.createObjective({ title: "More", assignee: a.id }, "commander");
    await tick();
    expect(store.getAgent(a.id)!.status).toBe("paused");
    const ask = store.pendingApprovals(theater.id).find((x) => x.kind === "budget")!;

    expect(hq.updateSettings({ supplyMode: "usage" }).supplyMode).toBe("usage");
    await tick();
    expect(store.getApproval(ask.id)!.status).toBe("expired");
    expect(adapter.runs).toHaveLength(2);
    expect(adapter.runs[1]!.ctx.maxBudgetUsd).toBeNull();
    expect(store.getAgent(a.id)!.tokensUsed).toBe(2);
    expect(events.some((m) => m.t === "settings" && m.settings.supplyMode === "usage")).toBe(true);
  });

  it("defaults to plan usage for subscription logins", async () => {
    const sub: CommsCheck = { claudeFound: true, version: "x", loggedIn: true, authMethod: "claude.ai", subscription: "max", error: null, checkedAt: 0, rateLimit: null };
    expect(supplyModeOf(store, sub)).toBe("usage");
    store.setSetting("supplyMode", "budget");
    expect(supplyModeOf(store, sub)).toBe("budget");
  });

  it("routes a permission prompt to the Commander and back", async () => {
    const a = await hq.deploy({ role: "engineer" });
    hq.createObjective({ title: "Run tests", assignee: a.id }, "commander");
    await tick();
    const caller = { agentId: a.id, runId: adapter.runs[0]!.ctx.runId };
    const pending = toolkit.permission(caller, { tool_name: "Bash", input: { command: "npm test" } });
    await tick();
    const ask = store.pendingApprovals(theater.id).find((x) => x.kind === "tool_permission")!;
    expect(ask.title).toContain("npm test");
    hq.decide(ask.id, true, { always: true });
    expect(await pending).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    // ALWAYS ALLOW: the exact command no longer asks.
    expect(await toolkit.permission(caller, { tool_name: "Bash", input: { command: "npm test" } })).toMatchObject({ behavior: "allow" });
    const denied = toolkit.permission(caller, { tool_name: "Bash", input: { command: "rm -rf build" } });
    await tick();
    hq.decide(store.pendingApprovals(theater.id).find((x) => x.kind === "tool_permission")!.id, false);
    expect(await denied).toMatchObject({ behavior: "deny" });
  });

  it("wakes the parent owner when delegated work lands in review", async () => {
    const general = await hq.deploy({ role: "general", mission: { title: "Ship it" } });
    await tick();
    const eng = await hq.deploy({ role: "engineer" });
    const root = store.openObjectivesFor(general.id)[0]!;
    const caller = { agentId: general.id, runId: adapter.runs[0]!.ctx.runId };
    const created = toolkit.create(caller, { title: "Build the thing", assignee: eng.letter, parent: `#${root.number}` });
    expect(created.objective.assignee).toContain(eng.callsign);
    adapter.finish(0);
    await tick();
    const engRun = adapter.runs.find((r) => r.ctx.agentId === eng.id)!;
    toolkit.update({ agentId: eng.id, runId: engRun.ctx.runId }, { objective: created.objective.ref, status: "in_review", comment: "Done, tests pass" });
    adapter.finish(adapter.runs.indexOf(engRun));
    await tick();
    const generalRuns = adapter.runs.filter((r) => r.ctx.agentId === general.id);
    expect(generalRuns).toHaveLength(2);
    expect(generalRuns[1]!.ctx.prompt).toContain("in review");
    expect(generalRuns[1]!.ctx.prompt).toContain("Done, tests pass");
  });

  it("runs an objective on the model and effort the Commander chose", async () => {
    const eng = await hq.deploy({ role: "engineer", model: "sonnet" });
    hq.createObjective({ title: "Hard bug", assignee: eng.id, model: "opus", effort: "high" }, "commander");
    await tick();
    expect(adapter.runs[0]!.ctx).toMatchObject({ model: "opus", effort: "high" });
    expect(store.listObjectives(theater.id)[0]).toMatchObject({ modelBy: "commander", modelPending: false });
  });

  it("lets the General pick models when picks are on", async () => {
    const general = await hq.deploy({ role: "general" });
    const eng = await hq.deploy({ role: "engineer" });
    hq.updateSettings({ generalPicksModels: true });

    // A Commander objective without a model waits for the General; the assignee isn't woken.
    const o = hq.createObjective({ title: "Rename a helper", assignee: eng.id }, "commander");
    await tick();
    expect(store.getObjective(o.id)!.modelPending).toBe(true);
    expect(adapter.runs.map((r) => r.ctx.agentId)).toEqual([general.id]);
    expect(adapter.runs[0]!.ctx.prompt).toContain(`objective "#${o.number}"`);
    const caller = { agentId: general.id, runId: adapter.runs[0]!.ctx.runId };
    expect(toolkit.myOrders(caller).modelPicks?.waiting).toEqual([expect.objectContaining({ ref: `#${o.number}` })]);
    expect(toolkit.checkout({ agentId: eng.id, runId: "rn_x" }, `#${o.number}`)).toMatchObject({ ok: false });

    // The General's pick releases it to the assignee, on that model.
    toolkit.update(caller, { objective: `#${o.number}`, model: "haiku", effort: "low" });
    await tick();
    expect(store.getObjective(o.id)).toMatchObject({ model: "haiku", effort: "low", modelBy: "general", modelPending: false });
    const engRun = adapter.runs.find((r) => r.ctx.agentId === eng.id)!;
    expect(engRun.ctx).toMatchObject({ model: "haiku", effort: "low" });

    // Objectives the General creates carry its pick.
    const created = toolkit.create(caller, { title: "Design the cache", assignee: eng.letter, model: "opus", effort: "high" });
    expect(store.findObjective(theater.id, created.objective.ref)).toMatchObject({ model: "opus", modelBy: "general" });
  });

  it("ignores the General's model picks while picks are off, and releases waiting objectives when turned off", async () => {
    const general = await hq.deploy({ role: "general" });
    const eng = await hq.deploy({ role: "engineer" });
    const ignored = hq.createObjective({ title: "Plain", assignee: eng.id, model: "opus" }, general.id);
    expect(store.getObjective(ignored.id)).toMatchObject({ model: null, modelBy: null });
    // The General is told its choice didn't count.
    const told = toolkit.update({ agentId: general.id, runId: null }, { objective: `#${ignored.number}`, model: "opus" });
    expect(told.note).toMatch(/not changed/);

    hq.updateSettings({ generalPicksModels: true });
    const waiting = hq.createObjective({ title: "Waits", assignee: eng.id }, "commander");
    expect(store.getObjective(waiting.id)!.modelPending).toBe(true);
    hq.updateSettings({ generalPicksModels: false });
    expect(store.getObjective(waiting.id)!.modelPending).toBe(false);
  });

  it("runs every agent in the PERMISSIONS mode: auto by default, then plan or manual", async () => {
    const eng = await hq.deploy({ role: "engineer" });
    const recon = await hq.deploy({ role: "recon" });
    hq.createObjective({ title: "One", assignee: eng.id }, "commander");
    await tick();
    expect(adapter.runs[0]!.ctx.permissionMode).toBe("auto");
    hq.updateSettings({ permissionMode: "plan" });
    hq.createObjective({ title: "Two", assignee: recon.id }, "commander");
    await tick();
    expect(adapter.runs.find((r) => r.ctx.agentId === recon.id)!.ctx.permissionMode).toBe("plan");
    // Manual is Claude Code's `default` mode.
    expect(hq.updateSettings({ permissionMode: "manual" }).permissionMode).toBe("manual");
    expect(cliPermissionMode(permissionOverrideOf(store))).toBe("default");
  });

  it("cleans up after a restart only for its own repo, and keeps a HOLD asked for mid-sortie", async () => {
    const other = store.ensureTheater(path.join(dir, "other"), "other", false, null);
    const mine = await hq.deploy({ role: "engineer" });
    const theirs = store.createAgent({ theaterId: other.id, letter: "A", callsign: "Far", role: "engineer", reportsTo: null, model: null, effort: null, permissionMode: "default", allowedTools: [], budgetUsd: null, workspace: { kind: "main", path: dir, branch: null } });
    store.updateAgent(theirs.id, { status: "running" });
    const theirRun = store.createRun(other.id, theirs.id, null, "manual");
    store.updateRun(theirRun.id, { status: "running" });
    store.saveWake({ agentId: theirs.id, reasons: ["order"], objectiveIds: [], note: null, createdAt: Date.now() });
    hq.createObjective({ title: "Mine", assignee: mine.id }, "commander");
    await tick();
    hq.pause(mine.id); // mid-sortie: the hold takes effect when the run ends

    expect(store.markInterruptedRuns(theater.id)).toBe(1);
    expect(store.getRun(theirRun.id)!.status).toBe("running");
    expect(store.getAgent(theirs.id)!.status).toBe("running");
    expect(store.listWakes(theater.id).map((w) => w.agentId)).not.toContain(theirs.id);
    expect(store.getAgent(mine.id)).toMatchObject({ status: "paused", pausedReason: "commander" });
  });

  it("does not let a partial patch erase stored fields", async () => {
    const o = hq.createObjective({ title: "Keep me", targetPaths: ["src"] }, "commander");
    store.updateObjective(o.id, { status: "blocked", targetPaths: undefined });
    expect(store.getObjective(o.id)!.targetPaths).toEqual(["src"]);
  });
});

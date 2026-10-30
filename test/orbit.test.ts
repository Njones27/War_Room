import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/server/adapters/claudeLocal.js";
import type { AgentAdapter, RunContext, RunHooks } from "../src/server/adapters/types.js";
import { Bus } from "../src/server/bus.js";
import { readAppTasks } from "../src/server/claudeApp.js";
import { parseArgs, PACKAGE_ROOT } from "../src/server/config.js";
import { describeCron, nextCronRun, parseCron } from "../src/shared/cron.js";
import { openDatabase } from "../src/server/db.js";
import { Orbit } from "../src/server/orbit.js";
import { Roles } from "../src/server/roles.js";
import type { SatelliteRunView, ServerMsg, TheaterView } from "../src/shared/protocol.js";
import { keepRecentRuns } from "../src/web/lib/store.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("cron", () => {
  it("parses lists, ranges and steps", () => {
    const c = parseCron("*/15 9-17 * * 1-5");
    expect([...c.minutes]).toEqual([0, 15, 30, 45]);
    expect(c.hours.has(9) && c.hours.has(17) && !c.hours.has(18)).toBe(true);
    expect([...c.weekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
  });

  it("finds the next run in local time", () => {
    // Wednesday 2026-10-28 10:30
    const from = at(2026, 10, 28, 10, 30);
    expect(nextCronRun("0 * * * *", from)).toBe(at(2026, 10, 28, 11, 0));
    expect(nextCronRun("0 8 * * *", from)).toBe(at(2026, 10, 29, 8, 0));
    expect(nextCronRun("0 9 * * 1", from)).toBe(at(2026, 11, 2, 9, 0));
    expect(nextCronRun("0 17 * * 1-5", at(2026, 10, 30, 18, 0))).toBe(at(2026, 11, 2, 17, 0)); // Friday evening → Monday
    expect(nextCronRun("0 0 1 * *", from)).toBe(at(2026, 11, 1, 0, 0));
    expect(nextCronRun("30 10 * * *", from)).toBe(at(2026, 10, 29, 10, 30)); // strictly after
  });

  it("treats Sunday as 0 or 7, and two day fields as either", () => {
    expect(nextCronRun("0 12 * * 7", at(2026, 10, 28))).toBe(at(2026, 11, 1, 12, 0));
    // 1st of the month or a Friday, whichever comes first.
    expect(nextCronRun("0 0 1 * 5", at(2026, 10, 28))).toBe(at(2026, 10, 30, 0, 0));
  });

  it("describes common schedules in plain words", () => {
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("*/10 * * * *")).toBe("Every 10 minutes");
    expect(describeCron("0 8 * * *")).toBe("Daily at 08:00");
    expect(describeCron("0 17 * * 1-5")).toBe("Weekdays at 17:00");
    expect(describeCron("30 9 * * 1")).toBe("Mondays at 09:30");
    expect(describeCron("0 0 1 * *")).toBe("Monthly on day 1 at 00:00");
    expect(describeCron("5 4 * 2 *")).toBe("Cron 5 4 * 2 *");
  });
});

/** Records satellite runs and finishes them on demand. */
class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  runs: { ctx: RunContext; hooks: RunHooks; stopped: boolean }[] = [];
  start(ctx: RunContext, hooks: RunHooks) {
    const run = { ctx, hooks, stopped: false };
    this.runs.push(run);
    return {
      send: () => true,
      stop: () => {
        run.stopped = true;
        hooks.onExit({ code: null, signal: "SIGTERM", stderrTail: "" });
      },
    };
  }
  finish(i: number, report = "All good.") {
    const r = this.runs[i]!;
    r.hooks.onEvent({ kind: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/README.md" }, parentToolUseId: null });
    r.hooks.onEvent({ kind: "result", subtype: "success", isError: false, totalCostUsd: 0.12, numTurns: 2, durationMs: 1, resultText: report, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, sessionId: null });
    r.hooks.onExit({ code: 0, signal: null, stderrTail: "" });
  }
}

describe("orbit", () => {
  let dir: string;
  let orbit: Orbit;
  let adapter: FakeAdapter;
  let now: number;
  const events: ServerMsg[] = [];
  const theater: TheaterView = { id: "th_1", root: "/repo", name: "repo", branch: "main", isGit: true };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-orbit-"));
    const config = { ...parseArgs(["--home", dir]), projectRoot: dir, dbPath: ":memory:", runDir: path.join(dir, "run") };
    const db = await openDatabase(":memory:");
    const bus = new Bus();
    events.length = 0;
    bus.on((m) => events.push(m));
    adapter = new FakeAdapter();
    now = at(2026, 10, 28, 10, 30);
    orbit = new Orbit({
      db,
      bus,
      roles: new Roles(path.join(PACKAGE_ROOT, "roles"), "/nonexistent"),
      adapter,
      config,
      theater: () => theater,
      permissionMode: () => "auto",
      appTasks: null,
      demo: false,
      now: () => now,
    });
  });

  afterEach(() => {
    orbit.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a satellite with its next run and plain-words schedule", () => {
    const s = orbit.create({ name: "Briefing", prompt: "Summarize commits", role: "recon", cron: "0 8 * * *" });
    expect(s.scheduleText).toBe("Daily at 08:00");
    expect(s.nextRunAt).toBe(at(2026, 10, 29, 8, 0));
    expect(s.enabled).toBe(true);
    expect(events.some((e) => e.t === "satellite" && e.satellite.id === s.id)).toBe(true);
  });

  it("rejects bad schedules, past one-offs and unknown roles", () => {
    expect(() => orbit.create({ name: "x", prompt: "y", cron: "every day" })).toThrow(/valid schedule/);
    expect(() => orbit.create({ name: "x", prompt: "y", fireAt: now - 1000 })).toThrow(/passed/);
    expect(() => orbit.create({ name: "x", prompt: "y", role: "pilot" })).toThrow(/Unknown role/);
  });

  it("fires due satellites as unattended runs and records the report", () => {
    const s = orbit.create({ name: "Hourly", prompt: "Run the tests", role: "medic", cron: "0 * * * *" });
    orbit.tick();
    expect(adapter.runs).toHaveLength(0);
    now = at(2026, 10, 28, 11, 0);
    orbit.tick();
    expect(adapter.runs).toHaveLength(1);
    const ctx = adapter.runs[0]!.ctx;
    expect(ctx.unattended).toBe(true);
    expect(ctx.cwd).toBe("/repo");
    expect(ctx.prompt).toBe("Run the tests");
    expect(ctx.allowedTools.some((t) => t.startsWith("mcp__warroom"))).toBe(false);
    expect(orbit.get(s.id).running).toBe(true);
    expect(orbit.get(s.id).nextRunAt).toBe(at(2026, 10, 28, 12, 0));

    // Not fired twice while it's still running.
    orbit.tick();
    expect(adapter.runs).toHaveLength(1);

    adapter.finish(0, "78 of 80 tests pass.");
    const run = orbit.runs()[0]!;
    expect(run.status).toBe("completed");
    expect(run.summary).toBe("78 of 80 tests pass.");
    expect(run.trigger).toBe("schedule");
    expect(orbit.get(s.id).running).toBe(false);
    expect(orbit.get(s.id).lastStatus).toBe("completed");
  });

  it("runs by hand, stops, pauses and resumes", () => {
    const s = orbit.create({ name: "Audit", prompt: "Audit deps", cron: "0 9 * * 1" });
    orbit.runNow(s.id);
    expect(() => orbit.runNow(s.id)).toThrow(/already running/);
    expect(orbit.stop(s.id)).toBe(true);
    expect(orbit.runs()[0]!.status).toBe("cancelled");
    expect(orbit.runs()[0]!.trigger).toBe("manual");

    expect(orbit.pause(s.id).nextRunAt).toBeNull();
    now = at(2026, 11, 2, 9, 0);
    orbit.tick();
    expect(adapter.runs).toHaveLength(1); // paused: nothing new
    const resumed = orbit.resume(s.id);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBe(at(2026, 11, 9, 9, 0));
  });

  it("switches a one-off off once it fires", () => {
    const s = orbit.create({ name: "Once", prompt: "Do it", fireAt: at(2026, 10, 28, 12, 0) });
    expect(s.scheduleText).toMatch(/^Once, Oct 28 at 12:00/);
    now = at(2026, 10, 28, 12, 1);
    orbit.tick();
    expect(adapter.runs).toHaveLength(1);
    const after = orbit.get(s.id);
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
  });

  it("edits a schedule and removes a satellite with its runs", () => {
    const s = orbit.create({ name: "A", prompt: "B", cron: "0 8 * * *" });
    const e = orbit.update(s.id, { cron: "0 17 * * 1-5", name: "PR digest" });
    expect(e.name).toBe("PR digest");
    expect(e.scheduleText).toBe("Weekdays at 17:00");
    orbit.runNow(s.id);
    adapter.finish(0);
    orbit.remove(s.id);
    expect(orbit.list()).toHaveLength(0);
    expect(orbit.runs()).toHaveLength(0);
    expect(events.some((m) => m.t === "satellite_removed" && m.id === s.id)).toBe(true);
  });

  it("caps each run in budget mode and says so when the cap stops it", () => {
    let mode: "budget" | "usage" = "usage";
    (orbit as unknown as { d: { supplyMode: () => string } }).d.supplyMode = () => mode;
    const s = orbit.create({ name: "Audit", prompt: "Audit deps", role: "security" });
    orbit.runNow(s.id);
    expect(adapter.runs[0]!.ctx.maxBudgetUsd).toBeNull();
    adapter.finish(0);
    mode = "budget";
    now += 60_000;
    orbit.runNow(s.id);
    expect(adapter.runs[1]!.ctx.maxBudgetUsd).toBe(5); // the Security role's budget
    const r = adapter.runs[1]!;
    r.hooks.onEvent({ kind: "result", subtype: "error_max_budget_usd", isError: true, totalCostUsd: 5, numTurns: 9, durationMs: 1, resultText: "", usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, sessionId: null });
    r.hooks.onExit({ code: 0, signal: null, stderrTail: "" });
    expect(orbit.runs()[0]!.status).toBe("failed");
    expect(orbit.runs()[0]!.error).toBe("Stopped at its $5.00 budget cap");
  });

  it("marks a run failed when Claude exits with an error", () => {
    const s = orbit.create({ name: "A", prompt: "B" });
    expect(s.scheduleText).toBe("Run by hand");
    expect(s.nextRunAt).toBeNull();
    orbit.runNow(s.id);
    adapter.runs[0]!.hooks.onExit({ code: 1, signal: null, stderrTail: "boom\nNot logged in" });
    expect(orbit.runs()[0]!.status).toBe("failed");
    expect(orbit.runs()[0]!.error).toBe("Not logged in");
  });
});

describe("unattended runs", () => {
  it("drop the War Room MCP server and the permission prompt tool", () => {
    const args = buildClaudeArgs({
      runId: "sr",
      agentId: "sat",
      cwd: "/repo",
      prompt: "go",
      resumeSessionId: null,
      instructionsPath: "/run/i.md",
      mcpConfigPath: "",
      strictMcp: true,
      permissionMode: "auto",
      model: null,
      effort: null,
      maxBudgetUsd: null,
      allowedTools: ["Read"],
      disallowedTools: [],
      sessionName: "War Room · Satellite · x",
      env: {},
      unattended: true,
    });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--permission-prompt-tool");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args.join(" ")).toContain("--permission-mode auto");
  });
});

describe("Claude app tasks", () => {
  it("reads task folders and the app's schedule file, read-only", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-app-"));
    const tasks = path.join(home, "tasks");
    fs.mkdirSync(path.join(tasks, "inbox-digest"), { recursive: true });
    fs.writeFileSync(path.join(tasks, "inbox-digest", "SKILL.md"), "---\nname: inbox-digest\ndescription: Summarize mail\n---\n\nSummarize unread mail.\n");
    fs.mkdirSync(path.join(tasks, "no-schedule"), { recursive: true });
    fs.writeFileSync(path.join(tasks, "no-schedule", "SKILL.md"), "Just a prompt.");
    const state = path.join(home, "scheduled-tasks.json");
    fs.writeFileSync(state, JSON.stringify({ scheduledTasks: [{ taskId: "inbox-digest", cronExpression: "30 7 * * *", enabled: true, lastRunAt: "2026-10-28T07:31:00Z", title: "Inbox digest" }] }));
    const list = readAppTasks({ taskDirs: [tasks, path.join(home, "missing")], stateFiles: () => [state] }, at(2026, 10, 28, 10, 0));
    const inbox = list.find((s) => s.id === "app:inbox-digest")!;
    expect(inbox.source).toBe("claude_app");
    expect(inbox.name).toBe("Inbox digest");
    expect(inbox.prompt).toBe("Summarize unread mail.");
    expect(inbox.scheduleText).toBe("Daily at 07:30");
    expect(inbox.nextRunAt).toBe(at(2026, 10, 29, 7, 30));
    expect(inbox.lastRunAt).toBe(Date.parse("2026-10-28T07:31:00Z"));
    const bare = list.find((s) => s.id === "app:no-schedule")!;
    expect(bare.name).toBe("No schedule");
    expect(bare.scheduleText).toBe("Set in the Claude app");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("satellite runs in the browser", () => {
  it("keep only each satellite's 30 newest runs", () => {
    const run = (i: number, sat: string): SatelliteRunView => ({ id: `${sat}-${i}`, satelliteId: sat, trigger: "schedule", status: "completed", startedAt: i, endedAt: i + 1, summary: null, error: null, costUsd: 0 });
    const runs: Record<string, SatelliteRunView> = {};
    for (let i = 0; i < 35; i++) runs[`a-${i}`] = run(i, "a");
    runs["b-0"] = run(0, "b");
    const kept = keepRecentRuns(runs, "a");
    expect(Object.values(kept).filter((r) => r.satelliteId === "a")).toHaveLength(30);
    expect(kept["a-4"]).toBeUndefined();
    expect(kept["a-5"]).toBeDefined();
    expect(kept["b-0"]).toBeDefined();
  });
});

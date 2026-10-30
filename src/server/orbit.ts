// Orbit: scheduled tasks ("satellites"). War Room keeps each satellite's
// schedule and fires it as one fresh headless Claude Code run in the theater,
// apart from the squad: no objective, no War Room MCP, and no permission
// prompts (nobody is watching), so only the role's allowed tools work.
// The Claude desktop app's Scheduled tasks ride along read-only.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RateLimitInfo, RunStatus, SatelliteRunView, SatelliteView, TheaterView } from "../shared/protocol.js";
import { toolActivity } from "./activity.js";
import type { AgentAdapter, RunExit, RunHandle } from "./adapters/types.js";
import type { Bus } from "./bus.js";
import { readAppTasks, type AppTaskSource } from "./claudeApp.js";
import type { WarRoomConfig } from "./config.js";
import { describeCron, describeOnce, isValidCron, nextCronRun } from "../shared/cron.js";
import { agentEnv } from "./env.js";
import { HqError } from "./hq.js";
import type { Roles } from "./roles.js";
import type { StreamEvent } from "./streamParser.js";
import { hash01, newId, prng, truncate } from "./util.js";

type Row = Record<string, SQLInputValue>;

export interface OrbitDeps {
  db: DatabaseSync;
  bus: Bus;
  roles: Roles;
  adapter: AgentAdapter;
  config: WarRoomConfig;
  theater: () => TheaterView;
  permissionMode: () => string;
  onRateLimit?: (info: RateLimitInfo) => void;
  /** The Claude app's Scheduled tasks; null leaves them out. */
  appTasks: AppTaskSource | null;
  /** Simulated runs on a fast clock and sample satellites; no Claude usage. */
  demo: boolean;
  now?: () => number;
}

export interface SatelliteInput {
  name: string;
  prompt: string;
  role?: string | null;
  model?: string | null;
  effort?: string | null;
  cron?: string | null;
  fireAt?: number | null;
  enabled?: boolean;
}

interface LiveRun {
  runId: string;
  satelliteId: string;
  handle: RunHandle | null;
  timers: NodeJS.Timeout[];
  stopped: boolean;
  activity: string;
  lastPush: number;
  summary: string | null;
  error: string | null;
  resultSubtype: string | null;
  costUsd: number;
  runDir: string | null;
}

/** Satellite runs allowed at once (they share plan usage with the squad). */
const MAX_LIVE = 2;
const RUNS_KEPT = 30;

const str = (v: SQLInputValue | undefined) => (v === null || v === undefined ? "" : String(v));
const strOrNull = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : Number(v));

export class Orbit {
  private readonly live = new Map<string, LiveRun>();
  private app: SatelliteView[] = [];
  private appSig = "";
  private timer: NodeJS.Timeout | null = null;
  private demoTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: OrbitDeps) {
    this.refreshApp(false);
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private get theaterId(): string {
    return this.d.theater().id;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private row(id: string): Row | undefined {
    return this.d.db.prepare("select * from satellites where id = ? and theater_id = ?").get(id, this.theaterId) as Row | undefined;
  }

  private view(r: Row): SatelliteView {
    const id = str(r.id);
    const cron = strOrNull(r.cron);
    const fireAt = numOrNull(r.fire_at);
    const enabled = Number(r.enabled) === 1;
    const last = this.d.db.prepare("select status from satellite_runs where satellite_id = ? order by started_at desc limit 1").get(id) as Row | undefined;
    const run = this.live.get(id);
    return {
      id,
      source: "warroom",
      name: str(r.name),
      prompt: str(r.prompt),
      role: strOrNull(r.role),
      model: strOrNull(r.model),
      effort: strOrNull(r.effort),
      cron,
      fireAt,
      scheduleText: cron ? describeCron(cron) : fireAt ? describeOnce(fireAt) : "Run by hand",
      enabled,
      running: Boolean(run),
      activity: run?.activity ?? null,
      nextRunAt: enabled ? numOrNull(r.next_run_at) : null,
      lastRunAt: numOrNull(r.last_run_at),
      lastStatus: last ? (str(last.status) as RunStatus) : null,
      path: null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  list(): SatelliteView[] {
    const own = (this.d.db.prepare("select * from satellites where theater_id = ? order by created_at").all(this.theaterId) as Row[]).map((r) => this.view(r));
    return [...own, ...this.app];
  }

  get(id: string): SatelliteView {
    const r = this.row(id);
    if (r) return this.view(r);
    const app = this.app.find((s) => s.id === id);
    if (app) return app;
    throw new HqError("No such satellite.", 404);
  }

  private runView(r: Row): SatelliteRunView {
    return {
      id: str(r.id),
      satelliteId: str(r.satellite_id),
      trigger: str(r.trigger) === "manual" ? "manual" : "schedule",
      status: str(r.status) as RunStatus,
      startedAt: Number(r.started_at),
      endedAt: numOrNull(r.ended_at),
      summary: strOrNull(r.summary),
      error: strOrNull(r.error),
      costUsd: Number(r.cost_usd ?? 0),
    };
  }

  /** Recent runs across this theater's satellites, newest first. */
  runs(limit = 200): SatelliteRunView[] {
    const rows = this.d.db
      .prepare("select r.* from satellite_runs r join satellites s on s.id = r.satellite_id where s.theater_id = ? order by r.started_at desc limit ?")
      .all(this.theaterId, limit) as Row[];
    return rows.map((r) => this.runView(r));
  }

  private emit(id: string): void {
    const r = this.row(id);
    if (r) this.d.bus.emit({ t: "satellite", satellite: this.view(r) });
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private validate(input: Partial<SatelliteInput>): void {
    if (input.cron && !isValidCron(input.cron)) throw new HqError(`"${input.cron}" isn't a valid schedule. Use 5 cron fields: minute hour day month weekday.`);
    if (input.cron && input.fireAt) throw new HqError("Pick a repeating schedule or a one-off time, not both.");
    if (input.fireAt && input.fireAt <= this.now()) throw new HqError("The one-off time has already passed.");
    if (input.role && !this.d.roles.get(input.role)) throw new HqError(`Unknown role "${input.role}".`);
  }

  private nextFor(cron: string | null, fireAt: number | null): number | null {
    if (cron) return nextCronRun(cron, this.now());
    return fireAt && fireAt > this.now() ? fireAt : null;
  }

  private own(id: string): Row {
    const r = this.row(id);
    if (r) return r;
    if (this.app.some((s) => s.id === id)) throw new HqError("That task belongs to the Claude app. Change it there.", 409);
    throw new HqError("No such satellite.", 404);
  }

  create(input: SatelliteInput): SatelliteView {
    this.validate(input);
    const id = newId("sat");
    const now = this.now();
    const cron = input.cron ?? null;
    const fireAt = input.fireAt ?? null;
    this.d.db
      .prepare(
        "insert into satellites (id, theater_id, name, prompt, role, model, effort, cron, fire_at, enabled, next_run_at, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, this.theaterId, input.name.trim(), input.prompt.trim(), input.role ?? null, input.model ?? null, input.effort ?? null, cron, fireAt, input.enabled === false ? 0 : 1, this.nextFor(cron, fireAt), now, now);
    this.emit(id);
    return this.get(id);
  }

  update(id: string, patch: Partial<SatelliteInput>): SatelliteView {
    const r = this.own(id);
    // Only what the patch sets is checked; a new schedule replaces the old kind.
    this.validate({ role: patch.role, cron: patch.cron, fireAt: patch.fireAt });
    const next = {
      cron: patch.fireAt ? null : patch.cron !== undefined ? patch.cron : strOrNull(r.cron),
      fireAt: patch.cron ? null : patch.fireAt !== undefined ? patch.fireAt : numOrNull(r.fire_at),
    };
    const enabled = patch.enabled ?? Number(r.enabled) === 1;
    this.d.db
      .prepare("update satellites set name = ?, prompt = ?, role = ?, model = ?, effort = ?, cron = ?, fire_at = ?, enabled = ?, next_run_at = ?, updated_at = ? where id = ?")
      .run(
        (patch.name ?? str(r.name)).trim(),
        (patch.prompt ?? str(r.prompt)).trim(),
        patch.role !== undefined ? patch.role : strOrNull(r.role),
        patch.model !== undefined ? patch.model : strOrNull(r.model),
        patch.effort !== undefined ? patch.effort : strOrNull(r.effort),
        next.cron,
        next.fireAt,
        enabled ? 1 : 0,
        this.nextFor(next.cron, next.fireAt),
        this.now(),
        id,
      );
    this.emit(id);
    return this.get(id);
  }

  remove(id: string): { ok: true } {
    this.own(id);
    this.stop(id);
    this.d.db.prepare("delete from satellite_runs where satellite_id = ?").run(id);
    this.d.db.prepare("delete from satellites where id = ?").run(id);
    this.d.bus.emit({ t: "satellite_removed", id });
    return { ok: true };
  }

  pause(id: string): SatelliteView {
    return this.update(id, { enabled: false });
  }

  resume(id: string): SatelliteView {
    return this.update(id, { enabled: true });
  }

  runNow(id: string): SatelliteView {
    const r = this.own(id);
    if (this.live.has(id)) throw new HqError("It's already running.", 409);
    this.launch(r, "manual");
    return this.get(id);
  }

  /** Stop a live run. */
  stop(id: string): boolean {
    const run = this.live.get(id);
    if (!run) return false;
    run.stopped = true;
    for (const t of run.timers) clearTimeout(t);
    if (run.handle) run.handle.stop();
    else this.finish(run, { code: 0, signal: null, stderrTail: "" });
    return true;
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  start(): void {
    if (this.d.demo) this.seedDemo();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();
    // In the demo something is always up there working.
    if (this.d.demo) {
      this.demoTimer = setInterval(() => this.demoPatrol(), 22_000);
      this.demoTimer.unref?.();
      setTimeout(() => this.demoPatrol(), 4000).unref?.();
    }
    this.tick();
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.demoTimer) clearInterval(this.demoTimer);
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  /** Fire every satellite that's due (one missed while War Room was closed fires once now). */
  tick(): void {
    this.refreshApp(true);
    const due = this.d.db
      .prepare("select * from satellites where theater_id = ? and enabled = 1 and next_run_at is not null and next_run_at <= ? order by next_run_at")
      .all(this.theaterId, this.now()) as Row[];
    for (const r of due) {
      const id = str(r.id);
      if (this.live.has(id)) continue;
      if (this.live.size >= MAX_LIVE) break; // the rest stay due for the next tick
      const cron = strOrNull(r.cron);
      // One-offs switch themselves off once fired, like the Claude app's.
      this.d.db.prepare("update satellites set next_run_at = ?, enabled = ? where id = ?").run(cron ? nextCronRun(cron, this.now()) : null, cron ? 1 : 0, id);
      this.launch(this.row(id)!, "schedule");
    }
  }

  private refreshApp(emit: boolean): void {
    if (this.d.demo) {
      this.app = demoAppTasks(this.now());
      return;
    }
    if (!this.d.appTasks) return;
    const next = readAppTasks(this.d.appTasks, this.now());
    const sig = JSON.stringify(next.map((s) => [s.id, s.name, s.scheduleText, s.enabled, s.nextRunAt, s.lastRunAt, s.updatedAt]));
    if (sig === this.appSig) return;
    const gone = this.app.filter((s) => !next.some((n) => n.id === s.id));
    this.app = next;
    this.appSig = sig;
    if (!emit) return;
    for (const s of gone) this.d.bus.emit({ t: "satellite_removed", id: s.id });
    for (const s of next) this.d.bus.emit({ t: "satellite", satellite: s });
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  private launch(r: Row, trigger: "schedule" | "manual"): void {
    const id = str(r.id);
    const runId = newId("sr");
    const now = this.now();
    this.d.db.prepare("insert into satellite_runs (id, satellite_id, trigger, status, started_at) values (?,?,?,?,?)").run(runId, id, trigger, "running", now);
    this.d.db.prepare("update satellites set last_run_at = ? where id = ?").run(now, id);
    // Keep the history short.
    this.d.db
      .prepare("delete from satellite_runs where satellite_id = ? and id not in (select id from satellite_runs where satellite_id = ? order by started_at desc limit ?)")
      .run(id, id, RUNS_KEPT);
    const run: LiveRun = { runId, satelliteId: id, handle: null, timers: [], stopped: false, activity: "Starting", lastPush: 0, summary: null, error: null, resultSubtype: null, costUsd: 0, runDir: null };
    this.live.set(id, run);
    this.pushRun(runId);
    this.emit(id);

    if (this.d.demo) return this.simulate(run, r);
    try {
      const theater = this.d.theater();
      const role = r.role ? this.d.roles.get(str(r.role)) : null;
      const runDir = path.join(this.d.config.runDir, runId);
      run.runDir = runDir;
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const instructionsPath = path.join(runDir, "instructions.md");
      fs.writeFileSync(instructionsPath, satelliteInstructions(str(r.name), theater.root, role ? { title: role.title, description: role.description, readOnly: role.readOnly } : null), { mode: 0o600 });
      run.handle = this.d.adapter.start(
        {
          runId,
          agentId: id,
          cwd: theater.root,
          prompt: str(r.prompt),
          resumeSessionId: null,
          instructionsPath,
          mcpConfigPath: "",
          strictMcp: false,
          permissionMode: this.d.permissionMode(),
          model: strOrNull(r.model) ?? role?.model ?? null,
          effort: strOrNull(r.effort) ?? role?.effort ?? null,
          maxBudgetUsd: null,
          allowedTools: (role?.allowedTools ?? ["Read", "Grep", "Glob"]).filter((t) => !t.startsWith("mcp__warroom")),
          disallowedTools: role?.disallowedTools ?? [],
          sessionName: `War Room · Satellite · ${str(r.name)}`,
          env: agentEnv({ WARROOM_SATELLITE_ID: id, WARROOM_RUN_ID: runId }),
          unattended: true,
        },
        { onEvent: (ev) => this.onEvent(run, ev), onExit: (ex) => this.finish(run, ex) },
      );
    } catch (err) {
      run.error = (err as Error).message;
      this.finish(run, { code: null, signal: null, stderrTail: run.error });
    }
  }

  private setActivity(run: LiveRun, text: string): void {
    run.activity = truncate(text, 120);
    // Tool events can come fast; the map only needs a few updates a second.
    if (this.now() - run.lastPush < 1200) return;
    run.lastPush = this.now();
    this.emit(run.satelliteId);
  }

  private onEvent(run: LiveRun, ev: StreamEvent): void {
    switch (ev.kind) {
      case "text":
        if (ev.parentToolUseId) return;
        run.summary = ev.text;
        this.setActivity(run, ev.text.split("\n").find((l) => l.trim()) ?? "Writing");
        return;
      case "thinking":
        if (!ev.parentToolUseId) this.setActivity(run, "Thinking");
        return;
      case "tool_use":
        if (!ev.parentToolUseId) this.setActivity(run, toolActivity(ev.name, ev.input).detail);
        return;
      case "result":
        run.resultSubtype = ev.subtype;
        if (ev.totalCostUsd > 0) run.costUsd = ev.totalCostUsd;
        if (ev.resultText) run.summary = ev.resultText;
        if (ev.isError) run.error = ev.resultText ? truncate(ev.resultText, 300) : ev.subtype;
        return;
      case "rate_limit":
        this.d.onRateLimit?.({ status: ev.status, type: ev.type, resetsAt: ev.resetsAt, fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, at: Date.now() });
        return;
      case "error":
        run.error = ev.text;
        return;
      default:
        return;
    }
  }

  private finish(run: LiveRun, exit: RunExit): void {
    if (this.live.get(run.satelliteId) !== run) return;
    this.live.delete(run.satelliteId);
    for (const t of run.timers) clearTimeout(t);
    const ok = exit.code === 0 && !run.error && (run.resultSubtype === null || run.resultSubtype === "success");
    const status: RunStatus = run.stopped ? "cancelled" : ok ? "completed" : "failed";
    let error = run.error;
    if (status === "failed" && !error) {
      const lastLine = exit.stderrTail.trim().split("\n").filter(Boolean).pop();
      error = lastLine ? truncate(lastLine, 300) : `claude exited with code ${exit.code ?? exit.signal ?? "?"}`;
    }
    this.d.db
      .prepare("update satellite_runs set status = ?, ended_at = ?, summary = ?, error = ?, cost_usd = ? where id = ?")
      .run(status, this.now(), run.summary ? truncate(run.summary.trim(), 2000) : null, status === "cancelled" ? "Stopped" : error, run.costUsd, run.runId);
    if (run.runDir) {
      try {
        fs.rmSync(run.runDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this.pushRun(run.runId);
    this.emit(run.satelliteId);
  }

  private pushRun(runId: string): void {
    const r = this.d.db.prepare("select * from satellite_runs where id = ?").get(runId) as Row | undefined;
    if (r) this.d.bus.emit({ t: "satellite_run", run: this.runView(r) });
  }

  // ── Demo ──────────────────────────────────────────────────────────────────

  private seedDemo(): void {
    const has = this.d.db.prepare("select 1 from satellites where theater_id = ? limit 1").get(this.theaterId);
    if (has) return;
    for (const s of DEMO_SATELLITES) this.create(s);
  }

  /** Demo: launch a quiet satellite now and then so the mesh has traffic. */
  private demoPatrol(): void {
    if (this.live.size >= MAX_LIVE) return;
    const idle = (this.d.db.prepare("select * from satellites where theater_id = ? and enabled = 1").all(this.theaterId) as Row[]).filter((r) => !this.live.has(str(r.id)));
    const pick = idle[Math.floor(Math.random() * idle.length)];
    if (pick) this.launch(pick, "schedule");
  }

  private simulate(run: LiveRun, r: Row): void {
    const rnd = prng(Math.floor(hash01(run.runId) * 2 ** 31));
    const script = demoScript(str(r.name), str(r.prompt));
    let at = 0;
    for (const step of script.steps) {
      at += 2200 + rnd() * 2600;
      run.timers.push(setTimeout(() => this.setActivity(run, step), at));
    }
    at += 1800 + rnd() * 1500;
    run.timers.push(
      setTimeout(() => {
        run.summary = script.report;
        run.resultSubtype = "success";
        this.finish(run, { code: 0, signal: null, stderrTail: "" });
      }, at),
    );
  }
}

export function satelliteInstructions(name: string, root: string, role: { title: string; description: string; readOnly: boolean } | null): string {
  return [
    `You are running a scheduled War Room task called "${name}" in ${root}.`,
    role ? `Your role: ${role.title}. ${role.description}` : "",
    role?.readOnly ? "Don't edit files: read, run read-only commands and report." : "",
    "Nobody is watching this run. Tools that need permission are denied, so work with what you're allowed to use and say what you couldn't do.",
    "When you finish, end with a short report (2 to 4 sentences) of what you found or changed.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const DEMO_SATELLITES: SatelliteInput[] = [
  { name: "Test sweep", prompt: "Run the test suite and report any failures with the likely cause.", role: "medic", cron: "0 * * * *" },
  { name: "Morning repo briefing", prompt: "Summarize new commits and open pull requests since yesterday, and flag anything failing in CI.", role: "recon", cron: "0 8 * * *" },
  { name: "Nightly build check", prompt: "Build the project from a clean install and report warnings or errors.", role: "support", cron: "0 2 * * *" },
  { name: "PR review digest", prompt: "Review today's open pull requests and list what needs attention.", role: "recon", cron: "0 17 * * 1-5" },
  { name: "Dependency audit", prompt: "Check dependencies for known vulnerabilities and outdated majors. Report the riskiest first.", role: "security", cron: "0 9 * * 1" },
];

function demoAppTasks(now: number): SatelliteView[] {
  const make = (id: string, name: string, cron: string, prompt: string): SatelliteView => ({
    id: `app:${id}`,
    source: "claude_app",
    name,
    prompt,
    role: null,
    model: null,
    effort: null,
    cron,
    fireAt: null,
    scheduleText: describeCron(cron),
    enabled: true,
    running: false,
    activity: null,
    nextRunAt: nextCronRun(cron, now),
    lastRunAt: null,
    lastStatus: null,
    path: `~/.claude/scheduled-tasks/${id}/SKILL.md`,
    createdAt: now,
    updatedAt: now,
  });
  return [
    make("inbox-digest", "Inbox digest", "30 7 * * *", "Summarize unread email from the last day and list anything that needs a reply."),
    make("weekly-expenses", "Weekly expense report", "0 16 * * 5", "Collect this week's receipts and draft the expense report."),
  ];
}

function demoScript(name: string, prompt: string): { steps: string[]; report: string } {
  const t = `${name} ${prompt}`.toLowerCase();
  if (t.includes("briefing")) return { steps: ["Reading recent commits", "Checking open pull requests", "Checking CI", "Writing the briefing"], report: "4 new commits on feature/ui-cleanup, 1 open PR, CI green. Nothing needs you this morning." };
  if (t.includes("test")) return { steps: ["Reading the test config", "Running npm test", "Reading 2 failing specs", "Writing the report"], report: "78 of 80 tests pass. Two failures in thread.test.ts come from a changed trace order; the fix is in buildThread's sort." };
  if (t.includes("build")) return { steps: ["Installing from the lockfile", "Running npm run build", "Checking bundle size", "Writing the report"], report: "Clean build in 41 s with no errors. One warning: the web bundle grew 6% since last night (three/addons)." };
  if (t.includes("depend") || t.includes("vulnerab")) return { steps: ["Reading package-lock.json", "Running npm audit", "Checking release notes", "Writing the report"], report: "No known vulnerabilities. Two majors are behind: vite (8 → 9) and zod (4.6 → 4.7 minor). Nothing urgent." };
  if (t.includes("pull request") || t.includes("pr ")) return { steps: ["Listing open pull requests", "Reading the diff for #5", "Checking CI status", "Writing the digest"], report: "One open PR (#5, UI cleanup): CI green, two review comments resolved. Ready to merge." };
  return { steps: ["Reading recent commits", "Checking open pull requests", "Checking CI", "Writing the briefing"], report: "4 new commits on feature/ui-cleanup, 1 open PR, CI green. Nothing needs you this morning." };
}

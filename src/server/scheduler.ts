// Heartbeat scheduler: turns wakes into sorties.
//
// A wake (assignment, order, approval, child objective done, patrol timer,
// manual) is queued per agent and coalesced. Sorties start while there's a
// free slot, the agent isn't paused/under TAKE COMMAND, and it has supply left
// (in budget mode; in usage mode agents draw on plan usage with no cap). Each
// sortie is one headless Claude Code run that resumes the agent's session for
// its current objective.
import fs from "node:fs";
import path from "node:path";
import type { AgentView, ObjectiveView, RateLimitInfo, SupplyMode, TheaterView, WakeReason } from "../shared/protocol.js";
import { OPEN_OBJECTIVE_STATUSES } from "../shared/protocol.js";
import { toRepoPath, toolActivity } from "./activity.js";
import type { AgentAdapter, RunExit, RunHandle } from "./adapters/types.js";
import type { Approvals } from "./approvals.js";
import type { Bus } from "./bus.js";
import type { WarRoomConfig } from "./config.js";
import { SHELL_TOOLS, type Demolition } from "./demolition.js";
import { agentEnv } from "./env.js";
import { buildInstructions, buildWakePrompt, formatLiveOrder } from "./prompts.js";
import type { RoleDef, Roles } from "./roles.js";
import type { StreamEvent } from "./streamParser.js";
import type { PendingWake, Store } from "./store.js";
import { newToken, truncate } from "./util.js";

export interface SchedulerDeps {
  store: Store;
  bus: Bus;
  roles: Roles;
  adapter: AgentAdapter;
  approvals: Approvals;
  config: WarRoomConfig;
  theater: () => TheaterView;
  mcpUrl: () => string;
  /** Defaults to "budget". */
  supplyMode?: () => SupplyMode;
  /** The `--permission-mode` every sortie runs with (defaults to the agent's own). */
  permissionMode?: () => string;
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Strikes buildings whose files an agent's shell command deleted. */
  demolition?: Demolition;
}

/**
 * Agents that run as one long-lived interactive session (team leads) instead
 * of sorties. The scheduler hands their wakes, orders and recalls over.
 */
export interface LiveSessions {
  handles(agent: AgentView): boolean;
  wake(agent: AgentView, reason: WakeReason, opts: { objectiveId?: string | null; note?: string | null }): void;
  deliver(agentId: string, authorName: string, body: string): string | null;
  recall(agentId: string): boolean;
  grant(agentId: string, rules: string[]): void;
  isRunLive(runId: string): boolean;
  runForToken(token: string): { runId: string; agentId: string } | null;
}

interface ActiveRun {
  runId: string;
  agentId: string;
  theaterId: string;
  token: string;
  handle: RunHandle | null;
  sessionKey: string;
  sessionId: string | null;
  cwd: string;
  objectiveId: string | null;
  /** Session cost already recorded before this run (total_cost_usd is cumulative). */
  baseCost: number;
  lastTotal: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  resultSubtype: string | null;
  error: string | null;
  stopped: boolean;
  subagentCalls: Set<string>;
  /** Shell commands in flight (subagents' too): deletions are checked when each one ends. */
  shellCalls: Set<string>;
  lastContextWrite: number;
  runDir: string;
  /** Objectives coalesced into this wake that still need their own sortie. */
  followUp: string[];
}

const FALLBACK_ROLE: RoleDef = {
  id: "soldier",
  name: "Soldier",
  title: "Soldier",
  icon: "star",
  accessory: "beret",
  description: "",
  worktree: false,
  permissionMode: "default",
  model: null,
  effort: null,
  budgetUsd: null,
  reportsTo: null,
  callsigns: [],
  readOnly: false,
  instructions: "You are a member of the War Room squad. Complete your objectives carefully.",
  allowedTools: ["Read", "Grep", "Glob", "mcp__warroom"],
  disallowedTools: [],
  mcp: "warroom",
  patrolMinutes: null,
  source: "builtin",
};

export class Scheduler {
  private readonly pending = new Map<string, PendingWake>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly tokens = new Map<string, { runId: string; agentId: string }>();
  /** One-shot tool grants for an agent's next sortie (e.g. after a merge approval). */
  private readonly grants = new Map<string, string[]>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private live: LiveSessions | null = null;

  constructor(private readonly d: SchedulerDeps) {
    for (const w of d.store.listWakes(d.theater().id)) this.pending.set(w.agentId, w);
  }

  attachLive(live: LiveSessions): void {
    this.live = live;
  }

  private liveFor(agentId: string): LiveSessions | null {
    const agent = this.live ? this.d.store.getAgent(agentId) : null;
    return agent && this.live!.handles(agent) ? this.live : null;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.patrol();
      this.tick();
    }, 15_000);
    this.timer.unref?.();
    this.tick();
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    for (const a of this.active.values()) {
      a.stopped = true;
      a.handle?.stop();
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  isRunLive(runId: string): boolean {
    for (const a of this.active.values()) if (a.runId === runId) return true;
    return this.live?.isRunLive(runId) ?? false;
  }

  runForToken(token: string): { runId: string; agentId: string } | null {
    return this.tokens.get(token) ?? this.live?.runForToken(token) ?? null;
  }

  isActive(agentId: string): boolean {
    return this.active.has(agentId);
  }

  activeCount(): number {
    return this.active.size;
  }

  hasPendingWake(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  grant(agentId: string, tools: string[]): void {
    const live = this.liveFor(agentId);
    if (live) live.grant(agentId, tools);
    else this.grants.set(agentId, [...(this.grants.get(agentId) ?? []), ...tools]);
  }

  /** Budget mode: per-agent caps apply. Usage mode: no caps. */
  private budgets(): boolean {
    return (this.d.supplyMode?.() ?? "budget") === "budget";
  }

  // ── Wakes ─────────────────────────────────────────────────────────────────

  wake(agentId: string, reason: WakeReason, opts: { objectiveId?: string | null; note?: string | null } = {}): void {
    const agent = this.d.store.getAgent(agentId);
    if (!agent || agent.status === "terminated") return;
    if (this.live?.handles(agent)) {
      this.live.wake(agent, reason, opts);
      return;
    }
    const w = this.pending.get(agentId) ?? { agentId, reasons: [], objectiveIds: [], note: null, createdAt: Date.now() };
    if (!w.reasons.includes(reason)) w.reasons.push(reason);
    if (opts.objectiveId && !w.objectiveIds.includes(opts.objectiveId)) w.objectiveIds.push(opts.objectiveId);
    if (opts.note) w.note = w.note ? `${w.note}\n\n${opts.note}` : opts.note;
    this.pending.set(agentId, w);
    this.d.store.saveWake(w);
    if (!this.active.has(agentId) && agent.status === "idle") this.d.store.updateAgent(agentId, { status: "queued" });
    queueMicrotask(() => this.tick());
  }

  cancelWake(agentId: string): void {
    this.pending.delete(agentId);
    this.d.store.deleteWake(agentId);
  }

  /** Start sorties while there's capacity. */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const queue = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const w of queue) {
        if (this.active.size >= this.d.config.maxConcurrent) break;
        if (this.active.has(w.agentId)) continue;
        const agent = this.d.store.getAgent(w.agentId);
        if (!agent || agent.status === "terminated") {
          this.cancelWake(w.agentId);
          continue;
        }
        if (agent.status === "paused" || agent.status === "commanded") continue;
        if (this.live?.handles(agent)) {
          this.cancelWake(w.agentId);
          continue;
        }
        if (this.budgets() && agent.budgetUsd !== null && agent.spentUsd >= agent.budgetUsd) {
          this.outOfSupply(agent);
          continue;
        }
        this.cancelWake(w.agentId);
        this.launch(agent, w);
      }
    } finally {
      this.ticking = false;
    }
  }

  private patrol(): void {
    const now = Date.now();
    const theater = this.d.theater();
    for (const agent of this.d.store.listAgents(theater.id)) {
      const minutes = this.d.store.patrolMinutes(agent.id) ?? this.d.roles.get(agent.role)?.patrolMinutes ?? null;
      if (!minutes || agent.teamMode || agent.status !== "idle" || this.pending.has(agent.id) || this.active.has(agent.id)) continue;
      const last = this.d.store.lastRunEnd(agent.id) ?? agent.createdAt;
      if (now - last < minutes * 60_000) continue;
      const hasWork = this.d.store.openObjectivesFor(agent.id).some((o) => !o.modelPending);
      const commandsMission = agent.reportsTo === null && this.d.store.activeMission(theater.id) !== null;
      if (hasWork || commandsMission) this.wake(agent.id, "timer");
    }
  }

  private outOfSupply(agent: AgentView): void {
    if (agent.status !== "paused") this.d.store.updateAgent(agent.id, { status: "paused", pausedReason: "out_of_supply" });
    this.d.store.setRuntime(agent.id, { activity: "offline", activityDetail: "Out of supply (budget reached)" });
    if (this.d.store.hasPendingApproval(agent.id, "budget")) return;
    const add = Math.max(5, Math.round((agent.budgetUsd ?? 5) * 0.5));
    this.d.approvals.request({
      theaterId: agent.theaterId,
      kind: "budget",
      agentId: agent.id,
      runId: null,
      title: `${agent.letter} · ${agent.callsign} is out of supply`,
      detail: `Spent $${agent.spentUsd.toFixed(2)} of a $${(agent.budgetUsd ?? 0).toFixed(2)} budget. Approve to add $${add}.`,
      payload: { addUsd: add },
    });
    this.d.store.comms(agent.theaterId, agent.id, "supply", `${agent.letter}·${agent.callsign} is out of supply and holding position`);
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /** Stream an order into a live sortie. Returns the run id, or null if the agent isn't running. */
  deliverLive(agentId: string, authorName: string, body: string): string | null {
    const live = this.liveFor(agentId);
    if (live) return live.deliver(agentId, authorName, body);
    const a = this.active.get(agentId);
    if (!a?.handle) return null;
    return a.handle.send(formatLiveOrder(authorName, body)) ? a.runId : null;
  }

  recall(agentId: string): boolean {
    const live = this.liveFor(agentId);
    if (live) return live.recall(agentId);
    const a = this.active.get(agentId);
    if (!a?.handle) return false;
    a.stopped = true;
    // A recalled sortie can't use a pending permission answer.
    this.d.approvals.expireRun(a.runId);
    a.handle.stop();
    return true;
  }

  // ── Sorties ───────────────────────────────────────────────────────────────

  /** The objective this sortie is for. One still waiting on the General's model pick isn't ready. */
  private pickObjective(agent: AgentView, w: PendingWake): ObjectiveView | null {
    for (const id of w.objectiveIds) {
      const o = this.d.store.getObjective(id);
      if (o && !o.modelPending && OPEN_OBJECTIVE_STATUSES.includes(o.status) && (!o.assigneeId || o.assigneeId === agent.id)) return o;
    }
    return this.d.store.openObjectivesFor(agent.id).find((o) => !o.modelPending) ?? null;
  }

  private launch(agent: AgentView, w: PendingWake): void {
    const { store, config } = this.d;
    const theater = this.d.theater();
    const role = this.d.roles.get(agent.role) ?? FALLBACK_ROLE;
    const objective = this.pickObjective(agent, w);
    const run = store.createRun(theater.id, agent.id, objective?.id ?? null, w.reasons[0] ?? "manual");
    const token = newToken();
    const runDir = path.join(config.runDir, run.id);
    const sessionKey = objective?.id ?? "standing";
    const session = store.getSession(agent.id, sessionKey);
    const resume = session && session.cwd === agent.workspace.path ? session.sessionId : null;
    const baseCost = resume ? session!.costUsd : 0;

    const a: ActiveRun = {
      runId: run.id,
      agentId: agent.id,
      theaterId: theater.id,
      token,
      handle: null,
      sessionKey,
      sessionId: resume,
      cwd: agent.workspace.path,
      objectiveId: objective?.id ?? null,
      baseCost,
      lastTotal: baseCost,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
      resultSubtype: null,
      error: null,
      stopped: false,
      subagentCalls: new Set(),
      shellCalls: new Set(),
      lastContextWrite: 0,
      runDir,
      followUp: w.objectiveIds.filter((id) => id !== objective?.id),
    };
    this.active.set(agent.id, a);
    this.tokens.set(token, { runId: run.id, agentId: agent.id });

    try {
      if (!fs.existsSync(agent.workspace.path)) throw new Error(`Workspace is missing: ${agent.workspace.path}`);
      void this.d.demolition?.prime(agent.workspace.path);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const superior = agent.reportsTo ? store.getAgent(agent.reportsTo) : null;
      const instructionsPath = path.join(runDir, "instructions.md");
      const mcpConfigPath = path.join(runDir, "mcp.json");
      fs.writeFileSync(instructionsPath, buildInstructions(agent, role, theater, superior), { mode: 0o600 });
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({ mcpServers: { warroom: { type: "http", url: this.d.mcpUrl(), headers: { Authorization: `Bearer ${token}` } } } }),
        { mode: 0o600 },
      );

      const orders = store.undeliveredOrders(agent.id);
      store.markDelivered(
        orders.map((o) => o.id),
        run.id,
      );
      const mission = objective?.missionId ? store.getMission(objective.missionId) : store.activeMission(theater.id);
      const parent = objective?.parentId ? store.getObjective(objective.parentId) : null;
      const prompt = buildWakePrompt({
        agent,
        reasons: w.reasons,
        notes: w.note ? [w.note] : [],
        mission,
        objective,
        parent,
        orders,
        authorName: (author) => this.authorName(author),
      });

      const grants = this.grants.get(agent.id) ?? [];
      this.grants.delete(agent.id);
      const allowedTools = [...new Set([...role.allowedTools, ...agent.allowedTools, ...grants])];
      const remaining = this.budgets() && agent.budgetUsd !== null ? Math.max(0.05, agent.budgetUsd - agent.spentUsd) : null;

      store.updateAgent(agent.id, { status: "running", pausedReason: null });
      store.setRuntime(agent.id, {
        activity: "orders",
        activityDetail: "Receiving orders",
        objectiveId: objective?.id ?? null,
        target: objective?.targetPaths[0] ?? store.getAgent(agent.id)?.target ?? null,
        subagents: 0,
      });
      store.addFeed(theater.id, { agentId: agent.id, runId: run.id, kind: "prompt", text: prompt });
      store.comms(
        theater.id,
        agent.id,
        "sortie",
        `${agent.letter}·${agent.callsign} moving out${objective ? ` on #${objective.number}` : ""} (${w.reasons.join(", ")})`,
      );

      a.handle = this.d.adapter.start(
        {
          runId: run.id,
          agentId: agent.id,
          cwd: agent.workspace.path,
          prompt,
          resumeSessionId: resume,
          instructionsPath,
          mcpConfigPath,
          strictMcp: role.mcp === "warroom",
          permissionMode: this.d.permissionMode?.() ?? agent.permissionMode,
          // The objective's model and effort (the Commander's or the General's choice) win over the agent's own.
          model: objective?.model ?? agent.model,
          effort: objective?.effort ?? agent.effort,
          maxBudgetUsd: remaining,
          allowedTools,
          disallowedTools: role.disallowedTools,
          sessionName: `War Room · ${agent.letter} · ${agent.callsign} (${role.name})`,
          env: agentEnv({
            WARROOM_AGENT_ID: agent.id,
            WARROOM_AGENT: `${agent.letter}·${agent.callsign}`,
            WARROOM_RUN_ID: run.id,
            WARROOM_OBJECTIVE_ID: objective?.id ?? "",
            WARROOM_WAKE_REASON: w.reasons.join(","),
          }),
        },
        { onEvent: (ev) => this.onEvent(a, ev), onExit: (ex) => this.onExit(a, ex) },
      );
      store.updateRun(run.id, { status: "running" });
    } catch (err) {
      a.error = (err as Error).message;
      this.onExit(a, { code: null, signal: null, stderrTail: a.error });
    }
  }

  authorName(author: string): string {
    if (author === "commander") return "Commander";
    const ag = this.d.store.getAgent(author);
    return ag ? `${ag.letter} · ${ag.callsign}` : author;
  }

  private onEvent(a: ActiveRun, ev: StreamEvent): void {
    const { store, bus } = this.d;
    const agent = store.getAgent(a.agentId);
    if (!agent) return;
    const theater = this.d.theater();
    switch (ev.kind) {
      case "init":
        if (ev.sessionId && ev.sessionId !== a.sessionId) {
          if (a.sessionId && a.sessionId !== ev.sessionId) {
            // Resume fell back to a fresh session: earlier totals no longer apply.
            a.baseCost = 0;
            a.lastTotal = 0;
          }
          a.sessionId = ev.sessionId;
          store.setSession(a.agentId, a.sessionKey, ev.sessionId, a.cwd, a.lastTotal);
          store.updateRun(a.runId, { sessionId: ev.sessionId });
        }
        return;
      case "replay":
        return;
      case "text":
        if (ev.parentToolUseId) return;
        store.addFeed(theater.id, { agentId: a.agentId, runId: a.runId, kind: "text", text: truncate(ev.text, 6000) });
        store.setRuntime(a.agentId, { activityDetail: truncate(ev.text.split("\n").find((l) => l.trim()) ?? "", 120) });
        return;
      case "thinking":
        if (!ev.parentToolUseId) store.setRuntime(a.agentId, { activity: "thinking", activityDetail: "Thinking" });
        return;
      case "tool_use": {
        if (ev.name === "Task" || ev.name === "Agent") {
          a.subagentCalls.add(ev.id);
          store.setRuntime(a.agentId, { subagents: a.subagentCalls.size }, false);
        }
        if (SHELL_TOOLS.has(ev.name)) a.shellCalls.add(ev.id);
        const act = toolActivity(ev.name, ev.input);
        const target = toRepoPath(act.rawPath, a.cwd, agent.workspace.path, theater.root);
        if (ev.parentToolUseId) return; // subagent internals: keep the parent's posture
        store.addFeed(theater.id, {
          agentId: a.agentId,
          runId: a.runId,
          kind: "tool_use",
          text: act.detail,
          tool: ev.name,
          toolUseId: ev.id,
          target,
        });
        store.setRuntime(a.agentId, {
          activity: act.activity,
          activityDetail: act.detail,
          ...(target !== null ? { target } : {}),
        });
        return;
      }
      case "tool_result": {
        if (a.subagentCalls.delete(ev.toolUseId)) store.setRuntime(a.agentId, { subagents: a.subagentCalls.size }, false);
        if (a.shellCalls.delete(ev.toolUseId)) void this.d.demolition?.check(agent, agent.workspace.path);
        if (ev.parentToolUseId) return;
        store.addFeed(theater.id, {
          agentId: a.agentId,
          runId: a.runId,
          kind: "tool_result",
          text: truncate(ev.text, 2000),
          toolUseId: ev.toolUseId,
          isError: ev.isError,
        });
        if (ev.isError) store.setRuntime(a.agentId, { activity: "error", activityDetail: truncate(ev.text, 120) });
        return;
      }
      case "usage":
        if (!ev.parentToolUseId && Date.now() - a.lastContextWrite > 4000) {
          a.lastContextWrite = Date.now();
          store.updateAgent(a.agentId, { contextTokens: ev.contextTokens });
        }
        return;
      case "text_delta":
        bus.emit({ t: "text_delta", agentId: a.agentId, runId: a.runId, text: ev.text });
        return;
      case "result": {
        const delta = ev.totalCostUsd - a.lastTotal;
        if (delta > 0) store.addSpend(a.agentId, delta);
        store.addTokens(a.agentId, ev.usage.input + ev.usage.output + ev.usage.cacheRead + ev.usage.cacheCreation);
        if (ev.totalCostUsd > 0) a.lastTotal = ev.totalCostUsd;
        a.numTurns += ev.numTurns;
        a.inputTokens += ev.usage.input + ev.usage.cacheRead + ev.usage.cacheCreation;
        a.outputTokens += ev.usage.output;
        a.resultSubtype = ev.subtype;
        if (ev.isError) a.error = ev.resultText ? truncate(ev.resultText, 300) : ev.subtype;
        if (a.sessionId) store.setSession(a.agentId, a.sessionKey, a.sessionId, a.cwd, a.lastTotal);
        store.updateRun(a.runId, {
          costUsd: Math.max(0, a.lastTotal - a.baseCost),
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          numTurns: a.numTurns,
        });
        store.addFeed(theater.id, {
          agentId: a.agentId,
          runId: a.runId,
          kind: "result",
          text: ev.isError ? `Sortie error (${ev.subtype})${ev.resultText ? `: ${truncate(ev.resultText, 400)}` : ""}` : truncate(ev.resultText || "Turn complete", 600),
          isError: ev.isError,
        });
        return;
      }
      case "rate_limit":
        this.d.onRateLimit?.({ status: ev.status, type: ev.type, resetsAt: ev.resetsAt, fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, at: Date.now() });
        return;
      case "system":
        if (ev.subtype === "compact_boundary" || ev.subtype === "api_retry") {
          store.addFeed(theater.id, { agentId: a.agentId, runId: a.runId, kind: "system", text: ev.text });
        }
        return;
      case "error":
        a.error = ev.text;
        store.addFeed(theater.id, { agentId: a.agentId, runId: a.runId, kind: "error", text: ev.text, isError: true });
        return;
    }
  }

  private onExit(a: ActiveRun, exit: RunExit): void {
    const { store } = this.d;
    if (this.active.get(a.agentId) !== a) return;
    this.active.delete(a.agentId);
    this.tokens.delete(a.token);
    this.d.approvals.expireRun(a.runId);
    store.releaseCheckouts(a.runId);

    const outOfBudget = a.resultSubtype === "error_max_budget_usd";
    const ok = exit.code === 0 && (a.resultSubtype === null || a.resultSubtype === "success" || outOfBudget);
    const status = a.stopped ? "cancelled" : ok ? "completed" : "failed";
    let error = a.error;
    if (!ok && !a.stopped && !error) {
      const lastLine = exit.stderrTail.trim().split("\n").filter(Boolean).pop();
      error = lastLine ? truncate(lastLine, 300) : `claude exited with code ${exit.code ?? exit.signal ?? "?"}`;
    }
    const run = store.updateRun(a.runId, { status, endedAt: Date.now(), error });
    try {
      fs.rmSync(a.runDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }

    const agent = store.getAgent(a.agentId);
    if (agent && agent.status === "running") {
      if (agent.pausedReason === "commander") store.updateAgent(agent.id, { status: "paused" });
      else if (this.budgets() && (outOfBudget || (agent.budgetUsd !== null && agent.spentUsd >= agent.budgetUsd))) this.outOfSupply(agent);
      else store.updateAgent(agent.id, { status: this.pending.has(agent.id) ? "queued" : "idle" });
    }
    store.setRuntime(a.agentId, {
      activity: status === "failed" ? "error" : "idle",
      activityDetail: status === "failed" ? error : status === "cancelled" ? "Recalled" : "Standing by",
      subagents: 0,
    });
    // A cap set before the switch to usage mode cut this sortie short: carry on.
    if (outOfBudget && !this.budgets() && store.getAgent(a.agentId)?.status === "idle") {
      this.wake(a.agentId, "manual", { objectiveId: a.objectiveId, note: "Your last sortie stopped at its old budget cap. Supply now comes from plan usage with no cap: pick up where you left off." });
    }
    // Each objective gets its own sortie (and session): queue the ones this wake carried.
    if (!a.stopped && status !== "failed") {
      for (const id of a.followUp) {
        const o = store.getObjective(id);
        if (o && OPEN_OBJECTIVE_STATUSES.includes(o.status) && o.assigneeId === a.agentId) this.wake(a.agentId, "assigned", { objectiveId: id });
      }
    }
    if (agent) {
      const cost = run ? ` · $${run.costUsd.toFixed(2)}` : "";
      const verb = status === "completed" ? "returned to base" : status === "cancelled" ? "was recalled" : "hit trouble";
      store.comms(agent.theaterId, agent.id, status === "failed" ? "error" : "sortie_end", `${agent.letter}·${agent.callsign} ${verb}${cost}${status === "failed" && error ? `: ${error}` : ""}`);
    }
    this.tick();
  }
}

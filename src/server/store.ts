// Control-plane state: the durable source of truth for agents, missions,
// objectives, orders, runs, approvals and the comms (audit) log.
// Every mutation is broadcast on the bus so connected UIs stay live.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  Activity,
  AgentStatus,
  TeamTask,
  AgentView,
  ApprovalKind,
  ApprovalStatus,
  ApprovalView,
  CommsEntry,
  FeedItem,
  MissionView,
  ObjectiveStatus,
  ObjectiveView,
  OrderView,
  Priority,
  RunStatus,
  RunView,
  TheaterView,
  WakeReason,
  Workspace,
} from "../shared/protocol.js";
import { OPEN_OBJECTIVE_STATUSES } from "../shared/protocol.js";
import type { Bus } from "./bus.js";
import { newId, parseJson } from "./util.js";

type Row = Record<string, SQLInputValue>;

/** Ephemeral per-agent state that changes on every tool event. */
interface Runtime {
  activity: Activity;
  activityDetail: string | null;
  target: string | null;
  objectiveId: string | null;
  subagents: number;
  teamTasks: TeamTask[];
  lastEventAt: number;
}

export interface NewAgent {
  theaterId: string;
  letter: string;
  callsign: string;
  role: string;
  reportsTo: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  allowedTools: string[];
  budgetUsd: number | null;
  workspace: Workspace;
  teamMode?: boolean;
}

export interface NewObjective {
  theaterId: string;
  title: string;
  body?: string;
  priority?: Priority;
  assigneeId?: string | null;
  parentId?: string | null;
  missionId?: string | null;
  targetPaths?: string[];
  createdBy: string;
  model?: string | null;
  effort?: string | null;
  modelBy?: ObjectiveView["modelBy"];
  modelPending?: boolean;
}

export interface PendingWake {
  agentId: string;
  reasons: WakeReason[];
  objectiveIds: string[];
  note: string | null;
  createdAt: number;
}

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  costUsd: number;
}

export class CheckoutConflict extends Error {
  constructor(message: string, readonly ownerAgentId: string | null) {
    super(message);
  }
}

const str = (v: SQLInputValue | undefined): string => (v === null || v === undefined ? "" : String(v));
const strOrNull = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: SQLInputValue | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: SQLInputValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** Drop undefined keys so a partial patch can't overwrite stored values. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class Store {
  private readonly runtime = new Map<string, Runtime>();

  constructor(
    readonly db: DatabaseSync,
    private readonly bus: Bus,
  ) {}

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    return strOrNull(this.get("select value from settings where key = ?", key)?.value);
  }

  setSetting(key: string, value: string): void {
    this.run("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }

  // ── Theaters ──────────────────────────────────────────────────────────────

  ensureTheater(root: string, name: string, isGit: boolean, branch: string | null): TheaterView {
    const existing = this.get("select * from theaters where root = ?", root);
    if (existing) {
      this.run("update theaters set name = ?, is_git = ?, branch = ? where id = ?", name, isGit ? 1 : 0, branch, existing.id!);
      return { id: str(existing.id), root, name, isGit, branch };
    }
    const id = newId("th");
    this.run(
      "insert into theaters (id, root, name, is_git, branch, created_at) values (?, ?, ?, ?, ?, ?)",
      id,
      root,
      name,
      isGit ? 1 : 0,
      branch,
      Date.now(),
    );
    return { id, root, name, isGit, branch };
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  private runtimeOf(id: string): Runtime {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = { activity: "idle", activityDetail: null, target: null, objectiveId: null, subagents: 0, teamTasks: [], lastEventAt: Date.now() };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  private toAgent(r: Row): AgentView {
    const id = str(r.id);
    const rt = this.runtimeOf(id);
    const status = str(r.status) as AgentStatus;
    return {
      id,
      theaterId: str(r.theater_id),
      letter: str(r.letter),
      callsign: str(r.callsign),
      role: str(r.role),
      reportsTo: strOrNull(r.reports_to),
      status,
      pausedReason: strOrNull(r.paused_reason),
      activity: status === "terminated" ? "offline" : status === "paused" ? "offline" : rt.activity,
      activityDetail: rt.activityDetail,
      target: rt.target,
      objectiveId: rt.objectiveId,
      model: strOrNull(r.model),
      effort: strOrNull(r.effort),
      permissionMode: str(r.permission_mode),
      allowedTools: parseJson<string[]>(strOrNull(r.allowed_tools), []),
      budgetUsd: numOrNull(r.budget_usd),
      spentUsd: num(r.spent_usd),
      tokensUsed: num(r.tokens_used),
      contextTokens: num(r.context_tokens),
      workspace: {
        kind: str(r.workspace_kind) as Workspace["kind"],
        path: str(r.workspace_path),
        branch: strOrNull(r.branch),
      },
      subagents: rt.subagents,
      external: false,
      teamMode: num(r.team_mode) === 1,
      teamLeadId: null,
      teamTasks: rt.teamTasks,
      sessionName: null,
      lastEventAt: rt.lastEventAt,
      createdAt: num(r.created_at),
    };
  }

  createAgent(a: NewAgent): AgentView {
    const id = newId("ag");
    const now = Date.now();
    this.run(
      `insert into agents (id, theater_id, letter, callsign, role, reports_to, model, effort, permission_mode,
        allowed_tools, budget_usd, status, workspace_kind, workspace_path, branch, team_mode, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`,
      id,
      a.theaterId,
      a.letter,
      a.callsign,
      a.role,
      a.reportsTo,
      a.model,
      a.effort,
      a.permissionMode,
      JSON.stringify(a.allowedTools),
      a.budgetUsd,
      a.workspace.kind,
      a.workspace.path,
      a.workspace.branch,
      a.teamMode ? 1 : 0,
      now,
      now,
    );
    return this.emitAgent(id)!;
  }

  getAgent(id: string): AgentView | null {
    const r = this.get("select * from agents where id = ?", id);
    return r ? this.toAgent(r) : null;
  }

  listAgents(theaterId: string, includeTerminated = false): AgentView[] {
    const rows = includeTerminated
      ? this.all("select * from agents where theater_id = ? order by created_at", theaterId)
      : this.all("select * from agents where theater_id = ? and status != 'terminated' order by created_at", theaterId);
    return rows.map((r) => this.toAgent(r));
  }

  allActiveAgents(): AgentView[] {
    return this.all("select * from agents where status != 'terminated'").map((r) => this.toAgent(r));
  }

  /** Resolve an agent reference: id, letter ("C"), callsign ("Hammer") or role ("engineer"). */
  findAgent(theaterId: string, ref: string): AgentView | null {
    const agents = this.listAgents(theaterId);
    const r = ref.trim().replace(/^@/, "");
    const lower = r.toLowerCase();
    return (
      agents.find((a) => a.id === r) ??
      agents.find((a) => a.letter.toLowerCase() === lower) ??
      agents.find((a) => a.callsign.toLowerCase() === lower) ??
      agents.find((a) => `${a.letter}·${a.callsign}`.toLowerCase() === lower) ??
      agents.find((a) => a.role.toLowerCase() === lower) ??
      null
    );
  }

  nextLetter(theaterId: string): string {
    const used = new Set(this.listAgents(theaterId).map((a) => a.letter));
    for (let i = 0; i < 26 * 27; i++) {
      const letter = i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
      if (!used.has(letter)) return letter;
    }
    return `X${Date.now() % 1000}`;
  }

  usedCallsigns(theaterId: string): Set<string> {
    return new Set(this.listAgents(theaterId).map((a) => a.callsign.toLowerCase()));
  }

  updateAgent(
    id: string,
    patch: Partial<{
      status: AgentStatus;
      pausedReason: string | null;
      callsign: string;
      reportsTo: string | null;
      model: string | null;
      effort: string | null;
      permissionMode: string;
      allowedTools: string[];
      budgetUsd: number | null;
      spentUsd: number;
      contextTokens: number;
      workspace: Workspace;
      patrolMinutes: number | null;
    }>,
  ): AgentView | null {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    const col = (c: string, v: SQLInputValue) => {
      sets.push(`${c} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) col("status", patch.status);
    if (patch.pausedReason !== undefined) col("paused_reason", patch.pausedReason);
    if (patch.callsign !== undefined) col("callsign", patch.callsign);
    if (patch.reportsTo !== undefined) col("reports_to", patch.reportsTo);
    if (patch.model !== undefined) col("model", patch.model);
    if (patch.effort !== undefined) col("effort", patch.effort);
    if (patch.permissionMode !== undefined) col("permission_mode", patch.permissionMode);
    if (patch.allowedTools !== undefined) col("allowed_tools", JSON.stringify(patch.allowedTools));
    if (patch.budgetUsd !== undefined) col("budget_usd", patch.budgetUsd);
    if (patch.spentUsd !== undefined) col("spent_usd", patch.spentUsd);
    if (patch.contextTokens !== undefined) col("context_tokens", patch.contextTokens);
    if (patch.patrolMinutes !== undefined) col("patrol_minutes", patch.patrolMinutes);
    if (patch.workspace !== undefined) {
      col("workspace_kind", patch.workspace.kind);
      col("workspace_path", patch.workspace.path);
      col("branch", patch.workspace.branch);
    }
    if (sets.length === 0) return this.getAgent(id);
    col("updated_at", Date.now());
    vals.push(id);
    this.run(`update agents set ${sets.join(", ")} where id = ?`, ...vals);
    return this.emitAgent(id);
  }

  patrolMinutes(id: string): number | null {
    return numOrNull(this.get("select patrol_minutes from agents where id = ?", id)?.patrol_minutes);
  }

  /** Update ephemeral activity state (not persisted). */
  setRuntime(id: string, patch: Partial<Runtime>, emit = true): AgentView | null {
    const rt = this.runtimeOf(id);
    Object.assign(rt, patch, { lastEventAt: Date.now() });
    return emit ? this.emitAgent(id) : this.getAgent(id);
  }

  addSpend(id: string, deltaUsd: number): AgentView | null {
    if (!(deltaUsd > 0)) return this.getAgent(id);
    this.run("update agents set spent_usd = spent_usd + ?, updated_at = ? where id = ?", deltaUsd, Date.now(), id);
    return this.emitAgent(id);
  }

  addTokens(id: string, tokens: number): AgentView | null {
    if (!(tokens > 0)) return this.getAgent(id);
    this.run("update agents set tokens_used = tokens_used + ?, updated_at = ? where id = ?", Math.round(tokens), Date.now(), id);
    return this.emitAgent(id);
  }

  private emitAgent(id: string): AgentView | null {
    const agent = this.getAgent(id);
    if (agent) this.bus.emit({ t: "agent", agent });
    return agent;
  }

  // ── Missions ──────────────────────────────────────────────────────────────

  private toMission(r: Row): MissionView {
    return {
      id: str(r.id),
      theaterId: str(r.theater_id),
      title: str(r.title),
      body: str(r.body),
      status: str(r.status) as MissionView["status"],
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    };
  }

  createMission(theaterId: string, title: string, body: string): MissionView {
    const id = newId("ms");
    const now = Date.now();
    this.run(
      "insert into missions (id, theater_id, title, body, status, created_at, updated_at) values (?, ?, ?, ?, 'active', ?, ?)",
      id,
      theaterId,
      title,
      body,
      now,
      now,
    );
    const mission = this.getMission(id)!;
    this.bus.emit({ t: "mission", mission });
    return mission;
  }

  getMission(id: string): MissionView | null {
    const r = this.get("select * from missions where id = ?", id);
    return r ? this.toMission(r) : null;
  }

  listMissions(theaterId: string): MissionView[] {
    return this.all("select * from missions where theater_id = ? order by created_at desc", theaterId).map((r) => this.toMission(r));
  }

  activeMission(theaterId: string): MissionView | null {
    const r = this.get("select * from missions where theater_id = ? and status = 'active' order by created_at desc limit 1", theaterId);
    return r ? this.toMission(r) : null;
  }

  updateMission(id: string, patch: Partial<Pick<MissionView, "title" | "body" | "status">>): MissionView | null {
    const m = this.getMission(id);
    if (!m) return null;
    this.run(
      "update missions set title = ?, body = ?, status = ?, updated_at = ? where id = ?",
      patch.title ?? m.title,
      patch.body ?? m.body,
      patch.status ?? m.status,
      Date.now(),
      id,
    );
    const mission = this.getMission(id)!;
    this.bus.emit({ t: "mission", mission });
    return mission;
  }

  // ── Objectives ────────────────────────────────────────────────────────────

  private toObjective(r: Row): ObjectiveView {
    return {
      id: str(r.id),
      theaterId: str(r.theater_id),
      number: num(r.number),
      title: str(r.title),
      body: str(r.body),
      status: str(r.status) as ObjectiveStatus,
      priority: str(r.priority) as Priority,
      assigneeId: strOrNull(r.assignee_id),
      parentId: strOrNull(r.parent_id),
      missionId: strOrNull(r.mission_id),
      targetPaths: parseJson<string[]>(strOrNull(r.target_paths), []),
      createdBy: str(r.created_by),
      checkoutRunId: strOrNull(r.checkout_run_id),
      model: strOrNull(r.model),
      effort: strOrNull(r.effort),
      modelBy: strOrNull(r.model_by) as ObjectiveView["modelBy"],
      modelPending: num(r.model_pending) === 1,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    };
  }

  createObjective(o: NewObjective): ObjectiveView {
    const id = newId("ob");
    const now = Date.now();
    const number = num(this.get("select coalesce(max(number), 0) + 1 as n from objectives where theater_id = ?", o.theaterId)?.n);
    this.run(
      `insert into objectives (id, theater_id, number, title, body, status, priority, assignee_id, parent_id, mission_id,
        target_paths, created_by, model, effort, model_by, model_pending, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.theaterId,
      number,
      o.title,
      o.body ?? "",
      o.priority ?? "normal",
      o.assigneeId ?? null,
      o.parentId ?? null,
      o.missionId ?? null,
      JSON.stringify(o.targetPaths ?? []),
      o.createdBy,
      o.model ?? null,
      o.effort ?? null,
      o.modelBy ?? null,
      o.modelPending ? 1 : 0,
      now,
      now,
    );
    return this.emitObjective(id)!;
  }

  getObjective(id: string): ObjectiveView | null {
    const r = this.get("select * from objectives where id = ?", id);
    return r ? this.toObjective(r) : null;
  }

  /** Resolve "ob_…", "#3" or "3". */
  findObjective(theaterId: string, ref: string): ObjectiveView | null {
    const r = ref.trim();
    const byId = this.getObjective(r);
    if (byId && byId.theaterId === theaterId) return byId;
    const n = Number(r.replace(/^#/, ""));
    if (!Number.isInteger(n)) return null;
    const row = this.get("select * from objectives where theater_id = ? and number = ?", theaterId, n);
    return row ? this.toObjective(row) : null;
  }

  listObjectives(theaterId: string): ObjectiveView[] {
    return this.all("select * from objectives where theater_id = ? order by number", theaterId).map((r) => this.toObjective(r));
  }

  openObjectivesFor(agentId: string): ObjectiveView[] {
    const placeholders = OPEN_OBJECTIVE_STATUSES.map(() => "?").join(", ");
    return this.all(
      `select * from objectives where assignee_id = ? and status in (${placeholders})
       order by case status when 'in_progress' then 0 when 'in_review' then 1 when 'todo' then 2 else 3 end,
         case priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, number`,
      agentId,
      ...OPEN_OBJECTIVE_STATUSES,
    ).map((r) => this.toObjective(r));
  }

  childrenOf(objectiveId: string): ObjectiveView[] {
    return this.all("select * from objectives where parent_id = ? order by number", objectiveId).map((r) => this.toObjective(r));
  }

  updateObjective(
    id: string,
    patch: Partial<
      Pick<ObjectiveView, "title" | "body" | "status" | "priority" | "assigneeId" | "targetPaths" | "checkoutRunId" | "parentId" | "model" | "effort" | "modelBy" | "modelPending">
    >,
  ): ObjectiveView | null {
    const o = this.getObjective(id);
    if (!o) return null;
    const next = { ...o, ...defined(patch) };
    this.run(
      `update objectives set title = ?, body = ?, status = ?, priority = ?, assignee_id = ?, target_paths = ?,
         checkout_run_id = ?, parent_id = ?, model = ?, effort = ?, model_by = ?, model_pending = ?, updated_at = ? where id = ?`,
      next.title,
      next.body,
      next.status,
      next.priority,
      next.assigneeId,
      JSON.stringify(next.targetPaths),
      next.checkoutRunId,
      next.parentId,
      next.model,
      next.effort,
      next.modelBy,
      next.modelPending ? 1 : 0,
      Date.now(),
      id,
    );
    return this.emitObjective(id);
  }

  /**
   * Atomic checkout. One agent works an objective at a time; a live
   * checkout by someone else is a conflict (like an HTTP 409).
   */
  checkout(objectiveId: string, agentId: string, runId: string, isRunLive: (runId: string) => boolean): ObjectiveView {
    const result = this.transaction(() => {
      const o = this.getObjective(objectiveId);
      if (!o) throw new Error("Objective not found.");
      if (o.status === "done" || o.status === "cancelled") throw new Error(`Objective #${o.number} is ${o.status}.`);
      if (o.assigneeId && o.assigneeId !== agentId) {
        throw new CheckoutConflict(`Objective #${o.number} is assigned to another agent. Pick a different one.`, o.assigneeId);
      }
      if (o.checkoutRunId && o.checkoutRunId !== runId && isRunLive(o.checkoutRunId)) {
        const owner = this.getRun(o.checkoutRunId)?.agentId ?? null;
        if (owner !== agentId) throw new CheckoutConflict(`Objective #${o.number} is checked out by another run.`, owner);
      }
      const status: ObjectiveStatus = o.status === "in_progress" ? o.status : "in_progress";
      this.run(
        "update objectives set assignee_id = ?, checkout_run_id = ?, status = ?, updated_at = ? where id = ?",
        agentId,
        runId,
        status,
        Date.now(),
        objectiveId,
      );
      return objectiveId;
    });
    return this.emitObjective(result)!;
  }

  releaseCheckouts(runId: string): void {
    const ids = this.all("select id from objectives where checkout_run_id = ?", runId).map((r) => str(r.id));
    if (ids.length === 0) return;
    this.run("update objectives set checkout_run_id = null, updated_at = ? where checkout_run_id = ?", Date.now(), runId);
    for (const id of ids) this.emitObjective(id);
  }

  private emitObjective(id: string): ObjectiveView | null {
    const objective = this.getObjective(id);
    if (objective) this.bus.emit({ t: "objective", objective });
    return objective;
  }

  // ── Orders (radio traffic) ────────────────────────────────────────────────

  private toOrder(r: Row): OrderView {
    return {
      id: str(r.id),
      theaterId: str(r.theater_id),
      agentId: strOrNull(r.agent_id),
      objectiveId: strOrNull(r.objective_id),
      author: str(r.author),
      body: str(r.body),
      createdAt: num(r.created_at),
      deliveredRunId: strOrNull(r.delivered_run_id),
    };
  }

  addOrder(o: { theaterId: string; agentId: string | null; objectiveId: string | null; author: string; body: string; deliveredRunId?: string | null }): OrderView {
    const id = newId("or");
    this.run(
      "insert into orders (id, theater_id, agent_id, objective_id, author, body, created_at, delivered_run_id) values (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      o.theaterId,
      o.agentId,
      o.objectiveId,
      o.author,
      o.body,
      Date.now(),
      o.deliveredRunId ?? null,
    );
    const order = this.toOrder(this.get("select * from orders where id = ?", id)!);
    this.bus.emit({ t: "order", order });
    return order;
  }

  undeliveredOrders(agentId: string): OrderView[] {
    return this.all("select * from orders where agent_id = ? and delivered_run_id is null order by created_at", agentId).map((r) => this.toOrder(r));
  }

  markDelivered(orderIds: string[], runId: string): void {
    for (const id of orderIds) this.run("update orders set delivered_run_id = ? where id = ?", runId, id);
  }

  listOrders(theaterId: string, limit = 200): OrderView[] {
    return this.all("select * from orders where theater_id = ? order by created_at desc limit ?", theaterId, limit)
      .map((r) => this.toOrder(r))
      .reverse();
  }

  // ── Sessions (one Claude Code session per agent + objective) ──────────────

  getSession(agentId: string, key: string): SessionRecord | null {
    const r = this.get("select * from sessions where agent_id = ? and session_key = ?", agentId, key);
    return r ? { sessionId: str(r.session_id), cwd: str(r.cwd), costUsd: num(r.cost_usd) } : null;
  }

  latestSession(agentId: string): (SessionRecord & { key: string }) | null {
    const r = this.get("select * from sessions where agent_id = ? order by updated_at desc limit 1", agentId);
    return r ? { key: str(r.session_key), sessionId: str(r.session_id), cwd: str(r.cwd), costUsd: num(r.cost_usd) } : null;
  }

  setSession(agentId: string, key: string, sessionId: string, cwd: string, costUsd?: number): void {
    const prev = this.getSession(agentId, key);
    const cost = costUsd ?? (prev && prev.sessionId === sessionId ? prev.costUsd : 0);
    this.run(
      `insert into sessions (agent_id, session_key, session_id, cwd, cost_usd, updated_at) values (?, ?, ?, ?, ?, ?)
       on conflict(agent_id, session_key) do update set session_id = excluded.session_id, cwd = excluded.cwd,
         cost_usd = excluded.cost_usd, updated_at = excluded.updated_at`,
      agentId,
      key,
      sessionId,
      cwd,
      cost,
      Date.now(),
    );
  }

  knownSessionIds(): Set<string> {
    return new Set(this.all("select session_id from sessions").map((r) => str(r.session_id)));
  }

  // ── Runs (sorties) ────────────────────────────────────────────────────────

  private toRun(r: Row): RunView {
    return {
      id: str(r.id),
      agentId: str(r.agent_id),
      objectiveId: strOrNull(r.objective_id),
      wakeReason: str(r.wake_reason) as WakeReason,
      status: str(r.status) as RunStatus,
      startedAt: num(r.started_at),
      endedAt: numOrNull(r.ended_at),
      costUsd: num(r.cost_usd),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      numTurns: num(r.num_turns),
      sessionId: strOrNull(r.session_id),
      error: strOrNull(r.error),
    };
  }

  createRun(theaterId: string, agentId: string, objectiveId: string | null, wakeReason: WakeReason): RunView {
    const id = newId("rn");
    this.run(
      "insert into runs (id, theater_id, agent_id, objective_id, wake_reason, status, started_at) values (?, ?, ?, ?, ?, 'starting', ?)",
      id,
      theaterId,
      agentId,
      objectiveId,
      wakeReason,
      Date.now(),
    );
    return this.emitRun(id)!;
  }

  getRun(id: string): RunView | null {
    const r = this.get("select * from runs where id = ?", id);
    return r ? this.toRun(r) : null;
  }

  updateRun(id: string, patch: Partial<Omit<RunView, "id" | "agentId" | "wakeReason" | "startedAt">>): RunView | null {
    const run = this.getRun(id);
    if (!run) return null;
    const n = { ...run, ...defined(patch) };
    this.run(
      `update runs set objective_id = ?, status = ?, ended_at = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?,
         num_turns = ?, session_id = ?, error = ? where id = ?`,
      n.objectiveId,
      n.status,
      n.endedAt,
      n.costUsd,
      n.inputTokens,
      n.outputTokens,
      n.numTurns,
      n.sessionId,
      n.error,
      id,
    );
    return this.emitRun(id);
  }

  listRuns(theaterId: string, limit = 100): RunView[] {
    return this.all("select * from runs where theater_id = ? order by started_at desc limit ?", theaterId, limit).map((r) => this.toRun(r));
  }

  lastRunEnd(agentId: string): number | null {
    return numOrNull(this.get("select max(ended_at) as t from runs where agent_id = ?", agentId)?.t);
  }

  /** Runs that were live when the server stopped can't be reattached. */
  /** Runs that were live when this theater's War Room stopped. Another theater's War Room may still be running. */
  markInterruptedRuns(theaterId: string): number {
    const rows = this.all("select id from runs where theater_id = ? and status in ('starting', 'running')", theaterId);
    for (const r of rows) {
      this.run("update runs set status = 'failed', ended_at = ?, error = 'interrupted: War Room restarted' where id = ?", Date.now(), r.id!);
      this.run("update objectives set checkout_run_id = null where checkout_run_id = ?", r.id!);
    }
    // A team lead's live session ends with War Room; RESUME brings the lead back.
    this.run(
      "update agents set status = 'paused', paused_reason = 'session_ended' where theater_id = ? and team_mode = 1 and status != 'terminated' and coalesce(paused_reason, '') != 'commander'",
      theaterId,
    );
    // A HOLD asked for mid-sortie takes effect now.
    this.run("update agents set status = 'paused' where theater_id = ? and paused_reason = 'commander' and status in ('running', 'queued', 'commanded')", theaterId);
    this.run("update agents set status = 'idle' where theater_id = ? and status in ('running', 'queued', 'commanded')", theaterId);
    return rows.length;
  }

  /** Which theater owns a run (for cleaning up its leftover files). */
  runTheater(runId: string): string | null {
    return strOrNull(this.get("select theater_id from runs where id = ?", runId)?.theater_id);
  }

  private emitRun(id: string): RunView | null {
    const run = this.getRun(id);
    if (run) this.bus.emit({ t: "run", run });
    return run;
  }

  // ── Feed (structured run transcript) ──────────────────────────────────────

  addFeed(theaterId: string, item: Omit<FeedItem, "id" | "at"> & { at?: number }): FeedItem {
    const full: FeedItem = { ...item, id: newId("fd"), at: item.at ?? Date.now() };
    this.run(
      "insert into feed (id, theater_id, agent_id, run_id, at, kind, text, tool, tool_use_id, is_error, target) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      full.id,
      theaterId,
      full.agentId,
      full.runId,
      full.at,
      full.kind,
      full.text,
      full.tool ?? null,
      full.toolUseId ?? null,
      full.isError ? 1 : 0,
      full.target ?? null,
    );
    this.bus.emit({ t: "feed", item: full });
    return full;
  }

  recentFeed(theaterId: string, perAgent = 80): FeedItem[] {
    const rows = this.all(
      `select * from (
         select *, row_number() over (partition by agent_id order by at desc) as rn from feed where theater_id = ?
       ) where rn <= ? order by at`,
      theaterId,
      perAgent,
    );
    return rows.map((r) => ({
      id: str(r.id),
      agentId: str(r.agent_id),
      runId: strOrNull(r.run_id),
      at: num(r.at),
      kind: str(r.kind) as FeedItem["kind"],
      text: str(r.text),
      tool: strOrNull(r.tool) ?? undefined,
      toolUseId: strOrNull(r.tool_use_id) ?? undefined,
      isError: num(r.is_error) === 1,
      target: strOrNull(r.target),
    }));
  }

  /** Repo-relative paths an agent has touched, most recent first. */
  touchedFiles(agentId: string, limit = 60): { path: string; tool: string; at: number }[] {
    return this.all(
      `select target, tool, max(at) as at from feed where agent_id = ? and kind = 'tool_use' and target is not null
       group by target order by at desc limit ?`,
      agentId,
      limit,
    ).map((r) => ({ path: str(r.target), tool: str(r.tool), at: num(r.at) }));
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  private toApproval(r: Row): ApprovalView {
    return {
      id: str(r.id),
      theaterId: str(r.theater_id),
      kind: str(r.kind) as ApprovalKind,
      agentId: strOrNull(r.agent_id),
      runId: strOrNull(r.run_id),
      title: str(r.title),
      detail: str(r.detail),
      payload: parseJson<Record<string, unknown>>(strOrNull(r.payload), {}),
      status: str(r.status) as ApprovalStatus,
      createdAt: num(r.created_at),
      resolvedAt: numOrNull(r.resolved_at),
      resolution: strOrNull(r.resolution),
    };
  }

  createApproval(a: {
    theaterId: string;
    kind: ApprovalKind;
    agentId: string | null;
    runId: string | null;
    title: string;
    detail: string;
    payload: Record<string, unknown>;
  }): ApprovalView {
    const id = newId("ap");
    this.run(
      "insert into approvals (id, theater_id, kind, agent_id, run_id, title, detail, payload, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      id,
      a.theaterId,
      a.kind,
      a.agentId,
      a.runId,
      a.title,
      a.detail,
      JSON.stringify(a.payload),
      Date.now(),
    );
    return this.emitApproval(id)!;
  }

  getApproval(id: string): ApprovalView | null {
    const r = this.get("select * from approvals where id = ?", id);
    return r ? this.toApproval(r) : null;
  }

  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">, resolution: string | null): ApprovalView | null {
    this.run("update approvals set status = ?, resolution = ?, resolved_at = ? where id = ? and status = 'pending'", status, resolution, Date.now(), id);
    return this.emitApproval(id);
  }

  pendingApprovals(theaterId: string): ApprovalView[] {
    return this.all("select * from approvals where theater_id = ? and status = 'pending' order by created_at", theaterId).map((r) => this.toApproval(r));
  }

  pendingApprovalsForRun(runId: string): ApprovalView[] {
    return this.all("select * from approvals where run_id = ? and status = 'pending'", runId).map((r) => this.toApproval(r));
  }

  hasPendingApproval(agentId: string, kind: ApprovalKind): boolean {
    return Boolean(this.get("select 1 from approvals where agent_id = ? and kind = ? and status = 'pending'", agentId, kind));
  }

  listApprovals(theaterId: string, limit = 100): ApprovalView[] {
    return this.all("select * from approvals where theater_id = ? order by created_at desc limit ?", theaterId, limit).map((r) => this.toApproval(r));
  }

  /** Blocking prompts can't survive a restart; mark them expired. */
  expireStalePermissionPrompts(theaterId: string): void {
    this.run("update approvals set status = 'expired', resolved_at = ? where theater_id = ? and status = 'pending' and kind = 'tool_permission'", Date.now(), theaterId);
  }

  private emitApproval(id: string): ApprovalView | null {
    const approval = this.getApproval(id);
    if (approval) this.bus.emit({ t: "approval", approval });
    return approval;
  }

  // ── Comms log (audit trail shown as the BF6 kill-feed ticker) ─────────────

  comms(theaterId: string, agentId: string | null, kind: string, text: string): CommsEntry {
    this.run("insert into comms (theater_id, at, agent_id, kind, text) values (?, ?, ?, ?, ?)", theaterId, Date.now(), agentId, kind, text);
    const r = this.get("select * from comms where id = last_insert_rowid()")!;
    const entry: CommsEntry = { id: num(r.id), at: num(r.at), agentId: strOrNull(r.agent_id), kind: str(r.kind), text: str(r.text) };
    this.bus.emit({ t: "comms", entry });
    return entry;
  }

  recentComms(theaterId: string, limit = 120): CommsEntry[] {
    return this.all("select * from comms where theater_id = ? order by id desc limit ?", theaterId, limit)
      .map((r) => ({ id: num(r.id), at: num(r.at), agentId: strOrNull(r.agent_id), kind: str(r.kind), text: str(r.text) }))
      .reverse();
  }

  // ── Wake queue (persisted so restarts resume) ─────────────────────────────

  saveWake(w: PendingWake): void {
    this.run(
      `insert into wakes (agent_id, reasons, objective_ids, note, created_at) values (?, ?, ?, ?, ?)
       on conflict(agent_id) do update set reasons = excluded.reasons, objective_ids = excluded.objective_ids, note = excluded.note`,
      w.agentId,
      JSON.stringify(w.reasons),
      JSON.stringify(w.objectiveIds),
      w.note,
      w.createdAt,
    );
  }

  deleteWake(agentId: string): void {
    this.run("delete from wakes where agent_id = ?", agentId);
  }

  listWakes(theaterId: string): PendingWake[] {
    return this.all("select w.* from wakes w join agents a on a.id = w.agent_id where a.theater_id = ? order by w.created_at", theaterId).map((r) => ({
      agentId: str(r.agent_id),
      reasons: parseJson<WakeReason[]>(strOrNull(r.reasons), []),
      objectiveIds: parseJson<string[]>(strOrNull(r.objective_ids), []),
      note: strOrNull(r.note),
      createdAt: num(r.created_at),
    }));
  }
}

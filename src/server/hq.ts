// HQ: the command layer. Everything the Commander (REST API) or an agent
// (MCP tools) can do goes through here, so side effects — wakes, comms log,
// approvals — stay consistent no matter who triggered them.
import type {
  AgentView,
  ApprovalView,
  CityModel,
  CommsCheck,
  FrontView,
  MissionView,
  ObjectiveStatus,
  ObjectiveView,
  OrderView,
  Priority,
  Settings,
  PermissionOverride,
  Snapshot,
  SupplyMode,
  TheaterView,
} from "../shared/protocol.js";
import { OPEN_OBJECTIVE_STATUSES } from "../shared/protocol.js";
import type { Approvals, Decision } from "./approvals.js";
import type { Bus } from "./bus.js";
import type { WarRoomConfig } from "./config.js";
import { alwaysRuleFor } from "./permissions.js";
import { MODEL_GUIDE } from "./prompts.js";
import type { Roles } from "./roles.js";
import type { Scheduler } from "./scheduler.js";
import type { Store } from "./store.js";
import type { TeamOps } from "./team.js";
import { newId, truncate } from "./util.js";
import { prepareWorkspace, removeWorktree } from "./workspaces.js";

export const MERGE_TOOLS = ["Bash(git merge*)", "Bash(git checkout*)", "Bash(git switch*)", "Bash(git commit*)", "Bash(git add*)", "Bash(git branch*)"];

export interface Providers {
  city: () => CityModel;
  commsCheck: () => CommsCheck;
  fronts: () => FrontView[];
  externalAgents: () => AgentView[];
  teamUnits?: () => AgentView[];
  takeCommandAvailable: () => boolean;
  supplyMode: () => SupplyMode;
  version: string;
}

/** The permission mode every agent runs in (the HUD's PERMISSIONS switch). */
export function permissionOverrideOf(store: Store): PermissionOverride {
  const v = store.getSetting("permissionMode");
  return v === "plan" || v === "manual" ? v : "auto";
}

/** The `--permission-mode` value for an override ("manual" is Claude Code's `default`). */
export const cliPermissionMode = (o: PermissionOverride): string => (o === "manual" ? "default" : o);

/** The Commander's choice, else plan usage for subscription logins and budgets for API keys. */
export function supplyModeOf(store: Store, comms: CommsCheck): SupplyMode {
  const v = store.getSetting("supplyMode");
  if (v === "budget" || v === "usage") return v;
  return comms.subscription || comms.authMethod === "claude.ai" ? "usage" : "budget";
}

export interface DeployInput {
  role: string;
  callsign?: string | null;
  reportsTo?: string | null;
  model?: string | null;
  effort?: string | null;
  budgetUsd?: number | null;
  permissionMode?: string | null;
  /** Run as a live Claude Code session that builds its own agent team (top-level commanders only). */
  teamMode?: boolean;
  mission?: { title: string; body?: string } | null;
  objective?: { title: string; body?: string; targetPaths?: string[]; priority?: Priority } | null;
}

export interface ObjectiveInput {
  title: string;
  body?: string;
  assignee?: string | null;
  parent?: string | null;
  priority?: Priority;
  targetPaths?: string[];
  missionId?: string | null;
  /** Only the Commander's and the General's choices count. */
  model?: string | null;
  effort?: string | null;
}

export interface ObjectivePatch {
  status?: ObjectiveStatus;
  comment?: string;
  assignee?: string | null;
  title?: string;
  body?: string;
  priority?: Priority;
  targetPaths?: string[];
  model?: string | null;
  effort?: string | null;
}

export class HqError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class HQ {
  private team: TeamOps | null = null;

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly roles: Roles,
    private readonly scheduler: Scheduler,
    private readonly approvals: Approvals,
    private readonly config: WarRoomConfig,
    private readonly theaterRef: () => TheaterView,
    private readonly providers: Providers,
  ) {
    approvals.onResolved((a, d) => void this.afterDecision(a, d));
  }

  get theater(): TheaterView {
    return this.theaterRef();
  }

  attachTeam(team: TeamOps): void {
    this.team = team;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  snapshot(): Snapshot {
    const t = this.theater;
    return {
      theater: t,
      agents: [...this.store.listAgents(t.id), ...(this.providers.teamUnits?.() ?? []), ...this.providers.externalAgents()],
      objectives: this.store.listObjectives(t.id),
      missions: this.store.listMissions(t.id),
      approvals: this.store.listApprovals(t.id, 60),
      runs: this.store.listRuns(t.id, 60),
      orders: this.store.listOrders(t.id, 200),
      comms: this.store.recentComms(t.id),
      feed: this.store.recentFeed(t.id),
      roles: this.roles.views(),
      city: this.providers.city(),
      commsCheck: this.providers.commsCheck(),
      fronts: this.providers.fronts(),
      settings: this.settings(),
    };
  }

  settings(): Settings {
    return {
      maxConcurrent: this.config.maxConcurrent,
      demo: this.config.demo,
      takeCommandAvailable: this.providers.takeCommandAvailable(),
      version: this.providers.version,
      supplyMode: this.providers.supplyMode(),
      permissionMode: permissionOverrideOf(this.store),
      generalPicksModels: this.store.getSetting("generalPicksModels") === "1",
    };
  }

  updateSettings(patch: { supplyMode?: SupplyMode; generalPicksModels?: boolean; permissionMode?: PermissionOverride }): Settings {
    const t = this.theater;
    if (patch.permissionMode && patch.permissionMode !== permissionOverrideOf(this.store)) {
      this.store.setSetting("permissionMode", patch.permissionMode);
      this.store.comms(t.id, null, "supply_mode", `Permissions: ${patch.permissionMode.toUpperCase()} for every agent's next sortie`);
    }
    if (patch.generalPicksModels !== undefined && patch.generalPicksModels !== this.settings().generalPicksModels) {
      this.store.setSetting("generalPicksModels", patch.generalPicksModels ? "1" : "0");
      this.store.comms(t.id, null, "supply_mode", patch.generalPicksModels ? "The General now picks the model and effort for each objective" : "Agents use their own models again");
      if (!patch.generalPicksModels) this.releaseModelPicks("General model picks were turned off");
    }
    if (patch.supplyMode && patch.supplyMode !== this.providers.supplyMode()) {
      this.store.setSetting("supplyMode", patch.supplyMode);
      if (patch.supplyMode === "usage") {
        // No caps any more: drop resupply requests and send held units back out.
        for (const ap of this.store.pendingApprovals(t.id)) if (ap.kind === "budget") this.approvals.expire(ap.id, "Supply switched to plan usage");
        for (const a of this.store.listAgents(t.id)) if (a.status === "paused" && a.pausedReason === "out_of_supply") this.resume(a.id);
      }
      this.store.comms(t.id, null, "supply_mode", patch.supplyMode === "usage" ? "Supply lines: plan usage. Budget caps are off." : "Supply lines: budgets. Agents hold when they reach their cap.");
    } else if (patch.supplyMode) this.store.setSetting("supplyMode", patch.supplyMode);
    const settings = this.settings();
    this.bus.emit({ t: "settings", settings });
    this.scheduler.tick();
    return settings;
  }

  name(agentId: string | null): string {
    if (!agentId || agentId === "commander") return "Commander";
    const a = this.store.getAgent(agentId);
    return a ? `${a.letter}·${a.callsign}` : agentId;
  }

  requireAgent(ref: string): AgentView {
    const a = this.store.getAgent(ref) ?? this.store.findAgent(this.theater.id, ref);
    if (!a || a.status === "terminated") throw new HqError(`No active agent "${ref}".`, 404);
    return a;
  }

  requireObjective(ref: string): ObjectiveView {
    const o = this.store.findObjective(this.theater.id, ref);
    if (!o) throw new HqError(`No objective "${ref}".`, 404);
    return o;
  }

  general(): AgentView | null {
    const agents = this.store.listAgents(this.theater.id);
    return agents.find((a) => a.role === "general") ?? agents.find((a) => a.reportsTo === null) ?? null;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async deploy(input: DeployInput, by = "commander"): Promise<AgentView> {
    const role = this.roles.get(input.role);
    if (!role) throw new HqError(`Unknown role "${input.role}".`);
    const t = this.theater;
    const used = new Set(this.store.listAgents(t.id).map((a) => a.letter));
    const letter = role.id === "general" && !used.has("A") ? "A" : this.store.nextLetter(t.id);
    const taken = this.store.usedCallsigns(t.id);
    const callsign =
      input.callsign?.trim() || role.callsigns.find((c) => !taken.has(c.toLowerCase())) || `${role.name}-${letter}`;
    let reportsTo: string | null = null;
    if (input.reportsTo) reportsTo = this.requireAgent(input.reportsTo).id;
    else if (role.reportsTo) reportsTo = this.store.listAgents(t.id).find((a) => a.role === role.reportsTo)?.id ?? null;

    const team = input.teamMode === true;
    if (team) {
      if (reportsTo) throw new HqError("Team mode is for top-level commanders: deploy it reporting to you.");
      if (!this.config.demo && !this.providers.takeCommandAvailable()) throw new HqError("Team mode needs the optional node-pty dependency (npm install node-pty).", 501);
    }
    // A team shares one worktree, so its edits land on their own branch even if the role works in the main checkout.
    const worktree = role.worktree || team;
    const slug = `${letter.toLowerCase()}-${role.id}-${newId("w").slice(-4)}`;
    const { workspace, warning } = this.config.demo
      ? { workspace: { kind: worktree ? ("worktree" as const) : ("main" as const), path: t.root, branch: worktree ? `warroom/${slug}` : t.branch }, warning: null }
      : await prepareWorkspace(t.root, slug, worktree);
    const permissionMode = input.permissionMode ?? role.permissionMode;

    const agent = this.store.createAgent({
      theaterId: t.id,
      letter,
      callsign,
      role: role.id,
      reportsTo,
      model: input.model ?? role.model,
      effort: input.effort ?? role.effort,
      permissionMode,
      allowedTools: [],
      // Interactive sessions can't take a dollar cap: a team always draws on plan usage.
      budgetUsd: team ? null : input.budgetUsd === undefined ? role.budgetUsd : input.budgetUsd,
      workspace,
      teamMode: team,
    });
    this.store.comms(t.id, agent.id, "deploy", `${letter}·${callsign} (${role.name}${team ? ", team lead" : ""}) deployed by ${this.name(by)}`);
    if (warning) this.store.comms(t.id, agent.id, "warning", `${letter}·${callsign}: ${warning}`);

    if (input.mission?.title) {
      const mission = this.store.createMission(t.id, input.mission.title, input.mission.body ?? "");
      this.store.comms(t.id, null, "mission", `MISSION: ${mission.title}`);
      this.createObjective(
        {
          title: input.objective?.title ?? `Command the mission: ${mission.title}`,
          body: input.objective?.body ?? mission.body,
          assignee: agent.id,
          missionId: mission.id,
          targetPaths: input.objective?.targetPaths ?? [],
          priority: input.objective?.priority ?? "high",
        },
        by,
      );
    } else if (input.objective?.title) {
      this.createObjective({ ...input.objective, assignee: agent.id }, by);
    }
    return this.store.getAgent(agent.id)!;
  }

  updateAgent(
    ref: string,
    patch: Partial<{ callsign: string; budgetUsd: number | null; model: string | null; effort: string | null; permissionMode: string; patrolMinutes: number | null; reportsTo: string | null }>,
  ): AgentView {
    const a = this.requireAgent(ref);
    const reportsTo = patch.reportsTo === undefined ? undefined : patch.reportsTo === null ? null : this.requireAgent(patch.reportsTo).id;
    const updated = this.store.updateAgent(a.id, { ...patch, reportsTo })!;
    if (a.status === "paused" && a.pausedReason === "out_of_supply" && updated.budgetUsd !== null && updated.spentUsd < updated.budgetUsd) {
      this.resume(a.id);
    }
    return this.store.getAgent(a.id)!;
  }

  pause(ref: string): AgentView {
    const a = this.requireAgent(ref);
    // A live team can't be parked mid-session; interrupting the lead is the closest thing.
    if (a.teamMode && this.team?.isLive(a.id)) {
      this.scheduler.recall(a.id);
      return a;
    }
    // A live sortie finishes first; the hold takes effect when it ends.
    if (a.status === "running") this.store.updateAgent(a.id, { pausedReason: "commander" });
    else this.store.updateAgent(a.id, { status: "paused", pausedReason: "commander" });
    this.store.comms(a.theaterId, a.id, "pause", `${a.letter}·${a.callsign} ordered to hold position`);
    return this.store.getAgent(a.id)!;
  }

  resume(ref: string): AgentView {
    const a = this.requireAgent(ref);
    if (a.teamMode && !this.team?.isLive(a.id)) {
      if (!this.config.demo && !this.providers.takeCommandAvailable()) throw new HqError("Team mode needs the optional node-pty dependency (npm install node-pty).", 501);
      this.store.updateAgent(a.id, { pausedReason: null });
      this.team?.restart(this.store.getAgent(a.id)!);
      return this.store.getAgent(a.id)!;
    }
    if (a.status === "paused") {
      this.store.updateAgent(a.id, { status: this.scheduler.hasPendingWake(a.id) ? "queued" : "idle", pausedReason: null });
      this.store.setRuntime(a.id, { activity: "idle", activityDetail: "Standing by" });
    } else if (a.pausedReason) this.store.updateAgent(a.id, { pausedReason: null });
    this.scheduler.tick();
    return this.store.getAgent(a.id)!;
  }

  wake(ref: string, note?: string): AgentView {
    const a = this.requireAgent(ref);
    this.scheduler.wake(a.id, "manual", { note: note ?? null });
    return this.store.getAgent(a.id)!;
  }

  recall(ref: string): boolean {
    const a = this.requireAgent(ref);
    const ok = this.scheduler.recall(a.id);
    if (ok) this.store.comms(a.theaterId, a.id, "recall", `${a.letter}·${a.callsign} recalled to base`);
    return ok;
  }

  async terminate(ref: string, opts: { removeWorktree?: boolean } = {}): Promise<{ agent: AgentView; worktree: string | null }> {
    const a = this.requireAgent(ref);
    // Let a team session wind down before its worktree can go.
    if (a.teamMode) await this.team?.stop(a.id);
    this.scheduler.recall(a.id);
    this.scheduler.cancelWake(a.id);
    for (const o of this.store.openObjectivesFor(a.id)) this.store.updateObjective(o.id, { assigneeId: null, status: "todo", checkoutRunId: null });
    this.store.updateAgent(a.id, { status: "terminated" });
    let worktree: string | null = null;
    if (opts.removeWorktree && a.workspace.kind === "worktree" && !this.config.demo) {
      const r = await removeWorktree(this.theater.root, a.workspace);
      worktree = r.removed ? "removed" : `kept (${r.reason})`;
    }
    this.store.comms(a.theaterId, a.id, "dismiss", `${a.letter}·${a.callsign} dismissed${worktree ? `; worktree ${worktree}` : ""}`);
    this.bus.emit({ t: "agent_removed", id: a.id });
    if (!this.general()) this.releaseModelPicks("There's no General to choose models");
    return { agent: this.store.getAgent(a.id)!, worktree };
  }

  // ── Missions & objectives ─────────────────────────────────────────────────

  async launchMission(input: { title: string; body?: string }): Promise<MissionView> {
    const general = this.general();
    if (!general) {
      const agent = await this.deploy({ role: "general", mission: input });
      return this.store.getMission(this.store.openObjectivesFor(agent.id)[0]?.missionId ?? "")!;
    }
    const mission = this.store.createMission(this.theater.id, input.title, input.body ?? "");
    this.store.comms(this.theater.id, null, "mission", `MISSION: ${mission.title}`);
    this.createObjective(
      { title: `Command the mission: ${mission.title}`, body: mission.body, assignee: general.id, missionId: mission.id, priority: "high" },
      "commander",
    );
    return mission;
  }

  createObjective(input: ObjectiveInput, by: string): ObjectiveView {
    const t = this.theater;
    if (!input.title?.trim()) throw new HqError("An objective needs a title.");
    const assignee = input.assignee ? this.requireAgent(input.assignee) : null;
    const parent = input.parent ? this.requireObjective(input.parent) : null;
    const missionId = input.missionId ?? parent?.missionId ?? this.store.activeMission(t.id)?.id ?? null;
    // Model and effort: the Commander can always set them; the General does when picks are on.
    // Otherwise a Commander objective waits for the General's pick (unless the General is its assignee).
    const general = this.general();
    const picks = this.settings().generalPicksModels;
    const chosen = Boolean(input.model || input.effort);
    const fromGeneral = general !== null && by === general.id;
    const modelBy = chosen && by === "commander" ? "commander" : chosen && fromGeneral && picks ? "general" : null;
    const modelPending = !modelBy && picks && by === "commander" && general !== null && assignee?.id !== general.id;
    const o = this.store.createObjective({
      theaterId: t.id,
      title: input.title.trim(),
      body: input.body?.trim() ?? "",
      priority: input.priority ?? "normal",
      assigneeId: assignee?.id ?? null,
      parentId: parent?.id ?? null,
      missionId,
      targetPaths: (input.targetPaths ?? []).map((p) => p.replace(/^\.?\//, "")).filter(Boolean),
      createdBy: by,
      model: modelBy ? (input.model ?? null) : null,
      effort: modelBy ? (input.effort ?? null) : null,
      modelBy,
      modelPending,
    });
    this.store.comms(t.id, by === "commander" ? null : by, "objective", `#${o.number} ${truncate(o.title, 60)}${assignee ? ` → ${assignee.letter}·${assignee.callsign}` : ""}`);
    if (modelPending && general) {
      this.scheduler.wake(general.id, "model_pick", {
        note:
          `The Commander created objective #${o.number} "${o.title}"${assignee ? ` for ${assignee.letter} · ${assignee.callsign} (${assignee.role})` : ""} and wants you to choose its model and effort. ` +
          `Call update_objective with objective "#${o.number}" plus model and effort; that releases it${assignee ? ` to ${assignee.callsign}` : ""}.\n${MODEL_GUIDE}`,
      });
    } else if (assignee) this.scheduler.wake(assignee.id, "assigned", { objectiveId: o.id });
    return o;
  }

  /** Stop waiting on the General: pending objectives run on their assignees' own models. */
  releaseModelPicks(reason: string): void {
    for (const o of this.store.listObjectives(this.theater.id)) {
      if (!o.modelPending) continue;
      this.store.updateObjective(o.id, { modelPending: false });
      if (o.assigneeId && OPEN_OBJECTIVE_STATUSES.includes(o.status)) this.scheduler.wake(o.assigneeId, "assigned", { objectiveId: o.id, note: `${reason}, so this runs on your own model.` });
    }
  }

  updateObjective(ref: string, patch: ObjectivePatch, by: string): ObjectiveView {
    const before = this.requireObjective(ref);
    let assigneeId = before.assigneeId;
    if (patch.assignee !== undefined) assigneeId = patch.assignee === null ? null : this.requireAgent(patch.assignee).id;
    // A model choice from the Commander, or the General's pick (when picks are on or one is pending).
    const general = this.general();
    const fromGeneral = general !== null && by === general.id;
    const setsModel = patch.model !== undefined || patch.effort !== undefined;
    const modelBy = setsModel && by === "commander" ? "commander" : setsModel && fromGeneral && (before.modelPending || this.settings().generalPicksModels) ? "general" : null;
    const o = this.store.updateObjective(before.id, {
      status: patch.status,
      title: patch.title,
      body: patch.body,
      priority: patch.priority,
      targetPaths: patch.targetPaths?.map((p) => p.replace(/^\.?\//, "")),
      assigneeId,
      ...(modelBy
        ? {
            model: patch.model !== undefined ? patch.model || null : before.model,
            effort: patch.effort !== undefined ? patch.effort || null : before.effort,
            modelBy,
            modelPending: false,
          }
        : {}),
    })!;
    if (modelBy && before.modelPending) {
      const pick = [o.model, o.effort].filter(Boolean).join(" · ") || "their own model";
      this.store.comms(o.theaterId, by === "commander" ? null : by, "objective", `#${o.number} will run on ${pick} (${modelBy === "general" ? "General's pick" : "Commander's pick"})`);
      if (o.assigneeId && OPEN_OBJECTIVE_STATUSES.includes(o.status)) this.scheduler.wake(o.assigneeId, "assigned", { objectiveId: o.id });
    }

    if (patch.comment?.trim()) {
      if (by === "commander") {
        if (o.assigneeId) this.sendOrder({ to: o.assigneeId, body: patch.comment.trim(), objectiveId: o.id, author: "commander" });
      } else {
        this.store.addOrder({ theaterId: o.theaterId, agentId: null, objectiveId: o.id, author: by, body: patch.comment.trim(), deliveredRunId: "report" });
      }
    }
    if (assigneeId && assigneeId !== before.assigneeId && !o.modelPending) this.scheduler.wake(assigneeId, "assigned", { objectiveId: o.id });

    if (patch.status && patch.status !== before.status) {
      this.store.comms(o.theaterId, by === "commander" ? null : by, "status", `#${o.number} ${truncate(o.title, 50)} → ${patch.status.replace("_", " ").toUpperCase()}`);
      this.notifyParent(o, patch.status, patch.comment ?? "", by);
      this.maybeCompleteMission(o);
    }
    return o;
  }

  private notifyParent(o: ObjectiveView, status: ObjectiveStatus, comment: string, by: string): void {
    if (!["done", "in_review", "blocked", "cancelled"].includes(status) || !o.parentId) return;
    const parent = this.store.getObjective(o.parentId);
    if (!parent?.assigneeId || parent.assigneeId === by) return;
    const siblings = this.store.childrenOf(parent.id);
    const open = siblings.filter((s) => OPEN_OBJECTIVE_STATUSES.includes(s.status) && s.status !== "in_review").length;
    const note =
      `Objective #${o.number} "${o.title}" is now ${status.replace("_", " ")} (by ${this.name(by)}).` +
      (comment ? `\nTheir report: ${truncate(comment, 1500)}` : "") +
      `\n${open === 0 ? "All delegated objectives under" : `${open} delegated objective(s) still open under`} #${parent.number}.`;
    this.scheduler.wake(parent.assigneeId, "child_done", { objectiveId: parent.id, note });
  }

  private maybeCompleteMission(o: ObjectiveView): void {
    if (!o.missionId || o.parentId || o.status !== "done") return;
    const mission = this.store.getMission(o.missionId);
    if (mission?.status !== "active") return;
    this.store.updateMission(mission.id, { status: "complete" });
    this.store.comms(o.theaterId, null, "mission", `MISSION COMPLETE: ${mission.title}`);
    this.bus.emit({ t: "toast", level: "info", text: `Mission complete: ${mission.title}` });
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  sendOrder(input: { to: string | null; body: string; objectiveId?: string | null; author: string }): OrderView {
    const t = this.theater;
    const body = input.body.trim();
    if (!body) throw new HqError("Orders can't be empty.");
    const recipient = input.to ? this.requireAgent(input.to) : null;
    const order = this.store.addOrder({ theaterId: t.id, agentId: recipient?.id ?? null, objectiveId: input.objectiveId ?? null, author: input.author, body });
    if (!recipient) {
      this.store.comms(t.id, input.author === "commander" ? null : input.author, "radio", `${this.name(input.author)} → Commander: ${truncate(body, 80)}`);
      this.bus.emit({ t: "toast", level: "info", text: `${this.name(input.author)}: ${truncate(body, 140)}` });
      return order;
    }
    const runId = this.scheduler.deliverLive(recipient.id, this.name(input.author), body);
    if (runId) {
      this.store.markDelivered([order.id], runId);
      this.store.addFeed(t.id, { agentId: recipient.id, runId, kind: "order", text: `${this.name(input.author)}: ${body}` });
      this.store.setRuntime(recipient.id, { activity: "orders", activityDetail: "Receiving orders" });
    } else {
      this.scheduler.wake(recipient.id, "order", { objectiveId: input.objectiveId ?? null });
    }
    this.store.comms(t.id, input.author === "commander" ? null : input.author, "radio", `${this.name(input.author)} → ${recipient.letter}·${recipient.callsign}: ${truncate(body, 80)}`);
    return order;
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  decide(id: string, approved: boolean, opts: { always?: boolean; note?: string | null } = {}): ApprovalView {
    const a = this.approvals.decide(id, approved, opts);
    if (!a) throw new HqError("No such request.", 404);
    return a;
  }

  requestReinforcements(requester: AgentView, input: { role: string; reason: string; callsign?: string | null }, runId: string | null): ApprovalView {
    const role = this.roles.get(input.role);
    if (!role) throw new HqError(`Unknown role "${input.role}". Roles: ${this.roles.list().map((r) => r.id).join(", ")}`);
    const approval = this.approvals.request({
      theaterId: requester.theaterId,
      kind: "reinforcements",
      agentId: requester.id,
      runId,
      title: `${requester.letter}·${requester.callsign} requests ${/^[aeiou]/i.test(role.name) ? "an" : "a"} ${role.name}`,
      detail: input.reason,
      payload: { role: role.id, callsign: input.callsign ?? null, requesterId: requester.id },
    });
    this.store.comms(requester.theaterId, requester.id, "request", `${requester.letter}·${requester.callsign} requests reinforcements: ${role.name}`);
    return approval;
  }

  requestMerge(requester: AgentView, input: { branch?: string | null; into?: string | null; summary: string; objective?: string | null }, runId: string | null): ApprovalView {
    const branch = input.branch?.trim() || requester.workspace.branch;
    if (!branch) throw new HqError("No branch to merge. Pass `branch`.");
    const into = input.into?.trim() || this.theater.branch || "main";
    const approval = this.approvals.request({
      theaterId: requester.theaterId,
      kind: "merge",
      agentId: requester.id,
      runId,
      title: `${requester.letter}·${requester.callsign} requests merge: ${branch} → ${into}`,
      detail: input.summary,
      payload: { branch, into, requesterId: requester.id, objective: input.objective ?? null },
    });
    this.store.comms(requester.theaterId, requester.id, "request", `${requester.letter}·${requester.callsign} requests merge ${branch} → ${into}`);
    return approval;
  }

  private async afterDecision(a: ApprovalView, d: Decision): Promise<void> {
    const t = this.theater;
    const requester = a.agentId ? this.store.getAgent(a.agentId) : null;
    const verdict = d.approved ? "APPROVED" : "DENIED";
    const note = d.note ? ` Commander's note: ${d.note}` : "";
    try {
      switch (a.kind) {
        case "tool_permission": {
          if (d.approved && d.always && requester) {
            const rule = alwaysRuleFor(String(a.payload.tool_name ?? ""), (a.payload.input as Record<string, unknown>) ?? {});
            if (rule && !requester.allowedTools.includes(rule)) this.store.updateAgent(requester.id, { allowedTools: [...requester.allowedTools, rule] });
          }
          this.store.comms(t.id, a.agentId, "permission", `${a.title}: ${d.approved ? "approved" : d.expired ? "expired" : "denied"}`);
          return;
        }
        case "reinforcements": {
          if (d.approved) {
            const agent = await this.deploy(
              { role: String(a.payload.role), callsign: (a.payload.callsign as string | null) ?? null, reportsTo: requester?.id ?? null },
              requester?.id ?? "commander",
            );
            if (requester) {
              this.scheduler.wake(requester.id, "approval", {
                note: `${verdict}: reinforcements. ${agent.letter} · ${agent.callsign} (${agent.role}) has joined and reports to you. Assign them work with create_objective.${note}`,
              });
            }
          } else if (requester) {
            this.scheduler.wake(requester.id, "approval", { note: `${verdict}: your request for a ${String(a.payload.role)}. Continue with the squad you have.${note}` });
          }
          return;
        }
        case "merge": {
          const branch = String(a.payload.branch);
          const into = String(a.payload.into);
          if (d.approved) {
            const general = this.general();
            const executor = general ?? requester;
            if (!executor) return;
            this.scheduler.grant(executor.id, MERGE_TOOLS);
            const objective = typeof a.payload.objective === "string" ? a.payload.objective : null;
            this.scheduler.wake(executor.id, "approval", {
              note:
                `${verdict}: merge \`${branch}\` into \`${into}\` (requested by ${this.name(requester?.id ?? null)}).${note}\n` +
                `Do it from the main checkout: \`git -C ${t.root} merge --no-ff ${branch}\`. Resolve any conflicts, run the relevant tests, then mark the related objective done${objective ? ` (#${objective.replace(/^#/, "")})` : ""} and report.`,
            });
          } else if (requester) {
            this.scheduler.wake(requester.id, "approval", { note: `${verdict}: merge of \`${branch}\`.${note || " Address the Commander's concerns and request again."}` });
          }
          return;
        }
        case "budget": {
          if (d.approved && requester) {
            const add = Number(a.payload.addUsd ?? 5);
            this.store.updateAgent(requester.id, { budgetUsd: (requester.budgetUsd ?? 0) + add });
            this.resume(requester.id);
            this.store.comms(t.id, requester.id, "supply", `Resupply: ${requester.letter}·${requester.callsign} +$${add}`);
          }
          return;
        }
      }
    } catch (err) {
      this.store.comms(t.id, a.agentId, "error", `Couldn't apply decision on "${a.title}": ${(err as Error).message}`);
    }
  }
}

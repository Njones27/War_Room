// The agents' side of the control plane. Each method is one War Room MCP
// tool; the demo adapter calls the same methods so both paths behave alike.
import type { AgentView, ObjectiveStatus, ObjectiveView, Priority } from "../shared/protocol.js";
import { OPEN_OBJECTIVE_STATUSES } from "../shared/protocol.js";
import type { Approvals } from "./approvals.js";
import { HqError, type HQ } from "./hq.js";
import { alwaysRuleFor, ruleMatches } from "./permissions.js";
import { MODEL_GUIDE } from "./prompts.js";
import type { Scheduler } from "./scheduler.js";
import { CheckoutConflict, type Store } from "./store.js";
import { truncate } from "./util.js";

export interface Caller {
  agentId: string;
  runId: string | null;
}

export type PermissionAnswer = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

const ref = (o: ObjectiveView) => `#${o.number}`;

export function describeToolCall(tool: string, input: Record<string, unknown>): { label: string; detail: string } {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return { label: `run \`${truncate(s("command").replace(/\s+/g, " "), 70)}\``, detail: s("command") + (s("description") ? `\n\n# ${s("description")}` : "") };
    case "Edit":
      return { label: `edit ${s("file_path")}`, detail: `${s("file_path")}\n\n- ${truncate(s("old_string"), 600)}\n+ ${truncate(s("new_string"), 600)}` };
    case "MultiEdit":
      return { label: `edit ${s("file_path")}`, detail: `${s("file_path")} (${Array.isArray(input.edits) ? input.edits.length : 0} edits)` };
    case "Write":
      return { label: `write ${s("file_path")}`, detail: `${s("file_path")}\n\n${truncate(s("content"), 1200)}` };
    case "WebFetch":
      return { label: `fetch ${truncate(s("url"), 60)}`, detail: s("url") };
    case "WebSearch":
      return { label: `search "${truncate(s("query"), 50)}"`, detail: s("query") };
    default:
      return { label: `use ${tool}`, detail: truncate(JSON.stringify(input, null, 2), 1500) };
  }
}

export class Toolkit {
  constructor(
    private readonly hq: HQ,
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    private readonly approvals: Approvals,
  ) {}

  private me(c: Caller): AgentView {
    const a = this.store.getAgent(c.agentId);
    if (!a || a.status === "terminated") throw new HqError("This agent is no longer active.");
    return a;
  }

  private label(a: AgentView | null): string {
    return a ? `${a.letter} · ${a.callsign}` : "Commander";
  }

  private objectiveSummary(o: ObjectiveView) {
    const parent = o.parentId ? this.store.getObjective(o.parentId) : null;
    return {
      ref: ref(o),
      title: o.title,
      status: o.status,
      priority: o.priority,
      body: o.body || undefined,
      targetPaths: o.targetPaths.length ? o.targetPaths : undefined,
      assignee: o.assigneeId ? this.label(this.store.getAgent(o.assigneeId)) : "unassigned",
      parent: parent ? `${ref(parent)} ${parent.title}` : undefined,
      model: o.modelPending ? "waiting for the General's pick" : (o.model ?? undefined),
      effort: o.effort ?? undefined,
    };
  }

  myOrders(c: Caller) {
    const me = this.me(c);
    const t = this.hq.theater;
    const agents = this.store.listAgents(t.id);
    const superior = me.reportsTo ? this.store.getAgent(me.reportsTo) : null;
    const orders = this.store
      .listOrders(t.id, 400)
      .filter((o) => o.agentId === me.id)
      .slice(-10)
      .map((o) => ({ from: this.hq.name(o.author), body: o.body, objective: o.objectiveId ? (this.store.getObjective(o.objectiveId)?.number ?? null) : null }));
    const mission = this.store.activeMission(t.id);
    // The General chooses models for objectives that are waiting on it (and, with picks on, for the ones it creates).
    const isGeneral = this.hq.general()?.id === me.id;
    const picks = this.hq.settings().generalPicksModels;
    const waiting = isGeneral ? this.store.listObjectives(t.id).filter((o) => o.modelPending && OPEN_OBJECTIVE_STATUSES.includes(o.status)) : [];
    return {
      ...(isGeneral && (picks || waiting.length)
        ? {
            modelPicks: {
              rule: "Set model and effort on every objective you create. For each one waiting below, call update_objective with model and effort to release it.",
              guide: MODEL_GUIDE,
              waiting: waiting.map((o) => ({ ref: ref(o), title: o.title, assignee: o.assigneeId ? this.label(this.store.getAgent(o.assigneeId)) : "unassigned" })),
            },
          }
        : {}),
      you: {
        callsign: this.label(me),
        role: me.role,
        reportsTo: superior ? `${this.label(superior)} (${superior.role})` : "Commander",
        subordinates: agents.filter((a) => a.reportsTo === me.id).map((a) => `${this.label(a)} (${a.role})`),
        workspace: me.workspace,
        supply:
          this.hq.settings().supplyMode === "usage" || me.budgetUsd === null
            ? "no cap (plan usage)"
            : `$${me.spentUsd.toFixed(2)} of $${me.budgetUsd.toFixed(2)} used`,
      },
      mission: mission ? { title: mission.title, body: mission.body || undefined } : null,
      objectives: this.store
        .openObjectivesFor(me.id)
        .filter((o) => !o.modelPending)
        .map((o) => this.objectiveSummary(o)),
      recentOrders: orders,
      squad: agents
        .filter((a) => a.id !== me.id)
        .map((a) => ({
          callsign: this.label(a),
          role: a.role,
          status: a.status,
          objective: a.objectiveId ? ref(this.store.getObjective(a.objectiveId) ?? ({ number: 0 } as ObjectiveView)) : null,
        })),
    };
  }

  checkout(c: Caller, objective: string) {
    const me = this.me(c);
    const o = this.hq.requireObjective(objective);
    if (!c.runId) throw new HqError("Checkout needs a live sortie.");
    if (o.modelPending) return { ok: false, conflict: true, message: `Objective ${ref(o)} is waiting for the General to choose its model. Pick another objective or report.` };
    try {
      const out = this.store.checkout(o.id, me.id, c.runId, (runId) => this.scheduler.isRunLive(runId));
      this.store.setRuntime(me.id, { objectiveId: out.id, ...(out.targetPaths[0] ? { target: out.targetPaths[0] } : {}) });
      return { ok: true, objective: this.objectiveSummary(out) };
    } catch (err) {
      if (err instanceof CheckoutConflict) {
        return { ok: false, conflict: true, message: `${err.message} Do not retry; pick another objective or report.`, owner: this.label(err.ownerAgentId ? this.store.getAgent(err.ownerAgentId) : null) };
      }
      throw err;
    }
  }

  update(c: Caller, input: { objective: string; status?: ObjectiveStatus; comment?: string; targetPaths?: string[]; model?: string; effort?: string }) {
    const me = this.me(c);
    const o = this.hq.requireObjective(input.objective);
    const parent = o.parentId ? this.store.getObjective(o.parentId) : null;
    const allowed = o.assigneeId === me.id || o.createdBy === me.id || parent?.assigneeId === me.id || me.reportsTo === null;
    if (!allowed) throw new HqError(`Objective ${ref(o)} isn't yours. Report to its owner instead.`);
    const out = this.hq.updateObjective(o.id, { status: input.status, comment: input.comment, targetPaths: input.targetPaths, model: input.model, effort: input.effort }, me.id);
    return { ok: true, objective: this.objectiveSummary(out), ...this.modelNote(input, out) };
  }

  /** A model or effort the caller set but that didn't count (only the General's picks do, and only with picks on). */
  private modelNote(input: { model?: string; effort?: string }, o: ObjectiveView): { note?: string } {
    const ignored = (Boolean(input.model) && o.model !== input.model) || (Boolean(input.effort) && o.effort !== input.effort);
    if (!ignored) return {};
    return { note: "Model and effort were not changed: only the General sets them, and only while the Commander has General model picks turned on. The assignee's own model applies." };
  }

  create(c: Caller, input: { title: string; body?: string; assignee?: string; parent?: string; priority?: Priority; targetPaths?: string[]; model?: string; effort?: string }) {
    const me = this.me(c);
    let assignee: AgentView | null = null;
    if (input.assignee) assignee = this.hq.requireAgent(input.assignee);
    const mayAssign = !assignee || assignee.id === me.id || assignee.reportsTo === me.id || me.reportsTo === null;
    const parent = input.parent ?? (me.objectiveId ? `#${this.store.getObjective(me.objectiveId)?.number}` : undefined);
    const o = this.hq.createObjective(
      { title: input.title, body: input.body, assignee: mayAssign ? (assignee?.id ?? null) : null, parent, priority: input.priority, targetPaths: input.targetPaths, model: input.model, effort: input.effort },
      me.id,
    );
    if (assignee && !mayAssign) {
      const general = this.hq.general();
      if (general && general.id !== me.id) {
        this.hq.sendOrder({ to: general.id, author: me.id, objectiveId: o.id, body: `I created ${ref(o)} "${o.title}" for ${this.label(assignee)}, but they don't report to me. Please assign it.` });
      }
      return { ok: true, objective: this.objectiveSummary(o), note: `${this.label(assignee)} doesn't report to you, so ${ref(o)} was left unassigned and the General was asked to assign it.` };
    }
    return { ok: true, objective: this.objectiveSummary(o), ...this.modelNote(input, o) };
  }

  listAgents(c: Caller) {
    this.me(c);
    return this.store.listAgents(this.hq.theater.id).map((a) => ({
      callsign: this.label(a),
      role: a.role,
      status: a.status,
      reportsTo: a.reportsTo ? this.label(this.store.getAgent(a.reportsTo)) : "Commander",
      activity: a.activityDetail,
      openObjectives: this.store.openObjectivesFor(a.id).map((o) => `${ref(o)} ${o.title} [${o.status}]`),
    }));
  }

  radio(c: Caller, input: { to: string; text: string; objective?: string }) {
    const me = this.me(c);
    const toCommander = /^(commander|cmdr|hq|human|user)$/i.test(input.to.trim());
    const objectiveId = input.objective ? this.hq.requireObjective(input.objective).id : null;
    const order = this.hq.sendOrder({ to: toCommander ? null : input.to, body: input.text, objectiveId, author: me.id });
    return { ok: true, delivered: order.agentId ? (this.scheduler.isActive(order.agentId) ? "live" : "queued; they'll be woken") : "to the Commander" };
  }

  report(c: Caller, input: { text: string; objective?: string }) {
    const me = this.me(c);
    const objectiveId = input.objective ? this.hq.requireObjective(input.objective).id : me.objectiveId;
    this.store.addOrder({ theaterId: me.theaterId, agentId: null, objectiveId, author: me.id, body: input.text, deliveredRunId: "report" });
    this.store.comms(me.theaterId, me.id, "sitrep", `SITREP ${me.letter}·${me.callsign}: ${truncate(input.text, 110)}`);
    return { ok: true };
  }

  requestReinforcements(c: Caller, input: { role: string; reason: string; callsign?: string }) {
    const me = this.me(c);
    const a = this.hq.requestReinforcements(me, input, c.runId);
    return { ok: true, request: a.id, status: "pending", note: "The Commander decides on the map. You'll be woken with the answer; don't wait for it." };
  }

  requestMerge(c: Caller, input: { branch?: string; into?: string; summary: string; objective?: string }) {
    const me = this.me(c);
    const a = this.hq.requestMerge(me, input, c.runId);
    return { ok: true, request: a.id, status: "pending", note: "The Commander reviews merges on the map. You'll be woken with the decision." };
  }

  async permission(c: Caller, input: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }, signal?: AbortSignal): Promise<PermissionAnswer> {
    const me = this.me(c);
    const toolInput = input.input ?? {};
    if (me.allowedTools.some((rule) => ruleMatches(rule, input.tool_name, toolInput))) return { behavior: "allow", updatedInput: toolInput };

    const { label, detail } = describeToolCall(input.tool_name, toolInput);
    const { decision } = this.approvals.requestAndWait(
      {
        theaterId: me.theaterId,
        kind: "tool_permission",
        agentId: me.id,
        runId: c.runId,
        title: `${me.letter}·${me.callsign} wants to ${label}`,
        detail,
        payload: { tool_name: input.tool_name, input: toolInput, tool_use_id: input.tool_use_id ?? null, alwaysRule: alwaysRuleFor(input.tool_name, toolInput) },
      },
      signal,
    );
    const previous = { activity: me.activity, activityDetail: me.activityDetail };
    this.store.setRuntime(me.id, { activity: "needs_you", activityDetail: `Awaiting approval: ${label}` });
    this.store.comms(me.theaterId, me.id, "permission", `${me.letter}·${me.callsign} requests permission to ${label}`);
    const d = await decision;
    this.store.setRuntime(me.id, d.approved ? previous : { activity: "thinking", activityDetail: "Adapting" });
    if (d.approved) return { behavior: "allow", updatedInput: toolInput };
    return {
      behavior: "deny",
      message: d.expired
        ? "The Commander didn't answer in time. Continue without this action, or report what you need."
        : `The Commander denied this.${d.note ? ` Note: ${d.note}` : ""} Adapt your approach; don't retry the same action.`,
    };
  }

  /** Objectives an agent could plausibly pick up (used by the demo adapter). */
  openFor(agentId: string): ObjectiveView[] {
    return this.store.openObjectivesFor(agentId).filter((o) => OPEN_OBJECTIVE_STATUSES.includes(o.status));
  }
}

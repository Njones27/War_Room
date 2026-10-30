// REST commands for the Commander's UI.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommsCheck } from "../shared/protocol.js";
import type { WarRoomConfig } from "./config.js";
import { cliPermissionMode, HqError, permissionOverrideOf, type HQ } from "./hq.js";
import { buildInstructions } from "./prompts.js";
import type { Orbit } from "./orbit.js";
import type { Roles } from "./roles.js";
import type { Scheduler } from "./scheduler.js";
import type { PtyHost } from "./ptyHost.js";
import type { Store } from "./store.js";
import type { TakeCommand } from "./takeCommand.js";
import type { TeamOps } from "./team.js";

type Route = (
  method: string,
  pattern: string,
  handler: (ctx: { params: Record<string, string>; body: Record<string, unknown>; query: URLSearchParams }) => unknown,
) => void;

const STATUS = z.enum(["todo", "in_progress", "blocked", "in_review", "done", "cancelled"]);
const PRIORITY = z.enum(["low", "normal", "high", "critical"]);
const EFFORT = z.enum(["low", "medium", "high", "xhigh", "max"]);
const MODE = z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

const Deploy = z.object({
  role: z.string(),
  callsign: z.string().max(40).nullish(),
  reportsTo: z.string().nullish(),
  model: z.string().max(80).nullish(),
  effort: EFFORT.nullish(),
  budgetUsd: z.number().positive().max(10_000).nullish(),
  permissionMode: MODE.nullish(),
  teamMode: z.boolean().optional(),
  mission: z.object({ title: z.string().min(1).max(200), body: z.string().max(8000).optional() }).nullish(),
  objective: z.object({ title: z.string().min(1).max(200), body: z.string().max(8000).optional(), targetPaths: z.array(z.string()).max(20).optional(), priority: PRIORITY.optional() }).nullish(),
});

const AgentPatch = z.object({
  callsign: z.string().min(1).max(40).optional(),
  budgetUsd: z.number().positive().max(10_000).nullable().optional(),
  model: z.string().max(80).nullable().optional(),
  effort: EFFORT.nullable().optional(),
  permissionMode: MODE.optional(),
  patrolMinutes: z.number().min(5).max(24 * 60).nullable().optional(),
  reportsTo: z.string().nullable().optional(),
});

const ObjectiveIn = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(8000).optional(),
  assignee: z.string().nullish(),
  parent: z.string().nullish(),
  priority: PRIORITY.optional(),
  targetPaths: z.array(z.string()).max(20).optional(),
  model: z.string().max(80).nullish(),
  effort: EFFORT.nullish(),
});

const ObjectivePatchIn = z.object({
  status: STATUS.optional(),
  comment: z.string().max(8000).optional(),
  assignee: z.string().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(8000).optional(),
  priority: PRIORITY.optional(),
  targetPaths: z.array(z.string()).max(20).optional(),
  model: z.string().max(80).nullable().optional(),
  effort: EFFORT.nullable().optional(),
});

const Satellite = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  role: z.string().max(40).nullish(),
  model: z.string().max(80).nullish(),
  effort: EFFORT.nullish(),
  cron: z.string().max(120).nullish(),
  fireAt: z.number().int().positive().nullish(),
  enabled: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HqError(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export interface RouteDeps {
  config: WarRoomConfig;
  hq: HQ;
  store: Store;
  roles: Roles;
  scheduler: Scheduler;
  takeCommand: TakeCommand;
  team: TeamOps;
  ptys: PtyHost;
  orbit: Orbit;
  rescan: () => Promise<void>;
  recheck: () => Promise<CommsCheck>;
}

export function registerRoutes(route: Route, d: RouteDeps): void {
  const { hq, store } = d;

  route("GET", "/api/snapshot", () => hq.snapshot());

  // Agents
  route("POST", "/api/agents", ({ body }) => hq.deploy(parse(Deploy, body)));
  route("PATCH", "/api/agents/:id", ({ params, body }) => hq.updateAgent(params.id!, parse(AgentPatch, body)));
  route("POST", "/api/agents/:id/wake", ({ params, body }) => hq.wake(params.id!, typeof body.note === "string" ? body.note : undefined));
  route("POST", "/api/agents/:id/pause", ({ params }) => hq.pause(params.id!));
  route("POST", "/api/agents/:id/resume", ({ params }) => hq.resume(params.id!));
  route("POST", "/api/agents/:id/recall", ({ params }) => ({ recalled: hq.recall(params.id!) }));
  route("POST", "/api/agents/:id/dismiss", ({ params, body }) => hq.terminate(params.id!, { removeWorktree: body.removeWorktree === true }));
  route("POST", "/api/agents/:id/orders", ({ params, body }) => {
    const b = parse(z.object({ body: z.string().min(1).max(8000), objectiveId: z.string().nullish() }), body);
    // A teammate takes orders through its lead.
    const unit = d.team.unit(params.id!);
    if (unit) {
      if (!d.team.relay(unit.id, "Commander", b.body)) throw new HqError("That teammate's session has ended.", 409);
      store.comms(unit.theaterId, unit.teamLeadId, "radio", `Commander → ${unit.letter}·${unit.callsign} (via lead): ${b.body.slice(0, 80)}`);
      return { ok: true };
    }
    return hq.sendOrder({ to: params.id!, body: b.body, objectiveId: b.objectiveId ?? null, author: "commander" });
  });
  route("GET", "/api/agents/:id/files", ({ params }) => store.touchedFiles(d.team.unit(params.id!)?.id ?? hq.requireAgent(params.id!).id));

  route("GET", "/api/agents/:id/session", ({ params }) => {
    if (d.team.unit(params.id!)) return { sessionId: null, cwd: "", command: null };
    const a = hq.requireAgent(params.id!);
    const s = store.latestSession(a.id);
    // A live team session can't also be resumed elsewhere.
    const live = a.teamMode && d.team.isLive(a.id);
    return { sessionId: s?.sessionId ?? null, cwd: a.workspace.path, command: s && !live ? `cd ${shellQuote(a.workspace.path)} && claude --resume ${s.sessionId}` : null };
  });

  // TAKE COMMAND (for a team lead: open its live session)
  route("POST", "/api/agents/:id/command", ({ params, body }) => {
    const leadId = d.team.unit(params.id!)?.teamLeadId ?? params.id!;
    const a = hq.requireAgent(leadId);
    if (a.teamMode) {
      if (!d.ptys.has(a.id)) throw new HqError(d.config.demo ? "Demo teams have no terminal." : `${a.letter}·${a.callsign}'s team session isn't running. RESUME brings it back.`, 409);
      const size = parse(z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }), body);
      d.ptys.resize(a.id, size.cols, size.rows);
      return { ok: true, buffer: d.ptys.buffer(a.id), team: true };
    }
    if (a.external) throw new HqError("Watch-only units can't be commanded from here. Open them in their own terminal.");
    if (!d.takeCommand.available) throw new HqError("TAKE COMMAND needs the optional node-pty dependency.", 501);
    if (d.config.demo) throw new HqError("TAKE COMMAND is disabled in demo mode (no Claude sessions exist).");
    if (d.takeCommand.has(a.id)) return { ok: true, buffer: d.takeCommand.buffer(a.id) };
    if (d.scheduler.isActive(a.id)) throw new HqError(`${a.letter}·${a.callsign} is on a sortie. Recall it or wait for it to return.`, 409);
    const size = parse(z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }), body);
    const latest = store.latestSession(a.id);
    const session = latest && latest.cwd === a.workspace.path ? latest : null;
    let instructionsPath: string | null = null;
    if (!session) {
      const role = d.roles.get(a.role);
      if (role) {
        const dir = path.join(d.config.runDir, `take-${a.id}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        instructionsPath = path.join(dir, "instructions.md");
        const superior = a.reportsTo ? store.getAgent(a.reportsTo) : null;
        fs.writeFileSync(instructionsPath, buildInstructions(a, role, hq.theater, superior), { mode: 0o600 });
      }
    }
    const { sessionId } = d.takeCommand.start(a, { ...size, sessionId: session?.sessionId ?? null, instructionsPath, permissionMode: cliPermissionMode(permissionOverrideOf(store)) });
    if (!session) store.setSession(a.id, a.objectiveId ?? "standing", sessionId, a.workspace.path, 0);
    store.updateAgent(a.id, { status: "commanded" });
    store.setRuntime(a.id, { activity: "orders", activityDetail: "Under your command" });
    store.comms(a.theaterId, a.id, "command", `Commander took command of ${a.letter}·${a.callsign}`);
    return { ok: true, sessionId };
  });
  route("DELETE", "/api/agents/:id/command", ({ params }) => {
    if (d.team.unit(params.id!)) return { ok: true };
    const a = hq.requireAgent(params.id!);
    // Hiding a team's terminal leaves the session running.
    if (!a.teamMode) d.takeCommand.stop(a.id);
    return { ok: true };
  });

  // Missions & objectives
  route("POST", "/api/missions", ({ body }) => hq.launchMission(parse(z.object({ title: z.string().min(1).max(200), body: z.string().max(8000).optional() }), body)));
  route("POST", "/api/objectives", ({ body }) => hq.createObjective(parse(ObjectiveIn, body), "commander"));
  route("PATCH", "/api/objectives/:id", ({ params, body }) => hq.updateObjective(params.id!, parse(ObjectivePatchIn, body), "commander"));

  // Approvals
  route("POST", "/api/approvals/:id", ({ params, body }) => {
    const b = parse(z.object({ approved: z.boolean(), always: z.boolean().optional(), note: z.string().max(2000).nullish() }), body);
    return hq.decide(params.id!, b.approved, { always: b.always, note: b.note ?? null });
  });

  route("PATCH", "/api/settings", ({ body }) =>
    hq.updateSettings(
      parse(z.object({ supplyMode: z.enum(["budget", "usage"]).optional(), generalPicksModels: z.boolean().optional(), permissionMode: z.enum(["auto", "plan", "manual"]).optional() }), body),
    ),
  );

  // Satellites (scheduled tasks)
  route("POST", "/api/satellites", ({ body }) => d.orbit.create(parse(Satellite, body)));
  route("PATCH", "/api/satellites/:id", ({ params, body }) => d.orbit.update(params.id!, parse(Satellite.partial(), body)));
  route("DELETE", "/api/satellites/:id", ({ params }) => d.orbit.remove(params.id!));
  route("POST", "/api/satellites/:id/run", ({ params }) => d.orbit.runNow(params.id!));
  route("POST", "/api/satellites/:id/stop", ({ params }) => ({ stopped: d.orbit.stop(params.id!) }));
  route("POST", "/api/satellites/:id/pause", ({ params }) => d.orbit.pause(params.id!));
  route("POST", "/api/satellites/:id/resume", ({ params }) => d.orbit.resume(params.id!));

  // Map + comms
  route("POST", "/api/city/rescan", async () => {
    await d.rescan();
    return { ok: true };
  });
  route("POST", "/api/comms-check", () => d.recheck());
}

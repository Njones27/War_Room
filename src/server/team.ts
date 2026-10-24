// Team mode: a commander that runs as one live, interactive Claude Code
// session (a "team lead") and builds its own Claude Code agent team.
//
// Agent teams only work in interactive sessions, so War Room hosts the lead
// in a pseudo-terminal and follows it through HTTP hooks and its transcript:
// teammates appear on the map as squad members, their permission prompts
// come to the Commander, and orders are typed into the session.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CityModel } from "../shared/city.js";
import type { AgentView, TeamTask, TheaterView, WakeReason } from "../shared/protocol.js";
import { toRepoPath, toolActivity, type ToolActivity } from "./activity.js";
import { startDemoTeam, type DemoTeamHandle } from "./adapters/demoTeam.js";
import type { Approvals } from "./approvals.js";
import type { Bus } from "./bus.js";
import type { WarRoomConfig } from "./config.js";
import { SHELL_TOOLS, type Demolition } from "./demolition.js";
import { agentEnv } from "./env.js";
import { alwaysRuleFor, cliSafeRules, ruleMatches } from "./permissions.js";
import { buildInstructions, buildWakePrompt, formatLiveOrder } from "./prompts.js";
import type { PtyHost } from "./ptyHost.js";
import type { Roles } from "./roles.js";
import type { LiveSessions } from "./scheduler.js";
import type { Store } from "./store.js";
import { contentText } from "./streamParser.js";
import { describeToolCall, type Toolkit } from "./toolkit.js";
import { newToken, truncate } from "./util.js";
import { transcriptPath } from "./watch.js";

export interface TeamDeps {
  store: Store;
  bus: Bus;
  ptys: PtyHost;
  approvals: Approvals;
  roles: Roles;
  config: WarRoomConfig;
  theater: () => TheaterView;
  mcpUrl: () => string;
  hookUrl: (token: string) => string;
  authorName: (author: string) => string;
  /** The `--permission-mode` a session starts with (defaults to the lead's own). Teammates inherit it. */
  permissionMode?: () => string;
  /** Demo mode: scripted teams instead of real Claude Code sessions. */
  demo?: { toolkit: () => Toolkit; city: () => CityModel };
  /** Strikes buildings whose files the team's shell commands deleted. */
  demolition?: Demolition;
}

type Json = Record<string, unknown>;
type HookReply = Record<string, unknown>;

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Elicitation",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "SessionEnd",
];

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const firstLine = (text: string) => truncate(text.split("\n").find((l) => l.trim()) ?? "", 120);
/** A tool call across hooks (PermissionRequest carries no tool_use_id). */
const callKey = (body: Json): string => `${str(body.tool_name)} ${JSON.stringify(body.tool_input ?? null)}`;

/**
 * Text typed into a session can come from agents (radio messages, reports,
 * objective titles), so it must not carry terminal control: no escape
 * sequences (they could end the paste early or answer a dialog) and no
 * carriage returns (they would submit). A leading "!", "/" or "#" would switch
 * the TUI into shell, command or memory mode, so it's pushed off the start.
 */
export function terminalSafe(text: string): string {
  const safe = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return /^[!/#]/.test(safe) ? ` ${safe}` : safe;
}

const fileSize = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Reads the complete JSON lines appended to a file since the last read. */
class JsonlTail {
  private offset: number;

  /** `fromEnd`: skip what's already in the file (a resumed session's earlier conversation). */
  constructor(
    public file: string,
    fromEnd = false,
  ) {
    this.offset = fromEnd ? fileSize(file) : 0;
  }

  retarget(file: string, fromEnd: boolean): void {
    this.file = file;
    this.offset = fromEnd ? fileSize(file) : 0;
  }

  read(): Json[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size - this.offset, 8 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      const text = buf.toString("utf8");
      const nl = text.lastIndexOf("\n");
      if (nl < 0) return [];
      this.offset += Buffer.byteLength(text.slice(0, nl + 1));
      const out: Json[] = [];
      for (const line of text.slice(0, nl).split("\n")) {
        try {
          out.push(JSON.parse(line) as Json);
        } catch {
          /* partial or foreign line */
        }
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

interface Mate {
  name: string;
  /** Claude Code's agent_id for the teammate, once a hook reports it. */
  agentId: string | null;
  view: AgentView;
  tail: JsonlTail | null;
  usage: Map<string, number>;
}

interface Session {
  leadId: string;
  token: string;
  runId: string;
  sessionId: string;
  cwd: string;
  dir: string;
  tail: JsonlTail;
  usage: Map<string, number>;
  /** The TUI is up (a hook fired, or the watchdog found no prompt in the way). */
  ready: boolean;
  /** Any hook has arrived, so Claude Code is past its startup prompts. */
  heard: boolean;
  /** Started with --resume: its transcript already holds the earlier conversation. */
  resumed: boolean;
  outbox: string[];
  /**
   * Permission requests War Room hasn't answered yet from the lead or its
   * plain subagents ("" or their agent id), by approval id. Claude Code may
   * already show their prompts in its terminal (a teammate's waits for War
   * Room's answer), so nothing is typed until this is empty: the Enter would
   * answer the prompt.
   */
  asking: Map<string, { agent: string; call: string }>;
  /** A paste is in the prompt box, waiting for its Enter. */
  pasted: boolean;
  /** Claude Code gets a moment (after each paste and Enter, or a prompt closing) before the next keystroke. */
  breath: NodeJS.Timeout | null;
  /** Text War Room typed recently, so an echoed prompt isn't logged twice. */
  sent: string[];
  mates: Map<string, Mate>;
  tasks: Map<string, TeamTask>;
  grants: string[];
  subagents: Set<string>;
  startedAt: number;
  lastContextWrite: number;
  watchdog: NodeJS.Timeout | null;
  closing: boolean;
  demo: DemoTeamHandle | null;
}

export class TeamOps implements LiveSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, Session>();
  /** Wake notes for a held lead with no session, delivered when it next starts. */
  private readonly heldNotes = new Map<string, string[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: TeamDeps) {
    d.ptys.onExit((agentId) => this.ended(agentId));
  }

  start(): void {
    this.timer = setInterval(() => this.pollTranscripts(), 1500);
    this.timer.unref?.();
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) s.demo?.stop();
  }

  // ── LiveSessions (called by the scheduler) ────────────────────────────────

  handles(agent: AgentView): boolean {
    return agent.teamMode;
  }

  isLive(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  isRunLive(runId: string): boolean {
    for (const s of this.sessions.values()) if (s.runId === runId) return true;
    return false;
  }

  runForToken(token: string): { runId: string; agentId: string } | null {
    const s = this.byToken.get(token);
    return s ? { runId: s.runId, agentId: s.leadId } : null;
  }

  grant(agentId: string, rules: string[]): void {
    this.sessions.get(agentId)?.grants.push(...rules);
  }

  wake(agent: AgentView, reason: WakeReason, opts: { objectiveId?: string | null; note?: string | null }): void {
    const s = this.sessions.get(agent.id);
    if (!s) {
      if (reason === "timer") return;
      // A held lead stays down. Orders and objectives wait in the store; notes (such as a
      // model pick it's asked for) wait here until it starts again.
      if (agent.pausedReason === "commander") {
        if (opts.note) this.heldNotes.set(agent.id, [...(this.heldNotes.get(agent.id) ?? []), opts.note]);
        return;
      }
      this.launch(agent, [reason], opts, agent.status === "paused" ? (this.d.store.getSession(agent.id, "team")?.sessionId ?? null) : null);
      return;
    }
    const orders = this.d.store.undeliveredOrders(agent.id);
    this.d.store.markDelivered(
      orders.map((o) => o.id),
      s.runId,
    );
    const text = this.wakeText(agent, [reason], opts, orders);
    this.d.store.addFeed(agent.theaterId, { agentId: agent.id, runId: s.runId, kind: "prompt", text });
    this.type(s, text);
  }

  deliver(agentId: string, authorName: string, body: string): string | null {
    const s = this.sessions.get(agentId);
    if (!s) return null;
    this.type(s, formatLiveOrder(authorName, body));
    return s.runId;
  }

  /** RECALL: interrupt whatever the lead is doing (its teammates keep working). */
  recall(agentId: string): boolean {
    const s = this.sessions.get(agentId);
    if (!s) return false;
    if (s.demo) s.demo.interrupt();
    else this.d.ptys.write(agentId, "\x1b");
    return true;
  }

  // ── Commander actions ─────────────────────────────────────────────────────

  units(): AgentView[] {
    return [...this.sessions.values()].flatMap((s) => [...s.mates.values()].map((m) => ({ ...m.view })));
  }

  unit(id: string): AgentView | null {
    for (const s of this.sessions.values()) for (const m of s.mates.values()) if (m.view.id === id) return { ...m.view };
    return null;
  }

  /** Orders for a teammate go through its lead, who relays them with SendMessage. */
  relay(unitId: string, authorName: string, body: string): boolean {
    for (const s of this.sessions.values()) {
      for (const m of s.mates.values()) {
        if (m.view.id !== unitId) continue;
        this.type(s, `[WAR ROOM · ORDERS from ${authorName} for your teammate ${m.name}] ${body}\nRelay this to ${m.name} with SendMessage, word for word.`);
        this.d.store.addFeed(m.view.theaterId, { agentId: m.view.id, runId: s.runId, kind: "order", text: `${authorName}: ${body}` });
        return true;
      }
    }
    return false;
  }

  /** RESUME after the session ended: resume the lead's conversation. Teammates don't survive. */
  restart(agent: AgentView): void {
    if (this.sessions.has(agent.id)) return;
    this.launch(
      agent,
      ["manual"],
      { note: "War Room restarted your session. Teammates don't survive a restart: spawn new ones if you still need them." },
      this.d.store.getSession(agent.id, "team")?.sessionId ?? null,
    );
  }

  /** DISMISS: end the session; its in-process teammates end with it. */
  async stop(agentId: string): Promise<void> {
    const s = this.sessions.get(agentId);
    if (!s) return;
    s.closing = true;
    if (s.demo) {
      s.demo.stop();
      this.ended(agentId);
      return;
    }
    await this.d.ptys.exit(agentId, 8000);
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  private wakeText(agent: AgentView, reasons: WakeReason[], opts: { objectiveId?: string | null; note?: string | null }, orders = this.d.store.undeliveredOrders(agent.id)): string {
    const { store } = this.d;
    const theater = this.d.theater();
    const objective = (opts.objectiveId ? store.getObjective(opts.objectiveId) : null) ?? store.openObjectivesFor(agent.id)[0] ?? null;
    const mission = objective?.missionId ? store.getMission(objective.missionId) : store.activeMission(theater.id);
    const parent = objective?.parentId ? store.getObjective(objective.parentId) : null;
    return buildWakePrompt({
      agent,
      reasons,
      notes: opts.note ? [opts.note] : [],
      mission,
      objective,
      parent,
      orders,
      authorName: (a) => this.d.authorName(a),
      team: true,
    });
  }

  private settingsFile(token: string): string {
    const timeout = Math.ceil(this.d.config.approvalTimeoutMs / 1000) + 60;
    const hooks = Object.fromEntries(HOOK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: "http", url: this.d.hookUrl(token), timeout: ev === "PermissionRequest" ? timeout : 15 }] }]]));
    return JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }, hooks });
  }

  private launch(agent: AgentView, reasons: WakeReason[], opts: { objectiveId?: string | null; note?: string | null }, resumeId: string | null): void {
    const { store, config, ptys } = this.d;
    if (this.sessions.has(agent.id)) return;
    const theater = this.d.theater();
    const role = this.d.roles.get(agent.role);
    if (!role) return;
    const objective = (opts.objectiveId ? store.getObjective(opts.objectiveId) : null) ?? store.openObjectivesFor(agent.id)[0] ?? null;
    const notes = [...(this.heldNotes.get(agent.id) ?? []), ...(opts.note ? [opts.note] : [])];
    this.heldNotes.delete(agent.id);
    opts = { ...opts, note: notes.length ? notes.join("\n\n") : null };
    const run = store.createRun(theater.id, agent.id, objective?.id ?? null, reasons[0] ?? "manual");
    const token = newToken();
    const dir = path.join(config.runDir, `team-${agent.id}`);
    const sessionId = resumeId ?? randomUUID();
    const s: Session = {
      leadId: agent.id,
      token,
      runId: run.id,
      sessionId,
      cwd: agent.workspace.path,
      dir,
      tail: new JsonlTail(transcriptPath(agent.workspace.path, sessionId), resumeId !== null),
      usage: new Map(),
      ready: false,
      heard: false,
      resumed: resumeId !== null,
      outbox: [],
      asking: new Map(),
      pasted: false,
      breath: null,
      sent: [],
      mates: new Map(),
      tasks: new Map(),
      grants: [],
      subagents: new Set(),
      startedAt: Date.now(),
      lastContextWrite: 0,
      watchdog: null,
      closing: false,
      demo: null,
    };

    try {
      if (!fs.existsSync(agent.workspace.path)) throw new Error(`Workspace is missing: ${agent.workspace.path}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const superior = agent.reportsTo ? store.getAgent(agent.reportsTo) : null;
      const instructions = path.join(dir, "instructions.md");
      const mcpConfig = path.join(dir, "mcp.json");
      const settings = path.join(dir, "settings.json");
      fs.writeFileSync(instructions, buildInstructions(agent, role, theater, superior, "team"), { mode: 0o600 });
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { warroom: { type: "http", url: this.d.mcpUrl(), headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
      fs.writeFileSync(settings, this.settingsFile(token), { mode: 0o600 });

      // A fresh session starts on its orders; a resumed one gets them typed once it's up.
      const orders = store.undeliveredOrders(agent.id);
      const prompt = this.wakeText(agent, reasons, opts, orders);
      const args = resumeId ? ["--resume", resumeId] : [prompt, "--session-id", sessionId, "-n", `War Room · ${agent.letter} · ${agent.callsign} (team lead)`];
      args.push("--teammate-mode", "in-process", "--append-system-prompt-file", instructions, "--mcp-config", mcpConfig, "--settings", settings);
      const mode = this.d.permissionMode?.() ?? agent.permissionMode;
      args.push("--permission-mode", mode === "bypassPermissions" ? "default" : mode);
      if (role.mcp === "warroom") args.push("--strict-mcp-config");
      if (agent.model) args.push("--model", agent.model);
      if (agent.effort) args.push("--effort", agent.effort);
      // Variadic flags last. In-process teammates run under the lead's rules. AskUserQuestion
      // can't be answered on the map, and its dialog would catch the text War Room types.
      args.push("--disallowedTools", ...new Set([...role.disallowedTools, "AskUserQuestion"]));
      const allowed = cliSafeRules([...new Set([...role.allowedTools, ...agent.allowedTools])]);
      if (allowed.length) args.push("--allowedTools", ...allowed);

      this.sessions.set(agent.id, s);
      this.byToken.set(token, s);
      void this.d.demolition?.prime(agent.workspace.path);
      if (this.d.demo) {
        // Its transcripts live in the run dir, never in ~/.claude.
        s.tail.file = path.join(dir, "transcript", `${sessionId}.jsonl`);
        s.demo = startDemoTeam({
          leadId: agent.id,
          runId: run.id,
          cwd: agent.workspace.path,
          transcript: s.tail.file,
          sessionId,
          hook: (body) => this.hook(token, body, new AbortController().signal),
          store,
          toolkit: this.d.demo.toolkit(),
          city: this.d.demo.city,
        });
      } else {
        ptys.spawn(agent.id, {
          args,
          cwd: agent.workspace.path,
          cols: 140,
          rows: 40,
          env: agentEnv({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", WARROOM_AGENT_ID: agent.id, WARROOM_AGENT: `${agent.letter}·${agent.callsign}`, WARROOM_RUN_ID: run.id }),
        });
      }
      // Up and running: the orders in its prompt are delivered.
      store.markDelivered(
        orders.map((o) => o.id),
        run.id,
      );
      if (resumeId) s.outbox.push(prompt);
      else s.sent.push(prompt.trim());
      store.setSession(agent.id, "team", sessionId, agent.workspace.path, 0);
      store.updateRun(run.id, { status: "running", sessionId });
      store.updateAgent(agent.id, { status: "running", pausedReason: null });
      store.setRuntime(agent.id, { activity: "orders", activityDetail: resumeId ? "Rejoining the fight" : "Forming the team", objectiveId: objective?.id ?? null, target: objective?.targetPaths[0] ?? agent.target, subagents: 0, teamTasks: [] });
      store.addFeed(theater.id, { agentId: agent.id, runId: run.id, kind: "prompt", text: prompt });
      store.comms(theater.id, agent.id, "sortie", `${agent.letter}·${agent.callsign} ${resumeId ? "is back in command of" : "is forming"} a team${objective ? ` for #${objective.number}` : ""}`);
      if (!s.demo) {
        s.watchdog = setTimeout(() => this.checkStartup(s, false), 6000);
        s.watchdog.unref?.();
      }
    } catch (err) {
      this.sessions.delete(agent.id);
      this.byToken.delete(token);
      if (notes.length) this.heldNotes.set(agent.id, notes);
      store.updateRun(run.id, { status: "failed", endedAt: Date.now(), error: (err as Error).message });
      store.updateAgent(agent.id, { status: "paused", pausedReason: "session_ended" });
      store.setRuntime(agent.id, { activity: "error", activityDetail: truncate((err as Error).message, 120) });
      store.comms(theater.id, agent.id, "error", `${agent.letter}·${agent.callsign} couldn't start a team session: ${(err as Error).message}`);
    }
  }

  /**
   * No hook yet. Claude Code may be showing its folder-trust prompt (hooks
   * only run in trusted folders), or another startup prompt.
   */
  private checkStartup(s: Session, final: boolean): void {
    s.watchdog = null;
    if (s.heard || !this.sessions.has(s.leadId)) return;
    const lead = this.d.store.getAgent(s.leadId);
    if (!lead) return;
    // TUI text arrives with cursor moves instead of spaces, so compare without whitespace.
    const screen = stripAnsi(this.d.ptys.buffer(s.leadId)).replace(/\s+/g, "");
    const trust = /oneyoutrust|trustthisfolder|trustthefiles/i.test(screen);
    if (trust || final) {
      const what = trust ? "Claude Code asks whether to trust this folder" : "Claude Code is waiting on something in its terminal";
      this.d.store.setRuntime(s.leadId, { activity: "needs_you", activityDetail: `${what}. Open TERMINAL to answer.` });
      this.d.store.comms(lead.theaterId, lead.id, "permission", `${lead.letter}·${lead.callsign}: ${what}. Answer it in the TERMINAL tab.`);
      this.d.bus.emit({ t: "toast", level: "warn", text: `${lead.letter}·${lead.callsign}: ${what}. Open TERMINAL.` });
      return;
    }
    // Nothing in the way (a resumed session only speaks once spoken to): start typing.
    if (!s.ready) {
      s.ready = true;
      this.flush(s);
    }
    s.watchdog = setTimeout(() => this.checkStartup(s, true), 20_000);
    s.watchdog.unref?.();
  }

  // ── Typing into the session ───────────────────────────────────────────────

  private type(s: Session, text: string): void {
    s.outbox.push(text);
    this.flush(s);
  }

  /**
   * Types everything waiting as one bracketed paste (so newlines stay in the
   * message), then Enter. Each keystroke checks again for an open prompt, and
   * whatever is left waits until War Room has answered it.
   */
  private flush(s: Session): void {
    if (!s.ready || s.breath || s.asking.size || this.sessions.get(s.leadId) !== s) return;
    if (s.pasted) {
      s.pasted = false;
      this.d.ptys.write(s.leadId, "\r");
      this.breather(s, 250);
      return;
    }
    if (!s.outbox.length) return;
    const text = terminalSafe(s.outbox.splice(0).join("\n\n"));
    s.sent = [...s.sent.slice(-19), text.trim()];
    if (s.demo) {
      s.demo.send(text);
      return;
    }
    this.d.ptys.write(s.leadId, `\x1b[200~${text}\x1b[201~`);
    s.pasted = true;
    this.breather(s, 350);
  }

  /** Holds keystrokes for at least `ms`, then types what's waiting. */
  private breather(s: Session, ms: number): void {
    if (s.breath) clearTimeout(s.breath);
    s.breath = setTimeout(() => {
      s.breath = null;
      this.flush(s);
    }, ms);
  }

  /** War Room answered a request. Claude Code closes its prompt when the reply lands; then, if no other is open, typing goes on. */
  private answered(s: Session, id: string): void {
    if (s.asking.delete(id) && !s.asking.size) this.breather(s, 500);
  }

  /** That agent got past its prompt (or all of them) without War Room, so it was answered in the terminal: retire the card. */
  private retire(s: Session, agent: string, call?: string): void {
    for (const [id, a] of s.asking) {
      if (a.agent !== agent || (call !== undefined && a.call !== call)) continue;
      this.d.approvals.expire(id, "Answered in the terminal");
      if (call !== undefined) return;
    }
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────

  /** One hook call from a team session. null: unknown token. */
  async hook(token: string, body: Json, signal: AbortSignal): Promise<HookReply | null> {
    const s = this.byToken.get(token);
    if (!s) return null;
    const lead = this.d.store.getAgent(s.leadId);
    if (!lead || lead.status === "terminated") return {};
    const ev = str(body.hook_event_name);
    if (!s.heard) {
      s.heard = true;
      if (s.watchdog) clearTimeout(s.watchdog);
      s.watchdog = null;
      if (lead.activity === "needs_you" && !s.mates.size) this.d.store.setRuntime(lead.id, { activity: "orders", activityDetail: "Forming the team" });
    }
    if (!s.ready) {
      s.ready = true;
      this.breather(s, 600);
    }
    const claudeAgent = str(body.agent_id) || null;
    if (typeof body.transcript_path === "string" && body.transcript_path && body.transcript_path !== s.tail.file) s.tail.retarget(body.transcript_path, s.resumed);
    const mate = claudeAgent ? this.mateFor(s, lead, claudeAgent, str(body.agent_type)) : null;
    // A plain subagent's internals (not a teammate): keep the lead's posture, as sorties do.
    const foreign = claudeAgent !== null && mate === null;

    switch (ev) {
      case "UserPromptSubmit": {
        const prompt = str(body.prompt).trim();
        if (prompt && !s.sent.some((t) => t === prompt)) {
          this.d.store.addFeed(lead.theaterId, { agentId: lead.id, runId: s.runId, kind: "prompt", text: `(typed in the terminal) ${truncate(prompt, 2000)}` });
        }
        this.d.store.setRuntime(lead.id, { activity: "orders", activityDetail: "Receiving orders" });
        return {};
      }
      case "PreToolUse":
        if (!foreign) this.toolStart(s, lead, mate, body);
        return {};
      case "PostToolUse":
        if (!mate) this.retire(s, claudeAgent ?? "", callKey(body));
        if (!foreign) this.toolEnd(s, lead, mate, body);
        return {};
      case "PermissionRequest":
        return this.permission(s, lead, mate, body, signal);
      case "Elicitation": {
        // War Room can't show an MCP server's form, and an open one would catch the text it types.
        const unit = mate?.view ?? lead;
        this.d.store.comms(lead.theaterId, lead.id, "permission", `Declined ${str(body.mcp_server_name) || "an MCP server"}'s question for ${unit.letter}·${unit.callsign}: ${truncate(str(body.message), 100)}`);
        return { hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } };
      }
      case "Notification": {
        const kind = str(body.notification_type);
        if (kind === "permission_prompt" || kind === "agent_needs_input" || kind === "elicitation_dialog") {
          this.setPosture(lead, mate, { activity: "needs_you", activityDetail: truncate(str(body.message) || "Waiting for you in the terminal", 120) });
        }
        return {};
      }
      case "Stop": {
        // The lead's turn is over, so none of its own prompts is still open.
        if (!claudeAgent) this.retire(s, "");
        const running = (Array.isArray(body.background_tasks) ? body.background_tasks : []).filter((t) => obj(t).type === "teammate" && obj(t).status === "running").length;
        const last = firstLine(str(body.last_assistant_message));
        this.d.store.setRuntime(lead.id, { activity: "idle", activityDetail: running ? `Waiting on ${running} teammate${running === 1 ? "" : "s"}` : last || "Standing by" });
        return {};
      }
      case "SubagentStart":
        if (mate) this.setPosture(lead, mate, { status: "running", activity: "orders", activityDetail: "Reporting for duty" });
        else if (claudeAgent) {
          s.subagents.add(claudeAgent);
          this.d.store.setRuntime(lead.id, { subagents: s.subagents.size }, false);
        }
        return {};
      case "SubagentStop":
        if (claudeAgent && !mate) this.retire(s, claudeAgent);
        if (mate) {
          if (typeof body.agent_transcript_path === "string") mate.tail ??= new JsonlTail(body.agent_transcript_path);
          this.setPosture(lead, mate, { status: "idle", activity: "idle", activityDetail: firstLine(str(body.last_assistant_message)) || "Standing by" });
        } else if (claudeAgent && s.subagents.delete(claudeAgent)) this.d.store.setRuntime(lead.id, { subagents: s.subagents.size }, false);
        return {};
      case "TeammateIdle": {
        const m = mate ?? (str(body.teammate_name) ? s.mates.get(str(body.teammate_name)) : undefined);
        if (m) this.setPosture(lead, m, { status: "idle", activity: "idle", activityDetail: m.view.activityDetail ?? "Standing by" });
        return {};
      }
      case "TaskCreated": {
        const id = str(body.task_id);
        if (id) s.tasks.set(id, { id, subject: truncate(str(body.task_subject) || "Task", 160), owner: str(body.teammate_name) || null, status: "pending" });
        this.emitTasks(s);
        return {};
      }
      case "TaskCompleted": {
        const id = str(body.task_id);
        const task = s.tasks.get(id) ?? { id, subject: truncate(str(body.task_subject) || "Task", 160), owner: str(body.teammate_name) || null, status: "completed" as const };
        s.tasks.set(id, { ...task, status: "completed" });
        this.emitTasks(s);
        return {};
      }
      default:
        return {};
    }
  }

  /** The teammate behind a Claude Code agent id, joining it to the map on first sight. */
  private mateFor(s: Session, lead: AgentView, claudeAgent: string, agentType: string): Mate | null {
    for (const m of s.mates.values()) if (m.agentId === claudeAgent) return m;
    // Teammates' ids are "a<name>-<hex>" with agent_type = <name>; plain subagents are "a<hex>".
    if (!agentType || !claudeAgent.startsWith(`a${agentType}-`)) return null;
    const m = s.mates.get(agentType) ?? this.join(s, lead, agentType);
    m.agentId = claudeAgent;
    m.tail ??= new JsonlTail(path.join(path.dirname(s.tail.file), s.sessionId, "subagents", `agent-${claudeAgent}.jsonl`));
    return m;
  }

  private join(s: Session, lead: AgentView, name: string, brief?: { description?: string; model?: string; type?: string }): Mate {
    const existing = s.mates.get(name);
    if (existing) return existing;
    const now = Date.now();
    const view: AgentView = {
      id: `tm_${lead.id.replace(/^ag_/, "")}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      theaterId: lead.theaterId,
      letter: `${lead.letter}${s.mates.size + 1}`,
      callsign: name,
      role: "teammate",
      reportsTo: lead.id,
      status: "running",
      pausedReason: null,
      activity: "orders",
      activityDetail: brief?.description ? `Brief: ${truncate(brief.description, 100)}` : "Joining the team",
      target: lead.target,
      objectiveId: null,
      model: brief?.model ?? lead.model,
      effort: lead.effort,
      permissionMode: lead.permissionMode,
      allowedTools: [],
      budgetUsd: null,
      spentUsd: 0,
      tokensUsed: 0,
      contextTokens: 0,
      workspace: lead.workspace,
      subagents: 0,
      external: false,
      teamMode: false,
      teamLeadId: lead.id,
      teamTasks: [],
      sessionName: brief?.type ?? null,
      lastEventAt: now,
      createdAt: now,
    };
    const m: Mate = { name, agentId: null, view, tail: null, usage: new Map() };
    s.mates.set(name, m);
    this.d.store.comms(lead.theaterId, lead.id, "deploy", `${view.letter}·${name} joined ${lead.letter}·${lead.callsign}'s team`);
    this.d.bus.emit({ t: "agent", agent: { ...view } });
    return m;
  }

  private setPosture(lead: AgentView, mate: Mate | null, patch: Partial<Pick<AgentView, "status" | "activity" | "activityDetail" | "target">>): void {
    if (!mate) {
      const { status: _ignored, ...rt } = patch;
      this.d.store.setRuntime(lead.id, rt);
      return;
    }
    Object.assign(mate.view, patch, { lastEventAt: Date.now() });
    this.d.bus.emit({ t: "agent", agent: { ...mate.view } });
  }

  private emitTasks(s: Session): void {
    this.d.store.setRuntime(s.leadId, { teamTasks: [...s.tasks.values()] });
    for (const m of s.mates.values()) {
      const mine = [...s.tasks.values()].filter((t) => t.owner === m.name);
      if (JSON.stringify(mine) === JSON.stringify(m.view.teamTasks)) continue;
      m.view.teamTasks = mine;
      this.d.bus.emit({ t: "agent", agent: { ...m.view } });
    }
  }

  private toolStart(s: Session, lead: AgentView, mate: Mate | null, body: Json): void {
    const theater = this.d.theater();
    const tool = str(body.tool_name);
    const input = obj(body.tool_input);
    let act: ToolActivity = toolActivity(tool, input);
    if (tool === "Agent" && str(input.name)) act = { activity: "directing", detail: `Spawning teammate ${str(input.name)}`, rawPath: null };
    else if (tool === "SendMessage") act = { activity: mate ? "reporting" : "directing", detail: `Message to ${str(input.to) || str(input.recipient) || "the team"}`, rawPath: null };
    if (tool === "TaskUpdate") {
      const id = str(input.taskId) || str(input.task_id) || str(input.id);
      const t = s.tasks.get(id);
      const status = str(input.status);
      if (t) {
        s.tasks.set(id, { ...t, owner: str(input.owner) || t.owner, status: status === "in_progress" || status === "completed" || status === "pending" ? status : t.status });
        this.emitTasks(s);
      }
    }
    const target = toRepoPath(act.rawPath, str(body.cwd) || s.cwd, lead.workspace.path, theater.root);
    this.d.store.addFeed(theater.id, { agentId: mate?.view.id ?? lead.id, runId: s.runId, kind: "tool_use", text: act.detail, tool, toolUseId: str(body.tool_use_id), target });
    this.setPosture(lead, mate, { status: "running", activity: act.activity, activityDetail: act.detail, ...(target !== null ? { target } : {}) });
  }

  private toolEnd(s: Session, lead: AgentView, mate: Mate | null, body: Json): void {
    const tool = str(body.tool_name);
    if (SHELL_TOOLS.has(tool)) void this.d.demolition?.check(mate?.view ?? lead, lead.workspace.path);
    const response = body.tool_response;
    const r = obj(response);
    const spawned = tool === "Agent" && r.status === "teammate_spawned" ? str(obj(body.tool_input).name) : "";
    if (spawned) {
      const input = obj(body.tool_input);
      this.join(s, lead, spawned, { description: str(input.description), model: str(input.model) || undefined, type: str(input.subagent_type) || undefined });
    }
    // MCP tools answer with content blocks; show their text, not the wrapper.
    const text = spawned ? `Teammate ${spawned} spawned` : typeof response === "string" ? response : Array.isArray(response) ? contentText(response) : JSON.stringify(response ?? "");
    this.d.store.addFeed(lead.theaterId, { agentId: mate?.view.id ?? lead.id, runId: s.runId, kind: "tool_result", text: truncate(text, 1200), toolUseId: str(body.tool_use_id), isError: r.is_error === true || r.isError === true });
  }

  private async permission(s: Session, lead: AgentView, mate: Mate | null, body: Json, signal: AbortSignal): Promise<HookReply> {
    const tool = str(body.tool_name);
    const input = obj(body.tool_input);
    const reply = (decision: Json): HookReply => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    // The unchanged input as updatedInput: tools that insist on their own dialog (ExitPlanMode) take War Room's answer too.
    const allow = reply({ behavior: "allow", updatedInput: input });
    // War Room's ALWAYS rules and merge grants pre-approve, as they do for sorties.
    if ([...lead.allowedTools, ...s.grants].some((rule) => ruleMatches(rule, tool, input))) return allow;

    const unit = mate?.view ?? lead;
    const who = `${unit.letter}·${unit.callsign}`;
    const { label, detail } = describeToolCall(tool, input);
    const { approval, decision } = this.d.approvals.requestAndWait(
      {
        theaterId: lead.theaterId,
        kind: "tool_permission",
        agentId: unit.id,
        runId: s.runId,
        title: `${who} wants to ${label}`,
        detail,
        payload: { tool_name: tool, input, team: true, teammate: mate?.name ?? null, alwaysRule: alwaysRuleFor(tool, input) },
      },
      signal,
    );
    // The lead's (or a plain subagent's) prompt may already be drawn while War Room waits; a teammate's isn't until War Room answers.
    if (!mate) s.asking.set(approval.id, { agent: str(body.agent_id), call: callKey(body) });
    const previous = { activity: unit.activity, activityDetail: unit.activityDetail };
    this.setPosture(lead, mate, { activity: "needs_you", activityDetail: `Awaiting approval: ${label}` });
    this.d.store.comms(lead.theaterId, lead.id, "permission", `${who} requests permission to ${label}`);
    const d = await decision;
    this.answered(s, approval.id);
    this.setPosture(lead, mate, d.approved ? previous : { activity: "thinking", activityDetail: "Adapting" });
    if (d.approved) {
      if (d.always) {
        const rule = alwaysRuleFor(tool, input);
        const current = this.d.store.getAgent(lead.id);
        if (rule && current && !current.allowedTools.includes(rule)) this.d.store.updateAgent(lead.id, { allowedTools: [...current.allowedTools, rule] });
      }
      return allow;
    }
    return reply({
      behavior: "deny",
      message: d.expired
        ? "The Commander didn't answer in time. Continue without this action, or ask your lead."
        : `The Commander denied this.${d.note ? ` Note: ${d.note}` : ""} Adapt your approach; don't retry the same action.`,
    });
  }

  // ── Transcripts: text and token usage ─────────────────────────────────────

  private pollTranscripts(): void {
    for (const s of this.sessions.values()) {
      const lead = this.d.store.getAgent(s.leadId);
      if (!lead) continue;
      this.absorb(s, lead, null, s.tail.read(), s.usage);
      for (const m of s.mates.values()) if (m.tail) this.absorb(s, lead, m, m.tail.read(), m.usage);
    }
  }

  private absorb(s: Session, lead: AgentView, mate: Mate | null, lines: Json[], usage: Map<string, number>): void {
    let tokens = 0;
    let context = 0;
    for (const o of lines) {
      if (o.type !== "assistant") continue;
      const message = obj(o.message);
      const u = obj(message.usage);
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const id = str(message.id);
      if (id) {
        // One line per content block, each with the message's usage so far.
        const total = n("input_tokens") + n("output_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        const delta = total - (usage.get(id) ?? 0);
        if (delta > 0) {
          tokens += delta;
          usage.set(id, total);
        }
        const ctx = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if (ctx > 0) context = ctx;
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const b = obj(block);
        if (b.type !== "text" || !str(b.text).trim()) continue;
        this.d.store.addFeed(lead.theaterId, { agentId: mate?.view.id ?? lead.id, runId: s.runId, kind: "text", text: truncate(str(b.text), 6000) });
        this.setPosture(lead, mate, { activityDetail: firstLine(str(b.text)) });
      }
    }
    if (mate) {
      if (tokens > 0 || context > 0) {
        mate.view.tokensUsed += tokens;
        if (context > 0) mate.view.contextTokens = context;
        this.d.bus.emit({ t: "agent", agent: { ...mate.view } });
      }
      return;
    }
    if (tokens > 0) this.d.store.addTokens(lead.id, tokens);
    if (context > 0 && Date.now() - s.lastContextWrite > 4000) {
      s.lastContextWrite = Date.now();
      this.d.store.updateAgent(lead.id, { contextTokens: context });
    }
  }

  // ── Session end ───────────────────────────────────────────────────────────

  private ended(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    const { store } = this.d;
    this.pollTranscripts();
    this.sessions.delete(agentId);
    this.byToken.delete(s.token);
    if (s.watchdog) clearTimeout(s.watchdog);
    this.d.approvals.expireRun(s.runId);
    store.releaseCheckouts(s.runId);
    store.updateRun(s.runId, { status: s.closing ? "completed" : "failed", endedAt: Date.now(), error: s.closing ? null : "The team session exited" });
    for (const m of s.mates.values()) this.d.bus.emit({ t: "agent_removed", id: m.view.id });
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    // DISMISS ends the session on purpose; terminate() marks the lead and logs it.
    const lead = store.getAgent(agentId);
    if (!lead || lead.status === "terminated" || s.closing) return;
    store.updateAgent(agentId, { status: "paused", pausedReason: "session_ended" });
    store.setRuntime(agentId, { activity: "offline", activityDetail: "Session ended. RESUME brings the lead back.", subagents: 0 });
    store.comms(lead.theaterId, lead.id, "sortie_end", `${lead.letter}·${lead.callsign}'s team session ended`);
  }
}

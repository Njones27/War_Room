import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "../src/server/adapters/types.js";
import { Approvals } from "../src/server/approvals.js";
import { Bus } from "../src/server/bus.js";
import { parseArgs, PACKAGE_ROOT } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { cliPermissionMode, HQ, permissionOverrideOf, supplyModeOf } from "../src/server/hq.js";
import type { PtyHost, PtySpawn } from "../src/server/ptyHost.js";
import { layoutCity } from "../src/server/repo/layout.js";
import { buildTree } from "../src/server/repo/scan.js";
import { Roles } from "../src/server/roles.js";
import { Scheduler } from "../src/server/scheduler.js";
import { Store } from "../src/server/store.js";
import { TeamOps, terminalSafe } from "../src/server/team.js";
import type { AgentView, CommsCheck, ServerMsg, TheaterView } from "../src/shared/protocol.js";

/** Stands in for node-pty: records what War Room spawns and types. */
class FakePty {
  spawns: { key: string; opts: PtySpawn }[] = [];
  fail = false;
  written: string[] = [];
  private live = new Set<string>();
  private exits: ((key: string, code: number | null) => void)[] = [];
  available = true;
  onExit(fn: (key: string, code: number | null) => void) {
    this.exits.push(fn);
  }
  onData() {}
  spawn(key: string, opts: PtySpawn) {
    if (this.fail) throw new Error("spawn failed");
    this.spawns.push({ key, opts });
    this.live.add(key);
  }
  has(key: string) {
    return this.live.has(key);
  }
  buffer() {
    return "";
  }
  resize() {}
  write(key: string, data: string) {
    if (!this.live.has(key)) return false;
    this.written.push(data);
    return true;
  }
  async exit(key: string) {
    this.kill(key);
  }
  kill(key: string) {
    if (!this.live.delete(key)) return;
    for (const h of this.exits) h(key, 0);
  }
  stopAll() {}
}

const noAdapter: AgentAdapter = {
  name: "none",
  start: () => {
    throw new Error("team leads don't run sorties");
  },
};

describe("team mode", () => {
  let dir: string;
  let store: Store;
  let hq: HQ;
  let team: TeamOps;
  let pty: FakePty;
  let theater: TheaterView;
  let events: ServerMsg[];
  const signal = new AbortController().signal;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-team-"));
    const config = { ...parseArgs(["--home", dir]), projectRoot: dir, dbPath: ":memory:", runDir: path.join(dir, "run") };
    const bus = new Bus();
    events = [];
    bus.on((m) => events.push(m));
    store = new Store(await openDatabase(":memory:"), bus);
    theater = store.ensureTheater(dir, "test", false, null);
    const roles = new Roles(path.join(PACKAGE_ROOT, "roles"), dir);
    const approvals = new Approvals(store, 60_000);
    const comms: CommsCheck = { claudeFound: true, version: "x", loggedIn: true, authMethod: "claude.ai", subscription: "max", error: null, checkedAt: 0, rateLimit: null };
    const supplyMode = () => supplyModeOf(store, comms);
    const scheduler = new Scheduler({ store, bus, roles, adapter: noAdapter, approvals, config, theater: () => theater, mcpUrl: () => "http://127.0.0.1:1/mcp", supplyMode });
    pty = new FakePty();
    team = new TeamOps({
      store,
      bus,
      ptys: pty as unknown as PtyHost,
      approvals,
      roles,
      config,
      theater: () => theater,
      mcpUrl: () => "http://127.0.0.1:1/mcp",
      hookUrl: (token) => `http://127.0.0.1:1/hooks/${token}`,
      authorName: (a) => scheduler.authorName(a),
      permissionMode: () => cliPermissionMode(permissionOverrideOf(store)),
    });
    scheduler.attachLive(team);
    const city = layoutCity(buildTree([{ path: "src/app.ts", bytes: 1, lines: 1 }]), { name: "t", root: dir, fileCount: 1, truncated: false });
    hq = new HQ(store, bus, roles, scheduler, approvals, config, () => theater, {
      city: () => city,
      commsCheck: () => comms,
      fronts: () => [],
      externalAgents: () => [],
      teamUnits: () => team.units(),
      takeCommandAvailable: () => true,
      supplyMode,
      version: "test",
    });
    hq.attachTeam(team);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Deploy a team lead and return it with the hook token from its settings file. */
  async function deployLead(): Promise<{ lead: AgentView; token: string; hook: (body: Record<string, unknown>) => Promise<unknown> }> {
    const lead = await hq.deploy({ role: "general", teamMode: true, mission: { title: "Review the API", body: "Three reviewers." } });
    const args = pty.spawns.at(-1)!.opts.args;
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1]!, "utf8")) as { env: Record<string, string>; hooks: Record<string, { hooks: { url: string }[] }[]> };
    const token = settings.hooks.PreToolUse![0]!.hooks[0]!.url.split("/hooks/")[1]!;
    return { lead: store.getAgent(lead.id)!, token, hook: (body) => team.hook(token, { session_id: "s", cwd: dir, ...body }, signal) };
  }

  it("starts the lead as an interactive team session", async () => {
    const { lead } = await deployLead();
    const { args, env, cwd } = pty.spawns[0]!.opts;
    expect(args[0]).toContain("Review the API");
    expect(args).toEqual(expect.arrayContaining(["--teammate-mode", "in-process", "--session-id"]));
    // Claude Code's own default: auto mode (the PERMISSIONS switch), which teammates inherit.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args).not.toContain("-p");
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(cwd).toBe(lead.workspace.path);
    expect(lead).toMatchObject({ status: "running", teamMode: true, budgetUsd: null });
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1]!, "utf8")) as { env: Record<string, string>; hooks: Record<string, unknown> };
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(["PermissionRequest", "Elicitation", "TeammateIdle", "TaskCreated", "SubagentStart"]));
  });

  it("puts teammates on the map from hooks", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { name: "scout", description: "Map the API" }, tool_response: { status: "teammate_spawned" } });
    await hook({ hook_event_name: "SubagentStart", agent_id: "ascout-7130f25cf30e07c1", agent_type: "scout" });
    await hook({ hook_event_name: "PreToolUse", agent_id: "ascout-7130f25cf30e07c1", agent_type: "scout", tool_name: "Read", tool_input: { file_path: path.join(dir, "src/app.ts") } });
    // A plain subagent is the lead's business, not a teammate.
    await hook({ hook_event_name: "SubagentStart", agent_id: "a439ae4317e056bf2", agent_type: "" });

    const [scout] = team.units();
    expect(team.units()).toHaveLength(1);
    expect(scout).toMatchObject({ letter: `${lead.letter}1`, callsign: "scout", teamLeadId: lead.id, activity: "reading", target: "src/app.ts" });
    expect(store.touchedFiles(scout!.id)).toEqual([expect.objectContaining({ path: "src/app.ts" })]);
    expect(hq.snapshot().agents.map((a) => a.id)).toContain(scout!.id);

    await hook({ hook_event_name: "TeammateIdle", agent_id: "ascout-7130f25cf30e07c1", teammate_name: "scout", team_name: "session-1" });
    expect(team.units()[0]).toMatchObject({ status: "idle", activity: "idle" });
  });

  it("brings teammates' permission prompts to the map and answers the hook", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "SubagentStart", agent_id: "acritic-0123456789abcdef", agent_type: "critic" });
    const ask = { hook_event_name: "PermissionRequest", agent_id: "acritic-0123456789abcdef", agent_type: "critic", tool_name: "Bash", tool_input: { command: "npm test" } };

    const first = hook(ask);
    await vi.advanceTimersByTimeAsync(0);
    const approval = store.pendingApprovals(theater.id)[0]!;
    expect(approval).toMatchObject({ kind: "tool_permission", agentId: team.units()[0]!.id, payload: expect.objectContaining({ team: true, teammate: "critic" }) });
    hq.decide(approval.id, true, { always: true });
    expect(await first).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "npm test" } } } });
    // ALWAYS is stored on the lead and covers the whole team.
    expect(store.getAgent(lead.id)!.allowedTools).toContain("Bash(npm test)");
    expect(await hook(ask)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });

    const denied = hook({ ...ask, tool_input: { command: "rm -rf dist" } });
    await vi.advanceTimersByTimeAsync(0);
    hq.decide(store.pendingApprovals(theater.id)[0]!.id, false, { note: "not now" });
    expect(await denied).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny", message: expect.stringContaining("not now") } } });
  });

  it("keeps dialogs War Room can't answer out of the terminal", async () => {
    const { hook } = await deployLead();
    const args = pty.spawns[0]!.opts.args;
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toContain("AskUserQuestion");
    // An MCP server's question is declined instead of waiting on screen.
    expect(await hook({ hook_event_name: "Elicitation", mcp_server_name: "tracker", message: "Which project?", mode: "form" })).toEqual({ hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } });
    // Plan approval only takes a hook's answer that carries updatedInput.
    const plan = hook({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "1. Audit auth" } });
    await vi.advanceTimersByTimeAsync(0);
    hq.decide(store.pendingApprovals(theater.id)[0]!.id, true);
    expect(await plan).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow", updatedInput: { plan: "1. Audit auth" } } } });
  });

  it("types orders into the session and relays teammates' orders through the lead", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "SubagentStart", agent_id: "ascout-7130f25cf30e07c1", agent_type: "scout" });
    hq.sendOrder({ to: lead.id, body: "Focus on auth", author: "commander" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.written.join("")).toContain("[WAR ROOM · ORDERS from Commander] Focus on auth");
    expect(pty.written).toContain("\r");

    expect(team.relay(team.units()[0]!.id, "Commander", "Check the tests too")).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    // Multi-line text goes in as one bracketed paste.
    expect(pty.written.some((w) => w.startsWith("\x1b[200~") && w.includes("Relay this to scout"))).toBe(true);
  });

  it("holds typed messages while one of the lead's prompts may be on screen", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "SessionStart" });
    await hook({ hook_event_name: "SubagentStart", agent_id: "ascout-7130f25cf30e07c1", agent_type: "scout" });
    const typed = () => pty.written.join("");
    const order = async (body: string) => {
      hq.sendOrder({ to: lead.id, body, author: "commander" });
      await vi.advanceTimersByTimeAsync(2000);
    };
    const asks = (agentId: string) => store.pendingApprovals(theater.id).filter((a) => a.agentId === agentId);
    const ask = (command: string) => hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } });

    // A teammate's prompt isn't drawn until War Room answers it, so orders still go in.
    const mates = hook({ hook_event_name: "PermissionRequest", agent_id: "ascout-7130f25cf30e07c1", agent_type: "scout", tool_name: "Bash", tool_input: { command: "make" } });
    await order("First order");
    expect(typed()).toContain("First order");

    // Two of the lead's own requests at once. A parallel tool call, a teammate going idle (no agent_id
    // before Claude Code 2.1.290) and a prompt notification don't end the hold; answering both does.
    const one = ask("make install");
    const two = ask("make docs");
    await vi.advanceTimersByTimeAsync(0);
    const read = { tool_name: "Read", tool_input: { file_path: path.join(dir, "src/app.ts") } };
    await hook({ hook_event_name: "PreToolUse", ...read });
    await hook({ hook_event_name: "PostToolUse", ...read, tool_response: "ok" });
    await hook({ hook_event_name: "TeammateIdle", teammate_name: "scout" });
    await hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" });
    await order("Second order");
    await order("Third order");
    const [first, second] = asks(lead.id);
    hq.decide(first!.id, true);
    await one;
    await vi.advanceTimersByTimeAsync(2000);
    expect(typed()).not.toContain("Second order");
    hq.decide(second!.id, false);
    await two;
    await vi.advanceTimersByTimeAsync(2000);
    // What waited goes in as one paste.
    const pastes = pty.written.filter((w) => w.includes("Second order"));
    expect(pastes).toHaveLength(1);
    expect(pastes[0]).toContain("Third order");

    // A prompt answered in the terminal: the lead runs the tool, and War Room retires the card.
    const three = ask("make lint");
    await vi.advanceTimersByTimeAsync(0);
    const lint = asks(lead.id)[0]!;
    await order("Fourth order");
    expect(typed()).not.toContain("Fourth order");
    await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "make lint" }, tool_response: "ok" });
    await three;
    await vi.advanceTimersByTimeAsync(2000);
    expect(typed()).toContain("Fourth order");
    expect(store.getApproval(lint.id)).toMatchObject({ status: "expired" });

    // A prompt that opens between a paste and its Enter holds the Enter until it's answered.
    hq.sendOrder({ to: lead.id, body: "Fifth order", author: "commander" });
    expect(pty.written.at(-1)).toContain("Fifth order");
    const four = ask("make e2e");
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.written.at(-1)).toContain("Fifth order");
    // The lead's turn ends: none of its prompts can still be open.
    await hook({ hook_event_name: "Stop" });
    await four;
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.written.at(-1)).toBe("\r");

    hq.decide(asks(team.units()[0]!.id)[0]!.id, true);
    await mates;
  });

  it("gives Claude Code time to close an answered prompt, and holds for a plain subagent's prompt", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "SessionStart" });
    await vi.advanceTimersByTimeAsync(1000);
    const typed = () => pty.written.join("");

    const asked = hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "make" } });
    await vi.advanceTimersByTimeAsync(0);
    hq.decide(store.pendingApprovals(theater.id)[0]!.id, true);
    await asked;
    hq.sendOrder({ to: lead.id, body: "Right after", author: "commander" });
    expect(typed()).not.toContain("Right after");
    await vi.advanceTimersByTimeAsync(600);
    expect(typed()).toContain("Right after");

    // A plain subagent's prompt is drawn in the lead's terminal too; it's over when the subagent stops.
    const sub = { agent_id: "a439ae4317e056bf2", agent_type: "" };
    const subAsk = hook({ hook_event_name: "PermissionRequest", ...sub, tool_name: "Bash", tool_input: { command: "ls" } });
    await vi.advanceTimersByTimeAsync(0);
    hq.sendOrder({ to: lead.id, body: "After the subagent", author: "commander" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(typed()).not.toContain("After the subagent");
    await hook({ hook_event_name: "SubagentStop", ...sub });
    await subAsk;
    await vi.advanceTimersByTimeAsync(2000);
    expect(typed()).toContain("After the subagent");
  });

  it("keeps orders undelivered when a session can't start", async () => {
    const { lead } = await deployLead();
    pty.kill(lead.id);
    pty.fail = true;
    hq.sendOrder({ to: lead.id, body: "Try again", author: "commander" });
    expect(store.undeliveredOrders(lead.id).map((o) => o.body)).toEqual(["Try again"]);
  });

  it("strips terminal control from typed text", async () => {
    // An agent's radio message can't close the paste, press Enter, or start a shell command.
    expect(terminalSafe("ok\x1b[201~\r!rm -rf ~\x03")).toBe("ok[201~\n!rm -rf ~");
    expect(terminalSafe("!whoami")).toBe(" !whoami");
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "SessionStart" });
    hq.sendOrder({ to: lead.id, body: "status?\x1b[201~\r/exit", author: "commander" });
    await vi.advanceTimersByTimeAsync(2000);
    const pasted = pty.written.find((w) => w.includes("status?"))!;
    expect(pasted.startsWith("\x1b[200~") && pasted.endsWith("\x1b[201~")).toBe(true);
    expect(pasted.slice(6, -6)).not.toMatch(/[\x1b\r]/);
  });

  it("doesn't replay a resumed lead's earlier conversation", async () => {
    const { lead } = await deployLead();
    const transcript = path.join(dir, "lead.jsonl");
    const line = (id: string, text: string) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } } }) + "\n";
    fs.writeFileSync(transcript, line("m1", "earlier work"));
    pty.kill(lead.id);
    hq.resume(lead.id);
    const token = (() => {
      const args = pty.spawns.at(-1)!.opts.args;
      const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1]!, "utf8")) as { hooks: Record<string, { hooks: { url: string }[] }[]> };
      return settings.hooks.Stop![0]!.hooks[0]!.url.split("/hooks/")[1]!;
    })();
    await team.hook(token, { hook_event_name: "UserPromptSubmit", prompt: "x", transcript_path: transcript }, signal);
    fs.appendFileSync(transcript, line("m2", "new work"));
    (team as unknown as { pollTranscripts(): void }).pollTranscripts();
    const texts = events.flatMap((m) => (m.t === "feed" && m.item.kind === "text" ? [m.item.text] : []));
    expect(texts).toContain("new work");
    expect(texts).not.toContain("earlier work");
    expect(store.getAgent(lead.id)!.tokensUsed).toBe(150);
  });

  it("tracks the team's task list", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "TaskCreated", task_id: "1", task_subject: "Audit auth", teammate_name: "scout" });
    await hook({ hook_event_name: "TaskCompleted", task_id: "1", task_subject: "Audit auth" });
    expect(store.getAgent(lead.id)!.teamTasks).toEqual([{ id: "1", subject: "Audit auth", owner: "scout", status: "completed" }]);
  });

  it("clears the team when the session ends and resumes the lead", async () => {
    const { lead, hook } = await deployLead();
    await hook({ hook_event_name: "SubagentStart", agent_id: "ascout-7130f25cf30e07c1", agent_type: "scout" });
    const unitId = team.units()[0]!.id;
    pty.kill(lead.id);
    expect(team.units()).toEqual([]);
    expect(events.some((m) => m.t === "agent_removed" && m.id === unitId)).toBe(true);
    expect(store.getAgent(lead.id)).toMatchObject({ status: "paused", pausedReason: "session_ended" });
    expect(await hook({ hook_event_name: "Stop" })).toBeNull();

    hq.resume(lead.id);
    const args = pty.spawns.at(-1)!.opts.args;
    expect(args.slice(0, 2)).toEqual(["--resume", pty.spawns[0]!.opts.args[pty.spawns[0]!.opts.args.indexOf("--session-id") + 1]]);
    expect(store.getAgent(lead.id)!.status).toBe("running");
  });

  it("keeps a held lead's notes for its next session, and doesn't mark a dismissed lead as ended", async () => {
    const { lead } = await deployLead();
    const eng = await hq.deploy({ role: "engineer" });
    pty.kill(lead.id);
    hq.pause(lead.id);
    expect(store.getAgent(lead.id)).toMatchObject({ status: "paused", pausedReason: "commander" });
    // A restart keeps the HOLD.
    store.markInterruptedRuns(theater.id);
    expect(store.getAgent(lead.id)!.pausedReason).toBe("commander");

    hq.updateSettings({ generalPicksModels: true });
    hq.createObjective({ title: "Pick my model", assignee: eng.id }, "commander");
    expect(pty.spawns).toHaveLength(1);
    hq.resume(lead.id);
    await vi.advanceTimersByTimeAsync(8000);
    expect(pty.written.join("")).toContain("choose its model and effort");

    events.length = 0;
    await hq.terminate(lead.id);
    const comms = events.flatMap((m) => (m.t === "comms" ? [m.entry.text] : []));
    expect(comms.some((t) => /session ended/.test(t))).toBe(false);
    expect(comms.some((t) => /dismissed/.test(t))).toBe(true);
  });

  it("refuses team mode for agents with a superior", async () => {
    const general = await hq.deploy({ role: "general" });
    await expect(hq.deploy({ role: "engineer", reportsTo: general.id, teamMode: true })).rejects.toThrow(/top-level/);
  });
});

// Demo team: a scripted Claude Code agent team for demo mode. It feeds the
// same hook handler and transcript files a live team session does, so the
// map, roster, approvals and task list behave as they would for real, without
// any Claude usage.
import fs from "node:fs";
import path from "node:path";
import type { CityModel } from "../../shared/city.js";
import type { Store } from "../store.js";
import type { Toolkit } from "../toolkit.js";
import { hash01, prng, sleep, truncate } from "../util.js";

export interface DemoTeamContext {
  leadId: string;
  runId: string;
  cwd: string;
  /** The lead's transcript file; teammates' sit under <dir>/<session>/subagents/. */
  transcript: string;
  sessionId: string;
  hook: (body: Record<string, unknown>) => Promise<unknown>;
  store: Store;
  toolkit: Toolkit;
  city: () => CityModel;
}

export interface DemoTeamHandle {
  send(text: string): void;
  interrupt(): void;
  stop(): void;
}

const SQUAD = [
  { name: "scout", brief: "Map the code paths the objective touches", task: "Survey the affected modules" },
  { name: "sapper", brief: "Make the change in the files scout flags", task: "Implement the change" },
  { name: "critic", brief: "Review the change and run the tests", task: "Review and verify" },
];

export function startDemoTeam(ctx: DemoTeamContext): DemoTeamHandle {
  let stopped = false;
  let busy = false;
  const inbox: string[] = [];
  const rnd = prng(Math.floor(hash01(ctx.runId) * 2 ** 31));
  const pause = (lo = 600, hi = 1800) => sleep(lo + rnd() * (hi - lo));
  const caller = { agentId: ctx.leadId, runId: ctx.runId };
  const ids = new Map(SQUAD.map((m) => [m.name, `a${m.name}-${Math.floor(rnd() * 2 ** 48).toString(16).padStart(16, "0")}`]));
  let seq = 0;
  let round = 0;

  const hook = (body: Record<string, unknown>) => (stopped ? Promise.resolve(null) : ctx.hook({ session_id: ctx.sessionId, transcript_path: ctx.transcript, cwd: ctx.cwd, ...body }));
  const write = (file: string, text: string) => {
    if (stopped) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const usage = { input_tokens: Math.round(200 + rnd() * 1500), output_tokens: Math.round(80 + rnd() * 700), cache_read_input_tokens: Math.round(4000 + rnd() * 30000), cache_creation_input_tokens: Math.round(rnd() * 3000) };
    fs.appendFileSync(file, JSON.stringify({ type: "assistant", message: { id: `msg_demo_${ctx.runId}_${seq++}`, content: [{ type: "text", text }], usage } }) + "\n");
  };
  const mateFile = (name: string) => path.join(path.dirname(ctx.transcript), ctx.sessionId, "subagents", `agent-${ids.get(name)}.jsonl`);
  const say = (text: string) => write(ctx.transcript, text);

  const tool = async (who: string | null, name: string, input: Record<string, unknown>, run?: () => unknown) => {
    if (stopped) return null;
    const agent = who ? { agent_id: ids.get(who), agent_type: who } : {};
    const id = `toolu_demo_${seq++}`;
    await hook({ hook_event_name: "PreToolUse", ...agent, tool_name: name, tool_input: input, tool_use_id: id });
    await pause(500, 1400);
    let value: unknown = "ok";
    try {
      value = run ? await run() : "ok";
    } catch (err) {
      value = (err as Error).message;
    }
    await hook({ hook_event_name: "PostToolUse", ...agent, tool_name: name, tool_input: input, tool_use_id: id, tool_response: value });
    return value;
  };

  const files = (prefix: string | null, n: number): string[] => {
    const real = ctx.city().buildings.filter((b) => !b.path.startsWith("@"));
    const pool = real.filter((b) => b.cluster <= 1 && (!prefix || b.path.startsWith(prefix.replace(/\/?$/, "/")) || b.district === prefix));
    const src = pool.length ? pool : real;
    return [...new Set(Array.from({ length: n }, () => src[Math.floor(rnd() * src.length)]?.path).filter((p): p is string => Boolean(p)))];
  };
  const abs = (p: string) => path.join(ctx.cwd, p);

  const teammate = async (m: (typeof SQUAD)[number], taskId: string, area: string | null) => {
    const file = mateFile(m.name);
    await hook({ hook_event_name: "SubagentStart", agent_id: ids.get(m.name), agent_type: m.name });
    await tool(m.name, "TaskUpdate", { taskId, status: "in_progress", owner: m.name });
    write(file, `On it: ${m.brief.toLowerCase()}.`);
    for (const f of files(area, 2 + Math.floor(rnd() * 2))) await tool(m.name, "Read", { file_path: abs(f) });
    await tool(m.name, "Grep", { pattern: m.name === "critic" ? "describe\\(|it\\(" : "TODO|FIXME", path: abs(area ?? ".") }, () => `${1 + Math.floor(rnd() * 8)} matches`);
    if (m.name === "sapper") {
      for (const f of files(area, 1 + Math.floor(rnd() * 2))) await tool(m.name, "Edit", { file_path: abs(f), old_string: "…", new_string: "…" });
    }
    if (m.name === "critic") {
      // Commands still come to the Commander; the demo autopilot answers if nobody does.
      const answer = await hook({ hook_event_name: "PermissionRequest", agent_id: ids.get(m.name), agent_type: m.name, tool_name: "Bash", tool_input: { command: "npm test", description: "Run the test suite" } });
      const allowed = JSON.stringify(answer ?? {}).includes('"allow"');
      if (allowed) await tool(m.name, "Bash", { command: "npm test" }, () => "✓ 42 passed");
      write(file, allowed ? "Tests pass (42). The change looks right." : "Couldn't run the tests (denied); review only.");
    }
    const report = m.name === "scout" ? "Mapped the entry points; flagged two files for sapper." : m.name === "sapper" ? "Change made and self-checked." : "Reviewed sapper's change; suite green.";
    write(file, report);
    await tool(m.name, "SendMessage", { to: "team-lead", message: report });
    await hook({ hook_event_name: "TaskCompleted", task_id: taskId, task_subject: m.task, teammate_name: m.name });
    await hook({ hook_event_name: "SubagentStop", agent_id: ids.get(m.name), agent_type: m.name, agent_transcript_path: file, last_assistant_message: report });
    await hook({ hook_event_name: "TeammateIdle", agent_id: ids.get(m.name), agent_type: m.name, teammate_name: m.name, team_name: `session-${ctx.sessionId.slice(0, 8)}` });
  };

  const operation = async () => {
    const kit = ctx.toolkit;
    const objective = kit.openFor(ctx.leadId)[0] ?? null;
    await tool(null, "mcp__warroom__my_orders", {}, () => kit.myOrders(caller));
    if (!objective) {
      say("No open objective. Standing by for orders.");
      await hook({ hook_event_name: "Stop", last_assistant_message: "Standing by for orders.", background_tasks: [] });
      return;
    }
    round++;
    await tool(null, "mcp__warroom__checkout_objective", { objective: `#${objective.number}` }, () => kit.checkout(caller, `#${objective.number}`));
    say(`Objective #${objective.number}: ${objective.title}. Splitting it three ways: scout maps, sapper builds, critic verifies.`);
    const area = objective.targetPaths[0] ?? ctx.city().districts.find((d) => d.path)?.path ?? null;
    for (const f of files(area, 2)) await tool(null, "Read", { file_path: abs(f) });
    const taskIds: string[] = [];
    for (const m of SQUAD) {
      const taskId = `${round}-${m.name}`;
      taskIds.push(taskId);
      await tool(null, "TaskCreate", { subject: m.task, description: m.brief });
      await hook({ hook_event_name: "TaskCreated", task_id: taskId, task_subject: m.task, task_description: m.brief, teammate_name: m.name });
    }
    for (const m of SQUAD) {
      await tool(null, "Agent", { name: m.name, description: m.brief, prompt: `${m.brief} for #${objective.number}.` }, () => ({ status: "teammate_spawned", name: m.name }));
      await pause(300, 700);
    }
    say("Team is moving. Waiting on reports.");
    const working = Promise.all(SQUAD.map((m, i) => sleep(i * 1500).then(() => teammate(m, taskIds[i]!, area))));
    await hook({ hook_event_name: "Stop", last_assistant_message: "Team is moving. Waiting on reports.", background_tasks: SQUAD.map((m) => ({ type: "teammate", status: "running", description: m.brief })) });
    await working;
    if (stopped) return;
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "(teammate reports)" });
    say("All three reports are in. Verified on our branch; closing the objective.");
    await tool(null, "mcp__warroom__update_objective", { objective: `#${objective.number}`, status: "done" }, () =>
      kit.update(caller, { objective: `#${objective.number}`, status: "done", comment: "Team of three: mapped, changed and verified (42 tests pass)." }),
    );
    await tool(null, "mcp__warroom__report", { text: "Objective secured." }, () => kit.report(caller, { text: `#${objective.number} secured by the team: scout mapped, sapper built, critic verified.` }));
    await hook({ hook_event_name: "Stop", last_assistant_message: "Objective secured. Standing by.", background_tasks: [] });
  };

  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      await operation();
      while (inbox.length && !stopped) {
        const text = inbox.shift()!;
        await hook({ hook_event_name: "UserPromptSubmit", prompt: text });
        await pause();
        if (ctx.toolkit.openFor(ctx.leadId).length && /objective|mission|assigned/i.test(text)) await operation();
        else {
          say(`Copy that: "${truncate(text.replace(/^\[WAR ROOM[^\]]*\]\s*/, ""), 80)}". Passing it to the team.`);
          await hook({ hook_event_name: "Stop", last_assistant_message: "Copy that.", background_tasks: [] });
        }
      }
    } finally {
      busy = false;
    }
  };

  void (async () => {
    await sleep(600);
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await loop();
  })();

  return {
    send(text: string) {
      if (stopped) return;
      inbox.push(text);
      void loop();
    },
    interrupt() {
      say("Interrupted. Holding.");
    },
    stop() {
      stopped = true;
    },
  };
}

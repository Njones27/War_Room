// Demo adapter: simulates Claude Code sorties so War Room can be explored,
// screenshotted and developed without spending any Claude usage. It drives
// the real control plane (objectives, approvals, reports) through the same
// toolkit the MCP server uses.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CityModel } from "../../shared/city.js";
import type { AgentView, ObjectiveView } from "../../shared/protocol.js";
import type { StreamEvent } from "../streamParser.js";
import type { Store } from "../store.js";
import type { Toolkit } from "../toolkit.js";
import { hash01, prng, sleep, truncate } from "../util.js";
import type { AgentAdapter, RunContext, RunHandle, RunHooks } from "./types.js";

interface DemoDeps {
  store: Store;
  toolkit: () => Toolkit;
  city: () => CityModel;
}

const TASKS: Record<string, { title: string; body: string }[]> = {
  recon: [
    { title: "Map the entry points and data flow", body: "Find where requests enter, how state moves, and which files matter most." },
    { title: "Survey the test coverage", body: "List what is tested, what isn't, and the riskiest gaps." },
  ],
  engineer: [
    { title: "Harden input validation on the API surface", body: "Validate and bound every external input. Keep behavior the same for valid input." },
    { title: "Refactor the largest module into smaller units", body: "Split responsibilities without changing behavior; keep the public API." },
  ],
  medic: [
    { title: "Add regression tests for the riskiest paths", body: "Cover the edge cases Recon flagged; make the suite green." },
  ],
  security: [
    { title: "Audit auth, secrets and dependency risk", body: "Report exploitable findings with severity and fixes." },
  ],
  support: [{ title: "Speed up the build and pin tooling versions", body: "Cut build time and make installs reproducible." }],
};

const sessionCost = new Map<string, number>();

/** The demo General's model picks, by the kind of work. */
const PICKS: Record<string, { model: string; effort: string }> = {
  recon: { model: "haiku", effort: "low" },
  engineer: { model: "sonnet", effort: "medium" },
  medic: { model: "sonnet", effort: "medium" },
  security: { model: "opus", effort: "high" },
  support: { model: "haiku", effort: "medium" },
};

export function createDemoAdapter(deps: DemoDeps): AgentAdapter {
  return {
    name: "demo",
    start(ctx: RunContext, hooks: RunHooks): RunHandle {
      let stopped = false;
      const inbox: string[] = [];
      const emit = (ev: StreamEvent) => !stopped && hooks.onEvent(ev);
      const sessionId = ctx.resumeSessionId ?? randomUUID();
      const rnd = prng(Math.floor(hash01(ctx.runId) * 2 ** 31));
      const caller = { agentId: ctx.agentId, runId: ctx.runId };
      const kit = deps.toolkit();
      const pause = (lo = 700, hi = 2100) => sleep(lo + rnd() * (hi - lo));
      let toolSeq = 0;

      const tool = async (name: string, input: Record<string, unknown>, run?: () => unknown | Promise<unknown>) => {
        if (stopped) return null;
        const id = `toolu_demo_${ctx.runId}_${toolSeq++}`;
        emit({ kind: "tool_use", id, name, input, parentToolUseId: null });
        await pause(500, 1500);
        let text = "ok";
        let isError = false;
        let value: unknown = null;
        try {
          value = run ? await run() : null;
          text = value === null || value === undefined ? "ok" : typeof value === "string" ? value : JSON.stringify(value);
        } catch (err) {
          text = (err as Error).message;
          isError = true;
        }
        emit({ kind: "tool_result", toolUseId: id, text: truncate(text, 1200), isError, parentToolUseId: null });
        return value;
      };
      const say = (text: string) => emit({ kind: "text", text, parentToolUseId: null });
      const abs = (p: string) => path.join(ctx.cwd, p);

      const files = (prefix: string | null, n: number): string[] => {
        const real = deps.city().buildings.filter((b) => !b.path.startsWith("@"));
        const pool = real.filter((b) => b.cluster <= 1 && (!prefix || b.path === prefix || b.path.startsWith(prefix.replace(/\/?$/, "/")) || b.district === prefix));
        const src = pool.length ? pool : real;
        const picks: string[] = [];
        for (let i = 0; i < n && src.length; i++) picks.push(src[Math.floor(rnd() * src.length)]!.path);
        return [...new Set(picks)];
      };
      const districtOf = (o: ObjectiveView | null) => o?.targetPaths[0] ?? null;

      const generalSortie = async (me: AgentView) => {
        const root = kit.openFor(me.id)[0] ?? null;
        say("Assessing the theater. Recon first, then we commit forces.");
        await tool("mcp__warroom__my_orders", {}, () => kit.myOrders(caller));
        if (root) await tool("mcp__warroom__checkout_objective", { objective: `#${root.number}` }, () => kit.checkout(caller, `#${root.number}`));
        for (const f of files(null, 2)) await tool("Read", { file_path: abs(f) }, () => `(${f})`);
        await tool("Glob", { pattern: "**/*" }, () => `${deps.city().fileCount} files`);

        const squad = deps.store.listAgents(me.theaterId).filter((a) => a.id !== me.id);
        const haveRoles = new Set(squad.map((a) => a.role));
        if (!haveRoles.has("support") && !deps.store.hasPendingApproval(me.id, "reinforcements") && rnd() < 0.7) {
          await tool("mcp__warroom__request_reinforcements", { role: "support", reason: "The build needs a logistics specialist." }, () =>
            kit.requestReinforcements(caller, { role: "support", reason: "The build needs a logistics specialist." }),
          );
        }
        // With General picks on: release objectives waiting on a model choice.
        const orders = kit.myOrders(caller);
        for (const w of orders.modelPicks?.waiting ?? []) {
          const assignee = w.assignee === "unassigned" ? null : squad.find((a) => w.assignee.includes(a.callsign));
          const pick = PICKS[assignee?.role ?? ""] ?? { model: "sonnet", effort: "medium" };
          await tool("mcp__warroom__update_objective", { objective: w.ref, ...pick }, () => kit.update(caller, { objective: w.ref, ...pick }));
        }
        const picking = Boolean(orders.modelPicks);
        const districts = deps.city().districts.filter((d) => d.path);
        // A demo mission is two waves of tasking, then the General closes it out.
        const waves = root ? deps.store.childrenOf(root.id).length : 0;
        const squadSize = squad.filter((a) => !a.external).length || 1;
        for (const a of waves >= squadSize * 2 ? [] : squad) {
          // Team leads run their own show.
          if (a.external || a.teamMode || kit.openFor(a.id).length) continue;
          const options = TASKS[a.role] ?? [{ title: "Hold the line", body: "Support the squad." }];
          const task = options[Math.floor(rnd() * options.length)]!;
          const target = districts.length ? districts[Math.floor(rnd() * districts.length)]!.path : "";
          const pick = picking ? (PICKS[a.role] ?? { model: "sonnet", effort: "medium" }) : {};
          await tool("mcp__warroom__create_objective", { title: task.title, assignee: a.letter, targetPaths: target ? [target] : [], ...pick }, () =>
            kit.create(caller, { title: task.title, body: task.body, assignee: a.letter, parent: root ? `#${root.number}` : undefined, targetPaths: target ? [target] : [], ...pick }),
          );
          await pause(300, 900);
        }

        // Review delegated work that's waiting on us.
        if (root) {
          const children = deps.store.childrenOf(root.id);
          for (const c of children.filter((c) => c.status === "in_review")) {
            await tool("Bash", { command: `git log --oneline -5 ${deps.store.getAgent(c.assigneeId ?? "")?.workspace.branch ?? ""}` }, () => "a1b2c3d feat: objective work");
            await tool("mcp__warroom__update_objective", { objective: `#${c.number}`, status: "done" }, () =>
              kit.update(caller, { objective: `#${c.number}`, status: "done", comment: "Reviewed: approved and merged." }),
            );
          }
          const after = deps.store.childrenOf(root.id);
          if (after.length && after.every((c) => c.status === "done" || c.status === "cancelled")) {
            await tool("mcp__warroom__update_objective", { objective: `#${root.number}`, status: "done" }, () =>
              kit.update(caller, { objective: `#${root.number}`, status: "done", comment: "All objectives secured. Mission accomplished." }),
            );
          }
        }
        await tool("mcp__warroom__report", { text: "Squad tasked." }, () =>
          kit.report(caller, { text: `${squad.filter((a) => !a.external).length} units tasked. Recon is mapping the terrain; engineers stand ready.` }),
        );
        say("Orders issued. Holding at HQ until the squad reports.");
      };

      const soldierSortie = async (me: AgentView) => {
        const objective = kit.openFor(me.id)[0] ?? null;
        await tool("mcp__warroom__my_orders", {}, () => kit.myOrders(caller));
        if (!objective) {
          say("No objectives assigned. Reporting ready for tasking.");
          await tool("mcp__warroom__report", { text: "Ready" }, () => kit.report(caller, { text: `${me.letter}·${me.callsign} ready for tasking.` }));
          return;
        }
        await tool("mcp__warroom__checkout_objective", { objective: `#${objective.number}` }, () => kit.checkout(caller, `#${objective.number}`));
        say(`Moving on objective #${objective.number}: ${objective.title}.`);
        const area = districtOf(objective);
        for (const f of files(area, 2 + Math.floor(rnd() * 3))) await tool("Read", { file_path: abs(f) }, () => `(${f})`);
        await tool("Grep", { pattern: me.role === "security" ? "token|secret|password" : "TODO|FIXME", path: abs(area ?? ".") }, () => `${2 + Math.floor(rnd() * 9)} matches`);

        let final: "in_review" | "done" = "in_review";
        let comment = "";
        switch (me.role) {
          case "engineer":
          case "support": {
            for (const f of files(area, 1 + Math.floor(rnd() * 2))) {
              await tool("Edit", { file_path: abs(f), old_string: "…", new_string: "…" }, () => `Updated ${f}`);
            }
            const cmd = me.role === "support" ? "npm run build" : "npm test";
            const verdict = await kit.permission(caller, { tool_name: "Bash", input: { command: cmd, description: "Verify the change" } });
            if (verdict.behavior === "allow") await tool("Bash", { command: cmd }, () => "✓ 42 passed");
            else say("Verification denied. Reporting the change unverified.");
            comment = `Change made on \`${me.workspace.branch ?? "main"}\`; ${verdict.behavior === "allow" ? "verified with " + cmd : "not verified (denied)"}.`;
            break;
          }
          case "medic": {
            const [f] = files(area, 1);
            if (f) await tool("Write", { file_path: abs(f.replace(/(\.[a-z]+)$/i, ".test$1")) }, () => "Created test file");
            await tool("Bash", { command: "npx vitest run" }, () => "Tests 18 passed (18)");
            comment = "Added regression tests; suite green (18 passed).";
            break;
          }
          case "security": {
            await tool("Bash", { command: "npm audit --omit=dev" }, () => "found 0 vulnerabilities");
            final = "done";
            comment = "No exploitable findings at high severity. One medium: tokens logged at debug level (see report).";
            break;
          }
          default: {
            await tool("WebSearch", { query: "best practices for this stack" }, () => "5 results");
            final = "done";
            comment = "Intel: entry points and key modules mapped; see target files.";
          }
        }
        await tool("mcp__warroom__update_objective", { objective: `#${objective.number}`, status: final }, () =>
          kit.update(caller, { objective: `#${objective.number}`, status: final, comment }),
        );
        say(`Objective #${objective.number} ${final === "done" ? "secured" : "ready for review"}.`);
      };

      const finish = (code: number) => {
        const prev = sessionCost.get(sessionId) ?? 0;
        const total = prev + 0.03 + rnd() * 0.18;
        sessionCost.set(sessionId, total);
        hooks.onEvent({
          kind: "result",
          subtype: "success",
          isError: false,
          totalCostUsd: total,
          numTurns: 3 + Math.floor(rnd() * 6),
          durationMs: 0,
          resultText: "Sortie complete.",
          usage: { input: Math.round(600 + rnd() * 2400), output: Math.round(150 + rnd() * 1200), cacheRead: Math.round(6000 + rnd() * 48000), cacheCreation: Math.round(rnd() * 4000) },
          sessionId,
        });
        setTimeout(() => hooks.onExit({ code, signal: null, stderrTail: "" }), 200);
      };

      void (async () => {
        await sleep(300);
        hooks.onEvent({ kind: "init", sessionId, model: "demo", tools: [], mcpServers: [], permissionMode: ctx.permissionMode, cwd: ctx.cwd });
        hooks.onEvent({ kind: "replay", text: ctx.prompt });
        emit({ kind: "thinking", parentToolUseId: null });
        await pause();
        const me = deps.store.getAgent(ctx.agentId);
        try {
          if (me) await (me.role === "general" || me.reportsTo === null ? generalSortie(me) : soldierSortie(me));
          while (inbox.length && !stopped) {
            const order = inbox.shift()!;
            say(`Copy that: "${truncate(order.replace(/^\[WAR ROOM · ORDERS from [^\]]+\]\s*/, ""), 80)}". Adjusting.`);
            await pause();
          }
        } catch (err) {
          emit({ kind: "error", text: (err as Error).message });
        }
        finish(0);
      })();

      return {
        send(text: string) {
          if (stopped) return false;
          inbox.push(text);
          hooks.onEvent({ kind: "replay", text });
          return true;
        },
        stop() {
          stopped = true;
        },
      };
    },
  };
}

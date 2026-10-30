// Runs a sortie with the user's own local Claude Code CLI in headless mode:
//   claude -p --input-format stream-json --output-format stream-json ...
// stdin stays open so orders can be streamed into the live session.
import { spawn } from "node:child_process";
import { cliSafeRules } from "../permissions.js";
import { StreamParser } from "../streamParser.js";
import type { AgentAdapter, RunContext, RunHandle, RunHooks } from "./types.js";

export const PERMISSION_TOOL = "mcp__warroom__permission_request";

export function buildClaudeArgs(ctx: RunContext): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--include-partial-messages",
    "-n",
    ctx.sessionName,
    "--append-system-prompt-file",
    ctx.instructionsPath,
    "--permission-mode",
    ctx.permissionMode,
  ];
  if (!ctx.unattended) args.push("--mcp-config", ctx.mcpConfigPath, "--permission-prompt-tool", PERMISSION_TOOL);
  if (ctx.resumeSessionId) args.push("--resume", ctx.resumeSessionId);
  if (ctx.strictMcp && !ctx.unattended) args.push("--strict-mcp-config");
  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.effort) args.push("--effort", ctx.effort);
  if (ctx.maxBudgetUsd !== null) args.push("--max-budget-usd", ctx.maxBudgetUsd.toFixed(2));
  // Variadic flags last so nothing after them is swallowed as a tool name.
  if (ctx.disallowedTools.length) args.push("--disallowedTools", ...ctx.disallowedTools);
  const allowed = cliSafeRules(ctx.allowedTools);
  if (allowed.length) args.push("--allowedTools", ...allowed);
  return args;
}

export function createClaudeLocalAdapter(claudeBin: string): AgentAdapter {
  return {
    name: "claude_local",
    start(ctx: RunContext, hooks: RunHooks): RunHandle {
      const child = spawn(claudeBin, buildClaudeArgs(ctx), { cwd: ctx.cwd, env: ctx.env, stdio: ["pipe", "pipe", "pipe"] });

      // Turn accounting. A message written mid-turn is merged into that turn,
      // so "one result per message" doesn't hold. Instead, wait until every
      // message has been acknowledged (--replay-user-messages) and a result
      // has followed the last acknowledgment.
      let sent = 0;
      let acked = 0;
      let lastAckAt = 0;
      let lastResultAt = 0;
      let inputClosed = false;
      let exited = false;
      let idle: NodeJS.Timeout | null = null;
      let stderrTail = "";

      const clearIdle = () => {
        if (idle) clearTimeout(idle);
        idle = null;
      };
      const closeInput = () => {
        if (inputClosed) return;
        inputClosed = true;
        clearIdle();
        child.stdin.end();
      };
      const maybeFinish = () => {
        clearIdle();
        const allAcked = acked >= sent || acked === 0; // acked === 0: CLI without replay support
        if (allAcked && lastResultAt >= lastAckAt) idle = setTimeout(closeInput, 1500);
      };

      const parser = new StreamParser((ev) => {
        if (ev.kind === "replay") {
          acked++;
          lastAckAt = Date.now();
          clearIdle();
        } else if (ev.kind === "result") {
          lastResultAt = Date.now();
          maybeFinish();
        } else if (ev.kind !== "rate_limit" && ev.kind !== "usage" && ev.kind !== "text_delta" && lastResultAt > 0 && idle) {
          clearIdle(); // a new turn started after the result
        }
        hooks.onEvent(ev);
      });

      const finish = (code: number | null, signal: string | null) => {
        if (exited) return;
        exited = true;
        clearIdle();
        parser.end();
        hooks.onExit({ code, signal, stderrTail });
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => parser.push(d));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        stderrTail = (stderrTail + d).slice(-4000);
      });
      child.stdin.on("error", () => {}); // EPIPE if the process died first
      child.on("error", (err) => {
        stderrTail += `\n${err.message}`;
        setTimeout(() => finish(null, null), 50);
      });
      child.on("close", (code, signal) => finish(code, signal));

      const send = (text: string): boolean => {
        if (inputClosed || exited || !child.stdin.writable) return false;
        sent++;
        clearIdle();
        child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
        return true;
      };

      send(ctx.prompt);

      return {
        send,
        stop() {
          closeInput();
          setTimeout(() => !exited && child.kill("SIGTERM"), 4000).unref();
          setTimeout(() => !exited && child.kill("SIGKILL"), 12000).unref();
        },
      };
    },
  };
}

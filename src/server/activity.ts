// Maps a tool call to what the mascot is doing and where on the map it goes.
import path from "node:path";
import type { Activity } from "../shared/protocol.js";
import { isWithin, truncate } from "./util.js";

export interface ToolActivity {
  activity: Activity;
  detail: string;
  /** Path from the tool input, still relative to the agent's cwd if it was relative. */
  rawPath: string | null;
}

const TEST_RE =
  /(^|[\s;&|(])(npm (run )?test|pnpm (run )?test|yarn (run )?test|bun test|npx (vitest|jest|mocha|playwright)|vitest|jest|mocha|pytest|python -m pytest|go test|cargo test|rspec|phpunit|mvn test|gradle test|dotnet test|swift test|deno test)\b/;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : p;
}

/** First literal directory of a glob ("src/**\/*.ts" → "src"). */
function globBase(pattern: string): string | null {
  const parts = pattern.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (/[*?[{]/.test(part)) break;
    out.push(part);
  }
  const base = out.join("/");
  return base && base !== "." ? base : null;
}

export function toolActivity(name: string, input: Record<string, unknown>): ToolActivity {
  const filePath = str(input.file_path) || str(input.notebook_path);
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { activity: "reading", detail: `Read ${shortPath(filePath)}`, rawPath: filePath || null };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { activity: "building", detail: `${name} ${shortPath(filePath)}`, rawPath: filePath || null };
    case "Grep": {
      const p = str(input.path);
      return { activity: "scouting", detail: `Grep "${truncate(str(input.pattern), 40)}"${p ? ` in ${shortPath(p)}` : ""}`, rawPath: p || null };
    }
    case "Glob": {
      const p = str(input.path) || globBase(str(input.pattern)) || "";
      return { activity: "scouting", detail: `Glob ${truncate(str(input.pattern), 50)}`, rawPath: p || null };
    }
    case "LS":
      return { activity: "scouting", detail: `List ${shortPath(str(input.path))}`, rawPath: str(input.path) || null };
    case "Bash":
    case "PowerShell": {
      const cmd = str(input.command);
      const testing = TEST_RE.test(cmd);
      return { activity: testing ? "testing" : "commands", detail: `$ ${truncate(cmd.replace(/\s+/g, " "), 80)}`, rawPath: null };
    }
    case "WebSearch":
      return { activity: "webrecon", detail: `Search: ${truncate(str(input.query), 60)}`, rawPath: null };
    case "WebFetch":
      return { activity: "webrecon", detail: `Fetch ${truncate(str(input.url), 60)}`, rawPath: null };
    case "Task":
    case "Agent":
      return { activity: "directing", detail: `Subagent: ${truncate(str(input.description) || str(input.subagent_type), 60)}`, rawPath: null };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return { activity: "planning", detail: "Updating plan", rawPath: null };
    case "AskUserQuestion":
      return { activity: "needs_you", detail: "Has a question", rawPath: null };
    case "ExitPlanMode":
      return { activity: "needs_you", detail: "Plan ready for review", rawPath: null };
    case "ToolSearch":
      return { activity: "thinking", detail: "Loading tools", rawPath: null };
  }
  if (name.startsWith("mcp__warroom__")) {
    const tool = name.slice("mcp__warroom__".length);
    switch (tool) {
      case "my_orders":
      case "checkout_objective":
        return { activity: "orders", detail: tool === "my_orders" ? "Checking orders" : "Checking out objective", rawPath: null };
      case "create_objective":
      case "request_reinforcements":
      case "list_agents":
        return { activity: "directing", detail: tool.replace(/_/g, " "), rawPath: null };
      default:
        return { activity: "reporting", detail: tool.replace(/_/g, " "), rawPath: null };
    }
  }
  if (name.startsWith("mcp__")) return { activity: "commands", detail: name.replace(/^mcp__/, "").replace(/__/g, " › "), rawPath: null };
  return { activity: "commands", detail: name, rawPath: null };
}

/**
 * Map a tool path to a repo-relative path. Worktree paths fold back onto the
 * same building because they share repo-relative paths.
 */
export function toRepoPath(raw: string | null, cwd: string, workspaceRoot: string, theaterRoot: string): string | null {
  if (!raw) return null;
  const abs = path.resolve(cwd, raw);
  for (const root of [workspaceRoot, theaterRoot]) {
    if (isWithin(root, abs)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel.startsWith(".claude/worktrees/")) continue;
      return rel === "" ? "" : rel;
    }
  }
  return null;
}

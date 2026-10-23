// Child-process environment for agent runs.
//
// When War Room itself is started from inside a Claude Code session (very
// common: `npm run dev` from Claude's terminal), the parent process carries
// host-session variables. Passing them through would make every agent run
// think it is a child of that session, so they're stripped here.

const HOST_SESSION_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_AGENT_SDK_", "CLAUDE_PREVIEW_"];
const HOST_SESSION_KEYS = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA", "CLAUDE_JOB_DIR"]);

// User-level configuration that must survive the strip.
const KEEP = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
]);

export function isInsideClaudeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === "1" || Boolean(env.CLAUDE_CODE_ENTRYPOINT);
}

export function agentEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const strip = isInsideClaudeSession(base);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (strip && !KEEP.has(k) && (HOST_SESSION_KEYS.has(k) || HOST_SESSION_PREFIXES.some((p) => k.startsWith(p)))) continue;
    out[k] = v;
  }
  // Permission prompts are answered by a person on the map; give them time.
  out.MCP_TOOL_TIMEOUT = "3600000";
  return { ...out, ...extra };
}

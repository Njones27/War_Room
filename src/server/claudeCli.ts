// Read-only calls to the local Claude Code CLI: version, login, sessions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommsCheck } from "../shared/protocol.js";
import { agentEnv } from "./env.js";

const exec = promisify(execFile);

async function run(bin: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await exec(bin, args, { env: agentEnv(), timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function commsCheck(bin: string): Promise<CommsCheck> {
  const check: CommsCheck = { claudeFound: false, version: null, loggedIn: null, authMethod: null, subscription: null, error: null, checkedAt: Date.now(), rateLimit: null };
  try {
    const v = await run(bin, ["--version"]);
    check.claudeFound = true;
    check.version = v.trim().split(/\s+/)[0] ?? null;
  } catch (err) {
    check.error = (err as NodeJS.ErrnoException).code === "ENOENT" ? `Claude Code CLI not found ("${bin}"). Install it from https://claude.com/claude-code` : (err as Error).message;
    return check;
  }
  try {
    const raw = await run(bin, ["auth", "status"]);
    const s = JSON.parse(raw) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    check.loggedIn = Boolean(s.loggedIn);
    check.authMethod = s.authMethod ?? null;
    check.subscription = s.subscriptionType ?? null;
  } catch (err) {
    // `auth status` exits 1 when logged out but still prints JSON.
    const out = (err as { stdout?: string }).stdout;
    try {
      const s = JSON.parse(out ?? "") as { loggedIn?: boolean; authMethod?: string };
      check.loggedIn = Boolean(s.loggedIn);
      check.authMethod = s.authMethod ?? null;
    } catch {
      check.error = "Couldn't read `claude auth status`.";
    }
  }
  if (check.loggedIn === false) check.error = "Claude Code isn't logged in. Run `claude auth login` in a terminal.";
  return check;
}

export interface ClaudeSessionInfo {
  id?: string;
  pid?: number;
  cwd: string;
  kind: "interactive" | "background";
  startedAt: number;
  sessionId?: string;
  name?: string;
  state?: string;
  status?: string;
  waitingFor?: string;
}

export async function listClaudeSessions(bin: string): Promise<ClaudeSessionInfo[]> {
  const raw = await run(bin, ["agents", "--json", "--all"], 12_000);
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as ClaudeSessionInfo[]).filter((s) => s && typeof s.cwd === "string") : [];
}

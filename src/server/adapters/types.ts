import type { StreamEvent } from "../streamParser.js";

/** Everything an adapter needs to start one sortie. */
export interface RunContext {
  runId: string;
  agentId: string;
  cwd: string;
  /** First user message (the wake prompt). */
  prompt: string;
  resumeSessionId: string | null;
  instructionsPath: string;
  mcpConfigPath: string;
  strictMcp: boolean;
  permissionMode: string;
  model: string | null;
  effort: string | null;
  maxBudgetUsd: number | null;
  allowedTools: string[];
  disallowedTools: string[];
  sessionName: string;
  env: Record<string, string>;
  /**
   * A scheduled satellite run nobody is watching: no War Room MCP server and
   * no permission prompts, so tools outside the allow list are denied.
   */
  unattended?: boolean;
}

export interface RunExit {
  code: number | null;
  signal: string | null;
  stderrTail: string;
}

export interface RunHooks {
  onEvent(ev: StreamEvent): void;
  onExit(exit: RunExit): void;
}

export interface RunHandle {
  /** Stream a user message into the live session. */
  send(text: string): boolean;
  /** Finish the run: close stdin, then escalate to signals. */
  stop(): void;
}

/** A way to run an agent. `claude_local` drives the local CLI; `demo` simulates one. */
export interface AgentAdapter {
  readonly name: string;
  start(ctx: RunContext, hooks: RunHooks): RunHandle;
}

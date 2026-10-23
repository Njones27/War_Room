// TAKE COMMAND: open an agent's real Claude Code session (the interactive
// TUI) in a pseudo-terminal streamed to the browser. While you hold command,
// the scheduler leaves the agent alone; RELEASE hands the session back.
import { randomUUID } from "node:crypto";
import type { AgentView } from "../shared/protocol.js";
import { agentEnv } from "./env.js";
import type { PtyHost } from "./ptyHost.js";

export class TakeCommand {
  /** Agents whose terminal is a TAKE COMMAND session (the host also runs team leads). */
  private readonly held = new Set<string>();
  private readonly exitHandlers: ((agentId: string, code: number | null) => void)[] = [];

  constructor(private readonly ptys: PtyHost) {
    ptys.onExit((agentId, code) => {
      if (!this.held.delete(agentId)) return;
      for (const h of this.exitHandlers) h(agentId, code);
    });
  }

  get available(): boolean {
    return this.ptys.available;
  }

  has(agentId: string): boolean {
    return this.held.has(agentId);
  }

  buffer(agentId: string): string {
    return this.ptys.buffer(agentId);
  }

  onExit(fn: (agentId: string, code: number | null) => void): void {
    this.exitHandlers.push(fn);
  }

  /**
   * Start the TUI. Resumes `sessionId` if given; otherwise starts a fresh
   * session with a known id so later sorties can resume it.
   */
  start(agent: AgentView, opts: { cols: number; rows: number; sessionId: string | null; instructionsPath: string | null; permissionMode: string }): { sessionId: string } {
    if (this.held.has(agent.id)) return { sessionId: opts.sessionId ?? "" };
    const sessionId = opts.sessionId ?? randomUUID();
    const args = opts.sessionId ? ["--resume", opts.sessionId] : ["--session-id", sessionId, "-n", `War Room · ${agent.letter} · ${agent.callsign}`];
    if (!opts.sessionId && opts.instructionsPath) args.push("--append-system-prompt-file", opts.instructionsPath);
    args.push("--permission-mode", opts.permissionMode);
    this.ptys.spawn(agent.id, { args, cwd: agent.workspace.path, env: agentEnv(), cols: opts.cols, rows: opts.rows });
    this.held.add(agent.id);
    return { sessionId };
  }

  stop(agentId: string): void {
    if (this.held.has(agentId)) void this.ptys.exit(agentId);
  }
}

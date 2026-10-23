// Pseudo-terminals for the interactive Claude Code sessions War Room hosts:
// TAKE COMMAND sessions and team leads. Output streams to the browser over
// the War Room socket, keyed by agent id, and the tail is kept so a terminal
// opened later can catch up.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import type { Bus } from "./bus.js";

type PtyModule = typeof import("node-pty");

interface Session {
  pty: IPty;
  buffer: string;
}

export interface PtySpawn {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

const MAX_BUFFER = 256 * 1024;

/** node-pty's macOS prebuilds sometimes ship spawn-helper without +x, which breaks every spawn. */
function fixSpawnHelper(): void {
  try {
    const req = createRequire(import.meta.url);
    const root = path.dirname(req.resolve("node-pty/package.json"));
    for (const dir of [path.join(root, "prebuilds", `${process.platform}-${process.arch}`), path.join(root, "build", "Release")]) {
      const helper = path.join(dir, "spawn-helper");
      if (fs.existsSync(helper)) {
        const mode = fs.statSync(helper).mode;
        if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755);
      }
    }
  } catch {
    /* not installed or not fixable; spawn will report it */
  }
}

export class PtyHost {
  private mod: PtyModule | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly dataHandlers: ((key: string, data: string) => void)[] = [];
  private readonly exitHandlers: ((key: string, code: number | null) => void)[] = [];
  private readonly exitWaiters = new Map<string, (() => void)[]>();

  constructor(
    private readonly bus: Bus,
    private readonly claudeBin: string,
  ) {}

  async init(): Promise<boolean> {
    try {
      const mod = (await import("node-pty")) as PtyModule & { default?: PtyModule };
      this.mod = mod.default ?? mod;
      fixSpawnHelper();
      return true;
    } catch {
      this.mod = null;
      return false;
    }
  }

  get available(): boolean {
    return this.mod !== null;
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  buffer(key: string): string {
    return this.sessions.get(key)?.buffer ?? "";
  }

  onData(fn: (key: string, data: string) => void): void {
    this.dataHandlers.push(fn);
  }

  onExit(fn: (key: string, code: number | null) => void): void {
    this.exitHandlers.push(fn);
  }

  /** Start `claude` in a terminal. */
  spawn(key: string, opts: PtySpawn): void {
    if (!this.mod) throw new Error("This needs the optional node-pty dependency (npm install node-pty).");
    if (this.sessions.has(key)) throw new Error("A terminal session is already open for this agent.");
    const proc = this.mod.spawn(this.claudeBin, opts.args, {
      name: "xterm-256color",
      cols: Math.max(40, Math.min(400, Math.floor(opts.cols ?? 120))),
      rows: Math.max(10, Math.min(200, Math.floor(opts.rows ?? 36))),
      cwd: opts.cwd,
      env: { ...opts.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const session: Session = { pty: proc, buffer: "" };
    this.sessions.set(key, session);
    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      this.bus.emit({ t: "term", agentId: key, data });
      for (const h of this.dataHandlers) h(key, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      this.bus.emit({ t: "term_exit", agentId: key, code: exitCode });
      for (const h of this.exitHandlers) h(key, exitCode);
      const waiters = this.exitWaiters.get(key) ?? [];
      this.exitWaiters.delete(key);
      for (const w of waiters) w();
    });
  }

  write(key: string, data: string): boolean {
    const s = this.sessions.get(key);
    if (!s) return false;
    s.pty.write(data);
    return true;
  }

  resize(key: string, cols: number, rows: number): void {
    const s = this.sessions.get(key);
    if (s && cols > 0 && rows > 0) s.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  /**
   * Ask Claude Code to exit cleanly, then make sure it does. Resolves when the
   * process is gone. With background work running (teammates, subagents),
   * /exit asks to confirm; Enter picks its default, "Exit and stop tasks".
   */
  exit(key: string, graceMs = 4000): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      this.exitWaiters.set(key, [...(this.exitWaiters.get(key) ?? []), resolve]);
      s.pty.write("\x1b");
      setTimeout(() => s.pty.write("/exit\r"), 150);
      setTimeout(() => this.sessions.get(key) === s && s.pty.write("\r"), 1800);
      setTimeout(() => {
        if (this.sessions.get(key) === s) s.pty.kill();
      }, graceMs).unref();
    });
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.pty.kill();
  }
}

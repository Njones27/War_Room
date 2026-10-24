// Watch-only units: Claude Code sessions War Room didn't start (your own
// terminals, background agents) shown on the map from `claude agents --json`
// plus a tail of their transcripts. They can't be messaged from here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Activity, AgentStatus, AgentView, FeedItem, FrontView, TheaterView } from "../shared/protocol.js";
import { toRepoPath, toolActivity } from "./activity.js";
import type { Bus } from "./bus.js";
import { inMainCheckout, SHELL_TOOLS, type Demolition } from "./demolition.js";
import { listClaudeSessions, type ClaudeSessionInfo } from "./claudeCli.js";
import { contentText } from "./streamParser.js";
import { isWithin, newId, truncate } from "./util.js";

interface Unit {
  view: AgentView;
  transcript: string | null;
  offset: number;
  feed: FeedItem[];
  /** Shell commands seen but not yet finished: deletions are checked when their results land. */
  shellCalls: Set<string>;
}

const TAIL_BYTES = 256 * 1024;

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function statusOf(s: ClaudeSessionInfo): { status: AgentStatus; activity: Activity; detail: string } {
  const waiting = s.status === "waiting" || s.state === "blocked";
  if (waiting) return { status: "running", activity: "needs_you", detail: s.waitingFor ? `Waiting: ${s.waitingFor}` : "Needs input" };
  if (s.status === "busy" || s.state === "working") return { status: "running", activity: "thinking", detail: "Working" };
  if (s.state === "failed") return { status: "idle", activity: "error", detail: "Failed" };
  return { status: "idle", activity: "idle", detail: s.kind === "background" ? "Done" : "Idle" };
}

export class Watch {
  private units = new Map<string, Unit>();
  private fronts: FrontView[] = [];
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly bin: string,
    private readonly bus: Bus,
    private readonly theater: () => TheaterView,
    private readonly managedSessionIds: () => Set<string>,
    private readonly intervalMs = 6000,
    private readonly demolition: Demolition | null = null,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  agents(): AgentView[] {
    return [...this.units.values()].map((u) => u.view);
  }

  feed(): FeedItem[] {
    return [...this.units.values()].flatMap((u) => u.feed);
  }

  frontList(): FrontView[] {
    return this.fronts;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const sessions = await listClaudeSessions(this.bin);
      this.apply(sessions);
    } catch {
      /* CLI busy or unavailable — try again next tick */
    } finally {
      this.polling = false;
    }
  }

  apply(sessions: ClaudeSessionInfo[]): void {
    const t = this.theater();
    const managed = this.managedSessionIds();
    const live = sessions.filter((s) => {
      if (!s.sessionId || managed.has(s.sessionId)) return false;
      if (s.kind === "interactive") return true;
      // Background: keep running processes and anything waiting on you; skip finished history.
      return s.pid !== undefined || s.state === "working" || s.state === "blocked";
    });
    const seen = new Set<string>();
    const frontMap = new Map<string, number>();
    let n = 0;

    for (const s of live.sort((a, b) => a.startedAt - b.startedAt)) {
      const inTheater = isWithin(t.root, s.cwd);
      if (!inTheater) {
        frontMap.set(s.cwd, (frontMap.get(s.cwd) ?? 0) + 1);
        continue;
      }
      n++;
      const sid = s.sessionId!;
      seen.add(sid);
      const st = statusOf(s);
      let unit = this.units.get(sid);
      if (!unit) {
        unit = {
          view: {
            id: `ext_${sid.slice(0, 8)}`,
            theaterId: t.id,
            letter: String(n),
            callsign: truncate(s.name || `Session ${sid.slice(0, 6)}`, 28),
            role: "external",
            reportsTo: null,
            status: st.status,
            pausedReason: null,
            activity: st.activity,
            activityDetail: st.detail,
            target: null,
            objectiveId: null,
            model: null,
            effort: null,
            permissionMode: "default",
            allowedTools: [],
            budgetUsd: null,
            spentUsd: 0,
            tokensUsed: 0,
            contextTokens: 0,
            workspace: { kind: s.cwd.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) ? "worktree" : "main", path: s.cwd, branch: null },
            subagents: 0,
            external: true,
            teamMode: false,
            teamLeadId: null,
            teamTasks: [],
            sessionName: s.name ?? null,
            lastEventAt: Date.now(),
            createdAt: s.startedAt,
          },
          transcript: transcriptPath(s.cwd, sid),
          offset: -1,
          feed: [],
          shellCalls: new Set(),
        };
        this.units.set(sid, unit);
      }
      const v = unit.view;
      const changed = v.status !== st.status || v.letter !== String(n) || (st.activity === "needs_you") !== (v.activity === "needs_you");
      v.letter = String(n);
      v.status = st.status;
      if (st.activity === "needs_you" || st.status !== "running") {
        v.activity = st.activity;
        v.activityDetail = st.detail;
      }
      const tailed = this.tail(unit, t);
      if (changed || tailed) {
        v.lastEventAt = Date.now();
        this.bus.emit({ t: "agent", agent: { ...v } });
      }
    }

    for (const [sid, unit] of this.units) {
      if (!seen.has(sid)) {
        this.units.delete(sid);
        this.bus.emit({ t: "agent_removed", id: unit.view.id });
      }
    }

    const fronts = [...frontMap.entries()].map(([cwd, count]) => ({ cwd, name: path.basename(cwd) || cwd, sessions: count })).sort((a, b) => b.sessions - a.sessions);
    if (JSON.stringify(fronts) !== JSON.stringify(this.fronts)) {
      this.fronts = fronts;
      this.bus.emit({ t: "fronts", fronts });
    }
  }

  /** Read new transcript lines; returns true if the unit's posture changed. */
  private tail(unit: Unit, t: TheaterView): boolean {
    if (!unit.transcript) return false;
    let size: number;
    try {
      size = fs.statSync(unit.transcript).size;
    } catch {
      return false;
    }
    if (unit.offset < 0) unit.offset = Math.max(0, size - TAIL_BYTES);
    if (size <= unit.offset) return false;
    const fd = fs.openSync(unit.transcript, "r");
    const buf = Buffer.alloc(Math.min(size - unit.offset, 4 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, unit.offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return false;
    unit.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
    let changed = false;
    let shell = false;
    const v = unit.view;
    for (const line of text.slice(0, lastNl).split("\n")) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (o.isSidechain === true) continue;
      const message = (o.message ?? {}) as { content?: unknown };
      if (o.type === "assistant" && Array.isArray(message.content)) {
        for (const b of message.content as Record<string, unknown>[]) {
          if (b.type === "tool_use") {
            if (SHELL_TOOLS.has(String(b.name)) && typeof b.id === "string") unit.shellCalls.add(b.id);
            const act = toolActivity(String(b.name), (b.input ?? {}) as Record<string, unknown>);
            const target = toRepoPath(act.rawPath, typeof o.cwd === "string" ? o.cwd : v.workspace.path, v.workspace.path, t.root);
            if (v.status === "running" && v.activity !== "needs_you") {
              v.activity = act.activity;
              v.activityDetail = act.detail;
            }
            if (target !== null) v.target = target;
            this.push(unit, { kind: "tool_use", text: act.detail, tool: String(b.name), target });
            changed = true;
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            this.push(unit, { kind: "text", text: truncate(b.text, 3000) });
            changed = true;
          }
        }
      } else if (o.type === "user" && o.isMeta !== true) {
        const c = message.content;
        if (Array.isArray(c)) {
          for (const b of c as Record<string, unknown>[]) if (b.type === "tool_result" && unit.shellCalls.delete(String(b.tool_use_id))) shell = true;
        }
        if (typeof c === "string" && c.trim() && !c.startsWith("<")) {
          this.push(unit, { kind: "prompt", text: truncate(c, 2000) });
          changed = true;
        } else if (Array.isArray(c) && !c.some((b) => (b as { type?: string }).type === "tool_result")) {
          const text = contentText(c);
          if (text.trim() && !text.startsWith("<")) {
            this.push(unit, { kind: "prompt", text: truncate(text, 2000) });
            changed = true;
          }
        }
      }
    }
    // A finished shell command in the main checkout may have deleted files: the diff since the last check is struck.
    if (shell && inMainCheckout(v.workspace.path, t.root)) void this.demolition?.check(v);
    return changed;
  }

  private push(unit: Unit, item: Omit<FeedItem, "id" | "at" | "agentId" | "runId">): void {
    const full: FeedItem = { ...item, id: newId("fx"), at: Date.now(), agentId: unit.view.id, runId: null };
    unit.feed.push(full);
    if (unit.feed.length > 60) unit.feed.splice(0, unit.feed.length - 60);
    this.bus.emit({ t: "feed", item: full });
  }
}

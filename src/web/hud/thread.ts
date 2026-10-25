import type { FeedItem, OrderView } from "../../shared/protocol";

export interface TraceStep {
  id: string;
  text: string;
  tool?: string;
  result?: string;
  /** stopped: the sortie ended before the tool reported back (recalled, crashed). */
  state: "run" | "ok" | "err" | "stopped";
}

export type ThreadEntry =
  | {
      kind: "msg";
      id: string;
      at: number;
      /** you: the Commander. agent: this agent. other: another agent writing to it. */
      from: "you" | "agent" | "other";
      /** "commander", an agent id, or (for orders known only from the feed) the sender's "A·Callsign". */
      authorId: string;
      /** Who an outgoing message from this agent went to. */
      to?: string;
      text: string;
      runId: string | null;
      /** Tool calls made after this message, folded into a trace under it. */
      steps: TraceStep[];
    }
  | { kind: "briefing"; id: string; at: number; text: string }
  | { kind: "sys"; id: string; at: number; text: string; err?: boolean };

type Msg = Extract<ThreadEntry, { kind: "msg" }>;

/** How far apart an order-log row and its live "order" feed item can be and still be the same order. */
const ECHO_MS = 10 * 60_000;

/** An "order" feed item's text: "Commander: …" or "A·Callsign: …". */
const splitOrder = (text: string) => /^(.+?): ([\s\S]*)$/.exec(text);

/**
 * One agent's conversation: orders to and from it (from the order log, so queued
 * orders show too), its replies, and its tool calls folded into a trace under the
 * reply they followed. A live-delivered "order" feed item repeats an order-log row
 * and is skipped; one with no row (orders relayed to a teammate) is shown.
 * `running`: whether the agent is on a sortie now; if not, unfinished steps show as stopped.
 */
export function buildThread(agentId: string, feed: FeedItem[], orders: OrderView[], running = false): ThreadEntry[] {
  type Ev = { at: number; seq: number; feed?: FeedItem; order?: OrderView };
  const events: Ev[] = [];
  const mine = orders.filter((o) => o.agentId === agentId || o.author === agentId);
  const echoes = (f: FeedItem, body: string) => mine.some((o) => o.agentId === agentId && o.body === body && Math.abs(o.createdAt - f.at) < ECHO_MS);
  feed.forEach((f, i) => {
    if (f.kind === "order") {
      const m = splitOrder(f.text);
      if (!m || echoes(f, m[2]!)) return;
    }
    events.push({ at: f.at, seq: i, feed: f });
  });
  mine.forEach((o, i) => events.push({ at: o.createdAt, seq: feed.length + i, order: o }));
  events.sort((a, b) => a.at - b.at || a.seq - b.seq);

  const out: ThreadEntry[] = [];
  const steps = new Map<string, TraceStep>();
  let last: Msg | null = null;

  // Steps still waiting on a result: done when their sortie reports, stopped when it ended without a word.
  const close = (match: (runId: string | null) => boolean, state: TraceStep["state"]) => {
    for (const e of out) if (e.kind === "msg" && match(e.runId)) for (const s of e.steps) if (s.state === "run") s.state = state;
  };

  for (const ev of events) {
    const o = ev.order;
    if (o) {
      const outgoing = o.author === agentId;
      const msg: Msg = {
        kind: "msg",
        id: `o-${o.id}`,
        at: o.createdAt,
        from: outgoing ? "agent" : o.author === "commander" ? "you" : "other",
        authorId: o.author,
        to: outgoing ? (o.agentId ?? "commander") : undefined,
        text: o.body,
        runId: null,
        steps: [],
      };
      out.push(msg);
      last = outgoing ? msg : null;
      continue;
    }
    const f = ev.feed!;
    switch (f.kind) {
      case "order": {
        // Relayed to a teammate: known only from the feed, as "Commander: …" or "A·Callsign: …".
        const [, name, body] = splitOrder(f.text)!;
        const you = name === "Commander";
        out.push({ kind: "msg", id: f.id, at: f.at, from: you ? "you" : "other", authorId: you ? "commander" : name!, text: body!, runId: f.runId, steps: [] });
        last = null;
        break;
      }
      case "prompt":
        // A new sortie: anything left running in an earlier one never finished.
        close((r) => r !== f.runId, "stopped");
        out.push({ kind: "briefing", id: f.id, at: f.at, text: f.text });
        last = null;
        break;
      case "text": {
        const msg: Msg = { kind: "msg", id: f.id, at: f.at, from: "agent", authorId: agentId, text: f.text, runId: f.runId, steps: [] };
        out.push(msg);
        last = msg;
        break;
      }
      case "tool_use": {
        const step: TraceStep = { id: f.toolUseId ?? f.id, text: f.text, tool: f.tool, state: "run" };
        steps.set(step.id, step);
        if (!last || last.runId !== f.runId) {
          last = { kind: "msg", id: f.id, at: f.at, from: "agent", authorId: agentId, text: "", runId: f.runId, steps: [] };
          out.push(last);
        }
        last.steps.push(step);
        break;
      }
      case "tool_result": {
        const step = f.toolUseId ? steps.get(f.toolUseId) : undefined;
        if (step) {
          step.state = f.isError ? "err" : "ok";
          step.result = f.text;
        }
        break;
      }
      case "result":
        close((r) => r === f.runId, "ok");
        out.push(f.isError ? { kind: "sys", id: f.id, at: f.at, text: f.text, err: true } : { kind: "sys", id: f.id, at: f.at, text: "Sortie complete" });
        last = null;
        break;
      case "error":
        out.push({ kind: "sys", id: f.id, at: f.at, text: f.text, err: true });
        break;
      case "system":
        out.push({ kind: "sys", id: f.id, at: f.at, text: f.text });
        break;
    }
  }
  if (!running) close(() => true, "stopped");
  return out;
}

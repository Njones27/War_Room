import type { FeedItem, OrderView } from "../../shared/protocol";

export interface TraceStep {
  id: string;
  text: string;
  tool?: string;
  result?: string;
  state: "run" | "ok" | "err";
}

export type ThreadEntry =
  | {
      kind: "msg";
      id: string;
      at: number;
      /** you: the Commander. agent: this agent. other: another agent writing to it. */
      from: "you" | "agent" | "other";
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

/**
 * One agent's conversation: orders to and from it (from the order log, so queued
 * orders show too), its replies, and its tool calls folded into a trace under the
 * reply they followed. Live-delivered "order" feed items repeat the order log and
 * are skipped.
 */
export function buildThread(agentId: string, feed: FeedItem[], orders: OrderView[]): ThreadEntry[] {
  type Ev = { at: number; seq: number; feed?: FeedItem; order?: OrderView };
  const events: Ev[] = [];
  feed.forEach((f, i) => f.kind !== "order" && events.push({ at: f.at, seq: i, feed: f }));
  orders.forEach((o, i) => (o.agentId === agentId || o.author === agentId) && events.push({ at: o.createdAt, seq: feed.length + i, order: o }));
  events.sort((a, b) => a.at - b.at || a.seq - b.seq);

  const out: ThreadEntry[] = [];
  const steps = new Map<string, TraceStep>();
  let last: Msg | null = null;

  const closeRun = (runId: string | null) => {
    for (const e of out) if (e.kind === "msg" && e.runId === runId) for (const s of e.steps) if (s.state === "run") s.state = "ok";
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
      case "prompt":
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
        closeRun(f.runId);
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
  return out;
}

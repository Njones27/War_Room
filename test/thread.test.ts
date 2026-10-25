import { describe, expect, it } from "vitest";
import type { FeedItem, OrderView } from "../src/shared/protocol.js";
import { buildThread } from "../src/web/hud/thread.js";

let seq = 0;
const feed = (kind: FeedItem["kind"], at: number, text: string, extra: Partial<FeedItem> = {}): FeedItem => ({ id: `f${++seq}`, agentId: "c", runId: "r1", at, kind, text, ...extra });
const order = (author: string, agentId: string | null, at: number, body: string): OrderView => ({
  id: `o${++seq}`,
  theaterId: "t",
  agentId,
  objectiveId: null,
  author,
  body,
  createdAt: at,
  deliveredRunId: null,
});

describe("buildThread", () => {
  it("turns orders, replies and tool calls into a conversation", () => {
    const t = buildThread(
      "c",
      [
        feed("prompt", 2, "You are C·Hammer…"),
        feed("text", 3, "On it."),
        feed("tool_use", 4, "$ npm test", { tool: "Bash", toolUseId: "u1" }),
        feed("tool_result", 5, "48 passed", { toolUseId: "u1" }),
        feed("tool_use", 6, "Edit src/a.ts", { tool: "Edit", toolUseId: "u2" }),
        feed("tool_result", 7, "boom", { toolUseId: "u2", isError: true }),
        feed("text", 8, "Ready for review."),
        feed("result", 9, "Ready for review."),
      ],
      [order("commander", "c", 1, "Add tests")],
    );
    expect(t.map((e) => (e.kind === "msg" ? `${e.from}:${e.text}` : e.kind))).toEqual(["you:Add tests", "briefing", "agent:On it.", "agent:Ready for review.", "sys"]);
    const onIt = t[2];
    expect(onIt?.kind === "msg" && onIt.steps.map((s) => [s.text, s.state])).toEqual([
      ["$ npm test", "ok"],
      ["Edit src/a.ts", "err"],
    ]);
  });

  it("skips live order echoes and starts a trace when tools come before any reply", () => {
    const t = buildThread("c", [feed("order", 2, "Commander: Add tests"), feed("tool_use", 3, "Read a.ts", { toolUseId: "u3" })], [order("commander", "c", 1, "Add tests")]);
    expect(t).toHaveLength(2);
    const work = t[1];
    expect(work?.kind === "msg" && work.from === "agent" && work.text === "" && work.steps[0]?.state).toBe("run");
  });

  it("shows reports the agent sent, and orders from other agents", () => {
    const t = buildThread("c", [], [order("a", "c", 1, "Take #11"), order("c", null, 2, "Done with #11"), order("a", "b", 3, "not for c")]);
    expect(t.map((e) => e.kind === "msg" && [e.from, e.to ?? null])).toEqual([
      ["other", null],
      ["agent", "commander"],
    ]);
  });

  it("closes unfinished steps when the sortie ends", () => {
    const t = buildThread("c", [feed("text", 1, "Working"), feed("tool_use", 2, "$ sleep 1", { toolUseId: "u4" }), feed("result", 3, "done")], []);
    const msg = t[0];
    expect(msg?.kind === "msg" && msg.steps[0]?.state).toBe("ok");
  });
});

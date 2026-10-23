import { describe, expect, it } from "vitest";
import { normalize, StreamParser, type StreamEvent } from "../src/server/streamParser.js";

// Shapes recorded from `claude -p --output-format stream-json --verbose` (v2.1.302).
const LINES = [
  { type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" },
  {
    type: "system",
    subtype: "init",
    session_id: "ac84769c-8488-4ca4-a04e-6895379b8bf9",
    model: "claude-opus-5-5",
    cwd: "/repo",
    permissionMode: "default",
    tools: ["Read", "Edit", "mcp__warroom__my_orders"],
    mcp_servers: [{ name: "warroom", status: "connected" }],
  },
  { type: "user", isReplay: true, message: { role: "user", content: "Go." }, session_id: "s" },
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      content: [{ type: "thinking", thinking: "", signature: "x" }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 19729, cache_read_input_tokens: 12534, output_tokens: 16 },
    },
  },
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/repo/hello.txt", content: "hi" } }] },
  },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "DO" } } },
  { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Denied by spike", is_error: true }] } },
  { type: "assistant", parent_tool_use_id: "toolu_task", message: { id: "msg_2", content: [{ type: "text", text: "subagent chatter" }] } },
  { type: "assistant", parent_tool_use_id: null, message: { id: "msg_3", content: [{ type: "text", text: "DENIED-OK" }] } },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792778400, rateLimitType: "five_hour" } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 2140,
    num_turns: 2,
    result: "DENIED-OK",
    session_id: "ac84769c-8488-4ca4-a04e-6895379b8bf9",
    total_cost_usd: 0.2015734,
    usage: { input_tokens: 4, output_tokens: 22, cache_read_input_tokens: 64000, cache_creation_input_tokens: 437 },
  },
];

function parseAll(chunks: string[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  const p = new StreamParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

describe("StreamParser", () => {
  const text = LINES.map((l) => JSON.stringify(l)).join("\n") + "\nnot json noise\n";

  it("normalizes a full sortie", () => {
    const events = parseAll([text]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["init", "replay", "thinking", "usage", "tool_use", "text_delta", "tool_result", "text", "text", "rate_limit", "result"]);
    const init = events[0] as Extract<StreamEvent, { kind: "init" }>;
    expect(init.sessionId).toBe("ac84769c-8488-4ca4-a04e-6895379b8bf9");
    expect(init.mcpServers).toEqual([{ name: "warroom", status: "connected" }]);
    const usage = events.find((e) => e.kind === "usage") as Extract<StreamEvent, { kind: "usage" }>;
    expect(usage.contextTokens).toBe(2 + 19729 + 12534);
    const result = events.at(-1) as Extract<StreamEvent, { kind: "result" }>;
    expect(result.totalCostUsd).toBeCloseTo(0.2015734);
    expect(result.numTurns).toBe(2);
    const toolResult = events.find((e) => e.kind === "tool_result") as Extract<StreamEvent, { kind: "tool_result" }>;
    expect(toolResult).toMatchObject({ toolUseId: "toolu_1", isError: true, text: "Denied by spike" });
  });

  it("marks subagent messages with their parent tool call", () => {
    const events = parseAll([text]);
    const sub = events.find((e) => e.kind === "text" && e.parentToolUseId === "toolu_task");
    expect(sub).toBeTruthy();
  });

  it("reads plan usage windows from rate limit events", () => {
    const [ev] = normalize({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        resetsAt: 1793000000,
        utilization: 0.81,
        unifiedWindows: { five_hour: { utilization: 0.04, resetsAt: 1792778400 } },
      },
    });
    expect(ev).toEqual({
      kind: "rate_limit",
      status: "allowed_warning",
      type: "seven_day",
      resetsAt: 1793000000,
      fiveHour: { utilization: 0.04, resetsAt: 1792778400 },
      // No seven_day entry in unifiedWindows: fall back to the binding window.
      sevenDay: { utilization: 0.81, resetsAt: 1793000000 },
    });
    const [bare] = normalize({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1 } });
    expect(bare).toMatchObject({ fiveHour: null, sevenDay: null });
  });

  it("handles lines split across chunks", () => {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7));
    expect(parseAll(parts).map((e) => e.kind)).toEqual(parseAll([text]).map((e) => e.kind));
  });
});

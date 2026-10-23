// Parses Claude Code's `--output-format stream-json` (one JSON object per
// line) into a small set of normalized events.
import type { UsageWindow } from "../shared/protocol.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export type StreamEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string | null;
      tools: string[];
      mcpServers: { name: string; status: string }[];
      permissionMode: string | null;
      cwd: string | null;
    }
  | { kind: "replay"; text: string }
  | { kind: "text"; text: string; parentToolUseId: string | null }
  | { kind: "thinking"; parentToolUseId: string | null }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown>; parentToolUseId: string | null }
  | { kind: "tool_result"; toolUseId: string; text: string; isError: boolean; parentToolUseId: string | null }
  | { kind: "usage"; contextTokens: number; parentToolUseId: string | null }
  | { kind: "text_delta"; text: string }
  | {
      kind: "result";
      subtype: string;
      isError: boolean;
      totalCostUsd: number;
      numTurns: number;
      durationMs: number;
      resultText: string;
      usage: Usage;
      sessionId: string | null;
    }
  | { kind: "rate_limit"; status: string; type: string | null; resetsAt: number | null; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }
  | { kind: "system"; subtype: string; text: string }
  | { kind: "error"; text: string };

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Text from a tool_result/user `content`, which is a string or a list of blocks. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asObj(block);
    if (b.type === "text") parts.push(asStr(b.text));
    else if (b.type === "image") parts.push("[image]");
    else if (b.type === "tool_reference") parts.push(`[loaded ${asStr(b.tool_name)}]`);
  }
  return parts.join("\n");
}

function windowOf(v: unknown): UsageWindow | null {
  const w = asObj(v);
  if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
  return { utilization: w.utilization, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null };
}

function usageOf(u: Json): Usage {
  return {
    input: asNum(u.input_tokens),
    output: asNum(u.output_tokens),
    cacheRead: asNum(u.cache_read_input_tokens),
    cacheCreation: asNum(u.cache_creation_input_tokens),
  };
}

export function normalize(raw: unknown): StreamEvent[] {
  const o = asObj(raw);
  const type = asStr(o.type);
  const parent = typeof o.parent_tool_use_id === "string" ? o.parent_tool_use_id : null;

  switch (type) {
    case "system": {
      const subtype = asStr(o.subtype);
      if (subtype === "init") {
        const servers = Array.isArray(o.mcp_servers) ? o.mcp_servers : [];
        return [
          {
            kind: "init",
            sessionId: asStr(o.session_id),
            model: asStr(o.model) || null,
            tools: Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === "string") : [],
            mcpServers: servers.map((s) => ({ name: asStr(asObj(s).name), status: asStr(asObj(s).status) })),
            permissionMode: asStr(o.permissionMode) || null,
            cwd: asStr(o.cwd) || null,
          },
        ];
      }
      if (subtype === "hook_started" || subtype === "hook_response" || subtype === "status") return [];
      if (subtype === "compact_boundary") return [{ kind: "system", subtype, text: "Context compacted" }];
      return [{ kind: "system", subtype, text: asStr(o.message) || asStr(o.text) || subtype }];
    }
    case "assistant": {
      const message = asObj(o.message);
      const out: StreamEvent[] = [];
      if (o.error) out.push({ kind: "error", text: `Claude error: ${typeof o.error === "string" ? o.error : JSON.stringify(o.error)}` });
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const b = asObj(block);
        if (b.type === "text" && asStr(b.text).trim()) out.push({ kind: "text", text: asStr(b.text), parentToolUseId: parent });
        else if (b.type === "thinking" || b.type === "redacted_thinking") out.push({ kind: "thinking", parentToolUseId: parent });
        else if (b.type === "tool_use" || b.type === "server_tool_use") {
          out.push({ kind: "tool_use", id: asStr(b.id), name: asStr(b.name), input: asObj(b.input), parentToolUseId: parent });
        }
      }
      const u = usageOf(asObj(message.usage));
      const ctx = u.input + u.cacheRead + u.cacheCreation;
      if (ctx > 0) out.push({ kind: "usage", contextTokens: ctx, parentToolUseId: parent });
      return out;
    }
    case "user": {
      const message = asObj(o.message);
      if (o.isReplay === true) return [{ kind: "replay", text: contentText(message.content) }];
      const out: StreamEvent[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const b = asObj(block);
        if (b.type === "tool_result") {
          out.push({
            kind: "tool_result",
            toolUseId: asStr(b.tool_use_id),
            text: contentText(b.content),
            isError: b.is_error === true,
            parentToolUseId: parent,
          });
        }
      }
      return out;
    }
    case "stream_event": {
      if (parent) return [];
      const ev = asObj(o.event);
      const delta = asObj(ev.delta);
      if (ev.type === "content_block_delta" && delta.type === "text_delta" && asStr(delta.text)) {
        return [{ kind: "text_delta", text: asStr(delta.text) }];
      }
      return [];
    }
    case "result":
      return [
        {
          kind: "result",
          subtype: asStr(o.subtype),
          isError: o.is_error === true,
          totalCostUsd: asNum(o.total_cost_usd),
          numTurns: asNum(o.num_turns),
          durationMs: asNum(o.duration_ms),
          resultText: asStr(o.result),
          usage: usageOf(asObj(o.usage)),
          sessionId: asStr(o.session_id) || null,
        },
      ];
    case "rate_limit_event": {
      const info = asObj(o.rate_limit_info);
      const type = asStr(info.rateLimitType) || null;
      const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : null;
      // Subscription logins report each plan window; older builds only the binding one.
      const windows = asObj(info.unifiedWindows);
      const binding = windowOf({ utilization: info.utilization, resetsAt });
      return [
        {
          kind: "rate_limit",
          status: asStr(info.status),
          type,
          resetsAt,
          fiveHour: windowOf(windows.five_hour) ?? (type === "five_hour" ? binding : null),
          sevenDay: windowOf(windows.seven_day) ?? (type === "seven_day" ? binding : null),
        },
      ];
    }
    default:
      return [];
  }
}

/** Line splitter for a child's stdout. */
export class StreamParser {
  private buf = "";

  constructor(private readonly onEvent: (e: StreamEvent) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.line(line);
    }
  }

  end(): void {
    const line = this.buf.trim();
    this.buf = "";
    if (line) this.line(line);
  }

  private line(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // non-JSON noise (warnings) — ignore
    }
    for (const ev of normalize(parsed)) this.onEvent(ev);
  }
}

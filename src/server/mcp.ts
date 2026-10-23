// War Room's MCP server: the agents' API into the control plane, served over
// Streamable HTTP at /mcp. Each sortie authenticates with its own bearer
// token, which identifies the agent and run. Stateless: one server instance
// per request.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { HqError } from "./hq.js";
import { MODEL_GUIDE } from "./prompts.js";
import type { Scheduler } from "./scheduler.js";
import type { Caller, Toolkit } from "./toolkit.js";

const STATUS = z.enum(["todo", "in_progress", "blocked", "in_review", "done", "cancelled"]);
const PRIORITY = z.enum(["low", "normal", "high", "critical"]);
const EFFORT = z.enum(["low", "medium", "high", "xhigh", "max"]);
const MODEL = z.string().max(80).describe('Claude Code model alias or ID, e.g. "haiku", "sonnet", "opus"');

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function wrap(fn: () => unknown): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const message = err instanceof HqError ? err.message : `War Room error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function buildServer(caller: Caller, kit: Toolkit, version: string): McpServer {
  const server = new McpServer(
    { name: "warroom", version },
    { instructions: "War Room control plane. Start every sortie with my_orders. Coordinate through objectives, not chat." },
  );

  server.registerTool(
    "my_orders",
    {
      description: "Your identity, chain of command, open objectives, recent orders, and the rest of the squad. Call this first every sortie.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => kit.myOrders(caller)),
  );

  server.registerTool(
    "checkout_objective",
    {
      description: "Claim an objective before working on it. On a conflict, don't retry: pick another objective or report.",
      inputSchema: { objective: z.string().describe('Objective reference, e.g. "#3"') },
    },
    async ({ objective }) => wrap(() => kit.checkout(caller, objective)),
  );

  server.registerTool(
    "update_objective",
    {
      description:
        "Record progress on an objective: change its status and/or add a comment saying what you did and how you verified it. Use in_review when the work needs checking, done when it's finished, and blocked with a reason when you're stuck.",
      inputSchema: {
        objective: z.string().describe('Objective reference, e.g. "#3"'),
        status: STATUS.optional(),
        comment: z.string().optional(),
        targetPaths: z.array(z.string()).optional().describe("Repo-relative files or folders this objective is about"),
        model: MODEL.optional().describe("General only: the model this objective runs on (see my_orders → modelPicks)"),
        effort: EFFORT.optional().describe("General only: the effort level this objective runs at"),
      },
    },
    async (args) => wrap(() => kit.update(caller, args)),
  );

  server.registerTool(
    "create_objective",
    {
      description:
        "Create an objective (task) and optionally assign it to a squad member (letter, callsign or role). By default the parent is your current objective. Assigning it wakes the assignee. " +
        `When my_orders shows modelPicks, set model and effort for the task too. ${MODEL_GUIDE}`,
      inputSchema: {
        title: z.string(),
        body: z.string().optional().describe("What done looks like, constraints, and pointers"),
        assignee: z.string().optional().describe('Agent letter, callsign or role, e.g. "C" or "engineer"'),
        parent: z.string().optional().describe('Parent objective, e.g. "#1"'),
        priority: PRIORITY.optional(),
        targetPaths: z.array(z.string()).optional().describe("Repo-relative files or folders to work on"),
        model: MODEL.optional(),
        effort: EFFORT.optional(),
      },
    },
    async (args) => wrap(() => kit.create(caller, args)),
  );

  server.registerTool(
    "list_agents",
    { description: "The squad roster: roles, status, chain of command, and open objectives.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => wrap(() => kit.listAgents(caller)),
  );

  server.registerTool(
    "radio",
    {
      description:
        "A short message to another agent (letter/callsign) or to \"commander\". It's delivered live if they're running, otherwise it wakes them. Keep it brief; put real work in objectives.",
      inputSchema: { to: z.string(), text: z.string(), objective: z.string().optional() },
    },
    async (args) => wrap(() => kit.radio(caller, args)),
  );

  server.registerTool(
    "report",
    {
      description: "Send a sitrep to the Commander: what's done, what's blocked, what you need.",
      inputSchema: { text: z.string(), objective: z.string().optional() },
    },
    async (args) => wrap(() => kit.report(caller, args)),
  );

  server.registerTool(
    "request_reinforcements",
    {
      description: "Ask the Commander to deploy another agent (role: engineer, security, recon, medic, support, …). The new agent reports to you. Non-blocking: you'll be woken with the answer.",
      inputSchema: { role: z.string(), reason: z.string(), callsign: z.string().optional() },
    },
    async (args) => wrap(() => kit.requestReinforcements(caller, args)),
  );

  server.registerTool(
    "request_merge",
    {
      description: "Ask the Commander to approve merging a branch (default: your worktree branch) into the main branch. Non-blocking: the General is woken to merge once it's approved.",
      inputSchema: { summary: z.string(), branch: z.string().optional(), into: z.string().optional(), objective: z.string().optional() },
    },
    async (args) => wrap(() => kit.requestMerge(caller, args)),
  );

  // Called by Claude Code itself (--permission-prompt-tool), not by the model.
  server.registerTool(
    "permission_request",
    {
      description: "War Room permission prompt handler. The Commander approves or denies on the map.",
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
    },
    async (args, extra) => {
      try {
        const answer = await kit.permission(caller, args, extra.signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ behavior: "deny", message: `War Room couldn't route the request: ${(err as Error).message}` }) }] };
      }
    },
  );

  return server;
}

export function createMcpHandler(scheduler: Scheduler, kit: Toolkit, version: string) {
  return async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const caller = token ? scheduler.runForToken(token) : null;
    if (!caller) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown or finished War Room sortie" }, id: null }));
      return;
    }
    const server = buildServer(caller, kit, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

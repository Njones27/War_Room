// Domain + wire types shared by the War Room server and the web UI.
import type { CityModel } from "./city.js";

export type { CityModel } from "./city.js";

export type AgentStatus =
  | "idle" // ready, nothing running
  | "queued" // a wake is waiting for a free slot
  | "running" // a sortie (headless Claude Code run) is live
  | "paused" // paused by the commander, or out of budget
  | "commanded" // the commander has TAKE COMMAND of the session
  | "terminated";

export type Activity =
  | "idle"
  | "orders" // receiving orders / checking the inbox
  | "thinking"
  | "reading"
  | "scouting"
  | "building"
  | "commands"
  | "testing"
  | "webrecon"
  | "directing"
  | "planning"
  | "reporting"
  | "needs_you"
  | "error"
  | "asleep"
  | "offline";

export interface Workspace {
  kind: "main" | "worktree";
  path: string;
  branch: string | null;
}

export interface AgentView {
  id: string;
  theaterId: string;
  letter: string;
  callsign: string;
  role: string;
  reportsTo: string | null;
  status: AgentStatus;
  pausedReason: string | null;
  activity: Activity;
  activityDetail: string | null;
  /** Repo-relative path the agent is working on (drives map movement). */
  target: string | null;
  objectiveId: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  allowedTools: string[];
  budgetUsd: number | null;
  spentUsd: number;
  /** Tokens processed across all sorties (input, output and cache). */
  tokensUsed: number;
  contextTokens: number;
  workspace: Workspace;
  subagents: number;
  /** Watch-only unit: a Claude session War Room observes but doesn't manage. */
  external: boolean;
  /** Team mode: a commander that runs as a live Claude Code session and builds its own agent team. */
  teamMode: boolean;
  /** Teammate units (members of a team lead's Claude Code agent team): the lead's agent id. */
  teamLeadId: string | null;
  /** Team leads: the team's shared task list. */
  teamTasks: TeamTask[];
  sessionName: string | null;
  lastEventAt: number;
  createdAt: number;
}

export interface TeamTask {
  id: string;
  subject: string;
  owner: string | null;
  status: "pending" | "in_progress" | "completed";
}

export type ObjectiveStatus = "todo" | "in_progress" | "blocked" | "in_review" | "done" | "cancelled";
export type Priority = "low" | "normal" | "high" | "critical";

export interface ObjectiveView {
  id: string;
  theaterId: string;
  number: number;
  title: string;
  body: string;
  status: ObjectiveStatus;
  priority: Priority;
  assigneeId: string | null;
  parentId: string | null;
  missionId: string | null;
  targetPaths: string[];
  /** "commander" or an agent id. */
  createdBy: string;
  checkoutRunId: string | null;
  /** Model and effort for this objective's sorties (null: the assignee's own settings). */
  model: string | null;
  effort: string | null;
  /** Who chose them. */
  modelBy: "commander" | "general" | null;
  /** Waiting for the General to choose them; the assignee isn't woken until it does. */
  modelPending: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MissionView {
  id: string;
  theaterId: string;
  title: string;
  body: string;
  status: "active" | "complete" | "aborted";
  createdAt: number;
  updatedAt: number;
}

export interface OrderView {
  id: string;
  theaterId: string;
  /** Recipient agent, or null when addressed to the commander. */
  agentId: string | null;
  objectiveId: string | null;
  /** "commander" or the sending agent id. */
  author: string;
  body: string;
  createdAt: number;
  deliveredRunId: string | null;
}

export type ApprovalKind = "tool_permission" | "reinforcements" | "merge" | "budget";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalView {
  id: string;
  theaterId: string;
  kind: ApprovalKind;
  agentId: string | null;
  runId: string | null;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

export type WakeReason = "deploy" | "assigned" | "order" | "approval" | "child_done" | "timer" | "manual" | "model_pick";
export type RunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface RunView {
  id: string;
  agentId: string;
  objectiveId: string | null;
  wakeReason: WakeReason;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  sessionId: string | null;
  error: string | null;
}

export type FeedKind = "prompt" | "order" | "text" | "tool_use" | "tool_result" | "system" | "result" | "error";

export interface FeedItem {
  id: string;
  agentId: string;
  runId: string | null;
  at: number;
  kind: FeedKind;
  text: string;
  tool?: string;
  toolUseId?: string;
  isError?: boolean;
  target?: string | null;
}

export interface CommsEntry {
  id: number;
  at: number;
  agentId: string | null;
  kind: string;
  text: string;
}

export interface RoleView {
  id: string;
  name: string;
  title: string;
  icon: string;
  accessory: string;
  description: string;
  worktree: boolean;
  permissionMode: string;
  model: string | null;
  effort: string | null;
  budgetUsd: number | null;
  reportsTo: string | null;
  callsigns: string[];
  /** Can't edit files (Edit and Write are disallowed). */
  readOnly: boolean;
}

export interface TheaterView {
  id: string;
  root: string;
  name: string;
  branch: string | null;
  isGit: boolean;
}

export interface UsageWindow {
  /** Fraction of the window used (0-1; can run past 1). */
  utilization: number;
  /** Unix epoch seconds. */
  resetsAt: number | null;
}

export interface RateLimitInfo {
  status: string;
  type: string | null;
  resetsAt: number | null;
  /** Plan usage windows (subscription logins), from Claude Code's rate_limit_event. */
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  at: number;
}

export interface CommsCheck {
  claudeFound: boolean;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  subscription: string | null;
  error: string | null;
  checkedAt: number;
  rateLimit: RateLimitInfo | null;
}

export interface FrontView {
  cwd: string;
  name: string;
  sessions: number;
}

/**
 * How agents are kept in supply. "budget": per-agent dollar caps on Claude
 * Code's cost estimate. "usage": no caps; agents draw on your plan's usage.
 */
export type SupplyMode = "budget" | "usage";

/**
 * Claude Code permission mode for every agent. "auto" is Claude Code's own
 * default (a classifier reviews actions; sessions that can't use it start in
 * Manual), "plan" researches without editing, "manual" asks for everything.
 */
export type PermissionOverride = "auto" | "plan" | "manual";

export interface Settings {
  maxConcurrent: number;
  demo: boolean;
  takeCommandAvailable: boolean;
  version: string;
  supplyMode: SupplyMode;
  permissionMode: PermissionOverride;
  /** The General chooses the model and effort for each objective (unless the Commander sets them). */
  generalPicksModels: boolean;
}

export interface Snapshot {
  theater: TheaterView;
  agents: AgentView[];
  objectives: ObjectiveView[];
  missions: MissionView[];
  approvals: ApprovalView[];
  runs: RunView[];
  orders: OrderView[];
  comms: CommsEntry[];
  feed: FeedItem[];
  roles: RoleView[];
  city: CityModel;
  commsCheck: CommsCheck;
  fronts: FrontView[];
  settings: Settings;
}

/** Server → client WebSocket messages. */
export type ServerMsg =
  | { t: "snapshot"; snapshot: Snapshot }
  | { t: "agent"; agent: AgentView }
  | { t: "agent_removed"; id: string }
  | { t: "objective"; objective: ObjectiveView }
  | { t: "mission"; mission: MissionView }
  | { t: "approval"; approval: ApprovalView }
  | { t: "run"; run: RunView }
  | { t: "order"; order: OrderView }
  | { t: "feed"; item: FeedItem }
  | { t: "text_delta"; agentId: string; runId: string; text: string }
  | { t: "comms"; entry: CommsEntry }
  | { t: "city"; city: CityModel }
  | { t: "comms_check"; check: CommsCheck }
  | { t: "fronts"; fronts: FrontView[] }
  | { t: "settings"; settings: Settings }
  | { t: "term"; agentId: string; data: string }
  | { t: "term_exit"; agentId: string; code: number | null }
  | { t: "toast"; level: "info" | "warn" | "error"; text: string };

/** Client → server WebSocket messages (terminal I/O only; everything else is REST). */
export type ClientMsg =
  | { t: "term_input"; agentId: string; data: string }
  | { t: "term_resize"; agentId: string; cols: number; rows: number };

export const OPEN_OBJECTIVE_STATUSES: ObjectiveStatus[] = ["todo", "in_progress", "blocked", "in_review"];

import type { AgentView, ObjectiveView } from "../../shared/protocol";

export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export const callsign = (a: Pick<AgentView, "letter" | "callsign">) => `${a.letter} · ${a.callsign}`;

/** "sonnet · high (General's pick)", or null when the objective uses the assignee's own model. */
export function modelTag(o: Pick<ObjectiveView, "model" | "effort" | "modelBy" | "modelPending">): string | null {
  if (o.modelPending) return "waiting for the General's model pick";
  const m = [o.model, o.effort].filter(Boolean).join(" · ");
  return m ? `${m}${o.modelBy === "general" ? " (General's pick)" : ""}` : null;
}

export const upper = (s: string) => s.toUpperCase();

export function statusWord(a: AgentView): string {
  if (a.external) return a.status === "running" ? "ACTIVE" : "IDLE";
  if (a.teamLeadId) return a.status === "running" ? "ON TASK" : "STANDING BY";
  if (a.teamMode && a.status === "running") return "LEADING A TEAM";
  if (a.teamMode && a.pausedReason === "session_ended") return "SESSION ENDED";
  switch (a.status) {
    case "running":
      return "ON SORTIE";
    case "queued":
      return "QUEUED";
    case "paused":
      return a.pausedReason === "out_of_supply" ? "OUT OF SUPPLY" : "HOLDING";
    case "commanded":
      return "UNDER YOUR COMMAND";
    case "terminated":
      return "DISMISSED";
    default:
      return "STANDING BY";
  }
}

export type Tone = "ok" | "warn" | "bad" | "live" | "";

/** A short status for pills and the squad list: "Working", "Needs you", "Holding"… */
export function statusPill(a: AgentView, needsYou: boolean): { text: string; tone: Tone } {
  if (needsYou || a.activity === "needs_you") return { text: a.external ? "Waiting" : "Needs you", tone: "warn" };
  if (a.external) return a.status === "running" ? { text: "Active", tone: "live" } : { text: "Idle", tone: "" };
  if (a.teamLeadId) return a.status === "running" ? { text: "On task", tone: "live" } : { text: "Standing by", tone: "ok" };
  if (a.teamMode && a.status === "running") return { text: "Team live", tone: "live" };
  if (a.teamMode && a.pausedReason === "session_ended") return { text: "Session ended", tone: "" };
  switch (a.status) {
    case "running":
      return { text: "Working", tone: "live" };
    case "queued":
      return { text: "Queued", tone: "" };
    case "paused":
      return a.pausedReason === "out_of_supply" ? { text: "Out of supply", tone: "bad" } : { text: "Holding", tone: "warn" };
    case "commanded":
      return { text: "Your command", tone: "live" };
    case "terminated":
      return { text: "Dismissed", tone: "" };
    default:
      return { text: "Standing by", tone: "ok" };
  }
}

/** "09:34" */
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function supplyFraction(a: AgentView): number {
  if (a.budgetUsd === null || a.budgetUsd <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - a.spentUsd / a.budgetUsd));
}

/** An agent's share of the squad's tokens (usage mode). */
export function usageShare(a: AgentView, agents: AgentView[]): number {
  const total = agents.reduce((n, x) => n + (x.external ? 0 : x.tokensUsed), 0);
  return total > 0 ? a.tokensUsed / total : 0;
}

export const pct = (f: number) => `${Math.round(f * 100)}%`;

/** "2h 10m" until a unix-seconds reset time. */
export function untilReset(resetsAt: number | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const min = Math.round((resetsAt * 1000 - now) / 60_000);
  if (min <= 0) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${min % 60}m` : `${Math.round(h / 24)}d`;
}

/** Whether the login draws on a Claude subscription's plan usage. */
export const onSubscription = (c: { subscription: string | null; authMethod: string | null } | null) => Boolean(c && (c.subscription || c.authMethod === "claude.ai"));

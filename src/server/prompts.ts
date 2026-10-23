// Text War Room hands to Claude Code: the static system-prompt addendum
// (role + protocol + identity) and the per-wake user message.
import type { AgentView, MissionView, ObjectiveView, OrderView, TheaterView, WakeReason } from "../shared/protocol.js";
import type { RoleDef } from "./roles.js";

export const SORTIE_PROTOCOL = `## War Room sortie protocol
You are one agent in a War Room squad. War Room is the control plane: it holds the mission, the objectives (tasks) and the chain of command. The human Commander watches the squad on a map and approves sensitive actions. You are woken for a "sortie" (one run) when something needs you: an assignment, new orders, an approval decision, a subordinate's progress, or a patrol timer.

Every sortie:
1. Orders: call the warroom \`my_orders\` tool first. It tells you who you are, your open objectives and any new orders.
2. Checkout: call \`checkout_objective\` before working an objective. If it reports a conflict, pick a different objective. Never retry a conflict.
3. Work: do the work in your current directory with your normal tools.
4. Update: record progress with \`update_objective\`: a status plus a comment saying what you did and how you verified it.
   - \`in_review\`: work done; someone should check it.
   - \`done\`: nothing remains.
   - \`blocked\`: you're stuck; say what's blocking you and who can unblock it.
5. Delegate: when work belongs to someone else, \`create_objective\` for them with your objective as the parent. Don't trade long messages. Use \`radio\` only for brief coordination.
6. End the sortie with the next action written into your last update. Don't wait around or poll: War Room wakes you when something changes.

Tool permission prompts go to the Commander on the map. If a request is denied, adapt; don't retry the same action.`;

export const TEAM_PROTOCOL = `## War Room team protocol
You are a team lead in War Room, running as a live Claude Code session. The human Commander watches you and your teammates on a map. Messages that start with [WAR ROOM] come from the Commander through War Room: treat them as your orders.

In team mode your squad is your own Claude Code agent team. Spawn teammates with the Agent tool instead of creating War Room objectives for other agents or calling request_reinforcements.

1. Orders: call the warroom \`my_orders\` tool first, then \`checkout_objective\` for your objective.
2. Plan: read enough of the repo to split the work into independent pieces. Use the shared task list for them.
3. Team: spawn teammates with the Agent tool and a short lowercase \`name\` (it becomes their callsign on the map). Give each a self-contained brief and a \`model\` that fits its task (haiku for simple work, sonnet for most, opus for the hardest). Two to four teammates is usually right.
4. Ownership: every teammate shares your working directory. Give each teammate its own files so nobody overwrites anyone else's work.
5. Board: keep the Commander's board current with \`update_objective\` on your War Room objective (in_review when the work is ready for the Commander's check, done when finished) and short sitreps with \`report\`.
6. Merge: your team works on your branch. When the work is verified, review the diff and call \`request_merge\`. Merge only after the Commander approves.
7. Finish: when the mission is complete, shut your teammates down, mark your objective done and report.

Permission prompts from you and your teammates go to the Commander on the map. If one is denied, adapt; don't retry the same action.`;

export function buildInstructions(agent: AgentView, role: RoleDef, theater: TheaterView, superior: AgentView | null, mode: "sortie" | "team" = "sortie"): string {
  const workspace =
    agent.workspace.kind === "worktree"
      ? `your own git worktree at ${agent.workspace.path} on branch \`${agent.workspace.branch}\``
      : `the main checkout of the repo at ${agent.workspace.path}`;
  const chain = superior ? `You report to ${superior.letter} · ${superior.callsign} (${superior.role}).` : "You report directly to the Commander.";
  return [
    `# War Room: ${agent.letter} · ${agent.callsign}, ${role.title}`,
    "",
    role.instructions,
    "",
    mode === "team" ? TEAM_PROTOCOL : SORTIE_PROTOCOL,
    "",
    "## Your post",
    `- Callsign: ${agent.letter} · ${agent.callsign} (${role.name})`,
    `- ${chain}`,
    `- Workspace: ${workspace}.`,
    `- Theater: ${theater.name} (${theater.root}).`,
  ].join("\n");
}

const REASON_TEXT: Record<WakeReason, string> = {
  deploy: "you have just been deployed",
  assigned: "an objective was assigned to you",
  order: "new orders came in",
  approval: "the Commander decided on your request",
  child_done: "a delegated objective changed status",
  timer: "patrol check",
  manual: "the Commander woke you",
  model_pick: "the Commander wants you to choose models for new objectives",
};

/** How the General picks a model and effort per objective. */
export const MODEL_GUIDE = `Choose the cheapest setup that will do the job well:
- haiku, low: mechanical edits, renames, docs, simple lookups
- sonnet, medium: most features, fixes and tests
- opus, high: hard debugging, architecture, security reviews, tricky refactors
- opus, xhigh or max: only the hardest problems`;

export interface WakePromptInput {
  agent: AgentView;
  reasons: WakeReason[];
  notes: string[];
  mission: MissionView | null;
  objective: ObjectiveView | null;
  parent: ObjectiveView | null;
  orders: OrderView[];
  authorName: (author: string) => string;
  /** A message to a live team lead rather than the start of a sortie. */
  team?: boolean;
}

export function buildWakePrompt(w: WakePromptInput): string {
  const lines: string[] = [];
  lines.push(`[WAR ROOM${w.team ? "" : " · SORTIE"}] ${w.agent.letter} · ${w.agent.callsign}: ${w.reasons.map((r) => REASON_TEXT[r]).join("; ")}.`);
  if (w.mission) lines.push("", `Mission: ${w.mission.title}${w.mission.body ? `\n${w.mission.body}` : ""}`);
  if (w.objective) {
    const o = w.objective;
    lines.push("", `Your objective: #${o.number} "${o.title}" (status ${o.status}, priority ${o.priority})`);
    if (o.body) lines.push(o.body);
    if (o.targetPaths.length) lines.push(`Target: ${o.targetPaths.join(", ")}`);
    if (w.parent) lines.push(`Parent objective: #${w.parent.number} "${w.parent.title}"`);
  }
  for (const note of w.notes) lines.push("", note);
  if (w.orders.length) {
    lines.push("", "New orders:");
    for (const o of w.orders) lines.push(`- ${w.authorName(o.author)}: ${o.body}`);
  }
  if (w.team) {
    lines.push("", w.objective ? `Next: call my_orders, checkout_objective #${w.objective.number}, then plan the work and lead your team.` : "Next: call my_orders and act on what changed.");
    return lines.join("\n");
  }
  lines.push(
    "",
    w.objective
      ? `Begin: call my_orders, then checkout_objective #${w.objective.number}, then follow the sortie protocol.`
      : "Begin: call my_orders and follow the sortie protocol. If you have nothing to do, report readiness and end the sortie.",
  );
  return lines.join("\n");
}

export function formatLiveOrder(author: string, body: string): string {
  return `[WAR ROOM · ORDERS from ${author}] ${body}`;
}

import { useMemo } from "react";
import type { AgentView } from "../../shared/protocol";
import { pct, supplyFraction, tokens, usageShare } from "../lib/format";
import { isManaged, pendingApprovals, sortedAgents, useStore } from "../lib/store";
import { RoleGlyph } from "../map/MapView";
import { viewAgent } from "./viewAgent";

/** Left squad list, styled like the BF6 squad panel. */
export function Roster() {
  const agentsMap = useStore((s) => s.agents);
  const roles = useStore((s) => s.roles);
  const selected = useStore((s) => s.selectedAgentId);
  const approvals = useStore((s) => s.approvals);
  const fronts = useStore((s) => s.fronts);
  const usage = useStore((s) => s.settings?.supplyMode === "usage");
  const needs = useMemo(() => new Set(pendingApprovals(approvals).map((a) => a.agentId)), [approvals]);
  const all = sortedAgents(agentsMap);
  const squad = all.filter(isManaged);
  const watch = all.filter((a) => a.external);
  const working = all.filter((a) => !a.external);

  // Budget mode: supply left. Usage mode (and teams, which have no cap): each agent's share of the squad's tokens.
  const bar = (a: AgentView) =>
    usage || a.teamMode || a.teamLeadId
      ? { fill: usageShare(a, working), title: `${tokens(a.tokensUsed)} tokens · ${pct(usageShare(a, working))} of squad usage` }
      : { fill: supplyFraction(a), title: a.budgetUsd === null ? "No budget cap" : `Supply: $${a.spentUsd.toFixed(2)} of $${a.budgetUsd.toFixed(2)} used` };

  const pick = (id: string) => viewAgent(id);

  return (
    <div className="roster">
      <div className="roster-title">Agent Squad</div>
      <div className="roster-list scroll">
        {squad.length === 0 && <div className="roster-empty">No agents deployed. Pick the General below and press DEPLOY to start an operation.</div>}
        {squad.flatMap((a) => {
          const icon = roles.find((r) => r.id === a.role)?.icon ?? "star";
          const tag = needs.has(a.id) ? "NEEDS YOU" : a.teamMode && a.status === "running" ? "TEAM LIVE" : a.status === "running" ? "ACTIVE" : a.status === "paused" ? (a.pausedReason === "session_ended" ? "ENDED" : "HOLD") : "";
          const row = (
            <button key={a.id} className={`roster-row${a.id === selected ? " selected" : ""}${needs.has(a.id) ? " needs" : ""}`} onClick={() => pick(a.id)}>
              <RoleGlyph icon={icon} size={20} />
              <span className="badge">{a.letter}</span>
              <span className="divider" />
              <span className="name">
                {a.callsign}
                <small>{tag}</small>
              </span>
              <span className="bar" title={bar(a).title}>
                <i style={{ width: `${bar(a).fill * 100}%` }} />
              </span>
            </button>
          );
          // Teammates of a team lead, under their lead like BF6 squad mates.
          const mates = all.filter((m) => m.teamLeadId === a.id);
          return [
            row,
            ...mates.map((m) => (
              <button key={m.id} className={`roster-row mate${m.id === selected ? " selected" : ""}${needs.has(m.id) ? " needs" : ""}`} onClick={() => pick(m.id)} title={m.activityDetail ?? undefined}>
                <span className="badge">{m.letter}</span>
                <span className="divider" />
                <span className="name">
                  {m.callsign}
                  <small>{needs.has(m.id) ? "NEEDS YOU" : m.status === "running" ? "ACTIVE" : ""}</small>
                </span>
                <span className="bar" title={bar(m).title}>
                  <i style={{ width: `${bar(m).fill * 100}%` }} />
                </span>
              </button>
            )),
          ];
        })}
        {watch.length > 0 && <div className="roster-title dim">Watch-only units</div>}
        {watch.map((a) => (
          <button key={a.id} className={`roster-row ext${a.id === selected ? " selected" : ""}`} onClick={() => pick(a.id)} title={a.workspace.path}>
            <RoleGlyph icon="none" size={18} />
            <span className="badge">{a.letter}</span>
            <span className="divider" />
            <span className="name">
              {a.callsign}
              <small>{a.activity === "needs_you" ? "WAITING" : a.status === "running" ? "ACTIVE" : ""}</small>
            </span>
          </button>
        ))}
        {fronts.length > 0 && <div className="roster-title dim">Other fronts</div>}
        {fronts.slice(0, 5).map((f) => (
          <div key={f.cwd} className="front-row" title={f.cwd}>
            <span>{f.name}</span>
            <span>
              {f.sessions} session{f.sessions === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

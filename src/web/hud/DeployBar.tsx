import { useMemo } from "react";
import { pendingApprovals, squadOrder, useStore } from "../lib/store";
import { RoleGlyph } from "../map/MapView";
import { cycleAgent, viewAgent } from "./viewAgent";

/** Bottom center, in the place of BF6's class selector: your agents. Q / E or a click opens one's intel. */
export function DeployBar() {
  const agentsMap = useStore((s) => s.agents);
  const roles = useStore((s) => s.roles);
  const selected = useStore((s) => s.selectedAgentId);
  const approvals = useStore((s) => s.approvals);
  const needs = useMemo(() => new Set(pendingApprovals(approvals).map((a) => a.agentId)), [approvals]);
  const list = squadOrder(agentsMap);
  const current = list.find((a) => a.id === selected);
  const roleOf = (role: string) => roles.find((r) => r.id === role);
  const caption = current
    ? `${current.letter} · ${current.callsign} · ${current.teamLeadId ? "teammate" : (roleOf(current.role)?.title ?? current.role)}`
    : list.length
      ? "Q / E to view your agents"
      : "Press SPACE to deploy your first agent";
  return (
    <div className="deploy-dock">
      <div className="deploy-bar" role="listbox" aria-label="Your agents">
        <button className="key" disabled={!list.length} onClick={() => cycleAgent(-1)} aria-label="Previous agent">
          Q
        </button>
        {list.map((a) => (
          <button
            key={a.id}
            role="option"
            aria-selected={a.id === selected}
            className={`role-cell agent-cell${a.id === selected ? " active" : ""}${a.teamLeadId ? " mate" : ""}${needs.has(a.id) ? " needs" : ""}`}
            title={`${a.letter} · ${a.callsign}`}
            onClick={() => viewAgent(a.id)}
          >
            <RoleGlyph icon={a.teamLeadId ? "none" : (roleOf(a.role)?.icon ?? "star")} size={a.teamLeadId ? 18 : 26} />
            <span className="cell-letter">{a.letter}</span>
          </button>
        ))}
        <button className="key" disabled={!list.length} onClick={() => cycleAgent(1)} aria-label="Next agent">
          E
        </button>
      </div>
      <div className="role-caption">{caption.toUpperCase()}</div>
    </div>
  );
}

export function DeployButton() {
  const set = useStore((s) => s.set);
  const orbit = useStore((s) => s.view === "orbit");
  // In orbit the big button launches satellites (scheduled tasks) instead of agents.
  if (orbit)
    return (
      <button className="deploy-btn tick-frame launch" onClick={() => set({ launchOpen: true, launchEdit: null })}>
        <span>
          LAUNCH<span className="key">SPACE</span>
        </span>
      </button>
    );
  return (
    <button className="deploy-btn tick-frame" onClick={() => set({ deployOpen: true, selectedRole: null })}>
      <span>
        DEPLOY<span className="key">SPACE</span>
      </span>
    </button>
  );
}

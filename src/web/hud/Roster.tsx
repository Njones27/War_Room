import { useMemo, useState } from "react";
import { OPEN_OBJECTIVE_STATUSES, type AgentView, type ApprovalView } from "../../shared/protocol";
import { statusPill } from "../lib/format";
import { isManaged, pendingApprovals, sortedAgents, useStore } from "../lib/store";
import { RoleGlyph } from "../map/MapView";
import { Icon } from "./icons";
import { Rich } from "./Rich";
import { viewAgent } from "./viewAgent";

const COLLAPSED_KEY = "warroom.squad-collapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Left squad list: each agent's status and what it's working on. Collapses to its header. */
export function Roster() {
  const agentsMap = useStore((s) => s.agents);
  const roles = useStore((s) => s.roles);
  const objectives = useStore((s) => s.objectives);
  const selected = useStore((s) => s.selectedAgentId);
  const approvals = useStore((s) => s.approvals);
  const fronts = useStore((s) => s.fronts);
  const set = useStore((s) => s.set);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const asks = useMemo(() => {
    const m = new Map<string, ApprovalView>();
    for (const a of pendingApprovals(approvals)) if (a.agentId && !m.has(a.agentId)) m.set(a.agentId, a);
    return m;
  }, [approvals]);
  const all = sortedAgents(agentsMap);
  const squad = all.filter(isManaged);
  const watch = all.filter((a) => a.external);

  // What the row's second line says: the request waiting on you, else the objective, else the latest activity.
  const task = (a: AgentView): { num: string | null; text: string } => {
    const ask = asks.get(a.id);
    if (ask) return { num: null, text: ask.title.replace(/^[A-Z]{1,2}·\S+\s/, "") };
    const o = (a.objectiveId ? objectives[a.objectiveId] : undefined) ?? Object.values(objectives).find((x) => x.assigneeId === a.id && OPEN_OBJECTIVE_STATUSES.includes(x.status));
    if (o) return { num: `#${o.number}`, text: o.title };
    return { num: null, text: a.status === "running" && a.activityDetail ? a.activityDetail : "No objective" };
  };

  const row = (a: AgentView, kind: "lead" | "mate" | "ext") => {
    const needs = asks.has(a.id) || a.activity === "needs_you";
    const st = statusPill(a, asks.has(a.id));
    const t = kind === "ext" ? { num: null, text: a.workspace.path } : task(a);
    const role = roles.find((r) => r.id === a.role);
    return (
      <button
        key={a.id}
        className={`squad-row${kind === "lead" ? "" : ` ${kind}`}${a.id === selected ? " selected" : ""}${needs ? " needs" : ""}`}
        onClick={() => viewAgent(a.id)}
        title={kind === "ext" ? a.workspace.path : undefined}
      >
        <RoleGlyph icon={kind === "ext" ? "none" : kind === "mate" ? "none" : (role?.icon ?? "star")} size={18} />
        <span className="nm">
          <b>{a.callsign}</b>
          <span>
            {a.letter} · {kind === "ext" ? "watching" : kind === "mate" ? "teammate" : (role?.name ?? a.role)}
          </span>
        </span>
        <span className={`st ${needs ? "need" : st.tone === "live" ? "live" : st.tone === "warn" || st.tone === "bad" ? "warn" : ""}`}>
          <i />
          {st.text}
        </span>
        <span className="task">
          {t.num && <span className="mono">{t.num}</span>}
          <span>
            <Rich text={t.text} />
          </span>
        </span>
      </button>
    );
  };

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  // Collapsed, the header still says who's working and who's waiting on you.
  const working = squad.filter((a) => a.status === "running").length;
  const waiting = squad.filter((a) => asks.has(a.id) || a.activity === "needs_you").length;

  return (
    <div className="roster">
      <div className={`roster-panel${collapsed ? " collapsed" : ""}`}>
        <div className="roster-head">
          <button className="roster-title" aria-expanded={!collapsed} aria-controls="squad-list" title={collapsed ? "Show the squad" : "Hide the squad"} onClick={toggle}>
            <h2>Squad</h2>
            <span className="count">{squad.length}</span>
            {collapsed && (
              <span className="roster-summary">
                {waiting > 0 && <span className="need">{waiting} need you</span>}
                {working > 0 && <span className="live">{working} working</span>}
              </span>
            )}
          </button>
          <button className="icon-btn" aria-label="Deploy an agent" title="Deploy an agent (Space)" onClick={() => set({ deployOpen: true, selectedRole: null })}>
            <Icon name="plus" />
          </button>
          <button className="icon-btn" aria-label={collapsed ? "Expand the squad list" : "Collapse the squad list"} title={collapsed ? "Show the squad" : "Hide the squad"} onClick={toggle}>
            <Icon name={collapsed ? "chevUp" : "chevDown"} />
          </button>
        </div>
        <div className="roster-list scroll" id="squad-list" hidden={collapsed}>
          {squad.length === 0 && <div className="roster-empty">No agents yet. Deploy a General to start an operation.</div>}
          {squad.flatMap((a) => [row(a, "lead"), ...all.filter((m) => m.teamLeadId === a.id).map((m) => row(m, "mate"))])}
          {watch.length > 0 && <div className="roster-sec">Watching · {watch.length}</div>}
          {watch.map((a) => row(a, "ext"))}
          {fronts.length > 0 && <div className="roster-sec">Other fronts</div>}
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
    </div>
  );
}

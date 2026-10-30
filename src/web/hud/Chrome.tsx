import { useMemo } from "react";
import type { PermissionOverride, SupplyMode, UsageWindow } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { onSubscription, pct, untilReset, usd } from "../lib/format";
import { isManaged, markerState, pendingApprovals, sortedAgents, useStore } from "../lib/store";
import { mapRef } from "../map/mapRef";
import { toggleOrbit } from "../map/OrbitView";

/** Screen furniture: ruler, dot fields, vignette, and the corner zoom buttons. */
export function Frame() {
  const zoom = (factor: number) => (useStore.getState().view === "orbit" ? mapRef.orbit?.zoomBy(factor) : mapRef.map?.zoomBy(factor));
  return (
    <>
      <div className="frame" aria-hidden>
        <div className="vignette" />
        <div className="dots" style={{ left: "13rem", top: "13rem", width: "9rem", height: "6rem" }} />
        <div className="dots" style={{ right: "14rem", top: "9rem", width: "7rem", height: "3rem" }} />
        <div className="dots" style={{ left: "16rem", bottom: "16rem", width: "6rem", height: "8rem" }} />
        <div className="dots" style={{ right: "28rem", bottom: "20rem", width: "10rem", height: "4rem" }} />
        <div className="ruler" />
      </div>
      <button className="corner" style={{ left: "2.2rem" }} title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.8)}>
        +
      </button>
      <button className="corner" style={{ left: "4.8rem" }} title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.25)}>
        −
      </button>
      <button className="corner settings-btn" title="Settings (P)" aria-label="Settings" onClick={() => useStore.getState().set({ settingsOpen: true })}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 9a3 3 0 110 6 3 3 0 010-6z" />
          <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
        </svg>
      </button>
      <button className="corner" style={{ right: "4.8rem" }} title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.25)}>
        −
      </button>
      <button className="corner" style={{ right: "2.2rem" }} title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.8)}>
        +
      </button>
    </>
  );
}

function WarRoomEmblem() {
  return (
    <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden>
      <path d="M24 5l15 5.5v11c0 9.6-6.3 17.8-15 21-8.7-3.2-15-11.4-15-21v-11z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15 16l18 18M33 16L15 34" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
      <path d="M13 14h5v5M35 14h-5v5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M21 31l-4 4M27 31l4 4" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

function CorpsEmblem() {
  return (
    <svg viewBox="0 0 22 16" width="44" height="32" shapeRendering="crispEdges" aria-hidden>
      <rect x="4" y="2" width="14" height="9" fill="currentColor" />
      <rect x="2" y="6" width="2" height="2" fill="currentColor" />
      <rect x="18" y="6" width="2" height="2" fill="currentColor" />
      <rect x="7" y="4" width="1" height="2" fill="#0c151b" />
      <rect x="14" y="4" width="1" height="2" fill="#0c151b" />
      <rect x="5" y="11" width="1" height="3" fill="currentColor" />
      <rect x="7" y="11" width="1" height="3" fill="currentColor" />
      <rect x="14" y="11" width="1" height="3" fill="currentColor" />
      <rect x="16" y="11" width="1" height="3" fill="currentColor" />
    </svg>
  );
}

function WheelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="7" y="3" width="10" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v4" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function DragIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="7" y="5" width="10" height="16" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 1v3M9 2.5h6M2 13h3M19 13h3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function Header() {
  const theater = useStore((s) => s.theater);
  const pingMode = useStore((s) => s.pingMode);
  const orbit = useStore((s) => s.view === "orbit");
  const satCount = useStore((s) => Object.keys(s.satellites).length);
  const set = useStore((s) => s.set);
  return (
    <>
      <div className="hud-header">
        <div className="emblem">
          <WarRoomEmblem />
        </div>
        <div>
          <div className="hud-title">WAR ROOM</div>
          <div className="hud-sub">
            OPERATION: {(theater?.name ?? "…").toUpperCase()}
            {theater?.branch ? ` · ${theater.branch.toUpperCase()}` : ""}
          </div>
        </div>
      </div>
      <div className="hud-hints">
        <div className="hint">
          <WheelIcon /> ZOOM
        </div>
        <div className="hint">
          <DragIcon /> {orbit ? "ROTATE" : "PAN"}
        </div>
        <button className="hint orbit-hint" onClick={() => toggleOrbit()}>
          <span className="key">G</span> {orbit ? "BACK TO CITY" : `ORBIT${satCount ? ` · ${satCount}` : ""}`}
        </button>
        {!orbit && (
          <button className={`hint${pingMode ? " active" : ""}`} onClick={() => set({ pingMode: !pingMode })}>
            <span className="key">Z</span> PING
          </button>
        )}
        <button className="hint" onClick={() => (orbit ? mapRef.orbit?.resetCamera() : mapRef.map?.resetCamera())}>
          <span className="key">R</span> RESET CAMERA
        </button>
        <button className="hint" onClick={() => set({ objectivesOpen: true })}>
          <span className="key">O</span> OBJECTIVES
        </button>
        <button className="hint" onClick={() => set({ settingsOpen: true })}>
          <span className="key">P</span> SETTINGS
        </button>
      </div>
    </>
  );
}

/** Top center: one icon per agent (click to select) and the active mission. */
export function ScoreBar() {
  const agentsMap = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals);
  const missions = useStore((s) => s.missions);
  const selected = useStore((s) => s.selectedAgentId);
  const select = useStore((s) => s.select);
  const needs = useMemo(() => new Set(pendingApprovals(approvals).map((a) => a.agentId)), [approvals]);
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const mission = missions.find((m) => m.status === "active");
  return (
    <div className="scorebar">
      <div className="objective-row">
        {agents.map((a) => {
          const st = markerState(a, needs.has(a.id));
          const shape = st === "needs" || st === "error" ? "diamond" : st === "working" ? "circle" : "square";
          return (
            <button key={a.id} className={`obj-icon ${shape}${a.id === selected ? " sel" : ""}`} title={`${a.letter} · ${a.callsign}`} onClick={() => select(a.id === selected ? null : a.id)}>
              <span>{a.letter}</span>
            </button>
          );
        })}
      </div>
      <div className="mission-line">{mission ? mission.title : agents.length ? "Awaiting orders from the Commander" : "Deploy a General to begin the operation"}</div>
    </div>
  );
}

export function Faction() {
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.set);
  const count = Object.values(agents).filter((a) => isManaged(a) && a.status !== "terminated").length;
  const mates = Object.values(agents).filter((a) => a.teamLeadId).length;
  const ext = Object.values(agents).filter((a) => a.external).length;
  return (
    <div className="faction-col">
      <div className="faction">
        <div>
          <div className="hud-title">CLAUDE CORPS</div>
          <div className="hud-sub">
            OPERATIONAL AGENTS: {count}
            {mates ? ` · TEAMMATES ${mates}` : ""}
            {ext ? ` · WATCHING ${ext}` : ""}
          </div>
          {settings?.demo && <div className="demo-tag">DEMO · SIMULATED SQUAD · NO CLAUDE USAGE</div>}
        </div>
        <div className="emblem" style={{ color: "var(--text-dim)" }}>
          <CorpsEmblem />
        </div>
      </div>
      <div className="side-stack">
        <button className="manage-btn" onClick={() => set({ manageOpen: true })}>
          MANAGE AGENTS
        </button>
        <Supply />
        <Comms />
      </div>
    </div>
  );
}

function PlanWindow({ label, name, w }: { label: string; name: string; w: UsageWindow | null }) {
  // A window whose reset time has passed starts over.
  const u = w ? (w.resetsAt !== null && w.resetsAt * 1000 < Date.now() ? 0 : w.utilization) : null;
  const level = u === null ? "" : u >= 0.9 ? " hot" : u >= 0.7 ? " warn" : "";
  const reset = untilReset(w?.resetsAt ?? null);
  return (
    <span className={`plan-win${level}`} title={u === null ? `${name}: no reading yet` : `${name}: ${pct(u)} used${reset && reset !== "now" ? ` · resets in ${reset}` : ""}`}>
      {label}
      <i>
        <b style={{ width: `${Math.min(1, u ?? 0) * 100}%` }} />
      </i>
      {u === null ? "—" : pct(u)}
    </span>
  );
}

/** BUDGET (per-agent dollar caps) or USAGE (no caps; your plan's usage limits apply). */
function Supply() {
  const settings = useStore((s) => s.settings);
  const check = useStore((s) => s.commsCheck);
  const agentsMap = useStore((s) => s.agents);
  if (!settings) return null;
  const mode = settings.supplyMode;
  const squad = Object.values(agentsMap).filter(isManaged);
  const spent = squad.reduce((n, a) => n + a.spentUsd, 0);
  const capped = squad.length > 0 && squad.every((a) => a.budgetUsd !== null && !a.teamMode);
  const caps = squad.reduce((n, a) => n + (a.budgetUsd ?? 0), 0);
  const rl = check?.rateLimit ?? null;
  const choose = (m: SupplyMode) => {
    if (m !== mode) void act(() => api.settings({ supplyMode: m }), m === "usage" ? "Budget caps off: agents draw on your plan usage" : "Budget caps on");
  };
  let line;
  if (mode === "budget") line = <span>SPENT {usd(spent)}{capped ? ` OF ${usd(caps)}` : ""}</span>;
  else if (settings.demo) line = <span className="dim">DEMO · NO PLAN USAGE</span>;
  else if (!onSubscription(check)) line = <span className="warn-text">API KEY · NO CAP · BILLED PER TOKEN</span>;
  else if (rl && (rl.fiveHour || rl.sevenDay)) {
    line = (
      <>
        <PlanWindow label="5H" name="5-hour window" w={rl.fiveHour} />
        <PlanWindow label="7D" name="Weekly window" w={rl.sevenDay} />
      </>
    );
  } else line = <span className="dim">PLAN USAGE SHOWS AFTER THE FIRST SORTIE</span>;
  return (
    <div className="supply">
      <div className="supply-row">
        <span>SUPPLY</span>
        <div className="seg" role="radiogroup" aria-label="Supply mode">
          <button role="radio" aria-checked={mode === "budget"} className={mode === "budget" ? "on" : ""} title="Per-agent dollar caps on Claude Code's cost estimate" onClick={() => choose("budget")}>
            BUDGET
          </button>
          <button role="radio" aria-checked={mode === "usage"} className={mode === "usage" ? "on" : ""} title="No caps: agents draw on your plan's usage limits" onClick={() => choose("usage")}>
            USAGE
          </button>
        </div>
      </div>
      <div className="supply-line">{line}</div>
    </div>
  );
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit",
  overage: "extra usage",
};

export function Comms() {
  const comms = useStore((s) => s.comms);
  const selected = useStore((s) => s.selectedAgentId);
  // The intel panel takes this space; its FEED tab carries the detail.
  if (selected) return null;
  const recent = comms.slice(-6);
  return (
    <div className="comms" aria-live="polite">
      {recent.map((c) => (
        <div key={c.id} className={`comms-line k-${c.kind}`}>
          {c.text}
        </div>
      ))}
    </div>
  );
}

const PERMISSION_MODES: { id: PermissionOverride; label: string; tip: string }[] = [
  {
    id: "auto",
    label: "AUTO",
    tip: "Claude Code's auto mode (its default): a classifier approves routine actions and anything it blocks comes to you. Sessions that can't use auto start in Manual.",
  },
  { id: "plan", label: "PLAN", tip: "Agents research and propose without editing. Plans come to you for approval." },
  { id: "manual", label: "MANUAL", tip: "Agents ask before edits, commands and network access; every request comes to you on the map." },
];

/** Bottom left: the permission mode every agent runs in. */
export function PermissionsBar() {
  const mode = useStore((s) => s.settings?.permissionMode);
  if (!mode) return null;
  const choose = (m: PermissionOverride) => {
    if (m !== mode) void act(() => api.settings({ permissionMode: m }), `Permissions: ${m.toUpperCase()} from each agent's next sortie`);
  };
  return (
    <div className="perm-bar">
      <span>PERMISSIONS</span>
      <div className="seg" role="radiogroup" aria-label="Permission mode for every agent">
        {PERMISSION_MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={m.id === mode} className={m.id === mode ? "on" : ""} title={m.tip} onClick={() => choose(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ZoomBox() {
  const pct = useStore((s) => s.zoomPct);
  const orbit = useStore((s) => s.view === "orbit");
  return <div className="zoom-box">{orbit ? "ORBIT" : `${pct}%`}</div>;
}

export function Banner() {
  const check = useStore((s) => s.commsCheck);
  const settings = useStore((s) => s.settings);
  const connected = useStore((s) => s.connected);
  const ready = useStore((s) => s.ready);
  if (ready && !connected) return <div className="banner">CONNECTION LOST · RECONNECTING…</div>;
  if (!check || settings?.demo) return null;
  if (!check.claudeFound || check.loggedIn === false) {
    return (
      <div className="banner">
        COMMS DOWN · {check.error ?? "Claude Code unavailable"}
        <button className="btn" onClick={() => void act(() => api.commsCheck())}>
          RECHECK
        </button>
      </div>
    );
  }
  const rl = check.rateLimit;
  // A reading from a window that has since reset no longer applies.
  if (rl && rl.status !== "allowed" && (rl.resetsAt === null || rl.resetsAt * 1000 > Date.now())) {
    const reset = untilReset(rl.resetsAt);
    return (
      <div className="banner">
        {rl.status === "rejected" ? "USAGE LIMIT REACHED" : "NEARING USAGE LIMIT"} · {(rl.type && LIMIT_NAMES[rl.type]) ?? "plan limit"}
        {reset ? ` · resets in ${reset}` : ""}
      </div>
    );
  }
  return null;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Locked() {
  const authError = useStore((s) => s.authError);
  if (!authError) return null;
  return (
    <div className="locked">
      <div>
        <h1>WAR ROOM LOCKED</h1>
        <p>Open the command link printed in the terminal where you started War Room. It carries a one-time token that unlocks this browser.</p>
      </div>
    </div>
  );
}

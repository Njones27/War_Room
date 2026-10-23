import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentView, FeedItem } from "../../shared/protocol";
import { OPEN_OBJECTIVE_STATUSES } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { ago, modelTag, pct, statusWord, supplyFraction, tokens, usageShare, usd } from "../lib/format";
import { DEFAULT_INTEL_SIZE, pendingApprovals, saveIntelSize, useStore, type IntelTab } from "../lib/store";
import { CAMO_PALETTE } from "../map/camo";
import { locate } from "../map/engine";
import { mapRef } from "../map/mapRef";
import { Mascot } from "../sprites/Mascot";

/** The BF6 camera-switch effect: a burst of blocky pixel noise that clears. */
function Glitch() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const w = (c.width = c.clientWidth);
    const h = (c.height = c.clientHeight);
    const tones = [...CAMO_PALETTE, "#55646f", "#8b9aa5", "#c9d2d6", "#3f5a4a"];
    let frame = 0;
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const density = Math.max(0, 1 - frame / 16);
      if (density <= 0) return;
      for (let i = 0; i < 260 * density; i++) {
        const bw = 6 + Math.random() * 60;
        const bh = 3 + Math.random() * 12;
        ctx.globalAlpha = 0.5 + Math.random() * 0.5;
        ctx.fillStyle = tones[Math.floor(Math.random() * tones.length)]!;
        ctx.fillRect(Math.floor((Math.random() * w) / 4) * 4, Math.floor((Math.random() * h) / 3) * 3, bw, bh);
      }
      ctx.globalAlpha = 1;
      frame++;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="cam-glitch" />;
}

function Meter({ label, value, text, kind }: { label: string; value: number; text: string; kind?: "ctx" }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <span className={`track${kind === "ctx" ? " ctx" : ""}`}>
        <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </span>
      <span>{text}</span>
    </div>
  );
}

function FeedTab({ agent }: { agent: AgentView }) {
  const feed = useStore((s) => s.feed[agent.id]) ?? [];
  const live = useStore((s) => s.live[agent.id]) ?? "";
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed.length, live]);
  const render = (f: FeedItem) => {
    const time = new Date(f.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
      <div key={f.id} className={`feed-item k-${f.kind}${f.isError ? " err" : ""}`}>
        {f.kind !== "tool_result" && f.kind !== "tool_use" && <span className="t">{time}</span>}
        {f.text}
      </div>
    );
  };
  return (
    <div
      ref={ref}
      className="feed scroll"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {feed.length === 0 && !live && <div className="empty">No radio traffic yet. Activity from this agent's sorties streams here.</div>}
      {feed.map(render)}
      {live && <div className="feed-live">{live}</div>}
    </div>
  );
}

function TeamTasks({ agent }: { agent: AgentView }) {
  if (!agent.teamTasks.length) return null;
  const order = { in_progress: 0, pending: 1, completed: 2 };
  return (
    <>
      <div className="obj-section">TEAM TASKS · {agent.teamTasks.filter((t) => t.status === "completed").length}/{agent.teamTasks.length} DONE</div>
      {[...agent.teamTasks]
        .sort((a, b) => order[a.status] - order[b.status])
        .map((t) => (
          <div key={t.id} className="obj-card">
            <div className="row1">
              <span>{t.subject}</span>
              <span className={`status-chip st-${t.status === "completed" ? "done" : t.status === "in_progress" ? "in_progress" : "todo"}`}>{t.status.replace("_", " ").toUpperCase()}</span>
            </div>
            {t.owner && <div className="row2">◆ {t.owner}</div>}
          </div>
        ))}
    </>
  );
}

function ObjectivesTab({ agent }: { agent: AgentView }) {
  const objectives = useStore((s) => s.objectives);
  const orders = useStore((s) => s.orders);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  if (agent.teamLeadId) {
    return (
      <div className="obj-list scroll">
        <TeamTasks agent={agent} />
        {agent.teamTasks.length === 0 && <div className="empty">No team tasks claimed. Teammates take work from their lead's shared task list.</div>}
      </div>
    );
  }
  const mine = Object.values(objectives)
    .filter((o) => o.assigneeId === agent.id)
    .sort((a, b) => Number(OPEN_OBJECTIVE_STATUSES.includes(b.status)) - Number(OPEN_OBJECTIVE_STATUSES.includes(a.status)) || b.updatedAt - a.updatedAt)
    .slice(0, 20);
  const lastReport = (id: string) => [...orders].reverse().find((o) => o.objectiveId === id && o.author === agent.id);
  return (
    <div className="obj-list scroll">
      {!agent.external && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            void act(() => api.createObjective({ title, assignee: agent.id, targetPaths: target.trim() ? [target.trim()] : [] }), "Objective assigned").then(() => {
              setTitle("");
              setTarget("");
            });
          }}
        >
          <input placeholder="New objective for this agent…" value={title} onChange={(e) => setTitle(e.target.value)} />
          {title && <input placeholder="Target path (optional), e.g. src/auth" value={target} onChange={(e) => setTarget(e.target.value)} />}
        </form>
      )}
      {mine.length === 0 && !agent.teamTasks.length && <div className="empty">No objectives assigned.</div>}
      {mine.map((o) => {
        const report = lastReport(o.id);
        return (
          <div key={o.id} className="obj-card">
            <div className="row1">
              <span>
                #{o.number} {o.title}
              </span>
              <span className={`status-chip st-${o.status}`}>{o.status.replace("_", " ").toUpperCase()}</span>
            </div>
            {o.targetPaths.length > 0 && <div className="row2">⌖ {o.targetPaths.join(", ")}</div>}
            {modelTag(o) && <div className={`row2 model-tag${o.modelPending ? " pending" : ""}`}>◆ {modelTag(o)}</div>}
            {report && <div className="row2">“{report.body.slice(0, 220)}{report.body.length > 220 ? "…" : ""}”</div>}
            {!agent.external && OPEN_OBJECTIVE_STATUSES.includes(o.status) && (
              <div className="actions">
                {o.status === "in_review" && (
                  <button className="btn cyan" onClick={() => void act(() => api.updateObjective(o.id, { status: "done" }))}>
                    MARK DONE
                  </button>
                )}
                <button className="btn" onClick={() => void act(() => api.updateObjective(o.id, { status: "cancelled" }))}>
                  CANCEL
                </button>
              </div>
            )}
          </div>
        );
      })}
      <TeamTasks agent={agent} />
    </div>
  );
}

function FilesTab({ agent }: { agent: AgentView }) {
  const [files, setFiles] = useState<{ path: string; tool: string; at: number }[]>([]);
  const city = useStore((s) => s.city);
  useEffect(() => {
    if (agent.external) {
      setFiles([]);
      return;
    }
    let alive = true;
    const load = () => void api.files(agent.id).then((f) => alive && setFiles(f), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agent.id, agent.external]);
  return (
    <div className="files-list scroll">
      {files.length === 0 && <div className="empty">{agent.external ? "File history isn't tracked for watch-only units." : "No files touched yet."}</div>}
      {files.map((f) => (
        <button
          key={f.path}
          className="file-row"
          onClick={() => {
            const at = city ? locate(city, f.path) : null;
            if (at) mapRef.map?.focus(at.x, at.z);
          }}
        >
          <span>
            {f.tool === "Edit" || f.tool === "Write" || f.tool === "MultiEdit" ? "✎ " : "· "}
            {f.path || "/"}
          </span>
          <span>{ago(f.at)}</span>
        </button>
      ))}
    </div>
  );
}

function TerminalTab({ agent }: { agent: AgentView }) {
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.set);
  const [session, setSession] = useState<{ command: string | null } | null>(null);
  useEffect(() => {
    if (agent.external) return;
    void api.session(agent.id).then(setSession, () => setSession(null));
  }, [agent.id, agent.external, agent.status]);
  if (agent.external) {
    return (
      <div className="term-intro">
        This is a Claude Code session you started yourself. War Room only watches it; open it from its own terminal.
        <code>{agent.workspace.path}</code>
      </div>
    );
  }
  if (agent.teamLeadId || agent.teamMode) {
    const leadId = agent.teamLeadId ?? agent.id;
    const live = agent.teamLeadId ? true : agent.status === "running";
    return (
      <div className="term-intro">
        <div>
          {agent.teamLeadId
            ? "Teammates run inside their lead's Claude Code session. Open it to watch the whole team, or pick this teammate in its agent panel to talk to it directly."
            : "This team lead is a live Claude Code session; its teammates run inside it. Type to it directly, answer prompts, or pick a teammate in the agent panel."}
        </div>
        <div className="actions">
          {live ? (
            <button className="btn primary" disabled={settings?.demo} onClick={() => set({ terminalFor: leadId })}>
              {agent.teamLeadId ? "OPEN LEAD'S TERMINAL" : "OPEN TEAM TERMINAL"}
            </button>
          ) : (
            <button className="btn primary" onClick={() => void act(() => api.resume(agent.id), "Bringing the team lead back")}>
              RESUME SESSION
            </button>
          )}
        </div>
        {settings?.demo && <div>Demo teams are simulated, so there's no terminal.</div>}
        {!live && <div>The session ended. RESUME brings the lead back with its conversation; teammates don't survive a restart.</div>}
      </div>
    );
  }
  return (
    <div className="term-intro">
      <div>TAKE COMMAND opens this agent's real Claude Code session (the interactive TUI) right here. War Room holds the agent's sorties until you release it.</div>
      <div className="actions">
        <button
          className="btn primary"
          disabled={!settings?.takeCommandAvailable || agent.status === "running"}
          onClick={() => set({ terminalFor: agent.id })}
          title={agent.status === "running" ? "Wait for the sortie to end, or recall it" : undefined}
        >
          {agent.status === "commanded" ? "OPEN TERMINAL" : "TAKE COMMAND"}
        </button>
      </div>
      {!settings?.takeCommandAvailable && <div>{settings?.demo ? "Unavailable in demo mode." : "Needs the optional node-pty dependency (npm install)."}</div>}
      {session?.command && (
        <>
          <div>Or continue it in your own terminal:</div>
          <code>{session.command}</code>
        </>
      )}
    </div>
  );
}

function OrdersBox({ agent }: { agent: AgentView }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const set = useStore((s) => s.set);
  if (agent.external) return null;
  const mate = agent.teamLeadId !== null;
  const team = agent.teamMode;
  const live = team && agent.status === "running";
  const sentMsg = mate ? "Orders relayed through the lead" : live ? "Orders typed into the team session" : agent.status === "running" ? "Orders delivered live" : "Orders queued; agent is waking";
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await act(() => api.order(agent.id, text.trim()), sentMsg);
    setBusy(false);
    if (ok) setText("");
  };
  const paused = agent.status === "paused";
  return (
    <div className="orders-box">
      <div className="orders-input">
        <textarea
          rows={2}
          placeholder={mate ? `Orders for ${agent.letter} · ${agent.callsign} (relayed by its lead)…` : `Orders for ${agent.letter} · ${agent.callsign}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            e.stopPropagation();
          }}
        />
        <button disabled={!text.trim() || busy} onClick={() => void send()}>
          SEND ⏎
        </button>
      </div>
      <div className="actions">
        {mate ? null : team ? (
          !live && (
            <button className="btn" onClick={() => void act(() => api.resume(agent.id), "Bringing the team lead back")}>
              RESUME
            </button>
          )
        ) : (
          <>
            <button className="btn" disabled={agent.status === "running" || paused} onClick={() => void act(() => api.wake(agent.id), "Waking")}>
              WAKE
            </button>
            <button className="btn" onClick={() => void act(() => (paused || agent.pausedReason ? api.resume(agent.id) : api.pause(agent.id)))}>
              {paused || agent.pausedReason ? "RESUME" : "HOLD"}
            </button>
          </>
        )}
        {!mate && (
          <button className="btn" disabled={agent.status !== "running"} title={team ? "Interrupt the lead (its teammates keep working)" : undefined} onClick={() => void act(() => api.recall(agent.id), team ? "Lead interrupted" : "Recalled")}>
            RECALL
          </button>
        )}
        <button className="btn cyan" onClick={() => set({ intelTab: "terminal" })}>
          TERMINAL
        </button>
        {!mate && (
        <button
          className="btn danger"
          onClick={() => {
            const wt = agent.workspace.kind === "worktree";
            if (!window.confirm(`Dismiss ${agent.letter} · ${agent.callsign}? Open objectives go back to the board.${wt ? "\n\nIts worktree is removed only if it has no uncommitted changes; the branch is kept." : ""}`)) return;
            void act(() => api.dismiss(agent.id, wt), "Agent dismissed");
          }}
        >
          DISMISS
        </button>
        )}
      </div>
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Drag the panel's left edge, top edge or top-left corner to resize it (sizes in rem). */
function startResize(e: React.PointerEvent, panel: HTMLElement | null, axis: "w" | "h" | "wh"): void {
  if (!panel || e.button !== 0) return;
  e.preventDefault();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const rect = panel.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, w: rect.width / rem, h: rect.height / rem };
  // Keep the roster on the left and the DEPLOY button below in view.
  const maxW = Math.max(DEFAULT_INTEL_SIZE.w, window.innerWidth / rem - 32);
  const maxH = Math.max(20, window.innerHeight / rem - 15.3);
  const move = (ev: PointerEvent) => {
    const { intelSize, set } = useStore.getState();
    const w = axis === "h" ? intelSize.w : clamp(start.w + (start.x - ev.clientX) / rem, 20, maxW);
    const h = axis === "w" ? intelSize.h : clamp(start.h + (start.y - ev.clientY) / rem, 20, maxH);
    set({ intelSize: { w: Math.round(w * 10) / 10, h: h === null ? null : Math.round(h * 10) / 10 } });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    delete document.body.dataset.resize;
    saveIntelSize(useStore.getState().intelSize);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  document.body.dataset.resize = axis;
}

const TABS: { id: IntelTab; label: string }[] = [
  { id: "feed", label: "FEED" },
  { id: "objectives", label: "OBJECTIVES" },
  { id: "files", label: "FILES" },
  { id: "terminal", label: "TERMINAL" },
];

export function IntelPanel() {
  const id = useStore((s) => s.selectedAgentId);
  const agent = useStore((s) => (id ? s.agents[id] : undefined));
  const roles = useStore((s) => s.roles);
  const objectives = useStore((s) => s.objectives);
  const approvals = useStore((s) => s.approvals);
  const tab = useStore((s) => s.intelTab);
  const usage = useStore((s) => s.settings?.supplyMode === "usage");
  const agentsMap = useStore((s) => s.agents);
  const size = useStore((s) => s.intelSize);
  const full = useStore((s) => s.intelFull);
  const set = useStore((s) => s.set);
  const select = useStore((s) => s.select);
  const camRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const needs = useMemo(() => pendingApprovals(approvals).some((a) => a.agentId === id), [approvals, id]);

  useEffect(() => {
    mapRef.camBox = camRef.current;
    return () => {
      mapRef.camBox = null;
    };
  }, [agent?.id]);

  if (!agent) return null;
  const role = roles.find((r) => r.id === agent.role);
  const lead = agent.teamLeadId ? agentsMap[agent.teamLeadId] : undefined;
  const objective =
    (agent.objectiveId ? objectives[agent.objectiveId] : undefined) ??
    Object.values(objectives).find((o) => o.assigneeId === agent.id && OPEN_OBJECTIVE_STATUSES.includes(o.status));
  const resetSize = () => {
    set({ intelSize: DEFAULT_INTEL_SIZE });
    saveIntelSize(DEFAULT_INTEL_SIZE);
  };
  const grip = (axis: "w" | "h" | "wh") => (
    <div className={`intel-grip ${axis}`} onPointerDown={(e) => startResize(e, panelRef.current, axis)} onDoubleClick={resetSize} title="Drag to resize · double-click to reset" aria-hidden />
  );
  return (
    <section
      ref={panelRef}
      className={`intel tick-frame${full ? " full" : ""}`}
      aria-label={`Intel: ${agent.callsign}`}
      style={full ? undefined : { width: `${size.w}rem`, ...(size.h !== null ? { height: `${size.h}rem` } : {}) }}
    >
      {!full && (
        <>
          {grip("w")}
          {grip("h")}
          {grip("wh")}
        </>
      )}
      <div className="intel-head">
        <button className="intel-full-btn" aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (F or Esc)" : "Full screen (F)"} onClick={() => set({ intelFull: !full })}>
          {full ? "⤡" : "⤢"}
        </button>
        {agent.external
          ? `UNIT ${agent.letter} · WATCH-ONLY`
          : agent.teamLeadId
            ? `TEAMMATE ${agent.letter} · ${lead ? `${lead.callsign.toUpperCase()}'S TEAM` : "TEAM"}`
            : agent.teamMode
              ? `AGENT ${agent.letter} · TEAM LEAD`
              : `AGENT ${agent.letter} · ${role?.name ?? agent.role}`}
        <button className="intel-close" aria-label="Close" onClick={() => select(null)}>
          ✕
        </button>
      </div>
      <div className="cam" ref={camRef}>
        <Glitch key={agent.id} />
        <div className="cam-brackets" />
        <div className="cam-cross" />
        <div className="cam-mascot">
          <Mascot accessory={agent.external ? "none" : agent.teamLeadId ? "helmet" : (role?.accessory ?? "beret")} activity={agent.activity} scale={full ? 7 : 4} dim={agent.status === "paused"} />
        </div>
        <div className={`cam-status${needs || agent.activity === "needs_you" ? " needs" : ""}`}>
          <b>{needs ? "NEEDS YOUR DECISION" : statusWord(agent)}</b>
          {agent.activity !== "idle" ? agent.activity.replace("_", " ").toUpperCase() : ""}
        </div>
      </div>
      <div className="intel-meta">
        <div className="intel-name">
          <span>
            {agent.letter} · {agent.callsign}
          </span>
          <small>{agent.external ? (agent.sessionName ?? "Claude session") : agent.teamLeadId ? `Teammate${agent.sessionName ? ` · ${agent.sessionName}` : ""}${agent.model ? ` · ${agent.model}` : ""}` : (role?.title ?? agent.role)}</small>
        </div>
        <div className="intel-detail" title={agent.activityDetail ?? ""}>
          {objective ? `#${objective.number} ${objective.title}` : (agent.activityDetail ?? "No objective")}
        </div>
        {!agent.external && (
          <>
            {usage || agent.teamMode || agent.teamLeadId ? (
              <Meter
                label="USAGE"
                value={usageShare(agent, Object.values(agentsMap))}
                text={`${tokens(agent.tokensUsed)} tok · ${pct(usageShare(agent, Object.values(agentsMap)))} of squad`}
              />
            ) : (
              <Meter
                label="SUPPLY"
                value={supplyFraction(agent)}
                text={agent.budgetUsd === null ? `${usd(agent.spentUsd)} · no cap` : `${usd(agent.spentUsd)} / ${usd(agent.budgetUsd)}`}
              />
            )}
            <Meter label="CONTEXT" kind="ctx" value={agent.contextTokens / 1_000_000} text={tokens(agent.contextTokens)} />
          </>
        )}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => set({ intelTab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "feed" && <FeedTab agent={agent} />}
        {tab === "objectives" && <ObjectivesTab agent={agent} />}
        {tab === "files" && <FilesTab agent={agent} />}
        {tab === "terminal" && <TerminalTab agent={agent} />}
      </div>
      <OrdersBox agent={agent} />
    </section>
  );
}

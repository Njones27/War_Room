import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentView, ObjectiveView } from "../../shared/protocol";
import { OPEN_OBJECTIVE_STATUSES } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { ago, clock, modelTag, pct, statusPill, statusWord, supplyFraction, tokens, usageShare, usd } from "../lib/format";
import { DEFAULT_INTEL_SIZE, pendingApprovals, saveIntelSize, useStore, type IntelTab } from "../lib/store";
import { CAMO_PALETTE } from "../map/camo";
import { locate } from "../map/engine";
import { mapRef } from "../map/mapRef";
import { Mascot } from "../sprites/Mascot";
import { Icon, STATUS_LABEL, STATUS_PILL } from "./icons";
import { MoreMenu, type MenuItem } from "./Menu";
import { Rich } from "./Rich";
import { buildThread, type ThreadEntry, type TraceStep } from "./thread";

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

function Stat({ label, value, text, ctx, title }: { label: string; value: number; text: string; ctx?: boolean; title?: string }) {
  return (
    <div className="stat" title={title}>
      <span>{label}</span>
      <span className={`bar${ctx ? " ctx" : ""}`}>
        <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </span>
      <b>{text}</b>
    </div>
  );
}

function Trace({ steps, initiallyOpen }: { steps: TraceStep[]; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const errors = steps.filter((s) => s.state === "err").length;
  const running = steps.some((s) => s.state === "run");
  const sum = errors ? `${errors} failed` : running ? "running" : "all passed";
  return (
    <div className={`trace${open ? " open" : ""}`}>
      <button className="trace-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevDown" : "chevRight"} />
        Trace · {steps.length} {steps.length === 1 ? "step" : "steps"}
        <span className={`sum${errors ? " err" : running ? "" : " ok"}`}>{sum}</span>
      </button>
      {open && (
        <div className="trace-steps">
          {steps.map((s) => (
            <details key={s.id} className="step">
              <summary>
                <i className={`dot${s.state === "ok" ? "" : ` ${s.state}`}`} />
                <code title={s.text}>{s.text}</code>
                <span className={`res${s.state === "ok" ? "" : ` ${s.state}`}`}>{s.state === "run" ? "running" : s.state === "err" ? "failed" : "done"}</span>
              </summary>
              {s.result && <pre className={s.state === "err" ? "err" : undefined}>{s.result}</pre>}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function Briefing({ text, at }: { text: string; at: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="sys">
        <span>
          Sortie started · {clock(at)} ·{" "}
          <button onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "hide briefing" : "briefing"}
          </button>
        </span>
      </div>
      {open && <pre className="briefing">{text}</pre>}
    </>
  );
}

function ChatTab({ agent, objective, onSendBack }: { agent: AgentView; objective: ObjectiveView | undefined; onSendBack: () => void }) {
  const feed = useStore((s) => s.feed[agent.id]);
  const orders = useStore((s) => s.orders);
  const live = useStore((s) => s.live[agent.id]) ?? "";
  const agentsMap = useStore((s) => s.agents);
  const roles = useStore((s) => s.roles);
  const entries = useMemo(() => buildThread(agent.id, feed ?? [], orders), [agent.id, feed, orders]);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, live]);

  const accessoryOf = (a: AgentView | undefined) => (!a || a.external ? "none" : a.teamLeadId ? "helmet" : (roles.find((r) => r.id === a.role)?.accessory ?? "beret"));
  const nameOf = (id: string) => (id === "commander" ? "You" : (agentsMap[id]?.callsign ?? "agent"));
  const lastSteps = entries.findLastIndex((e) => e.kind === "msg" && e.steps.length > 0);

  const msg = (e: Extract<ThreadEntry, { kind: "msg" }>, i: number) => {
    const author = e.from === "agent" ? agent : agentsMap[e.authorId];
    return (
      <div key={e.id} className={`msg${e.from === "you" ? " you" : ""}`}>
        <span className="avatar">{e.from === "you" ? <Icon name="user" /> : <Mascot accessory={accessoryOf(author)} activity="idle" scale={1.2} />}</span>
        <div>
          <div className="msg-meta">
            <b>{e.from === "agent" ? agent.callsign : nameOf(e.authorId)}</b>
            {e.to && <span>to {nameOf(e.to)}</span>}
            <span>{clock(e.at)}</span>
          </div>
          {e.text && (
            <div className="msg-text">
              <Rich text={e.text} />
            </div>
          )}
          {e.steps.length > 0 && <Trace steps={e.steps} initiallyOpen={i === lastSteps && (agent.status === "running" || i >= entries.length - 2)} />}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className="thread scroll"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {entries.length === 0 && !live && <div className="empty">Nothing yet. Send {agent.callsign} orders below, or wait for its first sortie.</div>}
      {entries.map((e, i) =>
        e.kind === "msg" ? (
          msg(e, i)
        ) : e.kind === "briefing" ? (
          <Briefing key={e.id} text={e.text} at={e.at} />
        ) : (
          <div key={e.id} className={`sys${e.err ? " err" : ""}`}>
            <span>
              {e.text} · {clock(e.at)}
            </span>
          </div>
        ),
      )}
      {live && (
        <div className="msg live">
          <span className="avatar">
            <Mascot accessory={accessoryOf(agent)} activity="idle" scale={1.2} />
          </span>
          <div>
            <div className="msg-meta">
              <b>{agent.callsign}</b>
              <span>typing</span>
            </div>
            <div className="msg-text">{live}</div>
          </div>
        </div>
      )}
      {!agent.external && objective?.status === "in_review" && agent.status !== "running" && (
        <div className="review">
          <span className="grow">
            <b>#{objective.number}</b> is ready for your review.
          </span>
          <button className="btn sm primary" onClick={() => void act(() => api.updateObjective(objective.id, { status: "done" }), "Objective done")}>
            Mark done
          </button>
          <button className="btn sm ghost" title={`Write what to change; your message wakes ${agent.callsign}`} onClick={onSendBack}>
            Send back
          </button>
        </div>
      )}
    </div>
  );
}

function TeamTasks({ agent }: { agent: AgentView }) {
  if (!agent.teamTasks.length) return null;
  const order = { in_progress: 0, pending: 1, completed: 2 };
  return (
    <>
      <div className="label section">
        Team tasks · {agent.teamTasks.filter((t) => t.status === "completed").length}/{agent.teamTasks.length} done
      </div>
      {[...agent.teamTasks]
        .sort((a, b) => order[a.status] - order[b.status])
        .map((t) => (
          <div key={t.id} className="card">
            <div className="card-title">
              <span className="t">{t.subject}</span>
              <span className={`pill sm ${t.status === "completed" ? "ok" : t.status === "in_progress" ? "warn" : ""}`}>{t.status === "completed" ? "Done" : t.status === "in_progress" ? "In progress" : "Pending"}</span>
            </div>
            {t.owner && <div className="card-meta">{t.owner}</div>}
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
      <div className="tab-list scroll">
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
    <div className="tab-list scroll">
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
          <input placeholder={`New objective for ${agent.callsign}…`} value={title} onChange={(e) => setTitle(e.target.value)} />
          {title && <input placeholder="Target path (optional), e.g. src/auth" value={target} onChange={(e) => setTarget(e.target.value)} />}
        </form>
      )}
      {mine.length === 0 && !agent.teamTasks.length && <div className="empty">No objectives assigned.</div>}
      {mine.map((o) => {
        const report = lastReport(o.id);
        return (
          <div key={o.id} className="card">
            <div className="card-title">
              <span className="mono">#{o.number}</span>
              <span className="t">{o.title}</span>
              <span className={`pill sm ${STATUS_PILL[o.status]}`}>{STATUS_LABEL[o.status]}</span>
            </div>
            {(o.targetPaths.length > 0 || modelTag(o)) && (
              <div className="card-meta">
                {o.targetPaths.map((p) => (
                  <span key={p} className="chip path">
                    {p}
                  </span>
                ))}
                {modelTag(o) && <span className={`model-tag${o.modelPending ? " pending" : ""}`}>{modelTag(o)}</span>}
              </div>
            )}
            {report && (
              <div className="card-quote">
                {report.body.slice(0, 220)}
                {report.body.length > 220 ? "…" : ""}
              </div>
            )}
            {!agent.external && OPEN_OBJECTIVE_STATUSES.includes(o.status) && (
              <div className="actions">
                {o.status === "in_review" && (
                  <button className="btn sm primary" onClick={() => void act(() => api.updateObjective(o.id, { status: "done" }))}>
                    Mark done
                  </button>
                )}
                <button className="btn sm ghost" onClick={() => void act(() => api.updateObjective(o.id, { status: "cancelled" }))}>
                  Cancel
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
    <div className="tab-list scroll" style={{ gap: 0 }}>
      {files.length === 0 && <div className="empty">{agent.external ? "File history isn't tracked for watch-only units." : "No files touched yet."}</div>}
      {files.map((f) => (
        <button
          key={f.path}
          className="file-row"
          title="Show on the map"
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
      <div className="term-intro scroll">
        <div>This is a Claude Code session you started yourself. War Room only watches it; open it from its own terminal.</div>
        <code className="code">{agent.workspace.path}</code>
      </div>
    );
  }
  if (agent.teamLeadId || agent.teamMode) {
    const leadId = agent.teamLeadId ?? agent.id;
    const live = agent.teamLeadId ? true : agent.status === "running";
    return (
      <div className="term-intro scroll">
        <div>
          {agent.teamLeadId
            ? "Teammates run inside their lead's Claude Code session. Open it to watch the whole team, or message this teammate from the Chat tab."
            : "This team lead is a live Claude Code session; its teammates run inside it. Type to it directly, answer prompts, or pick a teammate in the squad list."}
        </div>
        <div className="actions">
          {live ? (
            <button className="btn primary" disabled={settings?.demo} onClick={() => set({ terminalFor: leadId })}>
              {agent.teamLeadId ? "Open lead's terminal" : "Open team terminal"}
            </button>
          ) : (
            <button className="btn primary" onClick={() => void act(() => api.resume(agent.id), "Bringing the team lead back")}>
              Resume session
            </button>
          )}
        </div>
        {settings?.demo && <div>Demo teams are simulated, so there's no terminal.</div>}
        {!live && <div>The session ended. Resume brings the lead back with its conversation; teammates don't survive a restart.</div>}
      </div>
    );
  }
  return (
    <div className="term-intro scroll">
      <div>Take command opens this agent's real Claude Code session (the interactive TUI) right here. War Room holds the agent's sorties until you release it.</div>
      <div className="actions">
        <button
          className="btn primary"
          disabled={!settings?.takeCommandAvailable || agent.status === "running"}
          onClick={() => set({ terminalFor: agent.id })}
          title={agent.status === "running" ? "Wait for the sortie to end, or stop it" : undefined}
        >
          {agent.status === "commanded" ? "Open terminal" : "Take command"}
        </button>
      </div>
      {!settings?.takeCommandAvailable && <div>{settings?.demo ? "Unavailable in demo mode." : "Needs the optional node-pty dependency (npm install)."}</div>}
      {session?.command && (
        <>
          <div>Or continue it in your own terminal:</div>
          <code className="code">{session.command}</code>
        </>
      )}
    </div>
  );
}

function Composer({ agent, inputRef }: { agent: AgentView; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const set = useStore((s) => s.set);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text, inputRef]);
  if (agent.external) return null;
  const mate = agent.teamLeadId !== null;
  const team = agent.teamMode;
  const running = agent.status === "running";
  const paused = agent.status === "paused";
  const sentMsg = mate ? "Orders relayed through the lead" : team && running ? "Orders typed into the team session" : running ? "Orders delivered live" : "Orders queued; agent is waking";
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await act(() => api.order(agent.id, text.trim()), sentMsg);
    setBusy(false);
    if (ok) setText("");
  };
  const dismiss: MenuItem = {
    label: `Dismiss ${agent.callsign}…`,
    icon: "x",
    danger: true,
    onClick: () => {
      const wt = agent.workspace.kind === "worktree";
      if (!window.confirm(`Dismiss ${agent.letter} · ${agent.callsign}? Open objectives go back to the board.${wt ? "\n\nIts worktree is removed only if it has no uncommitted changes; the branch is kept." : ""}`)) return;
      void act(() => api.dismiss(agent.id, wt), "Agent dismissed");
    },
  };
  return (
    <div className="composer">
      <div className="composer-input">
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={mate ? `Message ${agent.callsign} (relayed by its lead)…` : `Message ${agent.callsign}…`}
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
        <button className="send" aria-label="Send" title="Send (Enter)" disabled={!text.trim() || busy} onClick={() => void send()}>
          <Icon name="send" />
        </button>
      </div>
      <div className="composer-bar">
        {mate ? null : team ? (
          running ? (
            <button className="tbtn" title="Interrupt the lead (its teammates keep working)" onClick={() => void act(() => api.recall(agent.id), "Lead interrupted")}>
              <Icon name="stop" />
              Interrupt
            </button>
          ) : (
            <button className="tbtn" onClick={() => void act(() => api.resume(agent.id), "Bringing the team lead back")}>
              <Icon name="resume" />
              Resume
            </button>
          )
        ) : (
          <>
            {running ? (
              <button className="tbtn" title="Recall: end this sortie now" onClick={() => void act(() => api.recall(agent.id), "Recalled")}>
                <Icon name="stop" />
                Stop
              </button>
            ) : (
              <button className="tbtn" disabled={paused} title="Start a sortie now" onClick={() => void act(() => api.wake(agent.id), "Waking")}>
                <Icon name="play" />
                Wake
              </button>
            )}
            <button className="tbtn" onClick={() => void act(() => (paused || agent.pausedReason ? api.resume(agent.id) : api.pause(agent.id)))}>
              <Icon name={paused || agent.pausedReason ? "resume" : "pause"} />
              {paused || agent.pausedReason ? "Resume" : "Hold"}
            </button>
          </>
        )}
        <button className="tbtn" onClick={() => set({ intelTab: "terminal" })}>
          <Icon name="terminal" />
          Terminal
        </button>
        <span className="grow" />
        {!mate && <MoreMenu items={[dismiss]} label={`More actions for ${agent.callsign}`} />}
      </div>
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Drag the panel's left edge, top edge or top-left corner to resize it (sizes in px). */
function startResize(e: React.PointerEvent, panel: HTMLElement | null, axis: "w" | "h" | "wh"): void {
  if (!panel || e.button !== 0) return;
  e.preventDefault();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const rect = panel.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
  // Keep the squad list on the left and the DEPLOY button below in view.
  const maxW = Math.max(DEFAULT_INTEL_SIZE.w, window.innerWidth - 32 * rem);
  const maxH = Math.max(320, window.innerHeight - 15.3 * rem);
  const move = (ev: PointerEvent) => {
    const { intelSize, set } = useStore.getState();
    const w = axis === "h" ? intelSize.w : clamp(start.w + (start.x - ev.clientX), 320, maxW);
    const h = axis === "w" ? intelSize.h : clamp(start.h + (start.y - ev.clientY), 320, maxH);
    set({ intelSize: { w: Math.round(w), h: h === null ? null : Math.round(h) } });
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const needs = useMemo(() => pendingApprovals(approvals).some((a) => a.agentId === id), [approvals, id]);
  const glitch = useStore((s) => s.prefs.effects !== "off");

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
  const openCount = Object.values(objectives).filter((o) => o.assigneeId === agent.id && OPEN_OBJECTIVE_STATUSES.includes(o.status)).length;
  const pill = statusPill(agent, needs);
  const squad = Object.values(agentsMap);
  const resetSize = () => {
    set({ intelSize: DEFAULT_INTEL_SIZE });
    saveIntelSize(DEFAULT_INTEL_SIZE);
  };
  const grip = (axis: "w" | "h" | "wh") => (
    <div className={`intel-grip ${axis}`} onPointerDown={(e) => startResize(e, panelRef.current, axis)} onDoubleClick={resetSize} title="Drag to resize · double-click to reset" aria-hidden />
  );
  const sendBack = () => {
    set({ intelTab: "feed" });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const tabs: { id: IntelTab; label: string; count?: number }[] = [
    { id: "feed", label: "Chat" },
    { id: "objectives", label: agent.teamLeadId ? "Tasks" : "Objectives", count: agent.teamLeadId ? undefined : openCount || undefined },
    { id: "files", label: "Files" },
    { id: "terminal", label: "Terminal" },
  ];
  let body: ReactNode = null;
  if (tab === "feed") body = <ChatTab agent={agent} objective={objective} onSendBack={sendBack} />;
  else if (tab === "objectives") body = <ObjectivesTab agent={agent} />;
  else if (tab === "files") body = <FilesTab agent={agent} />;
  else body = <TerminalTab agent={agent} />;

  return (
    <section
      ref={panelRef}
      className={`intel${full ? " full" : ""}`}
      aria-label={`Intel: ${agent.callsign}`}
      style={full ? undefined : { width: `${size.w}px`, ...(size.h !== null ? { height: `${size.h}px` } : {}) }}
    >
      {!full && (
        <>
          {grip("w")}
          {grip("h")}
          {grip("wh")}
        </>
      )}
      <div className="intel-head">
        <button className="head-btn full" aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (F or Esc)" : "Full screen (F)"} onClick={() => set({ intelFull: !full })}>
          <Icon name={full ? "shrink" : "expand"} />
        </button>
        {agent.external
          ? `Unit ${agent.letter} · Watch-only`
          : agent.teamLeadId
            ? `Teammate ${agent.letter} · ${lead ? `${lead.callsign}'s team` : "Team"}`
            : agent.teamMode
              ? `Agent ${agent.letter} · Team lead`
              : `Agent ${agent.letter} · ${role?.name ?? agent.role}`}
        <button className="head-btn close" aria-label="Close" onClick={() => select(null)}>
          <Icon name="x" />
        </button>
      </div>
      <div className="cam" ref={camRef}>
        {glitch && <Glitch key={agent.id} />}
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
      <div className="intel-id">
        <div className="id-row">
          <div className="who">
            <b>{agent.callsign}</b>
            <span>{agent.external ? (agent.sessionName ?? "Claude session") : agent.teamLeadId ? `Teammate${agent.model ? ` · ${agent.model}` : ""}` : (role?.title ?? agent.role)}</span>
          </div>
          <span className={`pill ${pill.tone}`}>
            <i />
            {pill.text}
          </span>
        </div>
        {objective ? (
          <button className="obj-row" title={objective.title} onClick={() => set({ intelTab: "objectives" })}>
            <span className="mono">#{objective.number}</span>
            <span className="t">{objective.title}</span>
            <span className={`pill sm ${STATUS_PILL[objective.status]}`}>{STATUS_LABEL[objective.status]}</span>
          </button>
        ) : (
          <div className="obj-row none" title={agent.activityDetail ?? ""}>
            <span className="t">{agent.activityDetail ?? "No objective"}</span>
          </div>
        )}
        {!agent.external && (
          <div className="stats">
            {usage || agent.teamMode || agent.teamLeadId ? (
              <Stat label="Usage" value={usageShare(agent, squad)} text={`${tokens(agent.tokensUsed)} · ${pct(usageShare(agent, squad))}`} title={`${tokens(agent.tokensUsed)} tokens, ${pct(usageShare(agent, squad))} of the squad's usage`} />
            ) : (
              <Stat label="Supply" value={supplyFraction(agent)} text={agent.budgetUsd === null ? `${usd(agent.spentUsd)} · no cap` : `${usd(agent.spentUsd)} / ${usd(agent.budgetUsd)}`} />
            )}
            <Stat label="Context" ctx value={agent.contextTokens / 1_000_000} text={tokens(agent.contextTokens)} />
          </div>
        )}
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => set({ intelTab: t.id })}>
            {t.label}
            {t.count !== undefined && <i>{t.count}</i>}
          </button>
        ))}
      </div>
      <div className="tab-body">{body}</div>
      <Composer agent={agent} inputRef={inputRef} />
    </section>
  );
}

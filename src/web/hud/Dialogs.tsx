import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ObjectiveStatus, ObjectiveView, Priority } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { callsign, modelTag, tokens, usd } from "../lib/format";
import { isManaged, sortedAgents, useStore } from "../lib/store";
import { EFFORT_OPTIONS } from "../../shared/models";
import { RoleGlyph } from "../map/MapView";
import { ModelSelect } from "./ModelSelect";

function Modal({ title, onClose, children, foot, wide }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal tick-frame${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="intel-close" style={{ top: "0.6rem" }} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

const EFFORTS = ["", ...EFFORT_OPTIONS];

export function DeployDialog() {
  const open = useStore((s) => s.deployOpen);
  const roles = useStore((s) => s.roles);
  const selectedRole = useStore((s) => s.selectedRole);
  const agentsMap = useStore((s) => s.agents);
  const missions = useStore((s) => s.missions);
  const city = useStore((s) => s.city);
  const isGit = useStore((s) => s.theater?.isGit ?? true);
  const usage = useStore((s) => s.settings?.supplyMode === "usage");
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.set);
  const select = useStore((s) => s.select);
  // No type is picked until you choose one (the map's HQ shortcuts preselect theirs).
  const role = roles.find((r) => r.id === selectedRole) ?? null;
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const activeMission = missions.find((m) => m.status === "active");
  const commands = role ? role.reportsTo === null : false;
  const wantsMission = commands && !activeMission;

  const [callsignText, setCallsign] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState("");
  const [reportsTo, setReportsTo] = useState("");
  const [budget, setBudget] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [team, setTeam] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !role) return;
    setCallsign("");
    setTitle("");
    setBody("");
    setTarget("");
    setBudget(role.budgetUsd === null ? "" : String(role.budgetUsd));
    setModel(role.model ?? "");
    setEffort(role.effort ?? "");
    setTeam(false);
    const boss = role.reportsTo ? agents.find((a) => a.role === role.reportsTo) : undefined;
    setReportsTo(boss?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role?.id]);

  if (!open) return null;
  const close = () => set({ deployOpen: false });
  const picker = (
    <div className="role-pick">
      {roles.map((r) => (
        <button key={r.id} className={`role-opt${r.id === role?.id ? " active" : ""}`} onClick={() => set({ selectedRole: r.id })} title={r.description}>
          <RoleGlyph icon={r.icon} size={20} /> {r.name}
        </button>
      ))}
    </div>
  );
  if (!role) {
    return (
      <Modal
        title="Deploy"
        onClose={close}
        foot={
          <>
            <button className="btn" onClick={close}>
              CANCEL
            </button>
            <button className="btn primary" disabled>
              DEPLOY
            </button>
          </>
        }
      >
        <div className="role-desc">Choose the type of agent to deploy.</div>
        {picker}
      </Modal>
    );
  }
  const permission = (settings?.permissionMode ?? "auto").toUpperCase();
  // Team mode: a top-level commander running as a live Claude Code session with its own agent team.
  const teamable = commands && !reportsTo;
  const teamOn = teamable && team;
  const teamReady = Boolean(settings?.takeCommandAvailable || settings?.demo);
  const taken = new Set(agents.map((a) => a.callsign.toLowerCase()));
  const suggested = role.callsigns.find((c) => !taken.has(c.toLowerCase())) ?? `${role.name}-${agents.length + 1}`;

  const deploy = async () => {
    setBusy(true);
    const agent = await act(
      () =>
        api.deploy({
          role: role.id,
          callsign: callsignText.trim() || null,
          reportsTo: reportsTo || null,
          // Usage mode hides the field; the role's default cap applies if you switch back.
          budgetUsd: usage || teamOn ? undefined : budget.trim() ? Number(budget) : null,
          teamMode: teamOn || undefined,
          model: model.trim() || null,
          effort: effort || null,
          mission: wantsMission && title.trim() ? { title: title.trim(), body: body.trim() } : null,
          objective: !wantsMission && title.trim() ? { title: title.trim(), body: body.trim(), targetPaths: target.trim() ? [target.trim()] : [] } : null,
        }),
      `${role.name} deployed`,
    );
    setBusy(false);
    if (agent) {
      close();
      select(agent.id);
    }
  };

  return (
    <Modal
      title={`Deploy · ${role.name}`}
      onClose={close}
      foot={
        <>
          <button className="btn" onClick={close}>
            CANCEL
          </button>
          <button className="btn primary" disabled={busy || (wantsMission && !title.trim())} onClick={() => void deploy()}>
            DEPLOY
          </button>
        </>
      }
    >
      {picker}
      <div className="role-card">
        <div className="role-card-head">
          <RoleGlyph icon={role.icon} size={16} /> {role.title}
        </div>
        <div className="role-card-summary">{role.description}</div>
        <div className="role-card-facts">
          {[
            role.reportsTo === null ? "Leads the squad" : role.readOnly ? "Read-only" : "Edits code",
            (role.worktree || teamOn) && isGit ? "Own git worktree and branch" : "Main checkout",
            role.reportsTo ? `Reports to the ${roles.find((r) => r.id === role.reportsTo)?.name ?? role.reportsTo}` : "Reports to you",
            `Permissions: ${permission}`,
          ].join("  ·  ")}
        </div>
      </div>
      {teamable && (
        <label className={`team-toggle${teamOn ? " on" : ""}`}>
          <input type="checkbox" checked={teamOn} disabled={!teamReady} onChange={(e) => setTeam(e.target.checked)} />
          <span>
            <b>TEAM MODE</b> · Runs as a live Claude Code session that builds its own team with Claude Code agent teams (experimental). Teammates show up on the map; their permission prompts come to you.
            {teamOn && " Teams use noticeably more tokens and always draw on plan usage (no budget cap)."}
            {!teamReady && " Needs the optional node-pty dependency (npm install)."}
          </span>
        </label>
      )}
      <div className="grid2">
        <label className="field">
          <span>CALLSIGN</span>
          <input placeholder={suggested} value={callsignText} onChange={(e) => setCallsign(e.target.value)} maxLength={40} autoFocus />
        </label>
        <label className="field">
          <span>REPORTS TO</span>
          <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
            <option value="">Commander (you)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {callsign(a)} ({a.role})
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>{wantsMission ? "MISSION" : "FIRST OBJECTIVE (OPTIONAL)"}</span>
        <input
          placeholder={wantsMission ? "e.g. Ship dark mode with tests" : "e.g. Add input validation to the API"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && (!wantsMission || title.trim()) && void deploy()}
        />
      </label>
      {(wantsMission || title) && (
        <label className="field">
          <span>BRIEFING</span>
          <textarea placeholder="What done looks like, constraints, pointers…" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
      )}
      {!wantsMission && title && (
        <label className="field">
          <span>TARGET</span>
          <input list="district-list" placeholder="Repo path to work on (optional), e.g. src/server" value={target} onChange={(e) => setTarget(e.target.value)} />
          <datalist id="district-list">
            {city?.districts.map((d) => <option key={d.path} value={d.path} />)}
          </datalist>
        </label>
      )}
      <div className={usage || teamOn ? "grid2" : "grid3"}>
        {!usage && !teamOn && (
          <label className="field">
            <span>BUDGET (USD)</span>
            <input type="number" min="0" step="1" placeholder="no cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
        )}
        <div className="field">
          <span>MODEL</span>
          <ModelSelect value={model} onChange={setModel} />
        </div>
        <label className="field">
          <span>EFFORT</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x || "your default"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <small className="role-desc" style={{ fontSize: "0.92rem" }}>
        {usage
          ? "Agents run on your local Claude Code with your login and draw on your plan's usage, with no budget cap (SUPPLY is set to USAGE). With an API key, that's billed per token."
          : "Agents run on your local Claude Code with your login. On a subscription, usage counts toward your plan's limits; with an API key it's billed per token. The budget is Claude Code's cost estimate and pauses the agent when reached."}
      </small>
    </Modal>
  );
}

export function ManageDialog() {
  const open = useStore((s) => s.manageOpen);
  const agentsMap = useStore((s) => s.agents);
  const usage = useStore((s) => s.settings?.supplyMode === "usage");
  const set = useStore((s) => s.set);
  if (!open) return null;
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const patch = (id: string, p: Record<string, unknown>) => void act(() => api.updateAgent(id, p));
  return (
    <Modal title="Manage agents" wide onClose={() => set({ manageOpen: false })}>
      {agents.length === 0 ? (
        <div className="empty">No agents deployed yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>AGENT</th>
              <th>ROLE</th>
              <th>REPORTS TO</th>
              <th>MODEL</th>
              {!usage && <th>BUDGET</th>}
              <th>{usage ? "TOKENS" : "SPENT"}</th>
              <th>PATROL (MIN)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <input defaultValue={a.callsign} onBlur={(e) => e.target.value.trim() && e.target.value !== a.callsign && patch(a.id, { callsign: e.target.value.trim() })} style={{ minWidth: "7rem" }} />
                  <small style={{ color: "var(--text-dim)" }}> {a.letter}</small>
                </td>
                <td>{a.role}</td>
                <td>
                  <select value={a.reportsTo ?? ""} onChange={(e) => patch(a.id, { reportsTo: e.target.value || null })}>
                    <option value="">Commander</option>
                    {agents
                      .filter((b) => b.id !== a.id)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {callsign(b)}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <ModelSelect compact commitOnBlur value={a.model ?? ""} onChange={(v) => patch(a.id, { model: v.trim() || null })} />
                </td>
                {!usage && (
                  <td>
                    <input
                      type="number"
                      min="0"
                      defaultValue={a.budgetUsd ?? ""}
                      placeholder="no cap"
                      onBlur={(e) => patch(a.id, { budgetUsd: e.target.value.trim() ? Number(e.target.value) : null })}
                      style={{ width: "5.5rem" }}
                    />
                  </td>
                )}
                <td title={usage ? `≈ ${usd(a.spentUsd)} at API prices` : undefined}>{usage ? tokens(a.tokensUsed) : usd(a.spentUsd)}</td>
                <td>
                  <input type="number" min="5" placeholder="off" defaultValue="" onBlur={(e) => e.target.value && patch(a.id, { patrolMinutes: Number(e.target.value) })} style={{ width: "4.5rem" }} />
                </td>
                <td>
                  <div className="actions">
                    <button className="btn" onClick={() => void act(() => (a.status === "paused" ? api.resume(a.id) : api.pause(a.id)))}>
                      {a.status === "paused" ? "RESUME" : "HOLD"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <small className="role-desc" style={{ fontSize: "0.92rem" }}>
        Roles live in <code>roles/*.md</code>. Add or override them per repo in <code>.war-room/roles/</code>. Patrol wakes an agent on a timer while it has open objectives.
      </small>
    </Modal>
  );
}

const COLUMNS: { id: ObjectiveStatus; label: string }[] = [
  { id: "todo", label: "TODO" },
  { id: "in_progress", label: "IN PROGRESS" },
  { id: "blocked", label: "BLOCKED" },
  { id: "in_review", label: "IN REVIEW" },
  { id: "done", label: "DONE" },
];

/** Folders and files for the map-target field's suggestions. */
function TargetList({ id }: { id: string }) {
  const city = useStore((s) => s.city);
  const paths = useMemo(() => {
    if (!city) return [];
    const dirs = city.districts.map((d) => d.path).filter(Boolean);
    const files = city.buildings.filter((b) => !b.path.startsWith("@")).map((b) => b.path);
    return [...new Set([...dirs, ...files])].slice(0, 400);
  }, [city]);
  return (
    <datalist id={id}>
      {paths.map((p) => (
        <option key={p} value={p} />
      ))}
    </datalist>
  );
}

function ObjectiveCard({ o }: { o: ObjectiveView }) {
  const agentsMap = useStore((s) => s.agents);
  const orders = useStore((s) => s.orders);
  const picks = useStore((s) => s.settings?.generalPicksModels === true);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const assignee = o.assigneeId ? agentsMap[o.assigneeId] : undefined;
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const thread = orders.filter((x) => x.objectiveId === o.id);
  const name = (id: string) => (id === "commander" ? "Commander" : agentsMap[id] ? callsign(agentsMap[id]!) : "agent");
  return (
    <div className="obj-card">
      <button className="row1" style={{ textAlign: "left" }} onClick={() => setOpen(!open)}>
        <span>
          #{o.number} {o.title}
        </span>
      </button>
      <div className="row2">
        {assignee ? callsign(assignee) : "unassigned"}
        {o.priority !== "normal" ? ` · ${o.priority}` : ""}
        {o.targetPaths.length ? ` · ⌖ ${o.targetPaths.join(", ")}` : ""}
      </div>
      {modelTag(o) && <div className={`row2 model-tag${o.modelPending ? " pending" : ""}`}>◆ {modelTag(o)}</div>}
      {open && (
        <>
          {o.body && <div className="row2" style={{ whiteSpace: "pre-wrap" }}>{o.body}</div>}
          {thread.length > 0 && (
            <div className="thread">
              {thread.map((t) => (
                <div key={t.id}>
                  <b>{name(t.author)}:</b> {t.body}
                </div>
              ))}
            </div>
          )}
          <div className="field">
            <select value={o.assigneeId ?? ""} onChange={(e) => void act(() => api.updateObjective(o.id, { assignee: e.target.value || null }))}>
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {callsign(a)} ({a.role})
                </option>
              ))}
            </select>
            <input
              placeholder="Comment / orders to the assignee…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && comment.trim()) void act(() => api.updateObjective(o.id, { comment: comment.trim() })).then(() => setComment(""));
              }}
            />
          </div>
          <div className="obj-model">
            <ModelSelect compact commitOnBlur value={o.model ?? ""} defaultLabel={picks ? "General picks" : "assignee's"} onChange={(v) => void act(() => api.updateObjective(o.id, { model: v.trim() || null }))} />
            <select value={o.effort ?? ""} onChange={(e) => void act(() => api.updateObjective(o.id, { effort: e.target.value || null }))}>
              <option value="">{picks ? "General picks" : "assignee's"}</option>
              {EFFORT_OPTIONS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div className="actions">
            {COLUMNS.filter((c) => c.id !== o.status).map((c) => (
              <button key={c.id} className="btn" onClick={() => void act(() => api.updateObjective(o.id, { status: c.id }))}>
                {c.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ObjectivesBoard() {
  const open = useStore((s) => s.objectivesOpen);
  const objectives = useStore((s) => s.objectives);
  const missions = useStore((s) => s.missions);
  const agentsMap = useStore((s) => s.agents);
  const pingTarget = useStore((s) => s.pingTarget);
  const picks = useStore((s) => s.settings?.generalPicksModels === true);
  const set = useStore((s) => s.set);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [target, setTarget] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mTitle, setMTitle] = useState("");
  const [mBody, setMBody] = useState("");

  useEffect(() => {
    if (open && pingTarget) setTarget(pingTarget);
  }, [open, pingTarget]);

  const byStatus = useMemo(() => {
    const m: Record<string, ObjectiveView[]> = {};
    for (const o of Object.values(objectives)) (m[o.status] ??= []).push(o);
    for (const k of Object.keys(m)) m[k]!.sort((a, b) => a.number - b.number);
    return m;
  }, [objectives]);

  if (!open) return null;
  const close = () => set({ objectivesOpen: false, pingTarget: null });
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const active = missions.find((m) => m.status === "active");
  const general = agents.find((a) => a.role === "general") ?? agents.find((a) => a.reportsTo === null);
  const defaultChoice = picks && general && assignee !== general.id ? "General picks" : "Assignee's default";

  return (
    <Modal title="Objectives" wide onClose={close}>
      {!active && (
        <div className="grid2">
          <label className="field">
            <span>LAUNCH A MISSION</span>
            <input placeholder="Mission for the General, e.g. Harden the auth flow" value={mTitle} onChange={(e) => setMTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>BRIEFING</span>
            <input placeholder="Optional details" value={mBody} onChange={(e) => setMBody(e.target.value)} />
          </label>
          <div className="actions" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}>
            <button className="btn primary" disabled={!mTitle.trim()} onClick={() => void act(() => api.mission(mTitle.trim(), mBody.trim()), "Mission launched").then(() => setMTitle(""))}>
              LAUNCH MISSION
            </button>
          </div>
        </div>
      )}
      <form
        className="grid3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void act(
            () =>
              api.createObjective({
                title: title.trim(),
                body: body.trim() || undefined,
                assignee: assignee || null,
                targetPaths: target.trim() ? [target.trim()] : [],
                priority,
                model: model.trim() || null,
                effort: effort || null,
              }),
            "Objective created",
          ).then(() => {
            setTitle("");
            setBody("");
            setTarget("");
            set({ pingTarget: null });
          });
        }}
      >
        <label className="field" style={{ gridColumn: "1 / 3" }}>
          <span>NEW OBJECTIVE</span>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={Boolean(pingTarget)} />
        </label>
        <label className="field">
          <span>ASSIGN TO</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {callsign(a)} ({a.role})
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ gridColumn: "1 / 3" }}>
          <span>BRIEFING</span>
          <input placeholder="What done looks like" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="field">
          <span>PRIORITY</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["low", "normal", "high", "critical"] as Priority[]).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="field" title="Pins the objective on that folder or file on the map, and sends the agent there. Or press Z and click a building.">
          <span>MAP TARGET (OPTIONAL)</span>
          <input list="objective-targets" placeholder="Folder or file, e.g. src/server" value={target} onChange={(e) => setTarget(e.target.value)} />
          <TargetList id="objective-targets" />
        </label>
        <div className="field">
          <span>MODEL</span>
          <ModelSelect value={model} onChange={setModel} defaultLabel={defaultChoice} />
        </div>
        <label className="field">
          <span>EFFORT</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">{defaultChoice}</option>
            {EFFORT_OPTIONS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <div className="form-foot" style={{ gridColumn: "1 / -1" }}>
          <label className={`team-toggle compact${picks ? " on" : ""}`}>
            <input type="checkbox" checked={picks} onChange={(e) => void act(() => api.settings({ generalPicksModels: e.target.checked }))} />
            <span>
              <b>GENERAL PICKS MODELS</b> · The General chooses the model and effort for each task: for the objectives it hands out, and for yours when you leave MODEL and EFFORT on "General picks".
              {picks && !general && " Deploy a General to use this."}
            </span>
          </label>
          <button className="btn primary" type="submit" disabled={!title.trim()}>
            CREATE
          </button>
        </div>
      </form>
      <div className="board">
        {COLUMNS.map((c) => (
          <div key={c.id} className="board-col">
            <h3>
              {c.label} · {(byStatus[c.id] ?? []).length}
            </h3>
            {(byStatus[c.id] ?? []).map((o) => (
              <ObjectiveCard key={o.id} o={o} />
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

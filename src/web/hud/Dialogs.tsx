import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OPEN_OBJECTIVE_STATUSES, type AgentView, type ObjectiveStatus, type ObjectiveView, type Priority } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { callsign, clock, modelTag, tokens, usageShare, usd } from "../lib/format";
import { DEFAULT_PREFS, type EffectsLevel, type Prefs, type Quality } from "../lib/prefs";
import { isManaged, sortedAgents, useStore } from "../lib/store";
import { EFFORT_OPTIONS } from "../../shared/models";
import { RoleGlyph } from "../map/MapView";
import { Mascot } from "../sprites/Mascot";
import { Icon, STATUS_LABEL, STATUS_PILL, StatusIcon } from "./icons";
import { Rich } from "./Rich";
import { MoreMenu } from "./Menu";
import { ModelSelect } from "./ModelSelect";

function Modal({ title, onClose, children, foot, size, head }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; size?: "wide" | "deploy"; head?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${size ? ` ${size}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Keys typed in the dialog stay out of the map's hotkeys; Escape still closes it.
        onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          {head}
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
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
  const permission = settings?.permissionMode ?? "auto";
  // Team mode: a top-level commander running as a live Claude Code session with its own agent team.
  const teamable = commands && !reportsTo;
  const teamOn = teamable && team;
  const teamReady = Boolean(settings?.takeCommandAvailable || settings?.demo);
  const taken = new Set(agents.map((a) => a.callsign.toLowerCase()));
  const suggested = role ? (role.callsigns.find((c) => !taken.has(c.toLowerCase())) ?? `${role.name}-${agents.length + 1}`) : "";
  const name = callsignText.trim() || suggested;

  const deploy = async () => {
    if (!role) return;
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

  const facts = role
    ? [
        role.reportsTo === null ? "Leads the squad" : role.readOnly ? "Read-only" : "Edits code",
        (role.worktree || teamOn) && isGit ? "Own git worktree and branch" : "Main checkout",
        role.reportsTo ? `Reports to the ${roles.find((r) => r.id === role.reportsTo)?.name ?? role.reportsTo}` : "Reports to you",
        `Permissions: ${permission[0]!.toUpperCase()}${permission.slice(1)}`,
      ]
    : [];
  const costNote = usage
    ? "Runs on your Claude Code login and draws on your plan's usage. No budget cap."
    : "Runs on your Claude Code login. The budget pauses the agent when Claude Code's cost estimate reaches it.";
  const costDetail = usage
    ? "Agents run on your local Claude Code with your login and draw on your plan's usage, with no budget cap (SUPPLY is set to USAGE). With an API key, that's billed per token."
    : "Agents run on your local Claude Code with your login. On a subscription, usage counts toward your plan's limits; with an API key it's billed per token.";

  return (
    <Modal
      title="Deploy an agent"
      size="deploy"
      onClose={close}
      foot={
        <>
          <span className="note grow" title={costDetail}>
            <Icon name="info" />
            {costNote}
          </span>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!role || busy || (wantsMission && !title.trim())} onClick={() => void deploy()}>
            {role ? `Deploy ${name}` : "Deploy"}
          </button>
        </>
      }
    >
      <div className="deploy-split">
        <div className="role-list" role="radiogroup" aria-label="Agent type">
          {roles.map((r) => (
            <button key={r.id} role="radio" aria-checked={r.id === role?.id} className={`role-item${r.id === role?.id ? " active" : ""}`} onClick={() => set({ selectedRole: r.id })} title={r.description}>
              <RoleGlyph icon={r.icon} size={18} />
              <b>{r.name}</b>
              <small>{r.title}</small>
            </button>
          ))}
        </div>
        <div className="modal-body deploy-form">
          {!role ? (
            <div className="empty" style={{ padding: 0 }}>
              Choose the type of agent to deploy. Start with a General: it turns your mission into objectives and requests the specialists it needs.
            </div>
          ) : (
            <>
              <div className="role-head">
                <Mascot accessory={role.accessory} activity="idle" scale={2.6} />
                <div>
                  <b>{role.title}</b>
                  <p>{role.description}</p>
                  <div className="chips">
                    {facts.map((f) => (
                      <span key={f} className="chip">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {teamable && (
                <label className={`toggle${teamOn ? " on" : ""}`}>
                  <input type="checkbox" checked={teamOn} disabled={!teamReady} onChange={(e) => setTeam(e.target.checked)} />
                  <span>
                    <b>Team mode</b> Runs as a live Claude Code session that builds its own team with Claude Code agent teams (experimental). Teammates show up on the map; their permission prompts come to you.
                    {teamOn && " Teams use noticeably more tokens and always draw on plan usage (no budget cap)."}
                    {!teamReady && " Needs the optional node-pty dependency (npm install)."}
                  </span>
                </label>
              )}
              <div className="grid2">
                <label className="field">
                  <span>Callsign</span>
                  <input placeholder={suggested} value={callsignText} onChange={(e) => setCallsign(e.target.value)} maxLength={40} autoFocus />
                </label>
                <label className="field">
                  <span>Reports to</span>
                  <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
                    <option value="">You (Commander)</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {callsign(a)} ({a.role})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>
                  {wantsMission ? "Mission" : "First objective"}
                  {!wantsMission && <em>optional</em>}
                </span>
                <input
                  placeholder={wantsMission ? "e.g. Ship dark mode with tests" : `What should ${name} work on first? e.g. Add input validation to the API`}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && (!wantsMission || title.trim()) && void deploy()}
                />
              </label>
              {(wantsMission || title) && (
                <label className="field">
                  <span>Briefing</span>
                  <textarea placeholder="What done looks like, constraints, pointers…" value={body} onChange={(e) => setBody(e.target.value)} />
                </label>
              )}
              {!wantsMission && title && (
                <label className="field">
                  <span>
                    Target<em>optional</em>
                  </span>
                  <input list="district-list" placeholder="Repo path to work on, e.g. src/server" value={target} onChange={(e) => setTarget(e.target.value)} />
                  <datalist id="district-list">
                    {city?.districts.map((d) => <option key={d.path} value={d.path} />)}
                  </datalist>
                </label>
              )}
              <div className={usage || teamOn ? "grid2" : "grid3"}>
                {!usage && !teamOn && (
                  <label className="field">
                    <span>Budget (USD)</span>
                    <input type="number" min="0" step="1" placeholder="no cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
                  </label>
                )}
                <div className="field">
                  <span>Model</span>
                  <ModelSelect value={model} onChange={setModel} />
                </div>
                <label className="field">
                  <span>Effort</span>
                  <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>
                        {x || "Your default"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function ManageDialog() {
  const open = useStore((s) => s.manageOpen);
  const agentsMap = useStore((s) => s.agents);
  const roles = useStore((s) => s.roles);
  const usage = useStore((s) => s.settings?.supplyMode === "usage");
  const set = useStore((s) => s.set);
  if (!open) return null;
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const squad = Object.values(agentsMap);
  const patch = (id: string, p: Record<string, unknown>) => void act(() => api.updateAgent(id, p));
  const dismiss = (a: AgentView) => {
    const wt = a.workspace.kind === "worktree";
    if (!window.confirm(`Dismiss ${a.letter} · ${a.callsign}? Open objectives go back to the board.${wt ? "\n\nIts worktree is removed only if it has no uncommitted changes; the branch is kept." : ""}`)) return;
    void act(() => api.dismiss(a.id, wt), "Agent dismissed");
  };
  return (
    <Modal
      title="Manage agents"
      size="wide"
      onClose={() => set({ manageOpen: false })}
      foot={
        <span className="note">
          <Icon name="info" />
          <span>
            Roles live in <code className="mono">roles/*.md</code>. Add or override them per repo in <code className="mono">.war-room/roles/</code>. Patrol wakes an agent on a timer while it has open objectives.
          </span>
        </span>
      }
    >
      <div className="modal-body" style={{ padding: "4px 8px 8px" }}>
        {agents.length === 0 ? (
          <div className="empty">No agents deployed yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Reports to</th>
                <th>Model</th>
                {!usage && <th>Budget</th>}
                <th>{usage ? "Usage" : "Spent"}</th>
                <th>Patrol</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const role = roles.find((r) => r.id === a.role);
                const share = usageShare(a, squad);
                return (
                  <tr key={a.id}>
                    <td>
                      <div className="agent-cell">
                        <RoleGlyph icon={role?.icon ?? "star"} size={18} />
                        <div>
                          <input
                            className="quiet name"
                            aria-label={`Callsign for ${a.letter}`}
                            defaultValue={a.callsign}
                            onBlur={(e) => e.target.value.trim() && e.target.value !== a.callsign && patch(a.id, { callsign: e.target.value.trim() })}
                          />
                          <small>
                            {a.letter} · {role?.name ?? a.role}
                            {a.status === "paused" ? " · holding" : ""}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select className="quiet" aria-label="Reports to" value={a.reportsTo ?? ""} onChange={(e) => patch(a.id, { reportsTo: e.target.value || null })}>
                        <option value="">You</option>
                        {agents
                          .filter((b) => b.id !== a.id)
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.callsign}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="quiet-model">
                      <ModelSelect compact commitOnBlur value={a.model ?? ""} defaultLabel="Default" onChange={(v) => patch(a.id, { model: v.trim() || null })} />
                    </td>
                    {!usage && (
                      <td>
                        <input
                          className="quiet num"
                          type="number"
                          min="0"
                          aria-label="Budget in USD"
                          defaultValue={a.budgetUsd ?? ""}
                          placeholder="no cap"
                          onBlur={(e) => patch(a.id, { budgetUsd: e.target.value.trim() ? Number(e.target.value) : null })}
                        />
                      </td>
                    )}
                    <td title={usage ? `≈ ${usd(a.spentUsd)} at API prices` : undefined}>
                      {usage ? (
                        <div className="usage">
                          <span className="bar">
                            <i style={{ width: `${share * 100}%` }} />
                          </span>
                          {tokens(a.tokensUsed)}
                        </div>
                      ) : (
                        usd(a.spentUsd)
                      )}
                    </td>
                    <td>
                      <input
                        className="quiet num"
                        type="number"
                        min="5"
                        aria-label="Patrol interval in minutes"
                        placeholder="Off"
                        defaultValue=""
                        onBlur={(e) => e.target.value && patch(a.id, { patrolMinutes: Number(e.target.value) })}
                      />
                    </td>
                    <td style={{ width: 44 }}>
                      <MoreMenu
                        down
                        className="icon-btn"
                        label={`Actions for ${a.callsign}`}
                        items={[
                          {
                            label: a.status === "paused" ? "Resume" : "Hold",
                            icon: a.status === "paused" ? "resume" : "pause",
                            onClick: () => void act(() => (a.status === "paused" ? api.resume(a.id) : api.pause(a.id))),
                          },
                          "sep",
                          { label: `Dismiss ${a.callsign}…`, icon: "x", danger: true, onClick: () => dismiss(a) },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

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

const GROUPS: ObjectiveStatus[] = ["in_progress", "in_review", "blocked", "todo", "done", "cancelled"];
const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];

/** One objective: its brief and every order and report about it, with its settings alongside. */
function ObjectiveDetail({ o }: { o: ObjectiveView }) {
  const agentsMap = useStore((s) => s.agents);
  const roles = useStore((s) => s.roles);
  const orders = useStore((s) => s.orders);
  const picks = useStore((s) => s.settings?.generalPicksModels === true);
  const [comment, setComment] = useState("");
  const assignee = o.assigneeId ? agentsMap[o.assigneeId] : undefined;
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const thread = orders.filter((x) => x.objectiveId === o.id);
  const accessory = (a: AgentView | undefined) => (a ? (roles.find((r) => r.id === a.role)?.accessory ?? "beret") : "none");
  const update = (p: Parameters<typeof api.updateObjective>[1]) => void act(() => api.updateObjective(o.id, p));
  const send = () => {
    if (!comment.trim()) return;
    void act(() => api.updateObjective(o.id, { comment: comment.trim() }), assignee ? `Sent to ${assignee.callsign}` : "Comment added").then((ok) => ok && setComment(""));
  };
  const author = (id: string) => (id === "commander" ? undefined : agentsMap[id]);
  const message = (key: string, authorId: string, at: number, text: string) => {
    const a = author(authorId);
    return (
      <div key={key} className={`msg${authorId === "commander" ? " you" : ""}`}>
        <span className="avatar">{authorId === "commander" ? <Icon name="user" /> : <Mascot accessory={accessory(a)} activity="idle" scale={1.2} />}</span>
        <div>
          <div className="msg-meta">
            <b>{authorId === "commander" ? "You" : (a?.callsign ?? "agent")}</b>
            <span>{clock(at)}</span>
          </div>
          <div className="msg-text">
            <Rich text={text} />
          </div>
        </div>
      </div>
    );
  };
  const defaultChoice = picks ? "General picks" : "Assignee's";
  return (
    <div className="obj-detail">
      <div className="obj-detail-head">
        <h3>
          <span className="mono">#{o.number}</span>
          {o.title}
        </h3>
        <div className="chips">
          <span className={`pill ${STATUS_PILL[o.status]}`}>
            <i />
            {STATUS_LABEL[o.status]}
          </span>
          {assignee && <span className="chip">{callsign(assignee)}</span>}
          {o.priority !== "normal" && <span className={`pill ${o.priority === "low" ? "" : "bad"}`}>{o.priority[0]!.toUpperCase() + o.priority.slice(1)} priority</span>}
          {o.targetPaths.map((p) => (
            <span key={p} className="chip path">
              <Icon name="folder" />
              {p}
            </span>
          ))}
          {modelTag(o) && <span className={`chip model-tag${o.modelPending ? " pending" : ""}`}>{modelTag(o)}</span>}
        </div>
      </div>
      <div className="obj-detail-body">
        <div className="thread">
          {o.body ? message("brief", o.createdBy, o.createdAt, o.body) : <div className="sys">Created {clock(o.createdAt)} · no briefing</div>}
          {thread.map((t) => message(t.id, t.author, t.createdAt, t.body))}
          {thread.length === 0 && <div className="empty" style={{ padding: 0 }}>No orders or reports on this objective yet.</div>}
        </div>
        <div className="obj-side">
          <label className="field">
            <span>Status</span>
            <select value={o.status} onChange={(e) => update({ status: e.target.value as ObjectiveStatus })}>
              {GROUPS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Assignee</span>
            <select value={o.assigneeId ?? ""} onChange={(e) => update({ assignee: e.target.value || null })}>
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {callsign(a)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select value={o.priority} onChange={(e) => update({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Model</span>
            <ModelSelect compact commitOnBlur value={o.model ?? ""} defaultLabel={defaultChoice} onChange={(v) => update({ model: v.trim() || null })} />
          </div>
          <label className="field">
            <span>Effort</span>
            <select value={o.effort ?? ""} onChange={(e) => update({ effort: e.target.value || null })}>
              <option value="">{defaultChoice}</option>
              {EFFORT_OPTIONS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="composer">
        <div className="composer-input">
          <textarea
            rows={1}
            placeholder={assignee ? `Comment or give ${assignee.callsign} orders…` : "Comment on this objective…"}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send" aria-label="Send" disabled={!comment.trim()} onClick={send}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
}

function NewObjective({ onDone }: { onDone: (number: number | null) => void }) {
  const agentsMap = useStore((s) => s.agents);
  const pingTarget = useStore((s) => s.pingTarget);
  const picks = useStore((s) => s.settings?.generalPicksModels === true);
  const set = useStore((s) => s.set);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [target, setTarget] = useState(pingTarget ?? "");
  const [priority, setPriority] = useState<Priority>("normal");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const agents = sortedAgents(agentsMap).filter(isManaged);
  const general = agents.find((a) => a.role === "general") ?? agents.find((a) => a.reportsTo === null);
  const defaultChoice = picks && general && assignee !== general.id ? "General picks" : "Assignee's default";
  return (
    <form
      className="obj-form"
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
        ).then((o) => {
          if (!o) return;
          set({ pingTarget: null });
          onDone(o.number);
        });
      }}
    >
      <h3>New objective</h3>
      <label className="field">
        <span>Title</span>
        <input placeholder="e.g. Harden input validation on the API" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>
          Briefing<em>optional</em>
        </span>
        <textarea placeholder="What done looks like" value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="grid3">
        <label className="field">
          <span>Assign to</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {callsign(a)} ({a.role})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" title="Pins the objective on that folder or file on the map, and sends the agent there. Or press Z and click a building.">
          <span>
            Map target<em>optional</em>
          </span>
          <input list="objective-targets" placeholder="e.g. src/server" value={target} onChange={(e) => setTarget(e.target.value)} />
          <TargetList id="objective-targets" />
        </label>
      </div>
      <div className="grid2">
        <div className="field">
          <span>Model</span>
          <ModelSelect value={model} onChange={setModel} defaultLabel={defaultChoice} />
        </div>
        <label className="field">
          <span>Effort</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">{defaultChoice}</option>
            {EFFORT_OPTIONS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={`toggle${picks ? " on" : ""}`}>
        <input type="checkbox" checked={picks} onChange={(e) => void act(() => api.settings({ generalPicksModels: e.target.checked }))} />
        <span>
          <b>General picks models</b> The General chooses the model and effort for each task: for the objectives it hands out, and for yours when you leave Model and Effort on "General picks".
          {picks && !general && " Deploy a General to use this."}
        </span>
      </label>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button className="btn primary" type="submit" disabled={!title.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

function NewMission({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <form
      className="obj-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        void act(() => api.mission(title.trim(), body.trim()), "Mission launched").then((ok) => ok && onDone());
      }}
    >
      <h3>Launch a mission</h3>
      <label className="field">
        <span>Mission for the General</span>
        <input placeholder="e.g. Harden the auth flow" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>
          Briefing<em>optional</em>
        </span>
        <textarea placeholder="What done looks like, constraints, pointers…" value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" type="submit" disabled={!title.trim()}>
          Launch mission
        </button>
      </div>
    </form>
  );
}

export function ObjectivesBoard() {
  const open = useStore((s) => s.objectivesOpen);
  const objectives = useStore((s) => s.objectives);
  const missions = useStore((s) => s.missions);
  const agentsMap = useStore((s) => s.agents);
  const pingTarget = useStore((s) => s.pingTarget);
  const set = useStore((s) => s.set);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "new" | "mission">("view");
  const [showClosed, setShowClosed] = useState<Record<string, boolean>>({});

  // A map ping opens the board with a new objective aimed at the pinged spot.
  useEffect(() => {
    if (open && pingTarget) setMode("new");
  }, [open, pingTarget]);

  const byStatus = useMemo(() => {
    const m: Partial<Record<ObjectiveStatus, ObjectiveView[]>> = {};
    for (const o of Object.values(objectives)) (m[o.status] ??= []).push(o);
    for (const k of GROUPS) m[k]?.sort((a, b) => (OPEN_OBJECTIVE_STATUSES.includes(k) ? a.number - b.number : b.number - a.number));
    return m;
  }, [objectives]);

  if (!open) return null;
  const close = () => {
    setMode("view");
    set({ objectivesOpen: false, pingTarget: null });
  };
  const active = missions.find((m) => m.status === "active");
  const firstOpen = GROUPS.filter((g) => OPEN_OBJECTIVE_STATUSES.includes(g)).flatMap((g) => byStatus[g] ?? [])[0];
  const current = (selected ? objectives[selected] : undefined) ?? firstOpen ?? Object.values(objectives)[0];

  return (
    <Modal
      title="Objectives"
      size="wide"
      onClose={close}
      head={
        <button className="btn sm" onClick={() => setMode("new")}>
          <Icon name="plus" />
          New objective
        </button>
      }
    >
      <div className="obj-split">
        <div className="obj-list" role="listbox" aria-label="Objectives">
          {!active && (
            <div className="mission-cta">
              <span className="grow">No active mission.</span>
              <button className="btn sm" onClick={() => setMode("mission")}>
                Launch a mission
              </button>
            </div>
          )}
          {GROUPS.map((g) => {
            const list = byStatus[g] ?? [];
            if (!list.length && (g === "cancelled" || g === "blocked")) return null;
            const closed = g === "done" || g === "cancelled";
            const shown = !closed || showClosed[g];
            return (
              <div key={g}>
                <button className="obj-group" aria-expanded={shown} onClick={() => closed && setShowClosed({ ...showClosed, [g]: !shown })} disabled={!closed}>
                  {closed ? <Icon name={shown ? "chevDown" : "chevRight"} /> : <StatusIcon status={g} />}
                  {STATUS_LABEL[g]} <em>{list.length}</em>
                </button>
                {shown &&
                  list.map((o) => {
                    const a = o.assigneeId ? agentsMap[o.assigneeId] : undefined;
                    return (
                      <button
                        key={o.id}
                        role="option"
                        aria-selected={mode === "view" && o.id === current?.id}
                        className={`obj-item${mode === "view" && o.id === current?.id ? " active" : ""}`}
                        onClick={() => {
                          setSelected(o.id);
                          setMode("view");
                        }}
                        title={o.title}
                      >
                        <StatusIcon status={o.status} />
                        <span className="mono">#{o.number}</span>
                        <span className="t">{o.title}</span>
                        {o.priority === "high" || o.priority === "critical" ? <span className="pill sm bad">{o.priority === "high" ? "High" : "Critical"}</span> : <span />}
                        {a ? (
                          <span className="letter" title={a.callsign}>
                            {a.letter}
                          </span>
                        ) : (
                          <span className="letter faint" title="Unassigned">
                            –
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
        {mode === "new" ? (
          <NewObjective
            onDone={(n) => {
              setMode("view");
              const made = n === null ? undefined : Object.values(useStore.getState().objectives).find((o) => o.number === n);
              if (made) setSelected(made.id);
            }}
          />
        ) : mode === "mission" ? (
          <NewMission onDone={() => setMode("view")} />
        ) : current ? (
          <ObjectiveDetail key={current.id} o={current} />
        ) : (
          <div className="empty">No objectives yet. Create one, or launch a mission and let the General plan it.</div>
        )}
      </div>
    </Modal>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={o.id === value} className={o.id === value ? "on" : undefined} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <i />
      <span>{on ? "On" : "Off"}</span>
    </button>
  );
}

function Setting({ name, help, children }: { name: string; help: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <b>{name}</b>
        <small>{help}</small>
      </div>
      {children}
    </div>
  );
}

const QUALITY: { id: Quality; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
const EFFECTS: { id: EffectsLevel; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/** Graphics and display preferences, saved in this browser. */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const set = useStore((s) => s.set);
  if (!open) return null;
  const close = () => set({ settingsOpen: false });
  const toggle = (k: keyof Pick<Prefs, "vehicles" | "labels" | "comms" | "hints" | "decor">) => (v: boolean) => setPrefs({ [k]: v });
  const isDefault = (Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]).every((k) => prefs[k] === DEFAULT_PREFS[k]);
  return (
    <Modal
      title="Settings"
      onClose={close}
      foot={
        <>
          <span className="note grow">
            <Icon name="info" />
            Saved in this browser. Changes apply right away.
          </span>
          <button className="btn ghost" disabled={isDefault} onClick={() => setPrefs(DEFAULT_PREFS)}>
            Reset to defaults
          </button>
          <button className="btn primary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="modal-body settings">
        <section>
          <h3 className="label">Graphics</h3>
          <Setting name="Quality" help="Render resolution and shadows. Lower it if the map stutters or your fans spin up.">
            <Segmented label="Quality" value={prefs.quality} options={QUALITY} onChange={(quality) => setPrefs({ quality })} />
          </Setting>
          <Setting name="Explosions and effects" help="Gunfire, explosions, smoke and screen shake. Below medium, aircraft only fire when a file is deleted. Off also skips the camera glitch.">
            <Segmented label="Explosions and effects" value={prefs.effects} options={EFFECTS} onChange={(effects) => setPrefs({ effects })} />
          </Setting>
          <Setting name="Vehicles" help="Helicopters, jets, the drone and the gunship. Off: agents walk everywhere, and deleted files' buildings just collapse.">
            <Switch label="Vehicles" on={prefs.vehicles} onChange={toggle("vehicles")} />
          </Setting>
        </section>
        <section>
          <h3 className="label">Display</h3>
          <Setting name="Agent name labels" help="Callsign and status under each agent on the map.">
            <Switch label="Agent name labels" on={prefs.labels} onChange={toggle("labels")} />
          </Setting>
          <Setting name="Comms log" help="The running log of events under SUPPLY.">
            <Switch label="Comms log" on={prefs.comms} onChange={toggle("comms")} />
          </Setting>
          <Setting name="Key hints" help="The key list under the title. The keys keep working; P opens these settings.">
            <Switch label="Key hints" on={prefs.hints} onChange={toggle("hints")} />
          </Setting>
          <Setting name="Screen decorations" help="Vignette, dot grids and the ruler along the left edge.">
            <Switch label="Screen decorations" on={prefs.decor} onChange={toggle("decor")} />
          </Setting>
        </section>
      </div>
    </Modal>
  );
}

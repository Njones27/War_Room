import { useEffect, useState } from "react";
import type { SatelliteRunView, SatelliteView } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { dayTime, duration, type Tone } from "../lib/format";
import { useStore } from "../lib/store";
import { Icon } from "./icons";
import { MoreMenu } from "./Menu";
import { Rich } from "./Rich";

function statusOf(s: SatelliteView): { text: string; tone: Tone } {
  if (s.running) return { text: "Running", tone: "live" };
  if (!s.enabled) return { text: "Paused", tone: "warn" };
  if (s.lastStatus === "failed") return { text: "Last run failed", tone: "bad" };
  return { text: s.nextRunAt ? "Waiting" : "Idle", tone: "ok" };
}

const RUN_ICON: Record<SatelliteRunView["status"], { mark: string; cls: string }> = {
  starting: { mark: "●", cls: "live" },
  running: { mark: "●", cls: "live" },
  completed: { mark: "✓", cls: "ok" },
  failed: { mark: "✕", cls: "bad" },
  cancelled: { mark: "■", cls: "dim" },
};

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The satellite you clicked: schedule, live state, past runs and its prompt. Same place as the agent panel. */
export function SatellitePanel() {
  const id = useStore((s) => (s.view === "orbit" ? s.selectedSatelliteId : null));
  const sat = useStore((s) => (id ? s.satellites[id] : undefined));
  const runsMap = useStore((s) => s.satelliteRuns);
  const roles = useStore((s) => s.roles);
  const set = useStore((s) => s.set);
  const [tab, setTab] = useState<"runs" | "prompt">("runs");
  const now = useNow(1000);

  if (!sat) return null;
  const own = sat.source === "warroom";
  const role = roles.find((r) => r.id === sat.role);
  const runs = Object.values(runsMap)
    .filter((r) => r.satelliteId === sat.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const live = runs.find((r) => r.status === "running" || r.status === "starting");
  const status = statusOf(sat);
  const close = () => set({ selectedSatelliteId: null });
  const runsAs = [role?.name ?? "No role", sat.model ?? "your default model", sat.effort ? `${sat.effort} effort` : null].filter(Boolean).join(" · ");

  return (
    <section className="intel sat-panel" aria-label={`Satellite: ${sat.name}`}>
      <div className="intel-head">
        {own ? `Satellite · ${role?.name ?? "Scheduled task"}` : "Satellite · Claude app"}
        <button className="head-btn close" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="intel-id">
        <div className="id-row">
          <div className="who">
            <b title={sat.name}>{sat.name}</b>
          </div>
          <span className={`pill ${status.tone}`}>
            <i />
            {status.text}
          </span>
        </div>
        <dl className="sat-meta">
          {sat.running && (
            <>
              <dt>Now</dt>
              <dd className="live-text">
                {sat.activity ?? "Starting"}
                {live ? ` · ${duration(now - live.startedAt)}` : ""}
              </dd>
            </>
          )}
          <dt>Schedule</dt>
          <dd>{sat.scheduleText}</dd>
          <dt>Next run</dt>
          <dd>{sat.nextRunAt ? dayTime(sat.nextRunAt, now) : sat.enabled ? "Not scheduled" : "Paused"}</dd>
          <dt>Last run</dt>
          <dd>{sat.lastRunAt ? dayTime(sat.lastRunAt, now) : "Never"}</dd>
          {own ? (
            <>
              <dt>Runs as</dt>
              <dd>{runsAs}</dd>
            </>
          ) : (
            <>
              <dt>Defined in</dt>
              <dd className="mono" title={sat.path ?? ""}>
                {sat.path ?? "the Claude app"}
              </dd>
            </>
          )}
        </dl>
        {own ? (
          <div className="sat-actions">
            {sat.running ? (
              <button className="btn sm" onClick={() => void act(() => api.stopSatellite(sat.id), "Run stopped")}>
                <Icon name="stop" />
                Stop
              </button>
            ) : (
              <button className="btn sm primary" onClick={() => void act(() => api.runSatellite(sat.id))}>
                <Icon name="play" />
                Run now
              </button>
            )}
            {sat.enabled ? (
              <button className="btn sm" onClick={() => void act(() => api.pauseSatellite(sat.id), `${sat.name} paused`)}>
                <Icon name="pause" />
                Pause
              </button>
            ) : (
              <button className="btn sm" onClick={() => void act(() => api.resumeSatellite(sat.id), `${sat.name} resumed`)}>
                <Icon name="resume" />
                Resume
              </button>
            )}
            <button className="btn sm" onClick={() => set({ launchOpen: true, launchEdit: sat.id })}>
              <Icon name="edit" />
              Edit
            </button>
            <MoreMenu
              down
              label={`More actions for ${sat.name}`}
              items={[{ label: "Delete satellite", danger: true, onClick: () => void act(() => api.deleteSatellite(sat.id), `${sat.name} deleted`) }]}
            />
          </div>
        ) : (
          <p className="sat-note">
            <Icon name="info" />
            Read-only here. Change or run it from Scheduled tasks in the Claude app.
          </p>
        )}
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "runs"} className={`tab${tab === "runs" ? " active" : ""}`} onClick={() => setTab("runs")}>
          Runs{runs.length ? <i>{runs.length}</i> : null}
        </button>
        <button role="tab" aria-selected={tab === "prompt"} className={`tab${tab === "prompt" ? " active" : ""}`} onClick={() => setTab("prompt")}>
          Prompt
        </button>
      </div>
      <div className="tab-body">
        {tab === "prompt" ? (
          <div className="sat-prompt">
            <Rich text={sat.prompt || "(empty)"} />
          </div>
        ) : runs.length === 0 ? (
          <div className="empty">{own ? "No runs yet. Run now starts one, or wait for its schedule." : "War Room can't see this task's runs. They're in the Claude app."}</div>
        ) : (
          <ul className="sat-runs">
            {runs.map((r) => {
              const icon = RUN_ICON[r.status];
              const text = r.status === "running" || r.status === "starting" ? (sat.activity ?? "Running") : r.status === "failed" ? (r.error ?? "Failed") : (r.summary ?? (r.status === "cancelled" ? "Stopped" : "Done"));
              return (
                <li key={r.id} className={`sat-run ${icon.cls}`}>
                  <span className="mark">{icon.mark}</span>
                  <span className="when">
                    {dayTime(r.startedAt, now)}
                    {r.trigger === "manual" && <em>by hand</em>}
                  </span>
                  <span className="took">{duration((r.endedAt ?? now) - r.startedAt)}</span>
                  <span className="what" title={text}>
                    {text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

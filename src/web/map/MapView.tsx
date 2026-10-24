import { useEffect, useMemo, useRef, useState } from "react";
import type { Building, CityModel } from "../../shared/city";
import type { AgentView, ObjectiveView, RoleView } from "../../shared/protocol";
import { OPEN_OBJECTIVE_STATUSES } from "../../shared/protocol";
import { fileSize } from "../lib/format";
import { markerState, pendingApprovals, useStore, type MarkerState } from "../lib/store";
import { Mascot, type MascotActivity } from "../sprites/Mascot";
import { locate, WarMap, zoneRect, type Zone, type ZoneTone } from "./engine";
import { mapRef } from "./mapRef";

interface Mover {
  x: number;
  z: number;
  top: number;
  path: { x: number; z: number; top: number }[];
  facing: 1 | -1;
  /** Travelling by helicopter (waiting, boarding or aboard). */
  lift: boolean;
}

/** On the move: walking, or aboard a helicopter. */
type Motion = "walk" | "ride";

interface Post {
  x: number;
  z: number;
  top: number;
  /** The building it stands on, if any. */
  on: string | null;
}

const SPEED = 42; // world units / second

/**
 * Whether a move is a helicopter job: every deployment out of HQ, and long
 * hops across the city. Short moves are walked.
 */
function airlift(city: CityModel, from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const hq = city.hq.rect;
  const atHq = (p: { x: number; z: number }) => p.x > hq.x - 12 && p.x < hq.x + hq.w + 12 && p.z > hq.y - 12 && p.z < hq.y + hq.h + 12;
  if (atHq(to)) return false;
  if (atHq(from)) return true;
  const span = Math.max(city.bounds.w, city.bounds.h);
  return Math.hypot(to.x - from.x, to.z - from.z) > Math.max(60, span * 0.3);
}

function accessoryFor(a: AgentView, roles: RoleView[]): string {
  if (a.external) return "none";
  if (a.teamLeadId) return "helmet";
  return roles.find((r) => r.id === a.role)?.accessory ?? "beret";
}

/**
 * Where each agent should stand right now. Working agents go to what they're
 * touching (or their objective's target); everyone else holds position, the
 * way units stay in the field. HQ is only where new agents start; teammates
 * start beside their lead. Nobody stands on a building that's been brought
 * down: they drop to street level on its rubble.
 */
function computePosts(city: CityModel, agents: AgentView[], objectives: Record<string, ObjectiveView>, last: Map<string, Post>, ruined: Set<string>): Map<string, Post> {
  const posts = new Map<string, Post>();
  const crowd = new Map<string, number>();
  const pads = city.hq.pads;
  let padIdx = 0;
  let extIdx = 0;
  const mateIdx = new Map<string, number>();
  // Leads first, so a new teammate can fall in beside its lead.
  const ordered = [...agents.filter((a) => !a.teamLeadId), ...agents.filter((a) => a.teamLeadId)];
  for (const a of ordered) {
    const objective = a.objectiveId ? objectives[a.objectiveId] : undefined;
    const atWork = a.status === "running" || a.status === "commanded";
    const where = atWork
      ? ((a.target !== null ? locate(city, a.target) : null) ??
        (objective && OPEN_OBJECTIVE_STATUSES.includes(objective.status) && objective.targetPaths[0] ? locate(city, objective.targetPaths[0]) : null))
      : null;
    const held = last.get(a.id);
    let p: Post;
    if (!where && held) {
      p = held.on && ruined.has(held.on) ? { ...held, top: 0.4 } : held;
    } else if (where) {
      const key = `${Math.round(where.x)}:${Math.round(where.z)}`;
      const n = crowd.get(key) ?? 0;
      crowd.set(key, n + 1);
      const ang = n * 2.4;
      const r = n === 0 ? 0 : 5 + n * 1.5;
      const on = where.building?.path ?? null;
      p = { x: where.x + Math.cos(ang) * r, z: where.z + Math.sin(ang) * r, top: on && ruined.has(on) ? 0.4 : where.top, on };
    } else if (a.teamLeadId && posts.has(a.teamLeadId)) {
      const lead = posts.get(a.teamLeadId)!;
      const i = mateIdx.get(a.teamLeadId) ?? 0;
      mateIdx.set(a.teamLeadId, i + 1);
      const ang = 0.7 + i * 1.9;
      p = { x: lead.x + Math.cos(ang) * 8, z: lead.z + Math.sin(ang) * 8, top: lead.top, on: lead.on };
    } else if (a.external) {
      const hq = city.hq.rect;
      p = { x: hq.x + hq.w * (0.15 + (extIdx++ % 5) * 0.17), z: hq.y + hq.h * 0.92, top: 0.4, on: null };
    } else {
      const pad = pads[padIdx++ % pads.length] ?? [city.hq.rect.x, city.hq.rect.y];
      p = { x: pad[0], z: pad[1], top: 0.4, on: null };
    }
    posts.set(a.id, p);
  }
  return posts;
}

function shapeClass(state: MarkerState): string {
  return state === "needs" || state === "error" ? "diamond" : state === "idle" || state === "offline" ? "square" : "circle";
}

export function MapView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerEls = useRef(new Map<string, HTMLDivElement>());
  const pinEls = useRef(new Map<string, HTMLDivElement>());
  const hqEl = useRef<HTMLDivElement>(null);
  const youEl = useRef<HTMLDivElement>(null);
  const linesRef = useRef<SVGSVGElement>(null);
  const movers = useRef(new Map<string, Mover>());
  const postsRef = useRef(new Map<string, Post>());
  const postsCityRef = useRef<CityModel | null>(null);
  const [motion, setMotion] = useState<Record<string, Motion>>({});
  const motionRef = useRef<Record<string, Motion>>({});
  const seenStrikes = useRef(new Set<string>());
  const [hover, setHover] = useState<{ b: Building; x: number; y: number } | null>(null);

  const city = useStore((s) => s.city);
  const agentsMap = useStore((s) => s.agents);
  const objectives = useStore((s) => s.objectives);
  const approvals = useStore((s) => s.approvals);
  const roles = useStore((s) => s.roles);
  const selectedId = useStore((s) => s.selectedAgentId);
  const pingMode = useStore((s) => s.pingMode);
  const pingTarget = useStore((s) => s.pingTarget);
  const zoomPct = useStore((s) => s.zoomPct);
  const strikes = useStore((s) => s.strikes);
  const destroyed = useStore((s) => s.destroyed);
  const destroyedSet = useMemo(() => new Set(destroyed), [destroyed]);

  const agents = useMemo(() => Object.values(agentsMap).filter((a) => a.status !== "terminated"), [agentsMap]);
  const needs = useMemo(() => new Set(pendingApprovals(approvals).map((a) => a.agentId)), [approvals]);
  const pins = useMemo(() => Object.values(objectives).filter((o) => o.targetPaths.length && o.status !== "cancelled" && (o.status !== "done" || Date.now() - o.updatedAt < 60_000)), [objectives]);

  // Engine lifecycle.
  useEffect(() => {
    const map = new WarMap(canvasRef.current!, {
      onHover: (b, x, y) => setHover(b ? { b, x, y } : null),
      onClick: (b, _world, ev) => {
        const st = useStore.getState();
        if (st.pingMode && b) {
          // Ripple first, then open the objectives board on the pinged building.
          map.ping(b.path);
          st.set({ pingMode: false, pingTarget: b.path });
          setTimeout(() => useStore.getState().pingTarget === b.path && useStore.getState().set({ objectivesOpen: true }), 700);
          return;
        }
        if (b && !ev.shiftKey) st.set({ focusPath: b.path });
      },
      onZoom: (pct) => useStore.getState().set({ zoomPct: pct }),
      onFrame: (t) => tick(t),
    });
    mapRef.map = map;
    if (import.meta.env.DEV) (window as unknown as { __warmap: WarMap }).__warmap = map;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const nextMotion: Record<string, Motion> = {};
      for (const [id, m] of movers.current) {
        const ride = m.lift ? map.air.liftState(id) : null;
        if (m.lift && !ride) m.lift = false;
        if (ride) {
          // The air wing has this agent: walking out to the pad, aboard, or fast-roping down.
          if (Math.abs(ride.x - m.x) > 0.05) m.facing = ride.x < m.x ? -1 : 1;
          m.x = ride.x;
          m.z = ride.z;
          m.top = ride.top;
          if (ride.walking) nextMotion[id] = "walk";
          else if (ride.embarked) nextMotion[id] = "ride";
          if (ride.phase === "done" || ride.phase === "abandoned") {
            map.air.endLift(id);
            m.lift = false;
            // Walk the rest of the way (all of it, if no helicopter came).
            const post = postsRef.current.get(id);
            if (post && Math.hypot(post.x - m.x, post.z - m.z) > 0.5) {
              m.path = [
                { x: post.x, z: m.z, top: 0.4 },
                { x: post.x, z: post.z, top: post.top },
              ];
            }
          }
        }
        const goal = m.lift ? undefined : m.path[0];
        if (goal) {
          const dx = goal.x - m.x;
          const dz = goal.z - m.z;
          const dist = Math.hypot(dx, dz);
          const step = SPEED * dt;
          if (Math.abs(dx) > 0.3) m.facing = dx < 0 ? -1 : 1;
          if (dist <= step) {
            m.x = goal.x;
            m.z = goal.z;
            m.top = goal.top;
            m.path.shift();
          } else {
            m.x += (dx / dist) * step;
            m.z += (dz / dist) * step;
            m.top = 0.4;
          }
          if (m.path.length) nextMotion[id] = "walk";
        }
        mapRef.positions.set(id, { x: m.x, z: m.z });
        const el = markerEls.current.get(id);
        if (el) {
          const p = map.project(m.x, m.top + 1.5, m.z);
          el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
          el.style.visibility = p.visible ? "visible" : "hidden";
          el.dataset.facing = String(m.facing);
        }
      }
      // Re-render only when someone starts or stops moving.
      const prev = motionRef.current;
      const changed = Object.keys(nextMotion).some((k) => prev[k] !== nextMotion[k]) || Object.keys(prev).some((k) => !nextMotion[k]);
      if (changed) {
        motionRef.current = nextMotion;
        setMotion(nextMotion);
      }
      positionStatic(map);
      drawLines(map);
      const sel = useStore.getState().selectedAgentId;
      const selPos = sel ? mapRef.positions.get(sel) : null;
      map.setCamView(mapRef.camBox && selPos ? mapRef.camBox.getBoundingClientRect() : null, selPos ?? null);
    };
    return () => {
      map.dispose();
      mapRef.map = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const positionStatic = (map: WarMap) => {
    const c = useStore.getState().city;
    if (!c) return;
    for (const [id, el] of pinEls.current) {
      const o = useStore.getState().objectives[id];
      const at = o ? locate(c, o.targetPaths[0] ?? null) : null;
      if (!at) continue;
      const p = map.project(at.x, at.top + 0.5, at.z);
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    }
    const hq = c.hq.rect;
    if (hqEl.current) {
      const p = map.project(hq.x + hq.w * 0.18, 1, hq.y + hq.h * 0.3);
      hqEl.current.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    }
    if (youEl.current) {
      const p = map.project(hq.x + hq.w * 0.5, 1, hq.y + hq.h * 0.36);
      youEl.current.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    }
  };

  const drawLines = (map: WarMap) => {
    const svg = linesRef.current;
    if (!svg) return;
    const st = useStore.getState();
    const parts: string[] = [];
    for (const a of Object.values(st.agents)) {
      const m = movers.current.get(a.id);
      if (!m) continue;
      const from = map.project(m.x, m.top + 1.5, m.z);
      // Command links: superior → subordinate on assignment; a lead → its working teammates.
      if (a.reportsTo && (a.status === "running" || a.status === "queued")) {
        const boss = movers.current.get(a.reportsTo);
        if (boss) {
          const to = map.project(boss.x, boss.top + 1.5, boss.z);
          parts.push(`<line x1="${to.x}" y1="${to.y}" x2="${from.x}" y2="${from.y}" class="${a.teamLeadId ? "ln-squad" : "ln-command"}"/>`);
        }
      }
      // Movement order: dashed line to the destination (BF6 squad order style).
      const dest = m.path[m.path.length - 1] ?? (m.lift ? postsRef.current.get(a.id) : undefined);
      if (dest) {
        const to = map.project(dest.x, dest.top + 1.5, dest.z);
        parts.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="ln-move"/>`);
      }
      if (a.id === st.selectedAgentId && st.city) {
        const o = a.objectiveId ? st.objectives[a.objectiveId] : null;
        const at = o?.targetPaths[0] ? locate(st.city, o.targetPaths[0]) : null;
        if (at && !dest) {
          const to = map.project(at.x, at.top + 0.5, at.z);
          parts.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="ln-objective"/>`);
        }
      }
    }
    svg.innerHTML = parts.join("");
  };

  // City changes.
  useEffect(() => {
    if (city && mapRef.map) mapRef.map.setCity(city);
  }, [city]);

  // Deleted files: the gunship brings their buildings down (live), or they're already rubble (on load).
  useEffect(() => {
    const map = mapRef.map;
    if (!map || !city) return;
    for (const st of strikes) {
      if (seenStrikes.current.has(st.id)) continue;
      seenStrikes.current.add(st.id);
      map.strike(st.paths);
    }
  }, [strikes, city]);
  useEffect(() => {
    if (city && mapRef.map) mapRef.map.setDestroyed(destroyed);
  }, [destroyed, city]);

  // A ping stays lit while its objective is being written.
  useEffect(() => mapRef.map?.holdPing(pingTarget), [pingTarget]);

  // Posts → movement paths.
  useEffect(() => {
    if (!city) return;
    // A rescan moves buildings, so held positions only carry over within one city.
    const held = postsCityRef.current === city ? postsRef.current : new Map<string, Post>();
    postsCityRef.current = city;
    const posts = computePosts(city, agents, objectives, held, destroyedSet);
    postsRef.current = posts;
    const air = mapRef.map?.air;
    for (const [id, post] of posts) {
      const m = movers.current.get(id);
      if (!m) {
        movers.current.set(id, { x: post.x, z: post.z, top: post.top, path: [], facing: 1, lift: false });
        continue;
      }
      if (m.lift && air) {
        const ride = air.liftState(id);
        // Still waiting for a helicopter and the new post is a short walk: walk it.
        if (ride?.phase === "queued" && !airlift(city, m, post)) {
          air.endLift(id);
          m.lift = false;
        } else {
          air.retarget(id, post);
          continue;
        }
      }
      const end = m.path[m.path.length - 1] ?? { x: m.x, z: m.z };
      if (Math.hypot(end.x - post.x, end.z - post.z) < 0.5) {
        // Same spot, new height (its building came down): settle onto the rubble.
        const last = m.path[m.path.length - 1];
        if (last) last.top = post.top;
        else if (!m.lift) m.top = post.top;
        continue;
      }
      if (air && airlift(city, m, post)) {
        m.path = [];
        m.lift = true;
        air.requestLift(id, { x: m.x, z: m.z, top: m.top }, post);
        continue;
      }
      // Move along the street grid: east-west first, then north-south.
      m.path = [
        { x: post.x, z: m.z, top: 0.4 },
        { x: post.x, z: post.z, top: post.top },
      ];
    }
    for (const id of [...movers.current.keys()]) {
      if (posts.has(id)) continue;
      movers.current.delete(id);
      air?.endLift(id);
    }
  }, [city, agents, objectives, destroyedSet]);

  // Building highlights + capture zones.
  useEffect(() => {
    const map = mapRef.map;
    if (!map || !city) return;
    const tones = new Map<string, ZoneTone>();
    const zones = new Map<string, Zone>();
    for (const a of agents) {
      if (a.target === null || !(a.status === "running" || a.status === "commanded" || a.external)) continue;
      const tone: ZoneTone = needs.has(a.id) || a.activity === "needs_you" ? "orange" : a.id === selectedId ? "yellow" : "cyan";
      const at = locate(city, a.target);
      if (at?.building) tones.set(at.building.path, tone);
      const rect = zoneRect(city, a.target);
      if (rect) {
        const key = `${rect.x},${rect.y}`;
        const prev = zones.get(key);
        if (!prev || tone === "orange" || (tone === "yellow" && prev.tone === "cyan")) zones.set(key, { key, rect, tone });
      }
    }
    map.setHighlights(tones);
    map.setZones([...zones.values()]);
  }, [agents, city, needs, selectedId]);

  return (
    <div className={`map-view${pingMode ? " ping" : ""}`}>
      <canvas ref={canvasRef} className="map-canvas" />
      <svg ref={linesRef} className="map-lines" />
      <div className="map-overlay">
        {city && (
          <>
            <div ref={hqEl} className="hq-badge">
              <div className="hq-slots">
                {roles.slice(0, 3).map((r) => (
                  <button
                    key={r.id}
                    className="hq-slot"
                    title={`Deploy ${r.name}`}
                    onClick={() => useStore.getState().set({ selectedRole: r.id, deployOpen: true })}
                  >
                    <RoleGlyph icon={r.icon} />
                  </button>
                ))}
              </div>
              <div className="hq-frame">
                <div className="hq-circle">HQ</div>
              </div>
            </div>
            <div ref={youEl} className="you-marker">
              <span className="you-label">You</span>
              <span className="you-x">✕</span>
            </div>
          </>
        )}
        {pins.map((o) => (
          <div
            key={o.id}
            ref={(el) => {
              if (el) pinEls.current.set(o.id, el);
              else pinEls.current.delete(o.id);
            }}
            className={`objective-pin st-${o.status}`}
            title={`#${o.number} ${o.title}`}
            onClick={() => useStore.getState().set({ objectivesOpen: true })}
          >
            {o.status === "done" ? "✓" : o.number}
          </div>
        ))}
        {agents.map((a) => {
          const state = markerState(a, needs.has(a.id));
          const selected = a.id === selectedId;
          const activity: MascotActivity = motion[a.id] === "walk" ? "walking" : a.external && a.status !== "running" ? "idle" : a.activity;
          const quietIdle = !a.external && a.status === "idle" && Date.now() - a.lastEventAt > 10 * 60_000;
          return (
            <div
              key={a.id}
              ref={(el) => {
                if (el) markerEls.current.set(a.id, el);
                else markerEls.current.delete(a.id);
              }}
              className={`agent-marker ms-${state}${selected ? " selected" : ""}${a.external ? " external" : ""}${a.teamLeadId ? " mate" : ""}${zoomPct > 120 ? " close" : ""}${motion[a.id] === "ride" ? " embarked" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                const st = useStore.getState();
                st.select(selected ? null : a.id);
              }}
            >
              <div className="am-mascot">
                <Mascot accessory={accessoryFor(a, roles)} activity={quietIdle && activity === "idle" ? "asleep" : activity} scale={2} flip={false} dim={state === "offline"} />
              </div>
              <div className={`am-shape ${shapeClass(state)}`}>
                <span>{a.letter}</span>
              </div>
              {selected && (
                <div className="am-brackets">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              )}
              {a.subagents > 0 && (
                <div className="am-squad">
                  {Array.from({ length: Math.min(6, a.subagents) }, (_, i) => (
                    <b key={i} style={{ transform: `rotate(${i * 60}deg) translateY(-26px)` }} />
                  ))}
                </div>
              )}
              <div className="am-label">
                {a.external ? a.callsign : `${a.letter} · ${a.callsign}`}
                {(selected || zoomPct > 140) && a.activityDetail && <small>{a.activityDetail}</small>}
              </div>
            </div>
          );
        })}
      </div>
      {hover && (
        <div className="map-tooltip" style={{ transform: `translate(${hover.x + 14}px, ${hover.y + 14}px)` }}>
          <div className="tt-path">{hover.b.path}</div>
          <div className="tt-meta">
            {hover.b.cluster > 1 ? `${hover.b.cluster} files · ` : ""}
            {hover.b.asset ? fileSize(hover.b.bytes) : `${hover.b.lines.toLocaleString()} lines`}
          </div>
          {destroyedSet.has(hover.b.path) && <div className="tt-destroyed">Destroyed: file deleted</div>}
          {pingMode && <div className="tt-ping">Click to create an objective here</div>}
        </div>
      )}
    </div>
  );
}

export function RoleGlyph({ icon, size = 18 }: { icon: string; size?: number }) {
  const s = { width: size, height: size };
  switch (icon) {
    case "star":
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M12 2.5l2.7 6.1 6.6.6-5 4.4 1.5 6.5L12 16.8 6.2 20.1l1.5-6.5-5-4.4 6.6-.6z" fill="currentColor" />
        </svg>
      );
    case "wrench":
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M14.7 3.3a5 5 0 00-6 6.4L3 15.4 3.9 20l4.6.9 5.7-5.7a5 5 0 006.4-6l-3 3-3.2-.8-.8-3.2z" fill="currentColor" />
        </svg>
      );
    case "shield":
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z" fill="none" stroke="currentColor" strokeWidth="2.4" />
        </svg>
      );
    case "binoculars":
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M5 5h4v4H5zM15 5h4v4h-4zM3 11h8v8H3zM13 11h8v8h-8zM10 11h4v3h-4z" fill="currentColor" />
        </svg>
      );
    case "cross":
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor" />
        </svg>
      );
    case "antenna":
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M11 9h2v12h-2zM6.3 4.3l1.4 1.4a6 6 0 000 8.6l-1.4 1.4a8 8 0 010-11.4zM17.7 4.3a8 8 0 010 11.4l-1.4-1.4a6 6 0 000-8.6zM12 6a3 3 0 110 6 3 3 0 010-6z" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" style={s} aria-hidden>
          <path d="M12 3l9 16H3z" fill="none" stroke="currentColor" strokeWidth="2.6" />
        </svg>
      );
  }
}

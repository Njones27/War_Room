import { create } from "zustand";
import type { Building, CityModel } from "../../shared/city";
import type {
  AgentView,
  ApprovalView,
  CommsCheck,
  CommsEntry,
  FeedItem,
  FrontView,
  MissionView,
  ObjectiveView,
  OrderView,
  RoleView,
  RunView,
  ServerMsg,
  Settings,
  Snapshot,
  StrikeView,
  TheaterView,
} from "../../shared/protocol";
import { loadPrefs, savePrefs, type Prefs } from "./prefs";

export type IntelTab = "feed" | "objectives" | "files" | "terminal";

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

/** Intel panel size in px. A null height fills the space above DEPLOY. */
export interface IntelSize {
  w: number;
  h: number | null;
}

export const DEFAULT_INTEL_SIZE: IntelSize = { w: 380, h: null };
// v2: sizes moved from rem to px when panels stopped scaling with the HUD.
const INTEL_SIZE_KEY = "warroom.intel-size.v2";

function loadIntelSize(): IntelSize {
  try {
    const v = JSON.parse(localStorage.getItem(INTEL_SIZE_KEY) ?? "null") as Partial<IntelSize> | null;
    if (v && typeof v.w === "number" && (v.h === null || typeof v.h === "number")) return { w: v.w, h: v.h };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_INTEL_SIZE;
}

export function saveIntelSize(size: IntelSize): void {
  try {
    localStorage.setItem(INTEL_SIZE_KEY, JSON.stringify(size));
  } catch {
    /* storage unavailable */
  }
}

interface State {
  connected: boolean;
  authError: string | null;
  ready: boolean;
  theater: TheaterView | null;
  agents: Record<string, AgentView>;
  objectives: Record<string, ObjectiveView>;
  missions: MissionView[];
  approvals: Record<string, ApprovalView>;
  runs: Record<string, RunView>;
  orders: OrderView[];
  comms: CommsEntry[];
  feed: Record<string, FeedItem[]>;
  /** Streaming assistant text for each agent's live turn. */
  live: Record<string, string>;
  roles: RoleView[];
  city: CityModel | null;
  /** Buildings whose files were deleted since the last scan. */
  destroyed: string[];
  /** Strikes received live (each one plays once on the map). */
  strikes: StrikeView[];
  commsCheck: CommsCheck | null;
  fronts: FrontView[];
  settings: Settings | null;

  // UI
  selectedAgentId: string | null;
  /** The agent type picked in the DEPLOY dialog (none until you choose). */
  selectedRole: string | null;
  hoverBuilding: Building | null;
  focusPath: string | null;
  pingMode: boolean;
  pingTarget: string | null;
  deployOpen: boolean;
  manageOpen: boolean;
  objectivesOpen: boolean;
  settingsOpen: boolean;
  /** Display preferences, saved in this browser. */
  prefs: Prefs;
  intelTab: IntelTab;
  intelSize: IntelSize;
  /** The intel panel fills the screen. */
  intelFull: boolean;
  zoomPct: number;
  toasts: Toast[];
  /** Agent whose TAKE COMMAND terminal is open. */
  terminalFor: string | null;

  apply(msg: ServerMsg): void;
  set(patch: Partial<State>): void;
  select(agentId: string | null): void;
  setPrefs(patch: Partial<Prefs>): void;
  toast(level: Toast["level"], text: string): void;
}

const FEED_LIMIT = 160;
let toastSeq = 0;

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

function groupFeed(items: FeedItem[]): Record<string, FeedItem[]> {
  const out: Record<string, FeedItem[]> = {};
  for (const f of items) (out[f.agentId] ??= []).push(f);
  return out;
}

function loadSnapshot(s: Snapshot): Partial<State> {
  return {
    ready: true,
    theater: s.theater,
    agents: byId(s.agents),
    objectives: byId(s.objectives),
    missions: s.missions,
    approvals: byId(s.approvals),
    runs: byId(s.runs),
    orders: s.orders,
    comms: s.comms,
    feed: groupFeed(s.feed),
    roles: s.roles,
    city: s.city,
    destroyed: s.destroyed ?? [],
    strikes: [],
    commsCheck: s.commsCheck,
    fronts: s.fronts,
    settings: s.settings,
  };
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  authError: null,
  ready: false,
  theater: null,
  agents: {},
  objectives: {},
  missions: [],
  approvals: {},
  runs: {},
  orders: [],
  comms: [],
  feed: {},
  live: {},
  roles: [],
  city: null,
  destroyed: [],
  strikes: [],
  commsCheck: null,
  fronts: [],
  settings: null,

  selectedAgentId: null,
  selectedRole: null,
  hoverBuilding: null,
  focusPath: null,
  pingMode: false,
  pingTarget: null,
  deployOpen: false,
  manageOpen: false,
  objectivesOpen: false,
  settingsOpen: false,
  prefs: loadPrefs(),
  intelTab: "feed",
  intelSize: loadIntelSize(),
  intelFull: false,
  zoomPct: 100,
  toasts: [],
  terminalFor: null,

  set: (patch) => set(patch),

  select: (agentId) =>
    set({ selectedAgentId: agentId, intelTab: agentId && get().selectedAgentId === agentId ? get().intelTab : "feed", ...(agentId ? {} : { intelFull: false }) }),

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    savePrefs(prefs);
    set({ prefs });
  },

  toast: (level, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === "error" ? 7000 : 4500);
  },

  apply: (msg) => {
    switch (msg.t) {
      case "snapshot":
        set(loadSnapshot(msg.snapshot));
        return;
      case "agent":
        set((s) => {
          if (msg.agent.status === "terminated") {
            const { [msg.agent.id]: _gone, ...rest } = s.agents;
            return { agents: rest, selectedAgentId: s.selectedAgentId === msg.agent.id ? null : s.selectedAgentId };
          }
          return { agents: { ...s.agents, [msg.agent.id]: msg.agent } };
        });
        return;
      case "agent_removed":
        set((s) => {
          const { [msg.id]: _gone, ...rest } = s.agents;
          return { agents: rest, selectedAgentId: s.selectedAgentId === msg.id ? null : s.selectedAgentId };
        });
        return;
      case "objective":
        set((s) => ({ objectives: { ...s.objectives, [msg.objective.id]: msg.objective } }));
        return;
      case "mission":
        set((s) => ({ missions: [msg.mission, ...s.missions.filter((m) => m.id !== msg.mission.id)] }));
        return;
      case "approval":
        set((s) => ({ approvals: { ...s.approvals, [msg.approval.id]: msg.approval } }));
        return;
      case "run":
        set((s) => {
          const live = msg.run.status === "completed" || msg.run.status === "failed" || msg.run.status === "cancelled" ? { ...s.live, [msg.run.agentId]: "" } : s.live;
          return { runs: { ...s.runs, [msg.run.id]: msg.run }, live };
        });
        return;
      case "order":
        set((s) => ({ orders: [...s.orders.filter((o) => o.id !== msg.order.id), msg.order].slice(-400) }));
        return;
      case "feed":
        set((s) => {
          const list = [...(s.feed[msg.item.agentId] ?? []), msg.item].slice(-FEED_LIMIT);
          const live = msg.item.kind === "text" || msg.item.kind === "tool_use" ? { ...s.live, [msg.item.agentId]: "" } : s.live;
          return { feed: { ...s.feed, [msg.item.agentId]: list }, live };
        });
        return;
      case "text_delta":
        set((s) => ({ live: { ...s.live, [msg.agentId]: ((s.live[msg.agentId] ?? "") + msg.text).slice(-4000) } }));
        return;
      case "comms":
        set((s) => ({ comms: [...s.comms, msg.entry].slice(-200) }));
        return;
      case "city":
        set({ city: msg.city, destroyed: [] });
        return;
      case "strike":
        set((s) => ({ strikes: [...s.strikes, msg.strike].slice(-30), destroyed: [...new Set([...s.destroyed, ...msg.strike.paths])] }));
        return;
      case "comms_check":
        set({ commsCheck: msg.check });
        return;
      case "fronts":
        set({ fronts: msg.fronts });
        return;
      case "settings":
        set({ settings: msg.settings });
        return;
      case "toast":
        get().toast(msg.level, msg.text);
        return;
      case "term":
      case "term_exit":
        return; // consumed by the terminal view
    }
  },
}));

// ── Selectors ──────────────────────────────────────────────────────────────

export function sortedAgents(agents: Record<string, AgentView>): AgentView[] {
  return Object.values(agents).sort((a, b) => {
    if (a.external !== b.external) return a.external ? 1 : -1;
    if (a.letter.length !== b.letter.length) return a.letter.length - b.letter.length;
    return a.letter.localeCompare(b.letter, undefined, { numeric: true });
  });
}

/** Agents War Room runs and the Commander manages (not watch-only units or teammates). */
export const isManaged = (a: AgentView) => !a.external && !a.teamLeadId;

/** The squad in roster order: each agent followed by its teammates (no watch-only units). */
export function squadOrder(agents: Record<string, AgentView>): AgentView[] {
  const all = sortedAgents(agents);
  return all.filter(isManaged).flatMap((a) => [a, ...all.filter((m) => m.teamLeadId === a.id)]);
}

export function pendingApprovals(approvals: Record<string, ApprovalView>): ApprovalView[] {
  return Object.values(approvals)
    .filter((a) => a.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

export type MarkerState = "working" | "idle" | "needs" | "error" | "offline";

export function markerState(a: AgentView, hasPending: boolean): MarkerState {
  if (a.status === "paused" || a.status === "terminated" || a.activity === "offline") return "offline";
  if (hasPending || a.activity === "needs_you") return "needs";
  if (a.activity === "error") return "error";
  if (a.status === "running" || a.status === "commanded") return "working";
  return "idle";
}

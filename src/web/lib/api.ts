import type { AgentView, ApprovalView, MissionView, ObjectiveStatus, ObjectiveView, OrderView, PermissionOverride, Priority, Settings, Snapshot, SupplyMode } from "../../shared/protocol";
import { useStore } from "./store";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) useStore.getState().set({ authError: data.error ?? "Not authorized" });
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** Run an action and surface failures as a toast instead of throwing. */
export async function act<T>(fn: () => Promise<T>, success?: string): Promise<T | null> {
  try {
    const out = await fn();
    if (success) useStore.getState().toast("info", success);
    return out;
  } catch (err) {
    useStore.getState().toast("error", (err as Error).message);
    return null;
  }
}

export interface DeployBody {
  role: string;
  callsign?: string | null;
  reportsTo?: string | null;
  model?: string | null;
  effort?: string | null;
  budgetUsd?: number | null;
  teamMode?: boolean;
  mission?: { title: string; body?: string } | null;
  objective?: { title: string; body?: string; targetPaths?: string[]; priority?: Priority } | null;
}

export const api = {
  snapshot: () => call<Snapshot>("GET", "/api/snapshot"),
  deploy: (b: DeployBody) => call<AgentView>("POST", "/api/agents", b),
  updateAgent: (id: string, patch: Record<string, unknown>) => call<AgentView>("PATCH", `/api/agents/${id}`, patch),
  wake: (id: string) => call<AgentView>("POST", `/api/agents/${id}/wake`, {}),
  pause: (id: string) => call<AgentView>("POST", `/api/agents/${id}/pause`, {}),
  resume: (id: string) => call<AgentView>("POST", `/api/agents/${id}/resume`, {}),
  recall: (id: string) => call<{ recalled: boolean }>("POST", `/api/agents/${id}/recall`, {}),
  dismiss: (id: string, removeWorktree: boolean) => call<{ worktree: string | null }>("POST", `/api/agents/${id}/dismiss`, { removeWorktree }),
  order: (id: string, body: string, objectiveId?: string | null) => call<OrderView | { ok: boolean }>("POST", `/api/agents/${id}/orders`, { body, objectiveId }),
  files: (id: string) => call<{ path: string; tool: string; at: number }[]>("GET", `/api/agents/${id}/files`),
  session: (id: string) => call<{ sessionId: string | null; cwd: string; command: string | null }>("GET", `/api/agents/${id}/session`),
  takeCommand: (id: string, cols: number, rows: number) => call<{ ok: boolean; buffer?: string; sessionId?: string; team?: boolean }>("POST", `/api/agents/${id}/command`, { cols, rows }),
  release: (id: string) => call<{ ok: boolean }>("DELETE", `/api/agents/${id}/command`),
  mission: (title: string, body: string) => call<MissionView>("POST", "/api/missions", { title, body }),
  createObjective: (b: { title: string; body?: string; assignee?: string | null; parent?: string | null; priority?: Priority; targetPaths?: string[]; model?: string | null; effort?: string | null }) =>
    call<ObjectiveView>("POST", "/api/objectives", b),
  updateObjective: (id: string, patch: { status?: ObjectiveStatus; comment?: string; assignee?: string | null; priority?: Priority; model?: string | null; effort?: string | null }) =>
    call<ObjectiveView>("PATCH", `/api/objectives/${id}`, patch),
  decide: (id: string, approved: boolean, opts: { always?: boolean; note?: string } = {}) => call<ApprovalView>("POST", `/api/approvals/${id}`, { approved, ...opts }),
  rescan: () => call<{ ok: boolean }>("POST", "/api/city/rescan", {}),
  commsCheck: () => call("POST", "/api/comms-check", {}),
  settings: (patch: { supplyMode?: SupplyMode; generalPicksModels?: boolean; permissionMode?: PermissionOverride }) => call<Settings>("PATCH", "/api/settings", patch),
};

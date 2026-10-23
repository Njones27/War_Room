// Requests that need the Commander's decision. Tool-permission prompts are
// blocking (the agent's run waits); the rest are fire-and-forget and their
// side effects run in HQ once decided.
import type { ApprovalKind, ApprovalView } from "../shared/protocol.js";
import type { Store } from "./store.js";

export interface Decision {
  approved: boolean;
  always: boolean;
  note: string | null;
  expired: boolean;
}

export interface ApprovalRequest {
  theaterId: string;
  kind: ApprovalKind;
  agentId: string | null;
  runId: string | null;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

type ResolvedHandler = (approval: ApprovalView, decision: Decision) => void;

export class Approvals {
  private readonly waiters = new Map<string, { resolve: (d: Decision) => void; timer: NodeJS.Timeout }>();
  private readonly handlers: ResolvedHandler[] = [];

  constructor(
    private readonly store: Store,
    private readonly timeoutMs: number,
  ) {}

  onResolved(fn: ResolvedHandler): void {
    this.handlers.push(fn);
  }

  /** Non-blocking request; side effects happen in onResolved handlers. */
  request(req: ApprovalRequest): ApprovalView {
    return this.store.createApproval(req);
  }

  /** Blocking request: resolves when the Commander decides, or denies on timeout. */
  requestAndWait(req: ApprovalRequest, signal?: AbortSignal): { approval: ApprovalView; decision: Promise<Decision> } {
    const approval = this.store.createApproval(req);
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.expire(approval.id, "No decision before the timeout"), this.timeoutMs);
      timer.unref?.();
      this.waiters.set(approval.id, { resolve, timer });
      signal?.addEventListener("abort", () => this.expire(approval.id, "The request was cancelled"), { once: true });
    });
    return { approval, decision };
  }

  decide(id: string, approved: boolean, opts: { always?: boolean; note?: string | null } = {}): ApprovalView | null {
    const current = this.store.getApproval(id);
    if (!current || current.status !== "pending") return current;
    const resolution = [approved ? (opts.always ? "approved (always)" : "approved") : "denied", opts.note].filter(Boolean).join(": ");
    const approval = this.store.resolveApproval(id, approved ? "approved" : "denied", resolution);
    const decision: Decision = { approved, always: Boolean(opts.always), note: opts.note ?? null, expired: false };
    this.settle(id, decision);
    if (approval) for (const h of this.handlers) h(approval, decision);
    return approval;
  }

  expire(id: string, note: string): void {
    const current = this.store.getApproval(id);
    if (current?.status === "pending") this.store.resolveApproval(id, "expired", note);
    this.settle(id, { approved: false, always: false, note, expired: true });
  }

  /** A run ended: its open permission prompts can no longer be answered. */
  expireRun(runId: string): void {
    for (const a of this.store.pendingApprovalsForRun(runId)) {
      if (a.kind === "tool_permission") this.expire(a.id, "The sortie ended");
    }
  }

  isWaiting(id: string): boolean {
    return this.waiters.has(id);
  }

  private settle(id: string, decision: Decision): void {
    const w = this.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(decision);
  }
}

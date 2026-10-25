import { useMemo, useState } from "react";
import type { ApprovalView } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { ago } from "../lib/format";
import { pendingApprovals, useStore } from "../lib/store";
import { Mascot } from "../sprites/Mascot";
import { Rich } from "./Rich";

const KIND_SUB: Record<ApprovalView["kind"], string> = {
  tool_permission: "Permission request",
  reinforcements: "Reinforcements request",
  merge: "Merge request",
  budget: "Resupply request",
};

/** The part of an always-allow rule people recognize: the command, the domain or the file name. */
function ruleLabel(rule: string): string {
  const m = /^(\w+)\((.*)\)$/.exec(rule);
  if (!m) return rule;
  const tool = m[1]!;
  const arg = m[2]!;
  const text = tool === "WebFetch" ? arg.replace(/^domain:/, "") : tool === "Bash" || tool === "PowerShell" ? arg : (arg.split("/").pop() ?? arg);
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

function Card({ a, index, count, onNext }: { a: ApprovalView; index: number; count: number; onNext: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = useStore((s) => (a.agentId ? s.agents[a.agentId] : undefined));
  const role = useStore((s) => (agent ? s.roles.find((r) => r.id === agent.role) : undefined));
  const select = useStore((s) => s.select);
  // ALWAYS ALLOW is offered only when the server could name an exact rule (a command, file or domain).
  const alwaysRule = typeof a.payload.alwaysRule === "string" ? a.payload.alwaysRule : null;
  const decide = async (approved: boolean, always = false) => {
    setBusy(true);
    await act(() => api.decide(a.id, approved, { always, note: note.trim() || undefined }));
    setBusy(false);
  };
  // Titles start with the agent's letter ("C·Hammer wants…"); the line below names the agent.
  const title = a.title.replace(/^[A-Z]{1,2}·/, "");
  const sub = [agent ? `${agent.letter} · ${agent.teamLeadId ? "Teammate" : (role?.title ?? agent.role)}` : null, KIND_SUB[a.kind], ago(a.createdAt) === "now" ? "just now" : `${ago(a.createdAt)} ago`].filter(Boolean).join(" · ");
  return (
    <div className="approval" role="alertdialog" aria-label={a.title}>
      <div className="approval-stripe" />
      <div className="approval-head">
        {agent && (
          <button className="avatar lg" title={`Open ${agent.callsign}`} onClick={() => select(agent.id)}>
            <Mascot accessory={agent.external ? "none" : agent.teamLeadId ? "helmet" : (role?.accessory ?? "beret")} activity="idle" scale={1.6} />
          </button>
        )}
        <div className="grow">
          <span className="approval-title">
            <Rich text={title} />
          </span>
          <span className="approval-sub">{sub}</span>
        </div>
        <span className="pill warn">
          <i />
          Needs you
        </span>
      </div>
      {a.detail && <pre className="approval-detail">{a.detail}</pre>}
      {a.kind !== "tool_permission" && (
        <input className="input approval-note" placeholder="Note to the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      )}
      <div className="approval-foot">
        {count > 1 ? (
          <button className="btn sm ghost" onClick={onNext} title="Show the next request">
            {index + 1} of {count} · next
          </button>
        ) : (
          <span className="approval-count">1 waiting</span>
        )}
        <span className="grow" />
        <button className="btn ghost" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
        {a.kind === "tool_permission" && alwaysRule && (
          <button className="btn" disabled={busy} onClick={() => void decide(true, true)} title={`Approve, and allow ${alwaysRule} for ${a.payload.team === true ? "the whole team" : "this agent"} from now on`}>
            Always allow <span className="rule">{ruleLabel(alwaysRule)}</span>
          </button>
        )}
        <button className="btn primary" disabled={busy} onClick={() => void decide(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}

/** Requests waiting on the Commander, one at a time above the agent bar. */
export function Approvals() {
  const approvals = useStore((s) => s.approvals);
  const pending = useMemo(() => pendingApprovals(approvals), [approvals]);
  // Track the request you're looking at by id, so it stays put when others are resolved.
  const [pickId, setPickId] = useState<string | null>(null);
  if (!pending.length) return null;
  const index = Math.max(0, pending.findIndex((p) => p.id === pickId));
  const a = pending[index]!;
  return (
    <div className="approvals">
      <Card key={a.id} a={a} index={index} count={pending.length} onNext={() => setPickId(pending[(index + 1) % pending.length]!.id)} />
    </div>
  );
}

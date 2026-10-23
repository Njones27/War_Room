import { useMemo, useState } from "react";
import type { ApprovalView } from "../../shared/protocol";
import { act, api } from "../lib/api";
import { pendingApprovals, useStore } from "../lib/store";

const KIND_LABEL: Record<ApprovalView["kind"], string> = {
  tool_permission: "PERMISSION REQUEST",
  reinforcements: "REINFORCEMENTS REQUEST",
  merge: "MERGE REQUEST",
  budget: "RESUPPLY REQUEST",
};

function Card({ a }: { a: ApprovalView }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = useStore((s) => (a.agentId ? s.agents[a.agentId] : undefined));
  const select = useStore((s) => s.select);
  // ALWAYS ALLOW is offered only when the server could name an exact rule (a command, file or domain).
  const alwaysRule = typeof a.payload.alwaysRule === "string" ? a.payload.alwaysRule : null;
  const decide = async (approved: boolean, always = false) => {
    setBusy(true);
    await act(() => api.decide(a.id, approved, { always, note: note.trim() || undefined }));
    setBusy(false);
  };
  return (
    <div className="approval" role="alertdialog" aria-label={a.title}>
      <div className="approval-head">
        <span>{KIND_LABEL[a.kind]}</span>
        {agent && (
          <button className="btn" style={{ height: "1.4rem" }} onClick={() => select(agent.id)}>
            {agent.letter} · {agent.callsign.toUpperCase()}
          </button>
        )}
      </div>
      <div className="approval-body">
        <div className="approval-title">{a.title}</div>
        {a.detail && <div className="approval-detail scroll">{a.detail}</div>}
        {a.kind !== "tool_permission" && <input className="approval-note" placeholder="Note to the agent (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />}
        <div className="actions">
          <button className="btn danger" disabled={busy} onClick={() => void decide(false)}>
            DENY
          </button>
          {a.kind === "tool_permission" && alwaysRule && (
            <button className="btn" disabled={busy} onClick={() => void decide(true, true)} title={`Approve, and allow ${alwaysRule} for ${a.payload.team === true ? "the whole team" : "this agent"} from now on`}>
              ALWAYS ALLOW
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={() => void decide(true)}>
            APPROVE
          </button>
        </div>
      </div>
    </div>
  );
}

/** Requests waiting on the Commander, stacked above the role bar. */
export function Approvals() {
  const approvals = useStore((s) => s.approvals);
  const pending = useMemo(() => pendingApprovals(approvals), [approvals]);
  if (!pending.length) return null;
  return (
    <div className="approvals">
      {pending.slice(0, 2).map((a) => (
        <Card key={a.id} a={a} />
      ))}
      {pending.length > 2 && <div className="approval-more">+{pending.length - 2} MORE REQUESTS WAITING</div>}
    </div>
  );
}

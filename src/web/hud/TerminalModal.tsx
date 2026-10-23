import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { act, api } from "../lib/api";
import { useStore } from "../lib/store";
import { onServerMessage, sendWs } from "../lib/ws";

/** TAKE COMMAND: the agent's real Claude Code TUI, streamed over the War Room socket. */
export function TerminalModal() {
  const agentId = useStore((s) => s.terminalFor);
  const agent = useStore((s) => (agentId ? s.agents[agentId] : undefined));
  const set = useStore((s) => s.set);
  const hostRef = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!agentId || !hostRef.current) return;
    setEnded(false);
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#05080a", foreground: "#d8dee2", cursor: "#70ebfc", selectionBackground: "#29434c" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    const off = onServerMessage((msg) => {
      if (msg.t === "term" && msg.agentId === agentId) term.write(msg.data);
      if (msg.t === "term_exit" && msg.agentId === agentId) {
        const team = useStore.getState().agents[agentId]?.teamMode;
        term.write(team ? "\r\n\x1b[2m[team session ended]\x1b[0m\r\n" : "\r\n\x1b[2m[session closed — the agent is back under War Room command]\x1b[0m\r\n");
        setEnded(true);
      }
    });
    const input = term.onData((data) => sendWs({ t: "term_input", agentId, data }));
    const resize = term.onResize(({ cols, rows }) => sendWs({ t: "term_resize", agentId, cols, rows }));
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(hostRef.current);
    void act(() => api.takeCommand(agentId, term.cols, term.rows)).then((r) => {
      if (!r) {
        term.write("\x1b[31mCouldn't take command. See the message above.\x1b[0m\r\n");
        setEnded(true);
        return;
      }
      if (r.buffer) term.write(r.buffer);
      term.focus();
    });
    return () => {
      off();
      input.dispose();
      resize.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [agentId]);

  if (!agentId) return null;
  const close = () => set({ terminalFor: null });
  const team = agent?.teamMode === true;
  return (
    <div className="modal-scrim" onKeyDown={(e) => e.stopPropagation()}>
      <div className="modal wide tick-frame" style={{ height: "min(46rem, calc(100vh - 4rem))" }} role="dialog" aria-modal="true" aria-label="Agent terminal">
        <div className="modal-head">
          <span>
            {team ? "TEAM SESSION" : "TAKE COMMAND"} · {agent ? `${agent.letter} · ${agent.callsign}` : ""}
          </span>
          <button className="intel-close" style={{ top: "0.6rem" }} onClick={close} aria-label="Hide terminal">
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: "0.4rem", background: "#05080a" }}>
          <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
        </div>
        <div className="modal-foot">
          <small className="role-desc" style={{ marginRight: "auto", fontSize: "0.92rem" }}>
            {team
              ? "The team lead's live Claude Code session; its teammates run inside it. Hiding this keeps the team running."
              : "You're driving the agent's own Claude Code session. Hiding this keeps the session open; RELEASE ends it and hands the agent back."}
          </small>
          <button className="btn" onClick={close}>
            HIDE
          </button>
          {!team && (
            <button
              className="btn primary"
              disabled={ended}
              onClick={() => {
                void act(() => api.release(agentId));
              }}
            >
              RELEASE
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

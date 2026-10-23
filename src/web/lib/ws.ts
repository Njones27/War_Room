import type { ClientMsg, ServerMsg } from "../../shared/protocol";
import { api } from "./api";
import { useStore } from "./store";

type Listener = (msg: ServerMsg) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry = 0;

export function onServerMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function sendWs(msg: ClientMsg): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

let started = false;

/** Open the live connection once (StrictMode mounts effects twice in dev). */
export function start(): void {
  if (started) return;
  started = true;
  void connect();
}

async function connect(): Promise<void> {
  const store = useStore.getState();
  // A REST probe first: a refused WebSocket hides the reason, fetch doesn't.
  try {
    store.apply({ t: "snapshot", snapshot: await api.snapshot() });
  } catch {
    if (useStore.getState().authError) return;
  }
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    retry = 0;
    useStore.getState().set({ connected: true, authError: null });
  };
  socket.onmessage = (ev) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMsg;
    } catch {
      return;
    }
    useStore.getState().apply(msg);
    for (const l of listeners) l(msg);
  };
  socket.onclose = () => {
    useStore.getState().set({ connected: false });
    if (useStore.getState().authError) return;
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(() => void connect(), delay);
  };
}

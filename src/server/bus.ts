import { EventEmitter } from "node:events";
import type { ServerMsg } from "../shared/protocol.js";

/** Fan-out of server events to every connected UI. */
export class Bus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(200);
  }

  emit(msg: ServerMsg): void {
    this.ee.emit("msg", msg);
  }

  on(fn: (msg: ServerMsg) => void): () => void {
    this.ee.on("msg", fn);
    return () => this.ee.off("msg", fn);
  }
}

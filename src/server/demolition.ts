// Buildings coming down: when files are deleted, their buildings are struck
// on the map. After an agent's shell command (and on a slow sweep of the main
// checkout for everything else) War Room checks which of the city's files
// still exist and calls a strike on the ones that vanished.
import fs from "node:fs";
import path from "node:path";
import type { CityModel } from "../shared/city.js";
import type { TheaterView } from "../shared/protocol.js";
import type { Bus } from "./bus.js";
import type { Store } from "./store.js";
import { newId } from "./util.js";

/** More files than this vanishing at once is a branch switch or a mass move, not a demolition. */
export const MASS_CHANGE = 40;

export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export interface DemolitionDeps {
  store: Store;
  bus: Bus;
  city: () => CityModel;
  theater: () => TheaterView;
}

/** Who deleted the files, for the comms line. */
export interface Demolisher {
  id: string;
  letter: string;
  callsign: string;
}

interface Census {
  city: CityModel;
  present: Set<string>;
}

export class Demolition {
  private census = new Map<string, Census>();
  private queue = new Map<string, Promise<void>>();
  private gone = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: DemolitionDeps) {}

  /** Buildings destroyed since the last scan. */
  destroyed(): string[] {
    return [...this.gone];
  }

  /** A rescan rebuilt the city: deleted files are gone from it. */
  reset(): void {
    this.census.clear();
    this.gone.clear();
  }

  /** Sweep the main checkout every few seconds for deletions made outside War Room's agents. */
  start(intervalMs = 5000): void {
    void this.prime(this.d.theater().root);
    this.timer = setInterval(() => void this.check(null, this.d.theater().root), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Note which of the city's files exist in a workspace before commands run there. */
  prime(root: string): Promise<void> {
    return this.serial(root, async () => {
      const city = this.d.city();
      if (this.census.get(root)?.city !== city) this.census.set(root, { city, present: await this.present(root, city) });
    });
  }

  /** After a command: strike the city's files that vanished from the workspace. */
  check(by: Demolisher | null, root: string): Promise<void> {
    return this.serial(root, async () => {
      const city = this.d.city();
      const before = this.census.get(root);
      const present = await this.present(root, city);
      this.census.set(root, { city, present });
      // A rescan in between moved the goalposts: start over from this census.
      if (!before || before.city !== city) return;
      const vanished = [...before.present].filter((p) => !present.has(p));
      if (vanished.length && vanished.length <= MASS_CHANGE) this.strike(by, vanished);
    });
  }

  /** Bring these buildings down. */
  strike(by: Demolisher | null, paths: string[]): void {
    const fresh = paths.filter((p) => !this.gone.has(p));
    if (!fresh.length) return;
    for (const p of fresh) this.gone.add(p);
    const t = this.d.theater();
    this.d.bus.emit({ t: "strike", strike: { id: newId("st"), agentId: by?.id ?? null, paths: fresh, at: Date.now() } });
    const what = fresh.length === 1 ? fresh[0]! : `${fresh[0]} (+${fresh.length - 1} more)`;
    this.d.store.comms(t.id, by?.id ?? null, "strike", by ? `${by.letter}·${by.callsign} deleted ${what}: strike inbound` : `${what} deleted: strike inbound`);
  }

  private async present(root: string, city: CityModel): Promise<Set<string>> {
    const paths = city.buildings.filter((b) => !b.path.startsWith("@")).map((b) => b.path);
    const out = new Set<string>();
    for (let i = 0; i < paths.length; i += 128) {
      const chunk = paths.slice(i, i + 128);
      const ok = await Promise.all(chunk.map((p) => fs.promises.access(path.join(root, p)).then(() => true, () => false)));
      chunk.forEach((p, j) => ok[j] && out.add(p));
    }
    return out;
  }

  /** Checks of one workspace run one at a time, so each diff starts from the last. */
  private serial(root: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.queue.get(root) ?? Promise.resolve()).then(fn).catch(() => {
      /* workspace vanished mid-check — the next check starts fresh */
    });
    this.queue.set(root, next);
    return next;
  }
}

/** The workspace root a session's cwd belongs to: its agent worktree, else the main checkout. */
export function workspaceRootOf(cwd: string, theaterRoot: string): string {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const at = cwd.indexOf(marker);
  if (at < 0) return theaterRoot;
  const rest = cwd.slice(at + marker.length).split(path.sep)[0] ?? "";
  return rest ? cwd.slice(0, at + marker.length) + rest : theaterRoot;
}

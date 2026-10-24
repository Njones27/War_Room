// Buildings coming down: when files are deleted, their buildings are struck
// on the map. The city stands for the main checkout, so only deletions there
// count: after a shell command an agent or session runs in the main checkout
// (and on a slow sweep for everything else) War Room checks which of the
// city's files still exist and calls a strike on the ones that vanished. A
// deletion in an agent's worktree comes down when it's merged into main. If
// struck files come back (a branch switch, a stash pop) the city is rebuilt.
import fs from "node:fs";
import path from "node:path";
import type { CityModel } from "../shared/city.js";
import type { TheaterView } from "../shared/protocol.js";
import type { Bus } from "./bus.js";
import type { Store } from "./store.js";
import { isWithin, newId } from "./util.js";

/** More files than this vanishing at once is a branch switch or a mass move, not a demolition. */
export const MASS_CHANGE = 40;

export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export interface DemolitionDeps {
  store: Store;
  bus: Bus;
  city: () => CityModel;
  theater: () => TheaterView;
  /** Struck files are back: rescan, so their buildings return. */
  restored?: () => void;
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

/** Whether a session's cwd is in the main checkout (not an agent worktree): only deletions there bring buildings down. */
export function inMainCheckout(cwd: string, theaterRoot: string): boolean {
  return isWithin(theaterRoot, cwd) && !cwd.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
}

export class Demolition {
  private census: Census | null = null;
  private queue: Promise<void> = Promise.resolve();
  private gone = new Set<string>();
  /** Demo strikes: those files were never deleted, so finding them isn't a restore. */
  private simulated = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: DemolitionDeps) {}

  /** Buildings destroyed since the last scan. */
  destroyed(): string[] {
    return [...this.gone];
  }

  /** A rescan rebuilt the city: deleted files are gone from it. */
  reset(): void {
    this.census = null;
    this.gone.clear();
    this.simulated.clear();
  }

  /** Sweep the main checkout every few seconds for deletions made outside War Room's agents. */
  start(intervalMs = 5000): void {
    void this.prime();
    this.timer = setInterval(() => void this.check(null), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Note which of the city's files exist before commands run. */
  prime(): Promise<void> {
    return this.serial(async () => {
      const city = this.d.city();
      if (this.census?.city === city) return;
      const present = await this.present(city);
      if (present && this.d.city() === city) this.census = { city, present };
    });
  }

  /** After a command: strike the city's files that vanished from the main checkout. */
  check(by: Demolisher | null): Promise<void> {
    return this.serial(async () => {
      const city = this.d.city();
      const before = this.census;
      const present = await this.present(city);
      // The checkout is missing (moved, unmounted), or a rescan landed meanwhile: try again next time.
      if (!present || this.d.city() !== city) return;
      this.census = { city, present };
      if (!before || before.city !== city) return;
      const back = [...this.gone].filter((p) => present.has(p) && !this.simulated.has(p));
      if (back.length) {
        // Struck files are back: rebuild the city (which also picks up anything deleted meanwhile).
        for (const p of back) this.gone.delete(p);
        this.d.restored?.();
        return;
      }
      const vanished = [...before.present].filter((p) => !present.has(p));
      // Lots at once, or most of a small repo, is a branch switch or a mass move rather than demolition.
      if (!vanished.length || vanished.length > MASS_CHANGE || (vanished.length > 1 && vanished.length * 2 >= before.present.size)) return;
      this.strike(by, vanished);
    });
  }

  /** Bring these buildings down. `simulated`: the demo pretends they were deleted. */
  strike(by: Demolisher | null, paths: string[], simulated = false): void {
    const fresh = paths.filter((p) => !this.gone.has(p));
    if (!fresh.length) return;
    for (const p of fresh) {
      this.gone.add(p);
      if (simulated) this.simulated.add(p);
    }
    const t = this.d.theater();
    this.d.bus.emit({ t: "strike", strike: { id: newId("st"), agentId: by?.id ?? null, paths: fresh, at: Date.now() } });
    const what = fresh.length === 1 ? fresh[0]! : `${fresh[0]} (+${fresh.length - 1} more)`;
    this.d.store.comms(t.id, by?.id ?? null, "strike", by ? `${by.letter}·${by.callsign} deleted ${what}: strike inbound` : `${what} deleted: strike inbound`);
  }

  /** Which of the city's files exist in the main checkout; null when the checkout itself is missing. */
  private async present(city: CityModel): Promise<Set<string> | null> {
    const root = this.d.theater().root;
    if (!(await fs.promises.access(root).then(() => true, () => false))) return null;
    const paths = city.buildings.filter((b) => !b.path.startsWith("@")).map((b) => b.path);
    const out = new Set<string>();
    for (let i = 0; i < paths.length; i += 128) {
      const chunk = paths.slice(i, i + 128);
      const ok = await Promise.all(chunk.map((p) => fs.promises.access(path.join(root, p)).then(() => true, () => false)));
      chunk.forEach((p, j) => ok[j] && out.add(p));
    }
    return out;
  }

  /** Checks run one at a time, so each diff starts from the last. */
  private serial(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch(() => {
      /* a failed check leaves the last census; the next one diffs from it */
    });
    return this.queue;
  }
}

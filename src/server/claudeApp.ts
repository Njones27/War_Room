// Read-only view of the Claude desktop app's Scheduled tasks. Each task is a
// folder with a SKILL.md (name, description, prompt); the app keeps schedules
// and run state in its own files, which are read when present and in a shape
// we recognise. War Room never writes to any of them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { SatelliteView } from "../shared/protocol.js";
import { describeCron, describeOnce, isValidCron, nextCronRun } from "../shared/cron.js";

export interface AppTaskSource {
  /** Folders holding one sub-folder per task, first match wins. */
  taskDirs: string[];
  /** The app's scheduled-tasks.json files (schedule, enabled, last/next run). */
  stateFiles: () => string[];
}

export function defaultAppTaskSource(home = os.homedir()): AppTaskSource {
  const appData =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude")
        : path.join(home, ".config", "Claude");
  return {
    taskDirs: [path.join(home, ".claude", "scheduled-tasks"), path.join(home, "Documents", "Claude", "Scheduled")],
    stateFiles: () => {
      const out: string[] = [];
      for (const kind of ["claude-code-sessions", "local-agent-mode-sessions"]) {
        for (const a of subdirs(path.join(appData, kind))) for (const b of subdirs(a)) {
          const f = path.join(b, "scheduled-tasks.json");
          if (fs.existsSync(f)) out.push(f);
        }
      }
      return out;
    },
  };
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

interface AppState {
  cron: string | null;
  fireAt: number | null;
  enabled: boolean | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  title: string | null;
}

const time = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Task id → what the app's state files say about it (unknown shapes are skipped). */
function readStates(files: string[]): Map<string, AppState> {
  const out = new Map<string, AppState>();
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const list = (raw as { scheduledTasks?: unknown })?.scheduledTasks;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = text(o.taskId) ?? text(o.id) ?? text(o.name);
      if (!id) continue;
      const cron = text(o.cronExpression) ?? text(o.cron);
      out.set(id, {
        cron: cron && isValidCron(cron) ? cron : null,
        fireAt: time(o.fireAt),
        enabled: typeof o.enabled === "boolean" ? o.enabled : typeof o.isEnabled === "boolean" ? o.isEnabled : null,
        lastRunAt: time(o.lastRunAt),
        nextRunAt: time(o.nextRunAt),
        title: text(o.title),
      });
    }
  }
  return out;
}

function parseSkill(file: string): { name: string | null; description: string | null; body: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: null, description: null, body: raw.trim() };
  let fm: Record<string, unknown> = {};
  try {
    fm = (YAML.parse(m[1]!) as Record<string, unknown>) ?? {};
  } catch {
    /* keep the body */
  }
  return { name: text(fm.name), description: text(fm.description), body: m[2]!.trim() };
}

const sentence = (id: string) => {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The app's tasks as read-only satellites. */
export function readAppTasks(src: AppTaskSource, now = Date.now()): SatelliteView[] {
  const states = readStates(src.stateFiles());
  const seen = new Set<string>();
  const out: SatelliteView[] = [];
  for (const dir of src.taskDirs) {
    for (const folder of subdirs(dir)) {
      const id = path.basename(folder);
      if (seen.has(id)) continue;
      const file = path.join(folder, "SKILL.md");
      const skill = parseSkill(file);
      if (!skill) continue;
      seen.add(id);
      const st = states.get(id);
      const enabled = st?.enabled ?? true;
      const cron = st?.cron ?? null;
      const fireAt = st?.fireAt ?? null;
      const scheduleText = cron ? describeCron(cron) : fireAt ? describeOnce(fireAt) : st ? "Run by hand" : "Set in the Claude app";
      let mtime = now;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        /* keep now */
      }
      out.push({
        id: `app:${id}`,
        source: "claude_app",
        name: st?.title ?? sentence(id),
        prompt: skill.body || skill.description || "",
        role: null,
        model: null,
        effort: null,
        cron,
        fireAt,
        scheduleText,
        enabled,
        running: false,
        activity: null,
        nextRunAt: enabled ? (st?.nextRunAt ?? (cron ? nextCronRun(cron, now) : fireAt && fireAt > now ? fireAt : null)) : null,
        lastRunAt: st?.lastRunAt ?? null,
        lastStatus: null,
        path: file,
        createdAt: mtime,
        updatedAt: mtime,
      });
    }
  }
  return out;
}

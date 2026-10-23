// SQLite via Node's built-in `node:sqlite` (no native dependency).
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA = `
create table if not exists theaters (
  id text primary key, root text unique not null, name text not null,
  is_git integer not null default 0, branch text, created_at integer not null
);
create table if not exists agents (
  id text primary key, theater_id text not null, letter text not null, callsign text not null,
  role text not null, reports_to text, model text, effort text, permission_mode text not null,
  allowed_tools text not null default '[]', budget_usd real, spent_usd real not null default 0,
  context_tokens integer not null default 0, status text not null, paused_reason text,
  workspace_kind text not null, workspace_path text not null, branch text, patrol_minutes integer,
  created_at integer not null, updated_at integer not null
);
create table if not exists missions (
  id text primary key, theater_id text not null, title text not null, body text not null default '',
  status text not null, created_at integer not null, updated_at integer not null
);
create table if not exists objectives (
  id text primary key, theater_id text not null, number integer not null, title text not null,
  body text not null default '', status text not null, priority text not null default 'normal',
  assignee_id text, parent_id text, mission_id text, target_paths text not null default '[]',
  created_by text not null, checkout_run_id text, created_at integer not null, updated_at integer not null
);
create table if not exists orders (
  id text primary key, theater_id text not null, agent_id text, objective_id text, author text not null,
  body text not null, created_at integer not null, delivered_run_id text
);
create table if not exists sessions (
  agent_id text not null, session_key text not null, session_id text not null, cwd text not null,
  cost_usd real not null default 0, updated_at integer not null,
  primary key (agent_id, session_key)
);
create table if not exists runs (
  id text primary key, theater_id text not null, agent_id text not null, objective_id text,
  wake_reason text not null, status text not null, started_at integer not null, ended_at integer,
  cost_usd real not null default 0, input_tokens integer not null default 0, output_tokens integer not null default 0,
  num_turns integer not null default 0, session_id text, error text
);
create table if not exists feed (
  id text primary key, theater_id text not null, agent_id text not null, run_id text, at integer not null,
  kind text not null, text text not null, tool text, tool_use_id text, is_error integer not null default 0, target text
);
create index if not exists feed_agent on feed(agent_id, at);
create table if not exists approvals (
  id text primary key, theater_id text not null, kind text not null, agent_id text, run_id text,
  title text not null, detail text not null default '', payload text not null default '{}', status text not null,
  created_at integer not null, resolved_at integer, resolution text
);
create table if not exists comms (
  id integer primary key autoincrement, theater_id text not null, at integer not null, agent_id text,
  kind text not null, text text not null
);
create table if not exists wakes (
  agent_id text primary key, reasons text not null, objective_ids text not null default '[]',
  note text, created_at integer not null
);
create table if not exists settings (key text primary key, value text not null);
`;

/** Columns added after the first release: [table, column, definition]. */
const ADDED_COLUMNS: [string, string, string][] = [
  ["agents", "tokens_used", "integer not null default 0"],
  ["agents", "team_mode", "integer not null default 0"],
  ["objectives", "model", "text"],
  ["objectives", "effort", "text"],
  ["objectives", "model_by", "text"],
  ["objectives", "model_pending", "integer not null default 0"],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, def] of ADDED_COLUMNS) {
    const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`alter table ${table} add column ${column} ${def}`);
  }
}

let warningPatched = false;

/** node:sqlite prints an ExperimentalWarning on load; silence just that one. */
function silenceSqliteWarning(): void {
  if (warningPatched) return;
  warningPatched = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (typeof text === "string" && text.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export async function openDatabase(file: string): Promise<DatabaseSync> {
  silenceSqliteWarning();
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma busy_timeout = 3000; pragma foreign_keys = off;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Roles are Markdown files with YAML frontmatter: the frontmatter configures
// how the agent runs, the body is appended to its system prompt.
// Built-ins live in ./roles; a repo can override or add roles in
// <repo>/.war-room/roles/*.md.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { RoleView } from "../shared/protocol.js";

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;

const Frontmatter = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
  name: z.string(),
  title: z.string().optional(),
  icon: z.string().default("star"),
  accessory: z.string().default("beret"),
  description: z.string().default(""),
  reportsTo: z.string().nullable().default(null),
  permissionMode: z.enum(PERMISSION_MODES).default("default"),
  worktree: z.boolean().default(false),
  model: z.string().nullable().default(null),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  budgetUsd: z.number().positive().nullable().default(null),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  /** "warroom" loads only War Room's MCP server (cheaper, faster); "all" keeps your MCP servers too. */
  mcp: z.enum(["warroom", "all"]).default("warroom"),
  patrolMinutes: z.number().positive().nullable().default(null),
  callsigns: z.array(z.string()).default([]),
});

export interface RoleDef extends RoleView {
  instructions: string;
  allowedTools: string[];
  disallowedTools: string[];
  mcp: "warroom" | "all";
  patrolMinutes: number | null;
  source: string;
}

export function parseRole(text: string, source: string): RoleDef {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${source}: missing YAML frontmatter`);
  const fm = Frontmatter.parse(YAML.parse(m[1]!) ?? {});
  const id = fm.id ?? path.basename(source, ".md").toLowerCase();
  return {
    id,
    name: fm.name,
    title: fm.title ?? fm.name,
    icon: fm.icon,
    accessory: fm.accessory,
    description: fm.description,
    worktree: fm.worktree,
    permissionMode: fm.permissionMode,
    model: fm.model,
    effort: fm.effort,
    budgetUsd: fm.budgetUsd,
    reportsTo: fm.reportsTo,
    callsigns: fm.callsigns,
    readOnly: ["Edit", "Write"].every((t) => fm.disallowedTools.includes(t)),
    allowedTools: fm.allowedTools,
    disallowedTools: fm.disallowedTools,
    mcp: fm.mcp,
    patrolMinutes: fm.patrolMinutes,
    instructions: m[2]!.trim(),
    source,
  };
}

function loadDir(dir: string, into: Map<string, RoleDef>, onError: (msg: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".md") || file.startsWith("_")) continue;
    const full = path.join(dir, file);
    try {
      const role = parseRole(fs.readFileSync(full, "utf8"), full);
      into.set(role.id, role);
    } catch (err) {
      onError(`Role ${full}: ${(err as Error).message}`);
    }
  }
}

export class Roles {
  private roles = new Map<string, RoleDef>();
  readonly errors: string[] = [];

  constructor(
    private readonly builtinDir: string,
    private projectRoot: string,
  ) {
    this.reload();
  }

  reload(projectRoot = this.projectRoot): void {
    this.projectRoot = projectRoot;
    const next = new Map<string, RoleDef>();
    this.errors.length = 0;
    const onError = (msg: string) => this.errors.push(msg);
    loadDir(this.builtinDir, next, onError);
    loadDir(path.join(projectRoot, ".war-room", "roles"), next, onError);
    this.roles = next;
  }

  get(id: string): RoleDef | null {
    return this.roles.get(id) ?? null;
  }

  require(id: string): RoleDef {
    const role = this.get(id);
    if (!role) throw new Error(`Unknown role "${id}". Known roles: ${[...this.roles.keys()].join(", ")}`);
    return role;
  }

  list(): RoleDef[] {
    const order = ["general", "engineer", "security", "recon", "medic", "support"];
    return [...this.roles.values()].sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.name.localeCompare(b.name);
    });
  }

  views(): RoleView[] {
    return this.list().map(({ instructions: _i, allowedTools: _a, disallowedTools: _d, mcp: _m, patrolMinutes: _p, source: _s, ...view }) => view);
  }
}

// Git worktrees for agents that write code, so parallel agents never edit
// the same checkout. They live under <repo>/.claude/worktrees/ (the same
// place Claude Code puts its own) and are excluded locally via .git/info/exclude.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../shared/protocol.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  return stdout.trim();
}

export async function gitInfo(root: string): Promise<{ isGit: boolean; branch: string | null; hasCommits: boolean }> {
  try {
    const top = await git(root, ["rev-parse", "--show-toplevel"]);
    if (!top) return { isGit: false, branch: null, hasCommits: false };
  } catch {
    return { isGit: false, branch: null, hasCommits: false };
  }
  let branch: string | null = null;
  try {
    branch = (await git(root, ["symbolic-ref", "--short", "HEAD"])) || null;
  } catch {
    branch = null;
  }
  let hasCommits = true;
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasCommits = false;
  }
  return { isGit: true, branch, hasCommits };
}

function excludeWorktrees(root: string): void {
  const gitDir = path.join(root, ".git");
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
  const file = path.join(gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).some((l) => l.trim() === ".claude/worktrees/")) return;
  fs.appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}# War Room agent worktrees\n.claude/worktrees/\n`);
}

export interface WorktreeResult {
  workspace: Workspace;
  warning: string | null;
}

/** Create (or reuse) an agent's worktree. Falls back to the main checkout when that isn't possible. */
export async function prepareWorkspace(root: string, slug: string, wantsWorktree: boolean): Promise<WorktreeResult> {
  const info = await gitInfo(root);
  const main: Workspace = { kind: "main", path: root, branch: info.branch };
  if (!wantsWorktree) return { workspace: main, warning: null };
  if (!info.isGit) return { workspace: main, warning: "Not a git repo, so this agent shares the main folder." };
  if (!info.hasCommits) return { workspace: main, warning: "The repo has no commits yet, so this agent shares the main checkout." };

  const dir = path.join(root, ".claude", "worktrees", `warroom-${slug}`);
  const branch = `warroom/${slug}`;
  if (fs.existsSync(path.join(dir, ".git"))) return { workspace: { kind: "worktree", path: dir, branch }, warning: null };
  excludeWorktrees(root);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    let branchExists = true;
    try {
      await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    } catch {
      branchExists = false;
    }
    await git(root, branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);
    return { workspace: { kind: "worktree", path: dir, branch }, warning: null };
  } catch (err) {
    return { workspace: main, warning: `Couldn't create a worktree (${(err as Error).message.split("\n")[0]}); using the main checkout.` };
  }
}

/** Remove an agent's worktree if it has no uncommitted changes. The branch is kept. */
export async function removeWorktree(root: string, ws: Workspace): Promise<{ removed: boolean; reason: string | null }> {
  if (ws.kind !== "worktree") return { removed: false, reason: null };
  if (!fs.existsSync(ws.path)) return { removed: true, reason: null };
  try {
    const dirty = await git(ws.path, ["status", "--porcelain"]);
    if (dirty) return { removed: false, reason: "it has uncommitted changes" };
    await git(root, ["worktree", "remove", ws.path]);
    return { removed: true, reason: null };
  } catch (err) {
    return { removed: false, reason: (err as Error).message.split("\n")[0] ?? "git error" };
  }
}

export async function branchSummary(root: string, branch: string, base: string | null): Promise<string> {
  try {
    const range = base ? `${base}..${branch}` : branch;
    const log = await git(root, ["log", "--oneline", "-n", "15", range]);
    const stat = base ? await git(root, ["diff", "--shortstat", `${base}...${branch}`]) : "";
    return [log || "(no commits ahead)", stat].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WarRoomConfig {
  host: "127.0.0.1";
  port: number;
  dev: boolean;
  demo: boolean;
  projectRoot: string;
  homeDir: string;
  dbPath: string;
  runDir: string;
  rolesDir: string;
  webDist: string;
  maxConcurrent: number;
  claudeBin: string;
  openBrowser: boolean;
  /** Permission-prompt wait before a request is auto-denied. */
  approvalTimeoutMs: number;
}

/** Repo root of the War Room package (works from src/ via tsx and from dist/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `war-room — a tactical command map for your local Claude Code agents

Usage: war-room [options]

  --project <path>        Repo to command (default: current directory)
  --port <n>              Port on 127.0.0.1 (default: 7777)
  --demo                  Simulated squad, no Claude usage
  --max-concurrent <n>    Agents allowed to run at once (default: 3)
  --claude <path>         Claude Code binary (default: claude on PATH)
  --home <dir>            State directory (default: ~/.war-room)
  --no-open               Don't open the browser
  -h, --help              Show this help
`;

export function parseArgs(argv: string[]): WarRoomConfig {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (!a.startsWith("--")) continue;
    const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) args.set(key, inline);
    else if (next !== undefined && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else args.set(key, true);
  }
  const str = (k: string): string | undefined => {
    const v = args.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const num = (k: string, d: number): number => {
    const v = Number(str(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };

  const demo = args.has("demo");
  const homeDir = path.resolve(str("home") ?? path.join(os.homedir(), ".war-room"));
  return {
    host: "127.0.0.1",
    port: num("port", 7777),
    dev: args.has("dev"),
    demo,
    projectRoot: path.resolve(str("project") ?? process.cwd()),
    homeDir,
    dbPath: demo ? ":memory:" : path.join(homeDir, "war-room.db"),
    // A demo keeps its run files to itself, so it can't disturb a live War Room's.
    runDir: demo ? path.join(os.tmpdir(), `war-room-demo-${process.pid}`) : path.join(homeDir, "run"),
    rolesDir: path.join(PACKAGE_ROOT, "roles"),
    webDist: path.join(PACKAGE_ROOT, "dist", "web"),
    maxConcurrent: num("max-concurrent", 3),
    claudeBin: str("claude") ?? "claude",
    openBrowser: !args.has("no-open"),
    approvalTimeoutMs: 30 * 60 * 1000,
  };
}

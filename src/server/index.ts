// War Room entry point: wires the control plane together and opens the map.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { CityModel } from "../shared/city.js";
import type { CommsCheck, RateLimitInfo, TheaterView } from "../shared/protocol.js";
import { createClaudeLocalAdapter } from "./adapters/claudeLocal.js";
import { createDemoAdapter } from "./adapters/demo.js";
import { createApp } from "./app.js";
import { Approvals } from "./approvals.js";
import { Bus } from "./bus.js";
import { commsCheck } from "./claudeCli.js";
import { PACKAGE_ROOT, parseArgs } from "./config.js";
import { openDatabase } from "./db.js";
import { Demolition } from "./demolition.js";
import { PtyHost } from "./ptyHost.js";
import { cliPermissionMode, HQ, permissionOverrideOf, supplyModeOf } from "./hq.js";
import { createMcpHandler } from "./mcp.js";
import { layoutCity } from "./repo/layout.js";
import { scanRepo } from "./repo/scan.js";
import { defaultAppTaskSource } from "./claudeApp.js";
import { Orbit } from "./orbit.js";
import { Roles } from "./roles.js";
import { registerRoutes } from "./routes.js";
import { Scheduler } from "./scheduler.js";
import { loadOrCreateToken, Security } from "./security.js";
import { Store } from "./store.js";
import { TakeCommand } from "./takeCommand.js";
import { TeamOps } from "./team.js";
import { Toolkit } from "./toolkit.js";
import { Watch } from "./watch.js";
import { parseJson } from "./util.js";
import { gitInfo } from "./workspaces.js";

const VERSION = (JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no browser available */
  }
}

/** The port of a War Room that's already running for this repo, if its lock is live. */
async function runningPort(lockFile: string): Promise<number | null> {
  try {
    const { pid, port } = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number; port: number };
    process.kill(pid, 0);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? port : null;
  } catch {
    return null; // no lock, a dead process, or nothing answering: a stale lock
  }
}

/** First free loopback port at or after `start` (so two War Rooms can run side by side). */
async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 20; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`No free port between ${start} and ${start + 19}. Pass --port.`);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(config.projectRoot) || !fs.statSync(config.projectRoot).isDirectory()) {
    throw new Error(`No folder at ${config.projectRoot}. Pass --project with the path to one of your repos (default: the current folder).`);
  }
  const bus = new Bus();
  const db = await openDatabase(config.dbPath);
  const store = new Store(db, bus);
  const git = await gitInfo(config.projectRoot);
  let theater: TheaterView = store.ensureTheater(config.projectRoot, path.basename(config.projectRoot), git.isGit, git.branch);

  // One War Room per repo. War Rooms for other repos share the state folder and run side by side.
  const lockFile = config.demo ? null : path.join(config.homeDir, "locks", `${theater.id}.json`);
  const running = lockFile ? await runningPort(lockFile) : null;
  if (running !== null) {
    const token = loadOrCreateToken(path.join(config.homeDir, "token"));
    console.log(`\n  War Room is already running for ${theater.name}.\n  Open      http://127.0.0.1:${running}/?token=${encodeURIComponent(token)}\n`);
    db.close();
    return;
  }
  config.port = await findPort(config.port);

  // Per-run files (prompts, MCP tokens) this repo's last War Room left behind are stale.
  // Other repos' belong to War Rooms that may still be running.
  fs.mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(config.runDir)) {
    const kind = entry.startsWith("rn_") ? "run" : entry.startsWith("take-") || entry.startsWith("team-") ? "agent" : null;
    if (!kind) continue;
    const owner = kind === "run" ? store.runTheater(entry) : (store.getAgent(entry.slice(entry.indexOf("-") + 1))?.theaterId ?? null);
    if (owner === null || owner === theater.id) fs.rmSync(path.join(config.runDir, entry), { recursive: true, force: true });
  }
  const interrupted = store.markInterruptedRuns(theater.id);
  store.expireStalePermissionPrompts(theater.id);
  const roles = new Roles(config.rolesDir, config.projectRoot);
  for (const e of roles.errors) console.warn(`  ! ${e}`);

  let city = null as unknown as CityModel; // set by the first rescan below
  const demolition = new Demolition({
    store,
    bus,
    city: () => city,
    theater: () => theater,
    // Struck files came back (a branch switch, a stash pop): rebuild the city so their buildings return.
    restored: () => void rescan().catch((err: Error) => console.warn(`  ! Rescan failed: ${err.message}`)),
  });
  const rescan = async () => {
    const scan = await scanRepo(config.projectRoot);
    const g = await gitInfo(config.projectRoot);
    theater = store.ensureTheater(config.projectRoot, theater.name, g.isGit, g.branch);
    city = layoutCity(scan.tree, { name: theater.name, root: theater.root, fileCount: scan.fileCount, truncated: scan.truncated });
    demolition.reset();
    bus.emit({ t: "city", city });
  };
  await rescan();
  demolition.start();

  // The last plan-usage reading survives restarts (it only arrives with sortie traffic).
  let comms: CommsCheck = { ...(await commsCheck(config.claudeBin)), rateLimit: parseJson<RateLimitInfo | null>(store.getSetting("rateLimit"), null) };
  const supplyMode = () => supplyModeOf(store, comms);
  const permissionMode = () => cliPermissionMode(permissionOverrideOf(store));
  const recheck = async () => {
    comms = { ...(await commsCheck(config.claudeBin)), rateLimit: comms.rateLimit };
    bus.emit({ t: "comms_check", check: comms });
    return comms;
  };

  const noteRateLimit = (info: RateLimitInfo) => {
    // An event that doesn't carry a window keeps the last reading for it.
    const prev = comms.rateLimit;
    const merged: RateLimitInfo = { ...info, fiveHour: info.fiveHour ?? prev?.fiveHour ?? null, sevenDay: info.sevenDay ?? prev?.sevenDay ?? null };
    comms = { ...comms, rateLimit: merged };
    store.setSetting("rateLimit", JSON.stringify(merged));
    bus.emit({ t: "comms_check", check: comms });
  };
  const approvals = new Approvals(store, config.approvalTimeoutMs);
  let toolkit: Toolkit | null = null;
  const adapter = config.demo
    ? createDemoAdapter({ store, toolkit: () => toolkit!, city: () => city, strike: (agent, paths) => demolition.strike(agent, paths, true) })
    : createClaudeLocalAdapter(config.claudeBin);
  // Demo runs get a throwaway token; real runs keep one so the link can be bookmarked.
  const security = new Security(config.port, config.demo ? undefined : loadOrCreateToken(path.join(config.homeDir, "token")));
  const scheduler = new Scheduler({
    store,
    bus,
    roles,
    adapter,
    approvals,
    config,
    theater: () => theater,
    mcpUrl: () => `http://127.0.0.1:${config.port}/mcp`,
    supplyMode,
    permissionMode,
    demolition,
    onRateLimit: (info) => noteRateLimit(info),
  });
  const orbit = new Orbit({
    db,
    bus,
    roles,
    adapter,
    config,
    theater: () => theater,
    permissionMode,
    onRateLimit: noteRateLimit,
    appTasks: config.demo ? null : defaultAppTaskSource(),
    demo: config.demo,
  });
  const ptys = new PtyHost(bus, config.claudeBin);
  await ptys.init();
  const takeCommand = new TakeCommand(ptys);
  const watch = config.demo ? null : new Watch(config.claudeBin, bus, () => theater, () => store.knownSessionIds(), undefined, demolition);
  const team = new TeamOps({
    store,
    bus,
    ptys,
    approvals,
    roles,
    config,
    theater: () => theater,
    mcpUrl: () => `http://127.0.0.1:${config.port}/mcp`,
    hookUrl: (token) => `http://127.0.0.1:${config.port}/hooks/${token}`,
    authorName: (author) => scheduler.authorName(author),
    permissionMode,
    demo: config.demo ? { toolkit: () => toolkit!, city: () => city } : undefined,
    demolition,
  });
  scheduler.attachLive(team);

  const hq = new HQ(store, bus, roles, scheduler, approvals, config, () => theater, {
    city: () => city,
    destroyed: () => demolition.destroyed(),
    commsCheck: () => comms,
    fronts: () => watch?.frontList() ?? [],
    externalAgents: () => watch?.agents() ?? [],
    teamUnits: () => team.units(),
    takeCommandAvailable: () => ptys.available && !config.demo,
    supplyMode,
    version: VERSION,
    satellites: () => orbit.list(),
    satelliteRuns: () => orbit.runs(),
  });
  hq.attachTeam(team);
  toolkit = new Toolkit(hq, store, scheduler, approvals);

  takeCommand.onExit((agentId) => {
    const a = store.getAgent(agentId);
    if (a?.status !== "commanded") return;
    store.updateAgent(agentId, { status: scheduler.hasPendingWake(agentId) ? "queued" : "idle" });
    store.setRuntime(agentId, { activity: "idle", activityDetail: "Standing by" });
    store.comms(a.theaterId, a.id, "command", `${a.letter}·${a.callsign} released back to War Room`);
    scheduler.tick();
  });

  const server = await createApp({
    config,
    security,
    bus,
    hq,
    mcp: createMcpHandler(scheduler, toolkit, VERSION),
    hooks: (token, body, signal) => team.hook(token, body, signal),
    onClientMessage: (msg) => {
      if (msg.t === "term_input" && typeof msg.data === "string") ptys.write(msg.agentId, msg.data);
      else if (msg.t === "term_resize") ptys.resize(msg.agentId, msg.cols, msg.rows);
    },
    routes: (route) => registerRoutes(route, { config, hq, store, roles, scheduler, takeCommand, team, ptys, orbit, rescan, recheck }),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  if (lockFile) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: config.port }), { mode: 0o600 });
  }

  const url = security.launchUrl;
  const auth = comms.loggedIn ? `logged in (${[comms.authMethod, comms.subscription].filter(Boolean).join(", ")})` : comms.error ?? "unknown";
  console.log(
    [
      "",
      "  ┌─────────────────────────────────────────────┐",
      "  │  W A R   R O O M   ·   command link ready    │",
      "  └─────────────────────────────────────────────┘",
      `  Theater   ${theater.name}  (${theater.root})`,
      `  Map       ${city.buildings.length} buildings from ${city.fileCount} files${city.truncated ? " (large repo: deep folders grouped)" : ""}`,
      `  Claude    ${comms.version ?? "not found"} · ${auth}`,
      `  Mode      ${config.demo ? "DEMO: simulated squad, no Claude usage" : "LIVE: agents run on your local Claude Code"}`,
      interrupted ? `  Note      ${interrupted} sortie(s) were interrupted by the last shutdown` : "",
      "",
      `  Open      ${url}`,
      "",
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n",
  );

  scheduler.start();
  orbit.start();
  team.start();
  watch?.start();
  const commsTimer = setInterval(() => void recheck(), 120_000);
  commsTimer.unref();

  if (config.demo) await seedDemo(hq, store, theater, approvals);
  if (config.openBrowser) openBrowser(url);

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("\n  Standing down…");
    scheduler.stopAll();
    orbit.stopAll();
    team.stopAll();
    ptys.stopAll();
    watch?.stop();
    demolition.stop();
    server.close();
    if (lockFile) fs.rmSync(lockFile, { force: true });
    if (config.demo) fs.rmSync(config.runDir, { recursive: true, force: true });
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Demo: a squad, a mission, and an autopilot that answers requests nobody clicked. */
async function seedDemo(hq: HQ, store: Store, theater: TheaterView, approvals: Approvals): Promise<void> {
  if (store.listAgents(theater.id).length === 0) {
    await hq.deploy({ role: "general", mission: { title: "OPERATION FIRST LIGHT", body: "Survey the codebase, ship one solid improvement, and prove it with tests." } });
    for (const role of ["recon", "engineer", "medic", "security"]) await hq.deploy({ role });
  }
  const names = ["SECOND WIND", "IRON GATE", "NIGHT WATCH", "SILVER LINING", "LONG HAUL"];
  let completedAt: number | null = null;
  const timer = setInterval(() => {
    for (const a of store.pendingApprovals(theater.id)) {
      if (Date.now() - a.createdAt > 14_000) approvals.decide(a.id, true, { note: "autopilot" });
    }
    // Keep the showcase going: a new operation 40s after the last one completes.
    if (store.activeMission(theater.id)) completedAt = null;
    else {
      completedAt ??= Date.now();
      if (Date.now() - completedAt > 40_000) {
        completedAt = null;
        void hq.launchMission({ title: `OPERATION ${names[Math.floor(Math.random() * names.length)]}`, body: "Another sweep of the codebase: find, fix, and verify." });
      }
    }
  }, 3000);
  timer.unref();
}

// A stray rejection gets logged; it shouldn't take the command link down.
process.on("unhandledRejection", (err) => console.error(`  ! ${(err as Error)?.message ?? err}`));

main().catch((err) => {
  console.error(`\n  War Room failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});

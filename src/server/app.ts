// HTTP + WebSocket front door: REST commands, the live event stream, the
// agents' MCP endpoint, and the web UI (Vite in dev, static files in prod).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { Bus } from "./bus.js";
import { PACKAGE_ROOT, type WarRoomConfig } from "./config.js";
import { HqError, type HQ } from "./hq.js";
import type { Security } from "./security.js";

type Handler = (ctx: { params: Record<string, string>; body: Record<string, unknown>; query: URLSearchParams }) => unknown | Promise<unknown>;

export interface AppDeps {
  config: WarRoomConfig;
  security: Security;
  bus: Bus;
  hq: HQ;
  mcp: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => Promise<void>;
  /** Team sessions' HTTP hooks. null: unknown session token. */
  hooks: (token: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  onClientMessage: (msg: ClientMsg) => void;
  routes: (route: (method: string, pattern: string, handler: Handler) => void) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HqError("Request body too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  return { re, keys };
}

export async function createApp(d: AppDeps): Promise<http.Server> {
  const { config, security } = d;
  const routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
  d.routes((method, pattern, handler) => routes.push({ method, ...compile(pattern), handler }));

  const server = http.createServer();
  // Permission prompts hold an MCP request open until the Commander decides.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let vite: { middlewares: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void } | null = null;
  if (config.dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: path.join(PACKAGE_ROOT, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
  }

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => {
    const root = config.webDist;
    let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("The web UI isn't built yet. Run `npm run build`, or `npm run dev` for development.");
      return;
    }
    const immutable = pathname.startsWith("/assets/");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    fs.createReadStream(file).pipe(res);
  };

  server.on("request", (req, res) => {
    // Anything a request can throw (a malformed URL, a bad %-escape) answers 400; it must never take the server down.
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!security.hostOk(req)) return sendJson(res, 421, { error: "War Room only answers on 127.0.0.1 / localhost." });

      // Agents' MCP endpoint: bearer run tokens; never from a browser.
      if (url.pathname === "/mcp") {
        if (req.headers.origin) return sendJson(res, 403, { error: "Forbidden" });
        try {
          const raw = req.method === "POST" ? await readBody(req, 4 * 1024 * 1024) : "";
          await d.mcp(req, res, raw ? JSON.parse(raw) : undefined);
        } catch (err) {
          if (!res.headersSent) sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null });
        }
        return;
      }

      // Team sessions' Claude Code hooks: the path carries the session's secret; never from a browser.
      if (url.pathname.startsWith("/hooks/")) {
        if (req.headers.origin || req.method !== "POST") return sendJson(res, 403, { error: "Forbidden" });
        try {
          const raw = await readBody(req, 16 * 1024 * 1024);
          // A permission hook stays open until the Commander decides; Claude Code may give up first.
          const gone = new AbortController();
          res.on("close", () => !res.writableFinished && gone.abort());
          const out = await d.hooks(decodeURIComponent(url.pathname.slice("/hooks/".length)), raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, gone.signal);
          if (out === null) return sendJson(res, 404, { error: "Unknown session" });
          return sendJson(res, 200, out);
        } catch (err) {
          if (!res.headersSent) return sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });

      if (url.pathname.startsWith("/api/")) {
        if (!security.originOk(req)) return sendJson(res, 403, { error: "Cross-origin request blocked." });
        if (!security.authed(req)) return sendJson(res, 401, { error: "Not authorized. Open the link War Room printed in your terminal." });
        const method = (req.method ?? "GET").toUpperCase();
        const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
        if (!route) return sendJson(res, 404, { error: "Not found" });
        try {
          const m = url.pathname.match(route.re)!;
          const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
          const raw = method === "GET" ? "" : await readBody(req, 1024 * 1024);
          const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          const out = await route.handler({ params, body, query: url.searchParams });
          return sendJson(res, 200, out ?? { ok: true });
        } catch (err) {
          const status = err instanceof HqError ? err.status : err instanceof SyntaxError ? 400 : 500;
          return sendJson(res, status, { error: (err as Error).message });
        }
      }

      // Launch link: trade the token for a SameSite cookie, then drop it from the URL.
      // (Only on "/": Vite uses ?t= for its own cache busting.)
      const t = url.pathname === "/" ? url.searchParams.get("token") : null;
      if (t !== null) {
        if (!security.tokenMatches(t)) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("That War Room link has expired. Use the link printed in your terminal.");
          return;
        }
        security.setCookie(res);
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }

      res.setHeader("x-frame-options", "DENY");
      res.setHeader("referrer-policy", "no-referrer");
      if (vite) vite.middlewares(req, res, () => sendJson(res, 404, { error: "Not found" }));
      else serveStatic(req, res, url.pathname);
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: "Bad request" });
      else res.destroy();
    });
  });

  // Live event stream.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    try {
      upgrade(req, socket, head);
    } catch {
      // A malformed handshake gets refused, never an uncaught exception.
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    }
  });
  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      // Vite's HMR socket handles its own upgrades in dev. Anything else must be
      // refused, not ignored: browsers allow one pending WebSocket handshake per
      // host, so a stale tab's hung handshake would stall the live connection.
      if (vite && String(req.headers["sec-websocket-protocol"] ?? "").includes("vite")) return;
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!security.hostOk(req) || !security.originOk(req) || !security.authed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

  wss.on("connection", (ws: WebSocket) => {
    const send = (msg: ServerMsg) => {
      if (ws.readyState !== ws.OPEN) return;
      // Drop cosmetic traffic when a client falls behind.
      if ((msg.t === "text_delta" || msg.t === "comms") && ws.bufferedAmount > 4 * 1024 * 1024) return;
      ws.send(JSON.stringify(msg));
    };
    send({ t: "snapshot", snapshot: d.hq.snapshot() });
    const off = d.bus.on(send);
    ws.on("message", (raw) => {
      try {
        d.onClientMessage(JSON.parse(String(raw)) as ClientMsg);
      } catch {
        /* ignore malformed */
      }
    });
    ws.on("close", off);
    ws.on("error", off);
  });

  return server;
}

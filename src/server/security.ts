// Local-only access control.
//
// The server can launch agents and type into terminals, so a stray web page
// must not be able to drive it. Three layers:
//  1. bind to 127.0.0.1 only (see index.ts)
//  2. a random launch token, exchanged for a SameSite=Strict HttpOnly cookie
//  3. Host + Origin checks (blocks DNS rebinding and cross-site requests)
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { newToken } from "./util.js";

export class Security {
  readonly token: string;
  readonly cookieName: string;
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;

  constructor(readonly port: number, token: string = newToken()) {
    this.token = token;
    // Cookies are shared across ports on the same host, so scope the name by port.
    this.cookieName = `wr_${port}`;
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  }

  get launchUrl(): string {
    return `http://127.0.0.1:${this.port}/?token=${encodeURIComponent(this.token)}`;
  }

  hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return typeof host === "string" && this.hosts.has(host.toLowerCase());
  }

  /** A present Origin must be ours. A missing one is only fine for safe methods. */
  originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin === "string") return this.origins.has(origin.toLowerCase());
    const method = (req.method ?? "GET").toUpperCase();
    return method === "GET" || method === "HEAD" || this.headerTokenOk(req);
  }

  tokenMatches(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private headerTokenOk(req: IncomingMessage): boolean {
    const h = req.headers["x-war-room-token"];
    return this.tokenMatches(typeof h === "string" ? h : null);
  }

  cookieToken(req: IncomingMessage): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k !== this.cookieName) continue;
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null; // a malformed cookie is just no cookie
      }
    }
    return null;
  }

  authed(req: IncomingMessage): boolean {
    return this.tokenMatches(this.cookieToken(req)) || this.headerTokenOk(req);
  }

  setCookie(res: ServerResponse): void {
    res.setHeader("Set-Cookie", `${this.cookieName}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`);
  }
}

/** A launch token that survives restarts, so the command link can be bookmarked. Stored 0600. */
export function loadOrCreateToken(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 24) return existing;
  } catch {
    /* first run */
  }
  const token = newToken();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

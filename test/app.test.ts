import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { Bus } from "../src/server/bus.js";
import { parseArgs } from "../src/server/config.js";
import type { HQ } from "../src/server/hq.js";
import { Security } from "../src/server/security.js";

/** One raw HTTP exchange, so malformed request lines reach the server as-is. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let out = "";
    socket.on("data", (d) => (out += d));
    socket.on("close", () => resolve(out));
    socket.on("error", () => resolve(out));
    setTimeout(() => socket.destroy(), 1500);
  });
}

describe("HTTP front door", () => {
  let server: http.Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warroom-app-"));
    // The Host check wants the real port, so pick a free one first.
    port = await new Promise<number>((r) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => r(p));
      });
    });
    const config = { ...parseArgs(["--home", dir, "--no-open"]), webDist: path.join(dir, "web"), port };
    server = await createApp({
      config,
      security: new Security(port, "secret-token"),
      bus: new Bus(),
      hq: {} as HQ,
      mcp: async () => {},
      hooks: async () => null,
      onClientMessage: () => {},
      routes: () => {},
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers malformed requests with 400 instead of crashing", async () => {
    // `//` is a URL with an empty host, `%` a broken escape; neither needs a login.
    expect(await raw(port, `GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)).toMatch(/^HTTP\/1\.1 4\d\d/);
    expect(await raw(port, `GET /% HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)).toMatch(/^HTTP\/1\.1 4\d\d/);
    expect(await raw(port, `GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: wr_${port}=%\r\nConnection: close\r\n\r\n`)).toMatch(/^HTTP\/1\.1 4\d\d/);
    expect(await raw(port, `GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)).toMatch(/^HTTP\/1\.1 4\d\d/);
    // Still up.
    expect(await raw(port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)).toMatch(/"ok":true/);
  });
});

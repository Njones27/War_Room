#!/usr/bin/env node
// `war-room` CLI: run War Room against the current repo (or --project <path>).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "server", "index.js");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`War Room needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
if (!existsSync(entry) || !existsSync(join(root, "dist", "web", "index.html"))) {
  console.error(`War Room isn't built yet. In ${root} run:\n\n  npm install && npm run build\n`);
  process.exit(1);
}
await import(pathToFileURL(entry).href);

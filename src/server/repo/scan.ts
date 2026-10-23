// Scans a repo into a file tree for the Code City.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface FileEntry {
  path: string;
  bytes: number;
  /** 0 for assets. */
  lines: number;
  /** An image, font, archive or other binary: it has no lines, so it gets one small building size. */
  asset?: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  depth: number;
  children: Map<string, TreeNode>;
  /** Set for files, and for directories collapsed into a single cluster building. */
  file: FileEntry | null;
  cluster: number;
  files: number;
  lines: number;
  bytes: number;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage", ".cache", "vendor",
  "target", "__pycache__", ".venv", "venv", ".idea", ".turbo", ".parcel-cache", ".gradle", "Pods", "DerivedData", ".pytest_cache",
]);

// Images (SVG too), media, fonts, archives, models and other binaries. Files with a NUL byte up front count as well.
const ASSET_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".svg", ".svgz", ".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff",
  ".jxl", ".dng", ".raw", ".psd", ".ai", ".xcf", ".sketch", ".fig", ".pdf", ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm",
  ".mp3", ".m4a", ".aac", ".flac", ".wav", ".aif", ".aiff", ".caf", ".ogg", ".woff", ".woff2", ".ttf", ".ttc", ".otf", ".eot",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".pkg", ".ipa", ".apk", ".aab", ".jar", ".exe", ".dll", ".so",
  ".dylib", ".bin", ".class", ".o", ".a", ".wasm", ".node", ".pyc", ".car", ".glb", ".fbx", ".usdz", ".riv", ".mlmodel", ".onnx",
  ".tflite", ".pt", ".safetensors", ".npy", ".parquet", ".db", ".sqlite",
]);

const MAX_LINE_COUNT_BYTES = 2 * 1024 * 1024;

function skipPath(rel: string): boolean {
  return rel.startsWith(".claude/worktrees/") || rel.split("/").some((part) => IGNORE_DIRS.has(part));
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      maxBuffer: 128 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.split("\0").filter((p) => p && !skipPath(p));
  } catch {
    return walk(root);
  }
}

function walk(root: string, limit = 60_000): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < limit) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !(e.name.startsWith(".") && e.name !== ".github")) stack.push(childRel);
      } else if (e.isFile() && !skipPath(childRel)) out.push(childRel);
    }
  }
  return out;
}

const SNIFF_BYTES = 8000;
const looksBinary = (buf: Buffer) => buf.subarray(0, SNIFF_BYTES).includes(0);

async function readHead(file: string): Promise<Buffer> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf.length > 0 && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

async function statFiles(root: string, rels: string[], countAllLines: boolean): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  let i = 0;
  const worker = async () => {
    while (i < rels.length) {
      const rel = rels[i++]!;
      const full = path.join(root, rel);
      try {
        const st = await fs.promises.lstat(full);
        if (!st.isFile()) continue;
        let asset = ASSET_EXT.has(path.extname(rel).toLowerCase());
        let lines = Math.max(1, Math.round(st.size / 40));
        if (!asset && countAllLines) {
          // Count the lines of files small enough to read; sniff the head of bigger ones.
          const buf = st.size <= MAX_LINE_COUNT_BYTES ? await fs.promises.readFile(full) : await readHead(full);
          asset = looksBinary(buf);
          if (!asset && st.size <= MAX_LINE_COUNT_BYTES) lines = countLines(buf);
        }
        out.push(asset ? { path: rel, bytes: st.size, lines: 0, asset } : { path: rel, bytes: st.size, lines });
      } catch {
        /* vanished or unreadable */
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function node(name: string, p: string, depth: number): TreeNode {
  return { name, path: p, depth, children: new Map(), file: null, cluster: 0, files: 0, lines: 0, bytes: 0 };
}

export function buildTree(files: FileEntry[]): TreeNode {
  const root = node("", "", 0);
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let d = 0; d < parts.length; d++) {
      const name = parts[d]!;
      const p = parts.slice(0, d + 1).join("/");
      let next = cur.children.get(name);
      if (!next) {
        next = node(name, p, d + 1);
        cur.children.set(name, next);
      }
      cur = next;
    }
    cur.file = f;
  }
  const total = (n: TreeNode): void => {
    if (n.children.size === 0 && n.file) {
      n.files = 1;
      n.lines = n.file.lines;
      n.bytes = n.file.bytes;
      return;
    }
    n.files = n.lines = n.bytes = 0;
    for (const c of n.children.values()) {
      total(c);
      n.files += c.files;
      n.lines += c.lines;
      n.bytes += c.bytes;
    }
  };
  total(root);
  return root;
}

/** Fold the deepest directories into single "cluster" buildings until the city fits. */
export function collapseTree(root: TreeNode, maxBuildings: number): number {
  let leaves = root.files;
  if (leaves <= maxBuildings) return 0;
  const dirs: TreeNode[] = [];
  const visit = (n: TreeNode) => {
    if (n.children.size === 0) return;
    if (n !== root) dirs.push(n);
    for (const c of n.children.values()) visit(c);
  };
  visit(root);
  dirs.sort((a, b) => b.depth - a.depth || b.files - a.files);
  const buildingsUnder = (n: TreeNode): number => {
    if (n.children.size === 0) return 1;
    let s = 0;
    for (const c of n.children.values()) s += buildingsUnder(c);
    return s;
  };
  let collapsed = 0;
  for (const d of dirs) {
    if (leaves <= maxBuildings) break;
    const current = buildingsUnder(d);
    d.children.clear();
    d.file = { path: d.path, bytes: d.bytes, lines: d.lines };
    d.cluster = d.files; // original file count under this directory
    leaves -= current - 1;
    collapsed++;
  }
  // Recompute leaf counts after collapsing.
  const recount = (n: TreeNode): number => {
    if (n.children.size === 0) return (n.files = n.cluster || 1);
    n.files = 0;
    for (const c of n.children.values()) n.files += recount(c);
    return n.files;
  };
  recount(root);
  return collapsed;
}

export interface ScanResult {
  tree: TreeNode;
  fileCount: number;
  truncated: boolean;
}

export async function scanRepo(root: string, maxBuildings = 2400): Promise<ScanResult> {
  const rels = await listFiles(root);
  const files = await statFiles(root, rels, rels.length <= 20_000);
  const tree = buildTree(files);
  const collapsed = collapseTree(tree, maxBuildings);
  return { tree, fileCount: files.length, truncated: collapsed > 0 };
}

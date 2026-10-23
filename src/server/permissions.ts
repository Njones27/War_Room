// Minimal matcher for Claude Code-style permission rules, used for
// "ALWAYS ALLOW" decisions made on the map while a sortie is live.
// Rules added this way are also passed to later runs via --allowedTools.

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/** Bash command rules: `*` spans anything, including spaces and slashes. */
function commandGlob(pattern: string): RegExp {
  const legacy = pattern.endsWith(":*") ? pattern.slice(0, -2) + "*" : pattern;
  const re = legacy
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "s");
}

export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const m = rule.match(/^([A-Za-z0-9_]+)(?:\((.*)\))?$/s);
  if (!m) return false;
  const [, name, spec] = m as unknown as [string, string, string | undefined];
  if (spec === undefined) {
    if (name.startsWith("mcp__") && name.split("__").length === 2) return toolName.startsWith(`${name}__`);
    return toolName === name;
  }
  if (toolName !== name) return false;
  if (name === "Bash" || name === "PowerShell") {
    const cmd = String(input.command ?? "").trim();
    // A wildcard must never stretch over a second command (`npm test; rm -rf ~`).
    if (spec.includes("*") && /[;&|`\n]|\$\(/.test(cmd)) return false;
    return commandGlob(spec).test(cmd);
  }
  if (name === "WebFetch" && spec.startsWith("domain:")) {
    try {
      const host = new URL(String(input.url ?? "")).hostname;
      const domain = spec.slice("domain:".length);
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  }
  const p = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
  return p !== "" && globToRegex(spec).test(p);
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Claude Code's --allowedTools parser toggles on every parenthesis and splits on
// spaces and commas outside them, so a ( or ) inside a rule would break it into
// broader rules: `Bash(x (y) Write (z))` would yield a bare `Write`.
const PARENS = /[()]/;

/**
 * Rules safe to hand to --allowedTools: a tool name (MCP names can hold "-" and
 * end in "*"), optionally with one (...) that holds no parentheses.
 */
export function cliSafeRules(rules: string[]): string[] {
  return rules.filter((r) => /^[A-Za-z0-9_*-]+(\([^()]*\))?$/.test(r));
}

/**
 * The rule ALWAYS ALLOW records: this exact command, file or web domain, and
 * nothing broader. null when no exact rule is possible (a command or path with
 * a wildcard in it, or any other tool), so the action is approved just once.
 */
export function alwaysRuleFor(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Bash" || toolName === "PowerShell") {
    const cmd = String(input.command ?? "").trim();
    // A `*` in a rule is a wildcard: `rm -rf dist/*` would also allow `rm -rf dist/x ~/.ssh`.
    return cmd && !cmd.includes("*") && !PARENS.test(cmd) ? `${toolName}(${cmd})` : null;
  }
  if (toolName === "WebFetch") {
    try {
      const host = new URL(String(input.url ?? "")).hostname;
      return host ? `WebFetch(domain:${host})` : null;
    } catch {
      return null;
    }
  }
  if (FILE_TOOLS.has(toolName)) {
    const p = String(input.file_path ?? input.notebook_path ?? "");
    return p && !/[*?[\]{}()]/.test(p) ? `${toolName}(${p})` : null;
  }
  return null;
}

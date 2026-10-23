# War Room v1: build plan

Full design: the approved plan (control plane + heartbeats + BF6 Code City map).

## Build
- [x] 0. Spike: stream-json in/out (+ mid-run order), `--resume`, `--permission-prompt-tool` via HTTP MCP (allow/deny), `--max-budget-usd`, node-pty `claude --resume`
- [x] 1. Scaffold: package/configs, shared protocol, SQLite store, security (token, Origin/Host), roles loader
- [x] 2. Control plane: scheduler (wakes, coalescing, concurrency, budget gate), claude_local runner, stream parser, activity mapper
- [x] 3. War Room MCP tools (orders, checkout, update/create objective, roster, radio, report, reinforcements, merge, permission prompt), approvals, budgets, worktrees
- [x] 4. Demo adapter + seeded demo squad (mission arc + autopilot); watch-only units from `claude agents --json`
- [x] 5. Code City scan + squarified-treemap layout, outskirts for small repos (unit tests)
- [x] 6. Three.js map: camo, city, roads, trees, boundary, HQ, zones, camera (zoom/pan/reset), picking, objective cam
- [x] 7. Pixel mascot sprites: 16 activity states + 7 role gear sets
- [x] 8. HUD: header, score bar, agent row, mission, faction, roster, intel panel (FEED/OBJECTIVES/FILES/TERMINAL), comms ticker, approvals, role picker + DEPLOY, deploy dialog, manage dialog, objectives board, PING
- [x] 9. TAKE COMMAND: node-pty + xterm.js, wake lock, copy-command fallback
- [x] 10. Verify: `npm test` (33), typecheck, demo in browser vs BF6 screenshots, live e2e on a sandbox repo
- [x] 11. README (setup, cost, roles, comparison), screenshot

## Review

**Live end-to-end** (sandbox repo with an off-by-one bug; real Claude Code, Max subscription):
- The General diagnosed the bug and requested an Engineer, which I approved on the map. The Engineer fixed it in its worktree.
- The test run was approved from the map. An order sent mid-run was honored: the report quoted the test line as asked.
- The General re-verified, requested a merge, merged after approval, and the mission completed.
- Cost: 5 sorties, about $0.94 estimated. Merge commit landed, tests 3/3 pass.
- Dismissing the Engineer removed its clean worktree and kept the branch. No stray processes were left.

**TAKE COMMAND:** the real TUI rendered in the browser and keystrokes reached it. Exiting released the agent back to War Room.

**Bugs found and fixed during verification:**
- Undefined patch fields overwrote stored values.
- Layout `shrink()` couldn't expand.
- Vite's `?t=` collided with the launch token.
- Coalesced assignments lost their own sortie.
- The intel panel covered the objective cam.
- Camo contrast was too low.
- Tiny repos rendered as giant buildings.

**Known gaps (v1):**
- One theater per process.
- Windows untested.
- The General needs one extra approval when its merge command also runs tests (Claude Code checks each sub-command; that's working as designed).

# Feedback batch 1 (after trying v1)

- [x] Q / E cycle roles; Z toggles PING (keys, key caps, hints, README)
- [x] Remove the crosshair lines; corner + / − are real zoom buttons
- [x] Idle agents hold position instead of walking back to HQ
- [x] Font: Rajdhani only (dropped the unused Barlow fallback name)
- [x] Model dropdown (aliases, pinned versions, Custom…) in Deploy and Manage
- [x] SUPPLY toggle: BUDGET (dollar caps) ↔ USAGE (plan usage, no caps, 5H / 7D windows)
- [x] TEAM MODE: the General runs as a live Claude Code session that builds its own agent team
- [x] README

## Review

**Tests:** 43 pass (was 33). New: supply gate and default, `unifiedWindows` parsing, and seven team-mode tests (spawn args and settings, hook → teammate mapping, permission allow / deny / ALWAYS / TERMINAL, typed orders and relays, task list, session end + RESUME).

**Spike first:** before building team mode, a Haiku spike hosted a real team lead in a PTY with HTTP hooks. It showed:
- teammates' hooks carry `agent_id` = `a<name>-<hex>` with `agent_type` = the name
- a held `PermissionRequest` blocks only that tool call (the TUI stays usable)
- the team directory name doesn't follow `--session-id`
- `/exit` asks to confirm while teammates run
- the TUI supports bracketed paste
- no `SessionStart` hook arrives, so readiness keys off the first hook of any kind

**Live team run** (non-git sandbox, Haiku, low effort):
- The lead spawned mathcheck and strcheck, which appeared as A1 / A2 on the map.
- mathcheck's Bash request was approved from the map card; it found `sum(2,2)` = 5.
- The lead closed the objective (mission complete).
- An order typed into the session made the lead message strcheck and report back.
- The team terminal showed the live TUI.
- DISMISS ended it cleanly: no stray processes, team config removed, run dir empty.

**Demo:** a scripted team (scout / sapper / critic) drives the same hook handler, so team mode can be tried with no usage.

**Known gaps:**
- Plan usage windows only arrive with headless sorties; a team session alone doesn't report them.
- Teammates don't survive a restart (agent teams limitation).
- A team in an untrusted git repo stops at Claude Code's trust prompt until it's answered in TERMINAL (War Room flags it).

## Review: prompt safety in team sessions

- War Room answers every team permission request itself: the TERMINAL hand-off on cards is gone. Allow replies carry the unchanged input as `updatedInput`, so ExitPlanMode and other dialog-only tools take the map's answer.
- Typing holds per request, only while the lead's or a plain subagent's request is unanswered. Cards answered in the terminal are retired on a matching PostToolUse, the lead's Stop, or the subagent's SubagentStop.
- The backlog goes in as one paste. Each keystroke re-checks, and typing waits 500ms after an answer so Claude Code can close the dialog.
- `AskUserQuestion` is disallowed; MCP elicitations are declined through the `Elicitation` hook.
- `cliSafeRules` keeps MCP names with `-` and `*`.
- **Tests:** 56 pass. Checked in the demo: team cards, approve, and order delivery.

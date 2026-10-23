# Lessons

- **"Claude Code harness" means wrapping the user's local `claude` CLI**, not re-implementing agents on the Agent SDK. Each agent must be a real Claude Code session (their login, CLAUDE.md, skills, plugins, MCP) that they can resume or take over.
- **Research comparable systems before proposing an architecture.** For an "agentic OS", study Paperclip / Gas Town / Claude Code agent view first. The expected shape is a control plane (org chart, task inbox with atomic checkout, event-driven heartbeat runs of `claude -p --output-format stream-json --resume`, budgets, approvals, audit log), not ad-hoc long-lived sessions with messages typed into a TUI.
- **State cost up front.** Explain whether a tool spends money (subscription limits vs API billing) before asking for plan approval.
- **Spawning `claude` from inside a Claude Code session inherits host env** (`CLAUDECODE`, `CLAUDE_CODE_*`). Sanitize the child env, or runs pick up the host session's settings. Check `claude auth status` outside the sandbox; the sandbox hides the keychain.
- **Don't ship decorative controls.** If a HUD element copied from a reference looks clickable (the BF6 corner + / −), make it work or remove it. Users will click it.
- **Units hold position.** Idle agents stay where they last worked; sending them back to HQ between jobs reads as aimless shuttling.
- **Spike undocumented integrations before building on them.** For agent teams, a cheap PTY + HTTP-hook spike revealed id formats, exit prompts and missing events that the docs didn't state.

# keeper

Event-sourced control-data daemon for Claude Code agents — Bun + `bun:sqlite`, single host,
single DB. Every agent session feeds an append-only event log; a long-running daemon
(`keeperd`) folds it into live projections and serves them over a subscribe/RPC socket.

- **Session tracking** — every prompt, tool call, and file mutation across claude, codex,
  pi, and hermes sessions lands in one queryable log
- **Live board** — plan epics/tasks, jobs, git state, and usage served as live-updating
  collections (`keeper status`, `keeper board`, `keeper query`)
- **Autopilot** — a reconciler dispatches plan work to managed workers, with worktree
  lanes, merge handling, and escalation
- **History forensics** — `keeper transcript` extracts bounded main/subagent
  conversations; `keeper search-history`, `keeper find-file-history`, and
  `keeper session events` answer who/when/what across sessions
- **Crash restore** — `keeper tabs restore` re-opens managed agent windows; a rolling
  cadence of verified DB snapshots guards the log
- **Agent Bus** — `keeper bus chat send <target> "message"` stores new content in a
  Bus message artifact; receivers explicitly read its confined path from the
  metadata-only notification. See the [bus skill](./plugins/keeper/skills/bus/SKILL.md).

Install & uninstall: [docs/install.md](./docs/install.md) · Guardrails:
[CLAUDE.md](./CLAUDE.md) · Vocabulary: [CONTEXT.md](./CONTEXT.md) · Decisions:
[docs/adr/](./docs/adr/)

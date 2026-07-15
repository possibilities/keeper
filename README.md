# keeper

Event-sourced control-data daemon for Claude Code agents — Bun + `bun:sqlite`, single host,
single DB. Every agent session feeds an append-only event log; a long-running daemon
(`keeperd`) folds it into live projections and serves them over a subscribe/RPC socket.

- **Session tracking** — every prompt, tool call, and file mutation across Claude and
  Pi sessions lands in one queryable log; a Pi `/rename` command derives a short
  Session title inline
- **Live board** — plan epics/tasks, jobs, and git state served as live-updating
  collections (`keeper status`, `keeper board`, `keeper query`)
- **Autopilot** — a reconciler dispatches plan work to managed workers, with worktree
  lanes, merge handling, and escalation; Harness activity, Dispatch claims, and exact
  Resource holds remain independently observable and recoverable
- **History forensics** — `keeper history list|show|search|files|index` is the
  canonical Claude/Pi surface; `keeper resume <session-reference>` is the human
  foreground continuation path; `keeper transcript` stays for explicit
  subagent/tool-detail or Pi branch-aware drill-down
- **Offline conversion** — `keeper conversation convert --from claude --to pi
  <session-reference>` writes native Pi sessions for a Claude parent and all of its
  subagents, with lossless provenance and no daemon or runtime dependency
- **Crash restore** — `keeper tabs restore` re-opens managed agent windows; a rolling
  cadence of verified DB snapshots guards the log
- **Agent Bus** — `keeper bus chat send <target> "message"` stores new content in a
  Bus message artifact; receivers explicitly read its confined path from the
  metadata-only notification. See the [bus skill](./plugins/keeper/skills/bus/SKILL.md).
- **Owned panels** — each request admits one bounded fan-out and one generic Task-owned judge;
  retries join the durable request and cancellation settles its exact registered children. See
  [installation and smoke checks](./docs/install.md#pi-task-and-panel-operations) and
  [machine-visible failures](./docs/problem-codes.md#panel-run-lifecycle).

Install, lifecycle audit, and uninstall: [docs/install.md](./docs/install.md) · Testing:
[docs/testing.md](./docs/testing.md) · Guardrails: [CLAUDE.md](./CLAUDE.md) · Vocabulary:
[CONTEXT.md](./CONTEXT.md) · Decisions: [docs/adr/](./docs/adr/)

# keeper

Event-sourced control-data daemon for Claude Code agents — Bun + `bun:sqlite`, single host,
single DB. Every agent session feeds an append-only event log; a long-running daemon
(`keeperd`) folds it into live projections and serves them over a subscribe/RPC socket.

- **Session tracking** — every prompt, tool call, and file mutation across Claude and
  Pi sessions lands in one queryable log; Claude uses its native `/rename`, while Pi's
  Keeper command provides bounded inference and canonical explicit slugs, and both
  native title sources feed Keeper's title history and Tmux renamer
- **Live board** — plan epics/tasks, jobs, and git state served as live-updating
  collections (`keeper status`, `keeper board`, `keeper query`)
- **Autopilot** — a reconciler dispatches plan work to managed workers, with worktree
  lanes, merge handling, and escalation; Harness activity, Dispatch claims, and exact
  Resource holds remain independently observable and recoverable
- **Account routing** — Claude launches use process-bound claude-swap Account routes from
  a fresh Capacity observation. claude-swap owns `usageStatus` and raw quota values;
  per-account Measurement age remains provenance in `keeper usage`, not an eligibility
  gate. Keeper-launched Pi sessions use an isolated Codex companion with its own visible native
  fallback and proof-gated activation. `keeper agent accounts check --json` reports both
  without reading credentials; see the [routing operations guide](./docs/install.md#pi-codex-account-pool)
- **Account focuses** — independent, PII-free stable-route preferences: Fable focus matches
  proven Fable work and Non-Fable focus matches proven non-Fable work. Explicit `--x-account`
  wins, then the matching eligible focus, Fable soft avoidance, and normal route selection.
  Focus fallback is visible and delivery health is independent; each scope rolls back with its
  own `clear`. Inspect both through account checks, `keeper status`, and `keeper board`. See the
  [routing operations guide](./docs/install.md#claude-account-routing-and-account-focuses)
- **History forensics** — `keeper history list|show|search|files|index` is the
  canonical Claude/Pi surface; `keeper resume <session-reference>` is the human
  foreground continuation path; `keeper transcript` stays for explicit
  subagent/tool-detail or Pi branch-aware drill-down
- **Offline conversion** — `keeper conversation convert` writes resumable native
  sessions in either Claude→Pi or Pi→Claude direction, preserving branches and
  lossless provenance without a daemon or harness runtime
- **Crash restore** — `keeper tabs restore` re-opens managed agent windows; a rolling
  cadence of verified DB snapshots guards the log
- **Agent Bus** — `keeper bus chat send <target> "message"` stores content in a
  confined artifact and reports socket acceptance; a delivered send may also show the
  recipient's pre-fanout Harness activity, never a read receipt. See the
  [bus skill](./plugins/keeper/skills/bus/SKILL.md).
- **Owned panels** — each request admits one bounded fan-out and one generic Task-owned judge;
  retries join the durable request, cancellation settles exact registered children, and daemon
  maintenance resumes pending or failed cleanup without reconstructing targets. See
  [installation and smoke checks](./docs/install.md#pi-task-and-panel-operations) and
  [machine-visible failures](./docs/problem-codes.md#panel-run-lifecycle).

Install, lifecycle audit, and uninstall: [docs/install.md](./docs/install.md) · Testing:
[docs/testing.md](./docs/testing.md) · Guardrails: [CLAUDE.md](./CLAUDE.md) · Vocabulary:
[CONTEXT.md](./CONTEXT.md) · Decisions: [docs/adr/](./docs/adr/)

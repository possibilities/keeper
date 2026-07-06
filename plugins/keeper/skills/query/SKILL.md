---
name: query
description: >-
  Read keeper's control data efficiently — session history, the live board,
  and the daemon's projections — without hand-parsing files or guessing at
  schema. Use when you need to look something up in keeper's own state: "what
  did that session do", "when did this file last change", "which jobs are
  running", "what's on the board", "read the dead letters / dispatch failures /
  usage" — even when the user never says "keeper" or "query". Reaches for
  stable JSON history verbs first, the live query/status projections second,
  and read-only sqlite last. NOT for investigate-and-route a code question
  (that is `/plan:hack`), NOT for hunting a bug in misbehaving code (that is
  `keeper:debug`), NOT for changing board state — pause/arm/retry/dispatch
  (that is `keeper:autopilot`).
allowed-tools: Bash
---

# query

Read keeper's control data the cheap way. keeper stores everything it knows —
every session's prompts and tool calls, the plan board, the live projections —
in one event-sourced SQLite DB behind the daemon. This skill routes a "look it
up in keeper" need to the narrowest read that answers it, so you never Read a
raw transcript or hand-parse a projection you could have queried.

**Two facts frame every read.** The daemon is the DB's SOLE writer — nothing
here mutates state. And a read-only connection is the actual guard: `sqlite3
-readonly` and the daemon's read-only round-trip enforce read-only at the
connection, not the prose. Keyword filters and "SELECT-only" are discipline, not
enforcement — the connection is.

## When this fires

You need a fact out of keeper's own state:

- *"what did session X do"*, *"replay that worker's tool calls"*
- *"when did this file last change / who touched it"*
- *"which jobs are running / failed / stuck"*, *"what's on the board"*
- *"read the dead letters / dispatch failures / handoffs / usage"*

**Near-miss exclusions — these are NOT this skill:**

- *"how does X work"*, investigate-and-route a code question → `/plan:hack`.
- Hunting a bug in code misbehaving right now → `keeper:debug` (it reaches for
  the same history verbs, but as forensics inside a debug loop).
- Changing board state — pause, arm, retry a dispatch, launch a worker →
  `keeper:autopilot` (or `keeper:dispatch`). This skill only reads.

## The three-tier read hierarchy

Reach in this order — each tier is cheaper and more stable than the one below
it. Drop to the next tier only when the one above cannot answer.

### Tier 1 — session-history JSON verbs (reach first)

Stable, purpose-built subcommands over `keeper.db`, read-only, no daemon, no
lock. Each prints one `{schema_version, ok, error, data}` envelope. Prefer these
to Reading a transcript — they are bounded and pre-shaped:

| Verb | Answers |
|---|---|
| `keeper find-file-history <path-fragment>` | Which sessions mutated a file, most-recent-first (session, time, op, source). |
| `keeper search-history <term>` | The prompt where something was discussed (ts, session, snippet); includes compacted events. |
| `keeper session events --session-id <id>` | One session's prompt/tool-call spine, chronological. |
| `keeper session summary <session-id>` | A bounded one-shot summary of a session — title, lifecycle, plan linkage, first/last prompt, event counts. Use instead of Reading the transcript. |
| `keeper show-job [selectors]` | One job's full metadata from the `jobs` projection; no selector auto-detects your own job. |

### Tier 2 — live projections (query / status)

When you need current derived state rather than session history, read the
daemon's projections over its socket — a read-only round-trip:

- `keeper status --json` — the board in one envelope: autopilot config
  (`{paused, mode, …}`), per-row readiness verdicts, counts, `drained`/`jammed`,
  in-flight launches, needs-human. Exit 0 on any board state.
- `keeper query <collection> [--filter k=v]... [--json]` — one allowlisted
  collection as a row array in the standard envelope. `--filter` is exact-match,
  repeatable, ANDed, resolved server-side against the collection's declared
  filters.

The everyday view is `keeper query tasks --json` — one row per open-epic task
(epic_id, task_id, title, tier, model, depends_on, runtime_status, readiness
verdict + pill), the derived per-task read you'd otherwise hand-assemble from
`query epics --json | jq`.

### Tier 3 — read-only sqlite (last resort)

Only when tiers 1–2 cannot express the read — an ad-hoc column or a join no verb
exposes. Never a default.

- Open read-only: `sqlite3 -readonly "$KEEPER_DB" '<sql>'`.
- `.schema <table>` FIRST — never guess columns.
- One single-statement `SELECT` with a `LIMIT`. No multi-statement scripts.
- The `-readonly` flag is the guard; if you cannot express it as one bounded
  SELECT, stop and reconsider tier 1–2.

## Orient the board

<!-- POINTER: keeper prompt render engineering/orient -->

Before reading specific rows, one call frames the whole board: `keeper status
--json` prints autopilot config, per-row readiness, counts, `drained`/`jammed`,
in-flight launches, and needs-human in a single exit-0 envelope. For the full
orient step run `keeper prompt render engineering/orient`.

## History forensics — "when did this change"

<!-- POINTER: keeper prompt render engineering/keeper-history-forensics -->

Tier-1 verbs turn "when did this regress / who touched it" into a query:
`keeper find-file-history <path-fragment>` lists the sessions that mutated a file
most-recent-first, `keeper search-history <term>` finds the prompt where a change
was discussed, and `keeper session events --session-id <id>` replays what
that session actually did. Run `keeper prompt render
engineering/keeper-history-forensics` for the full recipe set.

## The query collections

`keeper query --help` is the canonical, always-current list — read it rather
than trusting this enumeration if they ever disagree. The read allowlist is 18
collections:

`armed_epics`, `autopilot_state`, `block_escalations`, `builds`, `dead_letters`,
`dispatch_failures`, `epics`, `git`, `handoffs`, `jobs`, `lane_merged`,
`pending_dispatches`, `profiles`, `scheduled_tasks`, `subagent_invocations`,
`tmux_client_focus`, `usage`, `worktree_repo_status`.

`tasks` is a derived view layered on top (one row per open-epic task) — the most
useful read of all, and what you want over `epics` for per-task detail. An
off-allowlist name is rejected at parse time before any daemon round-trip, so
`--help` and this list are the whole surface.

## Guardrails

- **Reach top-down.** Tier 1 before tier 2 before tier 3 — a history verb over a
  raw SELECT every time it can answer. Drop a tier only when the one above
  genuinely cannot express the read.
- **Read-only is enforced at the connection, not the prose.** `sqlite3
  -readonly` and the daemon round-trip are the guard; never open a writable
  connection to "just look."
- **The daemon is the sole writer.** Nothing in this skill mutates state — to
  change the board, that is `keeper:autopilot` / `keeper:dispatch`.
- **Prefer a query to a Read.** A bounded envelope beats hand-parsing a
  transcript or a projection dump; if a tier-1 verb answers it, do not Read the
  file.

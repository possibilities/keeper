---
name: query
description: >-
  Read keeper's control data efficiently — session history, the live board,
  and the daemon's projections — without hand-parsing files or guessing at
  schema. Use when you need to look something up in keeper's own state: "what
  did that session do", "when did this file last change", "which jobs are
  running", "what's on the board", "read the dead letters / dispatch failures"
  — even when the user never says "keeper" or "query". Reaches for
  stable JSON history verbs first, the live query/status projections second,
  and read-only sqlite last. NOT for investigate-and-route a code question
  (that is `/plan:hack`), NOT for hunting a bug in misbehaving code (that is
  `keeper:debug`), NOT for changing board state — pause/arm/retry/dispatch
  (that is `keeper:autopilot`).
allowed-tools: Bash
---

# query

Read Keeper's history and control data through the narrowest supported surface.
Session history starts in native Claude/Pi artifacts and joins optional Keeper
job aliases; the plan board and live projections live in keeper.db behind the
daemon. Use a bounded command instead of hand-parsing either source.

**Three facts frame every lookup.** The daemon is keeper.db's sole writer.
`history list/show` and the daemon query round-trip are read-only. `history
search/files` may lock and refresh a disposable private index, while explicit
`history index refresh|rebuild|purge` mutates only that index—never keeper.db,
the board, or native transcript artifacts.

## When this fires

You need a fact out of keeper's own state:

- *"what did session X do"*, *"replay that worker's tool calls"*
- *"when did this file last change / who touched it"*
- *"which jobs are running / failed / stuck"*, *"what's on the board"*
- *"read the dead letters / dispatch failures / handoffs"*
- *"what model/context is this session actually running"*, *"what are my
  usage meters right now"*, *"what route would this launch pick / did my Pi
  session actually get"*

**Near-miss exclusions — these are NOT this skill:**

- *"how does X work"*, investigate-and-route a code question → `/plan:hack`.
- Hunting a bug in code misbehaving right now → `keeper:debug` (it reaches for
  the same history verbs, but as forensics inside a debug loop).
- Changing board state — pause, arm, retry a dispatch, launch a worker →
  `keeper:autopilot` (or `keeper:dispatch`). This skill never changes control
  state; only the disposable History index may refresh.

## The four-tier read hierarchy

Reach in this order — each tier is cheaper and more stable than the one below
it. Drop to the next tier only when the one above cannot answer.

### Tier 1 — session-history JSON verbs (reach first)

Stable, purpose-built subcommands over native artifacts plus optional Keeper
aliases. `list/show` are read-only; `search/files` take the private-index lock
and refresh that disposable index. Add `--format json` for the standard
`{schema_version, ok, error, data}` envelope. Prefer these bounded shapes to
reading a raw transcript:

| Verb | Answers |
|---|---|
| `keeper history list` | Which Claude/Pi sessions exist; shared exact Session references stay visible even when Keeper job aliases are unavailable. |
| `keeper history show <session-reference>` | One Session's bounded transcript page; ambiguity returns candidates and never newest-collapses. |
| `keeper history search <query>` | The prompt where something was discussed; refreshes the private history index first. |
| `keeper history files <path-fragment>` | File evidence grades (`observed_mutation`, `possible_mutation`, `mention`). Refreshes the private history index first. |
| `keeper history index [status|refresh|rebuild|purge]` | Inspect or maintain the disposable private history index. |
| `keeper show-job [selectors]` | One job's full metadata from the `jobs` projection; use `--session <session-reference>` for a shared Session reference. |

Use `keeper resume <session-reference>` when the next step is to continue the session in the foreground instead of inspecting it. `keeper transcript` stays only for explicit Claude subagent/tool-detail or Pi branch-aware turns.

### Tier 2 — purpose-built runtime, Usage, and routing reads

Before falling to a generic projection, three independent schema-v1,
side-effect-free commands answer a specific class of question directly. Each
prints one `{schema_version, ok, error, data}` envelope on stdout; partial or
unavailable evidence is reported explicitly (a bounded status/reason field),
never presented as a false zero. The full contracts — provenance, freshness,
partial-data semantics — live in `docs/agent-surface-contracts.md`.

| Verb | Answers |
|---|---|
| `keeper session runtime [<session-reference>]` | "What model/effort/context is THIS session actually running right now" — proven identity scope, exact-vs-coalesced provenance, freshness, and (for a Pi session) the current route. With no reference, resolves the ambient Harness identity. |
| `keeper usage --json` | Every normalized Claude/Codex Capacity meter — category, multiplier, source status, last-good measurement. Display data only; it never authorizes a routing decision. |
| `keeper accounts inspect [<session-reference>] --json` | Separate Claude launch-routing and Codex launch-seed routing blocks, plus — for a scoped Pi session — the actual PROVEN route after selection/retry, distinct from the initial launch alias. |

`keeper agent accounts check --json` remains compatible for existing callers,
but `keeper accounts inspect` is the preferred routing read — it keeps the
three provenance classes (Claude launch, Codex launch-seed, proven Pi runtime)
separate rather than folding them together.

### Tier 3 — live projections (query / status)

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

### Tier 4 — read-only sqlite (last resort)

Only when tiers 1–3 cannot express the read — an ad-hoc column or a join no verb
exposes. Never a default.

- Open read-only: `sqlite3 -readonly "$KEEPER_DB" '<sql>'`.
- `.schema <table>` FIRST — never guess columns.
- One single-statement `SELECT` with a `LIMIT`. No multi-statement scripts.
- The `-readonly` flag is the guard; if you cannot express it as one bounded
  SELECT, stop and reconsider tiers 1–3.

## Orient the board

<!-- POINTER: keeper prompt render engineering/orient -->

Before reading specific rows, one call frames the whole board: `keeper status
--json` prints autopilot config, per-row readiness, counts, `drained`/`jammed`,
in-flight launches, and needs-human in a single exit-0 envelope. For the full
orient step run `keeper prompt render engineering/orient`.

## History forensics — "when did this change"

<!-- POINTER: keeper prompt render engineering/keeper-history-forensics -->

Tier-1 verbs turn "when did this regress / who touched it" into a query:
`keeper history list` finds the exact Session reference, `keeper history show
<session-reference>` replays the bounded page, and `keeper history search|files`
recover prompt and file evidence. Run `keeper prompt render
engineering/keeper-history-forensics` for the full recipe set.

## The query collections

`keeper query --help` is the canonical, always-current list — run it rather
than trusting a hand-maintained inventory here, which drifts stale as
collections are added or renamed. `tasks` is a derived view layered on top
(one row per open-epic task) — the most useful read of all, and what you want
over `epics` for per-task detail. An off-allowlist name is rejected at parse
time before any daemon round-trip, so `--help` is the whole surface.

## Guardrails

- **Reach top-down.** Tier 1 before tier 2 before tier 3 before tier 4 — a
  history verb or a purpose-built runtime/Usage/routing read over a raw
  SELECT every time it can answer. Drop a tier only when the one above
  genuinely cannot express the read.
- **Read-only is enforced at the connection, not the prose.** `sqlite3
  -readonly` and the daemon round-trip are the guard; never open a writable
  connection to "just look."
- **The daemon is keeper.db's sole writer.** This skill never changes the board
  or native artifacts. History search/file reads may refresh the disposable
  private index; explicit index maintenance touches only that index.
- **Prefer a query to a Read.** A bounded envelope beats hand-parsing a
  transcript or a projection dump; if a tier-1 verb answers it, do not Read the
  file.

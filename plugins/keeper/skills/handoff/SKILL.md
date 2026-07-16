---
name: handoff
description: >-
  Hand a piece of work off to a fresh fire-and-forget claude worker via `keeper
  handoff` (one call; a keeperd worker boots it inline in your tmux session). Use
  whenever the human imperatively says "handoff" — "hand this off", "send a
  handoff", "handoff to/in the <repo> project" (cross-repo is just `--cwd`, still
  a handoff), "create handoffs", "spawn someone to investigate X" — or otherwise
  wants to pass a contextful task to a separate worker and walk away, even when
  they never say "keeper". This passes LIVE work to a worker; it is NOT authoring
  a markdown handoff DOCUMENT (a `.md` write-up) — for a written doc, just write
  the file. NOT for capturing/queuing a follow-up to track on the board (that is
  `plan:defer` — scaffolds an epic, dispatches no worker), NOT a plan-id launch
  (`keeper:dispatch` — `work::fn-N.M` / `close::fn-N`), NOT messaging a running
  agent (`keeper:bus`), NOT planning (`/plan:plan`).
allowed-tools: Bash
argument-hint: --slug <slug> --prompt "<brief>" [--cwd <path>] [--title "<t>"]
---

# handoff

Turn a "hand this off" / "create a handoff" request into a single
`keeper handoff` Bash call. `keeper handoff` enqueues a contextful brief for a
fresh `claude` worker; a keeperd worker opens a new window in your tmux session
and boots it into the configured `handoff_prompt_prefix` (currently `/hack`)
with your brief INLINE as that prefix's REQUEST (no `keeper handoff show`
round-trip). The handoff-ee runs the full prefix workflow — investigate first,
and for work-shaped briefs park at the prefix's confirm beat with a concrete
proposal, awaiting a plain-text greenlight in that window before any code lands.
A handoff SEEDS a prefix session; it does NOT run the work autonomously. The
enqueue is event-sourced and durable.

Fire-and-forget describes YOUR posture, not the handoff-ee's: the default
handoff parks at its confirm beat and has no deliverable. Fire one call, do NOT
use the Agent Bus, start a Monitor, or wait on that default handoff-ee. The
primed window waits for you whenever you switch to it. Use `--capture` only when
the human asks for a deliverable; its worker acts autonomously and writes the
standard answer envelope to its durable path.

A handoff slug is the caller-supplied, host-global event-sourced handle. It is
the dedup key, never a panel slug: a duplicate is rejected with exit 3 rather
than merged or re-launched.

Canonical contract: [Chunked wait](../../../../docs/agent-surface-contracts.md#chunked-wait)
and [Answer envelope](../../../../docs/agent-surface-contracts.md#answer-envelope) — on
wording disputes the doc wins.

## When this fires

The human wants to pass a contextful piece of work to a SEPARATE worker and
move on:

- *"Hand this off."* / *"Hand off this work to a fresh worker."*
- *"Create a handoff."* / *"Create handoffs for X and Y."*
- *"Spawn someone to investigate X."* / *"Kick off a worker to dig into Y; here's the context."*
- *"Send a handoff in the arthack project to work on it."* — a handoff launched in another repo via `--cwd`; a cross-repo target is not a reason to defer.

Each distinct handoff is ONE `keeper handoff` call — the one-call rule is
per-handoff, so "create handoffs for X and Y" is two calls (different `--slug`
each), not one.

**Near-miss exclusions — these are NOT this skill:**

- *"Write a handoff doc / handoff notes"* / *"draft a handoff document"* → that
  is authoring a markdown `.md` write-up, NOT dispatching live work to a worker.
  Just write the file; do not call `keeper handoff`.
- *"Fire a worker on fn-N.M"* / *"spawn a closer for fn-N"* → that is a plan
  launch: `keeper:dispatch` (`work::fn-N.M` / `close::fn-N`). Handoff carries a
  free-text brief, never a plan id/verb.
- *"Tell <agent> X"* / *"message the planner"* → that is `keeper:bus`, a
  message to an already-running agent.
- *"Defer this"* / *"put X on the list"* → that is `plan:defer`, which scaffolds
  a board epic and dispatches no worker. A temporal "when done…" or cross-repo
  framing does NOT downgrade a handoff to a defer — when the human says "handoff"
  or wants a worker to actually work on it, it is THIS skill.
- *"Plan a feature"* / *"make a plan"* → `/plan:plan`.

## Orient first (optional)

<!-- POINTER: keeper prompt render engineering/orient -->

When the brief depends on the current board — "hand off whatever's stuck", "spawn someone on the failing epic" — read it in one call first: `keeper status --json` prints autopilot config, per-row readiness verdicts, counts, `drained`/`jammed`, in-flight, and needs-human in a single envelope (exit 0 on any board state). For the full orient step run `keeper prompt render engineering/orient`. A self-contained brief needs no orient — skip to Step 1.

## Step 1 — Gather the brief

Assemble these from the conversation:

1. **A slug** (`--slug`, REQUIRED) — the short, human-meaningful,
   host-global handoff handle (e.g. `investigate-flaky-reaper`). It is slugified
   to `[a-z0-9-]+`, the worker launches as `handoff::<slug>`, and a duplicate is
   REJECTED (exit 3 — pick a new handle). Pick one descriptive of the work.
2. **The doc / brief** — the contextful instructions for the handoff-ee:
   what to investigate or build, plus the surrounding context it needs to start
   cold (paths, findings, constraints). This is the worker's whole world — be
   generous, but the brief is capped at 64KB (an over-cap brief is REJECTED,
   never truncated). The brief is the handoff-ee's prefix REQUEST, so it deeply
   shapes what happens — but write it as a request, NOT an order: avoid "just do
   it / land it / commit it" phrasing, which pushes the handoff-ee past the
   prefix's confirm beat and back into executing blind. Write it durable and
   behavioral: state the outcomes and contracts to deliver and *why*, not a
   line-by-line diff recipe. **Reference, don't duplicate** — point to the files,
   findings, and paths the worker should read rather than pasting large spans
   that rot as the repo moves. **Redact secrets** — the brief is event-sourced
   and durable, so keep tokens, keys, and credentials out of it; name where they
   live instead. If you've already written it to a file, use `--prompt-file`.
3. **A title** (`--title`) — a short human label for the handoff (optional but
   recommended; it surfaces on the board).
4. **The launch directory** (`--cwd`, optional) — the directory the handoff-ee
   launches in; defaults to YOUR current cwd. Pass `--cwd` only when the human
   wants the worker to start in a different repo/dir. Expands `~` and resolves a
   relative path; a non-existent / non-directory path is rejected (exit 2).
5. **The target session** (`--session`, optional) — defaults to
   `$KEEPER_TMUX_SESSION` > the current tmux session > `work`. Pass `--session`
   only when the human names a specific one.

If the human's request is too thin to write a useful brief, ask for the
missing context rather than enqueuing an empty handoff.

## Step 2 — Enqueue (one call)

```bash
keeper handoff --slug <slug> --prompt "<brief>" --title "<title>"
```

For a large brief or one already on disk:

```bash
keeper handoff --slug <slug> --prompt-file <path> --title "<title>"
```

Flags:

| Flag | Meaning |
|---|---|
| `--slug <slug>` | REQUIRED. Globally-unique id; slugified to `[a-z0-9-]+`. Worker launches as `handoff::<slug>`. A taken slug → exit 3. |
| `--prompt <doc>` | The brief inline. Mutually exclusive with `--prompt-file`. |
| `--prompt-file <path>` | Read the brief from a file (use for large briefs). |
| `--title <t>` | Human title for the handoff (surfaces on the board). |
| `--cwd <path>` | Directory the handoff-ee launches in. Default: your cwd. Expands `~`, resolves relatives; bad path → exit 2. |
| `--session <s>` | Target tmux session. Default: `$KEEPER_TMUX_SESSION` > current > `work`. |
| `--capture` | Opt in to an autonomous terminal deliverable at the durable envelope path; optional `--preset <triple>` or paired `--model <m> --effort <e>` select its launch. |

On success it prints the `handoff_id` (as `{ok, handoff_id}`) and exits 0. The
keeperd dispatcher resolves the target session internally; the CLI does not echo
it. The keeperd dispatcher mints a durable pre-launch marker and launches
the handoff-ee — a daemon restart mid-dispatch never double-launches.

## Captured handoff — fire, then wait

Choose this only when the human needs the handoff-ee's completed answer. Capture
is not the default because it spends an autonomous worker turn and retains a
terminal deliverable; ordinary delegated work should remain a parked handoff.

Request capture, then read the envelope path from the handoff row immediately
once the request returns:

```bash
SLUG=investigate-flaky-reaper
keeper handoff --capture --slug "$SLUG" --prompt "<autonomous brief>" --title "<title>"
ENVELOPE="$(keeper query handoffs --filter "handoff_id=$SLUG" --format json | jq -er '.data[0].envelope_path')"
```

Wait against `ENVELOPE` using the [Chunked wait](../../../../docs/agent-surface-contracts.md#chunked-wait)
contract: issue one bounded Bash tool call per chunk, with its `timeout`
parameter, to wait for and read that path. If the caller timeout expires, issue
a fresh bounded Bash tool call against the same path; do not put the re-issue in
a shell loop. A timeout detaches only this waiter; it neither cancels nor
re-launches the handoff-ee. The [Answer envelope](../../../../docs/agent-surface-contracts.md#answer-envelope)
contract defines the terminal JSON to read.

## Step 3 — Report

Surface to the human:

- The `handoff_id`. (The CLI does not report the target session; it dispatches
  into your current/`--session` tmux session per the precedence above.)
- How to inspect: `keeper status --json` for a one-shot board read (the
  handoff-ee surfaces as a job once it binds), `keeper board` for the live
  handoff-from → handoff-to relationship on your row and the handoff-ee's, and
  `keeper handoff show <slug>` (prints the stored brief — inspection only; the
  handoff-ee already has the brief inline and does not call it).

Then stop. This is fire-and-forget unless `--capture` was explicitly requested;
in that case report the durable envelope path and use the captured-handoff wait
recipe above.

## Exit taxonomy

| Exit | Meaning | Your action |
|---|---|---|
| 0 | Enqueued. | Surface the `handoff_id` + how to inspect. |
| 1 | Enqueue failure (e.g. daemon unreachable). | Read the message and surface it — keeperd may be down. |
| 2 | Arg fault: missing/empty `--slug`, both `--prompt` and `--prompt-file`, neither, an over-64KB brief, a NUL byte, or a bad `--cwd`. | Fix the named arg; for a large brief use `--prompt-file`. |
| 3 | Slug already in use (host-global). | Pick a new `--slug` and re-run. |

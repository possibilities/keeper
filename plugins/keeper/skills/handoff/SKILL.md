---
name: handoff
description: >-
  Hand a piece of work off to a fresh fire-and-forget claude worker — gather a
  contextful brief + instructions, then enqueue it with `keeper handoff` ONCE.
  A keeperd worker dispatches the brief into a new worker in your tmux session,
  preloaded with the doc. Use when the human says "hand this off", "hand off
  this work", "spawn someone to investigate X", or otherwise wants to pass a
  contextful task to a separate worker and walk away — even when they never say
  "keeper" or "handoff". NOT for launching a worker on a plan id (that is
  `keeper:dispatch` — `work::fn-N.M` / `close::fn-N`), NOT for messaging an
  already-running agent (that is `keeper:bus`), and NOT for planning work
  (`/plan:plan`).
allowed-tools: Bash
argument-hint: --prompt "<brief>" [--title "<t>"]
---

# handoff

Turn a "hand this off" request into a single `keeper handoff` Bash call.
`keeper handoff` enqueues a contextful brief for a fresh `claude` worker; a
keeperd worker opens a new window in your tmux session and boots it into the
configured `handoff_prompt_prefix` (`/hack` on this machine), pointed at your
brief. The handoff-ee reads the brief as its `/hack` REQUEST and runs the full
`/hack` workflow — investigate first, and for work-shaped briefs park at
`/hack`'s confirm beat with a concrete proposal, awaiting a plain-text greenlight
in that window before any code lands. A handoff SEEDS a `/hack` session; it does
NOT run the work autonomously. The enqueue is event-sourced and durable.

Fire-and-forget describes YOUR posture, not the handoff-ee's: you fire the one
call and walk away — do NOT use the Agent Bus, do NOT start a Monitor, do NOT
wait on the handoff-ee. The primed window waits for you whenever you switch to
it. Run the one call and report.

## When this fires

The human wants to pass a contextful piece of work to a SEPARATE worker and
move on:

- *"Hand this off."* / *"Hand off this work to a fresh worker."*
- *"Spawn someone to investigate X."* / *"Kick off a worker to dig into Y; here's the context."*

**Near-miss exclusions — these are NOT this skill:**

- *"Fire a worker on fn-N.M"* / *"spawn a closer for fn-N"* → that is a plan
  launch: `keeper:dispatch` (`work::fn-N.M` / `close::fn-N`). Handoff carries a
  free-text brief, never a plan id/verb.
- *"Tell <agent> X"* / *"message the planner"* → that is `keeper:bus`, a
  message to an already-running agent.
- *"Plan a feature"* / *"make a plan"* → `/plan:plan`.

## Step 1 — Gather the brief

Assemble three things from the conversation:

1. **The doc / brief** — the contextful instructions for the handoff-ee:
   what to investigate or build, plus the surrounding context it needs to start
   cold (paths, findings, constraints). This is the worker's whole world — be
   generous, but the brief is capped at 64KB (an over-cap brief is REJECTED,
   never truncated). The brief is the handoff-ee's `/hack` REQUEST, so it deeply
   shapes what happens — but write it as a request, NOT an order: avoid "just do
   it / land it / commit it" phrasing, which pushes the handoff-ee past `/hack`'s
   confirm beat and back into executing blind. If you've already written it to a
   file, use `--prompt-file`.
2. **A title** (`--title`) — a short human label for the handoff (optional but
   recommended; it surfaces on the board).
3. **The target session** (`--session`, optional) — defaults to
   `$KEEPER_TMUX_SESSION` > the current tmux session > `work`. Pass `--session`
   only when the human names a specific one.

If the human's request is too thin to write a useful brief, ask for the
missing context rather than enqueuing an empty handoff.

## Step 2 — Enqueue (one call)

```bash
keeper handoff --prompt "<brief>" --title "<title>"
```

For a large brief or one already on disk:

```bash
keeper handoff --prompt-file <path> --title "<title>"
```

Flags:

| Flag | Meaning |
|---|---|
| `--prompt <doc>` | The brief inline. Mutually exclusive with `--prompt-file`. |
| `--prompt-file <path>` | Read the brief from a file (use for large briefs). |
| `--title <t>` | Human title for the handoff (surfaces on the board). |
| `--session <s>` | Target tmux session. Default: `$KEEPER_TMUX_SESSION` > current > `work`. |

On success it prints the `handoff_id` (as `{ok, handoff_id}`) and exits 0. The
keeperd dispatcher resolves the target session internally; the CLI does not echo
it. The keeperd dispatcher mints a durable pre-launch marker and launches
the handoff-ee — a daemon restart mid-dispatch never double-launches.

## Step 3 — Report

Surface to the human:

- The `handoff_id`. (The CLI does not report the target session; it dispatches
  into your current/`--session` tmux session per the precedence above.)
- How to inspect: `keeper board` (the handoff-from → handoff-to relationship
  renders on your row and the handoff-ee's once it binds), and
  `keeper handoff show <handoff_id>` (prints the stored brief — also the
  dispatched worker's own first call).

Then stop. This is fire-and-forget — do not wait on or monitor the handoff-ee.

## Exit taxonomy

| Exit | Meaning | Your action |
|---|---|---|
| 0 | Enqueued. | Surface the `handoff_id` + how to inspect. |
| 1 | Enqueue failure (e.g. daemon unreachable). | Read the message and surface it — keeperd may be down. |
| 2 | Arg fault: both `--prompt` and `--prompt-file`, neither, an over-64KB brief, or a NUL byte. | For a large brief, write it to a file and use `--prompt-file`. |

## What NOT to do

- Do not pass a plan id/verb (`work::fn-N.M`, `close::fn-N`) — handoff carries
  a free-text brief, not a plan target. Those are `keeper:dispatch`.
- Do not use the Agent Bus and do not start a Monitor — handoff is
  fire-and-forget, with no wait-and-watch step.
- Do not pass BOTH `--prompt` and `--prompt-file` (exit 2).
- Do not pass a brief over 64KB via `--prompt` — route it to `--prompt-file`
  (an over-cap brief is rejected, never truncated).
- Do not call `keeper handoff` more than once for a single hand-off request —
  one enqueue per handoff.

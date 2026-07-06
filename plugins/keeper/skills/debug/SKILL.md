---
name: debug
description: >-
  Debug in-flight code feedback-loop-first: build a tight, red-capable
  reproduction BEFORE forming any hypothesis, then test ranked falsifiable
  hypotheses one at a time. Use when the intent is to hunt a bug in code that is
  misbehaving now — "why does X fail", "this test fails and I don't see why",
  "it's intermittent / flaky", "X regressed", "track down this crash" — even
  when the user never says "keeper" or "debug". NOT for system inquiry or "how
  does X work" or routing a request (that is `/plan:hack`); NOT for a failure
  whose fix is already obvious and needs no investigation.
allowed-tools: Bash
---

# debug

Find the cause of misbehaving code by experiment, not by reasoning in the
abstract. **The one rule: no hypothesis before a red-capable feedback loop.** A
loop is a single command you can run right now that goes RED on the bug and will
go GREEN once it is fixed. Build it, run it once, watch it fail — only then start
guessing at causes. A hypothesis formed against a loop you have never seen fail
is a guess dressed up as analysis.

Adapted for an unattended worker: where an interactive debugger would stop and
ask the human, **you escalate instead** — a typed `BLOCKED:` carrying the
evidence you gathered. And **"I cannot build a feedback loop" is itself the
hard stop**: it escalates, it is never a license to start guessing.

## When this fires

The intent is to hunt a bug in code that is misbehaving right now:

- *"why does X fail"*, *"this test fails and I can't see why"*
- *"it's intermittent / flaky / passes sometimes"*
- *"X regressed"*, *"this used to work"*
- *"track down this crash / hang / wrong output"*

**Near-miss exclusions — these are NOT this skill:**

- *"how does X work"*, *"what does this system do"*, investigate-and-route → that
  is `/plan:hack`. This skill is for in-flight code debugging, not system inquiry.
- A failure whose one-line fix is already obvious → just fix it; you do not need
  a hypothesis loop for a typo.
- Merely *seeing* an error mentioned in passing does not fire this — the intent
  has to be to chase down a cause.

## Phase 1 — Build a red-capable feedback loop (this IS the skill)

Before any hypothesis, produce a loop and run it once:

1. **Reach for the fast test tier first.** A targeted test is the cheapest loop
   substrate — `bun test <file>` (or the ecosystem's per-file selector) scoped to
   the failing behavior. If a red test does not exist yet, write the smallest one
   that reproduces the bug. Prefer extending the suite over an ad-hoc script: the
   loop you build is the regression test you keep.
2. **No red test possible?** Fall back to a single deterministic repro command
   whose exit code or output flips on the bug.
3. **You must have run it and SEEN it red.** A loop you have not watched fail is
   not a loop. Note the exact red signal (the assertion delta, the exit code, the
   wrong line of output) — that is your target.

**Intermittent / flaky first gets made deterministic.** A loop that only
sometimes goes red cannot falsify anything. Pin it before hypothesizing:

- Replace every fixed `Bun.sleep` / wall-clock wait with `retryUntil`-style
  polling (`test/helpers/retry-until.ts`) so timing jitter stops masking the bug.
- Run the loop N times to establish the failure rate, then narrow — seed, order,
  concurrency, a shared resource — until it fails on demand.

**If no loop can be built** — you cannot reproduce it, it needs an external
system you cannot reach, or it stays non-deterministic after an honest pinning
attempt — **stop. Do not guess.** Escalate per *Escalate, never ask* below with
the evidence you have (what you tried, the failure rate you observed, why it
would not pin).

## Phase 2 — Rank falsifiable hypotheses, test one at a time

With a red loop in hand:

1. **List candidate causes, ranked** by likelihood × cheapness-to-test. Write
   them down; do not carry them in your head.
2. **Make each one falsifiable** — state up front the observation that would kill
   it ("if it were the cache, clearing it would go green").
3. **Test ONE at a time against the loop.** Change one thing, re-run, read the
   signal. Never change two things at once — a green after a shotgun edit tells
   you nothing about which change mattered.
4. **A regression? Find when it entered.** keeper's event log answers who
   touched a file and what a past session did — bisect the suspect window before
   theorizing.

<!-- POINTER: keeper prompt render engineering/keeper-history-forensics -->

Keeper's read-only history subcommands turn "when did this regress" into a
query: `keeper find-file-history <path-fragment>` gives the sessions that
mutated a file most-recent-first, `keeper search-history <term>` finds the
prompt where a change was discussed, and `keeper session events
--session-id <id>` replays what that session actually did. Run `keeper prompt
render engineering/keeper-history-forensics` for the full recipe set.

## Phase 3 — Instrument with tagged probes, then remove them all

When you need visibility a test assertion cannot give, add temporary probes —
but tag every one with a unique token so cleanup is a single grep:

- Prefix each probe `[DEBUG-<token>]` (pick one token per hunt, e.g.
  `[DEBUG-a1b2]`), so `grep -rn "DEBUG-a1b2"` finds every one.
- **Before you commit, grep for the tag and expect zero hits.** A leftover
  `[DEBUG-*]` probe in a commit is a defect. Never ship instrumentation.

## Escalate, never ask (unattended adaptation)

You have no human to turn to. Every point where an interactive flow would ask,
you escalate with a typed `BLOCKED:` brief that carries the evidence you
gathered — the red signal, the hypotheses ruled out, and why you are stuck. That
is a decision-ready escalation, not a shrug. The canonical trigger is **"cannot
build a feedback loop"**; a dependency you cannot reach or a repro that needs an
external system are the same shape. Map the blocker to the worker's escalation
categories (`DEPENDENCY_BLOCKED`, `TOOLING_FAILURE`, `EXTERNAL_BLOCKED`, …) and
return the brief — do not commit a guess.

## What NOT to do

- **No hypothesis before a red loop.** Reasoning about causes without a loop that
  fails on demand is guessing.
- **No shotgun edits.** One change per re-run, or the loop cannot falsify.
- **No `sleep` to paper over a flake.** Poll with `retryUntil`; a timing patch
  hides the bug instead of finding it.
- **No leftover `[DEBUG-*]` probes** in a commit — grep them to zero first.
- **Never disable, skip, or weaken a test to make red go away.** If you cannot
  make the real assertion pass, escalate — a green you faked is worse than a red
  you understand.

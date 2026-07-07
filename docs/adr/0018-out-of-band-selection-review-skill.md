# 18. Out-of-band, human-invoked selection review

## Status

Accepted. Supersedes [ADR 11](0011-close-time-selection-review.md): selection
grading no longer runs at close time and leaves no board-visible record.

## Context

[ADR 11](0011-close-time-selection-review.md) put selection grading on the close
path: a dedicated auditor beat graded each executed cell at every epic close and
minted a clearable, display-only needs-human record when a cell graded
underpowered or overpowered. That bought a feedback surface before any outcome
record existed, at two costs now worth paying down.

First, grading is not a close-time concern. The latency-sensitive, content-blind
close path coupled grade durability to a beat that had to degrade instantly on any
failure, spending per-close on work whose value is entirely retrospective — the
verdict is only useful in aggregate, across many closed epics, read long after.

Second, the board-visible record was a persistent-nag surface that never blocked
work but always demanded a clear. It carried real machinery — a projection column,
a fold, a clear verb, status/readiness display members — for a signal that only
ever advised. The committed per-epic review file is the durable artifact worth
keeping; the live flag was scaffolding around it. The mechanical half stays: a
committed content-blind **selection-audit brief** per closed epic is cheap to
assemble and gives a later pass a stable, git-recoverable snapshot to grade.

## Decision

Selection grading moves off the close path into a human-invoked, out-of-band skill
(`/plan:cell-review`). The board-visible record — verb, epics projection column,
and every status/readiness/board display surface — is removed; historical events
still fold safely. `/plan:close` keeps only the mechanical capture: it commits the
per-epic audit brief (idempotent on re-close) and spawns no grading. Brief and
review are committed data-dir siblings, each write-once, `--force` to re-derive.

The skill drives one run end to end:

- **Work-list as a set difference.** The authoritative watermark is committed
  audit briefs minus committed reviews — never a `~/docs` file, never wall-clock.
  A committed review is its own high-water mark; a crash resumes from the
  difference (commit-then-advance).
- **Blinded venue-neutral grading.** A `plan:selection-auditor` grades each cell
  three-way from the brief's outcome record plus observable difficulty proxies
  (session length, tool calls, retries, blocks), blind to the selector's rationale
  and confidence.
- **Version-keyed verdicts.** Each review is stamped with `rubric_version`,
  `judge_model_version`, and `prompt_hash` beside the selection hashes, so a
  rubric, judge, or prompt change never masquerades as a policy shift; a version
  change re-grades with `--force`.
- **Honest cohort statistics.** Cohort rates key on `config_hash` with Wilson
  intervals and a hard minimum-cohort-count refusal below which nothing is
  proposed; confidence calibrates on quantile bins; every cross-policy-version
  comparison carries a Simpson's-trap caveat (the policy chose the cohort).
- **Advisory, never authoritative.** The skill writes human-facing reports under
  `~/docs/selection-reviews/` and *proposes* exact `model-selector.yaml` edits with
  drift-gate re-sync steps, then stops. `hand_tuned` and the drift-gated blocks are
  written only by a human or `/plan:model-guidance`.

The corpus is a prompt-injection surface: worker-generated brief/spec/forensic text
is delimited as data, and committed evidence is bounded to pointers.

Rejected: a lighter close-time flag (still couples grade durability to the close
path and re-adds a nag surface); a stored cursor or `~/docs` watermark (a set
difference over committed artifacts is self-healing); auto-applying edits (breaks
the human-ratification boundary); naive cross-version diffs (case-mix-confounded).

## Consequences

- The close path sheds an LLM-judge beat and a board signal; grading spend is paid
  once, on demand, in aggregate. The needs-human family loses its display-only
  member class; nothing on the board nags about a closed epic's cell selection.
- The durable dataset is unchanged in kind — one committed review file per graded
  epic, now version-keyed — produced out-of-band and re-derivable idempotently.
- Grade quality is no longer capped by close-time latency: the skill enriches from
  keeper.db forensics and stratifies judge spend toward the picks that matter.
- The loop is a proposal engine, not a policy writer; a graded dataset informs
  `model-selector.yaml` only through a human or `/plan:model-guidance` ratifying it.

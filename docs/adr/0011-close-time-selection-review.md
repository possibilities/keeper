# 11. Close-time selection review as a display-only needs-human record

## Status

Accepted.

## Context

The plan selector assigns each task a worker cell up front, guided by
hand-authored policy prose. Tuning that policy (sonnet-first, opus reserved
for intelligence-bound work) needs a feedback surface: were the picks right?
The long-run answer is empirical routing from recorded outcomes, but no
outcome record exists today, and any near-term audit has two hard
constraints — it must never hold back work (an advisory signal, not a gate),
and it must stay visible after the epic it grades has closed and left the
open board. The existing needs-human members either gate or vanish: parked
questions render only through the open-epic row, dispatch-failure stickies
couple clearing to the retry RPC, and everything counted into the needs-human
total feeds the board's jam computation. LLM-judge prior art adds two
calibration constraints: coarse categorical verdicts beat fine scores, and a
judge grading its own model family's picks systematically blesses them unless
grounded in objective outcome signals.

## Decision

A selection review is minted at epic close by a dedicated auditor beat that
runs after the quality audit and degrades instantly on any failure — it never
blocks the close. The auditor grades each genuinely selected-and-executed
task cell on a three-way categorical (underpowered, right-sized, overpowered),
grounded in the assembled objective record — spec, assigned cell, selection
rationale, per-task diff stats, done summary, runtime signals — and abstains
toward right-sized when signals are thin. Verdicts persist in a committed
per-epic review file, the durable dataset future empirical routing consumes;
each verdict snapshots the graded cell and the selection hashes so later
re-selections cannot orphan the verdict-to-cell join. The file is written
once per epic — a re-run close skips an existing review rather than
resurrecting a cleared flag or double-counting the dataset; only an explicit
force replaces it.

The live signal is separate from the dataset: a non-right-sized verdict sets
a clearable per-epic flag riding the plan-CLI state-overlay path (never a new
RPC), folded onto an epics projection column. It surfaces as a new
needs-human class that is display-only — counted and rendered by status and
the board's needs-human block regardless of the epic's open/closed status,
contributing zero to the needs-human total and the jam computation. The only
clear is the operator's clear verb. A fully right-sized epic writes the
dataset file but raises no flag.

Rejected: extending the quality auditor (a code-quality lens; conflating it
with provisioning grades muddies both verdicts); appending outcomes to the
selection sidecar (its replace-on-reselect contract would erase audit
history); counting the flag into the needs-human total (flips healthy boards
to jammed, violating the never-hold-back-work constraint); fine-grained audit
scores (manufactured precision LLM judges cannot support).

## Consequences

- The board can nag on a closed epic until an operator clears the review —
  deliberate: the record outlives the work it grades.
- The dataset accumulates one committed file per closed epic, joinable to
  selection sidecars by hash — the substrate for data-driven routing later.
- The needs-human family gains a display-only member class; the status schema
  encodes that it never contributes to the jam total.
- Grade quality is capped by the assemblable signal set at close time;
  verdicts lean right-sized when evidence is thin rather than guessing.
- The judge runs same-family (an opus-driven audit of claude picks) with
  signal-grounding as the bias mitigation; a cross-harness judge is a
  possible future once wrapped cells are routine.

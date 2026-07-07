## Overview

Invert the model selector's default: sonnet is the implementation workhorse, opus is the
big guns — chosen only on a nameable intelligence-bound reason — and mechanical work biases
toward lower efforts. The policy lives in a new human-owned hand-tuned section of the
selector config. Close the loop with a close-time selection review: a dedicated auditor
grades each executed cell underpowered / right-sized / overpowered, verdicts persist as a
committed per-epic dataset (the substrate for future empirical routing), and misfits raise
a clearable, display-only needs-human flag that never blocks or jams anything.
Decision record: docs/adr/0011.

## Quick commands

- keeper plan selection-brief <epic>   # brief carries the hand_tuned policy verbatim
- keeper plan selection-review <epic> --clear
- keeper status | jq .data.needs_human
- bun test && (cd plugins/plan && bun test)

## Acceptance

- [ ] A selection run under the new policy defaults to sonnet absent a named
      intelligence-bound reason, observable in the next planned epic's verdict rationales.
- [ ] Closing an epic with misfit cells leaves a committed review file plus a
      board-visible clearable flag, and no audit failure mode can delay or block the close.
- [ ] The review flag counts in needs_human as its own display-only class, contributes
      zero to total/jammed, survives the epic closing, and clears with one verb.
- [ ] Review verdicts snapshot the graded cell and selection hashes so they join to
      selection sidecars across future re-selects.

## Early proof point

Task that proves the approach: ordinal 1 (the policy rewrite). It is cheap and immediately
observable on the next selection; if the inversion fails to shift picks, revisit the
hand-tuned wording before building the audit loop.

## References

- docs/adr/0011-close-time-selection-review.md — the audit-record mechanism and rejected alternatives
- docs/adr/0010-host-provider-matrix-and-wrapped-worker-cells.md — why the selector policy is deliberately cheap-to-change config
- CONTEXT.md — Selection review entry; Needs-human family amended with display-only members
- `fn-1149` (overlap) — its task 6 rewrites the same selector surface (model-selector.yaml,
  selection_brief.ts, model-guidance-check.ts); competing rewrites, sequenced by the epic dep.
- `fn-1146` (overlap) — both epics add to the src/db.ts schema surface.
- Practice notes: same-family LLM judges wrongly bless their own family's outputs (~50%
  more likely) — ground verdicts in objective signals; coarse 3-way verdicts beat scores;
  burden-of-proof framing is what actually shifts a selector's default; sonnet delivers
  roughly 95-98% of opus coding quality at 40-80% lower cost, with the gap widening on
  multi-file architectural refactors — exactly the opus rubric axis.

## Docs gaps

- **plugins/plan/skills/model-guidance/SKILL.md**: hand_tuned section ownership semantics (task 1)
- **plugins/plan/README.md**: selector section — sonnet-first default + selection-review lifecycle (task 6)
- **docs/problem-codes.md**: rows for the new verb codes (task 6)

## Best practices

- **Burden-of-proof + anti-anchor clauses** are the levers that shift an LLM selector's
  default; forbid spec length and difficulty adjectives as difficulty proxies. [practice-scout]
- **Ground the judge in the outcome record**, never its own read of the diff; abstain
  toward right-sized on thin signals. [practice-scout]
- **Coarse 3-way verdicts only** — fine scales manufacture false precision. [practice-scout]
- **A different-family judge is the stronger bias mitigation** — future option once wrapped
  cells are routine. [practice-scout]

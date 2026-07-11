## Overview

The tier-2 escalation for a work fan-in merge conflict is non-functional: the
daemon dispatches a `deconflict::<taskId>` session, but the consuming CLI
(`keeper escalation-brief`) and the `deconflict` skill were never extended past
their epic-only framing, so the session cannot load its brief and declines on
arrival. This follow-up teaches the escalation-brief CLI and the deconflict skill
to accept a task-form ref and look up the sticky row across `verb IN ('close','work')`,
then locks the daemon-to-skill contract behind an end-to-end test. It degrades
safely today (the human is still paged on the terminal decline), so this is a
correctness fix, not a wedge repair.

## Acceptance

- [ ] `keeper escalation-brief deconflict::<taskId>` returns an `ok` brief for a sticky work-verb merge-conflict row (not `unparseable_key`).
- [ ] The `deconflict` skill reads correctly whether it boots on a `deconflict::<epic>` or a `deconflict::<taskId>` ref, and its retry step targets the matching `close::<epic>` / `work::<taskId>` verb.
- [ ] A test drives the full daemon-dispatched `deconflict::<taskId>` → `keeper escalation-brief` handoff and asserts a parseable brief.
- [ ] Close-verb `deconflict::<epic>` behavior is byte-unchanged.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | dispatchWorkDeconflict fires /plan:deconflict <taskId> but parseEscalationKey rejects task-form deconflict refs and buildDeconflictIncident filters verb='close'; the CLI/skill were never extended, so stage-2 is dead-on-arrival. |
| F2 | culled | — | cwd = row.dir ?? "" is unreached (dir always defaults to the lane path); theoretical defensive edge mirroring the close convention. |
| F3 | culled | — | New // fn-1240 comment tokens follow daemon.ts's pervasive pre-existing fn-id anchor convention; cosmetic-only, rule #0 unenforced on comments. |
| F3 kept-note | — | — | (see F3 row above) |
| F4 | merged-into-F1 | .1 | F4 (no test for escalation-brief deconflict::<taskId>) is the exact seam that hides F1; F1's fix ships this test. |
| F5 | merged-into-F1 | .1 | F5 (untested daemon-to-skill handoff) shares F1's root cause — the CLI/skill contract was never extended — so it folds into F1. |

## Out of scope

- The `cwd = row.dir ?? ""` null-dir defensive edge (F2, culled — unreached in practice).
- Dropping `// fn-1240` provenance tokens from daemon.ts comments (F3, culled — a tree-wide rule #0 reconciliation, not this diff).

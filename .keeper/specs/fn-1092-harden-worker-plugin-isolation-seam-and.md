## Overview

The arthack-dissolution epic shipped a live worker plugin-isolation gate and
keeper-owned worker permission posture, but two items survived audit: the
config-knob-AND-flag seam in `main()` that decides `stripScanDirs` is never
driven end-to-end (only bypassed with an explicit boolean in tests), and a
batch of new comments carry past-tense provenance back-references that
CLAUDE.md rule #0 bans. Both matter because the gate is flipped ON on the real
machine, so a silent seam no-op would defeat the isolation the operator turned
on, and the dangling back-references only rot with age.

## Acceptance

- [ ] The real `main()` arg vector is driven through the `stripScanDirs` seam, asserting scan dirs are stripped for a worker argv and retained for an interactive one.
- [ ] Provenance back-references (task ordinals, study-row citations) are rewritten to forward-facing invariants across the three cited files.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | `main.ts:2220` `stripScanDirs` AND-gate never driven end-to-end; `plugin-composition-map.test.ts:133/182` bypasses it via an explicit `{stripScanDirs}` boolean, and the gate is live (flipped ON, task .4). |
| F2 | culled | —  | Linchpin is Claude Code harness semantics (hooks fire under `--dangerously-skip-permissions`) we do not own and are confident about; pair path already lands branch-guard denies under the flag in production. No code defect. |
| F3 | kept   | .2 | CLAUDE.md rule #0 violation: past-tense provenance back-references at `main.ts:2213`, `plugin-composition-map.test.ts:171`, `vendored-corpus.test.ts:11-13/171-173` are unresolvable dangling refs. |
| F4 | culled | —  | Pair-partner isolation under gate-ON is intentional and consistent (keyed on keeper-automated); merely unpinned. Theoretical test-gap with no defect. |

## Out of scope

- Verifying hook deny-envelope enforcement under `--dangerously-skip-permissions` (F2) — Claude Code harness semantics we do not own; an out-of-band operator confirmation at most, not a code change.
- Pinning pair-partner isolation behavior under gate-ON (F4) — intentional/consistent, deferred.

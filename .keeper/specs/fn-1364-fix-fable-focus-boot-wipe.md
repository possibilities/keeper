## Overview

The durable Fable focus policy (`autopilot_state.fable_focus`) is nulled on every keeperd boot, so a policy set with an absolute deadline silently vanishes on the next restart or crash-respawn. This violates fn-1359's "policy survives restarts" acceptance criterion and the event-sourcing invariant that a deterministic-replayed projection column is mutated only by a fold. The end state: a populated policy survives a boot cycle intact (column + published leaf), the fix keeps every `autopilot_state` write fold-sole-writer-compliant, and a forward guard prevents any future table rebuild from silently dropping a column.

## Quick commands

- `bun test ./test/reducer-projections.test.ts ./test/refold-equivalence.test.ts ./test/db.test.ts`
- `keeper agent accounts fable-focus set claude-swap:2 absolute 2026-07-20T23:59:59Z --json && keeper daemon restart && keeper agent accounts fable-focus show --json`  # operator post-deploy proof: state must remain `active`

## Acceptance

- [ ] A populated `fable_focus` policy survives a simulated boot cycle (the pure reopen/re-fold seam, no real daemon) — both the durable column and the published leaf retain the policy.
- [ ] The exact boot-path write that nulls the column is identified and corrected so `autopilot_state` column mutations remain fold-sourced (or, if a rebuild/rewrite path is the cause, it preserves every column it does not explicitly own).
- [ ] A forward guard fails loudly if any `autopilot_state` rebuild copy-list omits a column present in the table schema.

## Early proof point

Task that proves the approach: `.1` — a red regression test reproducing the wipe through the pure seam, before any fix. If it can't be made red through the pure seam, the wipe is boot-path-only (not re-fold) and the task pivots to instrumenting the live boot write directly.

## References

- `docs/adr/0092-durable-fable-focus-routing.md` — governing decision; asserts durable intent remains inspectable across restarts. The fix conforms to it (no supersession).
- Operator instrumentation (this session, live repro DB): schema v136, `fable_focus` column present, NO `codex_adoption` column (so the v129 rebuild does NOT fire), reducer cursor resumes from a high persisted value (NOT a re-fold from 0). Both static theories are ruled out against the real DB — the exact writer needs live boot-path instrumentation.
- Overlap flags (no dep edge — surfaces disjoint, escalation ghosts un-validated behind a review gate): fn-1349/fn-1350/fn-1351/fn-1352 co-edit `src/daemon.ts` + `test/daemon.test.ts`; different regions.

## Docs gaps

- None. `docs/install.md` and ADR 0092 already describe the intended post-fix behavior (fix makes reality match the docs); no prose change is a deliverable.

## Best practices

- **Column-scoped writes over full-row REPLACE:** a read-modify-write config row should `UPDATE`/UPSERT only owned columns (`ON CONFLICT DO UPDATE SET`), so a newly-migrated column is preserved by construction — never `INSERT OR REPLACE` (DELETE+INSERT nulls unlisted columns).
- **Regression test must seed a non-default value:** the golden `fable_focus` must differ from BOTH the column default AND NULL, or a full-row-REPLACE bug passes silently on the null-to-default coincidence.
- **Schema-completeness assertion:** introspect the table's columns and assert any writer/rebuild copy-list ⊇ the table's column set, so the next forgotten column fails at the test, not in production.

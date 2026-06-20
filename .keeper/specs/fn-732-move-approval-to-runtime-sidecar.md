## Overview

Move planctl `approval` out of git-tracked def files into gitignored runtime
sidecars so keeper folds it gate-free (eliminating the approve-fold lag). The
DESTINATION design is unchanged and sound; this epic is RE-DECOMPOSED after a
failed first attempt that landed task-by-task and **black-holed approvals**
(planctl stopped writing the def file before keeper could read the sidecar,
and keeper had no fallback → approval stuck `pending` → autopilot re-approved
infinitely → unusable; reverted as planctl 34510d1).

## Landing strategy — Parallel Change (expand/contract), reader-first

Safe ordering for a writer (planctl, editable install, instant) and a reader
(keeperd, long-running daemon, needs restart) that must agree at EVERY commit.
Deps enforce `.3 → .1 → .2 → .4`:

1. **Expand reader FIRST (`.3`, keeper):** fold approval via a PERMANENT
   ladder sidecar → committed def → pending. No sidecars yet → falls through
   to def → behavior unchanged → safe to deploy first. Restart keeperd +
   confirm live. The def-fallback is the safety net that makes deploy order
   non-fragile — never remove it.
2. **Expand writer (`.1`, planctl):** DUAL-WRITE approval to sidecar AND the
   committed def (approve keeps auto-committing). Not-yet-restarted keeper
   reads def; restarted keeper reads sidecar. No keeper is ever starved.
3. **Backfill + contract (`.2`, planctl):** idempotent backfill seeds
   sidecars; THEN — gated on a positive end-to-end verify that keeper folds
   approval from the sidecar, in a quiesced window — planctl stops
   writing/committing def approval and strips it. The only irreversible step,
   LAST.
4. **Cleanup (`.4`, keeper):** remove the now-dead approval kick. Keep the
   def-fallback ladder permanently.

**Invariant (the test):** stop after ANY single task and run forever —
approval still resolves in both repos. No commit may black-hole approval.

## Quick commands

- `cd ~/code/planctl && uv run pytest tests/test_run_approve.py tests/test_models.py -q`
- `cd ~/code/keeper && bun test test/plan-worker.test.ts test/plan-classifier.test.ts test/rpc-handlers.test.ts`
- Verify gate (before `.2` contract): approve a done task, confirm keeper folds `approval=approved` from the sidecar within ~1s.

## Acceptance

- [ ] Every intermediate commit leaves approval resolvable in BOTH repos (no black-hole)
- [ ] keeper read-side (ladder + restart + live-verify) lands before planctl drops the def write
- [ ] planctl dual-writes during transition; def write removed only after the verify gate
- [ ] backfill idempotent; def-strip + def-write-removal is the last gated step
- [ ] keeper def-fallback retained permanently; both suites green; re-fold byte-identical

## Early proof point

Task `.3` (keeper expand-reader): folds approval gate-free from the sidecar
AND falls back to the committed def when no sidecar exists. If the
`.state.json` shape isn't foldable as assumed, fall back to a keeperd RPC kick
on approve rather than the sidecar watch.

## References

- Reverted first attempt: planctl `07a52e0` → revert `34510d1`. Failure mode: writer switched before reader could read, no fallback.
- Parallel Change / expand-contract: reader-supports-both before writer-switches; resolution ladder removes deploy-order fragility; contract is last + gated on positive verify; backfill idempotent; dual-write during transition. [Fowler ParallelChange; LaunchDarkly; PlanetScale]
- keeperd needs RESTART to pick up code; planctl (editable) is instant → reader-first + permanent fallback mandatory.
- precedents: keeper `task-state` fold arm (src/plan-worker.ts); planctl scripts/migrate_acks_to_state.py + acks.py.
- **fn-734** depends on this epic and is stale — re-plan AFTER this lands; out of scope here.
- NOTE: task titles below are stale from the prior decomposition; the SPECS are authoritative for each task's current role.

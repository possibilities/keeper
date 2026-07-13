## Description

Fixes finding F2 (evidence: `f099b4d7:src/pair/panel.ts`, `panelCancel`). In the
bounded cleanup pass, when `ownedLivePid(target)` is null and the target's pidfile
never becomes readable (`readPid(...) === null`) for a launched member
(`launched_at !== null`), the loop only defers while `deps.now() < deadline`; past
the deadline it falls to `target.attempt.state = "cancelled"`, and the post-loop
sweep escalates to `cleanup_failed` only when `ownedLivePid(target) !== null`. So a
launched member whose pidfile never materializes within the cleanup window is
reported torn-down-clean even though a live, never-signalled child may exist.

Classify that case (launched, pidfile never readable by the deadline, liveness
unknowable) as `cleanup_failed`/unresolved instead of `cancelled` — fail toward
"unresolved" when liveness is unknowable, matching the fail-open,
loud-reporting intent of the rest of the pass (`legIdentityHolds` already reasons
"a false 'alive' only extends a bounded wait").

Files: `src/pair/panel.ts` (panelCancel cleanup pass), plus test coverage.

## Acceptance

- [ ] A launched member whose pidfile never becomes readable by the cancel deadline lands in `unresolved_cleanup` with `state="cleanup_failed"` and a non-zero exit.
- [ ] Members that are genuinely gone (readable dead/recycled pid) still report `cancelled` (exit 0) — no regression on the clean-teardown path.
- [ ] A new regression test drives the pidfile-not-yet-present-at-cancel race (do not seed the pidfile before cancelling), asserting the unresolved classification.

## Done summary

## Evidence

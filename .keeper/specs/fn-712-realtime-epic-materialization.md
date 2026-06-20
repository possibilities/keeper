## Overview

A freshly-scaffolded keeper epic currently shows on `keeper board` as a
raw-id "shell row" (`[blocked:epic-not-validated]`, no title, no tasks)
for ~74 seconds before its real `EpicSnapshot`/`TaskSnapshot` projections
fold in. Two independent defects cause it: (A) the plan-worker's
`recheckPending()` synchronously spawns `git cat-file` for every path in a
cross-repo `pending` set (~1292 abandoned `.planctl` files), starving the
single-threaded worker's message loop so the authoritative realtime
`planctl-commit-changed` bypass (fn-681) queues behind it for tens of
seconds; and (B) the shell row is surfaced by the board (`default_visible`
is 1 for a NULL-status row) with no shared notion of "this epic isn't real
yet". End state: a scaffolded epic materializes in milliseconds and appears
fully-formed on the board AND becomes autopilot-eligible at the same
instant, gated by one shared `status IS NOT NULL` ("EpicSnapshot folded")
predicate — never a raw-id flicker, never a partial-projection dispatch.

## Quick commands

- `bun test test/plan-worker.test.ts` — Part A: scoped + batched recheck, fail-closed batch probe
- `bun test test/db.test.ts test/readiness.test.ts test/autopilot-worker.test.ts test/schema-version.test.ts` — Part B: materialized gate end to end
- Manual: scaffold a throwaway epic in a tmp planctl dir, watch `keeper board` — it appears fully-formed within a second, never as a raw-id stub

## Acceptance

- [ ] A scaffold commit's `EpicSnapshot` folds in well under a second (no full-pending-set synchronous git storm); the ~74s window is gone
- [ ] One shared predicate `status IS NOT NULL` gates both surfaces: the board hides a NULL-status shell row, and the autopilot reconciler refuses to dispatch a worker OR a closer against it
- [ ] Once the `EpicSnapshot` folds (status set), the epic appears on the board and becomes autopilot-eligible at the same instant
- [ ] `SCHEMA_VERSION` and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` move in lockstep in one commit; all touched test files green
- [ ] Re-fold determinism preserved (no reducer/event-log change; `default_visible` is a VIRTUAL column, `epic-not-materialized` is a read-time verdict)

## Early proof point

Task that proves the approach: Part A (task `.1`) — measure `EpicSnapshot`
emission latency after a scaffold commit. If batching+scoping doesn't
collapse it to sub-second: fall back to keeping `recheckPending` global but
batched-per-repo (one `git cat-file --batch-check` per repo), which still
kills the per-path storm.

## References

- Lineage: fn-681 (`planctl-commit-changed` realtime bypass), fn-629 (in-HEAD observation gate), fn-705 (data_version poll + reflog watch), fn-700 (`epic-no-tasks` close-row gate), fn-695 (commit-trailer `syncPlanctlLinks` that mints the shell row), fn-688 (epic tombstones)
- status is set to non-null at exactly ONE reducer site — the EpicSnapshot UPSERT (src/reducer.ts:802/808); all four shell-INSERTs write NULL, so `status IS NOT NULL` is an exact "materialized" discriminator
- Overlap (advisory, wired as epic deps to serialize): **fn-710** also bumps `SCHEMA_VERSION` (src/db.ts) and edits src/daemon.ts (kick-worker wiring); **fn-711** edits src/autopilot-worker.ts. Whichever lands second reconciles the version increments.

## Docs gaps

- **README.md**: rewrite the plan-worker / recheckPending block (per-file `cat-file` + FOUR-trigger enumeration → batched-per-repo + repo-scoped recheck); revise the `default_visible` predicate prose + the runnable SQL comment block; add a schema vN changelog paragraph; update the autopilot `epic-no-tasks` gate paragraph to name `epic-not-materialized` as the new earliest guard
- **CLAUDE.md**: revise the fn-629 "won't dispatch against an uncommitted epic" bullet (batched probe + scoped recheck), the `data_version` poll carve-out (scoped, no longer global recheck), and the fn-700 bullet (epic-not-materialized now ranks ahead of epic-not-validated)
- **keeper/api.py**: add the bumped schema version to `SUPPORTED_SCHEMA_VERSIONS`

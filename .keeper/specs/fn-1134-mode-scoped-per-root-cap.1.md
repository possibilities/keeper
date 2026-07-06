## Description

**Size:** M
**Files:** src/db.ts, src/rpc-handlers.ts, src/daemon.ts, src/readiness-inputs.ts, src/server-worker.ts, src/protocol.ts, test/rpc-handlers.test.ts, test/reducer-projections.test.ts, test/readiness.test.ts, test/db.test.ts

### Approach

Export one pure helper `effectivePerRootCap(stored: unknown, worktreeOn: boolean): number` from src/db.ts beside `DEFAULT_MAX_CONCURRENT_PER_ROOT`: worktree off → 1 always; worktree on → stored when it is a positive integer, else the default (1). Fail closed on every malformed shape (null, 0, negative, non-integer, absent); no upper clamp — the ceiling stays unbounded as today. This helper is the single derivation seam; no consumer re-interprets the raw column inline.

Delete `enforceWorktreeConcurrencyInvariant` entirely — function, doc block, export — keeping only the positive-int-or-null shape validation in the params validator. Delete the daemon call site: the pre-mint `worktree_mode` SELECT and the coerce/reject; mint the validated patch verbatim. The reducer fold already preserves untouched columns, so a worktree-only patch leaves stored intent intact — no fold or schema change, no SCHEMA_VERSION bump.

Derive at the two producer-side consumption seams: (1) `loadReadinessInputs` computes `maxConcurrentPerRoot` through the helper — the `autopilot_state` row it already reads carries `worktree_mode`, so no extra query; this covers the reconciler AND the autoclose worker, which loads the same inputs. (2) The boot-status publication derives the effective value: the per-column SELECT must gain `worktree_mode` (if missed, the derivation sees an absent column and silently publishes 1 forever — this gets an explicit test). The wire field `max_concurrent_per_root` keeps meaning "the cap dispatch uses" (effective) — meaning-stable for old clients; stored does NOT cross the wire. Update the BootStatus doc comment to state the effective semantics.

When a patch sets `max_concurrent_per_root` while worktree mode is (and remains) off, the success envelope carries a note stating the value is stored and the effective cap stays 1 until worktree mode turns on — main knows the folded mode at reply time; thread it through the result message.

Comments are forward-facing only: state the stored-vs-effective contract as it now is, no history, no plan ids.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/rpc-handlers.ts:452-513 — the invariant to delete; :403-416 the shape check to keep
- src/daemon.ts:4532-4544 — call site: pre-mint worktree_mode read + coerce/reject to delete
- src/readiness-inputs.ts:137-146 — raw read to route through the helper; worktree_mode is in the same row
- src/server-worker.ts:2078-2091 — boot publication; the SELECT at :2082 currently omits worktree_mode
- src/db.ts:259 — DEFAULT_MAX_CONCURRENT_PER_ROOT; the helper's home (db.ts is imported by both src/ and cli/)

**Optional** (reference as needed):
- src/reducer.ts:4942-4952 — fold parse; verify it preserves stored intent untouched (expected no-op)
- src/protocol.ts:115-119 — BootStatus field doc to restate as effective
- src/autoclose-worker.ts:456-469 — consumes loadReadinessInputs; verify no direct column read
- test/rpc-handlers.test.ts:421-468 — existing shape-validation tests to keep; :547-593 + import at :27 — invariant tests to replace
- src/server-worker.ts:258, :1478, :3486 — wire-type field sites; comments may need the effective wording

### Risks

- A dispatch-side consumer outside loadReadinessInputs / boot-status that reads the column raw would bypass the derivation — re-sweep `max_concurrent_per_root` consumers under src/ before finishing.
- Workers already in flight when worktree flips off are not killed by the cap change — pre-existing behavior under the old coerce too, not a regression; do not add mid-flight enforcement.

### Test notes

Helper unit tests (worktree on + 5 → 5; off + 5 → 1; on + each of null/0/-1/1.5/absent → 1). Toggle round-trip at the readiness-inputs seam: set 3, flip worktree off (inputs see 1), flip on (inputs see 3 — restored, never re-set). Set-while-off is now accepted end-to-end and the note rides the envelope (invert the deleted reject test). Boot-status publishes effective (off + stored 3 → 1) — the test that catches the SELECT omission. Pure in-process per repo rules: freshMemDb()/freshDbFile() over migrate(), sandboxEnv for state, retryUntil never Bun.sleep. Locate the suite that exercises the boot-status builder (test/readiness.test.ts or test/daemon.test.ts) rather than adding a new harness.

## Acceptance

- [ ] A pure shared helper derives the effective per-root cap: worktree on passes a positive-integer stored value through; worktree off, and every malformed/absent stored shape, derive to 1; unit-tested for all branches
- [ ] `set_autopilot_config` accepts `max_concurrent_per_root` > 1 while worktree mode is off, persists it unmodified, and the success envelope notes stored-with-effective-1 semantics
- [ ] Flipping worktree mode off no longer mutates the stored cap; a subsequent flip on restores the prior effective cap with no re-set
- [ ] The reconciler readiness inputs and the boot-status publication both carry the derived effective value (worktree off + stored 3 → both report 1; on → both report 3)
- [ ] The write-time invariant function no longer exists anywhere in the codebase and no test imports it
- [ ] `bun test` fast tier green

## Done summary

## Evidence

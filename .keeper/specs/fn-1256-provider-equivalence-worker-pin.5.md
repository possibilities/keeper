## Description

**Size:** S
**Files:** plugins/plan/src/verbs/claim.ts, plugins/plan/src/models.ts, plugins/plan/test/saga-claim.test.ts

### Approach

The claim verb captures the dispatch-injected effective cell into `.keeper` task runtime
metadata. Contract (shared with the dispatch seam, pinned here so the tasks can land in
either order): env `KEEPER_PLAN_DISPATCHED_MODEL` / `KEEPER_PLAN_DISPATCHED_TIER` /
`KEEPER_PLAN_DISPATCH_CONSTRAINT` are always emitted by launchers — non-empty exactly when
a provider constraint translated the cell. At claim: non-empty ⇒ write runtime keys
`dispatched_model`, `dispatched_tier`, `dispatch_constraint`; empty or absent ⇒ delete any
stale values (a pin-cleared re-claim must not lie). Last-write-wins per task; the definition
cells (`task.model`/`task.tier`) and the selection sidecar are never touched. Verify
normalize/merge preserves the new runtime keys through mergeTaskState round-trips so read
verbs surface them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/claim.ts:189-208 (assigned-cell read + CELL_UNASSIGNED gate), :305-350 (newState runtime keys, withTaskLock CAS, saveRuntime, ALREADY_MINE preservation)
- plugins/plan/src/models.ts:73-97 — normalizeTask defaults + mergeTaskState overlay semantics (confirm unknown runtime keys survive)

**Optional** (reference as needed):
- plugins/plan/CLAUDE.md environment-variables table — the KEEPER_PLAN_* env conventions this contract joins
- plugins/plan/src/verbs/resolve_task.ts or task read verbs — where merged runtime state surfaces

### Risks

- normalizeTask may strip unknown keys — if so, add the three fields to the normalization spine rather than special-casing claim
- Respect the no-incremental-mutation stance: these are lifecycle metadata like claimed_at, written only by claim's existing runtime path — no new verb, nothing resurrected

### Test notes

In-process saga tests: claim with constraint env writes all three keys; re-claim with empty
env clears them; definition cells byte-identical throughout; merged reads surface the keys.

## Acceptance

- [ ] A claim under non-empty constraint env lands the three runtime keys in `.keeper` (auto-committed) and a subsequent unconstrained claim removes them
- [ ] `task.model`/`task.tier` and the selection sidecar are byte-identical across constrained and unconstrained claims
- [ ] Merged task reads surface dispatched_* keys; plan fast suite green

## Done summary
claim reads KEEPER_PLAN_DISPATCHED_MODEL/TIER/CONSTRAINT and lands dispatched_model/dispatched_tier/dispatch_constraint in the runtime sidecar when non-empty; an unconstrained claim clears stale values via saveRuntime's full-overwrite semantics. task.model/task.tier and the selection sidecar untouched; merged reads surface the keys via mergeTaskState's unknown-key pass-through.
## Evidence

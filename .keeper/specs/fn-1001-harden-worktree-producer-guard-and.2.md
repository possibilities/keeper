## Description

**Size:** S
**Files:** plugins/plan/src/verbs/close_finalize.ts, plugins/plan/test/*

### Approach

In `close_finalize.ts`, the mutations are correctly primary-rooted via
`stateCtx = contextForRoot(primaryRepo)` (~:445, used at :529/:540/:567-568), but three
READS still use the cwd `ctx`: `findFollowupEpic(ctx.dataDir, …)` (:450 and :537) and
`loadTasksForEpic(ctx, …)` (:482). Switch those three to `stateCtx` so reads and writes
agree on the primary repo — matching the sibling `close_preflight.ts:139`
(`loadTasksForEpic(stateCtx, …)`). This closes the idempotency / followup-adoption
mis-report that would occur if `close-finalize` ever ran from a lane cwd without
`--project` (reads lane `.keeper`, writes primary). Pure, behavior-preserving on the
live `--project` path (where ctx==stateCtx already); the change only makes the
no-`--project`-from-a-lane case correct too.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/close_finalize.ts:445 (stateCtx construction), :450 + :537 (findFollowupEpic reads on ctx), :482 (loadTasksForEpic on ctx), :529/:540/:567-568 (the writes already on stateCtx)
- plugins/plan/src/verbs/close_preflight.ts:139 (the consistent sibling read on stateCtx)
- plugins/plan/test/worktree-close-state.test.ts (the lane-simulation harness; add a finalize-from-lane-without-project read assertion)

### Risks

- Behavior-preserving on the live path (ctx==stateCtx when --project is passed); verify the close skill's --project path is unchanged.
- Do NOT alter the write sites or the resolveFinalizeProject/--project logic — only the three reads.

### Test notes

Pure tier: a finalize idempotency / followup-adoption check from a lane cwd without --project reads tasks + followup from PRIMARY (not the lane), matching writes. Confirm the --project path (ctx==stateCtx) is unchanged.

## Acceptance

- [ ] close_finalize.ts:450/482/537 reads use stateCtx (primary-rooted), consistent with close_preflight
- [ ] live --project path unchanged (ctx==stateCtx); writes untouched
- [ ] pure test: finalize-from-lane-without-project reads primary; gate green

## Done summary
Switched close-finalize's three idempotency/followup-adoption reads (findFollowupEpic x2, loadTasksForEpic) from cwd ctx to primary-rooted stateCtx, matching its writes and close-preflight; added a lane-cwd followup-adoption test.
## Evidence

## Description

**Size:** M
**Files:** src/db.ts, src/types.ts, src/reducer.ts, keeper/api.py, test/daemon.test.ts

### Approach

Both escalation paths gain a third, terminal stage — "human notified" — with once-only semantics that survive re-folds and row re-failures. `dispatch_failures` grows a `human_notified_at REAL` once-marker (sibling of `merge_escalated_at` / `resolver_dispatched_at`, same discipline: independent columns, never conflated, re-armed only when `retry_dispatch` drops the row). The block-escalation latch gains staged outcomes: an escalation-dispatch attempt records a terminal `dispatched` (or a non-terminal `dispatch_failed` that leaves the row pending for re-sweep), and a terminal human-notify carries its own once-marker so a decline/death of the unblock session notifies the human exactly once. New/extended event payloads mirror `ResolverDispatchAttempted`: an escalation-dispatch-attempt event per path and a human-notified event per path; folds stay deterministic, never throw, and malformed `data` folds to safe values with the cursor advancing. Forward-only migration bumps SCHEMA_VERSION, with the new version added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the same commit.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:50 — SCHEMA_VERSION; src/db.ts:5753 (merge_escalated_at) and src/db.ts:5896 (resolver_dispatched_at) — the migration shape to mirror
- src/reducer.ts:4003-4016 — dispatch_failures UPSERT preserve-list: the new marker MUST join the INSERT column list AND stay excluded from the SET clause, or a re-failure resets it and re-fires the escalation
- src/reducer.ts:77 — ResolverDispatchAttempted fold; src/reducer.ts:804-825 — block_escalations latch arm/clear
- src/types.ts:1176 — ResolverDispatchAttempted payload shape
- keeper/api.py — SUPPORTED_SCHEMA_VERSIONS whitelist (test/schema-version.test.ts enforces the same-commit rule)

**Optional** (reference as needed):
- test/daemon.test.ts:3770 — selectPending* test idiom against freshMemDb with hand-inserted rows

### Risks

- Missing the UPSERT preserve-list edit silently re-dispatches escalations on row re-failure — the highest-severity defect available here.
- block_escalations is fold-managed and deterministic-replayed: new columns/statuses must fold from event `ts`, never wall-clock.

### Test notes

freshMemDb over a full migrate(); fold the new events and assert marker stamping, marker survival through a re-emitted DispatchFailed for the same key, DispatchCleared re-arm, and malformed-payload safe folds.

## Acceptance

- [ ] dispatch_failures carries an independent human-notify once-marker that survives row re-failure and is dropped only by retry_dispatch clears
- [ ] The block-escalation latch supports staged outcomes: a terminal dispatched, a non-terminal dispatch-failed that re-sweeps, and a human-notified once-marker
- [ ] New event payloads fold deterministically; malformed data folds to safe values and the cursor advances
- [ ] SCHEMA_VERSION is bumped with a forward-only migration and keeper/api.py SUPPORTED_SCHEMA_VERSIONS is updated in the same commit; fast suite green

## Done summary
Added the human-notify once-marker substrate for both escalation paths: v109→v110 adds nullable human_notified_at to dispatch_failures (deconflict) and block_escalations (unblock), with MergeHumanNotified/BlockHumanNotified folds, staged dispatched/dispatch_failed block-latch outcomes, UPSERT preservation, and SUPPORTED_SCHEMA_VERSIONS += 110.
## Evidence

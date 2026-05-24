## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

### Approach

Add `syncPlanctlLinks(db, sessionId, eventId, ts)` to `src/reducer.ts` as
a parallel helper to `syncJobIntoEpic` (NOT grafted into it — triggers
are disjoint: jobs-write trigger vs planctl-event trigger).

The helper:
1. SELECT `(id, ts, hook_event, slash_command, skill_name, planctl_op, planctl_target, planctl_epic_id, planctl_task_id, planctl_subject_present)` from `events WHERE session_id = ? ORDER BY id ASC`.
2. Filter window openers to `hook_event = 'PreToolUse' AND skill_name = 'plan:plan'` rows only (per locked decision — slash_command rows would double-fire).
3. Compute half-open windows via `computePlanWindows` from task .2.
4. Compute the new `epic_links` via `deriveEpicLinks` from task .2.
5. Read the pre-state `jobs.epic_links` for the affected session.
6. Compute the pre + post epic-id union (every target that appears in either pre or post `epic_links`).
7. UPDATE `jobs SET epic_links = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?`.
8. For each epic id in the pre+post union, run `deriveJobLinks` over the full per-epic invocation/window namespace and UPDATE `epics SET job_links = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?`. Shell-insert an `epics` row if missing (mirror `syncJobIntoEpic`'s shell-insert behavior — re-fold from scratch must reproduce every row).

Invocation site: post-switch block in `applyEvent`/`projectJobsRow`,
gated on `event.planctl_op != null OR (event.hook_event === 'PreToolUse' AND event.skill_name === 'plan:plan')`.
The post-switch placement matches the title-precedence precedent
(`src/reducer.ts:1141`); the gate fires regardless of which hook_event
switch arm did the lifecycle work.

EpicSnapshot ON CONFLICT carve-out: add `job_links` to the existing list
of columns explicitly preserved on EpicSnapshot UPSERTs (alongside
`jobs`). Without this, an approval RPC → file write → file-watcher →
EpicSnapshot fold would wipe `job_links`. The round-trip test for this
is mandatory (acceptance criterion).

Mirror `parseEmbeddedJobs` / `sortEmbeddedJobs` (`src/reducer.ts:644-694`)
as `parseEmbeddedLinks` / `sortEmbeddedLinks` — same deterministic sort
discipline: `(kind, target)` ascending, total-order tiebreaker (NOT a
single-field sort).

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:724-858` — `syncJobIntoEpic` (the analog seam — shell-insert pattern, last_event_id bump rule, sort discipline).
- `src/reducer.ts:644-694` — `parseEmbeddedJobs` / `sortEmbeddedJobs` (mirror for `parseEmbeddedLinks` / `sortEmbeddedLinks`).
- `src/reducer.ts:905-1183` — `projectJobsRow` (where the post-switch invocation lands).
- `src/reducer.ts:1141` — title-precedence post-switch precedent.
- `src/reducer.ts:1196-1232` — `applyEvent` BEGIN IMMEDIATE wrapper.
- The existing EpicSnapshot ON CONFLICT clause in `src/reducer.ts` (search for `ON CONFLICT` on epics — likely near the EpicSnapshot fold branch). MUST be located before coding; the carve-out is appended there.

**Optional**:
- `src/plan-classifier.ts` (just-completed task .2 exports).

### Risks

- Wide fold transactions: a session with 200 planctl events triggers 200 fan-outs, each scanning the per-session events log and recomputing every touched epic's `job_links`. The partial composite index (task .3) bounds this to per-session-scoped scans. Document the worst case in a comment block.
- EpicSnapshot wipes `job_links`: the ON CONFLICT carve-out is critical. If forgotten, approvals silently lose creator/refiner provenance.
- Re-fold determinism: a rewind + DELETE FROM jobs + DELETE FROM epics + drain must reproduce byte-identical projection. The new helper is pure-function-over-events; verify with a test that rewinds and re-drains.

### Test notes

Multiple fan-out tests in `test/reducer.test.ts`:
1. Single-session, single window, one creator → jobs.epic_links = [creator], epics[E].job_links = [creator].
2. Single-session, two windows, creator-then-refiner-same-epic → both edges emitted.
3. Read-only verb in window → no edges.
4. Two sessions touching the same epic → epics[E].job_links has both jobs.
5. EpicSnapshot ON CONFLICT round-trip: seed an epic with job_links, fold an EpicSnapshot for that epic, assert job_links survives.
6. Re-fold determinism: drive a full session, capture `jobs.epic_links` + `epics.job_links`, rewind cursor + DELETE FROM jobs/epics, drain to completion, assert byte-identical.

## Acceptance

- [ ] `syncPlanctlLinks` lives in `src/reducer.ts` as a parallel helper to `syncJobIntoEpic`.
- [ ] Invocation gated on `planctl_op != null OR (PreToolUse + skill_name='plan:plan')` in a post-switch block in `applyEvent` / `projectJobsRow`.
- [ ] EpicSnapshot ON CONFLICT clause explicitly preserves `job_links` (carve-out test passes).
- [ ] All six fan-out tests pass.
- [ ] Re-fold determinism test passes: rewind + re-drain reproduces byte-identical projection.

## Done summary
Added syncPlanctlLinks to reducer.ts: re-derives jobs.epic_links + per-touched-epic epics.job_links from scratch on every planctl-CLI invocation event (or /plan:plan window opener) via the pure classifier. Added EpicSnapshot ON CONFLICT carve-out for job_links, and shared normalizePlanctlOp helper used by both the live fan-out and the v13->v14 migration backfill so re-fold determinism holds byte-for-byte.
## Evidence

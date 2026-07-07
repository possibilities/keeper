## Description

**Size:** M
**Files:** src/daemon.ts, src/db.ts, src/failure-fingerprint.ts, keeper/api.py, test/daemon.test.ts, test/failure-fingerprint.test.ts

### Approach

Restructure the block-escalation sweep's category handling into a category->handler
dispatch TABLE (an if/else chain would merge-conflict with the audit-category routes an
in-flight epic adds to this same sweep — the epic dep covers sequencing; the table is the
shared seam). Task-scoped categories keep today's unblock path byte-equivalent.
SHARED_BASE_BROKEN handler: derive (repo, fingerprint) — repo from the blocked row's
target/project resolution, fingerprint from a NEW pure leaf `failure-fingerprint.ts`
(conservative normalization of the blocked reason's evidence: mask numbers/hex
ids/paths/timestamps/PIDs, bounded input, deterministic regex only — it feeds a fold, so
no wall-clock, no fs, O(1) per row). Latch: mint ONE sticky synthetic dispatch-failures
row keyed `repair::<repo-token>` whose reason carries the fingerprint, via the same
synthetic-event round-trip the merge-escalation stickies ride (re-fold deterministic —
wipe-and-replay must reproduce it byte-identically); hang `repair_dispatched_at` on it as
a new nullable REAL column via addColumnIfMissing, reusing the existing
human_notified_at page-once pattern for the decline path. SCHEMA_VERSION bump + the
python SUPPORTED_SCHEMA_VERSIONS whitelist land in the SAME commit. Dispatch ONE
repair::<token> per (repo, fingerprint) through dispatchEscalationSession — the per-key
occupancy guard and global cap apply once the two hard-coded verb lists
(readLiveEscalationJobs's plan_verb IN filter and resolveEscalationJobsFor / the
in-flight memo GC) learn the repair verb. Repair cwd is the repo's shared checkout —
NOT the lane-or-project resolution unblock uses. Serialization: one live repair per
(repo, fingerprint); a second distinct fingerprint on the same repo may dispatch
independently under the global cap; per-epic unblock serialization is untouched. Clear:
positive-evidence level-clear — the sweep observing the repo base green with zero
remaining SHARED_BASE_BROKEN blocked rows for that fingerprint clears the sticky row;
retained on no report. Decline/death: page exactly once via the human_notified_at gate
(mirror the existing unblock decline notify sweep), row stays sticky until
retry_dispatch re-arms. A dirty shared checkout at dispatch time is a DEFER (non-sticky
retry skip, no attempt consumed, no row minted) per the finalize dirty-degrade
precedent.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:884-979 — runBlockEscalationSweep (injectable-deps producer; the routing table lands here); :760 — shouldEscalateBlockedCategory (denylist — new category passes unchanged); :919-920 — the category gate call sites
- src/daemon.ts:2063-2117 — dispatchEscalationSession (occupancy + cap + LaunchSpec); :2011 — resolveEscalationJobsFor; :8176 — readLiveEscalationJobs's hard-coded verb list; :8391-8460 — dispatchUnblock/epicUnblockLive/notifyHumanOfBlock live wiring to mirror; :773-790 — effectiveBlockEscalationRepo (what repair's cwd derivation must NOT do)
- src/daemon.ts:1372 + :1616 — the merge-escalation + resolver sweeps: the column-latch, sequencing, and page-once patterns this task transplants
- src/db.ts:1515 — block_escalations PK (why the latch cannot live there); :5811/:5941/:6045 — the addColumnIfMissing nullable-REAL migration precedent
- src/baseline-store.ts — FailingTest/SuiteRedResult shapes available as fingerprint input
- keeper/api.py SUPPORTED_SCHEMA_VERSIONS + test/schema-version.test.ts — the same-commit pairing gate

**Optional** (reference as needed):
- test/daemon.test.ts — existing sweep tests with injectable deps (no real daemon/git/socket)
- CLAUDE.md Autopilot section — the DispatchFailed change-gate and positive-evidence-clear disciplines this must match

### Risks

- Re-fold determinism: the fingerprint and the synthetic row must derive purely from event data — any wall-clock or fs read in the fold path is a replay bomb
- Under-merged fingerprints race duplicate repairs (the skill's non-overlap assertion is the backstop); over-merged ones hide a second distinct defect — bias conservative, tune later
- The routing-table refactor touches the same lines an in-flight epic edits — land the table as a minimal seam, not a broad rewrite

### Test notes

Injectable-deps sweep tests: N blocked rows across 2+ epics, one repo+fingerprint ->
exactly one dispatch; two fingerprints -> two dispatches under cap; decline -> one page,
no re-dispatch until retry; green-base observation clears the row; dirty-checkout defer
consumes nothing; other categories byte-equivalent to today. Fingerprint unit table:
identical failures with differing paths/line-numbers/pids collapse, distinct failures do
not. Schema-version pairing test stays green.

## Acceptance

- [ ] N SHARED_BASE_BROKEN blocked tasks across multiple epics on one repo and fingerprint produce exactly one live repair dispatch; every other category routes to unblock exactly as before
- [ ] Two distinct fingerprints on one repo can each dispatch, subject to the global escalation cap
- [ ] A declined or dead repair session pages the human exactly once and is not re-dispatched until an operator retry re-arms it
- [ ] The sticky repair row clears only on positive evidence — the sweep observing the base green with no remaining matching blocked rows — and a dirty shared checkout defers with no attempt consumed and no row minted
- [ ] Schema version bump and the python supported-versions whitelist land in the same commit, and a wipe-and-replay refold reproduces the latch rows identically
- [ ] Daemon sweep and fingerprint suites green with injectable deps only — no real daemon, git, or socket

## Done summary

## Evidence

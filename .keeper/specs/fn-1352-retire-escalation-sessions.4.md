## Description

**Size:** S
**Files:** src/db.ts, src/reducer.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts

### Approach

Direction (human-ratified 07-21): UNIFY - escalation state collapses INTO
the dispatch_failures incident projection and block_escalations retires
(sibling task 2 does the collapse). This task lands ONLY the additive
schema groundwork task 2 re-points onto, with zero behavior change: one
forward-only SCHEMA_STEPS entry adding the incident columns to
dispatch_failures that the collapse needs and that do not exist today -
an incident owner reference plus generation, a durable attempt count
(the block_escalations owner_redispatch_attempts analogue), an
assignment/blocked-since timestamp, a bounded reason ref, and any
row-kind/key discriminator needed so per-task block incidents key into
the verb::id space alongside today's rows. Live shapes at authoring
time: dispatch_failures carries merge_escalated_at,
resolver_dispatched_at, human_notified_at, instance_event_id,
repair_dispatched_at, conflicted_files, attempt_id, claim_session_id,
claim_pid, claim_start_time, claimed_at; block_escalations carries
epic_id, task_id, blocked_since, status, outcome, human_notified_at,
owner_redispatch_attempts. Fold defaults for the new columns match the
zero-event projection; no producer writes them and no consumer reads
them yet (task 2 does both). SCHEMA_VERSION derives from the ladder
tail, SCHEMA_FINGERPRINT re-pins, and the version stays provisional
until landed.

### Investigation targets

*Verify before relying - these refs are planner-verified at authoring
time, but the repo moves.*

**Required** (read before coding):
- src/db.ts SCHEMA_STEPS tail + fingerprint pin - ladder discipline
  (docs/adr/0020)
- src/db.ts:5773-5784 - the dispatch_failures shape today
- block_escalations folds (src/reducer.ts:6208-6484) - the state whose
  carry-forward task 2 must express; choose column types that represent
  it losslessly
- docs/adr/0089-in-session-escalation-subagents.md - the retirement
  contract (human_notified_at carry-forward requirement)

### Risks

- Over-designing here starves task 2: land columns additive-only; if
  task 2 discovers a missing column it appends its own ladder entry -
  do not attempt the collapse migration, fold replacement, or any
  consumer edit here
- A column choice that cannot express block_escalations' page-once
  state per epic/task key would force task 2 into a second reshape -
  verify representability against the live shape before pinning types

### Test notes

Migration test proving a fresh DB and a migrated DB agree on the new
column defaults; refold-equivalence stays green (no fold behavior
change). Named gates.

## Acceptance

- [ ] One additive SCHEMA_STEPS entry lands the incident columns;
      SCHEMA_FINGERPRINT re-pinned; no hand-typed version
- [ ] Zero behavior change: no producer writes and no consumer reads
      the new columns; all existing suites green via named gates
- [ ] The new columns can losslessly represent every live
      block_escalations row (key, blocked_since, status, outcome,
      human_notified_at, owner_redispatch_attempts)

## Done summary
Landed an additive schema step adding blocked_since, block_status, block_outcome, and owner_redispatch_attempts to dispatch_failures so the escalation-retirement collapse can carry block_escalations state forward into the per-key incident projection. Zero behavior change: no producer writes or consumer reads them yet; re-fold stays byte-identical and the page-once human_notified_at + (verb,id) key already exist, so a live block_escalations row is losslessly representable.
## Evidence

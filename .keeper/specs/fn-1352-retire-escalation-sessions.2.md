## Description

**Size:** L
**Files:** src/db.ts, src/reducer.ts, src/board-render.ts, src/readiness.ts, src/dispatch-failure-pill.ts, cli/escalation-brief.ts, src/daemon.ts, src/reconcile-core.ts, src/autopilot-worker.ts, test/refold-equivalence.test.ts, test/reducer-projections.test.ts, test/dispatch-failure-pill.test.ts

### Approach

Direction (human-ratified 07-21, supersedes the SPEC_UNCLEAR block):
UNIFY into dispatch_failures - block escalations become incident state
on the dispatch_failures projection keyed in the verb::id space; the
block_escalations table and its folds retire in this task. Do NOT
reshape block_escalations in place.

Sibling task 4 landed the additive incident columns this task re-points
onto - read its landed diff first. Sibling task 1 (16ec964cd) landed
the incident-claim producer + folds (reducer foldIncidentClaimed /
foldIncidentReleased) as the interim shim these reads converge onto; it
landed no incident columns - that groundwork is task 4's, not task 1's.

One forward-only ladder entry (version assigned at merge, fingerprint
re-pinned) performs the collapse: the staged once-markers and the
block-escalation stage latch collapse into the task-4 incident columns
on per-key dispatch_failures rows - owner reference and generation,
durable attempt count, assignment time, reason ref, and
human_notified_at copied forward so no migrated row can re-page. The
latch folds are replaced by incident folds that stay deterministic,
never throw, and replace-merge per key with schema defaults matching
the zero-event projection; the claim and attachment folds from the
integration epics converge here as the only writers. The
producers/consumers that still read the old block_escalations table and
the resolver_dispatched_at/merge_escalated_at once-markers re-point at
the incident columns in the same ladder entry (they break the instant
the migration drops the old shape) - the block_escalations synthetic
emitters become incident-row producers in the verb::id space. Board
surfaces re-render: incident rows slot into the existing needs-human
subset accounting without double-counting, pills name incidents instead
of escalation sessions, and the brief CLI reads the incident shape.
Re-fold determinism is proven by the equivalence suite over the new
folds.

### Investigation targets

*Verify before relying - these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- Sibling task 4's landed diff - the incident columns this task
  re-points onto
- src/db.ts:5773-5784 plus the latch-column migrations at :3529, :3681,
  :3805, :4009 - the shape being collapsed
- src/reducer.ts:6208-6484 - the latch folds being replaced; :4284-4312
  the marker-preserving UPSERT; the task-1 incident-claim folds
  (foldIncidentClaimed/foldIncidentReleased) these converge onto
- src/db.ts SCHEMA_STEPS tail and the fingerprint pinning - ladder
  discipline
- src/board-render.ts:440 and src/readiness.ts:1385 - the render and
  needs-human accounting seams
- src/autopilot-worker.ts:10405-10430 (builds IncidentOwnerFailureFacts
  from the raw dispatch_failures columns resolver_dispatched_at /
  merge_escalated_at / human_notified_at), src/reconcile-core.ts:143-203
  (incidentOwnerAttachmentCount + nextIncidentOwnerAttachmentMarker
  read the two once-markers; the :187 doc comment "two-slot attachment
  lease until escalation state is collapsed" names THIS task), and
  src/daemon.ts:2302-2313 + :14395-14433
  (selectPendingBlockHumanNotifications + block-notify sweep over
  block_escalations) plus :13003/:13065 (block_escalations synthetic
  emitters), :1624 (pending-latch join) - the consumers/producers to
  re-point off the retired block_escalations table + once-markers onto
  the task-4 incident columns
- test/refold-equivalence.test.ts - the determinism proof that must
  stay green

**Optional** (reference as needed):
- src/dispatch-failure-key.ts - reason classification helpers the
  projection keys reuse

### Risks

- The rewind class matters: dispatch failures are
  deterministic-replayed - the migration must compose with
  wipe-and-replay while the carried-forward human_notified_at survives,
  which means the carry-forward must be event-derivable or explicitly
  seeded as a versioned migration step, not invented by the fold
- Double-counting in needs-human is silent and wrong in both
  directions - assert the total against fixtures with mixed incident
  and non-incident rows
- Re-pointing the daemon/reconcile/autopilot consumers is inseparable
  from the old-shape drop - the migration and the consumer edits must
  land atomically in this task or the build breaks at the commit

### Test notes

Fold suites over synthetic event streams for every incident transition;
refold-equivalence green; migration test from a pre-collapse fixture DB
proving no re-page and no lost page state; pill and board fixtures
updated. Named gates.

## Acceptance

- [ ] Escalation state lives entirely in the bounded per-key incident
      projection on dispatch_failures with deterministic folds and a
      green equivalence suite; the block_escalations table and its
      folds are gone
- [ ] A migrated row that already paged never pages again, and un-paged
      rows keep exactly one future page
- [ ] Board, readiness, pill, and brief surfaces read the incident
      shape with correct needs-human totals
- [ ] Every consumer/producer of the retired block_escalations table +
      once-markers reads the incident columns instead; no code path
      references the dropped shape
- [ ] The ladder entry is version-at-merge with the fingerprint
      re-pinned; all suites green via named gates

## Done summary

## Evidence

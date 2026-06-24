## Description

**Size:** M
**Files:** src/compaction.ts, test/refold-equivalence.test.ts, test/compaction.test.ts, README.md, CLAUDE.md

### Approach

Bound keeper.db ROW growth by physically DELETING old rows of the NO-OP-ARM SNAPSHOT
classes ONLY — `hook_event IN ('BackendExecSnapshot','TmuxPaneSnapshot','WindowIndexSnapshot')` —
NOT the full `RETENTION_SHED_CLASS_PREDICATE`. This narrowing is EMPIRICALLY REQUIRED:
seeding a corpus, draining to P0, deleting below the cursor, and re-folding showed the
broad shed-class DELETE is NOT byte-identical (jobs.state working→stopped,
last_api_error_at resurrected, last_permission_prompt_*/active_since lost, an entire
subagent_invocations turn vanished). Root cause: the shed BODIES are fold-unread, but
the ROWS' fold ARMS and cheap COLUMNS are load-bearing — SubagentStart/Stop/Turn,
modern PostToolUse:Agent, Pre/PostToolUse, and Notification have arms that mutate
jobs/subagent_invocations; non-plan Bash carries bash_mutation_* (git surface) +
background_task_id (computeMonitors). The three snapshot classes are the
retired-to-explicit-no-op fold arms (src/reducer.ts:7855/7870/7879): they touch no
projection and carry no producer-scanned column, so deleting the row == it never
existed → re-fold byte-identical (proven across two from-scratch re-folds). They are
also the dominant bloat (BackendExecSnapshot alone ≈ 37% of live rows).

A proven-safe dead-weight delete needs NO staging marker, so NO `is_shed_deleted`
column and NO SCHEMA_VERSION bump are required (this also drops the fn-930 schema
coordination). Direct batched DELETE gated `id < reducer_state.last_event_id
AND id <= computeColdWatermark AND hook_event IN (<the 3 no-op-snapshot classes>)`,
in bounded batches (500–5000/txn, the existing `.immediate()` shape) + `wal_checkpoint`
after batches + `incremental_vacuum`, all in keeper's OWN writer process (a separate
process + long reader pins the WAL). Express the delete predicate as a SINGLE named
constant GUARDED BY A TEST so it can never silently widen to a load-bearing class.
Re-spec `countAbsentBlobs` (:520) so an absent no-op-snapshot row is not a false
data-loss alarm while an absent KEEP-SET row still is. Update the README compaction
section + the CLAUDE.md retention invariant (the charter becomes: physical row
deletion is restricted to the no-op-arm snapshot classes; re-fold determinism holds
over the surviving rows).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:7855/7870/7879 — the three explicit no-op snapshot arms (the PROVEN-SAFE delete set)
- src/reducer.ts:4325/4392/4505/7287/7361 — the order-dependent shed-class arms that make a BROAD delete unsafe (do NOT delete rows these consume)
- src/compaction.ts:152 (`RETENTION_SHED_CLASS_PREDICATE` — the body-NULL set, NOT the delete set), :249 (`computeColdWatermark` MAX(id)), :286-302 (`retainColdPayloads` NULL + cursor gate), :520 (`countAbsentBlobs`)
- test/refold-equivalence.test.ts — the proof harness already used to prove the narrow set; make that a PERMANENT regression test

### Risks

- A future widening of the delete predicate to a load-bearing class silently breaks re-fold — pin the predicate to the no-op-arm set with a guarding test.
- A long-lived read txn pins the WAL during the delete — batch + checkpoint in the writer process.
- Must never delete a row inside T4's computeMonitors bound — the no-op-snapshot classes carry no `background_task_id` so they're disjoint from what computeMonitors reads, but keep the `id < cursor` gate.

### Detailed phases

1. Lock the delete set to the 3 no-op-snapshot classes as a single named constant; add a PERMANENT refold-equivalence regression test: seed a corpus with every shed-class type, DELETE only the no-op set, assert two from-scratch re-folds are byte-identical (jobs + subagent_invocations + git surface), AND document/assert that deleting a load-bearing shed row WOULD diverge (so the narrowness is self-justifying).
2. Implement the batched DELETE + `wal_checkpoint` + `incremental_vacuum`, gated on the predicate + `id < cursor` + cold watermark, in the writer process.
3. Re-spec `countAbsentBlobs`; update README compaction + CLAUDE.md retention invariant.

### Test notes

The permanent refold-equivalence regression test IS the gate — it must run the actual
DELETE then re-fold (not re-NULL). Add compaction.test.ts coverage for the batched
delete/checkpoint/vacuum mechanics + the countAbsentBlobs re-spec. `bun run test:full`.

## Acceptance

- [ ] The DELETE set is exactly the no-op-arm snapshot classes (`BackendExecSnapshot`, `TmuxPaneSnapshot`, `WindowIndexSnapshot`), expressed as a single named constant guarded by a test; the broad `RETENTION_SHED_CLASS_PREDICATE` is explicitly NOT deleted.
- [ ] A permanent refold-equivalence regression test proves: seed a corpus with every shed-class type, DELETE only the no-op set, two from-scratch re-folds byte-identical (jobs + subagent_invocations + git surface).
- [ ] DELETE is batched + `wal_checkpoint`ed + `incremental_vacuum`ed in keeper's writer process, gated `id < cursor AND id <= coldWatermark`.
- [ ] `countAbsentBlobs` re-spec'd (absent no-op-snapshot row ≠ data loss; absent keep-set row still is).
- [ ] No SCHEMA_VERSION bump (no new column). README compaction + CLAUDE.md retention invariant updated (forward-facing). `bun run test:full` green.

## Done summary
Bound keeper.db ROW growth by physically deleting the cold tail of the three no-op-arm snapshot classes (BackendExecSnapshot/TmuxPaneSnapshot/WindowIndexSnapshot) — proven re-fold-safe (their arms touch no projection, no producer-scanned column) while the broad shed class stays body-NULL-only. Predicate pinned by a guarding test; permanent SAFE+NECESSARY refold-equivalence regression added. No SCHEMA_VERSION bump.
## Evidence

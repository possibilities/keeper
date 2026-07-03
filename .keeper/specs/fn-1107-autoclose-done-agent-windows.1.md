## Description

**Size:** S
**Files:** src/db.ts, src/reducer.ts, src/types.ts, keeper/api.py, test/reducer-projections.test.ts, test/db.test.ts

### Approach

Add a nullable `jobs.dispatch_origin` TEXT column (deterministic-replayed class) and stamp
it `'autopilot'` in the reducer at the pending-dispatches discharge-on-bind seam: when a
SessionStart fold's discharge DELETE actually removes a `pending_dispatches` row for the
job's (verb, ref), the job row gets `dispatch_origin = 'autopilot'`. The gate is the
actual discharge (`db.changes() > 0` after the DELETE, or an equivalent prior existence
check) — NEVER `plan_verb`/`plan_ref` presence: a manual `keeper dispatch work::fn-N.M`
is plan-form but mints no Dispatched event and therefore no pending row (the CLI only
READS the pending table as a race guard), so manual workers must fold to NULL. This is
the airtight autopilot-vs-manual discriminator the autoclose worker scopes on. Replay
determinism holds because the Dispatched event that mints the pending row precedes the
binding SessionStart in the event log, so a full re-fold reproduces the same discharge
and the same stamp.

Schema mechanics: bump SCHEMA_VERSION 106 -> 107; add the column via the
`addColumnIfMissing` migration pattern (nullable, NO default); keep it OUT of the
CREATE_JOBS literal (append-only migration rule) and OUT of LIVE_ONLY_JOBS_COLUMNS
(it is deterministic-replayed, like kill_reason — survives wipe-and-replay). Add 107
to SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the SAME commit (hard whitelist
enforced by test/schema-version.test.ts). Surface the field on the Job type.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:7912-7945 — the discharge-on-bind seam: the DELETE FROM pending_dispatches and its gate `(isSpawnInsert || priorJob.plan_ref == null) && plan_verb != null && plan_ref != null`; the stamp lives in this branch, conditioned on the DELETE removing a row
- src/db.ts:5738 — `addColumnIfMissing(db,"jobs","kill_reason","TEXT")`, the exact migration template to copy
- src/db.ts:49 — SCHEMA_VERSION (currently 106)
- keeper/api.py:414 — the SUPPORTED_SCHEMA_VERSIONS frozenset
- cli/dispatch.ts:337-358 — manual dispatch READS pending_dispatches as a race guard, mints nothing: the proof manual workers stay NULL
- src/reducer.ts:4175-4190 — foldDispatched mints the pending row (establishes log-order determinism)

**Optional** (reference as needed):
- src/db.ts:1836 — LIVE_ONLY_JOBS_COLUMNS (dispatch_origin must NOT be listed)
- src/db.ts:852-856 — the append-only CREATE_JOBS rule
- src/types.ts:304 — the Job type to extend

### Risks

- A stale unbound pending row for the same (verb, ref) inside the dispatch TTL could mis-stamp a same-key manual dispatch — accepted, documented in the epic; do not over-engineer a fix.
- Stamping on the wrong gate (plan_verb presence) silently makes every manual plan worker autoclose-eligible — the exclusion test below is the tripwire.

### Test notes

Pure reducer tests over freshMemDb(): (a) Dispatched event then binding SessionStart ->
dispatch_origin 'autopilot'; (b) plan-form SessionStart with NO pending row -> NULL;
(c) handoff:: and untitled SessionStarts -> NULL; (d) full wipe-and-replay reproduces
byte-identical dispatch_origin values; (e) migration idempotence (re-running migrate on
a v107 DB is a no-op). test/schema-version.test.ts must pass without edits (it parses
keeper/api.py).

## Acceptance

- [ ] A SessionStart that discharges a pending dispatch folds a job row with dispatch_origin 'autopilot'; the same spawn-name arriving with no pending row folds NULL.
- [ ] Handoff, panel, and untitled sessions fold dispatch_origin NULL.
- [ ] A full re-fold (wipe-and-replay of deterministic projections) reproduces identical dispatch_origin values.
- [ ] Schema version is bumped with the python whitelist updated in the same commit; the schema-version suite is green.
- [ ] `bun test` green.

## Done summary
Added nullable jobs.dispatch_origin (schema v106->v107) stamped 'autopilot' at the reducer's SessionStart discharge-on-bind seam, gated on the actual pending_dispatches DELETE (changes > 0) so manual/handoff/untitled sessions fold NULL. Deterministic-replayed; re-fold reproduces stamps byte-identically. Added 107 to SUPPORTED_SCHEMA_VERSIONS in the same commit.
## Evidence

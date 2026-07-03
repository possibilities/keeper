## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, plugins/keeper/plugin/hooks/events-writer.ts, src/daemon.ts, keeper/api.py, test/db.test.ts, test/events-writer.test.ts, test/schema-version.test.ts, test/reducer-lifecycle.test.ts

### Approach

One forward-only migration (SCHEMA_VERSION bump) adding two columns to BOTH
surfaces. events gains harness and resume_target (nullable TEXT): note events
columns are a FIVE-place lockstep per column — CREATE_EVENTS literal,
KNOWN_EVENT_COLUMNS, the hook insertBindings, INGEST_EVENTS_COLUMNS, and the
insertEvent prepared statement — pinned by the events-writer LOCKSTEP test. jobs
gains harness and resume_target as migration-ONLY additive nullable columns
(never in CREATE_JOBS; appended after the current last column so fresh-vs-migrated
PRAGMA table_info parity holds). NULL rule (decided): the fold stores the event's
harness verbatim and never synthesizes a value; every read treats NULL as claude;
the migration performs NO backfill; the claude events-writer hook stamps
harness "claude" going forward. Fold changes: the SessionStart arm additionally
folds harness and resume_target when present on the event (COALESCE-style, no
revive-semantics change); a NEW ResumeTargetResolved arm folds ONLY
jobs.resume_target (idempotent replace) — deliberately not the SessionStart arm
so a late back-fill can never flip a killed row back to stopped. Bump
SCHEMA_VERSION and add the version to SUPPORTED_SCHEMA_VERSIONS in keeper/api.py
in the SAME commit.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:49 — SCHEMA_VERSION; :590 CREATE_EVENTS; :867-871 the jobs migration-only note; :2138 addColumnIfMissing; :5740-5800 recent column-add migrations to mirror
- plugins/keeper/plugin/hooks/events-writer.ts:555 — KNOWN_EVENT_COLUMNS + insertBindings; test/events-writer.test.ts:1069 LOCKSTEP pin
- src/daemon.ts:2341 — INGEST_EVENTS_COLUMNS; :4302 insertEvent prepared form
- src/reducer.ts:7777 — SessionStart fold arm (the ON-CONFLICT revive semantics to leave untouched); :7971-8039 Killed arm as the synthetic-arm template
- keeper/api.py SUPPORTED_SCHEMA_VERSIONS + test/schema-version.test.ts

**Optional** (reference as needed):
- test/refold-equivalence.test.ts and test/db.test.ts fresh-vs-migrated parity — the two invariant gates this task must keep green

### Risks

- Two different column disciplines (events five-place lockstep vs jobs migration-only append-order) in one migration — easy to cross-wire
- Any fold path that synthesizes 'claude' breaks refold-equivalence on legacy NULL events

### Test notes

LOCKSTEP green with the hook stamping claude; refold-equivalence green; fresh vs
migrated table_info identical; a ResumeTargetResolved event against a killed job
sets resume_target and leaves state killed (explicit regression case).

## Acceptance

- [ ] Migration applies forward-only; fresh and migrated databases have identical events/jobs column layouts
- [ ] A ResumeTargetResolved event sets a job's resume target without changing its state, including on terminal rows
- [ ] SessionStart events carrying harness/resume_target fold them onto the row; legacy NULL-harness rows read as claude everywhere
- [ ] Refold-equivalence and the events-writer column-lockstep suites are green; the python API whitelist accepts the new version in the same commit

## Done summary
Added v107 migration adding nullable harness + resume_target columns to events (five-place lockstep) and jobs (migration-only); the SessionStart fold folds both verbatim (never synthesizing claude) and a new ResumeTargetResolved arm idempotently sets resume_target without changing lifecycle state. Bumped SCHEMA_VERSION to 107 and the api.py whitelist in the same commit.
## Evidence

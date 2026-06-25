## Description
**Size:** M
**Files:** src/reducer.ts, src/db.ts, keeper/api.py, test/reaper-worker.test.ts (or a fold/migration test sibling)
### Approach
NULL `backend_exec_pane_id` (and `backend_exec_generation_id`) when a job folds to a terminal state (ended/killed) in the backend_exec fold, so dead jobs stop holding live-recyclable pane ids. Keep the fold re-fold-deterministic (drive off the event's data/ts; NEVER wall-clock / liveness / env / fs). Add a forward-only, version-guarded migration clearing `backend_exec_pane_id` on existing terminal jobs (~113). Bump SCHEMA_VERSION and add it to SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the SAME commit.
### Investigation targets
**Required** (read before coding):
- src/reducer.ts:8039 — the backend_exec fold (where job terminal state is set; add the pane/generation clear)
- src/db.ts — migration block, SCHEMA_VERSION, meta(schema_version) version-guard pattern
- keeper/api.py — SUPPORTED_SCHEMA_VERSIONS whitelist
- test/schema-version.test.ts — enforces the whitelist
### Risks
- Re-fold determinism is sacred (jobs is a deterministic-replayed projection): clearing pane_id must fold byte-identically on replay.
- Migration is forward-only + version-guarded; the non-idempotent clear is gated by schema_version.
### Test notes
- Fold: a job folding to ended/killed ends with NULL backend_exec_pane_id; re-fold determinism holds.
- Migration: existing terminal jobs' pane_id cleared; schema-version test green.
## Acceptance
- [ ] terminal-state fold NULLs backend_exec_pane_id + backend_exec_generation_id, deterministically
- [ ] forward-only migration clears backend_exec_pane_id on existing terminal jobs
- [ ] SCHEMA_VERSION bumped + added to SUPPORTED_SCHEMA_VERSIONS; schema-version test passes
- [ ] bun run test:full green
## Done summary
Terminal (ended/killed) jobs now NULL backend_exec_pane_id + generation in the fold (COALESCE arm guarded against terminal rows), plus a v91->v92 version-guarded migration clears the coords on existing terminal jobs; SCHEMA_VERSION bumped to 92 + whitelisted in keeper/api.py.
## Evidence

## Description

**Size:** S
**Files:** src/db.ts, keeper/api.py, README.md, test/schema-version.test.ts

### Approach

Add a forward-only, version-guarded rewind-and-redrain migration step in
`src/db.ts` modeled EXACTLY on the v80 step (`db.ts:4264-4295`): bump
`SCHEMA_VERSION` (`db.ts:48`) to 81; guard `if (preMigrateStoredVersion <
81)`; `UPDATE reducer_state SET last_event_id = 0`; DELETE the
deterministic-replayed projections in the wipe list (jobs, epics, …) but DO
NOT wipe `commit_trailer_facts` (a derive INPUT, rebuilt byte-identically
from cursor 0 via `INSERT OR IGNORE foldCommit`). RAISE the git floor to
`max(events.id)` + `seed_required = 1` via `rewindLiveProjection` (NOT a
floor-reset-to-0 — that re-arms the git O(history) time-bomb). Replicate the
v80 ephemeral wipe list (`pending_dispatches`, `dispatch_never_bound`, …) to
avoid the resurrection hazard. Add 81 to `SUPPORTED_SCHEMA_VERSIONS` in
`keeper/api.py` in the SAME commit. The rewind's real justification (name it
in the README prose, not "just in case"): it converges `epics.job_links`
under the new logic and is self-validating — the re-fold that previously
took ~15 min now runs in ~1–2 min under the cheap fold. Depends on Task 1 —
the new fold logic must exist before the redrain replays under it.

### Investigation targets

**Required** (read before coding):
- src/db.ts:4244-4295 — the v80 rewind-and-redrain step (the exact template); :4255-4259 (`commit_trailer_facts` deliberately NOT wiped); the git-floor RAISE vs v77's floor-reset-to-0
- src/db.ts:48 — `SCHEMA_VERSION` const; `rewindLiveProjection` + `LIVE_ONLY_PROJECTIONS` / `EPHEMERAL_PROJECTIONS` registries
- keeper/api.py — `SUPPORTED_SCHEMA_VERSIONS` frozenset + its comment block
- test/schema-version.test.ts — the membership cross-check that enforces the paired bump
- test/refold-equivalence.test.ts:824 — the ephemeral resurrection regression test the wipe list must satisfy

**Optional** (reference as needed):
- README.md ~2283-2313 — the schema-history prose block pattern for the new version

### Risks

- Forgetting to RAISE the git floor (or resetting it to 0) re-arms the O(history) git time-bomb — copy v80, not v77.
- Wiping `commit_trailer_facts` loses the commit-channel edges (it is an INSERT-OR-IGNORE derive input rebuilt from cursor 0) — DO NOT wipe it.
- Missing an ephemeral table in the wipe list resurrects a phantom (the `pending_dispatches` dispatch jam) — replicate v80's list; refold-equivalence.test.ts:824 guards it.
- Forgetting the keeper/api.py bump fails schema-version.test.ts; the `migrate()` pre-transaction guard must still refuse to let an old binary downgrade a newer DB.

### Test notes

- `bun run test:full` mandatory (db / migration path).
- schema-version.test.ts must pass with 81 added.
- A full rewind-and-redrain over the live-shaped corpus reproduces byte-identical projections AND completes fast (the self-validation).

## Acceptance

- [ ] `SCHEMA_VERSION` bumped to 81; 81 added to `SUPPORTED_SCHEMA_VERSIONS` in keeper/api.py in the same commit
- [ ] version-guarded rewind-and-redrain step added, modeled on v80: cursor→0, deterministic projections wiped, `commit_trailer_facts` NOT wiped, git floor RAISED (not reset), ephemeral wipe list replicated
- [ ] README schema-history prose block added for v81 (forward-facing, present tense, naming the convergence + self-validation reason)
- [ ] test/schema-version.test.ts green; test/refold-equivalence.test.ts (incl. the resurrection guard) green
- [ ] a post-migration boot re-fold reproduces byte-identical projections and completes in ~1–2 min (no socket-down storm)
- [ ] `bun run test:full` green

## Done summary

## Evidence

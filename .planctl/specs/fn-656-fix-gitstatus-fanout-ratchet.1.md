## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer.test.ts, CLAUDE.md, README.md

### Approach

In `projectGitStatus` (`src/reducer.ts`), the pass-4 fan-out loop over
`sortedSessions` (~:2032-2048) runs, per session: `jobUpdateStmt.run(...)`
(zeroes/sets the per-job git counts), then `syncIfPlanRef(...)` (fans the
count into the embedded epic `jobs[]` when `plan_ref != null`), then
`projectionJobs.push({ job_id, dirty: dirtyForSession })`. Change EXACTLY
one thing: guard the push with `if (dirtyForSession > 0)`. Leave the
`jobUpdateStmt.run` and `syncIfPlanRef` calls UNCONDITIONAL — they must
still fire for every session in `sortedSessions` so a session that
transitions to `dirty == 0` (still present in `priorSessions`) gets its
clearing UPDATE and its epic `jobs[]` cleared exactly once, on the
snapshot where it leaves the set. Because `priorSessions` is read from
the persisted `git_status.jobs`, shedding zero-dirty entries shrinks the
next snapshot's union — steady-state fan-out collapses from ~259 to the
currently-dirty set (0-5). `projectionJobs` is built in `sortedSessions`'
sorted iteration order, so the filtered array stays deterministically
ordered for the `git_status.jobs` JSON.

Then tighten the invariant prose in CLAUDE.md (event-sourcing invariants,
the `GitRootDropped` "walks the SAME canonical `git_status.jobs`
enumeration" / "every enumerated job" wording) and README.md (Architecture
schema-v31 git narrative) to state that `git_status.jobs` retains only
`dirty > 0` sessions. In-place sentence tightening, NOT a schema bump — do
NOT touch `SCHEMA_VERSION` or keeper-py `SUPPORTED_SCHEMA_VERSIONS`.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts (fan-out loop ~:2032-2048, push ~:2047) — the one-line guard site
- src/reducer.ts (~:1925-2007) — how `sessionDirtyCount`, `sessionsWithAttribution`, `allActiveSessions`, and `priorSessions` are built; confirm a session reachable only via `allActiveSessions` (undischarged attribution, zero current dirty files) has `dirtyForSession == 0` and is correctly dropped
- src/reducer.ts `retractGitStatus` (~:2152-2192) — reads `git_status.jobs` to enumerate job_ids to zero on GitRootDropped; confirm shedding already-zero sessions is a safe no-op
- src/reducer.ts `syncIfPlanRef` (~:3315-3339) — the per-session fan-out helper the guard must NOT wrap
- test/reducer.test.ts re-fold determinism tests (~:2120, ~:2277), fan-out test (~:292), retract tests (~:452, ~:2220); helpers `insertEvent` (~:50-141), `drainAll` (~:3783)

**Optional** (reference as needed):
- src/collections.ts (~:348) — `git_status` wire projection; confirm no consumer iterates `git_status.jobs` for `job_id`/`dirty` or as a session-count display except `retractGitStatus`
- src/db.ts (~:665-679) — `git_status` schema (`jobs TEXT NOT NULL DEFAULT '[]'`)

### Risks

- **Stale-count leak:** if the guard wrongly wraps `jobUpdateStmt.run` or `syncIfPlanRef` (not just the push), a session transitioning to clean never zeroes its `jobs` row / epic `jobs[]` — guard ONLY the push.
- **One slow transition fold:** the first post-deploy GitSnapshot per project still fans out the ratcheted ~259 once (no worse than today, self-converging). Accepted; no re-fold/migration. `nsessions` in `[gitfold-breakdown]` stays ~259 for that one fold (it reports `sortedSessions.length`, not `projectionJobs.length`) — the win lands on the NEXT snapshot.
- **Determinism:** the push decision must be a pure function of `sessionDirtyCount` (no `Date.now()`/env reads). It already is — keep it that way.

### Test notes

Add a reducer test that drives the dirty->clean lifecycle and asserts:
(a) a session with a current dirty file appears in `git_status.jobs`;
(b) after a follow-up snapshot where it is clean, it is ABSENT from
`git_status.jobs`, its `jobs.git_dirty_count == 0`, and (if it carries
`plan_ref`) its embedded epic `jobs[]` git count is cleared;
(c) a session reachable only via undischarged-but-not-currently-dirty
attribution is absent from the persisted set;
(d) a GitRootDropped retract after a session has zeroed/dropped is a
correct no-op for that session.
Confirm the existing re-fold determinism tests (~:2120, ~:2277) still
pass — the ~:2277 baseline's second-snapshot `git_status.jobs` value
changes from `[{...,dirty:0}]` to `[]` but stays internally consistent
across the rewind. Grep the test file for any literal `git_status.jobs`
assertion carrying a `dirty:0` entry that the fix would now omit.

VERIFY OFFLINE FIRST (mission hard constraint): copy the live DB
(`cp ~/.local/state/keeper/keeper.db /tmp/verify.db`; remove the
`-wal`/`-shm`), replay the slow GitSnapshot event ids (the ones logged at
2.3-3.3s in `[gitfold-breakdown]`) against the copy with the patched
reducer, confirm the fold latency drops well under ~2.4s AND the
projection result is correct (`git_status.jobs` sheds to the dirty-only
set, scalar counts unchanged). Only touch the live daemon after the copy
verifies.

## Acceptance

- [ ] `projectionJobs.push` guarded by `if (dirtyForSession > 0)`; `jobUpdateStmt.run` and `syncIfPlanRef` remain unconditional over `sortedSessions`
- [ ] new reducer test asserts the dirty->clean transition sheds the session from `git_status.jobs` at the transition (count zeroed, epic `jobs[]` cleared) and it is absent on the next snapshot
- [ ] new test asserts an undischarged-but-not-currently-dirty session is absent from `git_status.jobs`, and a retract-after-zero is a no-op
- [ ] existing re-fold determinism tests (~:2120, ~:2277) pass; no literal `dirty:0` `git_status.jobs` assertion left stale
- [ ] verified on a COPY of the live keeper.db: the previously-slow GitSnapshot folds drop well under the ~2.4s budget and projection results are correct, BEFORE the live daemon is touched
- [ ] CLAUDE.md + README.md prose tightened to state the `dirty > 0` retention invariant; `SCHEMA_VERSION` and keeper-py `SUPPORTED_SCHEMA_VERSIONS` untouched
- [ ] `bun test` passes; committed to main staging ONLY the touched files

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts, keeper/api.py, test/reducer-lifecycle.test.ts, test/refold-equivalence.test.ts

### Approach

Add a nullable `jobs.last_lifecycle_ts` column (the lifecycle stamp — a per-row
event-time high-water mark, per CONTEXT.md; never call it a watermark) and one
shared helper that every lifecycle-state-writing arm routes through. The gate is
polarity-aware per ADR 0013: quiescing transitions (to stopped) apply at
`event.ts >= stamp`; activating transitions (to working, including the
UserPromptSubmit revival — it shares the same stale-arrival race shape) require
strictly `event.ts > stamp`; terminal arms (Killed, SessionEnd) keep their existing
identity/terminal guards, are exempt from stamp REJECTION (a far-future-pinned row
must stay healable), and still advance the stamp; a NULL stamp always applies. On
apply the stamp advances to max(stamp, event.ts). The helper composes WITH the
existing terminal WHERE guards and the subagent-yield guard — it replaces neither.
Enumerate and route the FULL inventory of state-writing sites (roughly nine: the
silent-stream-cut drop, UserPromptSubmit revival, the SessionStart re-open region,
Stop, SessionEnd, Killed, the InputRequest synthetic arm, and the three un-stop
arms). The permission-prompt clear arm is deliberately NOT an un-stop — leave it
outside the state-flip path. The fold stays pure over event fields (re-fold
deterministic, O(1) per event).

The migration is DDL-only and REWINDING: add the column via the addColumnIfMissing
pattern (nullable, no default, kept OUT of the CREATE_JOBS literal, NOT added to
LIVE_ONLY_JOBS_COLUMNS), bump SCHEMA_VERSION, add the new version to
SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the SAME commit, rewind the cursor,
and DELETE the full CURRENT deterministic-replayed projection set — enumerate it
fresh from the live code (jobs, epics, subagent_invocations, commit_trailer_facts,
dispatch_failures, plus anything else in the class); the older rewind migrations'
DELETE lists are provably incomplete, do NOT copy them — then re-drain and call
rewindLiveProjection for the live-only git surface. The stamp is back-derived
purely by replay, never by an UPDATE back-fill.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/adr/0013-jobs-lifecycle-stamp-and-stuck-sentinel.md — the settled contract this task implements
- src/reducer.ts:8746-8807 — the bare un-stop arm and its comment (the root-cause arm)
- src/reducer.ts:8708-8745 — the two annotation-gated un-stop arms
- src/reducer.ts:8272-8372 — Stop arm (subagent-yield guard + monitors hoist + state flip)
- src/reducer.ts:8248-8267 — UserPromptSubmit revival (unconditional working today)
- src/reducer.ts:5653-5680 — dropParentJobOnSilentStreamCut working-to-stopped writer
- src/reducer.ts:7929-8036, :8374-8420, :8425-8480, :8674-8700 — SessionStart re-open region, SessionEnd, Killed, InputRequest synthetic arm
- src/db.ts:51 — SCHEMA_VERSION; keeper/api.py:431 — SUPPORTED_SCHEMA_VERSIONS (same commit)
- src/db.ts:2304 — addColumnIfMissing discipline; src/db.ts:3155-3187 — the one rewind-and-redrain example; src/db.ts:2016 — rewindLiveProjection
- test/reducer-lifecycle.test.ts:6630, :6642 — existing out-of-order-ts precedents; local insertEvent/tsCounter/drainAll harness

**Optional** (reference as needed):
- src/db.ts:1708, :4036, :4930 — commit_trailer_facts / dispatch_failures DELETE sites (evidence the old rewind lists are incomplete)
- src/reducer.ts:4362 — active_since consumer (INSTANT_DEATH_LIFETIME_SEC) — confirm gating out a stale un-stop (so active_since is not re-stamped) does not perturb instant-death detection
- src/subagent-invocations.ts:245 — findFreshInFlightSubagentAnchor (composes with the helper, unchanged)

### Risks

- The rewind DELETE list is the highest-risk piece: a missed deterministic projection leaves stale rows re-folded onto a rewound cursor. Derive the list from the current schema/code, not an old migration.
- Equal-ts ties are a hot path (racing same-host writers collide at ms granularity) — the semantic tiebreak (quiescence wins) needs direct tests, and must never be keyed on event.id.
- A genuine UserPromptSubmit whose ts exactly equals the stamp is swallowed by the strict-> activating gate; acceptable because the turn's following tool events carry newer ts and revive the row — note it in the arm comment.
- Swallowed (gated no-op) transitions must keep per-row bookkeeping re-fold-stable — mirror the existing changes>0-gated syncIfPlanRef discipline.

### Test notes

Permutation regression: drive all ingest orderings of {PreToolUse, Stop, straggler
PostToolUse(ts < Stop.ts), UserPromptSubmit} through the fold and assert the final
state is identical, including the equal-ts permutation (quiescence wins). Add a
resume-after-stop flow (tool events with fresh ts, no UserPromptSubmit) asserting
the row still un-stops, and a stale-straggler flow asserting it never resurrects.
Add the new column to the refold-equivalence corpus expectations. Prove
migrated-in-place vs from-scratch equivalence via the rewind (freshDbFile over a
full migrate). Keep helpers per-shard per the suite's convention; no sleeps —
retryUntil only.

## Acceptance

- [ ] A lifecycle transition whose event time has regressed behind the row's lifecycle stamp is not applied; the projection state is invariant across all ingest orderings of the same event set, equal-timestamp ties included
- [ ] A genuine resume (newer-timestamp tool events, with or without a prompt event) still transitions a stopped row back to working
- [ ] Terminal transitions always land regardless of stamp value and the stamp still advances
- [ ] The migration bumps the schema version, whitelists it in the python API in the same commit, and rewinds so the stamp is derived purely by replay; the re-fold equivalence and schema-version suites are green
- [ ] The full fast suite (`bun test`) is green

## Done summary

## Evidence

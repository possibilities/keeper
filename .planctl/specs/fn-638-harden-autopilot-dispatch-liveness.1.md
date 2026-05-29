## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts, CLAUDE.md

Close P3: a one-shot orphan sub-agent that never emits `SubagentStop` (sub
crashed, hook timed out, row lost to the "hook always exits 0" contract)
pins its job at `state='working'` until the window closes, because the Stop
fold's sub-agent guard swallows every Stop while any surviving sub-agent
row is `running`, and the only orphan resolver
(`sweepRunningSubagentsToUnknown`) runs solely on SessionEnd/Killed. This
holds the per-root/per-epic mutex open and wedges autopilot until a human
closes the Ghostty window.

### Approach

In the Stop fold (`src/reducer.ts:3722-3785`), the `subRunning` query
(`:3757-3769`) currently `break`s unconditionally — leaving `state='working'`
— whenever a surviving (max `turn_seq` per name-group) running sub-agent
exists. Add a recency bound: only swallow the Stop if the newest surviving
running sub-agent's `ts` is within `MAX_STOP_YIELD_GAP_SEC` of the Stop
event's `ts`; otherwise fall through to the normal `state='stopped'` write.
Define a named constant `MAX_STOP_YIELD_GAP_SEC = 120` with a comment
documenting the symmetric failure modes (too large → stuck gate held
longer; too small → premature `stopped` flash and a spurious `job-pending`
notification). Keep the same-name `turn_seq` collapse clause intact. Both
`events.ts` and `subagent_invocations.ts` are REAL unix-**seconds** (see the
`(event.ts - row.ts) * 1000` ms convention at `src/reducer.ts:~2002`) — keep
the unit explicit to avoid a 1000x bug. When the guard fires the stopped
write, run the existing `syncIfPlanRef` fan-out exactly as the normal Stop
path does (confirm `syncJobLinksOnJobWrite` propagation to linked epics).
This stays a pure function of the event log — NO `Date.now()` in the fold —
so re-fold determinism holds (CLAUDE.md "Producer-only liveness probing").

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3722-3785 — Stop fold + sub-agent guard (the swallow-without-write break)
- src/reducer.ts:3757-3769 — `subRunning` same-name `turn_seq` collapse query (the recency bound attaches here)
- src/reducer.ts:1975-1988 — `sweepRunningSubagentsToUnknown`, the only orphan resolver (SessionEnd/Killed only), for parity
- src/db.ts:399-413 — `subagent_invocations` schema (`ts REAL NOT NULL`)
- test/reducer.test.ts:2535-2660 — Stop/sub-agent test block; :2603-2642 hand-written `subagent_invocations` rows with explicit `ts`

**Optional** (reference as needed):
- src/reducer.ts:~2002 — `(event.ts - row.ts) * 1000` units convention
- CLAUDE.md "Producer-only liveness probing" + event-sourcing invariants

### Risks

- Negative or zero computed age (clock skew / same-second events) must NOT trip the release branch prematurely.
- A `running` row with NULL/0 `ts` (legacy/malformed) — fold to a safe, defined branch (conservatively treat as not-stuck → keep swallowing, to avoid a premature release); never throw inside the fold.
- Anchor the age on the surviving (max `turn_seq`) running row the existing query returns — measure against the newest running `ts`, not a demoted orphan.

### Test notes

Extend the reducer Stop/sub-agent block: (a) a `SubagentStart` `ts` well
older than the Stop `ts` (gap > N) with no `SubagentStop` → assert the job
flips to `state='stopped'`; (b) gap < N → assert it stays `working`; (c)
re-fold determinism — fold the same event sequence twice from scratch and
assert byte-identical `jobs`/`subagent_invocations` rows.

## Acceptance

- [ ] `MAX_STOP_YIELD_GAP_SEC` is a hardcoded named constant with a tradeoff comment (no config/env/meta-row source)
- [ ] Stop fold releases a job to `stopped` when the newest running sub-agent start is older than the bound; still swallows within the bound
- [ ] Same-name `turn_seq` collapse preserved; fan-out (`syncIfPlanRef`, `syncJobLinksOnJobWrite`) runs on the bounded release
- [ ] No `Date.now()` in the fold; re-fold determinism test passes
- [ ] Edge cases (negative age, NULL `ts`) fold to a defined, non-throwing branch

## Done summary

## Evidence

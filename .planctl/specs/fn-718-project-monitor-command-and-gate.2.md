## Description

**Size:** S
**Files:** src/await-conditions.ts, src/types.ts, test/await-conditions.test.ts

### Approach

Add a pure, fixture-testable liveness predicate mirroring `agentsIdleState`
(src/await-conditions.ts:627). It answers "is a monitor matching the
selector still running in the CALLER's OWN session?" — own-session scope
was the chosen binding.

1. Add `monitors: string | null` to the `Job` interface (src/types.ts:434) — surface the projection fact natively rather than reading it untyped (durable-source-of-truth stance). T1 establishes the enriched `MonitorEntry`; this consumes it.
2. Implement `monitorRunningState(ownSessionId, selector, jobsRows: Iterable<Job>)` returning the `AwaitState` union (`met` / `waiting` only):
   - Find the caller's OWN job row (`job.job_id === ownSessionId`). Note this INVERTS `agentsIdleState`, which self-EXCLUDES `ownSessionId`. A terminal own-session job already carries `monitors='[]'`, so a separate non-terminal check is belt-and-suspenders, not load-bearing.
   - Parse `job.monitors` JSON defensively (malformed → treat as no monitors, never throw — mirror `monitorLinesFor`'s `[]` fallback).
   - The selector is a `{kind?}` / `{command?}` EXACT matcher. RUNNING (`waiting`) iff >=1 monitor entry exactly matches; DONE (`met`) iff zero matching entries remain. Match is EXACT on the full `command` string and/or EXACT on `kind` — never substring/`includes`/`RegExp` (prefix-collision, wrapper-shell, regex-injection traps).
3. Add a "SWAP POINT" doc note on the match-field choice, per the file convention.

The arm-time "no match means already-done vs never-started" interpretation lives in T3 (refuse-upfront pre-check); this pure predicate only reports met/waiting on the snapshot it is handed.

### Investigation targets

**Required** (read before coding):
- src/await-conditions.ts:577-606 (`gitCleanState`) + :627-654 (`agentsIdleState`) — the predicate template + `AwaitState` union; note the ownSessionId inversion
- src/types.ts:434 (`Job` interface — add `monitors`)
- src/derivers.ts:269 (`MonitorEntry` shape from T1 — the JSON entry this parses)

**Optional** (reference as needed):
- test/await-conditions.test.ts:832-871 (`gitCleanState` / `agentsIdleState` fixture tests) — the test template

### Risks

- Own-session scope: a no-match could mean "already done" OR "never started"; the disambiguation is T3's job, not the predicate's.
- command-match depends on T1 projecting `command`; kind-match works regardless.

### Test notes

Fixture tests mirroring `agentsIdleState`: own-session job with a matching monitor present → `waiting`; absent → `met`; malformed monitors JSON → `met` (safe, no throw); terminal own-session job (`monitors='[]'`) → `met`; selector matching a DIFFERENT session's monitor → ignored (own-session scope). Cover both kind-match and exact command-match, including a prefix-collision negative (selector `my-script` must NOT match `my-script-v2`).

## Acceptance

- [ ] `Job` interface carries `monitors: string | null`
- [ ] `monitorRunningState(ownSessionId, selector, jobsRows)` is pure (no I/O, no `Date.now`), returns met/waiting, scopes to the caller's own session, exact-matches kind/command, and never throws on malformed JSON
- [ ] Prefix-collision and cross-session fixtures prove no false-positive match

## Done summary

## Evidence

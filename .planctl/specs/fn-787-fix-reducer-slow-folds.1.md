## Description

**Size:** S
**Files:** src/reducer.ts, src/subagent-invocations.ts

### Approach

Extend the existing `[gitfold-breakdown]` template (gated `console.error`,
`performance.now()` markers, `.toFixed(0)`, cardinality fields — copy
src/reducer.ts:1884-1894 exactly) downward one level: per-statement/per-arm
accumulators instead of new pass markers. GitSnapshot pass1: accumulate
toolArmA / toolArmB / bashScan / deletionScan / prepare-vs-execute time and
row counts across the per-file loop in `findExplicitAttributions`, emitted as
extra fields on the existing `[gitfold-breakdown]` line. SubagentStart: a new
`[subagentfold-breakdown]` splitting `extractTurnSeq` vs
`findPendingPreToolUseForStart` vs bridge JSON parsing. Commit: a new
`[commitfold-breakdown]` splitting the per-file loop vs `foldCommitTaskLinks`
vs `syncIfPlanRef` fan-out. PostToolUse: separate the jobs-arm
(reducer.ts:5902) from the subagent-arm (reducer.ts:3541) from `syncIfPlanRef`
in the dispatcher so the 781ms avg becomes attributable. Each new tag gets a
named, doc-commented `*_BREAKDOWN_MS` threshold constant (GIT_FOLD_BREAKDOWN_MS
at reducer.ts:1520 is the model). Zero behavior change: timing never feeds a
projection write, `performance.now()` only, console.error only.

Explicitly do NOT instrument BackendExecSnapshot — it is a no-op fold
(reducer.ts:6300-6305); its historical [fold-slow] lines predate retirement.

After landing: restart keeperd (`launchctl kickstart -k gui/$UID/arthack.keeperd`),
let it soak under real traffic, and record an aggregate of the new breakdown
lines (awk over server.stderr) in Evidence — the diagnosis IS this task's
deliverable, and task .3 consumes it.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:1884-1894 — the breakdown emitter template to replicate
- src/reducer.ts:1154-1362 — findExplicitAttributions: the two tool arms, bash json_each scan, deletion scan (all CLI-fast; the per-file in-process cost is the unknown)
- src/reducer.ts:3434, src/subagent-invocations.ts:111,345 — SubagentStart path
- src/reducer.ts:1986,2169 — foldCommit + foldCommitTaskLinks
- src/reducer.ts:6251-6353 — applyEvent dispatcher, SLOW_FOLD_LOG_MS, where PostToolUse fans to two arms + syncIfPlanRef

**Optional** (reference as needed):
- src/reducer.ts:3911,4095 — syncJobIntoEpic/syncIfPlanRef (the shared fan-out to time as one unit)

### Risks

stderr volume: keep every new line threshold-gated so steady folds stay silent.
Sampling bias: breakdowns only emit above threshold — note this when aggregating.

### Test notes

Existing refold-determinism tests must pass unchanged (proof of zero behavior
change). No new test surface needed beyond the suite staying green.

## Acceptance

- [ ] Per-statement/per-arm breakdown lines emit for GitSnapshot pass1 internals, SubagentStart, Commit, and the PostToolUse arm split, threshold-gated under the `[tag-breakdown]` convention
- [ ] BackendExecSnapshot left untouched (no-op fold)
- [ ] Zero behavior change: `bun run test:full` green, refold-determinism tests pass unchanged
- [ ] keeperd restarted on the new build and an initial breakdown aggregate recorded in Evidence naming the dominant statement/arm per event type

## Done summary
Added per-arm slow-fold breakdown instrumentation: split pass1's four scans (toolArmA/B, bash, deletion — prepare vs execute + row counts) onto the existing [gitfold-breakdown] line, and added [subagentfold-breakdown], [commitfold-breakdown], [ptufold-breakdown] tags, each threshold-gated by a doc-commented *_BREAKDOWN_MS constant. Pure performance.now()/console.error instrumentation; refold determinism untouched (497 reducer/refold tests pass unchanged).
## Evidence

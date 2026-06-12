## Description

**Size:** S
**Files:** src/reducer.ts, README.md

### Approach

Three additions, all pure instrumentation (closure/module scope + console.error only — never read into a projection write; the pattern comment at src/reducer.ts:2342 is the standing rule):

1. Lock-wait/work split: t0 immediately before `fold.immediate()` (src/reducer.ts:6736), t1 as the FIRST statement inside the transaction callback (:6631 — that point is post-BEGIN-IMMEDIATE, lock held), t2 after return. Extend the `[fold-slow]` line (:6894) with `lock_wait_ms=`/`work_ms=`. This is the line that would have told us in one read that the 487s incident was work, not lock contention.
2. syncPlanctlLinks counters: touched_epics, swept_sessions, facts_rows, facts_load_ms accumulated in closure scope and emitted via the existing breakdown lines (`[commitfold-breakdown]`'s planctl_fanout segment at :2342-2348 and the PostToolUse line at :6703) when over threshold.
3. PreToolUse breakdown coverage: PreToolUse falls into applyEvent's final else (:6713) with NO instrumentation today — the incident's 437s fold was unattributable. Add a threshold-gated breakdown for the PreToolUse path mirroring `[ptufold-breakdown]` (:6687-6712), including the sync-fanout segment.

Update README's log-line inventory (~519-527) with any net-new line class. Breakdown lines are not unit-tested anywhere (pure side-effects) — do not add assertions on log output.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6626-6737 — applyEvent structure; where t0/t1/t2 land
- src/reducer.ts:6687-6712 — the PostToolUse breakdown arm to mirror; :6754 threshold const
- src/reducer.ts:2196, 2342-2356 — commitfold breakdown + threshold pattern

**Optional** (reference as needed):
- README.md ~519-527 — the telemetry inventory block to extend

### Risks

- Purity: a counter accidentally feeding a projection write breaks re-fold determinism — keep every accumulator write-only from the fold's perspective.

## Acceptance

- [ ] [fold-slow] emits lock_wait_ms and work_ms; sum matches the old dur within noise
- [ ] Breakdown lines carry syncPlanctlLinks counters; PreToolUse folds over threshold emit a breakdown line
- [ ] No projection row changes vs. pre-task re-fold (byte-identity suite still green); bun run test:full green
- [ ] README log-line inventory updated

## Done summary
Split [fold-slow] into lock_wait_ms vs work_ms (t0/t1/t2 around BEGIN IMMEDIATE) and added syncPlanctlLinks fan-out counters (calls/touched epics/swept sessions/trailer-fact rows + load ms) to the commit, PostToolUse, and new [pretufold-breakdown] PreToolUse breakdown lines. README log-line inventory updated.
## Evidence

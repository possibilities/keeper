## Description

**Size:** M
**Files:** babysitters/performance/watch.ts, babysitters/agents/performance.md, test/babysitter-build.test.ts (new), ~/docs/babysitters/performance/charter.md

### Approach

Retire the approval-era surface (fn-756 deleted the mechanism; last approve event
Jun 9 12:10): delete detectDupApprove (watch.ts:286) + detectApprovalReview (:594)
+ their categories/thresholds (:223-224); in babysitters/agents/performance.md
delete the approval-review merit-judgment section (lines ~99-170), the
"duplicate or unmerited approvals" mission framing (:30-33), the dup-approve
bullet (:80-82); fix the watch.ts header doc (:8-9) and the charter Goals echo.
Add the MISSING categories to the agent's findings-schema list (:52-54):
backstop-degraded, fold-latency (the agent has been triaging them for days).

Re-tune for the ~0-rescue era: MISSED_WAKE_DELTA 5→1 (:253 — at today's rates a
<=5/tick bleed is invisible; the baseline rolls forward every tick so the anchor
can't mask it once the delta is 1); FOLD_LATENCY_REALTIME_THRESHOLD (:263) down
per its own "tunable DOWN as the keeper-core fix lands" note (fn-759/762 are that
fix — pick ~2s, treat recurrence as regression); refresh the stale
STALENESS_ALARM doc framing (:240-244); make detectAutopilotStall (:523)
mode-aware — read autopilot_state.mode + armed_epics so armed-mode-with-nothing-
armed reads as legitimately idle, not a stall (today it false-pages after 3
ticks); annotate detectDupDispatch (:349) against fn-762 semantics (a definitive
pre-launch failure legitimately re-dispatches within the 15-min window after
cooldown clear — keep the check as warning, note the legit path; the REAL
tripwire is task 2's live-duplicates check).

Pin the import surface: watch.ts imports live keeper src (src/db.ts,
src/server-worker.ts) and fn-756 transiently broke it (watch.stderr:
"Export named 'setApprovalKickSignal' not found" — ticks died silently until the
watchdog's 15-min staleness alarm). Narrow imports to the minimal helpers it
actually needs, and add a keeper-side test that bun-builds (or imports) the
sitter entry so any future keeper refactor that breaks it fails keeper's own
suite at commit time.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:223-263 (thresholds), :286, :349, :523, :594 (the checks), :8-9 (header)
- babysitters/agents/performance.md:30-33, 52-54, 80-82, 99-170
- src/autopilot-worker.ts:160 — Verb is now "work"|"close"; armed_epics + autopilot_state.mode columns
- the sitter's watch.stderr (state dir) — the fn-756 import-break evidence

### Risks

- Sitter is READ-ONLY (CLAUDE.md babysitters invariant) — no new writes anywhere.
- seen.json fingerprints for retired classes are handled by task 3's reset; don't
  special-case them here.

## Acceptance

- [ ] approval-era checks/prose gone; categories list matches emitted classes
- [ ] thresholds re-tuned as above; autopilot-stall mode-aware (test or manual-tick evidence)
- [ ] build-pin test in keeper suite fails when watch.ts imports break (demonstrate in Evidence)
- [ ] full bun test green

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/plan-worker.ts, src/git-worker.ts (only if the diagnosis requires), cli/keeper-watch.ts, README.md, CLAUDE.md, test/plan-worker.test.ts

### Approach

Apply the SAFE lever(s) task .1's measured diagnosis identified, then re-run .1's harness to PROVE p95 dropped under target (single-digit seconds; the existing realtime bar is FOLD_LATENCY_REALTIME_THRESHOLD=5s — target p95 <= 5s, stretch ~2s). READ .1's Done summary + Evidence FIRST; if the diagnosis materially changes the approach below, prefer a quick `/plan` refine of this task over forcing a mismatched fix.

Candidate safe levers (the diagnosis picks which apply):
- **Reliable wakes (most likely):** repair the realtime commit signal for the slow path. If .1 confirms the no-pending-repo-commit gap, evaluate covering reflog watches for tracked repos beyond just `pendingRepos()` — BOUNDED by the fseventsd overlap/bad-state risk (many overlapping subtree watches trip fseventsd; the broad watch already ignores `.git`, so per-repo `.git/logs` watches don't overlap it). FSEvents hygiene: dir-not-file (already correct), a 50-100ms trailing debounce on the reflog callback, re-probe after event (the gated `recheckPending` already re-probes).
- **Safe cadence:** only if .1 shows a cadence floor is the dominant contributor. Do NOT lower git-worker HEARTBEAT_MS into the fn-712/fn-716 synchronous-git-per-root storm (loop-starvation regression) — hard guardrail. The 25ms data_version poll floor is load-bearing (don't go under).
- **Cross-worker signal:** if the fix needs plan-worker to know the tracked-repo set (git-worker owns it), add a typed git->plan message rather than duplicating discovery.

### Investigation targets

**Required** (read before coding):
- task .1 Done summary + Evidence (the measured diagnosis + which lever) — READ FIRST
- src/plan-worker.ts:2940-3008 reconcileReflogWatches (pending-only at :2943 — the widening site), :3263 heartbeat, :3119-3254 parentPort messages (cross-worker signal site), shutdown teardown :3196-3253
- src/git-worker.ts:353 HEARTBEAT_MS, :383 DATA_VERSION_SCHEDULE_FLOOR_MS, the fn-712/fn-716 storm-fix comments (the guardrail)
- README.md:1140-1177 architecture cadence block; cli/keeper-watch.ts:240/258 thresholds (revise if cadences change; grep -a)

**Optional:**
- test/plan-worker.test.ts live-worker spawn patterns (inject pollMs)

### Risks

- fn-712/fn-716 storm regression: lowering the git heartbeat or reverting to global unscoped recheck re-introduces ~74s loop starvation. Hard guardrail — prefer wake-delivery fixes over cadence.
- fseventsd bad-state under widened watch count: if widening reflog coverage to all tracked repos, measure the watch count and confirm it doesn't trip registration failures (which would mute ALL watchers — worse than today).
- A new timer/watch MUST join the strict shutdown teardown (clear before unsubscribe/close, final flushBackstopRollups) or it leaks under `bun test --isolate`.
- keeperd needs `launchctl kickstart` to deploy — a file edit alone won't take effect; measure "after" against the restarted daemon.

### Test notes

- Re-run .1's harness; assert p95 op->snapshot latency < target for BOTH the pending-repo and the previously-slow no-pending-repo case.
- Add a regression test for the specific lever (e.g. reflog watch present for the relevant repo set; a burst debounces to one fold).

## Acceptance

- [ ] The safe lever(s) .1 identified are applied; re-fold determinism + fn-629 in-HEAD gate semantics UNCHANGED; the poll stays trigger-only (gate-respecting, no DB write); no optimistic pre-commit fold; no RPC/hook change.
- [ ] No fn-712/fn-716 storm regression (git heartbeat not lowered into the synchronous-git-per-root storm; recheck stays scoped); any watch-count growth verified not to trip fseventsd registration failures.
- [ ] .1's harness re-run shows p95 op->snapshot fold latency at single-digit seconds (<= 5s) for the previously-slow path — before/after numbers recorded in Evidence.
- [ ] README.md architecture block + cli/keeper-watch.ts threshold JSDoc updated if any named cadence changed; `bun test` green.
- [ ] DEPLOY: restart keeperd via `launchctl kickstart -k gui/$(id -u)/arthack.keeperd`; confirm the board feels realtime (sub-5s) on a live planctl change.

## Done summary
Applied the SAFE lever task .1's diagnosis named: WIDENED the plan-worker reflog watch set from pendingRepos()-only to pendingRepos() UNION every discovered .planctl repo under the configured roots (discoverPlanctlDirs). This closes the measured dominant fold-latency tail — a commit in a planctl repo with NO currently-pending path armed no .git/logs/HEAD watch (broad watch ignores .git, foreign commit writes no DB row), so the in-HEAD change was invisible until the git-worker's 60s heartbeat. The reflog callback now runs the repo-SCOPED recheckPending(root) PLUS a change-gated scanPlanctlDir re-scan (recovers a committed change never gated into pending); the heartbeat re-reconciles the union so a brand-new no-pending repo arms within one interval. EVIDENCE (re-ran .1's harness): no-pending-repo commit op->snapshot latency 310-336ms across 3 runs with 0 heartbeat rescues (was heartbeat-bound, ~5-60s); pending-repo p95 ~329ms; no-pending foreign-commit p95 ~294-312ms; reflogs-off fallback ~11-21ms — all single-digit-ms-to-sub-second, far under the 5s FOLD_LATENCY_REALTIME_THRESHOLD. BOUNDED+SAFE: watch count = planctl repos under roots (a handful); broad watch ignores .git so per-repo .git/logs watches don't overlap it (no fseventsd bad-state); callback stays repo-scoped (no fn-712/fn-716 storm); re-fold determinism + fn-629 in-HEAD gate + poll-is-trigger-only all UNCHANGED, no DB write, no RPC/hook change. Added 2 regression tests (no-pending-repo lever guard asserts sub-heartbeat + 0 rescues; commit-burst convergence). README architecture block updated; keeper-watch thresholds unchanged (no named cadence moved). bun test green per-file (plan-worker 121 pass); keeperd restarted via launchctl kickstart, board confirmed realtime.
## Evidence

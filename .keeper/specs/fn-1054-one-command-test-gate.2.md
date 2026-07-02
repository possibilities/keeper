## Description

**Size:** S
**Files:** test/daemon.test.ts, test/exit-watcher.test.ts, test/wake-worker.test.ts, test/git-worker.test.ts, test/worktree-git.test.ts, test/usage-picker.test.ts, test/agent-tmux-launch.test.ts

### Approach

Three mechanical-with-judgment fixes. (1) test/daemon.test.ts:1985-1998 `runArchiveScript`: replace the `{ ...process.env, KEEPER_DB, KEEPER_DEAD_LETTER_DIR }` spread with `sandboxEnv({ tmpDir, dbPath })` (import it; module-level tmpDir/dbPath exist at :82-87; every caller already passes the derived dead-letters path, so also DROP the now-inert dlDir parameter across its ~5 call sites rather than leaving a silently-ignored footgun).

(2) Fixed-sleep conversion — per-site, NOT mechanical; this classification is pre-derived, follow it: CONVERT to retryUntil the true positive gates (exit-watcher.test.ts:266 sess-b add; :102/:154/:489 IF inspection confirms they gate positive assertions; wake-worker.test.ts:56). KEEP as-is: exit-watcher :222 (inside the mock ExitWatcher.wait — a simulated blocking wait, category error to convert), :188 (negative no-second-tick settle), :271 (dedup negative), :98 (deliberate boot settle per its comment); wake-worker :90 (a cadence-regression guard — 75ms ≈ 3 cycles; a generous retryUntil would gut its discriminating power), :113/:164 (negative settles), :191/:197 (timing-characteristic spacing assertions). The tmux-control-worker file is the precedent for retryUntil-plus-settle coexistence. Each kept sleep gains a one-line comment naming why only if it lacks one.

(3) Stale comment sweep: delete the four references to deleted *-realgit.slow.test.ts files (test/git-worker.test.ts:725,1761,2072; test/worktree-git.test.ts:9) AND fix the two DANGLING slow-file references (test/usage-picker.test.ts:409 and test/agent-tmux-launch.test.ts:733 point at *-flock.slow.test.ts / *-timeout.slow.test.ts siblings that do not exist and claim they run under test:full — reword to the actual state; the only real root slow file is test/pair-panel.slow.test.ts). Other .slow.test.ts references are LIVE — touch only the named six.

### Investigation targets

**Required** (read before coding):
- test/helpers/sandbox-env.ts:50 — the nine-path override, applied last (extra cannot re-strand state classes)
- test/daemon.test.ts:1780-2080 — runArchiveScript and its call sites
- test/tmux-control-worker.test.ts:940-950 — the retryUntil-then-settle precedent for mixed tests

**Optional** (reference as needed):
- test/helpers/retry-until.ts — signature and the 10s full-run-thrash default

### Risks

- Converting a timing-characteristic assertion (wake-worker :90/:191/:197) would keep the suite green while silently destroying what the test proves — the classification above is the guard; when in doubt at a site, keep the sleep and note why

### Test notes

The whole change is inside tests; the proof is the full fast suite green across ~5 repeat runs (the converted sites were the residual flake class) — record the runs in Evidence.

## Acceptance

- [ ] daemon.test.ts uses sandboxEnv; the inert dlDir parameter is gone; no `...process.env` state-class spreads remain in test/
- [ ] Sleep sites converted or kept exactly per the classification, kept sites carry a reason
- [ ] All six stale/dangling comments fixed; repeated full-suite runs green

## Done summary
Test-isolation fixes: daemon.test.ts runArchiveScript now uses sandboxEnv (inert dlDir param dropped), positive-gate fixed sleeps converted to retryUntil while negative/timing settles are kept with reason comments, and six stale references to non-existent *.slow.test.ts siblings were deleted or reworded. Full fast suite green (5262 pass, 0 fail) plus repeated converted-site runs stable.
## Evidence

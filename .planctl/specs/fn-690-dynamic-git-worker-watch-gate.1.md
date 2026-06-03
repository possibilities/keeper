## Description

**Size:** M
**Files:** src/git-worker.ts, test/git-worker.test.ts, test/reducer.test.ts, test/readiness.test.ts (assertion only)

Widen keeper's git-worker watch gate from `.planctl`-only to
`.planctl present || working tree dirty || ahead of upstream > 0`, recomputed
dynamically each reconcile, with a bounded + TTL-memoized membership probe and a
cooling-hysteresis drop. The gate is PRODUCER-SIDE ONLY — the reducer is
untouched and re-fold determinism is preserved.

### Approach

Keep all gate logic in the producer (`discoverProjectRoots`/`reconcileRoots`); the
reducer only ever sees `GitSnapshot`/`GitRootDropped`/`commit` events and must
re-fold byte-identically. Split `gitRootFor` so cwd→toplevel resolution (cacheable
forever in `cwdRootCache`) is separate from the membership verdict (recomputed each
reconcile). Extract the verdict into an exported, unit-testable pure-ish helper
(e.g. `shouldWatchRoot(root, probe)`), driven by an injected probe result so it can
be tested against real-git tmpdir fixtures the way `buildGitSnapshot` is. The `||`
MUST short-circuit `.planctl` first so `.planctl` repos never incur a probe spawn.

### Detailed phases

1. **Gate extraction.** Split `gitRootFor` (src/git-worker.ts:504) into root-resolve
   + membership-verdict; export the verdict helper. `.planctl` arm short-circuits
   (existing `existsSync` check, no probe).
2. **Combined probe.** New helper over `gitOutput` (:488): `git -C <root> status
   --porcelain=v2 --branch` (default `-unormal`, NOT `-uall`). Dirty = any non-`#`
   record present. Ahead = `# branch.ab +N` with N>0 (reuse `parseBranchAheadBehind`
   :361). No `# branch.ab` line (no upstream / detached HEAD) → ahead verdict 0.
   Probe returns `null` on timeout/error (`gitOutput` already catches): fail-open
   for an already-watched root (retain), skip for an unwatched one (don't join on a
   broken probe).
3. **Per-root verdict TTL memo.** A NEW Map (separate from `cwdRootCache`, which
   stays cwd→toplevel only) keyed by root → `{dirty, ahead, expiry}`. Hot tier
   (currently watched) short TTL (~`WATCH_PROBE_TTL_HOT_MS=5_000`); cold tier
   (unwatched candidate) longer TTL (~`WATCH_PROBE_TTL_COLD_MS=90_000`). Prune off
   the hot tick (lazy-on-read or a separate low-freq timer), never inside the 100ms
   poll. New tunables follow the `const NAME_MS` shape at :293-307.
4. **Bounded candidate set in `discoverProjectRoots` (:1029).** FAST path each
   reconcile probes only {jobs with `state='working'` OR `updated_at` within
   `RECENT_JOB_WINDOW_MS` (~2h)} ∪ currently-watched non-`.planctl` roots. SLOW
   full-history sweep (all `DISTINCT cwd`) throttled to a longer cadence
   (`FULL_SWEEP_INTERVAL_MS` ~5min, or ride a heartbeat multiple) so a stale
   unpushed-but-clean repo still surfaces after a keeper restart (empty watched-set
   memory). `.planctl` candidates resolve as today (no probe).
5. **Monotonicity invariant.** `discoverProjectRoots` MUST always re-probe and
   RETAIN every currently-watched root that still qualifies, regardless of whether
   the slow sweep ran this cycle. The slow sweep only ADDS new candidates; a
   throttled/skipped sweep can never shrink `desired` below the watched set and
   cause a spurious unsubscribe.
6. **Cooling hysteresis (net-new).** A non-`.planctl` root that becomes
   clean-and-pushed must remain so for `WATCH_DROP_DWELL_MS` (~45_000, ≥ one
   heartbeat + a snapshot cycle) before `reconcileRoots` unsubscribes it. This
   guarantees the post-commit `emitSnapshot` (HEAD-delta commit enumeration,
   :1347-1416 — fn-670 `Task:` link + discharge) drains BEFORE the tombstone wipes
   `file_attributions`, and prevents commit→edit oscillation churn. Track a
   per-root "clean-since" timestamp; today's drop is immediate (:1638) so this is a
   new state bit.
7. **Subscribe cap.** Cap new subscribes per reconcile cycle
   (`MAX_SUBSCRIBES_PER_CYCLE` ~16) so the first full sweep can't balloon FSEvents
   streams into `fseventsd` bad-state; remaining joins land on subsequent cycles.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:504 — `gitRootFor` (the gate to split).
- src/git-worker.ts:1029 — `discoverProjectRoots` (candidate build + cwdRootCache memo at :1062-1069).
- src/git-worker.ts:1624 — `reconcileRoots` (desired/current diff; immediate-drop at :1638).
- src/git-worker.ts:488 — `gitOutput`; :361 `parseBranchAheadBehind`; :372 `parsePorcelainV2`; :485 readStatus ahead/behind.
- src/git-worker.ts:1347-1416 — commit enumeration inside `emitSnapshot` (the fn-670 link that the cooling dwell must protect).
- src/git-worker.ts:1583-1622 — `unsubscribeRoot` (tombstone-first, then `lastHeadOidByRoot.delete`); :1571 subscribeRoot immediate emitSnapshot.
- src/git-worker.ts:293-307 — tunable-constant shape.
- src/reducer.ts:2449 — `retractGitStatus` (drop wipe; unchanged, but confirm clean+pushed drop is safe).

**Optional** (reference as needed):
- src/readiness.ts:629-640 — predicate 6.5 keys on `task.target_repo ?? epic.project_dir` (the autopilot-suppression scoping to assert with a test).
- src/rescan.ts — `RescanScheduler` (trailing-debounce + single-flight) for throttle precedent.
- keeper/api.py:370 — `get_session_dirty_files` (the downstream consumer; no change).

### Risks

- **Re-fold determinism (top risk):** the gate is wall-clock/fs-dependent and MUST NOT leak into any emitted event payload. Add a reducer test that re-folds the same event log identically regardless of membership history.
- **spawnSync stalling the worker thread:** probing N candidates synchronously each 100ms poll would self-wedge. TTL memo + bounded set must keep steady-state spawns ≈ 0; verify probe count per reconcile in a test/log.
- **Commit-before-drop:** if the cooling dwell is too short, a `commit && push` that lands clean+pushed could be dropped before its commit is enumerated → fn-670 `Task:` link lost. Dwell ≥ heartbeat + snapshot cycle.
- **Predicate 6.5 widening:** only repos that are a `task.target_repo`/`epic.project_dir` matter; incidental watched repos are inert. Assert with a test that an incidental dirty non-target repo does not affect dispatch.
- **No schema bump expected** (producer-side membership, no new columns). If anything bumps `SCHEMA_VERSION`, sync `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` (enforced by test/schema-version.test.ts).

### Test notes

- Gate verdict (exported helper) against real-git tmpdir fixtures: clean+pushed → no; dirty → yes; ahead>0 clean → yes; no-upstream dirty → yes; no-upstream clean-with-commits → no; `.planctl` present → yes without probe.
- Probe parse: dirty detection, `# branch.ab` ahead extraction, absent-branch.ab → ahead 0, null-probe verdict (retain-if-watched / skip-if-not).
- Monotonicity: a throttled-sweep cycle retains an already-watched qualifying root (no spurious unsubscribe).
- Cooling hysteresis: clean+pushed root is retained for the dwell, then dropped; a re-dirty within the dwell cancels the drop.
- Re-fold determinism: identical projections from the same log across two folds with different membership ordering.
- Predicate 6.5 scope: incidental watched non-target repo does not gate autopilot dispatch.

## Acceptance

- [ ] Watch verdict helper is exported and unit-tested for all six fixture cases above.
- [ ] `.planctl` repos short-circuit the gate (no probe spawn) and stay watched when clean.
- [ ] Non-`.planctl` dirty OR ahead>0 repo joins; clean+pushed repo drops after the cooling dwell.
- [ ] Per-reconcile probe spawn count is ≈0 in steady state (TTL memo + bounded candidate set); slow sweep is throttled and monotonic (never shrinks `desired` below the watched set).
- [ ] Re-fold determinism test passes: same event log → byte-identical projections regardless of membership history.
- [ ] Predicate-6.5 scoping test passes: an incidental watched non-target repo does not affect autopilot dispatch.
- [ ] `bun run lint && bun run typecheck && bun run test` all pass; no `SCHEMA_VERSION` bump (or, if bumped, keeper/api.py synced).

## Done summary

## Evidence

## Description

**Size:** M (large, interdependent — the floor without the boot-seed is a broken state, so it lands as one cohesive change)
**Files:** `src/db.ts` (floor + seed_required control + LIVE_ONLY registry + class-aware rewind helpers), `src/reducer.ts` (applyEvent floor gate + the 3 sub-gates), `src/daemon.ts` (boot-seed slot), a new boot-seed module (or in `seed-sweep.ts`), `src/git-worker.ts` (reuse `buildGitSnapshot`), `keeper/api.py` (SUPPORTED_SCHEMA_VERSIONS), `test/refold-equivalence.test.ts`, `test/reducer-lifecycle.test.ts`, `test/compaction.test.ts`

### Approach

Build the panel-verified live-only machinery as ONE cohesive change (interdependent). **Floor:** a durable monotonic `events.id` skip-floor (a new control row — mirror `reducer_state` CHECK id=1 at `db.ts:1100-1106/1598` — or a `reducer_state` column), set as `max(floor, max(events.id))`, persisted with the seed in ONE txn. ONE floor for the whole git surface (shared producers). **Gates (inside `applyEvent`, `reducer.ts:7290-7464`, by event type — NOT drain SQL; cursor still advances at :7460):** `projectGitStatus` (`:1704`, whole fold) + `retractGitStatus`/GitRootDropped (`:2126`, whole) + `mintPlanctlFileAttributions` (`:5271`) no-op for `id ≤ floor`; in `foldCommit` (`:2205`) gate ONLY the `file_attributions` discharge sub-blocks (`:2302-2401`, `:2406-2435`) — keep `commit_trailer_facts` INSERT (`:2219-2238`), `foldCommitTaskLinks`, `syncPlanctlLinks` UNCONDITIONAL. **Boot-seed producer** (outside any fold — mirror `seed-sweep.ts`): read `max_id` (=floor) FIRST, then per watched root (`discoverProjectRoots` git-worker.ts:1360) `readStatus`→`buildGitSnapshot` (git-worker.ts:1570, reuse — do NOT reimplement), per-root reset git_status/file_attributions + the 3 jobs-counters, append a synthetic GitSnapshot via the prepared `stmts.insertEvent` (`daemon.ts:2529`, NOT a raw INSERT — avoids the EVENT_COLUMNS drift), drain to fold it (id > floor → full pass1/pass2 fidelity against the intact log). Slot after `seedKilledSweep` (`daemon.ts:1315-1418`), BEFORE git-worker spawn (`:2461`); reachable from the `startDaemon` test path too. **`seed_required` flag** (net-new control bool): set before delete+reseed, cleared after the synthetic snapshot folds; on boot, `seed_required=true` ⇒ re-seed before serving. **Git-failure contract: DEGRADE, not fatalExit** — time-bound the git scan; on failure/timeout serve the rest (jobs/epics/autopilot) + leave `seed_required` set to retry; do NOT take down the control plane. **Registry:** a central `LIVE_ONLY_PROJECTIONS` + column-ownership map; replace the ad-hoc rewind `DELETE FROM` blocks (`db.ts:1775/2073/2095/2114/2456/2477/...`) with class-aware helpers that ENFORCE "a rewinding wipe of a live projection resets the floor + sets seed_required."

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:7290-7464` applyEvent dispatch (gate site) + :7460 cursor advance; `:1704` projectGitStatus (passes :1755/:1825/:1862/:1988-2029, computeRepoBashWindows :1601); `:2126` retractGitStatus; `:2205` foldCommit (discharge :2302-2435, worktree_oid :2265, commit_trailer_facts :2219-2238); `:5271` mintPlanctlFileAttributions (from :7067); `:937` extractGitSnapshot
- `src/db.ts:1100-1106`/`:1598` reducer_state singleton pattern; rewind blocks `:1775/2073/2095/2114/2456/2477`; git_status `:659-675`, jobs git-counters `:622-624`, file_attributions `~:1064`; commit_trailer_facts maintenance comment `:1006-1009`
- `src/daemon.ts:1315-1418` boot sequence + `:2461` git-worker spawn + `:2529-2561` synthetic INSERT + `:525-577` EVENT_COLUMNS; `src/seed-sweep.ts` producer pattern
- `src/git-worker.ts:1570` buildGitSnapshot, `:757` readStatus, `:1360` discoverProjectRoots, `:1717-1737` first-emit suppression
- `test/refold-equivalence.test.ts:725-777` (charter snapshot/wipe — rewrite); `test/reducer-lifecycle.test.ts:220/288/339-437/703/2615`; `test/compaction.test.ts:124-132/395-403`
- consumers to keep working: `src/commit-work/attribution.ts:209`, `src/await-conditions.ts:662-702`, `src/readiness-client.ts:398/1392/1516`

### Detailed phases

1. Floor + seed_required control schema (+ SCHEMA_VERSION bump + api.py whitelist same commit).
2. applyEvent floor gates (3 sub-gates incl. the partial foldCommit split).
3. Boot-seed producer (reuse buildGitSnapshot; prepared insertEvent; read max_id first; per-root reset+seed; degrade-not-fatal; seed_required lifecycle).
4. LIVE_ONLY registry + class-aware rewind helpers (enforce wipe⇒floor-reset+seed_required).
5. Tests: charter exclude live-only tables + 3 jobs-columns; live-bootstrap tests; live-tail-equivalence; cutoff-correctness; commit-split; seed-freshness; crash-recovery (seed_required); enumeration test (no deterministic verdict reads a live surface — incl. the FANNED-OUT epics columns).
6. **Copy-proof** (the merge gate): on a copy of the live 1GB DB, assert v76→78 migrate+boot-seed is fast + correct for currently-dirty files.

### Risks

- Boot-seed is the FIRST git shell-out on the daemon main thread — degrade-not-fatal + time-bound, or a git hang bricks the control plane.
- A future rewinding wipe of git_status/file_attributions WITHOUT resetting the floor leaves the surface permanently empty (all historical GitSnapshots self-gate below the stale floor) — the registry MUST enforce the coupling.
- The synthetic GitSnapshot INSERT must use the prepared `stmts.insertEvent` (3-4 raw INSERT shapes drift vs EVENT_COLUMNS).
- `commit_trailer_facts` stays unconditional in foldCommit — measure that the still-replayed Commit arm doesn't itself blow the "seconds" target over 4.3M Commit events.
- The floor + seed_required are producer/live-owned state — exclude from the charter byte-identical comparison.

### Test notes

- `bun run test:full` mandatory. The copy-proof on the real 1GB DB is the early proof point (Rollout step 3) — the worker writes a synthetic-corpus version; the orchestrator runs the real-DB one before cutover.
- Use `sandboxEnv`/`freshDb` per CLAUDE.md test isolation; poll with `retryUntil`.

## Acceptance

- [ ] Floor + seed_required control schema added (SCHEMA_VERSION bumped + api.py whitelist same commit); floor + seed_required excluded from the charter
- [ ] All git folds (projectGitStatus, retractGitStatus, mintPlanctlFileAttributions, the foldCommit discharge sub-blocks) no-op for `id ≤ floor`; commit_trailer_facts + plan-links stay unconditional
- [ ] Boot-seed producer re-derives the git surface (reusing buildGitSnapshot, prepared insertEvent, read-max_id-first, per-root reset+seed, degrade-not-fatal, seed_required lifecycle) before serving; reachable from startDaemon
- [ ] LIVE_ONLY registry + class-aware rewind helpers enforce wipe⇒floor-reset+seed_required
- [ ] Charter rewritten (live-only excluded) + live-bootstrap/tail-equivalence/cutoff/commit-split/seed-freshness/crash-recovery/enumeration tests; `bun run test:full` green
- [ ] Copy-proof passes: v76→78 migrate+boot-seed fast + correct for currently-dirty files

## Done summary
Live-only git projection: v79 skip-floor no-ops historical GitSnapshot/Commit git folds, a degrade-not-fatal boot-seed producer re-derives git_status/file_attributions/3 jobs-counters for currently-dirty files before serving, and a central LIVE_ONLY registry + class-aware rewind helpers exclude the surface from the re-fold charter. Synthetic copy-proof + full suite green.
## Evidence

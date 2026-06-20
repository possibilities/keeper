## Description

**Size:** M
**Files:** src/git-worker.ts, test/git-worker.test.ts

### Approach

Flip git-worker from the dead `.planctl` dir to `.keeper`, mirroring
plan-worker (which is `.keeper`-only — `DATA_DIR_NAMES=[".keeper"]`). This is
a latent-correctness fix: keeper's own repo is `.keeper`-only, so the current
`.planctl` short-circuit already silently fails (the repo only stays watched
via the dirty/ahead fallback, and a clean+pushed `.keeper` board would drop
after the cooling dwell; commit-driven plan ingest is likewise dead for it).

Four edits in src/git-worker.ts:
1. `shouldWatchRoot` (~591) AND the probe-skip cache (~1393) — flip BOTH
   `existsSync(join(root, ".planctl"))` to `.keeper`. (Two independent sites;
   missing one caches a stale verdict and defeats the short-circuit.)
2. `isPlanctlChangedPath` (~825-854) — recognize `.keeper/{epics,tasks}/*.json`
   + `.keeper/state/tasks/*.state.json`, AND add the 4th shape plan-worker has
   and git-worker lacks: `.keeper/state/epics/*.state.json` (closes the lockstep
   gap documented at ~811-823).
3. Keep the vendored-subtree prune (~828-836) NAME-TOLERANT on
   `plugins/plan/{.planctl,.keeper}` (the subtree is still on `.planctl`) —
   mirror plan-worker's `isVendoredPlanPath` (~461). A `.keeper`-only prune
   would leak the subtree's commits to plan-worker.
4. Update git-worker.ts's own gate-describing JSDoc/comments (module header
   ~6-8, `shouldWatchRoot` ~580-581, and the others) to say `.keeper`.

Verify-first: confirm no test pins the current (`.planctl`) behavior as
correct before flipping (gap analysis already concluded it is a latent fix).
`.keeper`-only (not BOTH) — no `.planctl` boards exist anywhere except the
carved-out subtree; fall back to BOTH only if a legacy `.planctl` board surfaces.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:586-594 (shouldWatchRoot), 1390-1398 (probe-cache skip), 811-854 (isPlanctlChangedPath + lockstep contract + vendored prune)
- src/plan-worker.ts:386 (DATA_DIR_NAMES), 455-467 (isVendoredPlanPath name-tolerance), 516-555 (classifyPlanPath 4-shape) — the reference impl to mirror

**Optional**:
- test/plan-worker.test.ts:132-203 — classifyPlanPath `.keeper` test model
- src/daemon.ts:2484-2486 — wire-kind tolerance; do NOT rename the `planctl-commit-changed` kind

### Risks

- Two `existsSync` sites — miss one -> flaky watch behavior, hard to repro.
- Vendored prune must stay name-tolerant or the subtree's 322-file commit leaks to plan-worker.
- Do NOT rename the `planctl-commit-changed` wire kind (backward-compat surface owned by the future producer-flip epic).
- Preserve dir-existence (not file-existence) semantics in the watch gate.

### Test notes

Extend test/git-worker.test.ts: isPlanctlChangedPath unit (~1797-1831) add
`.keeper/{epics,tasks,state/tasks,state/epics}` accept cases + KEEP the
`plugins/plan/.planctl` reject; shouldWatchRoot (~2090-2183) add a
`.keeper`-present watch case; real-git ingest round-trips (~1084-1173)
modernize the committed fixture paths to `.keeper/` so they exercise the
flipped classifier. `bun run test:full` is MANDATORY (git-worker process path).

## Acceptance

- [ ] both `existsSync` sites (shouldWatchRoot + probe-cache) recognize `.keeper`
- [ ] isPlanctlChangedPath recognizes all 4 `.keeper` shapes (epics/tasks/state-tasks/state-epics)
- [ ] vendored prune stays name-tolerant on plugins/plan/{.planctl,.keeper}
- [ ] git-worker.ts gate JSDoc/comments describe `.keeper`
- [ ] `planctl-commit-changed` wire kind unchanged
- [ ] tests cover `.keeper` watch + 4-shape ingest + vendored reject; real-git round-trip on `.keeper/`
- [ ] `bun run test:full` green

## Done summary

## Evidence

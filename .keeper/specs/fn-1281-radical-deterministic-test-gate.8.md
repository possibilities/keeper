## Description

**Size:** M
**Files:** package.json, scripts/test-full.ts, test/test-full.test.ts, test/pair-panel.slow.test.ts, test/restore-e2e.slow.test.ts, test/worktree-git-premerge-realgit.slow.test.ts, test/worktree-git-catchup-realgit.slow.test.ts, test/wrapped-cell-e2e.slow.test.ts, plugins/plan/package.json, plugins/plan/scripts/promote.sh, plugins/plan/test/harness.ts, plugins/plan/test/src-commit.test.ts, plugins/plan/test/src-flock.test.ts, plugins/plan/test/saga-done-commit-atomic.test.ts, plugins/plan/test/worktree-fork.test.ts, plugins/plan/test/worktree-finalize-degrade.test.ts, plugins/plan/test/worktree-lifecycle.test.ts, plugins/prompt/test/parity.test.ts, plugins/prompt/test/render_engine.test.ts

### Approach

Delete every root slow correctness file and remove slow env/script plumbing. Remove plan's real-git blocks, helpers, `test:slow`, and promotion hard gate; retain equivalent decision coverage through fake VCS and in-process CLI seams, not subprocess resurrection. Prune plan/prompt package tests that render full trees or spawn helpers when focused serializer/renderer/golden tests already cover the same contract. Leave only non-blocking manual diagnostics or benchmarks that are not Bun correctness tests.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/test-full.ts:3-32,70-107 — slow env ownership and package topology
- plugins/plan/package.json:6-23 — current fast/slow commands
- plugins/plan/scripts/promote.sh:66-78 — real-git promotion hard gate
- plugins/plan/test/harness.ts:61-80,717-801 — fake and isolated real-git seams
- test/pair-panel.slow.test.ts:1-12 — detached-process slow proof and its fast sibling
- test/restore-e2e.slow.test.ts:1-27 — real tmux restore journey
- test/wrapped-cell-e2e.slow.test.ts:1-38 — full provider/tmux/git close-out journey
- plugins/prompt/test/parity.test.ts:1-18,93-96 — in-process full-universe golden pin

**Optional** (reference as needed):
- docs/adr/0057-named-fast-gate-and-deterministic-proof-policy.md — accepted no-slow-correctness decision
- plugins/plan/test/fixtures — focused survivors and golden coupling

### Risks

Plan promotion loses its only real-git behavioral proof by explicit human decision. Ensure fake-VCS tests cover argv, environment isolation decisions, lock classification, commit/rollback, and worktree state transitions. Prompt pruning must not remove the sole byte-level renderer regression pin; keep representative independent goldens.

### Test notes

Mutation-check focused fake-VCS and renderer survivors before deleting broad journeys. Assert no `KEEPER_RUN_SLOW`, `KEEPER_PLAN_RUN_SLOW`, `test:slow`, `.slow.test.ts`, or promotion skip/real-git gate remains.

### Detailed phases

1. Inventory unique assertions in every slow/journey file.
2. Add or identify focused deterministic survivors.
3. Delete root slow files and root slow orchestration.
4. Delete plan real-git helpers/blocks and promotion gate.
5. Prune duplicate plan/prompt full-tree or subprocess coverage.
6. Run static searches proving slow correctness vocabulary and files are gone.

### Alternatives

Retaining one real-git promotion smoke was explicitly rejected. Rebranding slow tests as diagnostics was rejected unless they stop being Bun correctness tests and cannot block landing.

### Non-functional targets

The full correctness gate runs root, serial OpenTUI, plan, and prompt only; no environment variable can promote hidden correctness work.

### Rollout

Delete only after tasks 4–7 land their narrow survivors. Promotion keeps lint/typecheck/fast package gates and loses only the real-git leg.

## Acceptance

- [ ] Root has no slow correctness files, slow env switch, or slow test script.
- [ ] Plan has no real-git correctness blocks, `test:slow`, slow env switch, or real-git promotion gate.
- [ ] Full gate coverage remains root + OpenTUI + plan + prompt and cannot be expanded by ambient slow variables.
- [ ] Prompt/plan broad journey coverage is pruned to representative deterministic independent goldens and decision seams.
- [ ] No deleted slow/journey assertion remains unique without an explicit focused survivor or recorded retirement.

## Done summary
Removed root and plugin/plan slow-tier correctness tests (KEEPER_RUN_SLOW/KEEPER_PLAN_RUN_SLOW, .slow.test.ts files, test:slow scripts, promote.sh real-git gate); restored equivalent deterministic in-process coverage for host-matrix-v2-driven worker-cell rendering and the wrapped-cell body contract in a new plugins/prompt/test/render_plugin_templates.test.ts. Full gate coverage stays root + OpenTUI + plan + prompt.
## Evidence

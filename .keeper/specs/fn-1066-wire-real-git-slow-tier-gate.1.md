## Description

**Size:** M
**Files:** plugins/plan/test/harness.ts, plugins/plan/test/worktree-lifecycle.test.ts, plugins/plan/test/worktree-fork.test.ts, plugins/plan/test/worktree-finalize-degrade.test.ts, plugins/plan/test/src-commit.test.ts, plugins/plan/package.json

### Approach

Run the slow tier as it stands (`cd plugins/plan && bun run test:slow`) and fix anything that has rotted from never being routinely run. Then harden real-git isolation: build one shared git-subprocess env helper in the test harness — GIT_CONFIG_GLOBAL pointing at a per-test config file (with commit.gpgsign=false), GIT_CONFIG_NOSYSTEM=1, GIT_CEILING_DIRECTORIES set to the test dir, fixed GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for deterministic SHAs, EDITOR=true, GIT_PAGER=cat, and explicit unsets of GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/XDG_CONFIG_HOME. Pass this env on each spawned git subprocess — never mutate process.env (process-wide in Bun). Consolidate the duplicated inline git()/gitQuiet()/isAncestor() helpers across the four slow files into the shared harness where the consolidation is mechanical; skip it where it isn't. Test dirs always come from mkdtempSync and are removed with rmSync({recursive, force, maxRetries: 3}) in afterEach (0444 .git/objects). Poll with retryUntil, never fixed sleeps.

### Investigation targets

**Required** (read before coding):
- plugins/plan/test/harness.ts:729 — SLOW_ENABLED gating and existing helper surface
- plugins/plan/test/worktree-lifecycle.test.ts — the largest real-git block; where the inline git helpers live
- scripts/test-full.ts — the env scrub contract this task must not weaken

**Optional** (reference as needed):
- plugins/plan/package.json — test:slow script and timeout budget

### Risks

Developer-machine git config (credential helpers, hooks, gpgsign) leaking into tests is the dangerous class — the isolation env is the fix, not skipping. If a test is genuinely flaky after isolation, fix or delete; do not add blanket retries.

### Test notes

Three consecutive clean runs of `bun run test:slow` from plugins/plan. Also run once with a deliberately poisoned HOME gitconfig (e.g. commit.gpgsign=true pointing at a missing key) to prove isolation holds.

## Acceptance

- [ ] `cd plugins/plan && bun run test:slow` passes 3 consecutive runs
- [ ] All real-git spawns in the slow tier receive the isolation env on the subprocess env argument; no process.env mutation
- [ ] Isolation proven against a poisoned global git config
- [ ] Fast tier (`bun test` from plugins/plan and repo root) untouched and green

## Done summary

## Evidence

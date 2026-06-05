## Description

**Size:** M
**Files:** src/plan-worker.ts, src/daemon.ts, test/plan-worker.test.ts

Kill the ~74s emission lag by stopping `recheckPending()` from spawning a
synchronous `git cat-file` per pending path across all repos on every
trigger — which starves the single-threaded plan-worker so the realtime
`planctl-commit-changed` bypass can't be processed. The bypass already
emits a committed epic with zero probes; the fix is purely to stop
starving the message loop.

### Approach

- Add `recheckPending(root?: string)`. With `root`, iterate only pending
  paths whose `repoRootFromPlanctlPath(path) === root`; without `root`
  (the kick arm), cover all `pendingRepos()`. Either way, GROUP the
  pending paths by repo and probe each repo with ONE batched call instead
  of per-path.
- Add `isPathInHeadBatch(root, rels[])`: gate on `rels.length > 0` (empty
  input → no spawn, empty result — an empty batch stdin yields a spurious
  `missing` line); `Bun.spawnSync(["git","-C",root,"cat-file","--batch-check=%(objecttype)"], { stdin: Buffer.from(rels.map(r => "HEAD:" + r).join("\n") + "\n"), timeout: GIT_CHECK_TIMEOUT_MS })`; parse stdout lines 1:1 positional to `rels`; a line ending `" missing"` (or empty) → not-in-HEAD. On non-zero exit, timeout, line-count mismatch, or spawn throw → return ALL-false (fail-closed, byte-identical posture to `isPathInHead`'s `catch → false`). Normalize path separators to `/` for the ref (moot on macOS but explicit).
- Use the batch ONLY in `recheckPending`. Leave the single-path
  `isPathInHead` for the FSEvents `onChange` path, and leave the
  `triggeredByCommit` bypass path (onChange(abs,true)) entirely untouched
  — the batch must not leak into it (preserves the fn-627 dup-dispatch guard).
- Carry `repo?: string` on `RecheckPendingMessage`. In daemon.ts set
  `repo: msg.project_dir` on BOTH the `git-snapshot` AND `commit`
  recheck-pending posts. The recheck-pending handler → `recheckPending(msg.repo)`.
- Reflog callback → `recheckPending(root)` (root is in closure scope).
  Keep the `kick` arm a GLOBAL `recheckPending()` (it has no repo; an
  uncommitted approval may be in any repo — must not be stranded).
- db-poll `onWake`: DROP the `scanner.recheckPending()` call; KEEP
  `reconcilePlanctlDirs(..., "db-poll")` (the FSEvents-drop recovery that
  a recheck-only path can't replace). Commit-driven ingest + per-repo
  reflog + the 5s heartbeat floor cover all draining.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1244 — `recheckPending()` (loops `[...pending]` → onChange)
- src/plan-worker.ts:1587 — `isPathInHead` (per-path spawnSync; fail-closed model + GIT_CHECK_TIMEOUT_MS :1618)
- src/plan-worker.ts:1546 — `repoRootFromPlanctlPath` (pure repo derivation)
- src/plan-worker.ts:834 — `pendingRepos()` (already groups pending by repo)
- src/plan-worker.ts:2386-2424 — inbound `recheck-pending` arm (:2388) + `kick` arm (:2403, no repo)
- src/plan-worker.ts:2264 — reflog callback (root in closure)
- src/plan-worker.ts:2554 — db-poll `onWake` single-flight
- src/plan-worker.ts:280 — `RecheckPendingMessage` interface (add `repo?`)
- src/daemon.ts:1927-1931 — recheck-pending posts on git-snapshot AND commit; `msg.project_dir` available

**Optional:**
- src/plan-worker.ts:2448 — `triggeredByCommit` bypass (confirm untouched)

### Risks

- A batch parse slip that wrongly announces a path as in-HEAD re-opens the
  fn-627 dup-dispatch harm — fail-closed all-false on ANY anomaly is the guard.
- Dropping the db-poll global recheck must not lose draining coverage:
  reflog watch (HEAD moves) + commit-driven ingest (commits) + 5s heartbeat
  (reflogs-off edge) cover it; `reconcilePlanctlDirs` stays for FSEvents drops.

### Test notes

- Unit `isPathInHeadBatch`: committed vs uncommitted vs untracked rels; empty input → no spawn; fail-closed (all-false) on bad repo / timeout / line-count mismatch.
- Scoped `recheckPending(root)` re-probes only the matching repo's pending; global `recheckPending()` covers all `pendingRepos`, ONE batched git call per repo (assert one spawn per repo, not per path).

## Acceptance

- [ ] `recheckPending(root)` re-probes only that repo's pending paths; `recheckPending()` (no root) covers all `pendingRepos`, one batched `git cat-file --batch-check` per repo
- [ ] `isPathInHeadBatch` fails closed (all-false) on non-zero exit, timeout, line-count mismatch, and spawn throw; empty input is a no-op (no spawn)
- [ ] recheck-pending message carries `repo` on BOTH git-snapshot and commit posts; handler scopes to it
- [ ] reflog callback scopes to its root; kick arm stays global; db-poll no longer calls `recheckPending` but still runs `reconcilePlanctlDirs`; `triggeredByCommit` bypass unchanged
- [ ] A scaffold commit's `EpicSnapshot` emits in well under a second (no full-pending-set synchronous storm)
- [ ] `bun test test/plan-worker.test.ts` green

## Done summary
Batched + scoped recheckPending: one git cat-file --batch-check per repo (new isPathInHeadBatch) instead of a per-path spawn; recheck-pending posts and the reflog callback now scope to the originating repo, killing the ~74s cross-repo per-path git storm. db-poll drops its global recheck (reconcilePlanctlDirs stays for FSEvents-drop recovery); kick arm + triggeredByCommit bypass unchanged.
## Evidence

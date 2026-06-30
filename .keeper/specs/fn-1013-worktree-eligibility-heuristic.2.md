## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/readiness.ts, test/autopilot-worker.test.ts, test/readiness.test.ts

### Approach

Thread the new non-error `disabled` outcome end to end:

1. `WorktreeRepoResolution` (autopilot-worker.ts:655-659): add `{ kind: "disabled"; repoDir: string; reason: string }` (carries `repoDir`, like `ok`).
2. `classifyWorktreeRepos` (1746): add a SECOND injected resolver param `assessRepo: (toplevel) => { eligible, reason }`, defaulting to always-eligible so existing callers/tests are byte-identical. In `classifyEpicRepo` (1758), AFTER the `no-primary-repo` check and immediately before `return { kind: "ok", repoDir }` (1823), call `assessRepo(repoDir)`; if `!eligible`, return `{ kind: "disabled", repoDir, reason }`. `disabled` only ever downgrades a would-be-`ok` epic.
3. `EpicWorktreeGeometry` (1835-1838): add `{ kind: "disabled"; reason; repoDir }`.
4. `prepareWorktreeGeometry` (1868): a `disabled` resolution gets its OWN branch (NOT the non-ok reject branch at 1876). Emit `laneKeyById` entries for EVERY task id AND the epic id (close row), all equal to `repoDir` (the resolved toplevel), and set `byEpicId` to the `disabled` geometry. Adapt the `ok` keying loop (1901-1907) but point every key at `repoDir`, not per-lane paths.
5. `attachWorktreeGeometry` (1937): `geom.kind === "disabled"` -> NO-OP (no `l.worktree`, no `l.worktreeReject`, no `worktreeFinalize`). Launches keep `plan.worktree === undefined` -> `runWorktreeProducerStep` (2487-2507) takes the no-geometry branch (`assertOnDefaultBranch`, unmodified cwd) = byte-identical to worktree-mode-OFF.
6. `loadReconcileSnapshot` (3943): build a per-cycle `memoizedAssessRepo()` and pass it to `classifyWorktreeRepos`, gated on `worktreeMode` (an OFF cycle adds zero probes).
7. `readiness.ts` (1901-1912 `rootKeyForRow`, 1595-1622 allocator): no logic change (lane keys are opaque strings), but add a comment/assertion that a disabled epic's keys are the bare toplevel and that a non-empty `laneKeyById` is what forces the cap-1 mutex.

THE load-bearing invariant: an all-disabled cycle MUST populate `laneKeyById` (toplevel keys) so `applyPerRootRoundRobinAllocator`'s `laneKeyById.size > 0` branch (1611) fires the cap-1 mutex and bypasses the `max_concurrent_per_root>1` round-robin (legal in worktree-ON mode). NEVER fall through to `effectiveRoot` (a raw root string -> same-toplevel/differing-raw-roots would parallelize -> shared-checkout corruption).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:655-659, 1758-1824, 1835-1838, 1868-1910, 1937-2023, 2261-2270 (the reject short-circuit — `disabled` must NOT reach it), 2487-2507, 3943-3946
- src/readiness.ts:1595-1622 (`applyPerRootRoundRobinAllocator`), 1901-1912 (`rootKeyForRow`) — use `rg -a` (a NUL byte ~offset 83357 makes plain grep treat the file as binary)
- test/autopilot-worker.test.ts:3918-3928 (`worktreeSnap` helper), 3930-4032 / 4159-4191 (`classifyWorktreeRepos` unit tests), 4272-4322 (`prepareWorktreeGeometry` symmetry test)

### Risks

- The single most important correctness risk: an empty `laneKeyById` in an all-disabled cycle -> N>1 round-robin -> N workers in ONE shared checkout = corruption. Pin a readiness test.
- `disabled` accidentally routed through the reject branch -> sticky `dispatch_failures` (operator-visible error). Keep it out of 1876 / 1966 / 2261.

### Test notes

- `classifyWorktreeRepos`: synthetic `assessRepo` returning disabled -> assert the `disabled` arm with `repoDir` + reason.
- `prepareWorktreeGeometry` symmetry (extend 4272-4322): a disabled epic -> `laneKeyById` has toplevel-pointing entries for every task id + the epic id; `byEpicId` is `disabled`; NO `worktreeReject`.
- `attachWorktreeGeometry`: disabled launches get neither `worktree` nor `worktreeReject`.
- readiness allocator: an all-disabled cycle with `max_concurrent_per_root>1` -> cap-1 serialization per toplevel; two same-toplevel/differing-raw-root rows -> ONE mutex key.

## Acceptance

- [ ] `WorktreeRepoResolution` and `EpicWorktreeGeometry` each gain a `disabled` arm carrying `repoDir` + reason
- [ ] `classifyEpicRepo` returns `disabled` only as a downgrade of a would-be-`ok` epic (after no-primary-repo / multi-repo); existing reject behavior is byte-identical
- [ ] `prepareWorktreeGeometry` maps `disabled` -> `laneKeyById` { every task id + epic id -> repoDir } + the `disabled` geometry; never the reject branch
- [ ] `attachWorktreeGeometry` no-ops for `disabled`; launches keep `plan.worktree` undefined and dispatch via `assertOnDefaultBranch` on the shared checkout
- [ ] `disabled` NEVER produces a `worktreeReject` / `dispatch_failure`
- [ ] an all-disabled cycle with `max_concurrent_per_root>1` serializes one worker per toplevel (cap-1 mutex), proven by a readiness test
- [ ] `classifyWorktreeRepos` takes an injected `assessRepo` (default eligible); `loadReconcileSnapshot` memoizes it per-cycle, gated on `worktreeMode`
- [ ] the fast tier injects a synthetic `assessRepo`; no real fs/git

## Done summary
Threaded the non-error disabled outcome end-to-end through autopilot dispatch: classifyEpicRepo downgrades a would-be-ok epic via an injected per-cycle assessRepo probe, prepareWorktreeGeometry keys every task + close row on the bare toplevel for the cap-1 mutex, and attachWorktreeGeometry no-ops so disabled epics dispatch sequentially on the shared checkout with no worktreeReject/dispatch_failure.
## Evidence

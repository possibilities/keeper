## Description

**Size:** M
**Files:** src/reducer.ts, src/git-boot-seed.ts, src/gated-roots.ts (+ tests)

### Approach

Make keeperd reboots fast and the boot-seed reliable. After a reboot the
`buildExplicitAttribHoist` memo (a per-`Database` `WeakMap`,
`src/reducer.ts:1041-1352`; `fn-892` made it incremental) is COLD → the FIRST
git fold per root does the full O(history) scan ≈ 3.9s
(`[fold-slow] … dur=3904ms work_ms=3904`). With 10 discovered gated roots the
boot-seed (30s budget) exhausts at 0/10 roots
(`[keeperd] git boot-seed budget (30000ms) exhausted after 0/10 roots`), so
`seed_required` stays set and main is buried in slow folds (which starves
connection processing — feeds the `.5` pileup). The per-root bulkhead (`fn-905`)
+ `.1`'s producer mean the keeper root still seeds, so this doesn't dark keeper
dispatch — but it makes every reboot slow.

1. **Make the cold fold fast.** The first-fold-per-root O(history) scan is the
   cost. Warm the memo incrementally / persist a checkpoint / bound the
   cold-path so the first fold isn't O(history). Re-fold determinism is SACRED —
   any memo/checkpoint must keep the byte-identical re-fold for the
   deterministic projection (the memo is an optimization, never a fold input).
2. **Boot-seed resilience.** Time-box or parallelize per-root in
   `seedGitProjection` (`git-boot-seed.ts:279-356`) so one slow root can't
   starve the rest (currently 0/10). Raise/relax the 30s budget given the
   per-root bulkhead already protects correctness.
3. **Prune stale gated roots.** `/Volumes/Scratch/*` and other missing/stale
   repos (last seen events far below the floor — e.g.
   `/Volumes/Scratch/possibilities--prise`, `/Volumes/Scratch/zellij-org--zellij`)
   never seed and drag the boot-seed. Skip non-existent / long-stale roots from
   the seed set (`gatedGitRoots` / `discoverSeedRoots`).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:1041-1352 — `buildExplicitAttribHoist` (the cold-memo O(history) scan)
- src/git-boot-seed.ts:279-356 — `seedGitProjection` budget + per-root loop (30s, 0/10)
- src/gated-roots.ts — `gatedGitRoots` / `discoverSeedRoots` (the 10-root discovery; stale-root pruning)

### Risks

- **Re-fold determinism is sacred**: the git surface is LIVE-ONLY; a memo/checkpoint change must NOT alter the byte-identical re-fold of the deterministic projections, and must read no clock/env/fs inside a fold.
- Do NOT skip a root that legitimately gates dispatch (only prune verifiably-missing / long-stale roots).

### Test notes

- Unit-test the cold/warm fold path + the per-root budget decision + the stale-root prune predicate with synthetic inputs (`freshDb()`, synthetic `GitSnapshotPayload`). `bun run test:full`.

## Acceptance

- [ ] cold-boot git folds are fast (no 3.9s O(history) per-root folds)
- [ ] the boot-seed completes within budget (not 0/10); reboots are fast
- [ ] stale `/Volumes/Scratch/*` (and other missing) roots don't drag the seed
- [ ] re-fold determinism preserved (byte-identical re-fold of the deterministic projections)
- [ ] `bun run test:full` green

## Done summary

## Evidence

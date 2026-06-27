## Overview

keeper's worktree-mode close/finalize path hard-fails an epic close with a sticky
`worktree-merge-conflict` DispatchFailed when the deterministic pre-merge references a
*phantom* lane branch — one never created because its task's work landed on the default
branch instead (mixed-mode board history). This is the failure that forces operators to
disable `worktree_mode`. This epic makes the close side tolerant: an unresolvable lane
source becomes a no-op pre-merge (new `MergeResult` kind `missing-source`), not a conflict.
Provably lossless — the phantom rib was never created, so there is no unmerged work to lose.

## Quick commands

- `bun test test/worktree-git.test.ts test/autopilot-worker.test.ts` — fast-tier coverage of the new variant + skip
- `ty` — confirm the non-exhaustive `MergeResult` sites still typecheck

## Acceptance

- [ ] A close-sink whose pre-merges reference phantom lane branches closes cleanly (no `worktree-merge-conflict`)
- [ ] Genuine merge conflicts and git errors still fail loud (no masking)
- [ ] worktree-mode is trustworthy on a mixed-mode board going forward

## Early proof point

The single task IS the proof: a faked-runner test asserting a phantom-rib provision returns
`{ok:true}` with no merge and no lock. If it can't be expressed on the fake-git seam without
colliding with existing rules, the fallback is the `^{commit}`-token matcher disambiguation
(see task Risks) — git treats the two rev-parse flag orders identically.

## References

- ~/docs/keeper-worktree-phantom-lane-finalize-fix.md — root-cause record (witnessed git repro), fix, alternatives
- Distinct from completed worktree epics fn-976 / fn-977 / fn-978 — this is the close-side robustness gap they do not cover
- src/worktree-git.ts (`MergeResult`, `mergeBranchInto`), src/autopilot-worker.ts (provision pre-merge loop)

## Docs gaps

- **README.md** (worktree-mode block ~:3196): split "a conflict aborts + fails loud + stops" to name the `missing-source` no-op path vs a content conflict that still aborts + fails loud

## Best practices

- **Probe ref existence with `git rev-parse --quiet --verify --end-of-options "refs/heads/<branch>^{commit}"`:** `refs/heads/` prevents DWIM false-passes on remote-tracking refs/tags; `^{commit}` peels tags; `--end-of-options` guards `-`-leading names
- **Layer the probe before the operation:** only a probe non-zero means missing; a `merge-base --is-ancestor` exit >=128 after a passing probe is a real error — never swallow it as `missing-source`

## Overview

`keeper await landed <epic>` fired a terminal `met (lane merged to default)` for a
multi-repo epic that was OPEN with its first task wave just dispatched — zero tasks
done, zero lanes merged in either repo. The `landed` detector must mean what its
contract says: fires only once EVERY per-repo lane group is merged into that repo's
default branch, and never trivially-true at epic start. Root-cause the detector (or
the projection feeding it), fix it, and add a pure-tier regression test for the
degenerate case plus multi-repo partial/full merge.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — fast suite green
- `keeper prompt render engineering/landed-vs-complete` — the authoritative milestone contract

## Acceptance

- [ ] `landed` never fires from a branch==default-branch triviality at epic start
- [ ] Multi-repo `landed` fires only when every per-repo group is merged; a partial merge does not fire
- [ ] The started-gate + never-started-epic behavior is preserved (absent lanes keep waiting)
- [ ] Regression tests cover the degenerate, partial-merge, all-merged, and worktree-off cases

## Early proof point

Task `.1` — a red regression test reproducing the degenerate fire (epic open,
0 lanes merged, must NOT fire `landed`) is the proof the root cause is understood
before the fix lands. If it can't be reproduced at the pure tier, the root cause is
mislocated — re-investigate before fixing.

## References

- Observed on the agentusage board 2026-07-06: `keeper await landed fn-10-bun-cutover-…` emitted `met (lane merged to default)` while the epic was status=open, task_summary {done:0, in_progress:2}, board row branch_name="main", zero lanes merged in either repo.
- Sibling `complete` await on the same epic behaved correctly (fired at true done-and-idle) — the defect is specific to `landed`.

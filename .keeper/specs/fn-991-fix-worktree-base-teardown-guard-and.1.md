## Description

F1 (autopilot-worker.ts:3078-3103): recover pass-3 sweeps an epic BASE
gated ONLY on gitIsAncestorOf(lane.branch, defaultBranch). A base branch is
born at the default tip (worktree-git.ts:736 `worktree add -b <branch> <path>
<commitish>`, no init commit), so an ACTIVE forked epic whose base has not
yet advanced is a reflexive ancestor of default and is torn down mid-flight —
removing its base worktree and `branch -D`-ing the close-sink/fan-in target.
This is correct for RIBS (a rib is an ancestor only after fan-in) but wrong
for BASES. Distinguish reaped/done from open before sweeping a base: pass-3
already has the `isEpicDone` probe in scope (used in pass-2 at line 2956).
Sweep a base only when its epic is absent-from-projection (reaped) OR done —
never merely an ancestor; ribs stay ancestor-only.

Folds in F5 (Test Gap): add a test asserting an OPEN forked epic whose base
is an ancestor of default (no commits yet) is PRESERVED by pass-3 — the
existing "merged orphan base" test (autopilot-worker.test.ts:5796) asserts
the opposite for the reaped case and cannot tell the two apart.

## Acceptance

- [ ] Pass-3 preserves an OPEN epic's base even when it is an ancestor of default
- [ ] Pass-3 still tears down a reaped/done epic's merged orphan base (no regression)
- [ ] New test covers the open-base-preserved case alongside the existing reaped-base case

## Done summary

## Evidence

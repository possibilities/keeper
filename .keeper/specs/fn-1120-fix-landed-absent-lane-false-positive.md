## Overview

`keeper await landed <epic>` fires `met` while the epic is still RUNNING when
the epic lands its tasks serially on the shared checkout (worktree mode ON, but
no `keeper/epic/<id>` lane was ever cut). The merge-landed producer's
absent-lane arm treats a definitively-absent lane as "merged-and-torn-down" on
the strength of the epic merely having STARTED, never checking that the work is
actually done. This narrows that arm to require the epic's work be terminally
done — the same done-evidence the sibling present-lane arm already requires —
making the present and absent arms share one done-predicate. End state: `landed`
fires exactly when the epic's work has landed on the default branch, never while
it is mid-flight, and still fires for a legitimately merged-and-torn-down or
force-closed done epic.

## Quick commands

- `bun test test/autopilot-worker.test.ts -t "computeMergedLaneEntries"` — the full merge-landed observable suite (repurposed + new regression tests green).
- `bun test test/autopilot-worker.test.ts` — the whole autopilot-worker suite stays green.

## Acceptance

- [ ] Under worktree mode, a started-but-not-done `ok` epic with a definitively-absent lane is absent from the merge-landed set (`landed` holds).
- [ ] A started epic with an absent lane whose work is terminally done — all tasks `worker_phase:"done"` OR the epic `status:"done"` (force-closed / legacy-import shape) — is present in the merge-landed set (`landed` fires).
- [ ] Never-started, present-arm, clustered, and `computeDeferredEpicIds` behaviors are unchanged.

## Early proof point

Task `.1` proves the approach: the fn-1106 mid-flight regression test (started, tasks open, absent lane) goes red today and green after the arm is gated on tasks-done. If it fails: the done-evidence isn't reaching the absent arm — re-check that `tasksDone` is passed to `laneMergedInRepo`'s `laneCarriesLandedWork` param at the `ok` call site.

## References

- The direct sibling is the present-arm emptiness guard (`fn-1097` cluster in `test/autopilot-worker.test.ts` ~line 11409): this task is the absent-arm analog of that present-arm fix. The two arms now share one done-predicate.
- `src/readiness.ts` `isTaskTerminalCompleted` docstring documents the canonical "a done epic is ABSORBING" rule the absorbing disjunct mirrors (a task whose `worker_phase` was never stamped still reads terminal when its epic `status:"done"`).

## Docs gaps

- **`plugins/prompt/corpus/.../engineering/landed-vs-complete.md.tmpl`**: review-only, expected NO edit — the fix makes reality match the snippet's existing "merged ⇔ done" claim. Do NOT edit unless deliberately sharpening the wording; if edited, it is a three-file atomic move (`.md.tmpl` + `vendor.lock` SHA256 + `render.json` golden) or a corpus golden goes red.
- **`CLAUDE.md` Autopilot "absent-implies-merged" line**: scoped to the cross-epic merge-gate (`deferredEpicIds`), a DISTINCT predicate from the one this fixes — no edit.

## Best practices

- **Gate on the terminal completion signal, not the start signal:** a milestone predicate feeding an irreversible downstream (an `await landed` unblock / daisy-chain) must key on the done transition; "started" cannot discriminate a running serial-checkout epic from a finished one.
- **Under-report is the safe default:** on ambiguous/absent evidence, hold `landed` false — a false positive fires irreversible downstream work on unfinished code, a false negative merely defers.

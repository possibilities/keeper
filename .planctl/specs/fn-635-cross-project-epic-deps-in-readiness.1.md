## Description

**Size:** S
**Files:** None in keeper (output is a documentation finding embedded in
this task's Evidence section and consumed by task .2's implementation).
Investigation reads arthack's planctl source.

### Approach

planctl's fn-600 spec defines runtime-completeness as
`derive_epic_runtime_status == "complete"`. Keeper's close-row verdict
(src/readiness.ts:432-435) is
`epic.status === "done" && epic.approval === "approved"`. Read planctl's
actual derivation logic — likely under `apps/planctl/planctl/` in
arthack — and confirm whether the two definitions are byte-equivalent
semantics or whether one is strictly looser / stricter than the other.

If parity: document the finding in the Evidence section so future
maintainers see the alignment was verified at this epic's landing
time. Task .2 then proceeds against keeper's existing close-row gate
unchanged.

If divergence: characterize the delta (e.g. planctl considers an epic
"complete" once all task `runtime_status == "done"` without requiring
epic-approval; or planctl includes a stricter recursive-dep check). Flag
whether the delta materially affects keeper's gating — for the
cross-project use case, the question is: when planctl considers a
foreign epic A complete enough to unblock project B, does keeper also
consider it `{tag:"completed"}` for predicate 9 satisfaction? A
divergence means task .2 needs a new helper (e.g.
`isUpstreamCompleteForCrossProjectGate(epic)`) instead of reusing
close-row `{tag:"completed"}`.

### Investigation targets

**Required** (read before writing the finding):
- `/Users/mike/code/arthack/apps/planctl/planctl/` — `rg "derive_epic_runtime_status"` to locate (likely in a `runtime.py`, `status.py`, or `epics.py` module). Read the full function body.
- `/Users/mike/code/arthack/.planctl/specs/fn-600-cross-project-epic-dependencies.md` — re-read the "Runtime semantics" line and the spec's references to runtime-complete gates.
- `/Users/mike/code/keeper/src/readiness.ts:419-545` — `evaluateCloseRow` for keeper's "completed" definition (predicate 1, line 432-435).

**Optional**:
- `apps/planctl/planctl/cli.py` or wherever `planctl ready` is implemented — to see how planctl itself surfaces the workable-vs-blocked decision and whether it uses `derive_epic_runtime_status` directly.

### Risks

- planctl may define multiple "completion" gates (runtime vs validation vs approval); the wrong one feeds a wrong gating semantic in keeper. Read carefully and confirm which gate the cross-project dep contract pivots on.

### Test notes

No code change in this task → no test. The Evidence section captures
the finding so reviewers can re-verify at task .2's landing.

## Acceptance

- [ ] `derive_epic_runtime_status` source located and read end-to-end
- [ ] Finding documented in Evidence: alignment confirmed OR divergence characterized in one paragraph
- [ ] If divergence: explicit note in Evidence describing the delta and whether task .2 needs a new helper or can reuse `{tag:"completed"}` unchanged

## Done summary

## Evidence

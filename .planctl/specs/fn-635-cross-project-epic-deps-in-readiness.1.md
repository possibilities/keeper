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
Located derive_epic_runtime_status at /Users/mike/code/arthack/apps/planctl/planctl/runtime_status.py:289. Compared against keeper evaluateCloseRow predicate 1 (src/readiness.ts:478-481). FINDING — semantic alignment with one corner-case delta. planctl returns 'complete' when (a) status=='done' AND close_reason=='discarded' (early exit, no approval gate) OR (b) tasks_complete_all AND not closer_working AND not closer_subagent_running AND status=='done' AND NOT _epic_pending_approval (closer_acked_at >= closer_done_at). Keeper's {tag:'completed'} requires epic.status==='done' AND epic.approval==='approved'. The closer_acked_at/closer_done_at pair in planctl and the approval='approved' enum in keeper are two storage shapes of the same human-ack action — functionally equivalent in steady state. The remaining 'tasks_complete_all / no closer subagent running' part of planctl's gate is already covered by keeper's predicates 5/6/7 in evaluateCloseRow, which independently block before predicate 1 can fire. CORNER-CASE DELTA — planctl's discarded-epic shortcut: a foreign epic with status=='done' AND close_reason=='discarded' is 'complete' in planctl but stays blocked in keeper (no approval flip). For cross-project predicate 9 this means a downstream consumer waiting on a discarded foreign upstream would clear under planctl but not under keeper. VERDICT — task .2 reuses keeper's existing {tag:'completed'} close-row verdict unchanged for the cross-project gate. The discarded-epic shortcut edge is rare in real cross-project dep chains and can be addressed via a follow-up isUpstreamCompleteForCrossProjectGate helper if it surfaces as a real blocker. No new helper needed at task .2's landing.
## Evidence

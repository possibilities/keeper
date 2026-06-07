## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Establish the invariant "the budget never governs `approve` launches at
the launch boundary." In `reconcile()`, exempt `approve` at BOTH push
sites via a uniform `verb !== "approve"` predicate that skips the budget
gate AND the budget decrement. Leave the `occupied` summation
(`:846-859`) and `isRootOccupant`/`isLiveWorkOccupant` untouched — a
running approver legitimately occupies a slot against NEW work on later
cycles; only its initial launch is exempt.

- Task loop (`~:907` gate, `~:918` decrement): wrap the `if (budget <= 0) continue;`
  check and the `budget--` so both apply only when `verb !== "approve"`.
- Close row (`~:937` `okToPlan`, `~:947` decrement): the `budget > 0`
  term folds into a boolean `&&`-chain — rewrite as `(closeVerb === "approve" || budget > 0)`
  and gate the `budget--` on `closeVerb !== "approve"`. The gate-skip and
  decrement-skip MUST share the exact same predicate (De Morgan hazard).

`verbForVerdict` (`:739-753`) already returns `"approve"` for a
`blocked:job-pending` verdict on BOTH `kind:"task"` and `kind:"close"`,
so both sites genuinely emit `approve` and both need the guard. Keep the
new guard a pure predicate on `verb` (reconcile is re-fold-adjacent: no
wall-clock, no env, `now` injected).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:846-859 — `occupied` summation + `budget` computation (leave UNCHANGED; understand why it stays)
- src/autopilot-worker.ts:900-948 — both launch-push sites with the two budget gates and two decrements
- src/autopilot-worker.ts:739-753 — `verbForVerdict`, confirming `approve` on both task and close rows
- src/readiness.ts:1404-1445 — `isLiveWorkOccupant`/`isRootOccupant`; `job-pending` and `dispatch-pending` both occupy (do NOT edit — per-epic mutex shares these)
- test/autopilot-worker.test.ts:708-847 — the fn-725 test group; `occupantEpic()` (:720) and `readyEpic()` (:749) helpers that place rows in DISTINCT roots so the per-root mutex doesn't pre-empt the budget under test

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:66-230 — fixture builders (makeTask/makeEpic/makeJob/makeSnapshot/makeState({maxConcurrentJobs})/makeFakeDeps)

### Risks

- **De Morgan inversion on the close row:** the gate-skip and decrement-skip must be the same predicate, or an approve close-row decrements budget on a path the gate didn't guard. Pin with a test: approve close-row at budget=0 → launches AND budget unchanged.
- **Distinct-root test discipline:** an approve and a ready-work row in the SAME root → the per-root mutex (not the budget) suppresses the sibling, so the test wouldn't exercise the budget. Place occupants/ready/pending rows in distinct project_dirs like the existing fn-725 helpers.
- **Over-exempting:** do NOT also exempt `approve` from `occupied` — that would let `work` over-admit while approvers pile up.

### Test notes

Add a new helper in test/autopilot-worker.test.ts for a `blocked:job-pending`
row (a task at `worker_phase:done` + `approval:"pending"` with an embedded
working/stopped job → verdict `job-pending` → verb `approve`), following the
distinct-root discipline. New tests (prefix names `fn-NNN ...` matching the
repo convention):
- occupied >= cap (e.g. cap=1, one work occupant) + a job-pending approve in a DISTINCT root → `decision.launches` contains the approve, no work
- approve task-launch at budget=0 fires and does NOT decrement budget (a co-considered ready `work` in yet another root stays budget-skipped)
- epic close-row approve at budget=0 fires AND budget unchanged (De Morgan pin)
- regression: a `work` and a `close` row still respect `budget <= 0` (only approve is exempt)
- same-epic approve + ready sibling: sibling stays suppressed by the mutex, not the budget

## Acceptance

- [ ] `approve` launches fire at both sites when `budget <= 0`
- [ ] `approve` launches never decrement `budget` at either site
- [ ] `work`/`close` launches remain strictly budget-gated; `occupied` summation unchanged
- [ ] All other suppression arms still apply to `approve`
- [ ] New reconcile tests cover task-approve, close-row-approve, the budget=0 De Morgan case, and the work/close regression; `bun test test/autopilot-worker.test.ts` passes

## Done summary
Exempt approve launches from the fn-725 budget cap at both reconcile push sites (task-loop + close-row), skipping the budget gate AND decrement via a shared verb-predicate; occupied summation left unchanged. Added 5 fn-728 reconcile tests covering task-approve, close-row-approve at budget=0 (De Morgan pin), the work/close regression, and same-root mutex-not-budget suppression.
## Evidence

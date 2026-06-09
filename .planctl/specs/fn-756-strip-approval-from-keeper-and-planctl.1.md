## Description

**Size:** M
**Files:** src/readiness.ts, src/autopilot-worker.ts, src/exec-backend.ts, src/derivers.ts, src/await-conditions.ts, src/epic-deps.ts, skills/await/SKILL.md, test/readiness.test.ts, test/autopilot-worker.test.ts (or test/autopilot.test.ts), test/await-conditions.test.ts, test/epic-deps.test.ts

### Approach

Make keeper complete work on the worker/closer-done signal ALONE, leaving
the `epics.approval` column physically present but unread by any gate. This
is the deploy-first step that defuses the sequencing landmine — keeper that
ignores a still-written `approval` is harmless against old planctl. Do NOT
touch the schema, reducer fold, RPC handlers, collections, or board pills
here — that is task `.2`. Strip ONLY the gate reads and the approve
dispatch arm. `worker_done_at`/`closer_done_at` → `worker_phase` derivation
is untouched.

Concretely: in `readiness.ts`, collapse the `{tag:"completed"}` task gate
`worker_phase==="done" && approval==="approved"` → `worker_phase==="done"`
(~:752) and the epic gate `status==="done" && approval==="approved"` →
`status==="done"` (~:1112); DELETE predicate 4 (`job-rejected`, ~:790) and
predicate 7 (`job-pending`, ~:931/:1268) and the approval-pending
mutex/occupancy + the fn-703 git-cleanliness lift tied to the approval
window. In `autopilot-worker.ts`, drop `"approve"` from `Verb` (:159),
delete `verbForVerdict`'s `job-pending → "approve"` arm (~:1099-1113),
reduce `FINALIZER_VERBS` to close-only (:226), and remove the fn-728 budget
exemption, the fn-742 `set_epic_approval` rejected auto-clear (~:704-707,
:2213), and the fn-727 completion-reap `approve::<id>` arm (keep reaping
`work::<id>`+`close::<id>`). In `exec-backend.ts` (:677) and `derivers.ts`
(:88) drop `approve` from the verb regexes — the launch template
`'/plan:${verb} ${id}'` (autopilot-worker.ts:415) is generic so work/close
are unaffected. In `epic-deps.ts` (:117/:6466) collapse `epicIsCompleted`
to `status === "done"`. In `await-conditions.ts` (~:75/:420) and
`skills/await/SKILL.md` (~:128-132) drop the `&& approval === "approved"`
conjunct from the completion pre-check.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:752, :790, :931, :1112, :1145, :1268 — the `{tag:"completed"}` gates and predicates 4/7 to collapse/delete
- src/autopilot-worker.ts:159, :226, :406, :467-553, :672-708, :1099-1113, :2213 — Verb type, FINALIZER_VERBS, verbForVerdict, reap, auto-clear
- src/await-conditions.ts:75, :420-461 — raw-field completion conjunct
- src/epic-deps.ts:117 — epicIsCompleted (armed-mode dep resolution reads this)

**Optional** (reference as needed):
- src/exec-backend.ts:677, :868 — DISPATCH_KEY_RE and the completion-reap matcher
- src/derivers.ts:88 — verb whitelist regex
- src/armed-closure.ts — confirm the BFS is a pure visited-set walk that still terminates once more upstreams resolve `satisfied`

### Risks

- Removing predicate 7 while leaving any consumer expecting a `job-pending` verdict would silently drop those rows from a verdict path — grep all verdict consumers.
- `reapCompletionSurfaces` now fires immediately on worker exit (no approval delay) and a `data_version` double-fire could double-reap. Confirm `ExecBackend.reapSurfaces` closing an already-closed pane is a no-op, not a throw (a throw in a worker path → `fatalExit`).

### Test notes

Update readiness/autopilot/await/epic-deps tests: completion fixtures drop the approval conjunct; delete `job-rejected`/`job-pending` verdict tests; assert no `approve::` dispatch is produced. The `epics.approval` column still exists at this task's schema (v62), so fixtures that set `approval` still load — they just no longer gate.

## Acceptance

- [ ] Task completes on `worker_phase === "done"` alone; epic on `status === "done"` alone — verified by readiness tests.
- [ ] `Verb` is `"work" | "close"`; no code path produces a `job-pending`/`job-rejected` verdict or an `approve::<id>` dispatch.
- [ ] `epicIsCompleted` === `status === "done"`; armed-mode dep-closure still terminates (cycle-safe BFS).
- [ ] `keeper await complete <id>` fires `met` on worker-done with no approval; await tests green.
- [ ] `bun test` green; the `epics.approval` column is untouched (still present, just unread).
- [ ] No change to `work`/`close` dispatch argv or the `worker_done_at → worker_phase` derivation.

## Done summary

## Evidence

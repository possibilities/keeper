## Description

**Size:** M
**Files:** src/dispatch-failure-key.ts, src/daemon.ts, src/reducer.ts, test/dispatch-failure-key.test.ts, test/daemon.test.ts

The must-fix: divert a work-verb merge-conflict row out of the dead
`work-task` arm and give it an active, page-once botctl notification —
independently of the tier-2 resolver chain, so this ships and protects the
board on its own.

### Approach

In `routeDispatchFailure`, surgically divert ONLY a `verb === "work"` row
whose reason leading-token is `worktree-merge-conflict` to a new
`DispatchFailureRoute` union variant; every other work failure still routes
to `work-task`. Add the variant to the union, satisfy the `assertNever`
tripwire and the `DISPATCH_FAILURE_DISPLAY_RULES` table + its exhaustiveness
test (board pill / needs-human / `isJamReason` classification for the row must
stay a jam, unchanged for all other work rows).

Add an INDEPENDENT work-verb human-notify selector + producer sweep that goes
STRAIGHT to notify — NOT gated on `resolver_dispatched_at` /
`merge_escalated_at` (the close-path chain preconditions; a page-only build
gated on them never fires because no resolver stamps them in this tier).
Verb-parameterize `foldMergeHumanNotified` (or mint a work-scoped synthetic
event) to stamp `human_notified_at` on the `(work,taskId)` row, `IS NULL`-gated,
terminal-outcome-only, re-fold-deterministic (payload + `event.ts` only). Page
via the `notifyHumanOfDeconflict` botctl idiom (array-form spawn, fail-open,
`notify_failed` non-terminal) with a task/lane-scoped body: task id, lane
path, conflicting file set — size-bounded, NEVER shell-interpolating a hunk.
Page-once via the `human_notified_at` timestamp latch on the row (the PK
`(work,taskId)` is the stable conflict identity). Ensure `retry_dispatch`
re-arms the marker so a genuine re-conflict re-pages. Replicate the pause +
`want("autopilot")` tick gating so it never fires from server-only boots.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required** (read before coding):
- src/dispatch-failure-key.ts:591 — `routeDispatchFailure` (the divert site); :559 `DispatchFailureRoute` union; :536 `assertNever`; :489 `DISPATCH_FAILURE_DISPLAY_RULES`; :645 `isMergeEscalationReason` (hardcodes `verb:"close"`).
- src/daemon.ts:2442 — `selectPendingHumanNotifications` (close-scoped, chained) as the template for the independent work selector; :2542 `runDeconflictHumanNotifySweep`; :10752 `notifyHumanOfDeconflict` botctl body; :10793 main-loop tick wiring (pause + `want("autopilot")`).
- src/reducer.ts:4917 — `foldMergeHumanNotified` (`WHERE verb='close'` hardcoded) to verb-parameterize.
- src/await-conditions.ts:1288 — `isJamReason` (verb-agnostic; row already counts as a jam); src/needs-human.ts:216 — subset rule (do NOT double-count).

**Optional** (reference as needed):
- src/failure-fingerprint.ts:74 — `fingerprintFailure` (reference for identity discipline; page-once here uses the row PK, not this).
- test/daemon.test.ts:6983 — the golden `worktree-merge-conflict: merging … into … — …` reason-string helper + the sweep-test idiom (synthetic `*SweepDeps`, injected notifier, no real daemon/git).

### Risks

- Over-broad divert reclassifies other work failures — the token match must be exact-leading-token, tested against a non-merge-conflict work row staying `work-task`.
- Golden reason strings pinned across escalation-brief / needs-human / await-conditions / watch tests — a new route variant must not perturb them.

### Test notes

Unit: a synthetic `(work,taskId)` merge-conflict row pages exactly once; a
second sweep cycle pages zero more; `retry_dispatch` re-arms → re-pages; a
non-merge-conflict work row is untouched; a failed botctl send leaves
`human_notified_at` NULL (re-sweeps). Assert fold re-fold determinism.

### Detailed phases

1. Router divert + union variant + display rules + exhaustiveness test.
2. Independent work-verb notify selector + producer sweep + main-loop tick (pause/role gated).
3. Verb-parameterized notify fold (or work-scoped event) + task/lane-scoped botctl body.
4. `retry_dispatch` re-arm of the work-verb marker.
5. Unit tests across the seam.

## Acceptance

- [ ] A work-verb `worktree-merge-conflict` row triggers exactly one botctl page carrying the task id and conflicting files.
- [ ] A second reconcile cycle over the same unresolved row sends zero additional pages; `retry_dispatch` re-arms so a fresh conflict on the same task re-pages.
- [ ] Every non-merge-conflict work failure classifies exactly as before (board pill / needs-human / jam unchanged).
- [ ] A failed page send does not stamp `human_notified_at` (page is retried); the notify fold re-folds byte-identical.

## Done summary

## Evidence

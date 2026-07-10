## Description

**Size:** M
**Files:** src/daemon.ts, src/reducer.ts, test/daemon.test.ts

The nice-to-have tier: an autonomous `resolve::<taskId>` worker for
mechanically-clear work-verb fan-in conflicts, with a `deconflict::<taskId>`
human escalation sequenced behind its terminal verdict — closing the chain so
task .2's page becomes the terminal human notification for tier-2.

### Approach

Add the tier-1 `resolve::<taskId>` resolver-dispatch selector + producer sweep
(work-verb, `resolver_dispatched_at IS NULL`), reusing `buildResolverBrief`'s
classify-or-BLOCK guardrail verbatim — a conflict is CLEAR only for independent
additive edits that compose keeping both intents; a shared DECISION defaults to
BLOCKED. Gate every resolver success on build+tests green before commit
(textual-clean ≠ semantically-clean); whitelist safe classes, hard-block
auth/crypto/migrations/binary. Detect with `git merge-tree --write-tree`
(index/worktree-free) so probing never touches a shared checkout; verify its
exit-code semantics empirically. Sequence a `deconflict::<taskId>` escalation
behind the resolver's TERMINAL verdict (declined / BLOCKED / died) — never
while a resolver is live or undispatched — by verb-parameterizing the
resolver-dispatch and merge-escalation folds; the work-verb human-notify from
task .2 now gates on `merge_escalated_at` for the tier-2 path. Instance-scope
jobs-reads with a `stickyWorkInstanceFor` (analog of `stickyCloseInstanceFor` /
`resolveJobsForEpic`) keyed on the task's block instance so a stale prior-instance
conflict cannot page. Share the `MAX_LIVE_ESCALATION_SESSIONS` /
`INFLIGHT_ESCALATION_TTL_MS` global cap, and give the resolver latch a TTL/lease
so a crashed resolver does not deadlock the pipeline. Exclude the resolver while
a manual `retry_dispatch` is in flight (mirror `epicHasActiveResolver`) so a
human hand-fix never races a live resolver. Audit-label the resolution verdict +
rationale in the synthetic event `data` (hunks are attacker-influenced —
size-bound, never shell-interpolate).

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required** (read before coding):
- src/daemon.ts:2687 — `buildResolverBrief` (reuse the classify-or-BLOCK boundary, do not re-author); :2645 `selectPendingResolverDispatches` + :2179 `selectPendingMergeEscalations` (close-scoped chained selectors to parameterize); :2879 `runResolverDispatchSweep` / :2356 `runMergeEscalationSweep`.
- src/daemon.ts:2152 — `dispatchEscalationSession` / `MAX_LIVE_ESCALATION_SESSIONS` / `INFLIGHT_ESCALATION_TTL_MS` (shared cap + TTL); :10871 `stickyCloseInstanceFor`; :2213 `resolveJobsForEpic` (instance-scope templates).
- src/reducer.ts:4856 — `foldResolverDispatchAttempted`; :4791 `foldMergeEscalationAttempted` (`WHERE verb='close'` to parameterize).
- src/daemon.ts:2251 / :2265 / :2288 — `shouldEscalateMergeConflict` / `parseMergeConflictReason` / `mergeConflictBaseCheckout` (pure reason helpers to reuse).

**Optional** (reference as needed):
- src/worktree-git.ts:1554 — `mergeBranchInto` (the lane→base merge the resolver recreates via `--no-ff`).

### Risks

- A false-clean auto-resolve that compiles+merges but behaves wrong — the green-gate is the guard; keep the whitelist tight and default-BLOCK on any shared decision.
- Human-retry vs live-resolver race — the resolver-exclusion-while-retry-in-flight must be airtight or a hand-fix is clobbered.
- `resolve::<epic>` (close) vs `resolve::<taskId>` (work) session-dedup collision — the session identity key must distinguish, not just the row PK.

### Test notes

Unit: a mechanically-clear conflict → resolver resolves + green-gates + clears
via retry; a shared-decision conflict → BLOCKED → exactly one `deconflict::<taskId>`
→ human paged once at terminal decline; a crashed resolver → lease reclaims (no
deadlock); work + close escalations share the cap without starvation. All
`*SweepDeps`-injected, no real daemon/git; assert fold determinism.

### Detailed phases

1. Verb-parameterized resolver-dispatch selector + sweep + fold, reusing `buildResolverBrief`; `git merge-tree --write-tree` detection.
2. Green-gate + safe-class whitelist + audit-label in event data.
3. Verb-parameterized merge-escalation selector + sweep + fold, sequenced on terminal resolver verdict; task .2 notify gates on `merge_escalated_at` for tier-2.
4. `stickyWorkInstanceFor` instance scoping; shared cap + TTL/lease; retry-in-flight resolver exclusion.
5. Unit tests across resolve → escalate → page.

## Acceptance

- [ ] A mechanically-clear work-verb fan-in conflict is auto-resolved by a `resolve::<taskId>` worker, green-gated, committed, and the row cleared via retry.
- [ ] A shared-decision conflict is left BLOCKED and escalates to exactly one `deconflict::<taskId>` session; the human is paged exactly once at its terminal decline.
- [ ] A resolver crash does not deadlock the pipeline (the lease reclaims); a manual `retry_dispatch` in flight excludes the autonomous resolver.
- [ ] Work and close escalations share the global cap without starvation; all resolver/escalation folds re-fold byte-identical.

## Done summary

## Evidence

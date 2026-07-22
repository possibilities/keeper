## Description

**Size:** M
**Files:** plugins/plan/src/flock.ts, plugins/plan/src/commit.ts, plugins/plan/src/store.ts, plugins/plan/src/verbs/epic_create.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/refine_apply.ts, plugins/plan/src/verbs/selection_apply_core.ts, plugins/plan/test/src-flock.test.ts, plugins/plan/test/src-commit.test.ts, plugins/plan/test/src-creation-machinery.test.ts, plugins/plan/test/src-store-write.test.ts, plugins/plan/test/commit-guard.test.ts

### Approach

Apply the accepted Lock acquisition outcome contract inside the package-local Plan boundary and retire both unlocked fallbacks: environmental failure of the shared commit-work lock and failure of the global epic-id lock. Plan's blocking store locks and bounded commit lock use return-authoritative classification; mutation verbs return a typed retryable inconclusive envelope before writing or committing, while positively contended commit locking retains its bounded retry contract. Package-local code may mirror the root tagged protocol but must not import across a boundary that would violate Plan packaging.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/plan/src/flock.ts:160` — return-authoritative helper and generic errno throw.
- `plugins/plan/src/flock.ts:187` — global epic-id lock's explicit fail-soft unlocked behavior.
- `plugins/plan/src/flock.ts:266` — existing commit-work tagged outcome.
- `plugins/plan/src/commit.ts:487` — commit-window acquisition and error mapping.
- `plugins/plan/src/verbs/scaffold.ts:1048` — scaffold's epic-id critical section.
- `plugins/plan/src/store.ts:352` — blocking store lock use.

**Optional** (reference as needed):
- `plugins/plan/test/src-creation-machinery.test.ts:426` — tests currently pin unlocked degradation.
- `docs/adr/0107-return-authoritative-lock-acquisition-outcomes.md` — accepted reversal and caller policy.

### Risks

The retired behavior was an intentional availability tradeoff, so error envelopes must be retryable and leave the worktree unchanged rather than converting transient infrastructure trouble into partial Plan state. Epic-id reservation and commit-work locks nest in a defined order; new outcome plumbing must not block indefinitely or invert that order.

### Test notes

Inject open, close-on-exec, syscall, errno-accessor, and deadline outcomes for both Plan locks. Assert every inconclusive mutation returns before file creation or modification, rollback is a no-op because no write began, positive contention stays retryable, and successful creation/refinement/selection still commits atomically.

### Detailed phases

1. Introduce package-local tagged acquisition and exact cleanup for blocking, nonblocking, and deadline paths.
2. Replace global epic-id and commit-work unlocked degradation with typed pre-write refusal across all mutating verbs.
3. Update store and creation/commit tests, then remove tests and comments that authorize unlocked mutation.

### Alternatives

Preserving fail-soft scan-only or unlocked commit behavior is rejected by the accepted safety decision. Reusing the root module directly is acceptable only if packaging and cold-start boundaries remain intact; otherwise protocol equivalence is preferred over import coupling.

### Non-functional targets

Mutating verbs remain bounded and retryable under lock trouble, preserve write-then-commit ordering, keep the global epic-id/commit-work lock order, and leave no staged, untracked, ledger, or partially written Plan state after refusal.

### Rollout

Land as one package-local policy change so no Plan mutation temporarily has one unlocked lock and one fail-closed lock. Existing callers receive additive typed errors and can retry unchanged after lock infrastructure recovers.

## Acceptance

- [ ] Plan blocking and bounded lock adapters authorize work only after exact syscall success and preserve positive contention separately from Inconclusive.
- [ ] Epic creation, scaffold, refinement, and selection refuse before writing when the global epic-id lock is Inconclusive.
- [ ] Plan auto-commit refuses retryably and leaves its invocation-owned paths unchanged when the shared commit-work lock is Inconclusive.
- [ ] No Plan mutation path proceeds scan-only or unlocked after lock setup/acquisition failure.
- [ ] Successful and positively contended Plan behaviors retain bounded atomic commit and retry semantics.

## Done summary

## Evidence

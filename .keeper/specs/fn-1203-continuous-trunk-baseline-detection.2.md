## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Give the repair escalation sweep a second candidate source: a repo whose newest default-tip baseline leaf is confirmed red (red across the confirming re-run, flakySuspect false) mints a repair candidate — one repair::<repo-token> per (repo, fingerprint), reusing the existing dispatch, latch, and page-once machinery — even when zero tasks are blocked. An infra-error or timeout leaf is never red for this purpose. Route any new drop/defer diagnostics through the typed drop() helper and the reconciled class union. Resolve the green ambiguity the gap analysis named: the clear gate for a baseline-sourced candidate must consult the baseline leaf (suite green at the current tip), while the checkout-cleanliness gate keeps its distinct dirty-defer role — name the two checks distinctly so the sweep never conflates them. Flake tolerance: a first red triggers the confirming re-run through the store's existing multi-run classification rather than dispatching immediately.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1546-1872 — the sweep region post fn-1201/fn-1202 (candidate selection, drop classes, defer diagnostics)
- src/daemon.ts:10116-10124 — isRepairBaseGreen/isRepairCheckoutDirty (the two "green" meanings to disentangle)
- src/baseline-store.ts deriveResult/classifyFailures — flakySuspect semantics and multi-run confirmation
- docs/adr/0017 — the repair contract (page-once, retry_dispatch re-arm) the new source must honor

### Risks

- A repair session dispatched with no blocked task has no task context — its brief must carry the failing tests from the leaf; verify the escalation brief composition handles a task-less candidate.
- Double-dispatch guard: a worker-stamped block and a baseline-sourced candidate for the same (repo, fingerprint) must coalesce to one sticky.

### Test notes

Injected-deps sweep tests: confirmed-red leaf with no blocked tasks yields one dispatch decision; flake-suspect or single-run red yields the re-run request, not a dispatch; infra-error yields nothing; worker-block + baseline-red same fingerprint yields one candidate.

## Acceptance

- [ ] A confirmed-red newest-tip baseline mints exactly one repair candidate per (repo, fingerprint) with zero blocked tasks, honoring the existing page-once and re-arm discipline
- [ ] Single-run red triggers a confirming re-run instead of dispatch; infra-error/timeout never dispatches
- [ ] Worker-sourced and baseline-sourced candidates for one fingerprint coalesce to one sticky
- [ ] The suite-green and checkout-clean gates are named distinctly and tested separately
- [ ] keeper fast suite green

## Done summary
Add a baseline-sourced repair candidate: a confirmed-red newest-tip baseline leaf mints a task-less repair candidate coalescing by repo token with worker blocks; single-run/flaky red defers to the store's confirming re-run; infra/timeout never dispatch. Split the conflated 'green' into distinct checkout-clean DEFER and suite-green CLEAR gates.
## Evidence

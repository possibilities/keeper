## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worker-cell.ts, src/reconcile-core.ts, test/worker-cell.test.ts, test/autopilot-worker.test.ts, docs/adr/, docs/problem-codes.md, CONTEXT.md

### Approach

The pure plan keeps composing the effective cell and emitting the wrapped
marker provisionally; the PRODUCER becomes the launch gate. Before any launch
side effect, the producer's existing resolveWorkerCell re-run extends with a
route-launchability check on the effective cell: the composed model must carry
a launchable provider route consistent with its driver (native route for a
native cell; a wrapped marker on a route-less or native-only model is the
fn-1325.2 replay and rejects). The reject is a NEW kind through the
assertNever switch minting the existing sticky DispatchFailed shape with a
reason naming the constraint + cell pair, consolidated into the
worker-provider reason family. Byte-pinned reason/argv expectations in the
launch tests update alongside. Ship the ADR (producer gate ownership, parked
semantics from the sibling task, provider-constraint vocabulary; relates to
ADR 0079) and the CONTEXT.md entries (provider constraint; parked-launch)
with Avoid lines that reconcile the glossary's existing rejected "pin" sense.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worker-cell.ts:487-589 — resolveWorkerCell precedence + providerRejectReason composer (extend HERE, never a parallel validator)
- src/autopilot-worker.ts:4927-5008 — the pre-launch re-run + assertNever reject switch the new kind joins
- src/reconcile-core.ts:2438-2536 — compose + wrapped marker at :2502 (stays provisional; understand what it trusts today)

**Optional** (reference as needed):
- src/provider-equivalence.ts + test/provider-equivalence.test.ts — the constraint translation map
- test/agent-launch-config.test.ts — byte-pinned argv fixtures that may churn

### Risks

- Over-strict gating could reject legitimately launchable wrapped cells — the fixture matrix must cover every current cell class
- Reason-string churn across byte-pinned suites

### Test notes

Deterministic fixtures: the fn-1325.2 replay (constraint + native-only cell →
sticky, no launch); an unlaunchable wrapped manifest (missing/stale) →
sticky; every currently-valid cell class still launches. Named gates for the
touched suites.

## Acceptance

- [ ] A provider-constraint + cell pair whose effective cell lacks a launchable route or manifest never reaches a launch side effect and mints a sticky failure naming the pair, cleared only by retry
- [ ] The fn-1325.2 replay fixture produces the sticky; every currently-valid cell class still launches
- [ ] The new reject kind flows through the assertNever switch with its problem-codes row in the worker-provider family
- [ ] The ADR and CONTEXT.md entries land with the provider-constraint vocabulary reconciled
- [ ] Named test gates for the touched suites pass

## Done summary
Producer-owned launch-contract gate: resolveWorkerCell now validates an active provider constraint's effective cell against its launchable route/driver/marker before spawn, returning a closed provider-unlaunchable kind that mints the sticky worker-provider-cell-unlaunchable reason instead of launching a doomed worker (fn-1325.2 replay fixture covered). Added ADR 0084 plus CONTEXT.md/problem-codes.md entries for provider constraint and parked launch.
## Evidence

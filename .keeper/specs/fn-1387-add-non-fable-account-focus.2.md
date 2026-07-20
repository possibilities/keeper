## Description

**Size:** M
**Files:** src/account-router.ts, src/agent/main.ts, src/agent/args.ts, src/agent/dispatch.ts, cli/descriptor.ts, cli/status.ts, test/account-router.test.ts, test/agent-account-routing.test.ts, test/agent-args.test.ts, test/agent-dispatch.test.ts, test/status.test.ts, test/helpers/agent-main-harness.ts

### Approach

Read both independent focus deliveries at the single route-decision boundary. Classify matching scope from effective process-lineage intent: proven `true` matches Fable, proven `false` matches Non-Fable, and `null` matches neither. Compute eligible managed routes once, honor explicit account requests first, select an eligible matching focus regardless of reservation pressure, then apply existing Fable-target soft avoidance for non-Fable work only when no Non-Fable target applies, and finally call the unchanged normal scorer.

Add `keeper agent accounts non-fable-focus show|set|clear`. Accept stable routes and observation-resolved `cN` input but persist only `claude-swap:<slot>`. Support permanent or timezone-bearing absolute lifetime. Absolute set rejects an elapsed deadline; a guarded `--require-eligible` form additionally requires fresh global evidence and a currently eligible target before mutation. CLI acknowledgement and uncertain-retry behavior mirror Fable focus. Account inspection and `keeper status` expose sibling configured/effective/eligibility/outcome/reason/diagnostic views without changing Pi/Codex output.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/account-router.ts:190-282` — intent classification and route eligibility.
- `src/account-router.ts:549-652` — current Fable preference/avoidance and reservation decision seam.
- `src/account-router.ts:740-853` — canonical focus inspection view.
- `src/account-router.ts:1054-1133` — normal score, pressure, LRU, and tie-break fallback.
- `src/agent/main.ts:1401-1435,2790-2985` — generic config RPC call and strict Fable focus CLI precedent.
- `src/agent/main.ts:3740-3840` — sole Claude process-boundary classification and route selection.
- `cli/status.ts:401-417,545-557,725-735` — focus status model and off default.
- `cli/descriptor.ts:1960-1992` — nested command metadata/help.

**Optional** (reference as needed):
- `test/account-router.test.ts:366-513` — focus, avoidance, sole-candidate, and explicit-route precedence matrix.
- `test/helpers/agent-main-harness.ts:220-233,453-487` — injected focus mutation/inspection seams.
- `docs/adr/0100-independent-scoped-account-focus.md` — complete precedence matrix.

### Risks

- Existing Fable avoidance currently filters the exact pool the Non-Fable focus must select from; applying preference afterward would make the new focus ineffective.
- Unknown intent must not silently become Non-Fable after a failed resume/query lookup.
- Same-target policies must report two matching focused outcomes without one scope consuming the other's inspection state.
- An absolute rollout guard must use daemon/event time for mutation authority, not only a stale client-side precheck.

### Test notes

Build the complete matrix over explicit route, intent `true|false|null`, focus off/active/expired/unavailable, targets same/different, target eligible/ineligible/absent, zero/one/many candidates, reservation pressure, Fable avoidance, stale global evidence, and Pi isolation. Cover stable-route persistence, `cN` resolution, elapsed deadline refusal, `--require-eligible`, idempotent clear, uncertain acknowledgement, and additive status JSON.

### Detailed phases

1. Extend route inputs/inspection with the second delivery and one generic scoped view.
2. Implement precedence at the eligibility seam and add stable focused/fallback/avoidance reasons.
3. Add strict nested CLI parsing, mutation, inspection, clear, deadline, and eligibility guard behavior.
4. Extend status/account-check machine contracts and exhaustive in-process tests.

### Alternatives

A post-score weight cannot guarantee target selection or explain fallback. Treating unknown as Non-Fable broadens focus when evidence is weakest. Reciprocal avoidance for Fable adds policy not requested by the human. All are rejected.

### Non-functional targets

- Off-policy and fallback normal candidate ordering remains unchanged.
- Focus adds no provider subprocess or extra capacity refresh per launch.
- Human and machine diagnostics remain bounded, PII-free, control-safe, and stable across idempotent retries.

### Rollout

Supply the guarded command and proof output, but never mutate live host policy from a task lane. Post-land activation owns the fixed deadline and eligibility check.

## Acceptance

- [ ] Proven non-Fable launches select an active eligible Non-Fable target before Fable avoidance and normal scoring.
- [ ] Proven Fable launches ignore Non-Fable focus and retain existing Fable focus behavior; unknown intent matches neither focus.
- [ ] Explicit Account route requests remain highest precedence and exact-request failures remain unchanged.
- [ ] Inactive, expired, unavailable, absent, or ineligible Non-Fable targets fall back visibly through existing avoidance/normal selection without becoming eligible.
- [ ] Same-target and different-target Fable/Non-Fable policies produce deterministic independent outcomes and reasons.
- [ ] Non-Fable show, permanent/absolute set, guarded eligible set, and idempotent clear use stable routes and typed PII-free envelopes.
- [ ] Elapsed absolute deadlines and stale/absent/ineligible guarded activation refuse before mutation.
- [ ] Account inspection and status expose both focus views while Pi/Codex routing and output remain unchanged.
- [ ] Named router, agent command, dispatch, descriptor, harness, and status tests pass.

## Done summary

## Evidence

## Description

**Size:** S
**Files:** src/fable-focus.ts, src/usage-observation-view.ts, test/fable-focus.test.ts, test/usage.test.ts, README.md, docs/install.md

### Approach

Remove Account focus and Usage view's secondary route-age vetoes after task 1 establishes the authoritative admitted-route projection. Focus continues to require a fresh healthy Capacity observation, a present admitted target, and valid lifetime/reset boundaries; it falls back visibly on a fresh non-`ok` target and resumes the unchanged durable preference when the target returns.

Keep Measurement age visible as provenance in the Usage view while rendering an admitted route's meters as usable. Model the timestamp separately from semantic account status so local age/countdown repainting does not create semantic fingerprint changes. Consolidate operator docs around fresh observed claude-swap advice, provider-owned `usageStatus`, raw quota values, and the distinction between Capacity observation freshness and Measurement age.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/fable-focus.ts:232 — cycle-end focus completion and duplicate route-age gate.
- src/fable-focus.ts:322 — current-reset focus construction and target eligibility.
- src/usage-observation-view.ts:106 — Claude source/account status construction.
- src/usage-observation-view.ts:313 — local age formatting and clock-skew behavior.
- src/usage-observation-view.ts:381 — semantic fingerprint exclusion for heartbeat-only movement.
- test/fable-focus.test.ts:29 — hardcoded Capacity sidecar schema fixture.
- test/usage.test.ts:25 — deterministic Usage view fixtures and rendering assertions.
- README.md:16 — account-routing front-door summary.
- docs/install.md:63 — operator routing, focus, inspection, and usage guidance.

**Optional** (reference as needed):
- docs/adr/0101-claude-swap-owned-measurement-trust.md:1 — accepted authority and reset semantics.
- docs/adr/0097-sidecar-backed-dynamic-usage-viewer.md:19 — Usage view's read-only boundary.
- docs/adr/0100-independent-scoped-account-focus.md:17 — focus precedence and eligible-route invariant.

### Risks

Do not weaken Capacity observation freshness or allow a configured focus to make a non-admitted target viable. Reset timestamps still govern explicit focus lifetime boundaries and display countdowns even though they no longer rewrite quota utilization. Keep Claude measurement-age diagnostics isolated from Codex alias freshness behavior and from semantic-history fingerprints.

### Test notes

Cover an old-but-provider-trusted focus target, fresh non-`ok` fallback and later resumption, current-reset construction with old future reset evidence, elapsed/mismatched reset refusal, usable meters with an honest measurement-age annotation, clock skew, stale Capacity observation rendering, and age/countdown-only fingerprint stability. Run only the named focus and Usage view tests.

## Acceptance

- [ ] Account focus treats an admitted old-measurement target as eligible, falls back when a fresh response removes it, and resumes the unchanged durable preference when the route returns.
- [ ] Current-reset and cycle-end focus lifetimes retain their reset elapsed/mismatch rules without reintroducing Measurement-age eligibility.
- [ ] `keeper usage` renders admitted meters plus bounded underlying Measurement-age provenance while source freshness continues to represent the Capacity observation.
- [ ] Measurement-age and countdown repainting do not change the Usage view semantic fingerprint by themselves.
- [ ] README and installation guidance distinguish fresh observed advice from diagnostic Measurement age and state that raw quota/status authority remains with claude-swap.
- [ ] The named Account-focus and Usage view test files pass.

## Done summary

## Evidence

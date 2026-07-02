## Description

**Size:** M
**Files:** src/subagent-invocations.ts, src/reducer.ts, test/subagent-invocations.test.ts, test/reducer-links.test.ts, test/reducer-lifecycle.test.ts, test/refold-equivalence.test.ts, README.md

### Approach

Bound `findPendingPreToolUseForStart` (src/subagent-invocations.ts:479-533) with a PARSE-CACHE memo: the anti-join SQL stays a live query (exact by construction — immune to PostToolUse:Agent re-binding/overwrite semantics and FIFO self-correction, which a materialized pending-set would have to model across three fold arms), while the JSON.parse of each candidate events.data blob — the measured cost — is memoized per event id in a per-Database WeakMap. Copy the gitAttribMemos scaffolding exactly (src/reducer.ts:1215-1456): __resetForTest export, watermark advanced past malformed/type-mismatch rows (the :1369-1371 discipline — a permanently-malformed low-id row must not re-anchor scans), never throw (a memo-internal error rebuilds cold, never propagates into the fold).

Add the missing event-id ceiling to the candidate query (`id < currentEventId`): today a from-scratch re-fold sees FUTURE PreToolUse:Agent rows the live fold never saw — a latent divergence (the refold-equivalence charter compares two re-folds, never re-fold-vs-live, so it cannot catch this). The byte-identity target is LIVE-fold semantics; thread currentEventId into the probe. Note the projection (subagent_invocations) is deterministic-replayed — confirmed.

Boot-seed warmer: implement only if the measured cold first-fold cost for a long session stays above ~1s after the parse cache lands (the warmGitAttribMemo precedent at reducer.ts:~1286 shows the shape); otherwise document why lazy warm-up suffices.

### Investigation targets

**Required** (read before coding):
- src/subagent-invocations.ts:474-533 — the probe, its covering-index comment, and the parse loop
- src/reducer.ts:5320-5390 — the SubagentStart arm, instrumentation accumulators, breakdown emit
- src/reducer.ts:1215-1456 — gitAttribMemos: the template for memo lifecycle, watermark discipline, cold-fidelity
- test/reducer-lifecycle.test.ts:2040-2119 — the warm-vs-cold byte-equal test shape to ship

**Optional** (reference as needed):
- src/reducer.ts:8722-8809 — MonitorProvenanceMemo (the id-ceiling precedent)
- test/reducer-links.test.ts:2547-2960 — existing SubagentStart behavior pins (FIFO, precedence, no-ops)

### Risks

- The ceiling deliberately CHANGES what a from-scratch re-fold produces where future-candidate matches existed — that is the fix, not a regression; the new equivalence tests encode live-fold semantics on both sides
- The parse cache must key on event id alone (blobs are immutable rows); caching derived match decisions would smuggle mutable state into the fold

### Test notes

Warm-vs-cold byte-equality (memo accumulated across drains vs reset+single-drain); a red-first divergence test: a session where the ONLY matching candidate lies at a future id — pre-fix re-fold binds it, post-fix neither live nor re-fold does; existing FIFO/precedence pins stay green; extend refold-equivalence with the arm.

## Acceptance

- [ ] Anti-join stays live SQL; parse cost memoized; watermark discipline matches the template
- [ ] id ceiling added; live-vs-refold divergence test red-first then green
- [ ] Warm-vs-cold byte-equal test ships; __resetForTest wired; no fold throw paths introduced
- [ ] README incident paragraph + diagnostics note; full fast suite green

## Done summary

## Evidence

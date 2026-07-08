## Description

**Size:** S
**Files:** cli/await.ts, src/await-conditions.ts, test (await fixtures)

### Approach

Verify-first: build a fixture replaying the observed unwind shape (verdict completed on one snapshot, regressed on the next, completed again) against the post-fn-1200 verdict stream and determine whether the await surface can still observe a transient completed. If not, land the fixture as regression coverage and close as a no-op with the evidence. If it can: gate the met latch on stability — the completion must hold across a small number of consecutive subscribe snapshots (2-3) with the target row's version watermark non-regressing; any regression resets the confirmation. Verify whether the snapshot payload already threads a per-row version to the await slot; if not, add that plumbing minimally. The bar only tightens: met must never fire earlier than current behavior, and steady-state latency added to a genuinely-complete await stays bounded to the confirmation snapshots.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/await-conditions.ts:73-81,477-492,654,736 — the completed reads and evaluators
- cli/await.ts:42 and ~857 — the met one-shot latch (PlanSlotState.met)
- fn-1200.3's landed terminality latch — what the verdict stream now guarantees

### Risks

- Double-latching what fn-1200 already fixed adds latency for nothing — hence verify-first with the fixture as the decider.

### Test notes

Fixture-driven: transient-completed sequence → no met; stable-completed sequence → met after the confirmation window; watermark regression during confirmation → reset.

## Acceptance

- [ ] The window verdict (remains / closed) is documented with the reproducing fixture
- [ ] If closed: fixture lands as regression; if open: transient completions never fire met and stable ones fire within the bounded window
- [ ] met never fires earlier than current behavior
- [ ] keeper fast suite green

## Done summary

## Evidence

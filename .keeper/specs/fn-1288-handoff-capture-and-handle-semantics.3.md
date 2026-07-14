## Description

**Size:** M
**Files:** src/handoff-worker.ts, src/exec-backend.ts, test/handoff-worker.test.ts

### Approach

Teach the handoff worker's launch path to honor a capture-bearing handoff row: resolve the launch triple (request fields override the dispatch-table pin resolved via resolveDispatchLaunchConfig), swap the prompt to a new exported autonomous framing constant (the deliverable contract: investigate, act within the brief, and finish with a final message that IS the answer — no parking, no confirm beat), and thread the row's envelope path into the launch as an env carrier on LaunchSpec, mirroring the existing wrapped-envelope carrier, so the detached leg itself writes the standard 9-key envelope on terminal outcome. The worker leg is the SOLE writer of that envelope; the daemon writes no competing result row, and a waiter timeout only detaches the waiter (the session stays recoverable — explicit abort is out-of-scope). The envelope record is size-bounded, single-JSON-object, matching the run-capture schema exactly so the golden envelope test covers it. Non-capture rows build the identical spec they do today. Keep the capture branch pure and exported for direct testing; re-size the coupled prompt-cap pinning test (prefix + framing + doc ≤ PROMPT_MAX_BYTES) for the longer autonomous framing.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/handoff-worker.ts:282-299,335-358,548-565 — spec construction, HANDOFF_PROMPT_FRAMING + buildHandoffPrompt, launch call
- src/exec-backend.ts:84-180 — LaunchSpec fields and the wrapped-envelope env-carrier precedent to mirror
- src/agent/run-capture.ts — the envelope schema/writer contract the leg must match (post-fn-1282 surface)

**Optional** (reference as needed):
- test/handoff-worker.test.ts — pure-decider test shape (synthetic rows, injected clock)
- test/agent-run-capture-golden.test.ts — the full-key-set golden the envelope must satisfy

### Risks

- A parked capture leg hangs its waiter to timeout — the framing swap must be mechanical on the capture flag, never prompt-content detection.
- Two writers on the envelope path (leg + daemon) would disagree on terminal state; keep the daemon read-only here.

### Test notes

Pure tests: capture row → spec carries triple + env carrier + autonomous framing; non-capture row → spec byte-identical to today; framing constant fits the re-sized cap test. No real launches (slow tier only if needed behind KEEPER_RUN_SLOW).

## Acceptance

- [ ] A capture handoff row launches with the autonomous framing, the resolved triple, and an envelope-path carrier; the leg's terminal outcome produces one size-bounded envelope at that path matching the shared 9-key schema
- [ ] A non-capture row launches byte-identically to pre-change behavior, parking framing included
- [ ] No daemon or worker code path writes to the envelope path other than the launched leg
- [ ] The prompt-cap pinning test passes with the new framing constant

## Done summary

## Evidence

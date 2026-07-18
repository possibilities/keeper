## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/run-capture.ts, src/agent/resume-policy.ts, src/agent/dispatch.ts, src/agent/transcript-watch.ts, src/bus-artifact.ts, src/provider-leg-death-notice.ts, test/agent-run-capture.test.ts, test/agent-resume-policy.test.ts, test/agent-dispatch.test.ts, test/bus-artifact.test.ts, plugins/keeper/skills/pair/SKILL.md, docs/agent-surface-contracts.md, CONTEXT.md

### Approach

Extend the existing `agent run --resume` live-target branch rather than adding another public verb. Resolve and pin the exact live job identity with Refuse-live, establish a capture boundary before sending a bounded immutable Bus artifact, and accept a response only after the matching injected message is observed in the transcript; the delivery acknowledgement alone is never an answer. Permit one response-bearing request per exact Partner, do not automatically retry ambiguous delivery, and reuse the existing answer envelope, death precedence, timeout budget, and show-last-message recovery.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/main.ts:1395-1469 — current live-target refusal and detached resume capture
- src/agent/resume-policy.ts:53-88,166-255 — exact name/id resolution, pid/start-time identity, ambiguity, and recycled-pid defenses
- src/agent/run-capture.ts:805-907 — captureFromHandle reuse boundary
- src/agent/transcript-watch.ts:31-68,121-180,455-458 — stop scanner and harness-specific freshness floor
- src/bus-artifact.ts:1-35,64-87 — bounded confined immutable message artifacts
- src/provider-leg-death-notice.ts:181-200,840-890 — typed honest Agent Bus delivery outcomes
- src/agent/dispatch.ts:67-150,346-365 — command routing and current raw-Bus guidance
- test/agent-run-capture.test.ts:1597-1740 — resumed capture and current live-target refusal

**Optional** (reference as needed):
- cli/bus.ts:870-890,1304-1333 — artifact publication, synchronous delivery ack, and definite-failure cleanup
- test/helpers/agent-main-harness.ts:1-18,107-190 — injected command-level effect harness
- test/agent-run-capture-depgraph.test.ts:1-29 — DB-free launch-path boundary

### Risks

- The Partner may finish unrelated work before processing the Bus message; no assistant stop may satisfy capture until the injected message boundary is observed
- Bus Presence and process liveness differ; definite non-delivery, ambiguous delivery, Partner death, and response timeout need distinct existing outcome mappings
- A second inbox subscriber would violate single-watcher ownership; reuse the existing transport/capture seams without taking over the Partner's Bus watch

### Test notes

Cover definite delivery plus answer, delivered timeout plus late transcript recovery, exact death after delivery, ambiguous transport with no resend, pre-existing unrelated stop, concurrent request refusal, identity rename/recycle races, and cleanup on cancellation.

## Acceptance

- [ ] `agent run --resume` sends a bounded message to the exact positively live Partner over the existing Bus artifact rail without starting a second Harness writer
- [ ] Capture accepts only a response after the matching injected-message boundary; a pre-existing or unrelated assistant stop cannot satisfy it
- [ ] Only one response-bearing request per exact Partner is admitted; duplicate/concurrent attempts fail closed and all waiters/artifacts clean up on every exit
- [ ] Delivery acknowledgement, delivery ambiguity, response timeout, and `partner_died` remain distinguishable without changing the exact nine-key answer envelope or automatically retrying a send
- [ ] A delivered timeout leaves the Partner live and names the existing non-resending transcript/show-last-message recovery path
- [ ] Focused dispatch, resume-policy, capture, artifact, and dependency-boundary tests pass

## Done summary
Extended agent run --resume to send a bounded message to an exact live Partner over the existing Bus artifact rail, capturing only the response observed after the injected-message boundary; single-request admission, honest ambiguity/death/timeout distinctions, and non-resending recovery guidance are preserved.
## Evidence

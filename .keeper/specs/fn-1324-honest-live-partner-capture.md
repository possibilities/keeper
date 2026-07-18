## Overview

Complete the pair/Partner workflow without inventing a second session writer or confusing an observation timeout with Partner termination. The existing `agent run --resume` path will message an exact live Partner over the Agent Bus, capture only the answer causally following that injected message, and leave a timed-out Partner alive with concrete transcript recovery guidance.

## Quick commands

- bun test ./test/agent-run-capture.test.ts ./test/agent-pair-subcommands.test.ts ./test/agent-resume-policy.test.ts ./test/agent-dispatch.test.ts

## Acceptance

- [ ] A timed-out capture reports an observation deadline honestly and never marks or reaps a positively live Partner as terminal
- [ ] `agent run --resume` can deliver one bounded message to an exact live Partner and capture only the response after the observed injection boundary
- [ ] The exact nine-key answer envelope, `partner_died` precedence, and no-automatic-retry rule for ambiguous delivery remain intact
- [ ] A timeout gives a non-resending path to inspect a late response; concurrent response-bearing requests for one Partner fail closed

## Early proof point

Task that proves the approach: task 1. If lifecycle and timeout cannot be separated without breaking panel/provider-leg consumers, keep the honest envelope change and refine task 2 around a narrower control-state seam.

## References

- docs/agent-surface-contracts.md — canonical wait and answer-envelope contract
- plugins/keeper/skills/pair/SKILL.md — user workflow to consolidate around the first-class path
- docs/adr/0062-unified-session-history-and-resume.md — Refuse-live remains the single-writer boundary

## Docs gaps

- **docs/agent-surface-contracts.md**: clarify observation timeout versus Partner termination and delivery acknowledgement versus captured response
- **plugins/keeper/skills/pair/SKILL.md**: replace the raw Bus detour with the first-class live message/capture and late-response workflow
- **CONTEXT.md**: prune-first revision of the existing Partner definition only if the current wording still conflates capture completion with Harness termination

## Best practices

- **Deadline is not cancellation:** a bounded wait never implies process termination
- **Delivery is not response:** the Bus acknowledgement cannot satisfy response capture
- **Observe before attributing:** require the injected-message boundary before accepting an assistant stop as the answer
- **Bound concurrency:** serialize one response-bearing request per exact Partner and clean every waiter on all exits

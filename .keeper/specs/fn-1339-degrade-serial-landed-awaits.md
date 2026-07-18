## Overview

`keeper await landed` consumes one merge-landed set, but a whole-epic serial shared-checkout fallback never cuts a lane and is currently omitted from that set even after the epic is done. Extend the existing producer so explicit `disabled` execution contributes completion-backed landing evidence without making a display Projection load-bearing or treating an arbitrary missing lane as success.

## Quick commands

- bun test ./test/autopilot-worker.test.ts ./test/await-conditions.test.ts ./test/await.test.ts ./test/await-worker.test.ts
- bun run typecheck

## Acceptance

- [ ] A done whole-epic serial fallback satisfies `keeper await landed` without a lane or git probe, while an unfinished serial epic keeps waiting
- [ ] Lane-capable and clustered multi-repo epics retain their existing all-groups landing semantics, and unknown or absent classification never degrades to success
- [ ] Ephemeral and durable waits consume the same merge-landed signal and report mode-neutral landing details that remain truthful without a lane
- [ ] The shared landed set keeps stable sorted, deduplicated output and `keeper status` no longer reports a done serial fallback as finalize-pending

## Early proof point

Task 1 proves the approach by changing the disabled-resolution producer matrix before touching help text. If the producer cannot distinguish explicit serial execution conservatively, stop rather than infer success from lane absence.

## References

- src/autopilot-worker.ts:3588-3605,3695-3785 — merge-landed producer and current disabled-resolution skip
- src/readiness-client.ts:618-644 — shared landed-set consumer used by socket snapshots and status
- src/await-worker.ts:267-324 — durable evaluator consumes the same lane_merged Projection
- src/await-conditions.ts:1623-1661 — membership predicate and lane-specific detail text
- cli/await.ts:160-161,216,265 — help text currently promises a lane-only milestone
- test/autopilot-worker.test.ts:16696-16829 — done-gating and disabled-resolution regression matrix

## Best practices

- **Explicit-mode degradation:** accept completion only from the reconciler's explicit serial resolution, never from missing lane evidence
- **One signal for all consumers:** preserve foreground, durable, and status parity through the existing merge-landed Projection
- **Pure deterministic coverage:** test the mode/status matrix directly without daemon processes, sockets, git subprocesses, or sleeps

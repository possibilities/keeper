## Overview

The codex-pool activation chain has a landed consumer, classifier, and
fail-closed gate but NO producer: nothing in the runtime can emit the
live-proof report, so enroll-to-activate is structurally unreachable
(found live by the proof operator after fn-1374 landed; fn-1356.1 is
parked EXTERNAL_BLOCKED on exactly this gap). This epic wires the landed
collector into the armed proof window so a managed session can produce
the report the documented capture-verdict-activate chain consumes.

## Quick commands

- bun test ./test/codex-pool-activation.test.ts ./test/agent-account-routing.test.ts
- (cd integrations/pi-codex-pool && bun test ./test/provider-pool.test.ts ./test/proof.test.ts)
- bun run typecheck

## Acceptance

- [ ] Under an explicitly armed proof window, a managed Pi session can produce a live-proof report that the documented capture verb accepts; un-armed sessions produce no report and no collection overhead.
- [ ] The activation gate's fail-closed semantics are byte-for-byte untouched; existing focused gates stay green.
- [ ] The extension's transitive module graph reaches no bun-only builtin, proven by a test.

## Early proof point

Task that proves the approach: ordinal 1. If the collector cannot be
triggered from the companion without new daemon surface, fall back to a
CLI-driven collection path and record the deviation in the task evidence.

## References

- Terminal finding (proof operator, 07-19 ~11:4x): proof.ts exports collectLiveProof/scanProofArtifacts/writeLiveProofReport with zero production callers; companion registers only codex-pool-observe; fn-1374's window gates routing, instruments nothing; captureCodexPoolProof only reads a caller path.
- docs/adr/0090 (pool contract) + fn-1374's proof-window amendment; docs/install.md codex-pool section (the documented command chain this epic makes real).
- fn-1356 depends on this epic (edge wired at scaffold); its .1 stays parked EXTERNAL_BLOCKED until this lands.
- Operator hotfix context: the extension imports the dep-free src/codex-pool-proof-window.ts leaf; keeping the extension bun-free is a hard invariant (backlog #61 carries the general gate).

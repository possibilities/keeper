## Overview

The audit of the keeper-pair port surfaced two coherence gaps on the pairing
surface. First, agentwrap's `findLastMessage` documents a "defined empty
signal" (`found:true, text:null`) for a tool-only final turn that the code
never actually produces for claude — and a test was named to match the
contract while asserting the opposite, so the rename masks the gap. Second,
keeper's `cli/pair.ts` orchestration — the load-bearing two-line Monitor
contract and SIGTERM reap — has no end-to-end test. Both are test/contract
integrity work on the same pairing surface.

## Acceptance

- [ ] The empty-turn `found` contract has one consistent story across the
      `findLastMessage` JSDoc, the agentwrap tests, and the keeper-side
      consumers (name, assertion, and doc all agree).
- [ ] `cli/pair.ts` has a direct test asserting the two-line Monitor contract
      holds on a failure path (exactly one `started` + one `failed`).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | transcript-watch.ts:89-90 JSDoc promises found:true/text:null for a claude tool-only turn but the code yields found:false; test at pair-subcommands.test.ts:199 is misnamed against its assertion. |
| F2 | merged-into-F1 | .1 | F2 (the pair-subcommands.test.ts:357 comment reasserting the found:true framing) shares F1's empty-turn found-contract root cause in the same file, so it folds into F1's task. |
| F3 | culled | — | cli/pair.ts Number(timeout) is correct: Number('1800abc') is NaN, rejected by Number.isFinite; auditor self-refuted. |
| F4 | kept | .2 | cli/pair.ts main() has no end-to-end test; the load-bearing two-line Monitor contract and SIGTERM reap are asserted only by module doc. |
| F5 | culled | — | codex agent_message fallback is a working branch with no demonstrated defect; a missing fixture below the keep bar. |

## Out of scope

- A codex `agent_message` (non-`task_complete`) fallback fixture (F5) — deferred; the branch works, no defect shown.
- Any change to the read-only "detection, not prevention" posture (Security Notes flagged it as the documented, accepted design).

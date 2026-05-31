## Description

**Size:** M
**Files:** src/board-render.ts (new), cli/board.ts, test/board.test.ts

### Approach

Create `src/board-render.ts` and move the render primitives that both
the epics view and the (forthcoming) jobs view need: the colorizer
`colorizePillsInLine` plus its `SGR` / `PILL_COLORS` tables, the pill
segment helpers `apiErrorPillSeg` / `inputRequestPillSeg`, the role
label `planVerbLabel`, the sub-agent collapse line builder
`subagentLinesFor`, the dead-letter pill renderer
`renderDeadLetterPill`, and the one-shot RPC client
`sendReplayDeadLetterRpc` (+ `ReplayDeadLetterRpcResult` /
`REPLAY_DEAD_LETTER_TIMEOUT_MS`). `subagentLinesFor` is currently a
`main()` closure that closes over `seg` — make it a pure module
function taking its `subagentIndex` + `jobId` + `indent` args (inline
the trivial `v == null ? "" : String(v)` or pass `seg`). The shared
module imports ONLY from `src/` (it already needs
`collapseSubagentsByName` from `src/readiness-client` and `Verdict`
types) — never from `cli/`. `cli/board.ts` imports the moved symbols
and keeps thin re-export shims for every name `test/board.test.ts`
imports (`colorizePillsInLine`, `renderDeadLetterPill`,
`epicNumFromIdOrBare`, `renderEpicDepPills`, `renderJobLinkLines`) —
mirror the existing `export { projectRows } from "../src/readiness-client"`
shim at cli/board.ts:266. Zero behavior change: board still renders
the combined frame after this task; only the module boundary moves.

### Investigation targets

**Required** (read before coding):
- cli/board.ts:583-730 — SGR / PILL_COLORS / colorizePillsInLine / renderDeadLetterPill
- cli/board.ts:300-345,383-389 — planVerbLabel / apiErrorPillSeg / inputRequestPillSeg
- cli/board.ts:769-897 — sendReplayDeadLetterRpc + ReplayDeadLetterRpcResult + REPLAY_DEAD_LETTER_TIMEOUT_MS
- cli/board.ts:1060-1086 — subagentLinesFor (main() closure; closes over seg)
- cli/board.ts:266 — the existing re-export shim precedent
- test/board.test.ts:30-43 — the exact import surface that must keep resolving

**Optional** (reference as needed):
- src/readiness-client.ts:360,411 — projectRows / collapseSubagentsByName (already in src/, no move)
- cli/git.ts — sibling main for the import-from-src/ convention

### Risks

Circular import if the shared module reaches back into `cli/board.ts`
— keep the dependency direction `cli/ → src/` only. Bun resolves a
cycle to `undefined` silently. Smoke `keeper board --help` after the
move to catch an undefined pill function at import time.

### Test notes

`bun test test/board.test.ts` must stay green with no test-file edits
beyond (optionally) updating import paths — but the shim approach
means the existing `../cli/board` imports keep resolving unchanged.
Verify the suite passes before this task is considered done.

## Acceptance

- [ ] `src/board-render.ts` exports the moved primitives; imports nothing from `cli/`
- [ ] `cli/board.ts` imports them and re-exports the five names `test/board.test.ts` uses
- [ ] `subagentLinesFor` is a pure module function (no `main()` closure dependency)
- [ ] `keeper board` renders the same combined frame as before (no behavior change)
- [ ] `bun test test/board.test.ts` passes; `keeper board --help` runs without an undefined-function error

## Done summary
Extracted shared render primitives from cli/board.ts to a new src/board-render.ts (colorizePillsInLine + SGR/PILL_COLORS, apiErrorPillSeg, inputRequestPillSeg, planVerbLabel, pure subagentLinesFor, renderDeadLetterPill, sendReplayDeadLetterRpc + result type and timeout). cli/board.ts re-exports the five names test/board.test.ts imports plus sendReplayDeadLetterRpc/ReplayDeadLetterRpcResult for scripts/drain-dead-letters.ts. Zero behavior change; 64 board tests + 1642-test full suite green, keeper board --help clean.
## Evidence

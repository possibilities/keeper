## Description

**Size:** S
**Files:** scripts/readiness.ts (delete), src/readiness.ts (new), scripts/board.ts, test/readiness.test.ts, test/board.test.ts

### Approach

Verbatim move of the pure readiness module into `src/` (its rightful home given it's imported by both the board renderer and tests, and will soon be imported by the new `src/readiness-client.ts` helper too). Three edits land in this task:

1. Move `scripts/readiness.ts` → `src/readiness.ts`. Inside the moved file, change the single import `from "../src/types"` → `from "./types"`. No other content changes — this is `mv`, not "rewrite while moving."
2. Update `scripts/board.ts` import (`from "./readiness"` → `from "../src/readiness"`).
3. Update both test files' imports: `test/readiness.test.ts` (one line) and `test/board.test.ts` (one line — only the `computeReadiness` line; the `projectRows` import on the adjacent line stays pointing at `../scripts/board` for now, since `projectRows` doesn't move until task `.2`).

No shebang, no `if (import.meta.main)`, no Bun-specific runtime touch added during the move. Pure refactor — `bun test` must pass before and after with identical output.

### Investigation targets

**Required** (read before coding):
- `scripts/readiness.ts:1-44` — module-level docstring spells the pure contract; verifying nothing accidentally drifts.
- `scripts/readiness.ts:46` — the one `import type` line that needs the path change.
- `scripts/board.ts:89-94` — current import block to update.
- `test/readiness.test.ts:24` — single import line to retarget.
- `test/board.test.ts:24-25` — two import lines; only line 25 (`computeReadiness`) retargets in this task.

**Optional** (reference as needed):
- `src/types.ts` — confirms `Epic`, `Job`, `SubagentInvocation`, `Task` exports are stable.

### Risks

No behavior change risk if the move is verbatim. Only failure mode is a typo'd import path that breaks the build; CI catches it immediately.

### Test notes

`bun test test/readiness.test.ts` and `bun test test/board.test.ts` both pass with identical assertion counts to pre-change. Run `bun test` for the full suite to confirm no other module imports `scripts/readiness` directly.

## Acceptance

- [ ] `scripts/readiness.ts` no longer exists; `src/readiness.ts` contains the moved module with the one internal import path corrected (`./types`).
- [ ] `scripts/board.ts` imports from `../src/readiness`.
- [ ] `test/readiness.test.ts` imports `computeReadiness` (and any sibling symbols) from `../src/readiness`.
- [ ] `test/board.test.ts` `computeReadiness` import retargeted to `../src/readiness` (line 25). The adjacent `projectRows` import is intentionally left unchanged.
- [ ] `bun test` passes with no assertion-count or test-count delta vs. pre-change.
- [ ] `grep -rn "scripts/readiness" --include="*.ts" .` (outside `.planctl/` and `node_modules/`) returns zero matches.

## Done summary

## Evidence

## Overview

The wrapped-cell edit-denial guard clears its Bash allowlist for any `bun run <arg>`, so a marked wrapped worker can Write an out-of-tree script (allowed), `bun run` it (allowed), and have that script write into `src/` — a reachable hole that defeats the guard's stated "single-state total edit-denial / nothing forgeable" guarantee. This follow-up closes the hole so the guard actually enforces the contract task .2 and ADR 0050 claim, and pins the behavior with tests so it can't silently regress.

## Acceptance

- [ ] A marked wrapped worker can no longer reach an arbitrary-file `bun run` that executes writable code into a tracked tree.
- [ ] The bun-run allowlist decision (allow vs deny) is asserted for both the permitted test-runner case and the arbitrary-path case.
- [ ] The compound out-of-tree-Write + `bun run` sequence is asserted as contained.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | wrapped-guard.ts:524 clears the allowlist for any `bun run <arg>`; with :691 (out-of-tree Write allowed) the compound bypass defeats the total-edit-denial acceptance. |
| F2 | culled | — | Copied lexer/git-injection helpers are a deliberate dep-free hook-isolation choice matching every sibling guard; a judgement call, not a violation. |
| F3 | merged-into-F1 | .1 | F3 (no test pins `bun run <arbitrary-path>`) shares F1's root cause (the :524 hole); the pinning test lands with the F1 fix. |
| F4 | merged-into-F1 | .1 | F4 (no test for the compound Write + `bun run` sequence) shares F1's root cause (the :691+:524 path); the regression test lands with the F1 fix. |

## Out of scope

- Extracting the CVE-hardened lexer/git-injection helpers into a shared dep-free module (F2, culled — deliberate hook-isolation copy).
- Any change to the out-of-tree Write allowance itself (the scratchpad contract path is intentional; the fix is the `bun run` exec surface, not Write).

## Overview

Mop-up follow-up to the planctl strip: rename the `planctl`-named code
symbols that Phases A/B deliberately scoped out — the plan-dir filesystem-scan
symbols in `src/plan-worker.ts` / `src/git-worker.ts` and the `PlanctlCondition`
await type. Pure symbol/identifier renames, no logic change. This exists so
those symbols are tracked, not orphaned, once the schema (fn-864) and subtree
(fn-859) work lands.

## Quick commands

- `rg -n 'Planctl|planctl' src/plan-worker.ts src/git-worker.ts src/await-conditions.ts cli/await.ts src/readiness-client.ts` → only trailer-key string literals remain after this lands
- `bun run typecheck && bun run test:full`

## Acceptance

- [ ] plan-dir scan symbols and `PlanctlCondition` renamed to `plan*`; all call sites updated; typecheck + test:full green
- [ ] No logic change; the `Planctl-Op:`/`Planctl-Target:` git-trailer KEY string literals are left untouched (immutable history; owned by Problem B)

## References

- Depends on `fn-859` (de-vendor) — the plan-dir symbols live in `plan-worker.ts`/`git-worker.ts`, which fn-859 edits; this must land after to avoid conflict.
- OUT of scope (owned elsewhere): the schema/fold symbols → `fn-864`; the commit-trailer parsers + Commit-IPC-message fields → Problem B (the trailer epic).

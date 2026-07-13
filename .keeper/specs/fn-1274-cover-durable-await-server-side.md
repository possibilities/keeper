## Overview

Two server-side surfaces of the new durable-await feature shipped without
direct test coverage: the ~130-line condition evaluator that decides whether
a persisted await is met, and the daemon-side spill-file path-containment
guard. Both are correct today but unguarded — a future refactor could
silently regress a condition branch or weaken the traversal check with no
failing test. This follow-up adds that coverage; it touches only tests.

## Acceptance

- [ ] `evaluateDurableAwaitConditions` has a table-driven test asserting
      met/waiting/unknown per condition kind against a seeded DB snapshot.
- [ ] A daemon-level test asserts a `../`-escaping `doc_path`, an empty
      spill file, and an oversized spill file each return `ok:false` and
      mint no `AwaitRequested` event.
- [ ] `bun test` stays green.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | evaluateDurableAwaitConditions (src/await-worker.ts:269, 14 condition kinds) has zero direct test refs; a wrong branch fires early or never with no safety net. |
| F2 | kept | .1 | request-await handler (src/daemon.ts:8343) carries its OWN copy of the realpath+startsWith spill guard, not the tested handoff copy; only param-shape is covered, not the daemon-side traversal/empty/oversized rejection. |
| F3 | culled | — | cli/await.ts:3218 catch leaks one small <uuid>.txt per failed durable request; CLI one-shot, no user-noticeable impact, below the keep bar. |
| F4 | culled | — | durableConditionSpec (cli/await.ts:3083) hand-lists the 14 kinds instead of importing DURABLE_AWAIT_CONDITION_KINDS — DRY/divergence nit, correct today. |
| F5 | culled | — | foldAwaitLifecycle (reducer.ts:5708) uses bare >=3 vs named NEVER_BOUND_AWAIT_THRESHOLD; magic-number nit, in lockstep today. |
| F6 | culled | — | snapshotCheckoutDirt double-reads untracked files on the content-keyed path; auditor calls it acceptable given dirt is small — micro-efficiency. |

## Out of scope

- The three culled Consider-nits (F3 spill-leak, F4 hardcoded kind Set, F5 magic threshold, F6 double-read) — left as-is; revisit on the next touch of those files.
- Any change to production behavior — this epic adds tests only.

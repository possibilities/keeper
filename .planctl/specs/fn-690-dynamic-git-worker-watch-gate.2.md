## Description

**Size:** S
**Files:** README.md, src/types.ts, src/daemon.ts, src/collections.ts, src/git-worker.ts, src/reducer.ts

Consolidation sweep: every doc/JSDoc site that frames keeper's git-worker as
watching only "planctl-backed" roots becomes stale once the dynamic gate
(`.planctl present || dirty || ahead>0`) lands. Update each to describe the
three-arm membership predicate and the dynamic join/drop reconciliation. Pure
description edits — no logic, no new claims. Depends on task 1 so the prose
matches the landed behavior.

### Approach

Walk the docs-gap-scout site list and revise each predicate label/sentence in
place. Keep the `git-worker.ts`↔`reducer.ts` tombstone descriptions consistent
with each other (the drop trigger is now "root no longer satisfies the watch
gate on reconcile", not ".planctl removed"). Do not append new paragraphs —
these are noun-phrase label and sentence revisions.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:1-29 (module header), :510 (`gitRootFor` comment), :151-161 (tombstone JSDoc).
- src/types.ts:1213-1222 — GitStatus/GitSnapshot JSDoc.
- src/reducer.ts:2420-2445 — `retractGitStatus` JSDoc (drop trigger).
- src/daemon.ts:48 — worker comment; src/collections.ts:374 — git descriptor.
- README.md lines 119, 841-843, 1781 — git collection / client / projection descriptions.

### Test notes

Doc-only; verify `bun run lint` (and any markdown/JSDoc lint) passes. No behavior to test. Confirm the README and code descriptions no longer claim ".planctl-backed only".

## Acceptance

- [ ] No remaining doc/JSDoc claim that keeper watches only `.planctl`-backed roots (grep `planctl-backed` across the listed files returns only intended/historical references).
- [ ] git-worker.ts and reducer.ts tombstone descriptions are mutually consistent on the new drop trigger.
- [ ] `bun run lint` passes.

## Done summary

## Evidence

## Description

**Size:** S
**Files:** `src/readiness.ts`, `test/readiness.test.ts`

### Approach

Convert each mutex from a single-pass walk into a two-pass walk (or
equivalent priority-claim algorithm):

1. **Pass 1** — iterate every task, and for any verdict that is
   non-completed AND non-`ready` (i.e. `{tag: "blocked", ...}` with
   any reason — `job-running`, `sub-agent-running`, etc.), claim its
   root (or its epic, for the per-epic mutex). These rows represent
   work already live; they own the slot regardless of iteration
   order relative to ready siblings.
2. **Pass 2** — iterate again, and for any `ready` verdict whose
   slot is already claimed, mutate to `{kind: "single-task-per-root"}`
   (or `"single-task-per-epic"`). If two `ready` verdicts compete for
   an unclaimed slot, the first wins and later ones are demoted —
   that part of the existing behavior is preserved.

The close-row branch in `applySingleTaskPerRootMutex` needs the same
two-pass treatment so an actively-blocked close row in a later epic
still claims the root ahead of an earlier-iterating ready task. Read
the existing close-row gate at `src/readiness.ts:633-644` and mirror
the two-pass shape there.

Add the missing symmetric tests so this can't regress: ready-first /
blocked-later, for both `applySingleTaskPerEpicMutex` and
`applySingleTaskPerRootMutex`.

### Investigation targets

**Required** (read before coding):
- `src/readiness.ts:562-585` — `applySingleTaskPerEpicMutex` (current one-pass; mutates only `ready`).
- `src/readiness.ts:603-646` — `applySingleTaskPerRootMutex` (same shape, includes close-row branch).
- `test/readiness.test.ts:1132-1148` — existing per-epic "non-ready row STILL claims slot" test; uses blocked-first ordering. The ready-first symmetric case is missing and is exactly the bug.
- `test/readiness.test.ts:1201-1230` — existing per-root variant of the same; same gap.
- `src/readiness.ts:540-558` — the docstring describing the intended "any non-completed occupant" semantics; the implementation does not actually deliver that when ordering is unfavorable.

## Acceptance

- [ ] `applySingleTaskPerEpicMutex` and `applySingleTaskPerRootMutex` are order-independent: a `job-running` task in epic position N+1 blocks a `ready` task in epic position N within the same epic / root.
- [ ] Close-row branch of the per-root mutex gets the same order-independent treatment.
- [ ] New test: `applySingleTaskPerRootMutex: ready row in earlier-iterating epic blocked by job-running row in later-iterating epic (same root)`.
- [ ] New test: `applySingleTaskPerEpicMutex: ready row before job-running row in same epic still gets demoted to single-task-per-epic`.
- [ ] `bun test test/readiness.test.ts` passes with all existing tests green.

## Done summary

## Evidence

## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, test/autopilot-worker.test.ts, test/worktree-git.test.ts

### Approach

Teach teardown and the lane dirt spool the ADR 0074 classification: before snapshotting a dying worktree's untracked entries, test each against the provisioning seam's planted-artifact definition — same link type, same target, byte-identical. Matches are keeper residue: deleted freely, never spooled, never counted as dirt for the recover pass's grace/page logic. Everything else — foreign untracked files, and formerly-provisioned paths whose content was replaced — keeps the exact spool-first path unchanged. The classification consumes the task-1 seam; no second definition of "what keeper plants" may exist.

### Investigation targets

*Verify before relying.*

**Required** (read before coding):
- src/autopilot-worker.ts — the recover pass's dirt evaluation and spool-then-force path (the lane dirt spool discipline in CLAUDE.md's worktree section)
- src/worktree-git.ts — the task-1 provisioning seam and its planted-artifact definition

### Risks

- The recover pass's dirt count gates paging; misclassifying a plant as dirt re-introduces noise, misclassifying work as plant destroys it — the byte-identity test must be exact, with any mismatch spooling.

## Acceptance

- [ ] A dying lane whose only untracked entries are keeper plants tears down with zero spool entries and zero dirt-page noise
- [ ] A replaced plant and a foreign file both spool exactly as before
- [ ] Both suites green; no second planted-artifact definition exists

## Done summary

## Evidence

## Description

**Size:** S
**Files:** src/autopilot-worker.ts (or daemon.ts — last-cycle retention), cli/autopilot.ts (status render + --help), README.md

### Approach

Surface WHY a repo's worktrees are disabled, as a NON-error operator view — never `dispatch_failures`, never a projection.

- Retain the last reconcile cycle's `worktreeRepoByEpicId` (or a derived `{ toplevel -> { mode: "worktree"|"serial"|"rejected", reason } }`) in in-memory reconciler state. It already lives per-cycle on `ReconcileSnapshot` (623) and is discarded; stash the last one where the autopilot status query can read it. NO projection — the reason is fs-derived/non-deterministic, so a projection would have to be live-only (`db.ts:1523-1531`); keeping it in-memory avoids that entirely.
- `keeper autopilot` status (cli/autopilot.ts; mirror the `cli/board.ts:469-470,852` precedent for surfacing reconciler-derived info to a human view): render a neutral `worktree: serial (reason)` line per disabled repo/epic, DISTINCT from the red failed / dispatch-failures block. An empty pre-first-cycle state renders cleanly (no section).
- Docs: `README.md` `## Architecture` worktree section (~3368-3378) — reword "Two distinct sticky rejects" and introduce `disabled` as a separate non-error category (criteria, sequential shared-checkout dispatch, the memoized probe, grandfathering, the non-sticky status). `cli/autopilot.ts` worktree `--help` (~86-92) — under 3 lines noting the heuristic falls some repos back to sequential shared-checkout.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:623 (`ReconcileSnapshot.worktreeRepoByEpicId`) and the reconcile-loop caller (daemon.ts) where last-cycle state can be retained
- cli/autopilot.ts:62-115 (`--help` + status render); README.md ~3285-3389
- cli/board.ts:469-470, 852 (precedent for surfacing reconciler info to a human view)

**Optional:**
- src/db.ts:1523-1531 (`LIVE_ONLY_PROJECTIONS`) — context for WHY a projection is avoided

### Risks

- Don't mint a projection: a deterministic-replayed projection of an fs-derived status violates re-fold determinism; in-memory-only is the simplest correct surface.
- Keep it out of the `dispatch_failures` / red path — `disabled` is non-error.

### Test notes

- Unit: the last-cycle map -> status-render shaping produces a neutral `serial (reason)` line for a disabled epic and nothing for an empty/clean board.
- Docs edits verified by reading (no test).

## Acceptance

- [ ] `keeper autopilot` shows which repos/epics are worktree-disabled and the reason, as a neutral (non-error) line distinct from the failed / dispatch-failures block
- [ ] NO projection added; the status reads from retained in-memory reconciler state; an empty pre-first-cycle state renders cleanly
- [ ] `README.md` worktree section reworded — `disabled` introduced as a separate non-error category; the "two sticky rejects" wording corrected
- [ ] `cli/autopilot.ts` worktree `--help` notes the sequential-fallback behavior (under 3 added lines)
- [ ] no `dispatch_failures` / sticky reject involvement

## Done summary

## Evidence

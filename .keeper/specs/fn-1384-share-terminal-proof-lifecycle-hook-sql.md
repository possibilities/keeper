## Overview

The cooperative-commit-rail epic extracted the shared `hasOrderedTerminalProof`
predicate into `src/lifecycle-terminal-proof.ts` so `unblock` and `commit-work`
agree byte-for-byte on what "terminally proven dead" means. But the lifecycle
hook-set SQL that feeds that predicate was left duplicated: `unblock.ts` inlines
a literal copy (twice, inside one query) of the same list that already exists as
the `TERMINAL_PROOF_LIFECYCLE_HOOKS_SQL` constant in `src/commit-work/surface.ts`.
Sharing the one constant across both callers closes a silent-drift hazard in
security-boundary code and finishes the byte-consistency invariant the epic set
out to establish.

## Acceptance

- [ ] The lifecycle hook-set SQL exists in exactly one place, imported by both `unblock` and `commit-work`.
- [ ] `unblock` and `commit-work` terminal-proof queries remain behaviorally identical (no change to which events count as lifecycle tails).
- [ ] Existing terminal-proof and unblock tests stay green.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | state===null reset-to-todo is defensible recovery-safe fail-closed; only the done_summary prose is loose, no user-facing defect. |
| F2 | culled | — | inline KEEPER_DB path duplicates resolveDbPath but the .trim() divergence is only reachable via whitespace-only KEEPER_DB; cosmetic DRY. |
| F3 | kept | .1 | unblock.ts inlines the lifecycle-hook list already exported as TERMINAL_PROOF_LIFECYCLE_HOOKS_SQL; sharing it closes cross-caller drift in security code. |
| F4 | culled | — | naming nitpick: "Recent" implies an absent staleness window; the local function body is self-evident. |
| F5 | culled | — | test gap on the rare untracked-claimant (state===null) edge whose behavior is defensible fail-closed; catch on next touch. |

## Out of scope

- Renaming `claimantSessionIsLiveOrRecent` (F4) — naming nitpick, not tracked.
- Sharing `resolveDbPath` into unblock (F2) — cosmetic DRY, not tracked.
- Adding the state===null branch test (F5) — deferred; low-value edge.

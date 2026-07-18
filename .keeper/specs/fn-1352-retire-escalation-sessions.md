## Overview

The cleanup that makes the inversion real: remove the escalation dispatchers, sweeps, caps, occupancy probes, and the autoclose escalation bucket; drop the escalation verbs and the empty role-marker carrier from the launch surface; collapse the staged latch columns into one bounded incident projection carrying the page-once state forward; and reshape the docs and glossary so every surface describes the in-session model. After this epic, autopilot can only ever launch work, close, and wrapped provider legs.

## Quick commands

- `bun test test/refold-equivalence.test.ts test/reducer-projections.test.ts` — determinism and projection suites green
- `bun scripts/lint-claude-md.ts && bun scripts/lint-source.ts` — doc gates green after the reshape
- `keeper status` — board renders incident rows, no escalation pills

## Acceptance

- [ ] No code path can dispatch a resolve, deconflict, unblock, or repair session; the dispatch vocabulary is work, close, and wrapped legs
- [ ] Escalation state lives in one bounded per-key incident projection; page-once state carried forward so cutover cannot re-page
- [ ] The board's needs-human accounting renders incident rows without double-counting
- [ ] CLAUDE.md, README, CONTEXT.md, and the composition map describe only the in-session model; fully superseded ADRs live under superseded/

## Early proof point

Task that proves the approach: task 1. If a live legacy escalation session exists at cutover time, the retirement waits for its natural terminal state — the exit watcher and jobs projection already classify it — rather than force-killing.

## References

- docs/adr/0089-in-session-escalation-subagents.md — the retirement contract (authority flip, human_notified_at carry-forward)
- docs/adr/0020 — migration ladder discipline (version at merge, never hand-typed)
- The needs-human subset accounting — the board contract incident rows must slot into

## Docs gaps

- **CLAUDE.md**: hook list, autopilot worktree paragraph, escalation caps line — the big collapse lands here, net shrink, lint-gated
- **README.md**: hook count and composition summary
- **CONTEXT.md**: retire/redefine the escalation-session vocabulary; add Incident, Grant, Trunk lease, Fencing token, Typed receipt, Attachment lease
- **docs/plugin-composition-map.md**: escalation-dispatch block rewritten around confined subagents
- **docs/problem-codes.md**: examples citing escalation dispatch rows

## Best practices

- **Forward-only, provisional versioning:** the ladder entry's number is assigned at merge; the fingerprint re-pins on every schema change
- **Bounded projection:** per-key replace-merge on the existing primary key — never a history-growing fold

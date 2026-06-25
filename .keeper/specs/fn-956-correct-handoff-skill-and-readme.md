## Overview

The handoff feature shipped with two user-facing docs overclaiming behavior
the code does not deliver: the keeper:handoff skill tells the driving agent
to surface a target session the CLI never prints, and the README describes
dispatch order as "oldest" when selection is UUID-lexicographic. This is a
small docs/skill accuracy correction so operators and agents are not misled.

## Acceptance

- [ ] The handoff skill no longer claims output that the CLI does not emit (or the CLI emits it).
- [ ] The README accurately describes handoff dispatch ordering.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | SKILL.md:87/:95/:107 say to surface the resolved session, but control-rpc.ts:199-201 prints only {ok,handoff_id} and cli/handoff.ts:209-232 never writes the session to stdout. |
| F2 | merged-into-F1 | .1 | F2 (README:3348 "oldest" vs handoff-worker.ts:330 ORDER BY handoff_id ASC on a random UUID) shares F1's root cause — handoff prose overclaiming code behavior — and folds into F1's task. |
| F3 | culled | — | Worker-count "thirteen->fourteen" vs ALL_WORKERS=18 is pre-existing narrative not introduced by this epic; out of scope. |
| F4 | culled | — | Test Gaps "verify from diff" advisory leading with "No gap blocks shipping"; no concrete missing test. |

## Out of scope

- The pre-existing "thirteen workers" narrative subset vs the 18-entry ALL_WORKERS divergence (F3) — predates this epic; reconcile in a dedicated docs pass.
- Verifying worker->main mint round-trip test coverage (F4) — no proven gap.

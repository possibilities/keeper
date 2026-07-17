## Overview

The bus.db migrate routes its channels index list through the
`createIndexFailOpen` helper, but that list's sole member is the UNIQUE
constraint index backing the channels upsert's `ON CONFLICT(pid, start_time)`
target — a correctness constraint, not the query optimization the helper is
documented for. This follow-up scopes fail-open to the messages
(optimization) indexes only and returns the channels UNIQUE index to the
strict `db.run` path, so a failed create surfaces as the loud, isolated
boot-time failure `migrateBusDb` promises rather than a cryptic downstream
upsert error.

## Acceptance

- [ ] The channels UNIQUE index is created on the throwing path (a failed
      create surfaces loudly at boot, not swallowed)
- [ ] The messages optimization indexes retain fail-open degradation
- [ ] Tests cover both semantics: a rejected messages index degrades without
      wedging migrate; a failed channels UNIQUE index throws

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | bus-db.ts:152 (32d9267b) routes the UNIQUE idx_channels_pid_start through createIndexFailOpen (optimization-only); scope fail-open to the messages indexes and keep channels strict so a failed create stays loud. |
| F2 | culled | — | REDUNDANT_COMMENT nit in the pruneControlMessagesOlderThan doc about a moot-today scenario (control rows never immune); comment-only, no user impact. |
| F3 | culled | — | Auditor deemed the createIndexFailOpen catch-arm test acceptable at lean; this task's acceptance already covers the strict-vs-fail-open split. |

## Out of scope

- The through-immune-head retention redesign and socketless presence reap themselves (shipped and audited clean).
- Any bus schema version bump — this is a routing/robustness fix, no DDL shape change.

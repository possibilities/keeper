## Overview

The three read-only history verbs shipped correct, but two load-bearing
correctness primitives lack test pins: `escapeLike` LIKE-wildcard escaping
and the read-failure error-envelope contract. This follow-up backfills the
missing assertions so a future regression in either is caught rather than
silently widening matches or swallowing a read error.

## Acceptance

- [ ] `escapeLike` literal-match behavior is pinned for search-history and find-file-history (a fragment with `%`/`_`/`\` matches literally, not as a wildcard).
- [ ] The `{ success: false }` read-failure envelope is asserted for find-file-history and show-session-events.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | show-session-events.ts:52/:132 empty `--session-id` is harmless (empty result, exit 0) — auditor's own ergonomics nit, below cull bar. |
| F2 | culled | — | `parseLimit` is a trivial shared check across three files; low value, no user-noticeable gap. |
| F3 | kept | .1 | `escapeLike` (search-history.ts:130, find-file-history.ts:132) is load-bearing for LIKE correctness yet untested; a regression silently widens matches. |
| F4 | merged-into-F3 | .1 | F4 (untested error-envelope path for find-file-history/show-session-events) merges into F3: same test-coverage work, same files, one commit. |

## Out of scope

- `--limit` honoring tests (F2) — trivial shared parser, declined.
- Empty-string `--session-id` rejection (F1) — harmless ergonomics nit, declined.

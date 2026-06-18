## Overview

The `BRIEF_MISSING` error on the close-phase submit path emits a remediation
hint whose second segment is a plain string literal, so it renders the literal
token `{epic_id}` instead of the epic id. The human who hits this error gets an
uncopyable `planctl close-preflight {epic_id}` command. This is a one-character
bug fix on a user-facing error path.

## Acceptance

- [ ] The `BRIEF_MISSING` remediation hint renders the actual epic id, not the literal `{epic_id}` token.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | submit_common.py:173 BRIEF_MISSING hint renders literal `{epic_id}`; user-facing remediation command is uncopyable |
| F2 | culled | — | run_close_finalize.py:206 open-only filter is a deliberate tradeoff; label-only drift on a no-mutation replay path |
| F3 | culled | — | run_followup_submit.py:87 BRIEF_CORRUPT on verdict-read is a naming nitpick; message accurate, planner stops regardless |
| F4 | culled | — | run_close_finalize.py docstring omits COMMIT_LOOKUP_FAILED; trivial doc drift, CLI --help already lists it |

## Out of scope

- The idempotent-replay `closed_clean` vs `closed_with_followup` label drift (F2) — deliberate tradeoff, deferred.
- `BRIEF_CORRUPT` code-name reuse on the verdict-read path (F3) — naming nitpick, deferred.
- `close-finalize` docstring typed-error list completeness (F4) — trivial doc drift, deferred.

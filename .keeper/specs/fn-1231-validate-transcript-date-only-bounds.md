## Overview

The transcript CLI's local-day `--since`/`--until` handling accepts out-of-range
date-only values (e.g. `2026-02-30`, `2026-13-01`) and silently normalizes them to a
valid day instead of erroring, so a fat-fingered date bounds the wrong window rather
than surfacing a mistake. This closes that single validation gap — a strictness
regression from the earlier `Date.parse` path — and pins it with a regression test.

## Acceptance

- [ ] An out-of-range date-only `--since`/`--until` value returns the existing `invalid --<edge> time` error instead of silently bounding a normalized day.
- [ ] In-range date-only values and relative/ISO-8601 forms continue to parse unchanged.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | kept   | .1 | cli/transcript.ts:221-244 — new Date normalizes out-of-range components to a finite time so the Number.isFinite guard is dead; prior Date.parse rejected these. |
| TG1 | merged-into-F1 | .1 | TG1 (out-of-range date test) folds into F1's task — the regression test lands with F1's validation fix as one commit. |
| F2  | culled | —  | No current user impact — renderedCost's +160/entry margin absorbs the undercount; proof-accuracy concern gated on a hypothetical future refactor. |
| TG2 | culled | —  | Paired to culled F2; tests an invariant with no current user impact. |
| F3  | culled | —  | Comment-cleanliness nit (rule #0) in keeper-events.ts:216; no user/behavior impact. |
| F4  | culled | —  | Cosmetic past-tense parenthetical in worstCaseHeaderBudget comment; no impact. |

## Out of scope

- The worstCaseHeaderBudget upper-bound-proof accuracy (F2/TG2) — no current over-budget output; deferred to any future renderedCost tightening.
- Provenance-comment cleanups (F3/F4) — cosmetic, no enforcing gate.

## Overview

The autoclose worker landed with change-history narration baked into its
code comments — commit SHAs, dead-epic references, and "prior incarnation"
scar-tissue prose — which CLAUDE.md rule #0 explicitly bans ("No fn-ids,
version numbers, dates, or past-tense provenance ... never change history").
These references rot: a reader chasing `commit 5b844449` or the "prior
incarnation" burns time on context that no longer exists. This is a
comment-only cleanup that brings the shipped autoclose surface into line
with an actively-policed repo guardrail, preserving the load-bearing
current-behavior rationale untouched.

## Acceptance

- [ ] No commit-SHA, dead-epic-id, or "prior incarnation" past-tense
      provenance narration remains in the fn-1107 code comments.
- [ ] The current-behavior "why fail-closed" rationale is preserved verbatim
      in intent; only history/provenance prose is removed.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/autoclose-worker.ts:2,22,33 and src/daemon.ts:3087,7468 carry commit-SHA/fn-id/prior-incarnation narration banned by CLAUDE.md rule #0; blamed to the fn-1107 commits. |
| F2 | culled | — | watchLoop pulse interleave is negligible/self-correcting, idempotent+blast-capped, mirrors the renamer worker, explicitly not a required change per the auditor. |

## Out of scope

- The two `RESERVED for task .2` comments in src/reconcile-core.ts (lines 501, 724): blamed to commit 3da0c8a4, which is NOT in the fn-1107 commit set — pre-existing, not this epic's diff.
- Migration-comment version tags and `fn-NNN:`-prefixed test names: established repo convention, explicitly fine per rule #0.
- The watchLoop pulse-interleave concurrency note (F2): culled, no change.

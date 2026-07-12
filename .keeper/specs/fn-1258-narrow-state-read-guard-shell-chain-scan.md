## Overview

The state-read guard's `keeper plan` seam exemption forfeits itself on any
shell metacharacter found anywhere in the command, but `SHELL_CHAIN` scans
the entire command including the quoted `--reason` payload. Since the
canonical AUDIT_SEVERE reason is a free-form one-line finding summary, a
legitimate escalation whose prose contains a shell-inert metachar (`>`,
`<`, `&`, `|`, `;`) inside the quoted reason is false-denied — the exact
escalation the fix set out to allow. This narrows the chain scan so it
inspects the command outside the quoted `--reason` value, restoring the
escalation path for finding summaries that read naturally.

## Acceptance

- [ ] A `keeper plan block --reason "AUDIT_SEVERE: <prose with a quoted, shell-inert metachar>"` is exempt (allowed) by the guard.
- [ ] A genuine chained tree read behind the seam (`keeper plan … && cat <audits-path>`) still denies.
- [ ] The fail-closed default and the `KEEPER_PLAN_GUARD_BYPASS=1` recovery are unchanged for anything outside the quoted reason.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | state-read-guard.ts:57 seam breadth is future-proofing against a hypothetical content-printing plan verb; the no-cat/grep invariant holds today and is documented in-code. Theoretical. |
| F2 | kept | .1 | state-read-guard.ts:66 SHELL_CHAIN scans the quoted --reason, so shell-inert metachars in a legit AUDIT_SEVERE summary false-deny the escalation the fix set out to allow. |
| F3 | merged-into-F2 | .1 | F3 (test gap: no coverage for a --reason prose metachar) is the regression test that pins F2's fix; folded into F2's task. |

## Out of scope

- Narrowing the seam exemption to specific escalation verbs (F1) — the no-content-printing invariant holds and is documented; deferred unless a content-printing plan verb is ever added.

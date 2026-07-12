## Overview

The state-read guard shipped in this epic denies the work orchestrator's
own AUDIT_SEVERE `keeper plan block` command. That command embeds the
finding_ref audits-tree path in its `--reason`, and the guard's Bash vector
(`commandTouchesStateTree`) scans the ENTIRE command string for a
`.keeper/state/audits` token, so a work/close-marked main-context session is
denied on its own sanctioned escalation. This deterministically defeats the
severe-audit escalation the epic exists to restore — the board wedges on a
task that looks perpetually AUDIT_READY and no human is paged. This
follow-up exempts the sanctioned typed seam from the Bash vector and adds
the missing regression test.

## Acceptance

- [ ] A work/close-marked orchestrator's `keeper plan block --reason "AUDIT_SEVERE: finding_ref=<audits-path>"` is ALLOWED by the state-read guard's Bash vector.
- [ ] Genuine reads of the audits/briefs trees (cat/grep/Read) from a marked orchestrator stay denied — the exemption is scoped to the sanctioned `keeper plan` seam, not a blanket bypass.
- [ ] A guard test asserts the sanctioned block command is allowed.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | state-read-guard.ts:56 scans the whole command; work.md.tmpl:232 embeds the audits finding_ref path in the AUDIT_SEVERE block reason, so the orchestrator's own block call is denied. |
| F2 | culled | — | Positive spec-conformance affirmation, not a defect claim. |
| F3 | culled | — | Commit-hygiene only: an unrelated oracle-golden recapture folded into 8eb3a624; already landed, no user impact. |
| F4 | culled | — | Judgement call not a defect; the requested WHY-note already exists at audit_gate_check.ts:133-136,154-157. |
| F5 | merged-into-F1 | .1 | F5 (missing guard test for the block-command collision) is the regression test for F1's defect; folded into F1's task. |

## Out of scope

- The guard's acknowledged Bash false-NEGATIVE gap (path hidden inside a variable expansion or `sh -c` payload) — advisory, documented in-code, not this epic's concern.
- The unrelated oracle-golden recapture mixed into commit 8eb3a624 (F3) — a landed commit-hygiene note, not re-litigated here.

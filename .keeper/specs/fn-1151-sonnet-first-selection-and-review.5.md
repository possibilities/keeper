## Description

**Size:** S
**Files:** plugins/plan/skills/close/SKILL.md

### Approach

Add the selection-audit beat to /plan:close as a new phase after the quality audit and
BEFORE finalize, so the committed review file lands while the epic is still open: run
selection-audit-brief (an already-exists response skips the whole beat silently — the
re-close idempotence rule), spawn plan:selection-auditor blind with the brief ref,
submit the verdict via selection-review-submit. EVERY failure — brief error, agent
death, malformed verdict, submit rejection — degrades immediately to a logged skip and
the close proceeds: no retry loop, no block, explicitly NOT the quality-auditor's
backoff-then-BLOCK posture (mirror the existing degrade-never-loop precedent in the
close flow's selector beat). The close report gains one line: cells audited, misfits
flagged, or the skip reason.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/close/SKILL.md:44-66 — the quality-audit phase this beat follows; :146-215 the Phase 3.5 degrade-never-block precedent to mirror; :219-238 the irreversible finalize the beat must precede

**Optional** (reference as needed):
- plugins/plan/agents/selection-auditor.md — the spawn contract (from task 4)

### Risks

- Copy-pasting the quality-auditor's blocking retry posture would violate the
  never-hold-back-work directive — the degrade posture is the load-bearing line.

### Test notes

Skill prose only; verify by walking the phase order and failure paths against the task-4
verb behaviors (skip-if-exists, distinct rejection codes).

## Acceptance

- [ ] The close flow runs the audit beat exactly once per epic before finalize, and a
      re-run close skips it via the existing-review response.
- [ ] Every audit failure path is specified to degrade to a logged skip with the close
      proceeding — no path retries in a loop or blocks finalize.
- [ ] The close report line carries the audit outcome or the skip reason.

## Done summary
Added Phase 3.6 selection-audit beat to /plan:close: assemble audit brief, spawn plan:selection-auditor blind, relay verdict to selection-review-submit before finalize. Every failure degrades to a logged skip (no retry/block), and the close report gains a selection-audit line.
## Evidence

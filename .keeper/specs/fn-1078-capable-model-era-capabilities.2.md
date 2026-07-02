## Description

**Size:** M
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/agents/quality-auditor.md (criteria echo), plugins/plan/skills/close/SKILL.md (if parse changes)

### Approach

Restructure the worker template so completion criteria sit at the top of the prompt (critical
rules first — attention holds there over 300 turns) as a checkable, exhaustive list bound to
observables the worker can verify with a tool call before declaring done: suite green within
the two-pass budget, keeper commit-work succeeded, session_files empty (the telemetry epic's
gate is the enforcement backstop; the criteria are the worker-side contract), keeper plan done
stamped, every acceptance checkbox in the task spec individually accounted for ("every X
accounted for" phrasing — exhaustiveness resists premature completion). The verifying step is
the worker's last phase: check criteria, then yield — the controller gate remains the
authority (self-evaluation is overconfident by design; the worker checks, the machine
enforces). Keep the phase spine otherwise intact — this is a restructure of WHERE contracts
live plus the criteria rewrite, not a rewrite of the phases.

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl — current phase order, Phase 5 self-check
- The telemetry epic's close-out gate design (its landed code) — the observable names to bind to

### Risks

- Criteria must stay cheap to check (each one tool call) or workers will skip them under turn pressure.

### Test notes

Render consistency green; desk-check against the warm-resume evidence pattern: the criteria
list must catch in_progress_uncommitted before yield.

## Acceptance

- [ ] Criteria at top, observable-bound, exhaustive-phrased; verifying phase precedes yield
- [ ] Four cells re-rendered; close-out gate and criteria name the same observables

## Done summary
Front-loaded a checkable, exhaustive, observable-bound Completion criteria block at top-of-prompt in the worker template and added a verify-before-yield Phase 6; criteria name the same observables the close-out gate enforces (in_progress_committed, done, dirty_session_files/session_files). Fans out to all four opus cells on render.
## Evidence

## Description

**Size:** M
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/template/agents/worker.md.tmpl, plugins/plan/src/audit_artifacts.ts, plugins/plan/plugin/hooks/stop-guard.ts, plugins/plan/CLAUDE.md, plugins/plan/test/audit-artifacts.test.ts, plugins/plan/test/stop-guard.test.ts

### Approach

The gate itself, per the recorded decision: docs/adr/0014-audit-gate-rides-block-machinery.md. Worker side (worker.md.tmpl): a brief carrying audit_required branches the close-out — after tests and the source commit, instead of stamping done the worker blocks itself with an AUDIT_READY-category reason naming its commit sha, then ends its turn; every other worker path is untouched. Orchestrator side (work.md.tmpl): the reconcile switch's blocked arm splits on the reason category — AUDIT_READY is the audit branch, everything else keeps today's behavior. The audit branch spawns the quality-auditor content-blind, task-scoped (the task's commit set, via a per-task brief written with the audit-artifacts helpers under the epic's audits tree, task-id-keyed, routed through the primary-repo state seam so parallel lanes never clobber, with a per-task commit-set hash so a crashed-and-resumed orchestrator detects an already-persisted result instead of re-auditing). Clean or mild: persist findings with status accumulated-open, unblock, cold-resume the worker with a resume brief stating the audit passed — the worker stamps its own done (the orchestrator-never-runs-done invariant holds). Verified-severe: one refute re-spawn of the auditor with a refute directive; refuted → treat as mild; confirmed → rewrite the block reason to AUDIT_SEVERE with the finding summary — the existing escalation takes it from there. stop-guard's blocked branch gains the AUDIT_READY-specific reason text (spawn the audit, not resume the worker). plugins/plan/CLAUDE.md gains one forward-facing line distinguishing the gate from the removed audit verbs. Re-render generated surfaces and update the managed sidecars + prompt oracle fixtures; the empty-diff case (no source commit) skips the audit and proceeds straight to done.

### Investigation targets

*Verify before relying.*

**Required**:
- docs/adr/0014-audit-gate-rides-block-machinery.md — the decision this implements
- plugins/plan/template/skills/work.md.tmpl (reconcile switch, resume machinery, 5-attempt budget) and template/agents/worker.md.tmpl (close-out phases)
- plugins/plan/src/verbs/block.ts and unblock — reason handling, category prefix convention; verbs/worker_resume.ts — the cold-resume brief
- plugins/plan/src/audit_artifacts.ts — layout helpers, computeCommitSetHash pattern for the per-task staleness key
- plugins/plan/plugin/hooks/stop-guard.ts + subagent-stop-guard.ts — terminal branches (blocked already allows; only the reason text changes)
- plugins/prompt oracle fixtures render-plugin-templates.json / check-generated.json — regenerate with the template edits

### Risks

- The resume budget: an audit park plus cold-resume consumes one of the 5 resume attempts — verify the budget accounting treats the audit resume as intentional, not a failure retry.
- Reap windows: confirm no autopilot reaper treats a blocked-AUDIT_READY task's idle orchestrator as reapable during a long audit; if one does, the grace design in task 5 owns it.

### Test notes

audit-artifacts tests cover the task-scoped layout + staleness key; stop-guard test covers the AUDIT_READY reason branch; generated-guard + prompt suite green after re-render. The full gate loop is the epic board smoke.

## Acceptance

- [ ] An audit-flagged worker parks blocked with an AUDIT_READY reason after committing, and never self-stamps done on that path; unflagged tasks are byte-identical to today
- [ ] The orchestrator audits the parked task content-blind, task-scoped, idempotently (a persisted fresh result short-circuits re-audit), and routes clean/mild to unblock-plus-resume with the worker stamping its own done
- [ ] Verified-severe survives one refute before the reason rewrites to AUDIT_SEVERE; refuted findings downgrade to accumulated-open
- [ ] Parallel lanes cannot clobber each other's per-task artifacts; the empty-diff case skips the audit
- [ ] Generated surfaces re-rendered, sidecars and oracle fixtures updated, plan and prompt suites green

## Done summary

## Evidence

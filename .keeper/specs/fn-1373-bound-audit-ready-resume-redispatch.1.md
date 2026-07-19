## Description

Addresses finding F1 (with the F3 test gap folded in). At audited commit c5967fb0,
src/daemon.ts runBlockEscalationSweep derives the handling rung as
`route === "work" ? "redispatch_owner" : "dispatch_legacy_unblock"` and consults
the owner-redispatch attempt bound (blockOwnerEscalationDecision, gated on
`owner_redispatch_attempts < BLOCK_OWNER_REDISPATCH_LIMIT`) ONLY inside the
`route === "unblock"` branch. The AUDIT_READY work route therefore hard-sets
redispatch_owner and never checks the bound: a replacement audit orchestrator that
repeatedly dies past the 120s grace re-dispatches a fresh owner forever and NEVER
pages the human — the eventual-escalation safety net every sibling category keeps
is absent for this one category (F3: the pathological loop is untested; only the
resume-once happy path and the at-cap skip are covered).

Gate the AUDIT_READY work rung on the same attempt bound so that, past N witnessed
replacement-orchestrator deaths, it falls through to a page (the legacy-unblock
paging rung, or a distinct AUDIT_READY-resume-exhausted surface). Preserve the
intended autonomous single-resume below the bound and leave the live-orchestrator
defer path and AUDIT_SEVERE routing untouched.

Files:
- src/daemon.ts — the runBlockEscalationSweep handlingRung derivation / route==work gate.
- test/daemon.test.ts — add the repeated replacement-orchestrator death case.

## Acceptance

- [ ] the AUDIT_READY work rung consults blockOwnerEscalationDecision (or the equivalent attempt bound) rather than hard-setting redispatch_owner
- [ ] past the bound, the resume pages (or surfaces an AUDIT_READY-resume-exhausted row) instead of redispatching indefinitely
- [ ] autonomous resume of a once-dead orchestrator below the bound is unchanged; live-orchestrator defer and AUDIT_SEVERE routing are unchanged
- [ ] a daemon.test.ts case drives dead -> resume -> replacement dies past grace -> ... and asserts the bound fires and the human is paged

## Done summary

## Evidence

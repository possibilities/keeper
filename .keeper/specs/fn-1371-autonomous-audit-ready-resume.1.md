## Description

**Size:** S
**Files:** plugins/keeper/plugin/hooks/wrapped-guard.ts, plugins/keeper/plugin/hooks/grant-guard.ts, test/wrapped-guard.test.ts, test/grant-guard.test.ts

### Approach

Extend the wrapped keeper-plan surface so a wrapped worker may run
`keeper plan block <task> --reason "AUDIT_READY: …"` when and only when <task> is the
launch-bound task the guard already validates for `plan done`, and the reason begins with
the AUDIT_READY prefix. Everything else about `plan block` stays denied, with the existing
actionable-denial style. The two guard copies are byte-identical by contract — mirror the
change in both and keep the identity check green.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/wrapped-guard.ts:575-586 — the launch-bound `plan done` validation to model the block allowance on
- test/wrapped-guard.test.ts — the deny corpus structure; add allow + deny cases for the new verb

### Risks

- The allowance must not open general blocking power: own-task binding + reason-prefix gating are both load-bearing.

## Acceptance

- [ ] own-task AUDIT_READY-prefixed block allowed in both guards; foreign task, other reasons, and --force stay denied
- [ ] both guard suites green and the byte-identity contract holds

## Done summary
Wrapped-guard and grant-guard now allow a wrapped worker to self-park its own launch-bound task via keeper plan block --reason AUDIT_READY:...; foreign tasks, non-AUDIT_READY reasons, and --force stay denied.
## Evidence

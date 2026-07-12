## Description

Fixes F1 (with F5's regression test folded in). The state-read guard's
Bash vector `commandTouchesStateTree` (`plugins/plan/plugin/hooks/state-read-guard.ts:56`,
`STATE_TREE_TOKEN = /\.keeper[\\/]state[\\/](?:briefs|audits)\b/`) tests the
whole command string, so the work gate's own escalation at
`plugins/plan/template/skills/work.md.tmpl:232` —
`keeper plan block <task_id> --reason "AUDIT_SEVERE: finding_ref=<path>"`,
where `<path>` is `taskFindingPath` = `audits/<epic>/tasks/<task>.json`
(`plugins/plan/src/audit_artifacts.ts:204`) — is denied in a work/close-marked
main context. Exempt the sanctioned typed seam: skip the token scan when
the command is a `keeper plan …` invocation (those verbs ARE the
content-blind seam and never cat/grep the tree). Keep the deny in force
for genuine tree reads.

Files:
- plugins/plan/plugin/hooks/state-read-guard.ts (commandTouchesStateTree / STATE_TREE_TOKEN)
- plugins/plan/test/state-read-guard.test.ts (add the regression test — F5)

## Acceptance

- [ ] `commandTouchesStateTree` returns false for a `keeper plan block --reason "AUDIT_SEVERE: finding_ref=<audits-path>"` command (the sanctioned seam is allowed).
- [ ] `commandTouchesStateTree` still returns true for a bare `cat <audits-path>` / `grep … <briefs-path>` command from a marked orchestrator.
- [ ] A new state-read-guard test asserts both directions above.

## Done summary

## Evidence

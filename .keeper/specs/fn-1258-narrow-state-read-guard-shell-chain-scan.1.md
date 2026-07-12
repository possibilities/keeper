## Description

Finding F2 (with merged F3): `plugins/plan/plugin/hooks/state-read-guard.ts:66`.
`SHELL_CHAIN = /[;&|`+"`"+`\n]|\$\(|[<>]/` is tested against the whole
`command` in `commandTouchesStateTree`, including the quoted `--reason`
payload. Per `plugins/plan/skills/work/SKILL.md:212` the AUDIT_SEVERE
reason is a free-form one-line finding summary, so a legitimate
escalation whose prose contains a shell-inert metachar inside the quoted
reason (e.g. `--reason "AUDIT_SEVERE: timeout > 5s regresses"`) forfeits
the exemption and is denied — the very case the parent fix set out to
allow.

Narrow the chain check so it inspects the command OUTSIDE the quoted
`--reason` value (metachars that are shell-inert inside double quotes must
not forfeit the exemption), while a chain that lands OUTSIDE the quotes
(`keeper plan … && cat <audits-path>`) still forfeits and denies. Preserve
the fail-closed default and the `KEEPER_PLAN_GUARD_BYPASS=1` recovery.
Add the regression test F3 names (a `keeper plan block` whose `--reason`
prose holds a bare `>`/`<`/`&`/`|`/`;`) at both the classifier and
subprocess-ladder layers, mirroring the existing exempt/chained cases.

Files:
- plugins/plan/plugin/hooks/state-read-guard.ts
- plugins/plan/test/state-read-guard.test.ts

## Acceptance

- [ ] `commandTouchesStateTree` returns false for a `keeper plan block --reason "AUDIT_SEVERE: …"` whose quoted reason contains a shell-inert metachar.
- [ ] `commandTouchesStateTree` still returns true for a real chained tree read (`keeper plan … && cat .keeper/state/audits/…`).
- [ ] Classifier + subprocess-ladder regression tests cover the metachar-in-reason case and pin the intended behavior.

## Done summary

## Evidence

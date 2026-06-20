## Description

Originating finding F1 (evidence: cli/await.ts:455). The `unknown
condition '<x>'` parse error message enumerates `complete, unblocked,
git-clean, agents-idle, server-up, monitor-running` but omits `started`,
which was added to `PLANCTL_CONDITIONS` by the source epic. Add `started`
to the enumeration string so the error advertises every valid condition.

## Acceptance

- [ ] cli/await.ts:455 enumeration includes `started`
- [ ] The listed conditions match the set parsed in `PLANCTL_CONDITIONS`

## Done summary
Added started to the unknown-condition parse-error enumeration in cli/await.ts so the error advertises every valid PLANCTL_CONDITIONS entry.
## Evidence

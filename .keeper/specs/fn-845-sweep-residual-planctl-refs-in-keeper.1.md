## Description

**Size:** S
**Files:** src/commit-work/attribution.ts, src/git-worker.ts, src/readiness.ts, src/await-conditions.ts + other live-tree planctl-comment sites

### Approach

Forward-facing sweep of NON-intentional planctl residue. (1) Fix
`PLANCTL_EXCLUDE_PREFIXES` in attribution.ts to exclude the live `.keeper/`
board dir (the keeper board moved there in fn-829.1) — keep `.planctl/` only
if the vendored plugin board still needs it. (2) Update stale doc-comments
that say planctl/.planctl meaning the live tool/dir. LEAVE the planctl_invocation
reader, vendored .planctl prune globs, and historical chore(planctl): attribution.

### Investigation targets

**Required**:
- src/commit-work/attribution.ts:40 (PLANCTL_EXCLUDE_PREFIXES)
- `rg -n 'planctl' src cli --glob '!**/*reducer*'` minus the intentional set

## Acceptance

- [ ] commit-work excludes `.keeper/`; stale comments swept; intentional residue intact; test:full green

## Done summary

## Evidence

## Description

**Size:** S
**Files:** src/git-worker (the commit-changed emitter), any remaining producer-side `planctl` names (non-historical)

### Approach

Flip the git-worker to emit `plan-commit-changed` (the bounced daemon already folds both). Rename the remaining producer-side `isVendoredPlanctlPath`→`isVendoredPlanPath` definition (consumers tolerant from fn-826.2). Leave the historical `planctl_invocation` reader untouched.

### Investigation targets

**Required**:
- the git-worker emitting `planctl-commit-changed`; `isVendoredPlanPath` definition site

### Risks

- Do NOT remove the `planctl_invocation` reader (historical events).

### Test notes

`bun run test:full`; `rg -n "planctl-commit-changed"` → 0 producers (consumer-tolerant reader may remain).

## Acceptance

- [ ] git-worker emits `plan-commit-changed`; producer-side symbols renamed; historical readers retained
- [ ] `bun run test:full` green

## Done summary

## Evidence

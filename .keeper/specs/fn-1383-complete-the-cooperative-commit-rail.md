## Overview

Close the file-claim commit-rail gaps that strand verified work: give the sanctioned
free-form operator a landing path WITH attribution (#66), make `session release`
validate the worktree it binds and make every refusal envelope carry an actionable
`request_release` pointer (#67 + #62 residual), stop `plan unblock` from stranding a
live claimant's done-mark (#70), and let a wrapped cell actually send the bounded
cooperative-release notice its refusal envelope prescribes (#71). This domain is
disjoint from the fn-1350 merge-incident arc (verified: fn-1350.1's landed surface
touches no commit-work/session/unblock/guard file) — but #70's task must re-verify
against fn-1352's escalation retirement at claim time.

## Quick commands

- `bun test ./test/commit-work.test.ts && bun run typecheck` — commit-rail suites green
- `keeper prompt render-plugin-templates --project-root plugins/plan --check` — template drift gate

## Acceptance

- [ ] A native operator session holding a live claim of the exact task can land and ATTRIBUTE plan commits through commit-work without guard bypass or trailer forgery
- [ ] A cross-repo `keeper session release` either releases the named claim in its actual worktree or refuses loudly — an ok-reporting no-op is impossible
- [ ] `multi_ambiguous` refusals carry the same actionable `request_release` pointer (with the claim's worktree) that `ownership_conflict` carries
- [ ] The unblock→re-claim→done cycle no longer strands a finished worker's done-mark
- [ ] A wrapped cell can send the bounded release notice named in its own refusal envelope

## Done summary

## Evidence

## Overview

The fn-852 branch-guard hook classifier has two flag-parsing gaps that let a
subagent create or switch a git branch with ordinary git flag forms — exactly
the invariant the guard exists to hold. Both are correctness misses in the
load-bearing classifier (`isBranchMutatingInvocation`), live-reproduced. This
follow-up tightens the create-flag and positional-name detection and adds the
regression cases the original 70-case truth table missed.

## Acceptance

- [ ] `git switch --create=<x>` / `git checkout --orphan=<x>` (equals forms) classify as DENY in subagent context
- [ ] `git branch --force <name>` / `git branch -f <name> <start>` (leading-flag create forms) classify as DENY
- [ ] Truth-table regression cases cover every fixed form; the previously-passing space-separated and allow cases stay green

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | branch-guard.ts:79-93/67-77 exact-token create-flag match; live `git switch --create=zzz` creates a branch yet guard ALLOWs. |
| F2 | kept | .1 | branch-guard.ts:95-105 inspects only tokens[0]; live `git branch --force newbranch` creates a branch (name at tokens[1]) yet guard ALLOWs. |
| F3 | culled | — | Backslash-newline continuation exotic for single-line agent tool_input; no realistic worker path. |
| F4 | culled | — | Not a defect — auditor's own note says the header passes the comment-style check, no change needed. |

## Out of scope

- Backslash-newline line-continuation boundary handling (F3 — exotic, deferred).
- Making the guard an adversarial sandbox — it stays a cooperative-worker hygiene control backstopped by the worker.md prose guardrail.

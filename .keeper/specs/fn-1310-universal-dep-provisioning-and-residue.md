## Overview

Implement ADR 0074: every keeper-created worktree gets the same dependency-symlink provisioning at creation, and teardown deletes only byte-identical keeper plants without spooling while everything else keeps the spool-first discipline. Ends the missing-deps red-baseline class and the spool noise from keeper's own symlinks.

## Quick commands

- `bun test ./test/worktree-git.test.ts ./test/autopilot-worker.test.ts` — focused suites green

## Acceptance

- [ ] Baseline and recovery worktrees run suites without missing-dependency failures
- [ ] A torn-down lane's spool snapshot carries no keeper-planted symlinks, while foreign untracked files and replaced plants still spool
- [ ] One seam owns both the provisioning and the identity test

## Early proof point

Task 1 (ordinal 1) proves universal provisioning. If it fails: some worktree-creation site can't share the seam — surface it as a design question before the teardown work.

## References

- docs/adr/0074-lane-residue-policy-and-universal-dep-provisioning.md — the contract
- fn-1309 (dep): both epics edit the autopilot worker; serialized by this edge

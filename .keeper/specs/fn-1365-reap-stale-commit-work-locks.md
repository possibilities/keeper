## Overview

A crashed `keeper commit-work` leaves an empty `<repo>/.git/keeper-commit-work.lock`; every later commit-work in ANY worktree of that repo then fails `stage_failed` (previews green) with an envelope that never names the lock, so workers block TOOLING_FAILURE on verified diffs. Four occurrences across three repos (arthack, agentbrain, keeper) in ~25h; each needs a manual operator sweep today. End state: the failure envelope names the lock when the lock is the cause, and a provably-stale lock is reaped automatically with an audited line.

## Quick commands

- `touch .git/keeper-commit-work.lock && keeper commit-work --preview-files` — a stale empty lock must be reaped (audited line) or named in the envelope, never a bare `stage_failed`.

## Acceptance

- [ ] A commit-work refusal caused by the repo lock names the lock path in its envelope.
- [ ] A provably-stale lock is reaped in-line with one audited log line; live-held locks always survive.

## Early proof point

Task that proves the approach: `.1`. If it fails: fall back to envelope-naming only (a) and keep the reap behind an explicit flag.

## References

- ~/docs/keeper-phase2-backlog.md item #51 (evidence: fn-2.1 6/6 stage_failed 07-18; keeper-repo sweep 07-19 00:0x)

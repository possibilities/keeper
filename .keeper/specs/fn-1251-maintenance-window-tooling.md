## Overview

Make the supported offline keeper.db reclaim maintenance a one-command,
discoverable, safe operation for a future agent or operator. Discovered by
performing the reclaim by hand: the flow today is ~8 manual steps stitched
across a CLI verb, a script, and raw launchctl, with a placeholder runbook
and a drain signal that counts the supervising session itself. Scope is
tooling + docs only; boot-time self-reclaim (letting the daemon reclaim
itself on restart) is explicitly OUT of scope.

## Quick commands

- `keeper reclaim --agent-help`  # should print resolved launchctl commands (task .3)
- `keeper await no-plan-workers`  # proposed unambiguous drain gate (task .1)

## Acceptance

- [ ] A single supported command runs the whole offline-reclaim window (pause → drain → snapshot → stop → reclaim → restart → verify → hold/play) with the same safety gates.
- [ ] "Is the board safe to stop?" is answerable by one unambiguous signal that excludes the supervising session.
- [ ] `keeper reclaim --agent-help` prints copy-pasteable resolved launchctl commands, not placeholders.
- [ ] A future agent can discover the supported runbook in one doc read.

## References

- Sibling daemon-hygiene epic: `fn-1248-crash-recovery-hardening` (task `.6` reduces backup churn; this epic is the operator-ergonomics side).
- The manual flow this replaces: `bun scripts/reclaim-db.ts` → `launchctl bootout gui/$UID/arthack.keeperd` → `keeper reclaim` → `launchctl bootstrap gui/$UID plist/arthack.keeperd.plist` → `keeper await server-up`.

## Overview

fn-837.2 wrote the DB reclaim (`reclaimDb` in src/backup.ts: VACUUM INTO + atomic
swap) but never exposed or ran it — the DB sits at ~1.2 GB vs a ~0.6 GB target, and
the un-run retention backlog is what kept re-starving the control plane after every
daemon restart this session. Wrap reclaimDb in a `keeper reclaim` CLI (offline:
daemon must be stopped — guarded), with post-reclaim verification, plus document the
operator runbook. The one-time run is an operator step after this lands.

## Quick commands

- operator runbook: `keeper autopilot pause` -> `launchctl bootout gui/$(id -u)/arthack.keeperd` -> `keeper reclaim` -> `launchctl bootstrap gui/$(id -u) <plist>` -> `keeper await server-up`
- verify: DB ~0.6 GB, `PRAGMA auto_vacuum`=2 preserved, schema_version unchanged, re-fold byte-identical

## Acceptance

- [ ] `keeper reclaim` runs reclaimDb (VACUUM INTO + atomic swap) on the live DB path; HARD-GUARDS against running while the daemon holds the DB (refuses if the UDS socket is live / daemon pid up)
- [ ] post-reclaim self-verify: new DB opens, schema_version unchanged, auto_vacuum=2, row counts on key projections match pre-reclaim; keeps a pre-reclaim snapshot
- [ ] operator runbook documented (README + the command's --agent-help)
- [ ] `bun run test:full` green (the backup.test.ts slow-tier file exercises it)

## Early proof point

The single task. If the swap corrupts or loses rows, the self-verify must catch it BEFORE deleting the pre-reclaim snapshot — fail loud, leave the original in place.

## References

- src/backup.ts reclaimDb (VACUUM INTO + atomic swap) + snapshot helpers; src/maintenance-worker.ts
- cli/ command registration pattern; test/backup.test.ts (slow-tier)
- the fn-837.2 runbook framing in the original handoff brief

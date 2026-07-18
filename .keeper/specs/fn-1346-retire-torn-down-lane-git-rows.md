## Overview

A torn-down lane worktree's live git projection row survives as phantom
whole-tree orphan dirt until the next daemon boot: always-watched
`.keeper` lanes are skipped by the vanished sweep and fail open through
the dwell path, so no runtime path can retire them. This epic closes the
retirement deadlock producer-side — the vanished sweep learns to retire
watched-and-gone roots behind an ENOENT-only, fail-closed discriminator —
and adds a teardown-side nudge so retirement is prompt instead of
full-sweep-latent. The existing GitRootDropped tombstone → retract fold
remains the sole retire path.

## Quick commands

- `bun test ./test/git-worker.test.ts ./test/git-live-projection.test.ts`
- `bun run typecheck`
- Operator post-deploy: land any epic, watch `keeper query git --json` — the lane's row disappears promptly after teardown instead of surviving with thousands of phantom deletions.

## Acceptance

- [ ] A watched lane whose directory is truly gone (ENOENT/ENOTDIR) is retired promptly after teardown: unsubscribed, tombstoned once, row deleted.
- [ ] A transient probe error on a live watched lane never retires it (fail-closed), and boot-path behavior is unchanged.
- [ ] Both teardown sites nudge the sweep after removals complete; a deferred/failed removal never triggers a retire.

## Early proof point

Task that proves the approach: ordinal 1 (its inverted vanished-sweep
fixture). If the nudge relay proves awkward: ship the producer-side sweep
fix alone and accept full-sweep latency — correctness does not depend on
the nudge.

## References

- The GitRootDropped → retractGitStatus tombstone machinery (the sole retire path; rewindLiveProjection is migration-only and stays untouched)
- The nudge-discovery worker→main→git-worker relay — the wiring precedent the teardown nudge mirrors
- CONTEXT.md "Live-only projection" — targeted producer-driven row retirement is sanctioned by the glossary
- Witness log: ~/docs/keeper-review-remediation.md (phantom rows 5176/5176 and 3881/3881; boot-rescan-only clearing)

## Docs gaps

- none — the glossary clause is already tightened; no new mutation point, no ADR

## Best practices

- **The deleting actor declares intent** — teardown signals the retire window; watcher/poll evidence alone cannot distinguish teardown from external deletion [tombstone pattern]
- **Vanished means ENOENT only** — every other probe error keeps the root; a stat blip must never retire a live lane [fail-closed discrimination]
- **One retire path** — the sweep owns unsubscribe+tombstone; a nudge only changes WHEN it runs, never introduces a second writer [single-writer discipline]

## Overview

Two silence classes let the incident hide: (1) the repair sweep deferred hourly on a dirty shared checkout for ~8 hours and the only trace was a greppable log line — and the existing `shared-checkout-dirty` distress family, which should have surfaced sustained dirt, never minted either; (2) the exit-watcher's tier-two stale-working sentinel pages on ANY working row with a live pid past 1h, so a parked-idle interactive human session re-mints an operator ack-row every 30 minutes (observed twice in one day for one idle session). This epic makes sustained sweep starvation operator-visible through the existing distress vocabulary, and stops benign parked-human sessions from generating ack toil.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/exit-watcher.test.ts test/daemon.test.ts`
- `keeper query dispatch_failures --json` — post-deploy: sustained shared-checkout dirt surfaces exactly one distress row; no stale-working rows for parked interactive sessions

## Acceptance

- [ ] A shared checkout dirty past the grace window reliably surfaces exactly one operator-visible distress row, and a starving repair sweep is attributable to it
- [ ] A parked-idle interactive session (no plan_ref) no longer mints tier-two stale-working ack-rows; plan-worker sessions keep full sentinel coverage
- [ ] One dirty checkout never pages as two incidents

## Early proof point

Task that proves the approach: `.1`. If the shared-checkout-dirty non-fire turns out to be by-design scoping (e.g. gated to worktree recover only): extend the trigger surface rather than minting a rival family.

## References

- docs/adr/0013 + docs/adr/0024 — the stuck-sentinel lineage `.2` amends
- Incident evidence: `# repair-defer ... class=dirty_checkout` deferred for hours with zero needs-human rows; stuck-sentinel:24367cf2 (an idle interactive session) re-minted twice in one day and required repeated operator acks
- fn-1198.1 Done summary — the confirmed starvation chain this epic makes visible

## Docs gaps

- **CONTEXT.md** (Needs-human entry): revise the family enumeration if the trigger surface changes; the "stale-working" policy stays under the existing stuck-sentinel term — no rival glossary entry
- **docs/adr/0013/0024 lineage**: new amendment recording the interactive-session carve-out
- **plugins/keeper/skills/watch/SKILL.md**: needs-human taxonomy notes if the trigger surface changes

## Best practices

- **Aging is lifecycle promotion** — dwell-time past a threshold promotes telemetry to a page; notify once on creation, never on every re-fire [practice-scout]
- **Idle-but-alive interactive sessions are soft telemetry** — never page on one; soften, don't blind [practice-scout]

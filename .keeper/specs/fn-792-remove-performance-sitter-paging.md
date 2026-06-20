## Overview

Converge the `performance` babysitter on the page-free pull model the
`helptailing` sitter (fn-791) defines: the scanner writes FINDINGS-LEDGER
followup files directly, spawns no agent, calls no botctl/notifyctl, and ships
no watchdog. Findings are discovered by running `/babysit-triage performance`.
Human decision (2026-06-11): push alerting made sense fighting a live fire;
the standing model is pull-based triage.

Known accepted trade: live-fire categories (`reducer-wedge`,
`duplicate-live-workers`, `autopilot-stall`) lose their real-time signal and
surface only at the next triage run. A future at-a-glance findings surface is
the eventual answer; deliberately out of scope now.

## Quick commands

- `bun babysitters/performance/watch.ts --tick` — full tick: scan → write followups → heartbeat (no spawn, no page)
- `ls ~/.local/state/babysitters/performance/followups/` — the corpus triage reads
- `grep -a -n 'botctl\|spawnAgent\|notifyctl' babysitters/performance/*.ts` — must come back empty post-convergence (note: watch.ts greps as binary, keep -a)
- `bun test test/keeper-watch.test.ts`

## Acceptance

- [ ] No agent spawn, no botctl/notifyctl call, no ack protocol anywhere under `babysitters/performance/`
- [ ] Scanner writes followups via the shared `babysitters/lib/` writer (byte-compatible with the FINDINGS-LEDGER three-shape contract; injection-safe Evidence fence preserved)
- [ ] Watchdog retired: watch.ts heartbeat stays, watchdog.ts + its test + its plist deleted, launchd uninstall documented
- [ ] Seen-state keeps dedup + held-tick confirmation gates; page-history fields dropped with a SEEN_STATE_VERSION bump (one-time re-baseline accepted)
- [ ] FINDINGS-LEDGER denominator rewritten (escalated = followup written, not paged); README install/uninstall/architecture match shipped reality
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: task 1 (the watch.ts convergence). If the shared
writer extraction fights fn-791's in-scanner writer shape, fall back to a
performance-local port of the same format and reconcile the lib extraction in a
follow-up — the corpus format, not the module boundary, is the contract.

## References

- `fn-791-build-helptailing-babysitter-producer` (overlap) — task 2 edits the same README install/uninstall blocks and FINDINGS-LEDGER.md; task 1 builds the followup writer this epic extracts into `babysitters/lib/` and consumes
- `babysitters/agents/performance.md:203-338` — the canonical followup format the scanner takes over (filename, frontmatter-canonical, injection-safe fenced Evidence, latest.md tmp+rename)
- `babysitters/FINDINGS-LEDGER.md:24-31` — the "denominator = PAGED findings only" contract being redefined
- `commands/babysit-triage.md:44-46,146-151` — triage already reads seen.json staleness as the scanner-absence signal (the watchdog's pull-model replacement)
- keeperd's OWN botctl alerting (src/integrity-probe.ts, maintenance-worker.ts, daemon.ts) is a separate concern — OUT of scope

## Docs gaps

- **babysitters/agents/performance.md**: deepest rewrite — from spawned-agent prompt to producer documentation (fn-791's agents/helptailing.md is the model) — task 2
- **README.md** (install 8/8b ~465–509, uninstall ~1184–1187, architecture ~2379–2416): drop spawn/page/watchdog prose, current-state only — task 2
- **babysitters/FINDINGS-LEDGER.md**: denominator + "page time" resurface-anchor wording — task 2

## Best practices

- **Don't keep an actionless watchdog:** a dead-man whose only response was a removed page gives false coverage; retire it and let the triage command's staleness check carry liveness
- **Staleness belongs in the artifact:** followup frontmatter gains `first_seen_at`/`last_seen_at` (schema-additive; the ledger join tolerates extra fields) so triage can rank by age
- **Recurrence is signal:** a finding that re-fires after its seen-entry TTL gets a NEW followup file — that is the resurface rule working, not a dedup failure
- **Atomic writes:** preserve tmp+rename for latest.md and per-finding files; triage may read mid-tick

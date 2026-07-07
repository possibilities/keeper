## Overview

Escalation sessions (`unblock::`, `deconflict::`, `resolve::`) are one-shot interactive sessions that idle forever after finishing, and every escalation guard counts a stopped-with-live-backend session as live — so a succeeded session starves its epic's escalation slot silently, a declined session never pages, and windows leak. This epic moves the escalation guards to turn-active occupancy, binds each session to its block instance (jobs-side stamps), scopes stage-3 paging per instance with a board-state verdict, adds an autoclose bucket that reaps finished escalation windows, and surfaces never-escalated (`blocked:`) suppressions in the board's needs-human block and the status envelope. Decision record: docs/adr/0017-turn-active-escalation-lifecycle.md.

## Quick commands

- `bun test test/daemon.test.ts` — escalation guard/classifier suites green
- `bun test test/reducer-projections.test.ts` — stamp + re-fold-determinism suites green
- `bun test test/autoclose-worker.test.ts` — bucket rail matrix green
- `bun test test/board.test.ts test/status.test.ts` — needs-human surfacing green
- `keeper status --json | jq .data.needs_human` — blocked-task subset member present
- `bun run typecheck`

## Acceptance

- [ ] A task that re-blocks while a prior finished unblock session still idles in its pane gets a fresh unblock dispatch (per-epic guard and per-key occupancy release on turn end, autoclose on or off)
- [ ] A declined unblock session pages the human as `declined` (not `died`, not never)
- [ ] Finished escalation windows (success path) are reaped by autoclose within grace; `autoclose_enabled: false` leaves windows open without starving any dispatch
- [ ] Homed `blocked:` suppression rows render in the top-of-board needs-human block, count in the banner, and appear as a named subset member in `keeper status` without double-counting `total`
- [ ] From-scratch re-fold reproduces all new stamps byte-identically

## Early proof point

Task that proves the approach: ordinal 1 (turn-active occupancy). If the permission-parked pin fails (a mid-turn prompt presents as `stopped`), the predicate gains the parked-marker live-arm named in that task's spec before anything downstream builds on it.

## References

- docs/adr/0017-turn-active-escalation-lifecycle.md — the decision record (amends 0007)
- `fn-1164-phantom-working-lifecycle-fix` (overlap) — schema-version collision (both bump SCHEMA_VERSION + keeper/api.py whitelist; whichever lands second rebases to the next number) and the same src/reducer.ts jobs-lifecycle fold neighborhood; also extends the same needs-human board surface (its .3 mints sticky anomaly rows)
- `fn-1167-variable-depth-automated-review` (overlap) — same src/daemon.ts escalation/paging machinery (.5 escalation grace landed, .4 in progress rides the block/escalation path)
- docs/adr numbering carries pre-existing collisions (two 0007/0008/0011/0012) — noted, out of scope here
- `keeper watch` gains no new delta type in this epic — the blocked-task class surfaces via board + status envelope only

## Docs gaps

- **CONTEXT.md**: reconcile `Needs-human` (third top-block class, count-vs-display language) and `Escalation dispatch` (turn-active occupancy) entries — revise, never append
- **CLAUDE.md**: autopilot escalation clause — turn-active cap + blocked-class-counts facts, net-neutral edit (size-gated)
- **plugins/keeper/skills/autopilot/SKILL.md**: hardcoded needs_human family enumeration goes stale
- **plugins/keeper/skills/watch/SKILL.md**: "six needs-human delta types" phrasing + 3x repeated filter lists — confirm phrasing against the envelope-only decision
- **README.md**: autoclose section gains a one-line escalation-window note (same knobs, no new config)

## Best practices

- **Re-verify at kill time (TOCTOU/CWE-367):** the actuator's read-then-kill gap is a race; the reap decision and the kill must ride one pulse's fresh read, and the instance stamp acts as a fencing token against acting on a superseded incident
- **Liveness is not progress:** pane/pid-alive as occupancy is the ghost-worker pitfall; turn-activity is the fix (Kestra's global-heartbeat failure caused duplicate execution — the same shape)
- **Correlation id, not name:** a spawn name identifies the incident class; the stamped event id identifies the instance — copy-forward causation-id pattern
- **Fail-closed destroy-only actuator:** any missing/ambiguous gate input skips the kill, never proceeds

## Overview

keeper has a long history of slowness, wedging, autopilot stalling, autopilot
erroneously starting jobs, autopilot running the same job multiple times, and
duplicate / unmerited approvals — each surfaced only by a human noticing after
the fact. This epic builds an always-on, escalate-only **babysitter**: a cheap
read-only scanner (`cli/keeper-watch.ts`) runs every 5 minutes under launchd,
detects those failure classes deterministically against `keeper.db`, and only
when something genuinely new appears does it spawn a headless `claude -p`
custom agent (`.claude/agents/keeper-babysitter.md`) that judges the ambiguous
class (unmerited approvals) and calls the human out via `notifyctl` + `botctl`.
End state: a standing watcher that catches the recurring whack-a-mole symptoms
automatically and pages a human to collaborate on a fix.

The scanner is a pure external observer — read-only connection, never writes
`keeper.db`, emits no synthetic events, performs no RPC. The headless agent
runs the PLAIN `claude` binary (not the `arthack-claude.py` wrapper) so the
keeper hook plugin is not loaded and the monitor's own sessions never pollute
the board it watches.

## Quick commands

- `bun run cli/keeper-watch.ts` — human-readable findings table for the live DB
- `bun run cli/keeper-watch.ts --json` — structured Finding[] (the agent's input contract)
- `bun run cli/keeper-watch.ts --tick` — launchd entry: scan, diff vs seen-state, escalate on new findings
- `bun run test:fast` — runs the new `test/keeper-watch.test.ts` detection unit tests
- `KEEPER_DB=/path bun run cli/keeper-watch.ts --json` — point at a sandbox DB

## Acceptance

- [ ] `keeper-watch --json` deterministically detects: dup-approve, dup-dispatch, dispatch-failure, daemon-down, reducer-wedge, dead-letter-growth, autopilot-stall, stuck-job, and surfaces approval-review items
- [ ] Each finding carries a stable `key` + `fingerprint` (no timestamps / pids / free-text in the fingerprint)
- [ ] `--tick` is silent (exit 0, no agent spawn) when nothing is new; escalates only on new findings
- [ ] First run / corrupt seen.json silently baselines (notifies nothing)
- [ ] Scanner opens the DB `{ readonly: true, prepareStmts: false }` and never writes it
- [ ] Hung agent is killed before the 300s interval; launchd always fires the next tick
- [ ] babysitter agent judges unmerited approvals and notifies via notifyctl + botctl
- [ ] launchd template installs/uninstalls cleanly per README steps
- [ ] `bun run lint`, `bun run typecheck`, `bun run test:fast` all pass

## Early proof point

Task that proves the approach: `.1` (scanner detection core). It is provable
in isolation against a seeded sandbox DB — including the live fn-728 dup-approve
signature (one `planctl_target` approved by 3 sessions in ~2 min) — before any
escalation, agent, or launchd wiring exists. If the deterministic detection
can't be made clean and false-positive-resistant here, the whole escalate-only
design is in question and we rethink before building tick/agent/plist.

## References

- Live symptom in the event log at planning time: `approve fn-728-exempt-approve-launches-from.2` dispatched 3x and approved by 3 distinct sessions at 10:24/10:25/10:26 (2026-06-07), matching 3 identical `chore(planctl): approve …` commits — the canonical dup-approve fixture.
- `src/db.ts` — `openDb` (~6022; `prepareStmts:false` mandatory, ~6044), `resolveDbPath` (~69), `resolveSockPath` (~84), `resolveDeadLetterDir` (~384), schema: `events` (~423), `jobs` (~724), `autopilot_state` (~1509), `dispatch_failures` (~1189), `reducer_state` (~1661)
- `src/reducer.ts:8032` — `reducer_state.updated_at = event.ts` (NOT wall-clock; do not use as a liveness heartbeat)
- `src/daemon.ts:938` — boot-appends `AutopilotPaused{paused:true}`; autopilot boots paused BY DESIGN
- `src/readiness.ts` — `computeReadiness`; autopilot-idle is usually a gate firing correctly, not a wedge
- `cli/session-state.ts`, `cli/keeper.ts` — CLI entry-shape + injectable-deps testability template
- `plist/arthack.keeperd.plist`, `plist/arthack.keeperd.logrotate.plist` — launchd templates to mirror (logrotate = periodic-job precedent)
- **Overlap (not a hard dep): fn-727** (revive autopilot window autoclose, in progress) writes `src/autopilot-worker.ts` + `src/readiness.ts`. No file conflict (babysitter adds new files only); semantic coupling only — if fn-727 changes how completion verdicts / `dispatch_failures` are recorded, recalibrate the autopilot-stall / stuck-job / wedge heuristics. Intentionally NOT wired as a blocking dep so the safety monitor isn't gated behind in-progress work.

## Docs gaps

- **README.md**: Install (add babysit plist symlink + `launchctl bootstrap` step beside the logrotate sidecar), Uninstall (add `bootout` + `rm`), Architecture (~L946, one sentence: out-of-process read-only scanner that never writes). `keeper-watch` is its OWN binary, not a `keeper` subcommand — do not add it to the subcommand enumeration as a subcommand.
- **CLAUDE.md**: one line under "Writes are tightly scoped" — the babysitter is a pure read-only external scanner (no event-log write, no synthetic events, no RPC).

## Best practices

- **WAL read-only:** open `mode=ro` (NOT `immutable=1` — bypasses locking, can return wrong answers / CORRUPT under a concurrent writer); keep each read txn <100ms and use a fresh connection per tick (a long-lived reader pins WAL frames and blocks keeperd's checkpoint). [sqlite.org/wal]
- **Bound event scans to a recent window** (e.g. last 1h by `events.ts`) so dup-approve / dup-dispatch stay O(recent), not O(all-events). [practice-scout]
- **launchd:** never mix `StartInterval` + `KeepAlive` (KeepAlive restarts immediately, defeating the interval); `StartInterval` resets from process EXIT (no-overlap for free, but a hung tick blocks all future ticks → the hard agent-timeout is load-bearing); no `~` in plist; set explicit `EnvironmentVariables.PATH` (no shell inheritance) including `~/.local/bin` for notifyctl/botctl. [launchd.info]
- **Dedup:** fingerprint on (check-type, stable-resource-id) + a `version` field; atomic write-then-rename of seen.json (never open 'w'); cooldown re-notify (~1h) + TTL prune so a persistent condition doesn't storm. [PagerDuty/Alertmanager]
- **Subprocess:** `await` the child (no zombie / no `nohup &`); gate the seen-state commit on exit 0; cap retries per fingerprint so a permanently-failing spawn doesn't re-attempt every tick forever. [headless-claude issues]

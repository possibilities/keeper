## Overview

keeper's window-reaper has three arms today: an autopilot verdict-gated arm, a
managed-session idle-gated arm (a hardcoded `{pair,panels,agentbus}` allow-list),
and a raw-OS-process orphan reaper. This collapses the two tmux-window arms into
ONE rule — a job's window closes when keeper created its session (birth-session
non-null), it stopped cleanly (`state` in `stopped`/`ended`, never `killed`), and
an idle grace elapsed — and deletes the orphan raw-process arm entirely (runaway
processes are fixed at their source, not by the daemon). The opt-out
(`disable_autoclose`) gains glob support and now gates every keeper session
including `autopilot`; the grace becomes a config key (default 3s). End state is
one legible sentence: a keeper-created tracked agent's window closes once it has
stopped cleanly and sat idle past the grace.

## Quick commands

- `bun run test:full`
- `bun test test/glob.test.ts test/reaper-worker.test.ts test/config.test.ts`

## Acceptance

- [ ] One unified reap predicate; the two tmux-window arms and the orphan arm are gone
- [ ] `disable_autoclose` accepts globs (`panels:*`) and gates every keeper session incl. `autopilot`; grace is config-driven (`autoclose_grace_seconds`, default 3s)
- [ ] Failed (`killed`) windows stay open; human-created (NULL-birth) windows are never touched
- [ ] Docs reflect the single rule; `bun run test:full` is green

## Early proof point

Task that proves the approach: `.1` (the dep-free glob leaf + the
`(session)=>boolean` matcher) — pure, isolated, and it unblocks the reaper rework.
If it fails (the hook import-graph constraint can't be met by a shared leaf):
inline the matcher in `pair-command.ts` and let `reducer.ts` keep its own copy.

## References

- The three arms: `src/reaper-worker.ts`; the allow-list: `src/exec-backend.ts:150`; the fnmatch helper: `src/reducer.ts:1107`
- Autopilot slot-occupancy coupling (why dropping the verdict gate changes re-dispatch): `src/autopilot-worker.ts:1107`
- Restore non-regression (a reaped window is `window_gone_server_alive`, never a restore candidate): `src/restore-set.ts:262`

## Docs gaps

- **README.md**: rewrite the autoclose/reaper sections (config block ~456, arch prose ~438, deep-dive ~3119, twelfth-worker thread ~3341) to the single rule; delete the orphan-arm paragraph + `disable_orphan_reap`; fix stale 60s/~20s timings; revisit the "four reapers" count
- **plugins/keeper/skills/pair/SKILL.md** & **plugins/plan/skills/panel/SKILL.md**: note `disable_autoclose` accepts globs (e.g. `panels:*`)

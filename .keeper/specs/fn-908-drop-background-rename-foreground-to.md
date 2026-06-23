## Overview

Keeper's `setup-tmux` provisions three human work sessions today —
`autopilot`, `background`, `foreground`. This collapses them to two by
removing `background` entirely and renaming `foreground` → `work`, so the
control plane is `dash` + `autopilot` + `work`. The change is a
site-targeted rename of the session-name string in three production
constants (`WORK_SESSIONS`, dash `SESSION_PRIORITY`, dispatch
`FALLBACK_SESSION`) plus the docstrings, docs, and constant-asserting
tests — no behavior or contract change. The managed `autopilot` session is
untouched.

## Quick commands

- `rg -n '"background"|"foreground"' cli/ src/ test/` — after the change,
  every remaining hit is an intentionally-kept incidental fixture or the
  busy-classification (pane-command) sense; zero session-name constants.
- `bun run test:full` — full tier (CLI/dash/tmux process paths) green.
- `keeper setup-tmux --help` — help text names two work sessions
  (`autopilot`, `work`) and "all three sessions" for `--kill-sessions`.

## Acceptance

- [ ] No `background` session is provisioned; `foreground` is renamed to
  `work` across the three production constants + their derivations.
- [ ] The dual-sense "foreground"/"background" busy-classification and the
  generic "background worker/task" prose are untouched; only session-name
  usages change.
- [ ] Docs (README setup-tmux + dispatch sections, dispatch SKILL.md)
  reflect two work sessions and the `work` fallback.
- [ ] `bun run test:full` passes.

## Early proof point

Task that proves the approach: `.1` (the whole rename). If it fails, the
dual-sense hazard or the restore-offer test redesign is the likely culprit
— re-check that edits are site-targeted and that the offer matrix collapsed
to a single restorable session.

## References

- Sequenced AFTER fn-907 (track live tmux pane location) and fn-902 (order
  dash by tmux window index): both edit `cli/setup-tmux.ts` /
  `src/dash/view-model.ts` / the dash test files. Running the rename last,
  as a grep-driven normalization over their landed code, avoids concurrent
  merge conflicts on the shared files.

## Docs gaps

- **README.md**: setup-tmux step (~615-627) + architecture mirror
  (~1340-1361) — two work sessions, "all three" kill count; dispatch
  section (~1032-1040) — `work` fallback, and fix the `--session
  background` example which names a removed session.
- **plugins/keeper/skills/dispatch/SKILL.md**: `:77` precedence cell +
  `:140` attach-hint sentence → `work`.

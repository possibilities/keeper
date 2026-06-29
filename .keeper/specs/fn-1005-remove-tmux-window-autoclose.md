## Overview

Delete the tmux window-AUTOCLOSE feature from keeper end to end so no automatic
window closing remains — the operator garbage-collects completed tmux windows by
hand. This removes the daemon window-reaper Worker, the `disable_autoclose` +
`autoclose_grace_seconds` config keys, the `resolveDisableAutoclose` matcher, and
the CLI-side pair reap (including its SIGTERM/timeout-path kill). After this lands,
every keeper-created window — autopilot/dispatch workers and claude/codex/pi pair +
panel partners — stays open until manually closed. The daemon reaper is already
off-by-default (`KEEPER_ENABLE_REAPER` unset); the behavior-changing piece is the
CLI-side reap that today closes codex/pi pair + panel windows.

## Quick commands

- `bun test` — the whole suite must stay green; the worker-fleet count assertion in `test/daemon.test.ts` is the tripwire.
- `grep -rn "autoclose\|reaper-worker\|disable_autoclose\|resolveDisableAutoclose\|KEEPER_ENABLE_REAPER" src cli test README.md plugins` — after the change, only the intentionally-kept overloaded-"reap" + fn-977 sites should remain (see References).
- `keeper pair send codex --role reviewer --prompt-file <f> --output <o>` — the partner's tmux window now stays open (no synchronous reap).

## Acceptance

- [ ] `src/reaper-worker.ts` is deleted and the daemon spawns ALL_WORKERS minus `reaper` with a green build + full test suite.
- [ ] The `disable_autoclose` and `autoclose_grace_seconds` keys no longer exist anywhere (parser, types, defaults, README, example, personal config).
- [ ] No automatic tmux window closing remains: the CLI-side pair reap (including the SIGTERM/timeout path) is gone; the SIGTERM handler still emits its terminal `failed` line.
- [ ] The KEEP set is untouched: all non-window "reapers" (autopilot / server-worker / seed-sweep / bus) and the fn-977 pane-id-recycle reducer logic + migration v92 + its test remain intact.
- [ ] `~/.config/keeper/config.yaml` no longer carries the `disable_autoclose` block.

## Early proof point

Task that proves the approach: `.1` (code + tests removal). If `bun test`'s worker-fleet count assertion or an orphaned-import typecheck fails, the deletion missed a wiring site — re-grep the four-link daemon chain + the three `KeeperConfig` return literals before proceeding.

## References

- **KEEP — overloaded "reap" (NOT autoclose):** autopilot completion-reap (`src/autopilot-worker.ts`), server-worker connection reapers (`src/server-worker.ts`, incl. the "reaper regressed" alarm at `README.md:1784`), seed-sweep pidless reap (`src/seed-sweep.ts`), bus channel reap (`src/bus-worker.ts`, `src/bus-db.ts`), and the arbitrary `test/handoff-worker.test.ts` fixture string.
- **KEEP — immutable, now consumerless:** the fn-977 pane-id-recycle terminal-clear reducer logic, **migration v92**, and `test/reducer-projections.test.ts:3915-3950` — a forward-only migration under sacred re-fold determinism; only their stale "window-reaper" rationale comments get rewritten forward-facing (and `test/db.test.ts:2430`).
- **KEEP — shared leaves:** `src/glob.ts` `compileFnmatch`/`isGlobToken` (still consumed by `src/reducer.ts`), and `DEFAULT_PAIR_SESSION` (drives the `--session` flag).
- Daemon worker-fleet removal is a 4-link chain (`WorkerName` union -> `ALL_WORKERS` -> spawn block + onerror/close guards -> shutdown registry), each mirrored by a `test/daemon.test.ts` assertion.

## Docs gaps

- **README.md**: prune the window-reaper worker-tour paragraph + renumber the ordinal tour, drop the two config-key docs + example comments, delete the autoclose deep-dive, fix the "fourteen workers" count.
- **plugins/keeper/skills/pair/SKILL.md**: rewrite the reap / `disable_autoclose` notes to "windows stay open for inspection".
- **plugins/plan/skills/panel/SKILL.md**: rewrite the panel-autocloses note to "panel windows stay open; attach with `tmux attach -t panels`".

## Best practices

- **Remove every worker lifecycle point, not just the spawn:** the `onerror`->fatalExit and `close`->fatalExit guards must go with the spawn block, or a late error event fires `fatalExit` on a process that already shut the worker down cleanly.
- **Grep the filename, not just symbols, for `import type`:** a dangling `import type` to a deleted module is a TS2307 build error that biome's unused-import rule does NOT catch.
- **Config parser is best-effort, not strict:** an old config still carrying the removed keys is silently ignored by construction — no migration gate needed.

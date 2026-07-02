## Overview

Panels are dead on current source: every panel leg launches as `keeper agent run … --name panel::<slug>::<preset>` but `parseRunArgs` rejects `--name` as an unknown flag, so all legs exit `bad_args` before writing a result. This epic teaches `agent run` the flag (threading it to the tmux window name uniformly, plus the harness-native name flag where one exists), adds the round-trip test class that would have caught the drift, and hardens the fresh durable-panel liveness path against pid recycle and reboot-during-wait.

## Quick commands

- `bun test test/agent-run-capture.test.ts test/pair-panel.test.ts test/agent-panel-cli.test.ts` — the P0 round-trip + liveness guard coverage
- `keeper agent panel start --slug smoke --prompt "say hi" && keeper agent panel wait --slug smoke` — live smoke once installed

## Acceptance

- [ ] `keeper agent run` accepts `--name <v>` / `--name=<v>`; panel legs launch clean end-to-end at the unit seam
- [ ] A round-trip test feeds `buildPanelLegArgv` output through `splitSubcommand` + `parseRunArgs` and fails if the two surfaces ever drift again
- [ ] A recycled pid can no longer read as a live leg (start-time cross-check), and a reboot mid-`wait` terminates promptly with a distinct reason instead of spinning to 124
- [ ] The stale resultless manifest at `~/.local/state/keeper/panels/keeper-stabilization-priorities` reconciles cleanly on the next `panel start`

## Early proof point

Task that proves the approach: `.1` — the round-trip test goes red against current source, green after the parse+thread change. If it fails: the flag can land in `parseRunArgs` as parse-and-ignore first (stops the bleeding), with window-name threading as a follow-up commit.

## References

- Live repro: `~/.local/state/keeper/panels/keeper-stabilization-priorities/` per-leg logs show `agent: unknown flag: --name`, outcome bad_args
- The interactive-path naming precedent: `src/agent/main.ts:2147-2168` (auto-mint suppressed by an explicit `--name`)
- Recycle-safe identity idiom: `src/bus-worker.ts:469-496` verbatim-compare via `readOsStartTime` (`src/seed-sweep.ts:101-130`)

## Docs gaps

- **README.md** (~1454): add `--name` to the `keeper agent run` flag enumeration, framed like `keeper dispatch --name`
- **README.md** (~1436): revise the panel liveness sentence in place — filesystem-only becomes three-signal (result file + boot epoch + pidfile + start-time cross-check)
- **README.md** (~1438): fold the `wait` reboot-guard behavior into the existing `panel wait` sentence

## Best practices

- **Round-trip the real parser:** builder-output-only tests pass while the target parser rejects the flag — the exact bug class here; the test must exercise `parseRunArgs` itself
- **`kill(pid,0)` proves occupancy, not identity:** pair the pid with a verbatim-compared OS start-time (`LC_ALL=C` `ps -o lstart=`) per the repo idiom
- **Boot-epoch derivation must be sleep-proof:** macOS Sonoma+ `os.uptime()` excludes sleep; verify the existing `bootEpochMs` seam derives from `sysctl kern.boottime`, not now()-uptime arithmetic, before reusing it in `wait`

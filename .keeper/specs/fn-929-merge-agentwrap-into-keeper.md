## Overview

Fold the agentwrap launcher (~6,078 LOC / 17 src modules, its own repo at
`~/code/agentwrap`) into the keeper binary as a `keeper agent …` subcommand
family, repoint every keeper launch call site at the in-binary surface, and
retire the external repo. This is the deliberately-sequenced capstone — all
agentwrap consumers (fn-890/893/894/896/903) are settled, so it rewrites a
FROZEN call-site set. End state: keeper is both the control-data daemon AND
the agent launcher; `keeper agent <claude|codex|pi> …`,
`keeper agent wait-for-stop <h>`, `keeper agent show-last-message <h>` are the
launch+wait+read surface; the external `agentwrap` binary is gone.

## Quick commands

- `keeper agent claude --help` — the folded launcher answers (standalone proof)
- `keeper agent claude --agentwrap-tmux --agentwrap-tmux-detached --agentwrap-no-confirm …` — detached launch returns launch JSON
- `bun run test:full` — MANDATORY (touches daemon + dispatch + db paths)
- `bun run test:hygiene` — no-real-git scan must stay green after vendoring tests
- `keeper dispatch work::<task>` — live dispatch smoke: a real worker lands via the in-binary path

## Acceptance

- [ ] `keeper agent <claude|codex|pi>` launches all three agents in-binary (foreground + detached), byte-identical argv / launch-JSON vs the retired agentwrap binary
- [ ] Every keeper launch call site (exec-backend seam, autopilot-worker, dispatch, pair, daemon boot probe) routes through `keeper agent`; no consumer spawns an external `agentwrap`
- [ ] The detached tmux pane verifiably re-execs `keeper agent` (not `src/daemon.ts`, not the external binary) — an integration test asserts the actual pane command
- [ ] `mapAgentwrapExit`'s {0,1,2,3,4} exit→breaker contract is byte-preserved; the `test/exec-backend.test.ts` byte-pin updated deliberately
- [ ] `bun run test:full` green; a live `keeper dispatch` smoke lands a real worker; soaked autopilot-paused before unpausing
- [ ] `~/code/agentwrap` archived with a provenance commit + tag; `bun unlink agentwrap`; docs (README / CLAUDE.md / skills / --help) reflect the in-binary surface

## Early proof point

Task that proves the approach: `.1` (vendor + `keeper agent claude` works
standalone). If it fails (cold-start blowup, import-graph contamination, the
dispatch wiring fighting the lazy loader): fall back to a thin `cli/agent.ts`
that shells `bun src/agent/main.ts` while the lazy-dispatch integration is
worked out — keeps the proof point reachable without blocking on the loader.

## References

- Original brief: `~/docs/merge-agentwrap-into-keeper.md`
- Foundation epics (done): fn-890 (tmux transport + wait-for-stop/show-last-message), fn-893 (keeper agentwrap exec-backend), fn-896 (retire pluggable exec-backend — agentwrap sole launch path), fn-894 (keeper pair via agentwrap), fn-903 (retire pairctl)
- Board clear at plan time (epic-scout: 349 epics, 0 open) — no dependency, reverse-dep, or write-overlap with any open epic

## Alternatives

- **Keep agentwrap external, only rename/repoint** — rejected: perpetuates the cross-repo JSON contract, a second `bun link`, the boot probe, and a second repo's CI for a launcher whose only consumer is keeper.
- **In-process module call (no subprocess)** — rejected for THIS migration: the launcher mutates `process.env`, installs signal handlers, and re-execs from `process.argv[1]`; in-process inherits the same argv[1] breakage AND a larger blast radius. Subprocess is the smallest delta; in-process is a separate optional later step.

## Architecture

agentwrap is the LAUNCHER that starts a claude session with the plugins loaded
(`plugin_scan_dirs` → keeper's `plugins/`); keeper is the control-data daemon
that runs under/alongside that session. Folding merges two layers into one
binary — deliberately (keeper-the-toolchain owns the launcher). No circularity:
`keeper agent claude …` only needs keeper on PATH; the launcher does not depend
on the daemon. The load-bearing seam is the detached tmux pane's SELF-re-exec:
agentwrap embeds `[bunBin, agentwrapBin, ...argv]` built from
`process.execPath + process.argv[1]`; under keeper `argv[1]` is `cli/keeper.ts`
(CLI) or `src/daemon.ts` (keeperd), so the fold must embed an explicit
`launcherArgvPrefix = [bunBin, <abs cli/keeper.ts>, "agent", …]` resolved from
`KEEPER_AGENT_PATH` — an absolute, symlink-resolved path that both fixes the
wrong-binary re-exec AND survives keeperd's stripped LaunchAgent PATH. The
launch primitive (`exec-backend` `buildAgentwrapLaunchArgv` / `agentwrapLaunch`)
and the `mapAgentwrapExit` exit→breaker contract stay byte-stable across the
repoint. keeper is pure-Bun (not compiled), so vendoring is source modules under
`src/agent/`, not a compile step.

## Rollout

1. Vendor + `keeper agent` standalone — the external binary still serves all
launches, zero behavioral change yet. 2. Land the self-invocation seam behind
the not-yet-repointed surface. 3. Repoint consumers with autopilot PAUSED (its
boot default); soak armed-off; live dispatch smoke before unpausing. 4. Only
after soak: keeper-side retire + docs, then archive agentwrap. Rollback at any
step: the archived repo + `bun link` restores the external binary, so keep it
archived (NOT deleted) until the in-binary path has soaked in real dispatch.

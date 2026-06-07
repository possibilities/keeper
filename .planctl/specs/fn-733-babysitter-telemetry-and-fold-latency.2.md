## Description

**Size:** S
**Files:** cli/keeper-watch.ts, cli/keeper-watchdog.ts, plist/arthack.keeper-watchdog.plist, README.md, CLAUDE.md

Close the "who watches the watcher" gap: the babysitter writes a liveness
heartbeat each completed tick, and a SEPARATE launchd job alarms if it goes
stale (the one failure class the babysitter structurally cannot self-report).

### Approach

**Heartbeat write** (in `tick()`): as the LAST action on every COMPLETED tick
path — including the missing-DB early-return and the silent-baseline path —
atomically write `{ts}` to `heartbeat.json` under `KEEPER_WATCH_STATE_DIR`
(reuse `atomicWriteFile`). The heartbeat attests "keeper-watch ran a tick,"
NOT "keeperd is healthy" (daemon-down is a separate detector). A crashed/hung
tick never reaches the write — which is exactly what the watchdog should catch.

**External watchdog** (`cli/keeper-watchdog.ts`, a tiny Bun CLI — chosen over a
shell for testability + consistency with the repo's Bun-first, biome-linted
cli/; mirrors the orphanwatch/dropwatch dead-man behavior): read
`heartbeat.json`; if `now − ts > WATCHDOG_STALE_SECS` (= `max(3×300s, 900s)` =
900s, accommodating launchd `StartInterval` jitter) alarm via `notifyctl` +
`botctl send-message --topic Chat`. Silent first-run (no heartbeat yet =
keeper-watch hasn't ticked, not dead); a once-daily all-clear so silence never
means the watchdog itself died. It must NOT depend on keeper-watch or keeperd
being up.

**plist** `arthack.keeper-watchdog.plist`: mirror `arthack.keeper-orphanwatch.plist`
— `StartInterval 600`, `RunAtLoad true`, `ProcessType Background`, explicit
`PATH` incl `/Users/mike/.local/bin` (notifyctl/botctl), absolute paths (no `~`),
StandardOut/Err under `~/.local/state/keeper-watch/`. TEMPLATE (manual symlink +
bootstrap, like the other keeper plists). Then the README/CLAUDE.md doc updates.

### Investigation targets

**Required** (read before coding):
- cli/keeper-watch.ts `tick()` :1194-1336 (the return paths where the heartbeat write lands) + `atomicWriteFile` :80 + `resolveSeenStatePath`/`KEEPER_WATCH_STATE_DIR`
- plist/arthack.keeper-orphanwatch.plist + plist/arthack.keeper-babysit.plist (plist templates to mirror)
- cli/session-state.ts / cli/keeper.ts (Bun CLI entry-shape for keeper-watchdog.ts)

**Optional** (reference as needed):
- README.md install step 8 / uninstall / architecture babysitter paragraph; CLAUDE.md :77-80

### Risks

- Heartbeat written too early (tick start) makes a hung tick look healthy — write it LAST, after scan+fold.
- Too-tight staleness threshold false-alarms on launchd jitter — 3× interval / 900s floor.
- Watchdog coupled to keeper-watch/keeperd would die with them — keep it standalone, reading only the heartbeat file.

### Test notes

Unit-test the watchdog's pure staleness decision (fresh ts → ok; stale ts →
alarm; missing file → silent first-run) with injected clock + file-read, no
real notifyctl. Heartbeat-write: assert `tick()` writes `heartbeat.json` on the
normal and missing-DB paths. Sandbox `KEEPER_WATCH_STATE_DIR`. Manual: stop the
babysitter, wait, confirm the watchdog pages.

## Acceptance

- [ ] `tick()` writes `heartbeat.json` atomically as the last action on every completed path (incl. missing-DB)
- [ ] `cli/keeper-watchdog.ts` alarms (notifyctl + botctl) when the heartbeat is older than the staleness threshold; silent first-run; daily all-clear
- [ ] The watchdog runs standalone (no dependency on keeper-watch/keeperd being up)
- [ ] `plist/arthack.keeper-watchdog.plist` mirrors keeper plist conventions (StartInterval 600, RunAtLoad, PATH incl ~/.local/bin, no `~`, template header)
- [ ] README (install 8b / uninstall / architecture) + CLAUDE.md updated
- [ ] Watchdog decision unit-tested; `bun run lint && typecheck && test:fast` pass

## Done summary

## Evidence

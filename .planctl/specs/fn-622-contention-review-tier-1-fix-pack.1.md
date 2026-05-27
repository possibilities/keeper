## Description

**Size:** S
**Files:** `src/server-worker.ts`, `README.md`, `plist/arthack.keeperd.plist`, `plist/arthack.keeperd.logrotate.plist` (new)

### Approach

Add a module-level `const TRACE = process.env.KEEPER_TRACE_SERVER === "1";` at the top of `src/server-worker.ts` (after imports, near the existing constants block). Wrap every existing `srvTs(...)` call site with `if (TRACE)` — this is the perf-critical detail: the caller's template-literal `msg` argument allocates BEFORE the function call would fire, so gating only inside `srvTs` defeats the purpose. The 8 known call sites: `src/server-worker.ts:1121`, `1135`, `1202`, `1206`, `1211`, `1218`, `1328`, `1337`. After the edit, `grep -n 'srvTs(' src/server-worker.ts` should show every match preceded by `if (TRACE)` on the previous line or the same line.

Leave the `[server-worker]` prefix error logs (`src/server-worker.ts:1231`, `:1351`, `:1357`, `:1390`, `:1439`) un-gated — they are the rare-error class, not the trace class.

README and plist documentation:
- In `README.md`, near the existing `KEEPER_SOCK` env var prose (around line 273), add `KEEPER_TRACE_SERVER=1` with a one-line description ("enables verbose server-worker diagnostic logging — `[srv-ts]` stage timings, frame byte counts, connection lifecycle; off by default").
- In `plist/arthack.keeperd.plist`'s `EnvironmentVariables` dict, add `KEEPER_TRACE_SERVER` with value `<string>0</string>` (operator-discoverable; flipping to `1` and `launchctl kickstart -k`ing the daemon enables tracing).
- Add a README install/upgrade step: a one-time `truncate -s 0 ~/.local/state/keeper/server.stderr` before re-bootstrapping the LaunchAgent on this upgrade. The 437 MB file already exists; this step recovers the disk space and is the only manual operator action this epic requires.

Rotation sidecar:
- Create `plist/arthack.keeperd.logrotate.plist`, a user-LaunchAgent that runs weekly (`StartCalendarInterval` Sunday 04:00 or similar). Its `ProgramArguments` invokes `/bin/sh -c "truncate -s 0 \"$HOME/.local/state/keeper/server.stderr\" && launchctl kickstart -k gui/$UID/arthack.keeperd"`. The plist's `Label` is `arthack.keeperd.logrotate`. No `StandardOutPath` / `StandardErrorPath` — output goes to the user's default launchd log; failures are observable via `launchctl print gui/$UID/arthack.keeperd.logrotate`.
- Document the install in the README install section: `cp plist/arthack.keeperd.logrotate.plist ~/Library/LaunchAgents/` then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/arthack.keeperd.logrotate.plist`.

### Investigation targets

**Required** (read before coding):
- `src/server-worker.ts:135-137` — `srvTs` definition; do NOT modify the body, only call-site wrappers
- `src/server-worker.ts:1121,1135,1202,1206,1211,1218,1328,1337` — all 8 `srvTs(...)` call sites; verify the grep matches before and after
- `src/server-worker.ts:1230-1232,1351,1357,1390,1439` — `[server-worker]` prefix error logs that stay UN-gated
- `src/db.ts:65,80,124` — the existing `KEEPER_*` env-var resolveX pattern (read-once-at-boot via `process.env`)
- `plist/arthack.keeperd.plist:33-43` — existing `EnvironmentVariables` block to extend
- `plist/arthack.keeperd.plist:57-60` — `StandardErrorPath` path (the file the sidecar will truncate)
- `README.md:230` and `README.md:273` — existing env-var prose (`KEEPER_WATCH_ROOT`, `KEEPER_SOCK`) to mirror

**Optional** (reference as needed):
- `CLAUDE.md` "Worker contract" — confirms server-worker is single-threaded, reading env once at module load is correct
- `man launchd.plist(5)` — confirms `StartCalendarInterval` shape for the sidecar plist

### Risks

- **Missed `srvTs` call site** → silent log regrowth. Mitigate: `grep -n 'srvTs(' src/server-worker.ts` post-edit confirms every match is gated. Add a one-shot check to the test (or a CI lint) if practical.
- **Sidecar runs while daemon is mid-write** → daemon's existing fd writes to a truncated file; offset doesn't reset until `launchctl kickstart -k` runs the next line. That's why the `&&` chain runs both in one shell invocation (truncate then kickstart). A failed truncate aborts the kickstart, which is the safer failure mode.
- **First weekly run after install lands while the operator is mid-debug** → daemon restarts with no warning. Mitigate: weekly cadence is rare; the README install note states the rotation cadence so operators expect it.

### Test notes

- Add a test (Bun `bun:test`) that imports `server-worker.ts` with `KEEPER_TRACE_SERVER` unset and confirms `srvTs` is NOT called from a synthetic dispatch path (mock socket fakes `data` chunk).
- Add a sibling test with `KEEPER_TRACE_SERVER=1` (set via `process.env` before import) confirming `srvTs` IS called. Note: module-level `const TRACE` means each test must spawn a fresh module-import; use `bun --define` or restructure the const into a getter for testability. Decide at implementation time which is cleaner.
- Manual: run `bun --eval 'process.env.KEEPER_TRACE_SERVER="1"; require("./src/server-worker.ts")'` and visually confirm `[srv-ts]` lines appear on stderr.

## Acceptance

- [ ] Module-level `const TRACE = process.env.KEEPER_TRACE_SERVER === "1";` declared once at the top of `src/server-worker.ts`
- [ ] All 8 existing `srvTs(...)` call sites wrapped with `if (TRACE)` — verified via `grep -n 'srvTs(' src/server-worker.ts`
- [ ] `srvTs` function body unchanged
- [ ] `[server-worker]` prefix error logs at lines 1231, 1351, 1357, 1390, 1439 remain un-gated
- [ ] `README.md` documents `KEEPER_TRACE_SERVER` near `KEEPER_SOCK`
- [ ] `plist/arthack.keeperd.plist` lists `KEEPER_TRACE_SERVER` under `EnvironmentVariables` with default `<string>0</string>`
- [ ] `plist/arthack.keeperd.logrotate.plist` created as a weekly sidecar LaunchAgent running `truncate -s 0 server.stderr && launchctl kickstart -k gui/$UID/arthack.keeperd`
- [ ] README install section documents the one-time `truncate -s 0` upgrade step AND the sidecar plist install (`cp` + `launchctl bootstrap`)
- [ ] `bun test` green

## Done summary

## Evidence

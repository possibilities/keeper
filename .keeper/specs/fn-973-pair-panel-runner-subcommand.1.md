## Description

**Size:** M
**Files:** src/pair/panel.ts (new), cli/pair.ts, test/pair-panel.test.ts (new)

### Approach

Add a `panel` sub-verb to `keeper pair` with two operations, `start` and `wait`, implemented in a
new `src/pair/panel.ts` orchestrator and dispatched from the existing sub-verb router. `start`
resolves panel members in-process, launches each panelist as a detached `keeper pair send` leg,
persists + prints a manifest, and returns immediately; `wait` blocks one chunk polling leg
terminality and emits an N-of-N verdict. All OS-specific machinery (detachment, polling,
deadline-bounding) lives here in TS — zero `setsid`/`timeout`/`gtimeout`.

**Member resolution** — re-implement panel-runner Step 0 in-process via `loadPresetRegistry()` /
`resolvePreset` (src/agent/config.ts) and the `runPresetsResolve` taxonomy (src/agent/main.ts):
a registry panel hit → its members (each `{name, harness}`); an unknown/undefined name → the
legacy two-model fallback, members `opus` (`--cli claude`) + `codex` (`--cli codex`); a single
preset name → a one-member panel. Build each leg's launch argv from `buildPairLaunchArgv` /
`resolvePairKeeperAgentPath` (src/pair-command.ts) + the `[process.execPath,
resolveKeeperAgentPath()]` self-re-exec prefix (daemon.ts:4575 precedent): `keeper pair send
<prompt> {--preset <m> | --cli <harness>} --read-only --session panels --output <dir>/<m>.yaml
--timeout <T>`.

**Detachment (the linchpin)** — do NOT rely on `Bun.spawn({detached:true}).unref()` alone;
interpose a short-lived POSIX shell that double-forks the real leg so it reparents away from the
exiting `start` process and captures the real backgrounded pid:
`Bun.spawn(['sh','-c','nohup "$@" </dev/null >"$LOG" 2>&1 & echo $! > "$PIDFILE"','--',
...legArgv], {detached:true, stdio:'ignore'}).unref()`. `nohup` is POSIX on both OSs and is
exactly what the panel-runner proved works by hand. Use `>"$LOG" 2>&1` (not `&>>`) — `/bin/sh` on
macOS is bash 3.2.

**Terminality (in `wait`), precedence — log-line authoritative, pid is the crash backstop only:**
(1) `<m>.yaml` exists → success (keeper pair send renames it atomically within the same dir);
(2) else `<m>.log` carries a `[keeper-pair] completed` / `[keeper-pair] failed` line → terminal
(the leg's guaranteed two-line contract, holds on every path incl SIGTERM) — capture the
`failed … error=` text, and a `pair: …` arg-fault stderr line, as the fail reason so it is never
blank; (3) else the pidfile pid is dead via the `pidAlive` idiom (daemon.ts:1581 — alive iff
resolves or EPERM, ESRCH = gone) AND past a short startup grace → crash fail; (4) else running.

**`start`** mints a fresh scratch dir (mktemp-style, on real APFS so keeper pair send's same-dir
atomic `--output` rename stays EXDEV-safe), writes the single prompt file there, launches every
leg, then writes `<dir>/manifest.json` via same-dir temp-then-rename and prints it to stdout:
`{dir, members:[{name,harness,yaml,log,pidfile}]}`. Launch-all-then-persist (manifest is
all-or-nothing); a per-leg spawn failure records that leg with no pidfile so it surfaces as a
normal N-of-N fail in `wait`.

**`wait`** is stateless across re-issues: re-reads `<dir>/manifest.json`, polls every leg on a
`Date.now()` deadline (`--chunk` seconds, default 540, rejected above a safe ceiling under the
600s Bash single-call cap) with a `Bun.sleep` interval (no busy loop). All legs terminal → print
verdict JSON, exit 0. Chunk elapsed → exit 124 (re-issuable). Missing/corrupt manifest or bad
flags → exit 2. **Exit 0 means all-terminal, NOT all-success** — the agent keys off the verdict.

**Verdict JSON** (the seam the agent consumes): `{dir, ok:<bool all-success>,
members:[{name, harness, status:"ok"|"fail", yaml:<path|null>, reason:<string|null>}]}`.
Content-blind: `wait` reads `.yaml` only for existence and `.log` only for the wrapper's own
event/error lines — NEVER a panelist's answer content.

### Investigation targets

**Required** (read before coding):
- cli/pair.ts:189-216 — sub-verb router + `parseArgs` options map; extend to route `panel` (peek `argv[0]==="panel"`, then `argv[1]` start|wait), add HELP + JSDoc
- cli/pair.ts:118-127 — `emitEvent` stdout convention; keep manifest/verdict JSON distinct from per-leg event lines
- cli/pair.ts:432-573 — codex trust seed (432-434), `buildPairLaunchArgv` usage, atomic same-dir `--output` rename (557-573): the leg-launch shape to reproduce
- src/agent/config.ts:368-424 — `loadPresetRegistry` (fail-open empty), `resolvePreset` (fail-loud `ConfigError`), empty-panel reject (393-396)
- src/agent/main.ts:647-676 — `runPresetsResolve` panel/preset/neither taxonomy to mirror in-process
- src/pair-command.ts — `buildPairLaunchArgv` (206), `PAIR_CLIS` (45), `DEFAULT_PAIR_SESSION` (666), `resolvePairKeeperAgentPath` (652), `resolveDisableAutoclose` (686)
- src/daemon.ts:1581-1589 — `pidAlive` idiom; src/daemon.ts:4570-4612 — `Bun.spawn` precedent + self-re-exec prefix
- src/exec-backend.ts:21 — the injectable "Bun.spawn-shaped subset" house pattern to follow for testability

**Optional** (reference as needed):
- src/codex-trust.ts — `ensureCodexDirTrust` (lock-serialized, fail-open); consider a one-shot pre-seed before fanout to remove N-leg lock contention
- test/agent-pair-subcommands.test.ts + test/helpers/{agent-main-harness,sandbox-env,retry-until}.ts — the DI harness + `sandboxEnv` + `retryUntil` patterns to mirror

### Risks

- macOS detached-child death on parent-exit: mitigated by the `nohup` double-fork wrapper; MUST have a test asserting a leg's `.yaml` still lands after `start` exits.
- pid-reuse / wrapper-pid / startup-race: mitigated by making the `.log` terminal line authoritative and pid only a backstop with a startup grace.
- `EXDEV` on macOS: keep every temp-then-rename (manifest + each leg `--output`) within the same scratch volume; never rename across `os.tmpdir()`.
- Orphaned legs after the agent's backstop: there is no `panel stop` verb — rely on each leg's `--timeout` + the codex synchronous reap / claude daemon reaper; document the `panels`-session blast radius (out of scope to actively kill).

### Test notes

Keep the new test in the FAST tier by injecting the spawn fn, clock, and pid-probe (exec-backend.ts
house style): a fake `keeper pair send` that writes `<m>.yaml` or a `failed` `.log` line after a
tick. Assert: full-success N-of-N verdict + exit 0; a mixed verdict (one leg writes a `failed` log
→ status fail, reason populated) still exits 0 with `ok:false`; `wait` exit 124 when the deadline
elapses with a leg non-terminal; manifest round-trip (`start` persists → `wait` re-reads);
legacy-fallback resolution (no registry → `opus`/`codex` members with `--cli` flags); `--chunk`
rejected above the ceiling. Extract any REAL-spawn detached-survival case into
`test/pair-panel.slow.test.ts` (folds into `test:full`). Run `bun run test:full` before landing.

## Acceptance

- [ ] `keeper pair panel start <prompt> [--panel <name>] [--dir <d>] [--timeout <s>]` resolves members (registry panel, legacy `opus`+`codex` fallback, or single preset), launches each as a detached `keeper pair send` leg via the `nohup` double-fork wrapper, persists `<dir>/manifest.json` + prints it, exits 0 immediately
- [ ] Detached legs survive `start`'s exit on macOS and Linux; no `setsid`/`timeout`/`gtimeout` anywhere in the path
- [ ] `keeper pair panel wait --dir <d> [--chunk 540]` blocks one chunk (`Date.now()` deadline + `Bun.sleep`, no busy loop), exits 0 with verdict JSON `{dir, ok, members:[{name,harness,status,yaml,reason}]}` when all legs terminal, exits 124 when the chunk elapses, exits 2 on missing/corrupt manifest or bad flags
- [ ] Terminality precedence holds: `.yaml` = success → `.log` terminal line = success/fail → pid-death-past-grace = crash fail; pid is backstop only
- [ ] `wait` is content-blind: never surfaces panelist answer content from `.yaml`, only existence + the wrapper's own event/error lines
- [ ] `--chunk` above the safe ceiling (under the 600s Bash cap) is rejected/clamped
- [ ] Fast-tier test covers success / mixed-fail / 124-timeout / manifest round-trip / legacy-resolution via injected spawn+clock+pid; `bun run test:full` green
- [ ] No keeper.db write, no RPC path, no third-party deps; cli/pair.ts JSDoc + HELP document `panel start|wait`

## Done summary

## Evidence

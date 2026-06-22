## Description

**Size:** M
**Files:** src/tmux-launch.ts

Harden the tmux subprocess layer so launches survive a stripped, C-locale
LaunchAgent environment. Four coupled changes, all in the spawn/argv core:
locale+TERM defaulting on every tmux spawn (Patch A), an ASCII `\x01` capture
delimiter replacing `\t` (Patch A, robustness), `=`-exact session targets
(Patch D), a bounded spawn timeout (Patch E), and absolute resolution of the
`tmux`/`bun`/`agentwrap` binaries (Patch F).

### Approach

- **Locale/TERM (A):** in `defaultTmuxCommandRunner` (~209-231) pass an `env:` to `Bun.spawnSync` built as `{ ...process.env, LANG: <utf8>, LC_CTYPE: <utf8>, TERM: process.env.TERM ?? "xterm-256color", COLORTERM: process.env.COLORTERM ?? "truecolor" }`. Default LANG/LC_CTYPE to a UTF-8 value (`C.UTF-8` or `en_US.UTF-8`) only when absent/non-UTF-8. NEVER set a global `LC_ALL`. MUST spread `...process.env` — `deps.env` IS `process.env`, and a bare object drops PATH and the `KEEPER_TMUX_PANE` carrier.
- **Delimiter (A):** replace the `\t` field separator in the `-F` capture format (`#{session_name}\t#{window_id}\t#{pane_id}`, ~261-297) with `\x01`, and update the `line.split("\t")` in `parseCreatedTarget` (~542) to split on `\x01`. This survives a C-locale server that sanitizes `\t`→`_`. Keep the `@`/`%` prefix assertions.
- **Exact targets (D):** `=`-prefix the `-t` targets on `has-session` and `new-window` (~265, ~278). Do NOT `=`-prefix the `new-session -s` create name (~291/292) — that creates a session literally named `=name`.
- **Timeout (E):** add a bounded `timeout` (a sane default, e.g. 5s for cheap commands; allow a longer bound for `new-session`) to the `Bun.spawnSync` call. Bun returns a result on timeout — map a timeout to a non-zero `TmuxCommandResult` the caller can classify (the exit-code taxonomy task consumes this), never an uncaught throw.
- **Absolute binaries (F):** resolve `tmux` to an absolute path before spawn (the `buildTmuxBase` literal `"tmux"` at ~402 ENOENTs under a stripped PATH) — resolve via a PATH scan against the known dirs or accept a deps-injected absolute path. Ensure `agentwrapBin` (main.ts `process.argv[1]`, may be relative) resolves absolutely so the post-`cd` re-exec in launch.sh finds it.

### Investigation targets

**Required:**
- src/tmux-launch.ts:209-231 — `defaultTmuxCommandRunner` (`Bun.spawnSync`, `isSpawnNotFound`); the A/E/F landing site.
- src/tmux-launch.ts:261-297 — `launchAgentwrapInTmux` argv builders (`-F` format, `-t`/`-s` targets); A-delimiter + D land here.
- src/tmux-launch.ts:531-547 — `parseCreatedTarget` (the `\t` split + `@`/`%` assertions).
- src/tmux-launch.ts:402 — `buildTmuxBase` (literal `"tmux"` argv[0]); F must resolve this.
- ~/code/keeper/src/exec-backend.ts:584-590 + :332 — keeper's `localeDefaultedEnv` + mint env reference implementation.

**Optional:**
- src/main.ts:179-181 — `bunBin`/`agentwrapBin` deps defaults (F).
- src/tmux-launch.ts:233-249 — `isSpawnNotFound`/`bufferToString` helpers (reuse for F not-found).

### Risks

- `Bun.spawnSync` timeout semantics on bun 1.3.14: confirm whether it returns a sentinel result vs throws; wrap into a classifiable result either way (a non-ENOENT throw currently escapes the runner's catch and crashes main with no exit code).
- The delimiter swap is a parse-contract change; pin it in tests so a regression surfaces.
- Do not `=`-prefix the `-s` create name (would change created session names).

### Test notes

Extend `test/tmux-launch.test.ts` via the injected `runTmuxCommandFn` seam (no real tmux here): assert the spawned argv carries the locale/TERM env and the absolute tmux path, the `-F` format uses `\x01`, `parseCreatedTarget` splits on `\x01`, targets are `=`-prefixed on lookups but not on `-s`, and a simulated timeout yields a classifiable non-zero result (not a throw). Keep all existing tests green.

## Acceptance

- [ ] tmux spawns carry `LANG`/`LC_CTYPE`/`TERM`/`COLORTERM` defaults with `...process.env` spread intact (PATH + `KEEPER_TMUX_PANE` preserved); no global `LC_ALL`.
- [ ] The `-F` capture format and `parseCreatedTarget` use `\x01`; a C-locale-style mangled `\t` no longer breaks the parse.
- [ ] `has-session`/`new-window` targets are `=`-exact; `new-session -s` create name is NOT `=`-prefixed.
- [ ] A bounded timeout yields a classifiable non-zero `TmuxCommandResult` (no uncaught throw); `tmux`/`bun`/`agentwrap` resolve absolutely under a stripped PATH.
- [ ] `bun lint && bun typecheck && bun test` green; existing behavior unchanged when env already has a UTF-8 locale.

## Done summary
Hardened the tmux spawn core: locale/TERM defaulting and an ASCII \x01 capture delimiter on every tmux spawn, =-exact has-session/new-window targets (create name untouched), a bounded spawn timeout mapped to a classifiable non-zero result, and absolute tmux/agentwrap binary resolution under a stripped PATH. New flags would have changed nothing; existing behavior is byte-identical when a UTF-8 locale is already set.
## Evidence

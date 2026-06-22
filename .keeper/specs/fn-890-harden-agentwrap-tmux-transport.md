## Overview

Patch agentwrap's `--agentwrap-tmux*` transport so a daemon with a stripped,
C-locale environment (keeper's autopilot, a macOS LaunchAgent) can drive every
agent launch through agentwrap instead of building tmux windows itself. Adds
locale/TERM hardening, an immediate machine-readable launch result decoupled
from the transcript-stop wait, a documented exit-code taxonomy, caller-controlled
env injection, exact session targeting, bounded tmux timeouts, absolute-binary
resolution, and run-artifact GC. Every change is backward-compatible and opt-in:
with no new flags, existing human/interactive behavior is byte-identical.

## Quick commands

- `cd /Users/mike/code/agentwrap && bun lint && bun typecheck && bun test`
- Stripped-env smoke (proves immediate JSON + C-locale parse): `env -i PATH=/opt/homebrew/bin:/usr/bin:/bin "$(which agentwrap)" claude --agentwrap-tmux-detached --agentwrap-tmux-L awtest$$ --agentwrap-tmux-session probe --agentwrap-tmux-env KEEPER_TMUX_SESSION=probe -p hi | jq . ; tmux -L awtest$$ kill-server`

## Acceptance

- [ ] Under `env -i` (C-locale) on a scratch `-L` socket, a non-`--wait-for-stop` launch prints exactly one parseable JSON line within ~1s and exits 0.
- [ ] Exit codes are distinct and documented: tmux-not-found / session-not-found = no-op code (3), timeout / lock contention = retryable code (4), bad-args = 2, internal = 1, success = 0; structured JSON is emitted even on error.
- [ ] `--agentwrap-tmux-env KEY=VALUE` (repeatable) injects validated env into the pane via tmux `-e`; dynamic-linker keys and malformed keys are rejected with bad-args.
- [ ] tmux session targets are `=`-exact; the tmux/bun/agentwrap binaries resolve absolutely under a stripped PATH.
- [ ] Run-artifact dirs are GC'd (age + liveness, count-cap, startup sweep) and `--no-artifacts` suppresses them; an in-flight run is never swept.
- [ ] With no new flags set, all existing agentwrap tests pass unchanged; `bun lint && bun typecheck && bun test` is green.

## Early proof point

Task that proves the approach: `.1` (tmux spawn hardening) — it proves the
C-locale JSON-parse path (locale default + `\x01` delimiter) end to end under a
stripped-env scratch socket. If it fails: the `\x01` delimiter swap is the
fallback that makes the parse robust even when locale-defaulting cannot reach an
already-poisoned server.

## References

- Enables a future keeper change (not in this epic): keeper's exec-backend swaps its hand-rolled `tmux new-window` to invoke patched agentwrap. Keeper's reference implementations to mirror: `~/code/keeper/src/exec-backend.ts:584-590` (locale + TERM/COLORTERM mint env) and the `KEEPER_TMUX_PANE` cross-repo drift-guard comment at `exec-backend.ts:158-165`.
- tmux locale is frozen at server startup (defaulting helps only the spawn that starts the server); prefer `C.UTF-8` / `LANG`+`LC_CTYPE`, never global `LC_ALL`.
- Exit-code taxonomy and machine-readable-CLI contract follow clig.dev + Rust CLI Recommendations (single-line JSON on stdout, diagnostics on stderr, stable `schema_version`, structured error on non-zero exit).

## Docs gaps

- **src/dispatch.ts (`AGENTWRAP_HELP`, ~57-95)**: add `--agentwrap-tmux-env KEY=VALUE` and `--no-artifacts` at the existing column alignment; note the new tmux-mode exit codes.
- **CLAUDE.md / AGENTS.md (`## tmux transport`, ~33-54)**: revise (not append) the flag list, JSON-stdout schema, exit codes, env-forwarding contract; add bullets for bounded timeout, absolute-binary resolution, locale/TERM defaulting, and runDir GC.

## Best practices

- **Locale only in the spawn env, never global `LC_ALL`:** pin `LANG`/`LC_CTYPE`/`TERM`/`COLORTERM` on the tmux `Bun.spawnSync` env (spreading `...process.env` so PATH and the `KEEPER_TMUX_PANE` carrier survive); a bare `env:` object wipes PATH.
- **`-e` env injection is exec-array, allowlisted, sanitized:** push `["-e", "KEY=VALUE"]` as argv elements (never shell-interpolated); validate keys, block `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`/`DYLD_*`/`LD_*`, strip control chars from values.
- **`=`-exact targets on lookups only:** `=`-prefix `has-session -t` / `new-window -t` targets, but NOT the `new-session -s` create name (that would create a session literally named `=name`).
- **GC gates age AND liveness:** never delete a run dir whose marker pid is alive; path-traversal-guard every `rmSync` to a direct child of the GC root; startup sweep, not `fs.watch`.

## Overview

Add a config-selectable `agentwrap` exec backend so keeper launches workers by
invoking the patched agentwrap CLI (which owns the tmux window) instead of
hand-rolling `tmux new-window` itself. `tmux` stays the DEFAULT backend and the
fallback — `agentwrap` is opt-in via the `exec_backend` config value, provable
before any default flip. The binding/lease/kill/list/rename/focus machinery is
UNCHANGED: keeper already discards the synchronous pane id and binds via the
SessionStart hook (`KEEPER_TMUX_PANE` + `KEEPER_TMUX_SESSION`), so only the
LAUNCH transport changes. agentwrap's one-line JSON + exit code are consumed
only to confirm the launch and classify retry.

This is round 2 of a two-part effort; round 1 (the agentwrap-side
`--agentwrap-tmux*` hardening) has landed.

## Quick commands

- `cd /Users/mike/code/keeper && bun test test/exec-backend.test.ts test/config.test.ts && bun run test:full`
- Smoke (opt into the backend, dispatch one worker): set `exec_backend: agentwrap` in config.yaml, restart keeperd, `keeper dispatch work::<some-task>` and confirm a worker binds in the `autopilot` tmux session exactly as under the tmux backend.

## Acceptance

- [ ] `exec_backend: agentwrap` selects a real second backend (`createAgentwrapBackend`); `tmux` stays the default + fallback; an unknown value still warns-and-falls-back to tmux.
- [ ] The agentwrap backend launches via `<abs-agentwrap> claude --agentwrap-tmux --agentwrap-tmux-detached --agentwrap-tmux-session <session> --agentwrap-tmux-env KEEPER_TMUX_SESSION=<session> …`, parses the one-line `schema_version:1` JSON, and maps exit codes 0/1/2/3/4 to launch/retry outcomes WITHOUT changing the hook-based binding/lease contract.
- [ ] agentwrap is invoked by ABSOLUTE PATH (config `agentwrap_path` + `KEEPER_AGENTWRAP_PATH` env override, `~` expanded at resolve time); a missing/bad path fails the launch loudly, not silently.
- [ ] Both autopilot and manual `keeper dispatch` honor the configured backend.
- [ ] `focusPane`/`listPanes`/`renameWindow`/`killWindow` are unchanged (shared with the tmux backend); crash-classification still reads `pid_died` correctly.
- [ ] `bun run test:full` is green; a byte-pinned agentwrap-stdout fixture guards the cross-repo JSON/exit-code contract.

## Early proof point

Task that proves the approach: `.2` (the agentwrap backend) — it proves the
full launch→parse→exit-map→bind path against a stubbed agentwrap spawn. If it
fails: the tmux backend remains default and fallback, so nothing in production
regresses while the approach is reworked.

## References

- Consumes the landed agentwrap contract (round 1): CLI flags + one-line JSON (`schema_version:1`, top-level `session`/`windowId`/`paneId`) + `TMUX_EXIT={1:internal,2:bad-args,3:noop,4:retryable}` — agentwrap `src/tmux-launch.ts:48-53`, `src/main.ts:468,482-515`. Crash-classification parity verified safe (agentwrap's `"$@"; exec "$0" -l -i` wrapper preserves pane persistence; keeper `src/exec-backend.ts:401-451`).
- Cross-repo drift: the JSON schema + exit-code taxonomy + the `KEEPER_TMUX_PANE` carrier are a cross-repo contract with NO shared module (matching-comment drift guard at `src/exec-backend.ts:158-165`). The new JSON-parse + exit-map adds a second such surface — guard it with a byte-pinned fixture (task .4).
- **Overlap awareness (rebase, not a blocking dep):** fn-889 (repo-wide codemod) also edits `src/daemon.ts`; fn-887 also edits `cli/dispatch.ts` + `docs/exec-backend.md`. These are different functions/regions — rebase carefully if either lands first; this epic is intentionally NOT dep-blocked on them so it can land independently.

## Docs gaps

- **README.md (`## Config` ~343-381, `## Architecture` ~2645,2734)**: list `agentwrap` as a valid `exec_backend`, add the `agentwrap_path` key + YAML example, drop the "tmux is the sole backend" prose.
- **docs/exec-backend.md (4, 21-45, 256-278)**: name both implementations; convert the "Extending to a new backend" guide from future-instruction to current-state (keep it as a perpetual how-it-works for further backends).
- **plugins/keeper/skills/dispatch/SKILL.md (lines 4, 21)**: "tmux window" → "managed window" (the dispatch skill routes through whatever backend is configured).

## Best practices

- **One central exit-code→outcome map**, never scattered `if exitCode===3`: `0`=launched, `3`=permanent no-op (no retry — conflating it with transient infinite-retries), `4`=transient (bounded retry via the normal expire path), `1/2`=hard fail (`2` is a keeper-built-bad-argv bug — loud, never retry); a timeout-kill (`signal!==null`) is its own class, distinct from a clean non-zero.
- **Parse stdout line-by-line, never `JSON.parse` a raw chunk**; validate `schema_version`, hard-reject unknown as permanent; wrap every parse in try/catch → INTERNAL and log raw bytes; drain stderr separately (reuse `runCapture`, which already does).
- **Absolute binary path, `~` expanded via `os.homedir()` at resolve time** (`execvp` doesn't expand `~`); env/config-overridable; do not blind-spread `process.env` into a third-party binary.

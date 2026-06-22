## Description

**Size:** M
**Files:** src/tmux-launch.ts

Add a generic, keeper-agnostic `--agentwrap-tmux-env KEY=VALUE` flag (Patch C)
that injects caller-controlled env into the launched pane via tmux `-e`, so a
driver can set e.g. `KEEPER_TMUX_SESSION` (and, in tests, the keeper isolation
vars) without agentwrap hardcoding any keeper knowledge.

### Approach

- **Parse (repeatable, new array shape):** add `--agentwrap-tmux-env` to `parseAgentwrapTmuxArgs` (~72-159, `VALUE_FLAGS` ~63-70). It is the FIRST repeatable option — accumulate into an array field on `TmuxLaunchOptions` (last-wins per duplicate KEY, or append — pick and document). MUST be consumed in this pre-pass (an unrecognized token leaks into the inner agent argv; existing tests assert the launch script contains no `--agentwrap-tmux*` tokens). Support split and joined (`--agentwrap-tmux-env=KEY=VALUE`) forms.
- **Validate:** key must match `^[A-Z_][A-Z0-9_]*$`; reject (bad-args, exit 2 via the taxonomy from task .2) a malformed key or a missing `=`. Hard-block dynamic-linker keys (`LD_*`, `DYLD_*`). Strip control chars (`[\x00-\x1f\x7f]`) from values before injection.
- **Inject:** push `["-e", "KEY=VALUE"]` argv elements onto BOTH `new-session` and `new-window` builders (~268-297) so cold-start AND warm-start dispatches get the env. Use exec-array form (never shell-interpolated); reuse `shellQuote` only where a string context demands it. Confirm the tmux `-e` minimum-version assumption holds for the installed tmux (macOS 3.x is fine).

### Investigation targets

**Required:**
- src/tmux-launch.ts:72-159 — `parseAgentwrapTmuxArgs` + `VALUE_FLAGS` (~63-70); the new flag is parsed here, as a separate pre-pass.
- src/tmux-launch.ts:268-297 — `new-session`/`new-window` argv builders; `-e` injection goes here.
- src/tmux-launch.ts:524-529 — `shellQuote` (reuse, don't duplicate).
- src/main.ts:1137-1147 — the `KEEPER_TMUX_PANE` carrier context (what keeper already reads from the pane).

**Optional:**
- test/tmux-launch.test.ts:156-165,293 — launch-script assertions; pin that injected env reaches the pane via `-e` and that no `--agentwrap-tmux*` token leaks.

### Risks

- First array-shaped option in `TmuxLaunchOptions` — keep the scalar VALUE_FLAGS path intact; don't regress the existing single-value flags.
- Silently dropping a rejected key is worse than failing loud (a missing `KEEPER_DB` would pollute the production feed in tests) — reject loudly with bad-args.
- `new-window -e` vs `new-session -e` version support: inject on both; the macOS tmux floor is fine, but assert behavior in tests.

### Test notes

Direct-call tests on `parseAgentwrapTmuxArgs` (new describe block — none exists yet) for repeat/dedup, split/joined, malformed-key reject, blocked `LD_*`/`DYLD_*`, control-char strip. Harness test: a valid `--agentwrap-tmux-env` reaches the pane via `-e` on both builders and never leaks into the inner argv.

## Acceptance

- [ ] `--agentwrap-tmux-env KEY=VALUE` is repeatable, accepts split + joined forms, consumed in `parseAgentwrapTmuxArgs`, and never leaks into the inner agent argv.
- [ ] Keys are validated `^[A-Z_][A-Z0-9_]*$`; `LD_*`/`DYLD_*` and malformed keys are rejected with bad-args (2); control chars are stripped from values.
- [ ] Injected env reaches the pane via tmux `-e` on both `new-session` and `new-window`.
- [ ] `bun lint && bun typecheck && bun test` green; `AGENTWRAP_HELP` lists the new flag at the existing column alignment.

## Done summary

## Evidence

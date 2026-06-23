## Overview

keeper pair lets a partner model run for `--timeout` seconds (default 1800), but
agentwrap's `wait-for-stop` has its own hardcoded 600s internal stop-wait deadline
that keeper never feeds — so a partner turn between 10 and 30 min dies at 10 min
with a retryable timeout. This epic makes keeper's `--timeout` the single source of
truth: agentwrap gains a `--stop-timeout-ms` flag on `wait-for-stop` (lands first),
and keeper emits it from its existing budget while widening its subprocess-kill
margin to sit strictly above agentwrap's worst-case return. The human surface
(`keeper pair send --timeout <seconds>`) is unchanged; the flag is a
machine-to-machine wire.

## Quick commands

- (agentwrap) `cd /Users/mike/code/agentwrap && bun lint && bun typecheck && bun test test/pair-subcommands.test.ts`
- (agentwrap) `agentwrap claude --agentwrap-help | grep -- --stop-timeout-ms` — flag is documented in help
- (keeper) `bun run test test/pair-command.test.ts` — argv emission + kill-margin assertions green

## Acceptance

- [ ] a partner turn between 10 and 30 min no longer dies at 10 min under the default `--timeout`
- [ ] agentwrap `wait-for-stop` honors `--stop-timeout-ms` and still defaults to 600s without it
- [ ] keeper's subprocess kill never pre-empts agentwrap's clean exit-4 retryable return
- [ ] both repos' suites green; both committed (agentwrap first)

## Early proof point

Task that proves the approach: `.1` (agentwrap `--stop-timeout-ms`). If extending the
`resolveHandle` arg loop proves awkward, fall back to a pre-pass in
`runTranscriptSubcommand` that strips the flag before `resolveHandle` sees `rest`.

## References

- Rollout ordering: agentwrap (`.1`) MUST land before keeper (`.2`). `agentwrap` on
  PATH (`~/.bun/bin/agentwrap`) symlinks into `/Users/mike/code/agentwrap` (verified),
  interpreted source with no build step — so a `.1` commit is live on the next
  `keeper pair`; the `.2`-depends-on-`.1` edge enforces ordering under autopilot. A
  new-keeper → old-agentwrap call would `BAD_ARGS` every pairing, which the ordering closes.
- Deadline race: agentwrap's path-discovery wait (≤30s, `DEFAULT_PATH_TIMEOUT_MS`) runs
  sequentially BEFORE the stop-wait clock starts, so its worst-case clean return is
  ~`stopTimeoutMs + 30s`; keeper's kill margin (`stopMs + 30s + 5s`) accounts for it.
- Future idea (out of scope): a single absolute `--deadline <epoch-ms>` covering both
  agentwrap phases would dissolve the two-clock race structurally; bigger change, deferred.

## Docs gaps

- **agentwrap `src/dispatch.ts` (USAGE + AGENTWRAP_HELP)**: add `[--stop-timeout-ms <ms>]` to the `wait-for-stop` line.
- **agentwrap `CLAUDE.md` (tmux transport)**: note `--stop-timeout-ms` overrides the 600s default at the subcommand level.
- **keeper `plugins/keeper/skills/pair/SKILL.md`**: compose-flow shows `wait-for-stop <id> --stop-timeout-ms <ms>`; the `--timeout` row notes it forwards as `--stop-timeout-ms` with a widened kill margin.
- **keeper `cli/pair.ts`**: wait-step comment + `buildWaitForStopArgv` JSDoc note the timeout wiring.

## Description

**Size:** S
**Files:** src/pair-subcommands.ts, src/main.ts, src/dispatch.ts, CLAUDE.md, test/pair-subcommands.test.ts

### Approach

Add a `--stop-timeout-ms <n>` (and `--stop-timeout-ms=<n>`) option to the
`wait-for-stop` subcommand. Parse it by extending `resolveHandle`'s existing manual
arg loop — mirror the `--agent` / `--agent=` branches exactly — and store the parsed
value on a new optional `stopTimeoutMs` field of `ResolvedHandle`. This keeps all flag
parsing in the one existing seam (no separate pre-pass) and rides the same `rest`
flow. Validate to a finite positive integer; a malformed value (`abc`, `0`, negative,
non-integer) returns `{ok:false, error:"--stop-timeout-ms must be a positive integer ms: …"}`,
which `runTranscriptSubcommand` already maps to `BAD_ARGS` (exit 2) — NEVER a silent
600s fallback. `runWaitForStop` threads `handle.stopTimeoutMs` into
`waitForTranscriptStop({ …, stopTimeoutMs })`; the consume point
(`?? DEFAULT_STOP_TIMEOUT_MS` at transcript-watch.ts:81) already exists, so an absent
flag still defaults to 600s (forward-tolerant). Keep `resolveHandle`'s strict
rejection of genuinely-unknown flags intact. Self-diagnosis: when the stop wait times
out, include the effective deadline and its source in the error string (e.g.
`timed out after 1800000ms (caller)` vs `600000ms (default)`) so the next failure
self-reports. Update the `wait-for-stop` line in `dispatch.ts` USAGE + AGENTWRAP_HELP
to show `[--stop-timeout-ms <ms>]`, and the CLAUDE.md tmux-transport sentence to note
the flag overrides the default at the subcommand level (forward-facing prose).

### Investigation targets

**Required** (read before coding):
- src/pair-subcommands.ts:53-116 — `resolveHandle` manual loop; the `--agent`/`--agent=` pattern to mirror; `ResolvedHandle` shape (add `stopTimeoutMs`)
- src/pair-subcommands.ts:182-205 — `runWaitForStop`; thread `stopTimeoutMs` into `waitForTranscriptStop`; the `!outcome.ok` timed-out error string
- src/transcript-watch.ts:32-56, 77-97 — `TranscriptWatchOptions.stopTimeoutMs` (already declared), the `?? DEFAULT_STOP_TIMEOUT_MS` consume at :81, `DEFAULT_STOP_TIMEOUT_MS = 600_000`
- src/main.ts:560-594 — `runTranscriptSubcommand`: `rest`→`resolveHandle`→`runWaitForStop`; BAD_ARGS at :570-573, RETRYABLE at :577-583
- src/tmux-launch.ts:48-53 — exit taxonomy (`BAD_ARGS:2`, `RETRYABLE:4`)

**Optional** (reference as needed):
- src/dispatch.ts:45,98 — USAGE / AGENTWRAP_HELP `wait-for-stop` line to update; :129-150 `splitSubcommand` passes `rest`
- CLAUDE.md tmux-transport section (~lines 90-92)

### Risks

- Exit-taxonomy collision: a malformed flag MUST surface as `BAD_ARGS` (2), never `RETRYABLE` (4); both are asserted in tests. Route it through `resolveHandle` returning `{ok:false}`.
- Do not weaken `resolveHandle`'s rejection of genuinely-unknown flags — only `--stop-timeout-ms` becomes known.
- `--stop-timeout-ms` is meaningful only to `wait-for-stop`; `show-last-message` shares `resolveHandle` and will tolerate (ignore) it — acceptable; note it.
- Optional hardening (non-blocking): cap absurd values (e.g. > 24h) so a misconfigured caller can't set a multi-century deadline; keeper only ever emits sane values, so omit unless trivial.

### Test notes

Mirror test/pair-subcommands.test.ts: (1) `resolveHandle` parse tests (:117-178 style) for
`--stop-timeout-ms 1800000` and the `=` form, flag-before-handle AND flag-after-handle,
asserting the value lands on the resolved handle; (2) malformed value → `BAD_ARGS` exit 2
via `makeHarness` end-to-end (:230-282 style, mirror the bad_args assertion :265-281);
(3) the injected-`stopTimeoutMs` bounded test already exists (:510-533) — add one asserting
`runWaitForStop` forwards a parsed flag into `waitForTranscriptStop`; (4) a genuinely-unknown
flag is still rejected. Run `bun lint` + `bun typecheck` + `bun test` (agentwrap has no test
gate and no `keeper commit-work` — standard git commit).

## Acceptance

- [ ] `wait-for-stop` accepts `--stop-timeout-ms <n>` and `--stop-timeout-ms=<n>`, in both orderings relative to the handle
- [ ] the parsed value is threaded into `waitForTranscriptStop` and bounds the stop wait
- [ ] malformed / zero / negative / non-integer value exits `BAD_ARGS` (2), never `RETRYABLE` (4), never a silent 600s fallback
- [ ] absent flag still defaults to 600s (`DEFAULT_STOP_TIMEOUT_MS`); genuinely-unknown flags still rejected
- [ ] the timed-out error reports the effective deadline + source (caller vs default)
- [ ] `dispatch.ts` USAGE/AGENTWRAP_HELP + CLAUDE.md note the new flag (forward-facing prose)
- [ ] `bun lint`, `bun typecheck`, `bun test` pass

## Done summary
agentwrap wait-for-stop now accepts --stop-timeout-ms <n>/=<n> (both orderings); parsed in resolveHandle as a positive-int ms (malformed → BAD_ARGS, never a silent 600s fallback), threaded into waitForTranscriptStop, with a self-reporting timed-out error (caller vs default). Documented in dispatch help + CLAUDE.md.
## Evidence

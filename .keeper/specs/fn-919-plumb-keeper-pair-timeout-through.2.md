## Description

**Size:** S
**Files:** src/pair-command.ts, cli/pair.ts, test/pair-command.test.ts, plugins/keeper/skills/pair/SKILL.md

### Approach

Make keeper's `--timeout` authoritative for the partner stop wait. Compute
`stopTimeoutMs = Math.ceil(timeoutSeconds * 1000)` ONCE (a fractional `--timeout` rounds
up to ms granularity), and use that single value for BOTH the emitted flag and the kill
margin so they are provably consistent. Extend `buildWaitForStopArgv` to take the ms value
and append `"--stop-timeout-ms", String(stopTimeoutMs)` (keep the conversion in one tested
seam — recommended: compute `stopTimeoutMs` in cli/pair.ts and pass ms into the pure
builder; a tiny pure `stopTimeoutMsFromSeconds` helper shared with the kill-margin calc is
an acceptable alternative). In cli/pair.ts, raise the `Bun.spawnSync` subprocess-kill
timeout from the bare `timeoutSeconds*1000` to `stopTimeoutMs + PATH_CEILING_MS + SLOP_MS`,
where `PATH_CEILING_MS = 30_000` (agentwrap's `DEFAULT_PATH_TIMEOUT_MS`) and
`SLOP_MS = 5_000`. RATIONALE (load-bearing): agentwrap runs its ≤30s path-discovery wait
SEQUENTIALLY before the stop-wait clock starts, so its worst-case clean RETRYABLE return is
~`stopTimeoutMs + 30s`; keeping the kill at `stopTimeoutMs` would SIGKILL agentwrap
mid-wait on a slow start, yielding a raw `waitRes === null` "spawn failed / killed" instead
of the clean exit-4. The kill MUST sit strictly above agentwrap's worst case. Add a named
const + comment noting the loose coupling to agentwrap's `DEFAULT_PATH_TIMEOUT_MS` (a future
bump there prompts a glance here; do NOT hard-import across repos). Keep the existing
`--timeout` reject of 0 / non-finite (cli/pair.ts:239-246 already guards `<= 0`). Update
SKILL.md (compose-flow + `--timeout` row) and the cli/pair.ts wait-step comment to note
`--timeout` drives `--stop-timeout-ms` and the widened kill margin (forward-facing).

### Investigation targets

**Required** (read before coding):
- src/pair-command.ts:262-267 — `buildWaitForStopArgv` (extend signature, emit flag); pure + exported
- cli/pair.ts:359-365 — the `wait-for-stop` spawn: `buildWaitForStopArgv` call + the 4th-arg kill timeout (both change)
- cli/pair.ts:239-246 — existing `--timeout` parse/validate (reuse `timeoutSeconds`; confirm 0 rejected)
- cli/pair.ts:124-146 — `runAgentwrap` spreads `{ timeout: timeoutMs }` into `Bun.spawnSync`

**Optional** (reference as needed):
- /Users/mike/code/agentwrap/src/transcript-watch.ts:50 — `DEFAULT_PATH_TIMEOUT_MS = 30_000` (the 30s the margin must cover)
- test/pair-command.test.ts:237-248 — pure argv-builder test pattern (`.toEqual` the exact argv)
- plugins/keeper/skills/pair/SKILL.md — compose-flow + `--timeout` row

### Risks

- The kill margin must STRICTLY exceed agentwrap's worst-case return (`stopTimeoutMs + 30s path + slop`) or the bug persists as a raw kill instead of a clean retry.
- Loose coupling to agentwrap's `DEFAULT_PATH_TIMEOUT_MS` — comment it; do not hard-import across repos.
- Keep `--timeout 0` / negative rejected (a zero `stopTimeoutMs` makes agentwrap time out on the first poll).

### Test notes

Pure-only, no real git (default tier — keeper's no-real-git rule): `buildWaitForStopArgv`
emits `--stop-timeout-ms <Math.ceil(timeoutSeconds*1000)>` including a fractional `--timeout`;
the kill-margin value equals `stopTimeoutMs + 35_000` and is strictly `> stopTimeoutMs`;
`--timeout 0` is rejected at arg parse. Run via `bun run test` (gated — never raw `bun test`).
Commit via `keeper commit-work`.

## Acceptance

- [ ] `buildWaitForStopArgv` emits `--stop-timeout-ms <Math.ceil(timeoutSeconds*1000)>`, conversion in one tested seam
- [ ] subprocess-kill timeout = `stopTimeoutMs + 30s + 5s`, strictly above agentwrap's worst-case return
- [ ] keeper always passes its resolved budget (authoritative even at the 1800s default)
- [ ] `--timeout 0` / non-finite still rejected
- [ ] SKILL.md + cli/pair.ts comment updated (forward-facing)
- [ ] `bun run test` green; committed via `keeper commit-work`
- [ ] depends on the agentwrap flag being live (task `.1`) before this runs

## Done summary

## Evidence

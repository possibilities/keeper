## Description

**Size:** S
**Files:** test/integration.test.ts

### Approach

The "exit-watcher folds a SIGKILL'd victim" test (~line 1758) spawns a
generated `victim-launcher.ts` child via `Bun.spawn` that parks forever
(`await new Promise(() => {})`) waiting to be SIGKILL'd. The happy path
kills it, but the `afterEach` at line 89 only reaps `daemon`, never
`victim`. Any timed-out or thrown run leaks the parked child, which spins
at high CPU and saturates the machine, cascading into more e2e timeouts
(observed: 5 leaked, up to 1d7h old, one at 97% CPU). Track every spawned
victim in a cleanup registry mirroring how `daemon` is tracked, and
SIGKILL it unconditionally in `afterEach`/`afterAll`. Also replace the
CPU-pegging `await new Promise(() => {})` park in the generated launcher
with a non-spinning idle (long keep-alive timer, or park on a signal) so
even a transiently-leaked victim stays cheap.

### Investigation targets

**Required** (read before coding):
- test/integration.test.ts:89 — afterEach teardown; reaps `daemon` only, add victim reaping here
- test/integration.test.ts:1758-1830 — the victim test: launcher write, spawn (1824), victimPid (1830)

**Optional** (reference as needed):
- test/integration.test.ts:1771-1796 — generated launcher body with the `await new Promise(() => {})` park

### Risks

- A leaked victim spawns its own inner hook child; killing only victimPid may orphan the grandchild — kill the process group or track descendants.
- Loosening deadlines could mask real regressions; prefer fixing the leak over bumping timeouts.

### Test notes

Run `bun test test/integration.test.ts` ~5x; after each, assert
`pgrep -f victim-launcher.ts` returns nothing. No leaked processes across
repeated runs.

## Acceptance

- [ ] `afterEach` (or `afterAll`) unconditionally SIGKILLs every spawned victim-launcher, mirroring the daemon teardown
- [ ] The generated victim-launcher no longer busy-spins while parked (CPU ~0 while idle)
- [ ] After 5 consecutive `bun test test/integration.test.ts` runs, `pgrep -f victim-launcher.ts` is empty
- [ ] jobctl commit-work --session-id ce3a8c4c-3295-43c8-9c96-f32915dc1b8e gate passes (no new lint/type failures)

## Done summary
Reaped leaked victim-launcher subprocesses via afterEach registry + process-group kill, and replaced the busy-spin park with a 24.8d setTimeout so idle launchers no longer peg CPU. 5x consecutive victim-test runs leave pgrep -f victim-launcher.ts empty.
## Evidence

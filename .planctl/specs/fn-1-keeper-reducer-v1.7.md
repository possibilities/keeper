## Description

**Size:** M
**Files:** test/integration.test.ts

### Approach

End-to-end smoke covering the full path: hook write → events row → `data_version` bump → worker wake → reducer drain → `jobs` projection.

Per test:
1. Create a fresh tmp dir; set `KEEPER_DB=<tmp>/keeper.db`.
2. Spawn the daemon via `Bun.spawn(["bun", "run", "src/daemon.ts"], { env, stdout, stderr })`. Wait briefly for boot drain + worker spawn.
3. Pipe a known JSON payload into the hook: `Bun.spawn(["bun", "plugin/hooks/events-writer.ts"], { env, stdin: payload, … })`. Run a sequence (SessionStart → UserPromptSubmit → Stop → SessionEnd) — pause ~200ms between each for the worker to wake and drain.
4. Poll the `jobs` table via a separate `openDb(path, { readonly: true })` connection with a `retryUntil` helper (e.g. up to 2s total, 50ms cadence) until the expected state is observed — assert: one `jobs` row exists, `state` transitions go `stopped → working → stopped → ended`, `mode` reflects the most recent `permission_mode` in the payloads, `last_event_id` matches `MAX(events.id)`.
5. Send `SIGTERM` to the daemon. Assert clean exit code 0.

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/dashctl/test/*.test.ts` — Bun test conventions (`bun test --isolate`, `expect`, lifecycle hooks)
- `src/db.ts` (task 2) — open + schema contract for the read-only assertion connection
- `plugin/hooks/events-writer.ts` (task 3) — stdin payload shape

**Optional** (reference as needed):
- [Bun spawn docs](https://bun.com/docs/api/spawn) — env propagation, stdin piping

### Risks

- **Timing flake** — the wake worker polls at 50ms; reducer drain is async. Use `retryUntil(predicate, 2000ms)` rather than fixed sleeps for assertions. Generous-but-bounded.
- **Daemon spawn pollutes test output** — capture stdout/stderr; only emit on failure.
- **`bun test --isolate`** is required so each test gets a fresh process (in-process bun:sqlite handles leak across tests otherwise).
- This test exercises the wake worker by design — do NOT shortcut by calling `drain()` directly. The whole point is to verify the wake path actually fires.

### Test notes

- Local invocation: `bun test --isolate test/integration.test.ts`.
- This test detects regressions in: hook DDL drift, hook → events insert, data_version visibility cross-process, worker → main wake delivery, reducer drain ordering, projection state transitions.

## Acceptance

- [ ] Test spawns daemon + pipes a known SessionStart/UPS/Stop/SessionEnd sequence through the hook
- [ ] `events` table contains exactly the expected rows in id order
- [ ] `jobs` row is created with `state` transitioning through `stopped → working → stopped → ended`
- [ ] `mode` reflects the latest `permission_mode` from the payload sequence
- [ ] `reducer_state.last_event_id` equals `MAX(events.id)` at end of test
- [ ] Daemon exits 0 on SIGTERM
- [ ] Test runs green locally with `bun test --isolate test/integration.test.ts`

## Done summary

## Evidence

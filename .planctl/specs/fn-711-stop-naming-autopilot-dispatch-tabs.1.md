## Description

**Size:** S
**Files:** src/exec-backend.ts, test/exec-backend.test.ts

### Approach

In the managed `launch` (`src/exec-backend.ts:~956`), stop forwarding
the `name` argument into `buildZellijNewTabArgs` — call it as
`buildZellijNewTabArgs(session, cwd, argv)` so `--name` is omitted
(the builder already drops `--name` for an empty/absent name; the
restore `ensureLaunched` path already does this). KEEP the `name`
param on `launch` — it still feeds the warn/log lines and is the
autopilot dedup key. Do NOT touch `composeWorkerArgv` — the
`--name verb::id` baked into the worker argv is the SessionStart
correlator and must stay. Trim the now-stale "the reconciler always
passes the worker's verb::id spawn name so the tab bar mirrors..."
sentences in the `launch` interface doc (~187–194) and the
`buildZellijNewTabArgs` doc (~373–379). The builder keeps its
optional `name?` param (its own unit tests cover both branches).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:956 — managed `launch` forwards `name` into `buildZellijNewTabArgs`; drop the forward
- src/exec-backend.ts:381-399 — `buildZellijNewTabArgs` already omits `--name` for empty/absent name (no change)
- src/exec-backend.ts:265-272 — `ensureLaunched` restore path already launches unnamed (the pattern to mirror)
- test/exec-backend.test.ts:262-265 — integration test asserts `calls[1]` contains `--name`; flip to `.not.toContain("--name")`

**Optional** (reference as needed):
- src/autopilot-worker.ts:951 — call site `backend.launch(argv, key, cwd)` (no change; `key` still passed for logs/dedup)

## Acceptance

- [ ] Managed `launch` calls `buildZellijNewTabArgs(session, cwd, argv)` (no `name` forwarded); dispatched tab is unnamed
- [ ] `composeWorkerArgv` `--name verb::id` correlator unchanged; `launch`'s `name` param retained for warn/log lines
- [ ] Stale doc sentences in `launch` interface + `buildZellijNewTabArgs` trimmed
- [ ] test/exec-backend.test.ts launch integration test flipped to assert `--name` is omitted; builder unit tests (109–130) unchanged
- [ ] `bun run typecheck` + `bun test test/exec-backend.test.ts` green

## Done summary

## Evidence

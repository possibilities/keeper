## Description

**Size:** M
**Files:** test/git-boot-seed.test.ts, test/session-state.test.ts, test/daemon.test.ts, test/events-writer.test.ts, test/server-worker.test.ts

### Approach

Close out the keeper-root real-process load. De-git `git-boot-seed.test.ts`
and `session-state.test.ts` by feeding synthetic snapshot/seed inputs
(reuse the pure seams from the producer task). For the real-subprocess
spawners, prefer the existing `withInProcessDaemon` over spawning a real
`keeperd`, and call the events-writer hook in-process instead of spawning
it; move per-test setup to `beforeAll` where file-local `--isolate` makes
it safe. Respect `withInProcessDaemon`'s parallel-safety contract: it
mutates `process.env` only inside a synchronous boot window then restores
before any await — do not add awaits in that window, and use the `workers:`
selector to avoid the `@parcel/watcher` dlopen SIGTRAP under `--parallel`.
Where a test genuinely needs a real process/real git to mean anything,
slow-quarantine it rather than fake the thing under test.

### Investigation targets

**Required** (read before coding):
- test/helpers/in-process-daemon.ts — `withInProcessDaemon(fn,{env,workers})`, the parallel-safe in-process boot + `disableNativeWatcher`
- test/helpers/sandbox-env.ts — `sandboxEnv(...)` for the hook-in-process env
- test/git-boot-seed.test.ts, test/session-state.test.ts — current `initRepo` usage

**Optional** (reference as needed):
- test/daemon.test.ts — which cases already use `withInProcessDaemon` vs spawn a real keeperd

### Risks

- `beforeAll` reuse can leak state across tests — only collapse where the
  shared fixture is read-only / re-derived per test; anything that mutates
  keeps its own setup.

### Test notes

Verify under `bun test --parallel` (not just serial) so the in-process env
window stays race-free.

## Acceptance

- [ ] git-boot-seed + session-state run with zero real git
- [ ] daemon/events-writer/server-worker prefer `withInProcessDaemon` / in-process hook calls over real spawns; no `@parcel/watcher` SIGTRAP under `--parallel`
- [ ] Genuinely process-dependent cases are slow-quarantined, not faked
- [ ] These files' isolated wall-time drops materially and they stay green under `--parallel`

## Done summary
De-gitted git-boot-seed + session-state via injectable seams (buildSnapshotForRoot, buildSessionState gitRunner/attribution) driven by synthetic payloads + a faked git runner; quarantined the genuine real-git discovery path to a .slow file. daemon/events-writer/server-worker already prefer withInProcessDaemon + slow-quarantine their process-dependent spawns; all green under --parallel.
## Evidence

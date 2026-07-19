## Description

**Size:** M
**Files:** src/codex-account-observation.ts, src/codex-account-observation-refresh.ts, src/codex-account-router.ts, src/codex-account-observer-worker.ts, src/account-routing-config.ts, src/daemon.ts, scripts/daemon-load-roots.txt, test/codex-account-observation.test.ts, test/codex-account-observation-refresh.test.ts, test/codex-account-router.test.ts, test/codex-account-observer-worker.test.ts, test/daemon-load-surface.test.ts

### Approach

Add a provider-qualified Codex control plane parallel to, not inside, the Claude `cswap` schema. A supervised import-inert DB-free worker invokes task 1's observer command with exact argv, a deadline, and an output cap, validates a versioned credential-free envelope, and atomically publishes a private sidecar. Consumers combine fresh worst-window headroom with a flocked, bounded, expiring pressure/cooldown ledger; deterministic least-recently-used ordering resolves ties, while stale or missing capacity produces a visible native-fallback decision rather than a false balanced route.

Reuse Keeper's shared refresh lock, exact-runner, atomic publication, `FileLock`, injected clock/runner, and worker-supervision patterns. The new surfaces never enter a Projection, reducer write, mutating RPC, or credential path, and worker cycle failures degrade observation without crashing the fold; unrecoverable worker lifecycle failures retain normal daemon-fatal semantics.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/account-observation.ts:390` — private atomic observation publication and strict read validation.
- `src/account-observation-refresh.ts:35` — stale-check, lock, double-check, and injected provider runner.
- `src/account-observer-worker.ts:1` — DB-free supervised worker lifecycle.
- `src/account-router.ts:490` — inspection, selection, and transient reservation mechanics.
- `src/file-lock.ts:143` — shared flock implementation.
- `src/daemon.ts:10692` — account observer spawn, error, and shutdown ownership.
- `scripts/daemon-load-roots.txt` — checked-in daemon load-surface boundary.

**Optional** (reference as needed):
- `docs/adr/0079-mandatory-claude-swap-routing.md` — Claude-specific policy that remains separate.
- `docs/adr/0090-keeper-managed-pi-codex-account-pool.md` — accepted Pi/Codex ownership and fallback decision.
- `test/account-observation-refresh.test.ts:67` — injected runner/clock and lock-contention tests.
- `test/account-router.test.ts:84` — freshness, reservation spreading, and inspection tests.

### Risks

- Extending the existing Claude schema would conflate mandatory launch routes with advisory Codex session routes.
- Concurrent daemon work touches `src/daemon.ts`; this task must remain dependency-gated against overlapping open epics before arm.
- Corrupt ledgers, lock timeouts, process death, clock skew, and stale observations must not create durable starvation or leak raw observer output.
- The `/wham/usage` source is internal and may drift; validation must retain the last good bounded snapshot without treating it as fresh.

### Test notes

Keep correctness tests pure with injected filesystem roots, clocks, locks, workers, and exact-argv outcomes. Cover schema/version/size rejection, PII stripping, atomic replacement, stale-last-good behavior, bounded lock contention, equal-score spreading, expired pressure cleanup, cooldown half-open recovery, all-unavailable native fallback, import inertia, abort shutdown, and daemon load-root inclusion.

### Detailed phases

1. Define provider-qualified observation and pressure schemas plus strict parsers and atomic files.
2. Add deterministic selector, diagnostics, and refresh coordination.
3. Add supervised worker and daemon load-surface wiring.
4. Pin every failure/cleanup edge with deterministic tests.

### Alternatives

Extend the Claude observation file — rejected because its identity, mandatory-failure, and Fable-conservation semantics are different. Publish capacity through SQLite/RPC — rejected because transient provider advice is not event-sourced control data.

### Non-functional targets

Observer stdout and files are bounded and PII-free; no cycle blocks the daemon event loop; no kernel watcher targets Keeper's DB; shutdown releases every worker-owned resource.

### Rollout

Publish in shadow/diagnostic mode first. The launcher may inspect the sidecar, but task 3 remains responsible for arming the companion and visible fallback behavior.

## Acceptance

- [ ] keeperd publishes and reads a separate versioned Codex capacity sidecar containing only opaque aliases, bounded quota windows, freshness, and sanitized status classes.
- [ ] Selection atomically combines fresh capacity with expiring cross-process pressure/cooldowns, spreads equal candidates deterministically, and returns a visible native-fallback verdict when usable pool evidence is absent.
- [ ] Observation and pressure remain DB-free transient files; no Projection, fold, mutating RPC, credential, raw provider response, token-derived identity, or account PII is introduced.
- [ ] The supervised worker is import-inert, cycle-fail-soft, shutdown-clean, load-surface-declared, and daemon-fatal only on unrecoverable lifecycle failure.
- [ ] Pure named tests cover malformed/stale data, atomic publication, last-good retention, contention, crash expiry, cooldown recovery, all-unavailable fallback, and PII/size bounds.

## Done summary
Added a provider-qualified Codex capacity observation/pressure/routing stack (observation sidecar, refresh coordination, deterministic selector, DB-free supervised observer worker) parallel to the Claude cswap schema, wired into the daemon load surface, with pure named test coverage for freshness, atomicity, contention, cooldown, and fallback edges.
## Evidence

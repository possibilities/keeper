## Description

**Size:** M
**Files:** src/account-routing-config.ts, src/account-observation.ts, src/account-observer-worker.ts, src/account-router.ts, src/file-lock.ts, src/daemon.ts, test/account-observation.test.ts, test/account-observer-worker.test.ts, test/account-router.test.ts

### Approach

Introduce a DB-free, PII-free account-routing core around the two installed public CLIs. A supervised observer invokes CodexBar and `cswap list --json` through an injected exact-argv runner, validates bounded freshness-bearing payloads, and atomically publishes only the latest normalized Capacity observation; launchers never parse raw external output or wait on provider network calls.

CodexBar health gates automatic balancing and contributes the native default route. claude-swap schema-v1 rows contribute managed `claude-swap:<slot>` routes; the active managed slot and native default must not appear as duplicate capacity. Unknown, stale, expired, signed-out, API-key-only, or otherwise unlaunchable rows are excluded without being converted to zero usage.

Replace the reserve ladder with a pure selector over all applicable normalized windows. Score each candidate by its worst effective utilization after short-lived, non-exclusive Launch reservations, prefer the greatest headroom, and use deterministic LRU plus stable route ID as tie-breakers. The flocked ledger owns only bounded reservation pressure and recency; it contains no account affinity or reserve latch.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/usage-picker.ts:1 — current DB-free picker contract, fallback semantics, and fixed-window assumptions to replace
- src/usage-picker.ts:156 — current selection and pending-reservation behavior
- src/usage-picker.ts:463 — flocked atomic state replacement pattern worth preserving
- src/usage-flock.ts:1 — close-on-exec lock primitive to generalize without widening ownership
- src/usage-scraper-worker.ts:1 — current supervised producer lifecycle and worker-message conventions
- src/daemon.ts:8562 — current usage worker spawn/lifecycle seam
- /Volumes/Scratch/src/steipete--CodexBar/docs/cli.md:38 — public JSON command, source, timeout, and exit-code contract
- /Users/mike/src/realiti4--claude-swap/src/claude_swap/json_output.py:53 — generic scoped windows, freshness, and schema-v1 serializer

**Optional** (reference as needed):
- /Volumes/Scratch/src/steipete--CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeSwap/ClaudeSwapAccountReader.swift:1 — bounded exact-argv reader precedent
- /Users/mike/src/realiti4--claude-swap/src/claude_swap/usage_store.py:41 — stale-on-error cache and freshness ceiling
- test/usage-picker.test.ts:145 — deterministic clock, malformed-state, and concurrent-selection fixtures

### Risks

CodexBar's ordinary provider payload is structured but not the app-only claude-swap projection, so the observer must not pretend it supplies managed rows. The two subprocesses can disagree in freshness or identity; only the documented active slot may deduplicate the native route, and PII fields must be dropped before logs or state. A worker crash or host suspend must not turn an expired reservation into an exclusive account claim.

### Test notes

Keep every test pure and in-process: inject command results, clocks, and state roots rather than spawning binaries, workers, a daemon, or tmux. Cover unsupported schemas, duplicate slots, malformed percentages/timestamps, oversized output, stale data, missing executables, partial provider failure, active-default deduplication, model-scoped windows, simultaneous picks, reservation expiry, and deterministic tie-breaking.

### Detailed phases

1. Define normalized observation, route, window, health, and error contracts plus strict parsers for the two public payloads.
2. Add the optional observer lifecycle and atomic mode-0600 sidecar with last-good freshness semantics and bounded diagnostics.
3. Generalize the lock primitive and implement the continuous selector/reservation ledger as pure policy.
4. Wire the observer into daemon supervision in shadow mode without changing launch behavior.

### Alternatives

Polling both CLIs synchronously in every launcher was rejected because it adds provider latency and stampedes refreshes. Depending on `codexbar serve` was rejected as an unnecessary third resident process. Reusing usage projections was rejected because capacity is transient launch advice, not event-sourced domain truth.

### Non-functional targets

Use no shell; cap each stdout/stderr stream and total JSON depth; enforce bounded deadlines and cancellation; write normalized state atomically with user-only permissions; never persist or log raw JSON, email, organization, credential paths, or tokens. Observation failure must consume bounded CPU and memory and must never block the daemon or a default launch.

### Rollout

Land the observer disabled for routing: it may publish health and candidate snapshots, but task 2 is the only seam allowed to consume them for launches. Retain the old usage runtime until the public-wrapper proof succeeds.

## Acceptance

- [ ] A normalized observation represents native and managed routes with arbitrary named/model-scoped windows, explicit freshness, and no PII.
- [ ] Automatic selection is disabled whenever CodexBar is absent, unhealthy, stale, malformed, or unsupported.
- [ ] Missing or unusable claude-swap inventory leaves only the native default route without surfacing an error to the launcher.
- [ ] The selector chooses the greatest worst-window headroom after reservations, with deterministic LRU and stable-ID tie-breaks, and contains no reserve latch or conversation affinity.
- [ ] Concurrent selections update one bounded, flock-protected ledger atomically and cannot stampede a single equally eligible route.
- [ ] The observer publishes one atomic user-private sidecar and retains no unbounded observation history.
- [ ] Adversarial parser, freshness, fallback, concurrency, and worker-lifecycle tests pass without real subprocesses or workers.

## Done summary

## Evidence

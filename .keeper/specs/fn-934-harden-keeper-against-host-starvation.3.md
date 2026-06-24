## Description

**Size:** S
**Files:** scripts/test-gate.ts, package.json, plugins/plan/test/fixtures/flock_peer.ts, plugins/plan/test/src-store-write.test.ts, CLAUDE.md

### Approach

Two test-infra leaks that let agent test activity oversubscribe the shared host.
(a) Test-gate bypass: `scripts/test-gate.ts` already enforces the `--parallel` cap
even under `KEEPER_TEST_NO_GATE` (only the lock is bypassed), but a RAW `bun test`
(not via `bun run test`/`test:full`) bypasses the gate script entirely — and the plan
plugin's own `bun test` (plugins/plan/package.json) is path-ignored by the keeper gate,
so it runs un-gated AND un-capped. Close the hole so an ad-hoc/agent test run can't
flood the host: route `bun test` through the gate (a `pretest`/wrapper enforcement, or
make the host-wide flock + cap apply regardless of entry point), and bring the plan
suite under a gate/cap too. (b) `plugins/plan/test/fixtures/flock_peer.ts` "hold" mode
busy-spins `while (!existsSync(releaseMarker)) {}` (~:34) with no sleep (95% CPU), no
max-hold deadline, no parent-death detection → leaks a spinning core forever when its
parent test dies. Replace the busy-spin with a `Bun.sleepSync` poll, add a max-hold
deadline (self-exit), and exit on parent death (`process.ppid` change/death). Verify
the `src-store-write.test.ts` marker-handshake timing still passes.

### Investigation targets

**Required** (read before coding):
- scripts/test-gate.ts:66 (`buildBunTestArgs`), :91 (`lockBypassed`/`KEEPER_TEST_NO_GATE`), :105 (`acquireGate`) — the gate; the raw-`bun test` bypass is the hole
- package.json:18-19 (keeper `test`/`test:full` route through the gate; `--path-ignore-patterns` excludes plugins/**); plugins/plan/package.json (the plan suite's own raw `bun test`)
- plugins/plan/test/fixtures/flock_peer.ts:34 — the busy-spin hold loop; plugins/plan/test/src-store-write.test.ts:281-307 — the marker handshake that uses it

### Risks

- A `bun test` wrapper must not break legitimate gated runs or the gate's own fail-open.
- The flock_peer timing fix must not break the cross-process contention test's handshake.

### Test notes

Verify a raw `bun test` is now gated/capped (or refuses to run uncapped); verify
flock_peer exits on parent death + max-hold and no longer busy-spins; run the existing
flock tests + `bun run test:full`.

## Acceptance

- [ ] A raw `bun test` (and the plan plugin suite) can no longer oversubscribe the host — it routes through / is capped by the host-wide gate.
- [ ] `flock_peer.ts` hold mode polls with `Bun.sleepSync` (no busy-spin), self-exits on a max-hold deadline, and exits on parent death.
- [ ] Existing flock/contention tests still pass; CLAUDE.md test-gate note reflects the current enforcement (forward-facing).

## Done summary
Closed the raw-bun-test gate bypass via bunfig.toml host-wide-flock preloads (keeper + plan suites, KEEPER_TEST_GATED avoids self-deadlock) and fixed the flock_peer hold-mode busy-spin to poll with Bun.sleepSync plus max-hold + parent-death self-exit.
## Evidence

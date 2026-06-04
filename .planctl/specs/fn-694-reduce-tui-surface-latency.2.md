## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/wake-worker.ts, README.md, CLAUDE.md, test/server-worker.test.ts, test/wake-worker.test.ts, test/daemon.test.ts

Lever B. The change pipeline crosses two serial 50ms `data_version`
polls: wake-worker poll → main folds → server-worker poll → patch. The
first poll is irreducible (the hook is fire-and-forget; main can only
learn via the wake-worker poll). Collapse the SECOND: after main folds,
kick the server-worker so it runs diffTick immediately instead of waiting
for its next poll tick. Also halve the first poll's worst case (50→25ms).

### Approach

**B1 — kick.** In `pumpWakes` (~:1386-1399), after `drainToCompletion(db)`
returns (post-COMMIT), `serverWorker.postMessage({type:"kick"})` — the
`{type:...}` shape matches the main→worker convention; the handle is in
scope (~:1437). In the server-worker's `parentPort.on("message")` handler
(~:2215-2276), add a `{type:"kick"}` branch alongside the `shutdown` check
(~:2229) that runs `diffTick(db, server.conns)` against the `main()`-scope
closures. Wrap diffTick in try/catch (log to stderr, continue) — the
handler is in the no-self-heal path, so an uncaught throw crashes the
worker. Keep the pollLoop (~:1750) as the level-triggered backstop; do not
remove or gate it. The kick does not advance pollLoop's local `last`, so
the next poll re-diffs — harmless (diffTick is version-gated and
idempotent; see test "does not double-send" ~:1492).

**B2 — halve wake poll.** `daemon.ts:1404` `pollMs: 50 → 25` and
`wake-worker.ts:54` `DEFAULT_POLL_MS 50 → 25` (already floored at
`MIN_POLL_MS=25`). Leave the server-worker pollLoop cadence as-is — it's
now backstop-only since the kick is the fast path.

**Docs.** Update README `## Architecture` (~:961) cadence + kick fast
path; CLAUDE `## Worker contract` (~:277) kick-as-fast-path; CLAUDE
`## DO NOT` polling-primitive rule (~:224) to clarify the in-process kick
is complementary, not a file watcher.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1386-1399 — `pumpWakes` / `drainToCompletion` call site (kick goes after the drain loop)
- src/daemon.ts:1437-1493 — `serverWorker` handle + existing `onmessage` bridge (kick is the opposite direction: main→worker postMessage)
- src/daemon.ts:1404 — wake-worker spawn `pollMs: 50`
- src/server-worker.ts:2215-2276 — `parentPort.on("message")` handler; shutdown check ~:2229 (where the kick branch slots)
- src/server-worker.ts:1477 — `diffTick` (sync, stateless across calls, version-gated)
- src/server-worker.ts:1750-1787 — `pollLoop` (backstop; tracks `last` locally)
- src/wake-worker.ts:54-55 — `DEFAULT_POLL_MS=50` / `MIN_POLL_MS=25`
- CLAUDE.md "Worker contract" — `{kind}` worker→main / `{type}` main→worker convention; isMainThread guard; no-self-heal

**Optional** (reference as needed):
- test/server-worker.test.ts:1492 — "diffTick does not double-send" (idempotency template for the kick test)

### Risks

- Kick handler throw → worker crash → keeper exits 1. The try/catch is load-bearing.
- Confirm Bun's worker event loop serializes the message callback against the `await Bun.sleep` resumption in pollLoop (no two diffTicks interleaving `sub.lastSent` mutation). Single-threaded, so expected — but assert it.
- B2 doubles idle wake-worker `PRAGMA data_version` reads (negligible); don't lower below the 25ms floor.
- Soft overlap with lever C (both touch server-worker.ts) — if C surfaces an in-scope diffTick/pollLoop fix, sequence it after this task.

### Test notes

Add a server-worker test driving the kick branch (call the message
handler with `{type:"kick"}` against the `fakeSock`/`watch` harness; assert
diffTick emits the pending patch, and a second kick is a no-op). Pass the
new `pollMs: 25` through `watchLoop` in test/wake-worker.test.ts. Validate
with bench-latency before/after (fold→surface latency for events from
OTHER sessions, which exercise the kick path).

## Acceptance

- [ ] main posts `{type:"kick"}` to the server-worker AFTER `drainToCompletion` returns
- [ ] server-worker `{type:"kick"}` branch runs diffTick against its conns, wrapped in try/catch (never throws out of the handler)
- [ ] pollLoop retained as backstop (not removed/gated)
- [ ] wake-worker poll lowered to 25ms (daemon spawn + DEFAULT_POLL_MS)
- [ ] kick + poll double-fire proven idempotent by test
- [ ] README/CLAUDE.md cadence + kick + polling-primitive prose updated
- [ ] full test suite green; bench-latency shows reduced fold→surface latency (record in Evidence)

## Done summary

## Evidence

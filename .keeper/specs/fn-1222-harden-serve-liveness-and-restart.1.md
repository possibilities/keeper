## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/bus-worker.ts, test/daemon.test.ts

### Approach

Make the serve-liveness probe incapable of killing the daemon it protects. Four moves, one
behavioral contract: a probe connection is closed on every settle path (including a timeout
that fires before the connect opens — the open handler must close a socket that arrives after
settling, not just `sock?.end()` at settle); any well-formed error frame carrying the probe's
correlation id counts as proof-of-life, and the per-pid cap-reject site passes the request id
through so its rejection frame is attributable; the daemon's own connections are exempt from
PER_PID_MAX_CONNECTIONS and censused in a distinct self bucket (settling whether capped peers
are self-probes or external clients); and each socket's probing arms on its own worker's
`{kind:"ready"}` message — the bus worker gains the ready emit it lacks — so a bus-only boot
arms correctly and no probe fires before its socket is bound. Factor the settle/match logic
into pure exported seams so the fast tier can cover the state machine without a real socket.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:3590 — probeSocketRead: the settle() + `let sock` assigned only inside open(s); the timeout-before-open leak
- src/daemon.ts:11805 — the probe isMatch `(f) => f.id === id` that scores id-less rejects as death
- src/server-worker.ts:3048 — per-pid cap-reject emitting errorFrame without the id; errorFrame itself (≈1999) already threads id when passed
- src/server-worker.ts:2513 — pidConnCount + logCapCensus (≈2519) census buckets the self-exemption extends
- src/daemon.ts:6288 — sw.onmessage bridge where `{kind:"ready"}` currently matches no branch; arming moves here
- src/server-worker.ts:3817 — the server worker's ready emit to mirror in src/bus-worker.ts

### Risks

- The self-exemption predicate must identify the daemon's own probe conns precisely (peer pid == daemon pid); an over-broad exemption re-opens the cap the reapers rely on
- Boot-grace interaction: arming per-worker must not shorten the effective grace for the later-binding socket

### Test notes

Pure-seam tests for the settle state machine (timeout-before-open, open-after-settled,
error-frame-with-id, error-frame-without-id) and for the census bucketing; the repro harness's
faithful probe copy gets the same fix so its detector stays honest. No real sockets in bun test.

## Acceptance

- [ ] A probe that times out before its connection opens leaves zero lingering connections, proven by a pure settle-seam test matrix
- [ ] An error frame carrying the probe's correlation id — including a cap rejection — is scored as proof-of-life by the probe matcher
- [ ] The daemon's own connections are exempt from the per-pid cap and reported in a distinct census bucket
- [ ] Each served socket's probing arms only after that worker reports ready, and a bus-only boot arms its bus probing
- [ ] Fast suite passes with the new seams covered; no test opens a real socket

## Done summary

## Evidence

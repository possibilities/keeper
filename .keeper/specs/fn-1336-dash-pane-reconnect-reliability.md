## Overview

Dash panes sat at DISCONNECTED after daemon recovery until a full rebuild,
while one-shot status calls were healthy. The reconnect loop exists and emits
rich telemetry, but recovery hinges on a close callback after self-terminate
(a stuck latch if it never fires), no connect-timeout bounds a hung dial, and
the on-screen banner renders none of the existing attempt/countdown telemetry.
This epic red-reproduces the wedge, hardens recovery unconditionally, fixes
the client-side stateless utf8 decode, and renders an honest three-state
banner — making routine recovery never require `keeper setup-tmux`.

## Quick commands

- bun test ./test/readiness-client.test.ts && bun test ./test/view-shell.test.ts
- bun scripts/subscribe-bounce-soak.ts

## Acceptance

- [ ] A deterministic red repro pins the exact wedge state, and the hardened client guarantees a scheduled reconnect even when self-terminate never re-drives close, with a bounded connect dial
- [ ] Panes recover from a daemon bounce without replacement; the flat-RSS soak gate stays green; every teardown stays hard-destroy
- [ ] A multibyte frame split across reads decodes intact; torn tails are discarded on reconnect
- [ ] The banner renders grace, retrying (attempt + countdown from the existing waiting payload), and DISCONNECTED + last-good-frame age; ADR 0019 is revised in place to the new model

## Early proof point

Task ordinal 2 is the risky core: its red test must reproduce a stuck
DISCONNECTED client under the injected socket seam before any fix lands. If
neither latch nor hung-dial reproduces: record the null result and land the
belt-and-suspenders hardening anyway (guaranteed reschedule + connect-timeout
are correct regardless of which wedge fired in production).

## References

- src/readiness-client.ts:1105 triggerReconnect (close-callback-dependent latch); :1522 connectOnce (no connect-timeout); :1641-1669 connectWithRetry await; :1554 stateless decode; :160-221 backoff/heartbeat constants; :56-63 terminate-not-end leak note
- src/view-shell.ts:620-895 banner state machine; :1231-1273 emitLifecycle (waiting payload sidecar-only); :1202 paintLiveFrame exitReconnecting-before-byte-compare
- src/server-worker.ts:3668 decodeConnChunk — the stateful decoder shape to mirror; test/server-worker.test.ts:281 snowman-split template
- docs/adr/0019-tui-readiness-gate-over-boot-status.md — records the current model; revise in place, one slice
- Epic deps: none (disjoint from fn-1335 and the dispatch-visibility epic — no daemon.ts contact)

## Docs gaps

- **docs/adr/0019**: revise the Decision/Consequences to the three-state banner + hardened recovery model — consolidate, never a second stale paragraph
- **CONTEXT.md**: only if the frame-age/retrying states earn first-class names; DISCONNECTED stays the sole dead-socket token; never "reconnect" in the resume sense

## Best practices

- **Ephemeral socket per attempt; attempt zero dials immediately; full-jitter small-base low-cap backoff; connect-timeout exceeds the backoff base**
- **ENOENT/ECONNREFUSED/EPIPE are lifecycle signals** distinguished only in the reason string; only a completed connect proves liveness
- **Frame-age from a monotonic stamp gated on frame recency, never socket state; degrade in place over blanking**
- **Injected socket factory + fake clock + injected RNG** keep every repro in the deterministic in-process tier; the seam must faithfully model terminate-without-close

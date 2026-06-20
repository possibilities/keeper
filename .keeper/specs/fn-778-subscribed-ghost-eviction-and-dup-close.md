## Overview

Two findings from the 2026-06-10 16:44 incident (evidence in
~/docs/keeper-reliability/2026-06-09-roadmap-state.md incident log): (1) the conn
cap saturated AGAIN post-fn-767 — set at 64 while the kernel held only 19 fds, with
~24 live long-running `keeper await` subscriber clients in the ecosystem: the leak
class is SUBSCRIBED ghosts, which fn-767's idle sweep deliberately exempts (the
fn-723 no-ping-pong descope — now invalidated by evidence); rejected clients'
reconnect-forever retries then burn ~20 conn-ids/min, amplifying saturation.
(2) While saturated, two `close::fn-608-squeegee-vtkeep-provenance-refs` finalizers
launched ONE SECOND apart (jobs created 16:44:21 + 16:44:22, both alive) — not the
cooldown-expiry pattern; the dispatch-time stamp should have suppressed the second.
Also observed: that boot came up paused=0 where prior boots came up paused=1.

## Quick commands

- `bun test test/server-worker.test.ts test/autopilot-worker.test.ts` — new tests green
- Soak: `grep -c max_connections ~/.local/state/keeper/server.stderr` flat over an hour under multi-agent await load

## Acceptance

- [ ] a subscribed connection whose peer process is gone is evicted within one reap pass (no ping/pong protocol change needed if the peer-pid probe approach is taken; otherwise the chosen mechanism is documented against the fn-723 descope rationale)
- [ ] `keeper await` (and sibling subscribe clients) back off exponentially with jitter on max_connections rejection (cap ~30s) instead of hammering
- [ ] the dup-close double-dispatch is root-caused with a written verdict (single-cycle double-fire vs stamp-visibility vs overlapping cycles vs other), fixed, and pinned by a test reproducing the same-second shape
- [ ] the boot pause state question is answered in Evidence (what governs paused-at-boot; why 2026-06-10 16:12 boot came up unpaused) and made deterministic if it was a bug

## Early proof point

Task that proves the approach: task 1's peer-liveness eviction. If macOS
LOCAL_PEERPID (or an equivalent Bun-accessible peer credential) is not retrievable
for UDS conns, fall back to a cap-pressure-triggered benign write that lets dead
peers EPIPE through the EXISTING evict path.

## References

- fn-767 (.planctl/specs/) + its Evidence — the idle sweep + every-tick reap this extends; the subscribed-exemption being the documented residual
- fn-723 spec — the original no-ping-pong descope rationale ("a faithfully-ponging orphan is indistinguishable from a quiet live viewer") — note the NEW mechanism must distinguish dead-peer from quiet-viewer, which peer-pid probing does and ping/pong does not
- fn-757 — reconnect-forever awaits (the retry-storm amplifier task 1 adds backoff to)
- CLAUDE.md "No in-process self-heal" + fn-723 carve-out — eviction is connection hygiene; the peer-pid probe matches the producers-probe-liveness pattern (exit-watcher precedent)

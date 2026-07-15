# 61. Bus takeover only over a dead predecessor

## Status

Accepted.

## Context

The Agent Bus keys a subscriber channel on `(pid, start_time)` identity and, on a
duplicate registration, unconditionally evicts the prior channel (a takeover).
That rule assumes the newcomer is a reconnect and the predecessor is stale — the
right call after a network blip, where the old connection is dead but not yet
reaped. It is exactly wrong when both connections are alive: each evicted
watcher's reconnect loop re-subscribes within its 250ms floor and evicts the
other, an infinite eviction war. One session that accidentally armed two
`keeper bus watch` processes sustained ~3.6 takeovers per second, saturating the
bus accept loop hard enough to trip the serve-liveness watchdog
([ADR 0059](0059-bus-only-serve-stall-degrades-in-place.md)). One agent has no
reason to hold two bus connections — duplicate live subscribers are a defect to
reject, not a topology to serve — and [ADR 0062](0062-unified-session-history-and-resume.md)'s
Refuse-live contract keeps one-live-session-per-identity load-bearing for resume.

## Decision

A takeover is legal only over a dead predecessor. On duplicate registration the
bus probes the existing channel's connection: dead — evict and admit the
newcomer, the classic reconnect; alive — refuse the newcomer with a typed
`duplicate_subscriber` rejection so it terminates visibly instead of fighting.
The watch client treats that rejection as terminal, not retryable. The client
reconnect loop additionally gains jitter and stops resetting its backoff on
short-lived sessions, so any residual eviction churn builds real backoff instead
of a 250ms lockstep. Watch arming stays idempotent per session so a resume does
not mint a second watcher in the first place. `send_only` registration keeps its
no-presence carve-out untouched.

## Consequences

- Two live watchers under one identity can no longer manufacture an eviction
  storm; the defective duplicate exits with a diagnosable error naming the
  contract it broke.
- Genuine reconnects keep working unchanged — a dead predecessor is evicted
  exactly as before.
- Single-holder identity semantics survive, so ADR 0062's Refuse-live contract
  and the Presence vocabulary keep their meaning without amendment.
- The probe adds one liveness check to the duplicate-registration path only; the
  common single-registration path is untouched.

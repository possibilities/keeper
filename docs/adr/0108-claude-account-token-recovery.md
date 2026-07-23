# 108. Claude Account token recovery

## Status

Accepted. Narrows ADRs 0100 and 0101 while preserving mandatory claude-swap routing, claude-swap-owned credential and Measurement authority, stable PII-free Account routes, and fresh Capacity admission.

## Context

A current `cswap list --json` response can revoke one Account route with `usageStatus: token_expired`. claude-swap can make one owner-profile recovery request that establishes a non-expired identity-matched OAuth credential, but that credential result does not establish current usage or route eligibility. Treating recovery stdout as capacity would combine credential mutation with routing authority and could launch through an account whose usage remains unavailable.

Recovery also needs a bounded retry posture. Repeating an expensive credential operation every observation cycle ignores provider direction; permanently suppressing it leaves no operator escape. A daemon-owned worker, durable event, or public recovery projection would add lifecycle and privacy surface to transient credential maintenance.

## Decision

claude-swap is the sole credential owner. Keeper invokes exactly one request as `cswap recover <positive-slot> --json`, validates the bounded versioned envelope, and maps its fixed statuses to the PII-free Keeper outcomes `recovered`, `not-needed`, `retry-later`, `human-required`, `tool-failure`, and `recovery-unverified`. Unknown fields needed for authority are never inferred, and stdout or stderr is never logged.

The existing DB-free AccountObserver owns automatic recovery. Each cycle follows this fail-closed order:

1. refresh through the shared lock and publish the current Capacity observation;
2. let that fresh healthy observation revoke routing for every `token_expired` row;
3. choose at most one due expired slot in current inventory order and acquire its nonblocking recovery lock;
4. wait boundedly for the refresh lock, make an owned list call, and revalidate that same stable route without switching slots;
5. durably increment and cap its attempt count and set the next deadline before any recovery side effect;
6. make one bounded recovery request; and
7. wait boundedly for the refresh lock, then make and publish an owned verification list.

Recovery output never authorizes an Account route. Only an owned post-recovery Capacity observation can restore normal routing. Automatic recovery clears a slot's retry state only when fresh positive evidence removes token expiry or removes the slot. A positive recovery result without fresh route evidence remains `recovery-unverified` at the foreground boundary.

One private owner-only atomic sidecar holds schema-versioned, PII-free per-slot retry state, capped at the managed inventory bound. Every attempt prearms suppression before invoking recovery, so a crash cannot erase its backoff. Later retry, tool, and unverified outcomes retain that state; `human-required` refines it to a latch. Automatic failures back off for 3, 6, 12, 24, 48, then 60 minutes. Only fresh positive Capacity evidence clears state. Per-slot nonblocking file locks preserve single-flight across the observer and foreground command; sidecar-lock contention also fails immediately rather than blocking a Worker.

`keeper agent accounts recover cN [--json]` is the foreground escape. It makes an owned list before resolving the strict current zero-based label, returns `not-needed` for an already healthy route, revalidates the same route under its slot lock, invokes recovery only for token expiry, and refuses other issues. It bypasses prior automatic backoff and the human latch by prearming a new attempt, never by clearing first. After `recovered` or `not-needed` from claude-swap, it makes another owned list and succeeds only when the exact route is fresh and healthy. The Keeper command creates no Keeper Launch reservation or Harness session; claude-swap recovery intentionally starts one bounded Claude canary. Normal route selection remains mandatory for subsequent Keeper launches.

The bounded runner accepts an AbortSignal and owns timeout, abort, output-cap, termination, and child joining. AccountObserver shutdown aborts the current provider child and lets the typed worker loop settle before the Worker exits.

No Keeper database table, event, RPC, daemon worker, distress row, load-manifest root, Terminal Control action, browser login, or Keeper-owned credential store is added.

## Alternatives considered

- **Authorize routing from `recovered`.** Rejected because identity-matched OAuth health proves neither usage nor quota eligibility.
- **Retry every observer cycle.** Rejected because persistent exponential suppression is required for provider-safe automatic maintenance.
- **Suppress forever after `human-required`.** Rejected because an explicit, observable foreground retry is a necessary operator escape.
- **Use one global recovery lock.** Rejected because ownership is per credential slot; unrelated slots need independent single-flight boundaries.
- **Add durable daemon control data.** Rejected because recovery state is transient, bounded, DB-free, and reconstructible from Capacity.
- **Open a browser or run interactive login.** Rejected because Keeper requests only claude-swap's noninteractive owner-profile operation.

## Consequences

- A token-expired account disappears from routing before any recovery attempt and returns only through fresh Capacity evidence.
- Automatic recovery attempts at most one slot per cycle and remains nonfatal to observation cadence.
- Foreground results and logs contain only `cN`, fixed outcomes, and allowlisted problem codes.
- Operator credential repair remains in claude-swap; Keeper provides bounded retry and verification rather than credential ownership.
- Worker shutdown waits for provider-child cleanup instead of exiting while a subprocess may survive.

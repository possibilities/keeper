# 65. Shared capacity refresh and foreground Codex reset

## Status

Accepted.

## Context

Keeper's account-routing observer and operator quota tools read the same external capacity sources. Independent polling loops can duplicate provider requests, disagree about freshness, and race publication. A Codex reset is also an irreversible interactive action: the CLI presents two option-numbered menus, and a changed or ambiguous layout must never be guessed through.

The reset controller is intentionally operator-started. It should wait in the foreground until the weekly Codex window nears exhaustion, submit at most one Full reset, report the outcome, and exit. It must not require a dedicated LaunchAgent.

## Decision

The account-routing observation is the shared, transient capacity snapshot. Its schema includes PII-free Codex quota windows and the available reset-credit count alongside Claude routing capacity. Codex capacity is never a Claude account route and never enters route scoring.

Every producer uses one per-refresh advisory lock. A caller first reads the observation without locking, compares its timestamp with that caller's requested maximum age, then double-checks after acquiring the lock. Only a still-stale caller invokes Claude CodexBar, Codex CodexBar, and `cswap` concurrently and atomically replaces the observation. Lock contention is a bounded wait for the active publisher. A refresh by any caller advances the shared timestamp, so another caller skips its own provider work while that data satisfies its cadence.

The daemon observer uses the same refresh operation as foreground callers and holds no lifetime observer lock. Its periodic wake remains supervisor-owned and DB-free; ordinary refresh contention does not end the worker.

`keeper usage reset-codex-before-exceeding` is a foreground, long-running command. It checks shared data every 30 seconds by default and emits progress notifications at five-percentage-point boundaries by default. Both values are operator-configurable. It triggers at 99% weekly utilization, uses recent transitions only to choose a conservative final shot time, and strictly revalidates the same weekly window, threshold, freshness, and single available reset immediately before submission.

The Codex interaction is an exact state machine over captured tmux text:

1. `/usage` must render one recognized menu with option 1 selected and option 2 named `Redeem usage limit reset`; only the observed availability suffixes are accepted.
2. Selecting option 2 must render one reset menu with `Cancel` selected and exactly one option 2 named `Full reset` with a nonempty expiry.
3. The state machine selects `Full reset`, atomically writes a user-private submission latch, then sends the final Enter once.

Unknown labels, numbering, selection markers, duplicate matches, extra choices, missing expiry, or any other format ambiguity fail closed before the latch and final Enter. Once the latch is written, a transport or confirmation ambiguity remains submission-blocking and is never retried automatically. A later command may submit only for a strictly later weekly reset window.

The command invokes `notifyctl` with exact argv for progress and one final outcome, while foreground output remains authoritative if notification delivery fails. SIGINT or SIGTERM before the latch cancels without submission; after the latch, interruption cannot create permission for a second attempt.

## Consequences

- Daemon routing and foreground quota controls share provider work without a daemon RPC or SQLite dependency.
- Faster foreground polling can refresh data for the slower worker, and worker refreshes can satisfy foreground reads.
- Observation publication remains PII-free, bounded, atomic, and transient.
- Reset safety prefers a missed or manually inspected opportunity over an inferred menu choice or duplicate credit redemption.
- Running the reset controller is an explicit operator action; no permanent reset watcher is installed.

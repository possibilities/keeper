# 81. Durable boot identity and stable restart verdict

## Status

Accepted. Refines ADR 0030's restart-ledger persistence and ADR 0073's restart-verdict smoke while preserving their single-instance and test-isolation decisions.

## Context

The restart ledger is described as append-only forensic history, but normal boot rewrites it after aging records to a crash-loop window and a failed read can therefore be followed by a rewrite containing only the current boot. Boot persistence is also late and best-effort: boot Drain statistics and healthy service can advance after the row write fails. The restart CLI accepts any later readable row when its pre-read found none and combines boolean health samples without proving they came from one daemon boot.

A short-lived daemon was observed near launchd's throttle interval, but the surviving timing does not identify its signal or exit cause. Timing proximity is not authority for a lifecycle repair.

## Decision

One **Daemon boot identity** binds process, ledger, Drain, and served health:
`boot_id`, pid, and recycle-safe process start time.

- After the single-instance lock succeeds and before DB open, migration, workers, Drain statistics, or socket readiness, keeperd appends and syncs one bounded boot line. A failed append is boot-fatal and stderr is the authority when the ledger itself cannot record the failure.
- Boot and enrichment records are true append-only NDJSON. Crash-loop windowing and caps are read-side projection inputs; normal boot never rewrites or ages forensic history. Legacy conversion may use one explicit atomic migration that preserves every valid record. Malformed or unreadable input never becomes an empty authoritative history that is then persisted.
- `fatalExit(reason)` appends bounded reason evidence when in-process evidence exists. External SIGKILL or unavailable platform evidence remains explicitly unattributed; the producer never guesses a cause.
- Every served result, including memoized steady-state replies, exposes the current boot identity and Drain state. A health observation is structured, not boolean, so callers can reject mixed process or boot evidence.

`keeper daemon restart` proves a stable replacement rather than command acceptance:

1. Snapshot the old served identity and latest valid ledger marker.
2. Issue one bounded `launchctl kickstart`; its PID output is diagnostic, not sole authority, and the CLI never retries the irreversible command.
3. Require the old recycle-safe identity to be gone, one different served identity, that identity's durable boot row, completed Drain, and consecutive healthy observations all naming that same identity.
4. Keep the same identity healthy for at least twelve seconds after the first caught-up observation, crossing the LaunchAgent's ten-second throttle interval. A replacement during this window resets evidence rather than letting samples from multiple boots combine.
5. Return success with the proven boot identity. Command failure may remain a warning only when the complete stronger proof succeeds; missing, mismatched, unstable, or inconclusive evidence fails with bounded diagnostics.

Monotonic time owns deadlines and stabilization; wall time remains ledger chronology. A controlled sandbox restart and a no-replacement control characterize the verdict before and after integration. Post-deploy host verification is operator evidence, never task acceptance.

## Consequences

- A daemon cannot advertise health or mutate boot Drain statistics without a durable identity row.
- Forensic history no longer disappears as a side effect of crash-loop retention. Already-lost records are not reconstructable and remain a documented evidence gap.
- Restart success cannot be assembled from an old row, a stale process, or probes spanning a rapid crash loop.
- Every successful restart takes a bounded stabilization interval; honest latency is preferred to a fast false positive.
- The historical short death remains unattributed unless primary exit evidence demonstrates a cause. Tests simulate that class without asserting speculation as history.

# 101. claude-swap-owned measurement trust

## Status

Accepted. Narrows the freshness authority inherited through ADR 0100 while preserving mandatory managed Account routes, fresh Capacity observations, scoped Account focus precedence, and fail-closed launch behavior.

## Context

Keeper observes managed Claude accounts through the versioned `cswap list --json` contract. claude-swap owns account credentials, polling cadence, failure backoff, last-good retention, and the bounded decision that maps each account to `usageStatus`. Keeper separately freshness-bounds the completed observation so an abandoned response cannot authorize future launches.

Applying another maximum age to each underlying usage measurement creates a second telemetry policy. A current claude-swap response can attest `usageStatus: ok` while deliberately serving an older last-good measurement during polling or provider backoff, yet Keeper can reject the same account as stale. Advancing an emitted utilization to zero when its reset timestamp passes similarly makes Keeper more optimistic than the credential-owning producer.

## Decision

A Capacity observation's freshness is the age of Keeper's completed, validated claude-swap response. A fresh response is the current eligibility attestation; underlying Measurement age is provenance for diagnostics.

Keeper admits an Account route only when its row has a positive stable slot, `usageStatus: ok`, valid measurement provenance, structurally valid quota windows, and the required session and weekly meters. Fable work additionally requires a valid Fable meter. Known non-`ok` statuses, malformed or unsupported responses, missing required fields, stale Capacity observations, and exhausted raw quota values remain fail-closed.

Keeper does not apply an independent maximum age to an admitted measurement and does not reinterpret an emitted utilization after its reset timestamp. Reset timestamps remain available for Usage view countdowns and Account focus lifetime checks. When both claude-swap freshness fields are valid, `usageFetchedAt` is canonical; clock skew affects diagnostics rather than eligibility. Separately marked last-good fields may supply aged Usage view meters for a non-`ok` row, but never an Account route.

The transient Capacity observation schema changes with this semantic boundary so an observation produced under a different admission policy is incompatible rather than ambiguously reusable.

## Alternatives considered

- **Keep Keeper's measurement-age ceiling.** Rejected because two freshness owners disagree during claude-swap's deliberate last-good and backoff states.
- **Force claude-swap to poll within Keeper's ceiling.** Rejected because the credential-owning producer controls provider budgets, cadence, and backoff.
- **Infer eligibility from visible TUI bars.** Rejected because the Usage view may render last-good data beyond the machine contract's decision trust; Keeper consumes `usageStatus` from the versioned JSON response.
- **Advance elapsed reset windows locally.** Rejected because this can make a route appear usable before claude-swap has observed the new quota state.

## Consequences

- A route may remain eligible with an aged measurement while a fresh claude-swap response explicitly attests that the measurement is decision-trusted.
- A fresh non-`ok` response revokes the route immediately, and an unrefreshed Capacity observation still expires at Keeper's observation ceiling.
- Routing, explicit Account selection, Account focus, and the Usage view share one producer-owned eligibility decision.
- Measurement age remains visible without silently changing launch eligibility.
- An exhausted meter remains exhausted until claude-swap reports a changed utilization.

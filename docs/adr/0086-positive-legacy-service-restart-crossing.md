# 86. Positive legacy service restart crossing

## Status

Accepted. Refines ADR 0081's restart-verdict algorithm only for a predecessor that positively serves the result protocol without a Daemon boot identity; the ordinary exact-identity replacement contract remains unchanged.

## Context

A daemon may serve a valid result while omitting the boot identity tuple because that capability is not present in the running binary. The first restart into an identity-capable binary can therefore produce a healthy, ledger-backed successor while the exact predecessor comparison required by ADR 0081 is structurally impossible. Waiting longer cannot create the missing predecessor identity, so the command consumes its full deadline and reports an unproven restart after the replacement is already stable.

Generic identity absence cannot authorize a weaker proof. A timeout, refused connection, malformed frame, partial identity, unreadable ledger, or ambiguous pre-restart state may indicate an outage or interference rather than an older protocol capability.

## Decision

The pre-restart socket observation is frozen before the one irreversible kickstart as a closed evidence class:

- **Exact identity** — a valid result carries the complete `boot_id`, pid, recycle-safe start time, and boolean Drain state. The ADR 0081 algorithm applies byte-for-byte.
- **Positive identity-capability crossing** — a syntactically valid result is positively served with either no boot header or a boot header carrying boolean Drain state while all three identity fields are absent. A readable pre-restart ledger snapshot is also required.
- **Unavailable or ambiguous** — transport failure, timeout, EOF, non-result or malformed framing, unreadable pre-ledger state, and any partially populated or contradictory identity tuple. This class never selects compatibility proof.

For a positive identity-capability crossing, success requires all of the following after the kickstart:

1. One complete successor Daemon boot identity is served and was absent from the frozen set of valid identities in the readable pre-restart ledger.
2. That exact identity has a durable boot row, completes Drain, and remains continuously healthy under the same twelve-second stabilization rule as the ordinary path.
3. Identity changes, unavailable probes, ledger mismatch, or incomplete Drain reset or withhold proof exactly as they do for an exact replacement.

The crossing waives only the impossible comparison against an unserved predecessor identity. It does not waive durable successor identity, ledger backing, Drain, health, stabilization, the single-kickstart rule, or the monotonic deadline. Complete proof may override a failed or timed-out kickstart exactly as the ordinary stronger proof does, retaining bounded command diagnostics as a warning.

Successful output identifies the proof path additively as `exact-replacement` or `identity-capability-crossing`. Failure keeps the existing stable top-level problem codes; bounded evidence reasons distinguish unavailable pre-state, ambiguous partial identity, and a valid crossing whose successor proof remained incomplete.

Deterministic in-process fixtures cover the compatibility matrix. The closed real-daemon scenario set remains unchanged.

## Consequences

- The first restart into identity-capable code can succeed as soon as the same durable successor proof is stable, instead of waiting for evidence the predecessor cannot supply.
- An outage or malformed response cannot masquerade as protocol compatibility; only positive served evidence selects the crossing.
- Current daemons continue to require exact predecessor disappearance and a distinct exact successor identity.
- Operators can tell which proof contract succeeded without parsing diagnostics or timing.

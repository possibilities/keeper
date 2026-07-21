# 103. Agent runtime diagnostics and threshold awaits

## Status

Accepted. Extends ADR 0054, ADR 0072, ADR 0090, ADR 0097, ADR 0100, and ADR 0101.

## Context

Keeper receives Harness runtime measurements for its statusline, reads sanitized Capacity observations for `keeper usage`, and derives reservation-free routing inspections. Those surfaces have different truth boundaries: jobs telemetry is coalesced, the Usage view may show last-good meters that cannot authorize routing, Claude Launch attribution is process-scoped, and a Pi Codex session route is quota-scope-specific and may change before Substantive output.

Agents need stable machine reads and level-triggered actions such as reacting when context usage is high or weekly quota is low. Parsing viewer artifacts, treating display labels as route identity, or resolving "current account" on every poll would make those actions stale or nondeterministic. Durable actions also need the caller's real follow-up through the existing exact document seam.

## Decision

### Independent machine contracts

Keeper exposes three read-only, independently versioned standard JSON envelopes. Unknown additive fields and enum values remain compatible; stdout stays machine-only.

- `keeper session runtime [<session-reference>]` is always JSON and uses ambient Session resolution when omitted. It returns explicit subject scope and available identities; model; effort axis and level; context percentage, token count, and window size; proven Claude Launch attribution or scoped Codex session route; observation and response times; source; and freshness. Missing measurements are unavailable, never zero; missing or ambiguous Session references are operational errors.
- `keeper usage --json` implies a one-shot snapshot and rejects `--watch`. It returns the Usage view's normalized source, account, meter, category, multiplier, Measurement-age, and last-good distinctions. Missing, stale, exhausted, or unavailable providers are successful partial snapshots with per-source status.
- `keeper accounts inspect --json` returns separate Claude launch, Codex launch-seed, and Pi runtime Routing diagnostics. Allowlisted output includes stable routes or opaque aliases, quota scopes, observation and Measurement times, focus or activation state, eligibility and bounded reasons, reservations, cooldowns, pressure, score components, proven actual routes, and reservation-free `would_route` outcomes. It never refreshes credentials, reserves, or creates pressure.

`keeper agent accounts check --json` remains compatible through the same inspection seams. A combined global status envelope is not added because Session telemetry, Usage, and routing retain independent provenance.

### Exact runtime observations

The statusline path atomically publishes an exact latest observation on every Harness sample. Event and jobs-Projection publication may remain coalesced. Runtime reads prefer the exact leaf and label Projection fallback as coalesced; `jobs.updated_at` is never telemetry observation time.

A producer reports only identity and scope it proves. Parent- or job-scoped data is never presented as nested-agent-local. The Pi Codex companion publishes bounded, private, PII-free scoped-route changes for selection, retry, fallback, and retirement; it exposes only opaque alias and quota scope. The launch-time initial alias remains a hint, never the actual route.

### Threshold conditions

Thresholds compare finite raw percentages in inclusive range `0..100`. `context-used-at-least 80` means `>= 80`; `weekly-quota-at-most 10` means remaining weekly capacity `<= 10`. Display rounding is never input.

`context-used-at-least <percent>` is foreground-only. It binds the ambient runtime subject, re-evaluates exact telemetry through the Monitor flow, honors immediate, `--require-transition`, `--probe`, and AND semantics, and fails with target-ended when its Session ends. Durable expressions containing it are rejected before arm.

`weekly-quota-at-most <percent>` supports foreground and durable waits. It accepts `route:current` or an explicit stable Account route / opaque Codex alias, plus Codex scope where applicable. At arm, `route:current` resolves once to provider, route or alias, weekly meter, scope, and resolution time; absent authority refuses arm. Later routing never retargets the wait, and a follow-up launch uses normal independent routing.

Evaluation reuses validated Capacity readers and producer-owned eligibility semantics. Missing, malformed, stale, unavailable, or removed frozen-route evidence remains waiting with bounded detail; it settles only by recovery, timeout, or cancel. Existing owner-fenced cancellation, firing acknowledgement, and stable effect identity remain unchanged.

### Durable follow-ups and wakes

Durable mode accepts mutually exclusive `--follow-up <text>` and `--follow-up-file <path>` through the bounded spill-document seam. Omission keeps generic prose for compatibility; skills supply an explicit document for requested actions. Prompt content never appears in list output, errors, Usage, or Routing diagnostics.

A durable row's `done` means its stable follow-up Session launch was accepted under existing bind proof, not that follow-up work completed. Existing bounded never-bound recovery and launch-failure semantics remain.

The shared await worker performs one coalesced idle re-evaluation at least every 30 seconds alongside DB wakes. This bounds reaction to Capacity sidecars and elapsed deadlines without per-await watchers or provider refreshes.

## Alternatives considered

- **Use jobs as current runtime.** Rejected because values are coalesced, timestamps have broader lifecycle meaning, and identity may be parent-scoped.
- **Put everything in `keeper status --json`.** Rejected because each surface has different freshness and partial-failure semantics.
- **Resolve current route on every poll.** Rejected because routing changes would mutate durable intent.
- **Make context durable.** Rejected because a fresh follow-up has a different context window.
- **Persist Capacity or add an RPC.** Rejected because sidecars remain authoritative and generic await JSON/document storage already carries the intent.

## Consequences

Agents inspect runtime, Usage, and routing without parsing TUI or temporary artifacts. Exact and coalesced telemetry coexist with explicit provenance. Pi route reporting follows retries without widening the credential boundary. Quota waits survive restarts and react to sidecar-only changes within a bounded interval; context waits remain attached to their measured Session. Existing durable rows, RPCs, Projections, and independent routing remain compatible, with no migration or new RPC.

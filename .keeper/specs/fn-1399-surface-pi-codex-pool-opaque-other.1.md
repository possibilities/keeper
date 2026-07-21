## Description

In integrations/pi-codex-pool/src/pool.ts (with tests beside the
existing test/provider-pool.test.ts and test/seams.test.ts):

- Private failure record (visibility): on every terminal classified
  pool failure, write ONE bounded private JSON record carrying the
  REAL upstream error text (currently captured as `lastErrorMessage`
  and then discarded by `sanitizedErrorEvent`), keyed by
  session/attempt, alias/route, and failure class, to a private file
  under the pool's existing state directory (see src/state.ts for the
  resolution seam). The file must be size- or count-bounded (cap and
  truncate/rotate; never unbounded growth). Attacker-influenced
  payload rules apply: one bounded JSON line per record, length-capped
  message text, no shell/NDJSON injection. The sanitized event stream
  visible to the harness keeps carrying ONLY the code
  (`pool-other-failure` etc.) exactly as today.
- Failover eligibility (the dead-request fix): an `other`-classified
  failure that occurs BEFORE any substantive output (the existing
  `substantive()` seam, pool.ts:193-204) becomes failover-eligible
  exactly once - ride the existing `delegatedAttempts < 2` bound and
  route-exclusion machinery rather than inventing a new counter. An
  `other` failure AFTER substantive output keeps today's non-retryable
  behavior (a mid-stream resend could duplicate side effects).
- Auth regex widening (the known miss): extend the auth class regex
  (pool.ts:157-163) with login/credential-expiry phrasings the current
  pattern misses (e.g. "not logged in", "login expired",
  "session expired", "please run .* login", "credentials? (are )?
  (invalid|expired|missing)") - anchor each added alternative to a
  real codex CLI phrasing where a specimen is recoverable (the new
  private failure log is the forward corpus; keep additions
  conservative, no catch-alls that would swallow genuine other-class
  text).

This surface is NOT daemon-resident (integrations/ is outside every
daemon-load-root), so no daemon restart is owed on landing.

## Acceptance

- [ ] A pre-substantive `other` failure attempts exactly one failover
      to an eligible alternate route; a post-substantive `other`
      failure does not retry (tests through the existing pool seams).
- [ ] Every terminal pool failure writes one bounded private record
      carrying the real upstream message; the sanitized event stream
      still carries only the sanitized code.
- [ ] The private failure log is bounded (cap enforced by test) and
      each record's message text is length-capped.
- [ ] A login/credential-expiry phrasing outside today's auth regex
      classifies as `auth` (regression test), and all existing
      classifier tests stay green.

## Done summary
Widened the auth classifier regex for login/session-expiry and credential invalid/expired/missing phrasings, made pre-substantive other-classified pool failures failover once via the existing attempt/exclusion machinery, and added a bounded private NDJSON failure log capturing the real upstream message while the sanitized event stream keeps carrying only the code.
## Evidence

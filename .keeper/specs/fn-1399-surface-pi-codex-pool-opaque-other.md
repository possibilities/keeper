## Overview

The pi-codex-pool failure classifier buckets any upstream error text that
matches none of the quota/rate/context/auth/transport regexes into `other`
(integrations/pi-codex-pool/src/pool.ts:143-172). Two compounding problems:
`retryable()` (pool.ts:174-176) excludes `other`, so no failover to the
second enrolled alias is ever attempted; and `sanitizedErrorEvent`
(pool.ts:242-261) replaces the real upstream message with the bare
`pool-other-failure` code, so the operator gets zero diagnostics. A
credential-expiry error phrased outside the auth regexes therefore kills
requests dead with no failover and no visible cause (live specimens on
07-20; operator-flagged as "plagued by pool-other-failure").

Fix: preserve the real error text in one bounded private record per
failure, give pre-substantive-output `other` failures exactly one
failover attempt, and widen the auth regex to the known-missed
login/credential-expiry shapes.

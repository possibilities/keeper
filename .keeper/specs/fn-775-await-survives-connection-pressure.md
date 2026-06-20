## Overview

An armed `keeper await` dies terminal `reason=connect` when keeperd rejects
it with `max_connections` — the cap reject arrives as an error frame before
first paint, so the client's terminal gate classifies a transient capacity
condition as an unrecoverable query error. Reclassify cap rejects as
retryable through the existing capped-backoff reconnect loop (preserving the
reconnect-forever contract), fix the backoff-reset semantics so retry actually
backs off, keep re-query one-shots from committing false `deleted` verdicts,
and correct the epic-complete status literals in the skill doc and JSDoc
(planctl epics terminalize as `done`; there is no `closed`).

Server-side hygiene (fn-767's idle sweep, MAX_CONNECTIONS, TTL) is
deliberately untouched: whether cap rejections persist after this client fix
is an empirical question answered by the post-rollout measurement pass, not
by speculative const tuning.

## Quick commands

- `bun test test/readiness-client.test.ts test/await.test.ts` — client + CLI suites green
- `grep -n "TRANSIENT_SERVER_CODES\|max_connections" src/readiness-client.ts` — allowlist landed in the client, not the CLI
- `grep -n '"done"' skills/await/SKILL.md src/await-conditions.ts` — status literals corrected

## Acceptance

- [ ] A `max_connections` error frame on the main readiness subscription routes to teardown + capped-backoff reconnect — never `onFatal`, never `reason=connect`
- [ ] Backoff `attempt` resets only on first `result` (served), not on socket `open` (accepted) — an accept-then-cap-reject cycle grows the backoff
- [ ] Cap-rejects use a longer-base jittered backoff regime distinct from socket-level connect rejections
- [ ] A cap-reject during a scope-exempt re-query one-shot never commits `deleted`; after bounded retry it defers to the next steady-poll snapshot
- [ ] `--connect-timeout` still bounds a never-painted await wedged at the cap (give-up anchor keyed off first result is preserved)
- [ ] skills/await/SKILL.md pre-check reads `epic.status == "done"`; the reason=connect row describes only genuine query-shape errors; await-conditions.ts JSDoc states the `status=='done'` re-query predicate
- [ ] No server-side consts or reject-shape changes

## Early proof point

Task that proves the approach: ordinal 1. If gating the attempt-reset on
first result regresses the legitimate fast-reconnect path (daemon bounce
mid-board), recovery: keep the open-reset for post-paint reconnects and gate
only the pre-paint phase.

## References

- Root cause: src/readiness-client.ts isTerminal (`sts.every(s => !s.gotResult)`) treats ANY pre-paint error frame as unrecoverable; the cap reject (server-worker.ts:2604-2631, errorFrame then socket.end()) always arrives pre-paint
- The fn-757 contract: a plain await reconnects forever; `reason=unreachable` exists only under opt-in `--connect-timeout`; cap rejects must ride the plain path, never invent a third regime
- fn-767 shipped the server hygiene (zero-sub idle sweep, every-tick reap) citing the 2026-06-09 incident (83 rejections) — its efficacy under the post-fix fleet is measured later, not tuned here
- Capacity-retry practice: an application-level "server full" envelope is capacity-transient, not terminal; longer base + full jitter for cap retries because reconnections worsen the exact contended resource and fleets retry in lockstep

## Best practices

- **Reset backoff on served, not accepted:** accept-then-reject servers defeat open-keyed resets — the counter must key off proof of service (first result)
- **Named allowlist over inline checks:** `TRANSIENT_SERVER_CODES` as an exported const documents the retryable contract and keeps the malformed-query terminal path narrow
- **Indeterminate beats wrong:** a verifier that cannot confirm deletion defers; it never converts "couldn't check" into a terminal verdict

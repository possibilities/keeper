## Description

**Size:** M
**Files:** src/readiness-client.ts, cli/await.ts, test/readiness-client.test.ts, test/await.test.ts

### Approach

All classification work lands in src/readiness-client.ts (subscribeMulti
owns the reconnect loop); cli/await.ts only renders already-classified
outcomes and should need at most the re-query contract touch.

1. **Allowlist.** Export `TRANSIENT_SERVER_CODES = new Set(["max_connections"])`
   beside the terminal gate. In the error-frame handler (:1119-1154), when
   `frame.code` is in the set, do NOT consult `isTerminal` and do NOT call
   `onFatal` — tear down and let the close-driven `connectWithRetry` re-enter
   (the server already `socket.end()`s after the frame; ensure no
   double-teardown when both the frame branch and the close handler run).
   Narrow the :16-19 header premise to match: a pre-paint error frame is
   terminal only when its code is not transient.
2. **Backoff-reset semantics.** Move the `attempt = 0` reset from the
   socket `open` handler (:1214) to first `result` (where the give-up
   anchor already clears, :1066). An accept-then-cap-reject cycle must grow
   `attempt`. Verify the legitimate daemon-bounce fast-reconnect still
   behaves (post-paint reconnect: first result after reconnect resets it);
   if pre/post-paint need different handling, gate only pre-paint.
3. **Cap-reject backoff regime.** When the teardown reason is a transient
   server code, use a longer base with full jitter (e.g. base 2500ms,
   `delay = random(0, min(MAX_BACKOFF_MS, base * 2^attempt))`); socket-level
   connect rejections keep the existing 250ms→5s ladder. Keep both under
   the existing MAX_BACKOFF_MS cap.
4. **Re-query one-shot contract.** The scope-exempt re-queries
   (cli/await.ts:1051, :1105) currently `onFatal: () => finish(false)` — a
   cap-reject would commit a false `deleted`. Give the one-shot a bounded
   retry (small attempt count under the transient regime); if still
   cap-rejected, resolve INDETERMINATE: do not commit deleted, stay armed,
   and let the next steady-poll absent-transition re-trigger the re-query.
   Confirm `--connect-timeout`'s unpainted give-up anchor (keyed off first
   result) still bounds a never-painted await wedged at the cap.
5. **Tests.** Mirror readiness-client.test.ts:602 (connect rejections are
   not terminal) for a pre-paint `max_connections` error frame: asserts
   reconnect, no onFatal. Add: backoff grows across accept-then-reject
   cycles (no 250ms pin); jittered delays stay under cap; re-query
   cap-reject does not produce exit 4 / `deleted`; a genuine malformed-query
   error frame still terminates `reason=connect` (the :506-589 cases stay
   green); fn-757 reconnect-forever cases at await.test.ts:499 unaffected.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:16-19,67-73,175-176,1066,1119-1154,1214,1254-1276,1495,1863 — header premise, backoff consts, give-up anchor, error handler, attempt reset, close→reconnect, both isTerminal sites
- cli/await.ts:1051,1105,1505-1519 — re-query one-shots and the onFatal reason mapping
- test/readiness-client.test.ts:201,506-589,602,746,937 — errorFrame helper and the assertion shapes to mirror

**Optional** (reference as needed):
- src/server-worker.ts:2604-2631 — the reject shape the client receives (error frame then end; read-only context, no server change)
- test/await.test.ts:499 — fn-757 line-shape assertions

### Risks

- Both isTerminal sites (:1495 subscribeCollection, :1863 subscribeReadiness) consume the change — verify each caller's onFatal path.
- Moving the attempt reset is concurrency-sensitive: a partial paint (some collections resulted, others not) must not double-reset or starve the backoff.
- No `[keeper-await]` output-line additions — await.test.ts pins exact line shapes; cap retries stay silent.

### Test notes

`bun test test/readiness-client.test.ts test/await.test.ts`; full suite via
the project's standard gate before commit.

## Acceptance

- [ ] Pre-paint max_connections frame → reconnect with growing jittered backoff; no onFatal, no reason=connect
- [ ] attempt resets only on first result; accept-then-reject cycles back off
- [ ] Re-query cap-reject never commits deleted; bounded retry then defer
- [ ] Malformed-query frames still terminal; fn-757 and --connect-timeout contracts intact
- [ ] All listed test cases added and green; no server-side changes

## Done summary

## Evidence

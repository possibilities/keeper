/**
 * Shared `retryUntil` poll helper for the daemon/integration tier. Polls
 * `predicate` until it returns a truthy value or the deadline elapses; returns
 * the truthy value, or `null` on timeout. Used instead of fixed sleeps so a
 * fast machine doesn't waste time and a slow one doesn't flake.
 *
 * The default timeout is deliberately generous (10s): an idle machine returns on
 * the first or second poll, so the ceiling is never paid in the common case, but
 * a `test:full` run thrashing every core (dozens of daemons + workers + sockets)
 * can starve the fold→serve→subscribe→deliver chain well past a 2s deadline. The
 * deadline only bites on a genuinely wedged predicate; widening it trades a slow
 * failure for far fewer load-induced flakes while staying poll-based (never a
 * fixed sleep). Pass a tighter `timeoutMs` at a callsite that asserts a NEGATIVE
 * (a thing must NOT appear), where a long wait is pure dead time.
 */
export async function retryUntil<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 10000,
  cadenceMs = 50,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await Bun.sleep(cadenceMs);
  }
}

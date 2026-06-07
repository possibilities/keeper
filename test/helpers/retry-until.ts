/**
 * Shared `retryUntil` poll helper for the daemon/integration tier. Polls
 * `predicate` until it returns a truthy value or the deadline elapses; returns
 * the truthy value, or `null` on timeout. Used instead of fixed sleeps so a
 * fast machine doesn't waste time and a slow one doesn't flake.
 */
export async function retryUntil<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 2000,
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

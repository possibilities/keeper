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
export async function drainMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

interface ScheduledTask {
  id: number;
  due: number;
  callback: () => void;
}

export class ManualScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  readonly setTimer = (callback: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { id, due: this.now + Math.max(0, ms), callback });
    return id;
  };

  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.tasks.delete(handle);
    }
  };

  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let handle = 0;
      const finish = (): void => {
        this.clearTimer(handle);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      handle = this.setTimer(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
    });

  pendingCount(): number {
    return this.tasks.size;
  }

  nextDelay(): number | null {
    const next = this.nextTask();
    return next === null ? null : next.due - this.now;
  }

  async advanceBy(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const next = this.nextTask();
      if (next === null || next.due > target) {
        break;
      }
      this.now = next.due;
      this.tasks.delete(next.id);
      next.callback();
      await drainMicrotasks();
    }
    this.now = target;
    await drainMicrotasks();
  }

  async runNext(): Promise<void> {
    const delay = this.nextDelay();
    if (delay === null) {
      throw new Error("manual scheduler has no pending task");
    }
    await this.advanceBy(delay);
  }

  private nextTask(): ScheduledTask | null {
    let next: ScheduledTask | null = null;
    for (const task of this.tasks.values()) {
      if (
        next === null ||
        task.due < next.due ||
        (task.due === next.due && task.id < next.id)
      ) {
        next = task;
      }
    }
    return next;
  }
}

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

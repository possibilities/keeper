/**
 * Drop-recovery primitives shared by the two producer workers
 * (`transcript-worker`, `plan-worker`).
 *
 * macOS FSEvents delivers a *dropped-events* signal through `@parcel/watcher`'s
 * subscribe-callback `err` argument when the kernel/client buffer overruns under
 * congestion. The lost change is then gone for good — there may be no future
 * event for the missed file, so the live tail (transcript) / live snapshot
 * (plan) silently misses it; only a daemon restart's boot scan recovers it.
 *
 * This module supplies the two pieces both workers need to close that hole on
 * the LIVE path WITHOUT a restart and WITHOUT a self-heal/re-subscribe:
 *
 * - {@link isDropError} — the (null-safe) discriminator. FSEvents emits THREE
 *   drop messages (UserDropped / KernelDropped / too-many), all carrying the
 *   substring `must be re-scanned`. We match that substring, not the literal
 *   UserDropped string, so all three recover. A non-matching `err` returns
 *   false → the caller keeps today's swallow-and-log.
 * - {@link RescanScheduler} — a trailing-edge debounce + single-flight guard.
 *   Drops arrive in BURSTS; an un-debounced re-scan-per-drop is O(tree) and
 *   itself causes more drops (a feedback loop). The scheduler collapses a burst
 *   into ONE scan after it subsides, and if a drop lands mid-scan it sets a
 *   dirty bit and re-runs exactly once. The scan callback supplied by the worker
 *   reuses that worker's existing change-gated boot-scan primitive, so a re-scan
 *   over unchanged files emits nothing.
 *
 * Neither piece is a self-heal: the subscription stays alive (only `notifyError`
 * tears it down, which a drop is NOT), the worker never re-subscribes, and a
 * throw inside the scan is swallowed to stderr — it never reaches `fatalExit`.
 */

/**
 * The substring every FSEvents drop message carries (verified against
 * @parcel/watcher 2.5.6 `src/macos/FSEventsBackend.cc`: the UserDropped,
 * KernelDropped, and too-many variants all end "...must be re-scanned.").
 */
export const DROP_MESSAGE_SUBSTRING = "must be re-scanned";

/**
 * True iff `err` is a recoverable FSEvents dropped-events signal — i.e. its
 * message contains {@link DROP_MESSAGE_SUBSTRING}. Null-safe: a null/undefined
 * err, or one with a non-string message, returns false (the caller then keeps
 * the swallow-and-log path). Pure.
 */
export function isDropError(err: unknown): boolean {
  if (err === null || err === undefined) {
    return false;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" &&
          typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : typeof err === "string"
          ? err
          : null;
  if (message === null) {
    return false;
  }
  return message.includes(DROP_MESSAGE_SUBSTRING);
}

/** A cancelable timer handle — `setTimeout`'s return, narrowed for injection. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** Injectable timer surface so a fake clock can drive the scheduler in tests. */
export interface SchedulerTimers {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

const realTimers: SchedulerTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Default trailing-edge debounce window — long enough to let a drop burst subside. */
export const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Trailing-edge debounce + single-flight re-scan scheduler, with an OPTIONAL
 * max-wait / latency ceiling.
 *
 * - `schedule()` (called once per matched drop) (re)arms a trailing-edge timer:
 *   a burst of N drops collapses into ONE timer fire after the window subsides.
 * - When the timer fires it runs the supplied `scan` callback under a
 *   single-flight `inFlight` guard. If a drop arrives WHILE a scan is running,
 *   `schedule()` sets a `pending` dirty bit; on completion the scheduler re-runs
 *   the scan exactly once to cover the change that landed mid-scan.
 * - **Max-wait ceiling (optional).** A pure trailing-edge debounce re-arms
 *   forever under continuous load that fires faster than the window — it never
 *   flushes, so staleness is unbounded. When `maxWaitMs` is set (> 0), the FIRST
 *   `schedule()` after an idle period also arms a one-shot ceiling timer; if the
 *   debounce keeps slipping, the ceiling fires a flush within `maxWaitMs` of the
 *   burst's start. Either flush path (trailing OR ceiling) clears the ceiling so
 *   the next idle→busy edge re-arms it. With `maxWaitMs` UNSET (the default, 0 /
 *   "no ceiling") the scheduler is byte-identical to the old trailing-only
 *   behavior — the existing transcript-worker / plan-worker callers do not pass
 *   a ceiling and therefore do not change.
 * - The `scan` callback is responsible for its own error handling — but as a
 *   belt-and-suspenders, the scheduler also wraps the invocation so a throw is
 *   reported via `onError` (stderr) and never propagates. A re-scan must never
 *   reach `fatalExit`.
 * - `cancel()` clears any armed timer — BOTH the debounce and the ceiling —
 *   (called from the worker's shutdown handler BEFORE `unsubscribe()`); the scan
 *   callback itself re-checks the worker's `shuttingDown` flag before touching a
 *   closing DB.
 *
 * The scan callback is synchronous (both workers' boot-scan primitives are
 * synchronous file reads); single-flight is therefore mostly relevant for the
 * mid-scan dirty-bit re-run, but the guard is kept explicit for clarity and to
 * stay correct if a future scan yields.
 */
export class RescanScheduler {
  private timer: TimerHandle | null = null;
  private ceilingTimer: TimerHandle | null = null;
  private inFlight = false;
  private pending = false;

  constructor(
    private readonly scan: () => void,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
    private readonly onError: (msg: string) => void = (m) => console.error(m),
    private readonly timers: SchedulerTimers = realTimers,
    /**
     * Optional latency ceiling. `0` (the default) means "no ceiling" — pure
     * trailing-edge debounce, byte-identical to the historical behavior.
     */
    private readonly maxWaitMs: number = 0,
  ) {}

  /** Arm (or re-arm) the trailing-edge timer; coalesces a burst into one fire. */
  schedule(): void {
    if (this.inFlight) {
      // A scan is running; remember to re-run once it finishes (covers a change
      // that landed mid-scan) instead of arming a concurrent timer.
      this.pending = true;
      return;
    }
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.debounceMs);
    // First schedule() of an idle→busy burst arms the ceiling (if configured);
    // subsequent schedule()s within the burst leave it running so it fires
    // maxWaitMs after the burst STARTED, not after each re-arm.
    if (this.maxWaitMs > 0 && this.ceilingTimer === null) {
      this.ceilingTimer = this.timers.setTimeout(() => {
        this.ceilingTimer = null;
        // Ceiling reached before the debounce settled — flush now. Cancel the
        // still-armed trailing timer so the burst flushes exactly once.
        if (this.timer !== null) {
          this.timers.clearTimeout(this.timer);
          this.timer = null;
        }
        this.run();
      }, this.maxWaitMs);
    }
  }

  /** Cancel any armed timer — debounce AND ceiling — (shutdown). Idempotent. */
  cancel(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearCeiling();
  }

  /** Clear the ceiling timer so the next idle→busy edge re-arms it. Idempotent. */
  private clearCeiling(): void {
    if (this.ceilingTimer !== null) {
      this.timers.clearTimeout(this.ceilingTimer);
      this.ceilingTimer = null;
    }
  }

  /** Run the scan under the single-flight guard, draining the dirty bit. */
  private run(): void {
    // A flush (trailing OR ceiling) ends the current burst — clear the ceiling
    // so the next idle→busy edge re-arms it from a fresh start.
    this.clearCeiling();
    this.inFlight = true;
    try {
      this.scan();
    } catch (err) {
      this.onError(
        `[rescan] re-scan threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
    if (this.pending) {
      this.pending = false;
      // A drop landed mid-scan — re-run exactly once to cover it.
      this.run();
    }
  }
}

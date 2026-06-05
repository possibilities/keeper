/**
 * Drop-recovery primitive tests (src/rescan.ts), driven with NO Worker/watcher:
 *
 * - `isDropError`: matches all THREE FSEvents drop messages (UserDropped /
 *   KernelDropped / too-many), is null-safe, and rejects a non-drop err (so the
 *   caller keeps swallow-and-log). The literal messages are pinned against
 *   @parcel/watcher 2.5.6 so a future wording change trips this test.
 * - `RescanScheduler`: trailing-edge debounce (a burst of N schedule() calls
 *   collapses into ONE scan), single-flight + dirty-bit (a drop mid-scan re-runs
 *   exactly once), cancel() disarms an armed timer, and a throwing scan is
 *   swallowed to onError (never propagates). A fake clock drives the timer.
 */

import { expect, test } from "bun:test";
import {
  DEFAULT_DEBOUNCE_MS,
  isDropError,
  RescanScheduler,
  type SchedulerTimers,
} from "../src/rescan";

// The three literal FSEvents drop messages, verbatim from
// @parcel/watcher 2.5.6 src/macos/FSEventsBackend.cc:84-88.
const DROP_MESSAGES = [
  "Events were dropped by the FSEvents client. File system must be re-scanned.",
  "Events were dropped by the kernel. File system must be re-scanned.",
  "Too many events. File system must be re-scanned.",
];

test("isDropError matches all three FSEvents drop messages", () => {
  for (const m of DROP_MESSAGES) {
    expect(isDropError(new Error(m))).toBe(true);
  }
});

test("isDropError is null-safe and rejects a non-drop err", () => {
  expect(isDropError(null)).toBe(false);
  expect(isDropError(undefined)).toBe(false);
  expect(isDropError(new Error("EPERM: operation not permitted"))).toBe(false);
  expect(isDropError(new Error(""))).toBe(false);
  expect(isDropError({})).toBe(false);
  // A plain-string or {message} carrier still works (defensive).
  expect(isDropError("File system must be re-scanned.")).toBe(true);
  expect(isDropError({ message: "must be re-scanned" })).toBe(true);
});

/**
 * A controllable fake clock. `schedule()`d callbacks fire only on `flush()`
 * (every armed timer, ignoring its delay — the trailing-only tests) or
 * `flushDelay(ms)` (only timers armed for exactly `ms` — lets a ceiling test
 * fire the ceiling timer without the debounce, and vice versa).
 */
function fakeClock(): {
  timers: SchedulerTimers;
  flush: () => void;
  flushDelay: (ms: number) => void;
  pendingCount: () => number;
} {
  let next = 1;
  const cbs = new Map<number, { cb: () => void; ms: number }>();
  const timers: SchedulerTimers = {
    setTimeout: (cb, ms) => {
      const id = next++;
      cbs.set(id, { cb, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      cbs.delete(handle as unknown as number);
    },
  };
  const fireSubset = (ids: number[]) => {
    // Snapshot+delete before firing so a callback's own schedule() (which arms
    // a fresh timer) is NOT re-fired in this same pass.
    const ready: Array<() => void> = [];
    for (const id of ids) {
      const entry = cbs.get(id);
      if (entry) {
        ready.push(entry.cb);
        cbs.delete(id);
      }
    }
    for (const cb of ready) {
      cb();
    }
  };
  return {
    timers,
    flush: () => fireSubset([...cbs.keys()]),
    flushDelay: (ms) =>
      fireSubset(
        [...cbs.entries()].filter(([, e]) => e.ms === ms).map(([id]) => id),
      ),
    pendingCount: () => cbs.size,
  };
}

test("RescanScheduler: a burst of N schedule()s collapses into ONE scan", () => {
  const clock = fakeClock();
  let scans = 0;
  const sched = new RescanScheduler(
    () => {
      scans++;
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
  );

  sched.schedule();
  sched.schedule();
  sched.schedule();
  // Only one timer is armed (re-arms replace, not stack).
  expect(clock.pendingCount()).toBe(1);
  expect(scans).toBe(0);

  clock.flush();
  expect(scans).toBe(1);
});

test("RescanScheduler: cancel() disarms an armed timer (no scan)", () => {
  const clock = fakeClock();
  let scans = 0;
  const sched = new RescanScheduler(
    () => {
      scans++;
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
  );

  sched.schedule();
  expect(clock.pendingCount()).toBe(1);
  sched.cancel();
  expect(clock.pendingCount()).toBe(0);
  clock.flush();
  expect(scans).toBe(0);
});

test("RescanScheduler: a drop mid-scan re-runs the scan exactly once", () => {
  const clock = fakeClock();
  let scans = 0;
  let sched!: RescanScheduler;
  sched = new RescanScheduler(
    () => {
      scans++;
      if (scans === 1) {
        // Simulate a drop arriving WHILE the first scan runs: sets the dirty
        // bit (inFlight is true), so the scheduler re-runs once on completion.
        sched.schedule();
      }
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
  );

  sched.schedule();
  clock.flush();
  // First scan ran, set the dirty bit, then the scheduler re-ran exactly once.
  expect(scans).toBe(2);
  // No extra timer armed by the mid-scan schedule() (it took the dirty-bit path).
  expect(clock.pendingCount()).toBe(0);
});

test("RescanScheduler: a throwing scan is swallowed to onError, never propagates", () => {
  const clock = fakeClock();
  const errs: string[] = [];
  const sched = new RescanScheduler(
    () => {
      throw new Error("boom");
    },
    DEFAULT_DEBOUNCE_MS,
    (m) => errs.push(m),
    clock.timers,
  );

  sched.schedule();
  // flush() must not throw — the scheduler catches.
  expect(() => clock.flush()).not.toThrow();
  expect(errs.some((e) => e.includes("boom"))).toBe(true);
});

const CEILING_MS = 2000;

test("RescanScheduler: ceiling UNSET = unchanged trailing-only behavior (no ceiling timer armed)", () => {
  const clock = fakeClock();
  let scans = 0;
  // No maxWaitMs arg → default 0 → no ceiling.
  const sched = new RescanScheduler(
    () => {
      scans++;
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
  );

  sched.schedule();
  sched.schedule();
  sched.schedule();
  // Exactly ONE timer (the debounce) — no extra ceiling timer.
  expect(clock.pendingCount()).toBe(1);
  expect(scans).toBe(0);
  clock.flush();
  expect(scans).toBe(1);
  // No straggler ceiling timer left armed after the flush.
  expect(clock.pendingCount()).toBe(0);
});

test("RescanScheduler: ceiling set + continuous schedule() faster than debounce flushes at the ceiling", () => {
  const clock = fakeClock();
  let scans = 0;
  const sched = new RescanScheduler(
    () => {
      scans++;
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
    CEILING_MS,
  );

  // First schedule() arms BOTH a debounce timer and a ceiling timer.
  sched.schedule();
  expect(clock.pendingCount()).toBe(2);

  // Simulate continuous churn: every re-arm replaces the debounce but the
  // ceiling keeps its original deadline (so the debounce never settles).
  for (let i = 0; i < 5; i++) {
    sched.schedule();
    // Still exactly two timers: the re-armed debounce + the untouched ceiling.
    expect(clock.pendingCount()).toBe(2);
  }
  expect(scans).toBe(0);

  // The ceiling fires (the debounce never would under continuous churn). It
  // flushes the scan and cancels the still-armed debounce.
  clock.flushDelay(CEILING_MS);
  expect(scans).toBe(1);
  // Both timers gone — ceiling fired, debounce was cancelled by the flush.
  expect(clock.pendingCount()).toBe(0);
});

test("RescanScheduler: ceiling re-arms on the next idle→busy edge", () => {
  const clock = fakeClock();
  let scans = 0;
  const sched = new RescanScheduler(
    () => {
      scans++;
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
    CEILING_MS,
  );

  // First burst: debounce settles (trailing flush) and clears the ceiling.
  sched.schedule();
  expect(clock.pendingCount()).toBe(2);
  clock.flushDelay(DEFAULT_DEBOUNCE_MS);
  expect(scans).toBe(1);
  expect(clock.pendingCount()).toBe(0);

  // Next idle→busy edge re-arms a fresh ceiling alongside the debounce.
  sched.schedule();
  expect(clock.pendingCount()).toBe(2);
  clock.flushDelay(CEILING_MS);
  expect(scans).toBe(2);
  expect(clock.pendingCount()).toBe(0);
});

test("RescanScheduler: single-flight + mid-scan dirty-bit re-run still hold under a ceiling", () => {
  const clock = fakeClock();
  let scans = 0;
  let sched!: RescanScheduler;
  sched = new RescanScheduler(
    () => {
      scans++;
      if (scans === 1) {
        // A drop lands WHILE the first scan runs (inFlight true) → dirty bit,
        // NOT a concurrent timer. Must still re-run exactly once under a ceiling.
        sched.schedule();
      }
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
    CEILING_MS,
  );

  sched.schedule();
  // debounce + ceiling armed.
  expect(clock.pendingCount()).toBe(2);
  clock.flushDelay(DEFAULT_DEBOUNCE_MS);
  // First scan ran, set the dirty bit, scheduler re-ran exactly once.
  expect(scans).toBe(2);
  // No straggler timers: the trailing flush cleared the ceiling, and the
  // mid-scan schedule() took the dirty-bit path (armed nothing).
  expect(clock.pendingCount()).toBe(0);
});

test("RescanScheduler: cancel() clears BOTH the debounce and the ceiling timers", () => {
  const clock = fakeClock();
  let scans = 0;
  const sched = new RescanScheduler(
    () => {
      scans++;
    },
    DEFAULT_DEBOUNCE_MS,
    () => {},
    clock.timers,
    CEILING_MS,
  );

  sched.schedule();
  // Both timers armed.
  expect(clock.pendingCount()).toBe(2);
  sched.cancel();
  // cancel() must clear BOTH (debounce + ceiling), leaving nothing armed.
  expect(clock.pendingCount()).toBe(0);
  clock.flush();
  expect(scans).toBe(0);
});

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

/** A controllable fake clock: schedule()d callbacks fire only on flush(). */
function fakeClock(): {
  timers: SchedulerTimers;
  flush: () => void;
  pendingCount: () => number;
} {
  let next = 1;
  const cbs = new Map<number, () => void>();
  const timers: SchedulerTimers = {
    setTimeout: (cb) => {
      const id = next++;
      cbs.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      cbs.delete(handle as unknown as number);
    },
  };
  return {
    timers,
    flush: () => {
      // Fire every currently-armed callback (drain in insertion order).
      const snapshot = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of snapshot) {
        cb();
      }
    },
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

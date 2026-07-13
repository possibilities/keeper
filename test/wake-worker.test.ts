import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  stepWatchLoop,
  type WatchLoopScheduler,
  watchLoop,
} from "../src/wake-worker";
import { ManualScheduler } from "./helpers/retry-until";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-wake-test-"));
  dbPath = join(tmpDir, "keeper.db");
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function loopScheduler(clock: ManualScheduler): WatchLoopScheduler {
  return {
    now: () => clock.now,
    sleep: (ms) => clock.sleep(ms),
  };
}

function commit(db: ReturnType<typeof openDb>["db"], id: string): void {
  db.query(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, ?, 'Stop', 'lifecycle', '{}')",
  ).run(id);
}

test("stepWatchLoop proves idle deadline boundaries and commit coalescing", () => {
  const initial = { lastVersion: 1, lastWakeAt: 100 };
  expect(stepWatchLoop(initial, 1, 149, 50)).toEqual({
    state: initial,
    wake: false,
  });
  expect(stepWatchLoop(initial, 1, 150, 50)).toEqual({
    state: { lastVersion: 1, lastWakeAt: 150 },
    wake: true,
  });
  expect(stepWatchLoop(initial, 1, 151, 50).wake).toBe(true);

  const commitAtDeadline = stepWatchLoop(initial, 2, 150, 50);
  expect(commitAtDeadline).toEqual({
    state: { lastVersion: 2, lastWakeAt: 150 },
    wake: true,
  });
});

test("watchLoop posts one wake when another connection commits at the default cadence", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  const clock = new ManualScheduler();
  let wakes = 0;
  let shutdown = false;
  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    undefined,
    0,
    undefined,
    loopScheduler(clock),
  );

  expect(clock.nextDelay()).toBe(25);
  commit(writer, "s");
  await clock.advanceBy(24);
  expect(wakes).toBe(0);
  expect(clock.pendingCount()).toBe(1);
  await clock.advanceBy(1);
  expect(wakes).toBe(1);
  expect(clock.pendingCount()).toBe(1);

  shutdown = true;
  await clock.runNext();
  await loop;
  expect(clock.pendingCount()).toBe(0);
  writer.close();
  reader.close();
});

test("watchLoop shutdown with no writes is silent and drains its pending sleep", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const clock = new ManualScheduler();
  let wakes = 0;
  let shutdown = false;
  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25,
    0,
    undefined,
    loopScheduler(clock),
  );

  expect(wakes).toBe(0);
  expect(clock.pendingCount()).toBe(1);
  shutdown = true;
  await clock.runNext();
  await loop;
  expect(wakes).toBe(0);
  expect(clock.pendingCount()).toBe(0);
  reader.close();
});

test("watchLoop maxIdleMs wakes exactly at the boundary and re-arms", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const clock = new ManualScheduler();
  let wakes = 0;
  let shutdown = false;
  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25,
    50,
    undefined,
    loopScheduler(clock),
  );

  await clock.advanceBy(49);
  expect(wakes).toBe(0);
  await clock.advanceBy(1);
  expect(wakes).toBe(1);
  await clock.advanceBy(50);
  expect(wakes).toBe(2);

  shutdown = true;
  await clock.runNext();
  await loop;
  reader.close();
});

test("watchLoop maxIdleMs=0 keeps explicit idle pending without waking", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const clock = new ManualScheduler();
  let wakes = 0;
  let shutdown = false;
  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25,
    0,
    undefined,
    loopScheduler(clock),
  );

  await clock.advanceBy(250);
  expect(wakes).toBe(0);
  expect(clock.pendingCount()).toBe(1);
  shutdown = true;
  await clock.runNext();
  await loop;
  reader.close();
});

test("watchLoop coalesces a commit and overdue idle condition into one wake per step", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  const clock = new ManualScheduler();
  const wakeAt: number[] = [];
  let shutdown = false;
  const loop = watchLoop(
    reader,
    () => wakeAt.push(clock.now),
    () => shutdown,
    25,
    50,
    undefined,
    loopScheduler(clock),
  );

  commit(writer, "coalesced");
  await clock.advanceBy(25);
  expect(wakeAt).toEqual([25]);
  await clock.advanceBy(49);
  expect(wakeAt).toEqual([25]);
  await clock.advanceBy(1);
  expect(wakeAt).toEqual([25, 75]);

  shutdown = true;
  await clock.runNext();
  await loop;
  writer.close();
  reader.close();
});

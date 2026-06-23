/**
 * Wake-worker round-trip tests. The deterministic data_version behavior (two
 * connections, timing) is covered end-to-end in the integration test; here we
 * verify the two structural contracts that don't depend on tight timing:
 *
 * - `watchLoop` posts a wake when ANOTHER connection commits, and stops when
 *   `isShutdown()` flips (driven directly, no real Worker — fast + reliable).
 * - A real spawned Worker shuts down cleanly on `{ type: "shutdown" }`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { watchLoop } from "../src/wake-worker";
import { retryUntil } from "./helpers/retry-until";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-wake-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // Bootstrap the schema with a writer so the readonly connection can open.
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("watchLoop posts a wake when another connection commits", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  let wakes = 0;
  let shutdown = false;

  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25,
  );

  // A SEPARATE writer connection commits — data_version only moves for the
  // reader when a different connection writes.
  const writer = openDb(dbPath).db;
  writer
    .query(
      "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 's', 'Stop', 'lifecycle', '{}')",
    )
    .run();

  // Give the 25ms poll a few cycles to observe the commit.
  await Bun.sleep(120);
  shutdown = true;
  await loop;

  expect(wakes).toBeGreaterThanOrEqual(1);
  writer.close();
  reader.close();
});

test("watchLoop default cadence (DEFAULT_POLL_MS=25) observes a commit within ~75ms", async () => {
  // fn-694 lever B2: the default poll cadence dropped 50→25ms. Drive the loop
  // with NO explicit pollMs so it uses DEFAULT_POLL_MS, and assert it observes
  // a commit within a window only the tighter cadence reliably clears.
  const reader = openDb(dbPath, { readonly: true }).db;
  let wakes = 0;
  let shutdown = false;

  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    // no pollMs → DEFAULT_POLL_MS (25)
  );

  const writer = openDb(dbPath).db;
  writer
    .query(
      "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 's', 'Stop', 'lifecycle', '{}')",
    )
    .run();

  // 75ms ≈ 3 cycles at 25ms; at the old 50ms default this is a single cycle.
  await Bun.sleep(75);
  shutdown = true;
  await loop;

  expect(wakes).toBeGreaterThanOrEqual(1);
  writer.close();
  reader.close();
});

test("watchLoop resolves once isShutdown flips with no writes", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  let wakes = 0;
  let shutdown = false;

  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25,
  );

  await Bun.sleep(80);
  shutdown = true;
  await loop; // must resolve, not hang

  expect(wakes).toBe(0);
  reader.close();
});

test("watchLoop maxIdleMs fires an idle wake with no commits (epic fn-907)", async () => {
  // No writer commits at all — only the idle timer drives wakes. The restore
  // worker rides this so the out-of-band tmux topology probe pulses ~1s even
  // when keeper.db is idle.
  const reader = openDb(dbPath, { readonly: true }).db;
  let wakes = 0;
  let shutdown = false;

  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25, // poll cadence
    40, // maxIdleMs — fire an idle wake every ~40ms with no commit
  );

  // ~200ms of pure idle should yield several idle wakes (no DB writes).
  await Bun.sleep(220);
  shutdown = true;
  await loop;

  expect(wakes).toBeGreaterThanOrEqual(2);
  reader.close();
});

test("watchLoop maxIdleMs=0 (default) fires NO idle wake without a commit", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  let wakes = 0;
  let shutdown = false;

  // maxIdleMs omitted → 0 → the idle path is disabled; a commit-less loop stays
  // silent (the wake worker's contract is unchanged).
  const loop = watchLoop(
    reader,
    () => {
      wakes += 1;
    },
    () => shutdown,
    25,
  );

  await Bun.sleep(120);
  shutdown = true;
  await loop;

  expect(wakes).toBe(0);
  reader.close();
});

test("watchLoop coalesces a commit and an overdue idle tick (one wake per turn)", async () => {
  // A commit resets the idle clock, so a fresh commit and an overdue idle wake
  // never both fire in the same loop iteration — one onWake per turn.
  const reader = openDb(dbPath, { readonly: true }).db;
  const wakeTimes: number[] = [];
  let shutdown = false;

  const loop = watchLoop(
    reader,
    () => {
      wakeTimes.push(Date.now());
    },
    () => shutdown,
    25,
    50,
  );

  // Commit once mid-flight; the rest of the wakes come from the idle timer.
  const writer = openDb(dbPath).db;
  await Bun.sleep(60);
  writer
    .query(
      "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 's', 'Stop', 'lifecycle', '{}')",
    )
    .run();
  await Bun.sleep(160);
  shutdown = true;
  await loop;

  // Consecutive wakes are always at least ~one poll interval apart — never two
  // in the same iteration (the coalesce). Allow a small scheduling slop floor.
  for (let i = 1; i < wakeTimes.length; i++) {
    expect(wakeTimes[i] - wakeTimes[i - 1]).toBeGreaterThanOrEqual(20);
  }
  expect(wakeTimes.length).toBeGreaterThanOrEqual(2);
  writer.close();
  reader.close();
});

test("spawned Worker shuts down cleanly on shutdown message", async () => {
  // `workerData` is a Bun/Node worker_threads option not present in the DOM
  // `WorkerOptions` lib type; cast to reach it.
  const worker = new Worker(
    new URL("../src/wake-worker.ts", import.meta.url).href,
    { workerData: { dbPath, pollMs: 25, role: "wake" } } as WorkerOptions & {
      workerData: unknown;
    },
  );

  let closed = false;
  // Bun exposes worker exit via the "close" event.
  worker.addEventListener("close", () => {
    closed = true;
  });

  // Let it boot and open its read-only connection.
  await Bun.sleep(60);
  worker.postMessage({ type: "shutdown" });

  // Poll the clean-exit flag with a generous ceiling so a hang fails loudly
  // (free on the happy path) instead of racing a fixed deadline under load.
  const ok = await retryUntil(() => closed || null, 20_000);
  expect(ok).toBe(true);
});

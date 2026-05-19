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
  writer.exec(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 's', 'Stop', 'lifecycle', '{}')",
  );

  // Give the 25ms poll a few cycles to observe the commit.
  await Bun.sleep(120);
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

test("spawned Worker shuts down cleanly on shutdown message", async () => {
  // `workerData` is a Bun/Node worker_threads option not present in the DOM
  // `WorkerOptions` lib type; cast to reach it.
  const worker = new Worker(
    new URL("../src/wake-worker.ts", import.meta.url).href,
    { workerData: { dbPath, pollMs: 25 } } as WorkerOptions & {
      workerData: unknown;
    },
  );

  const exited = new Promise<void>((resolve) => {
    // Bun exposes worker exit via the "close" event.
    worker.addEventListener("close", () => resolve());
  });

  // Let it boot and open its read-only connection.
  await Bun.sleep(60);
  worker.postMessage({ type: "shutdown" });

  // Race the clean-exit signal against a timeout so a hang fails loudly.
  const result = await Promise.race([
    exited.then(() => "exited" as const),
    Bun.sleep(2000).then(() => "timeout" as const),
  ]);

  expect(result).toBe("exited");
});

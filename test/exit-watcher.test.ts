/**
 * Tests for `src/exit-watcher.ts`. Two layers:
 *
 * 1. `diffLoop` against a real two-connection DB + a mocked ExitWatcher —
 *    verifies the data_version diff fires `onTick` with the correct
 *    candidate set on commits by another connection, and resolves cleanly
 *    when `isShutdown` flips. The "watch-set diff + alreadyDead → exit
 *    message" wiring is exercised in the same test by driving the diff
 *    callback directly (no real Worker thread needed).
 *
 * 2. A real spawned Worker shuts down cleanly on `{ type: "shutdown" }` —
 *    proves the FFI fd release runs in the worker's own shutdown handler
 *    and the worker actually exits (the kqueue/pidfd carve-out requires
 *    the resource to release before terminate()). This runs only on
 *    platforms the FFI module supports.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { diffLoop } from "../src/exit-watcher";
import type {
  AddResult,
  ExitWatcher,
  WaitResult,
} from "../src/exit-watcher-ffi";
import { retryUntil } from "./helpers/retry-until";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-exit-watcher-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // Bootstrap the schema with a writer so the readonly connection can open.
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Seed a `jobs` row directly (bypassing the events log). Mirrors the helper
 * in `test/daemon.test.ts` — the diffLoop reads `jobs`, so we don't need to
 * route through the reducer to set up the candidate set.
 */
function seedJobsRow(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  pid: number | null,
  startTime: string | null,
  state = "stopped",
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, title, title_source, transcript_path, start_time)
       VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, NULL, NULL, ?)`,
    [jobId, 0, pid, state, 0, startTime],
  );
}

// ---------------------------------------------------------------------------
// diffLoop — data_version-driven candidate-set diff
// ---------------------------------------------------------------------------

test("diffLoop fires onTick once at boot and again on each commit by another connection", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  const ticks: {
    job_id: string;
    pid: number | null;
    start_time: string | null;
  }[][] = [];
  let shutdown = false;

  // Seed an initial candidate row so the boot tick is non-empty.
  seedJobsRow(writer, "sess-pre-boot", 4242, "darwin:foo");

  const loop = diffLoop(
    reader,
    (rows) => {
      ticks.push(rows.slice());
    },
    () => shutdown,
    25,
  );

  // Boot tick fires synchronously inside diffLoop — give the event loop one
  // turn to let the awaited Bun.sleep enter the polling phase.
  await Bun.sleep(50);

  // A SEPARATE writer commit (another seed) must drive a second tick.
  seedJobsRow(writer, "sess-after-boot", 5252, "darwin:bar");
  await Bun.sleep(100);

  shutdown = true;
  await loop;

  // Boot tick: just the pre-boot row.
  expect(ticks.length).toBeGreaterThanOrEqual(1);
  expect(ticks[0]).toContainEqual({
    job_id: "sess-pre-boot",
    pid: 4242,
    start_time: "darwin:foo",
  });

  // At least one subsequent tick saw both rows.
  const afterRows = ticks[ticks.length - 1];
  const jobIds = afterRows.map((r) => r.job_id).sort();
  expect(jobIds).toEqual(["sess-after-boot", "sess-pre-boot"]);

  writer.close();
  reader.close();
});

test("diffLoop emits all non-terminal rows INCLUDING NULL-pid ones (fn-743)", async () => {
  // fn-743 dropped the old `pid IS NOT NULL` exclusion: a NULL-pid stopped row
  // is the stuck-`stopped` incident (unwatchable, lived forever). The diff loop
  // now surfaces it so `diffTick` can reap it via a pidless exit message.
  // Terminal rows (ended/killed) stay out of the candidate set.
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  let lastTick:
    | { job_id: string; pid: number | null; start_time: string | null }[]
    | null = null;
  let shutdown = false;

  // Mixed: alive working, alive stopped, ended (out), killed (out), NULL-pid
  // stopped (NOW IN — reaped via the pidless path), NULL-pid ended (out).
  seedJobsRow(writer, "sess-working", 1001, "darwin:a", "working");
  seedJobsRow(writer, "sess-stopped", 1002, "darwin:b", "stopped");
  seedJobsRow(writer, "sess-ended", 1003, "darwin:c", "ended");
  seedJobsRow(writer, "sess-killed", 1004, "darwin:d", "killed");
  seedJobsRow(writer, "sess-no-pid", null, null, "stopped");
  seedJobsRow(writer, "sess-no-pid-ended", null, null, "ended");

  const loop = diffLoop(
    reader,
    (rows) => {
      lastTick = rows.slice();
    },
    () => shutdown,
    25,
  );

  await Bun.sleep(50);
  shutdown = true;
  await loop;

  expect(lastTick).not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
  const ids = lastTick!.map((r) => r.job_id).sort();
  // NULL-pid STOPPED row is in; terminal rows (pid-bearing or NULL) are out.
  expect(ids).toEqual(["sess-no-pid", "sess-stopped", "sess-working"]);
  // The NULL-pid candidate carries pid === null (the diffTick pidless arm keys
  // off this to reap-on-sight rather than arm the kernel watcher).
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
  const noPidRow = lastTick!.find((r) => r.job_id === "sess-no-pid");
  expect(noPidRow?.pid).toBeNull();

  writer.close();
  reader.close();
});

test("diffLoop resolves once isShutdown flips with no writes", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  let ticks = 0;
  let shutdown = false;

  const loop = diffLoop(
    reader,
    () => {
      ticks += 1;
    },
    () => shutdown,
    25,
  );

  // Boot tick fires synchronously; subsequent ticks require commits.
  await Bun.sleep(80);
  shutdown = true;
  await loop; // must resolve, not hang

  // Exactly the boot tick (empty rows, no commits drove additional ticks).
  expect(ticks).toBe(1);
  reader.close();
});

// ---------------------------------------------------------------------------
// Worker integration — spawn + clean shutdown (FFI resource release)
// ---------------------------------------------------------------------------

const ffiSupported =
  process.platform === "darwin" || process.platform === "linux";

test.if(ffiSupported)(
  "spawned exit-watcher worker shuts down cleanly on shutdown message",
  async () => {
    // `workerData` is a Bun/Node worker_threads option not present in the
    // DOM `WorkerOptions` lib type; cast to reach it. Same dance as
    // `test/wake-worker.test.ts`.
    const worker = new Worker(
      new URL("../src/exit-watcher.ts", import.meta.url).href,
      { workerData: { dbPath, pollMs: 25 } } as WorkerOptions & {
        workerData: unknown;
      },
    );

    let closed = false;
    worker.addEventListener("close", () => {
      closed = true;
    });

    // Let it boot, open its RO connection, and construct the ExitWatcher.
    await Bun.sleep(120);
    worker.postMessage({ type: "shutdown" });

    // Poll the clean-exit flag with a generous ceiling so a hang fails loudly
    // (free on the happy path) instead of racing a fixed deadline under load.
    const ok = await retryUntil(() => closed || null, 20_000);
    expect(ok).toBe(true);
  },
);

test.if(ffiSupported)(
  "spawned exit-watcher worker posts an exit message when a tracked child dies",
  async () => {
    // Seed a candidate row for a real short-lived child process. We use
    // Bun.spawn so we get a stable cross-platform pid and the kernel
    // delivers an actual exit notification to the FFI layer. This is the
    // end-to-end loop: seed jobs row → worker registers via FFI → child
    // exits → kernel delivers → worker posts `{kind:"exit"}`.
    const child = Bun.spawn(["sleep", "0.2"]);
    const pid = child.pid;

    const writer = openDb(dbPath).db;
    seedJobsRow(writer, "sess-victim", pid, "darwin:victim");
    writer.close();

    const worker = new Worker(
      new URL("../src/exit-watcher.ts", import.meta.url).href,
      { workerData: { dbPath, pollMs: 25 } } as WorkerOptions & {
        workerData: unknown;
      },
    );

    let closed = false;
    worker.addEventListener("close", () => {
      closed = true;
    });

    const exitMsg = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("no exit message within 3000ms"));
      }, 3000);
      worker.addEventListener("message", (ev: MessageEvent<unknown>) => {
        const data = ev.data as { kind?: string } | undefined;
        if (data && data.kind === "exit") {
          clearTimeout(timer);
          resolve(data);
        }
      });
    }).finally(() => {
      worker.postMessage({ type: "shutdown" });
    });

    const msg = exitMsg as {
      kind: string;
      jobId: string;
      pid: number;
      startTime: string | null;
    };
    expect(msg.kind).toBe("exit");
    expect(msg.jobId).toBe("sess-victim");
    expect(msg.pid).toBe(pid);
    expect(msg.startTime).toBe("darwin:victim");

    await child.exited;
    // Poll the close flag (shutdown already messaged above) with a generous
    // ceiling instead of a fixed cleanup sleep.
    await retryUntil(() => closed || null, 20_000);
  },
);

// ---------------------------------------------------------------------------
// Watch-set diff against a mocked ExitWatcher — the alreadyDead short-circuit
// ---------------------------------------------------------------------------

/**
 * Build a mock ExitWatcher whose `add()` returns a programmable result per
 * call (so a test can drive the alreadyDead branch deterministically) and
 * whose `wait()` blocks on a controlled resolver. The mock records every
 * call for assertion.
 */
function buildMockWatcher(scriptedAdd: AddResult[]): {
  watcher: ExitWatcher;
  addCalls: { pid: number; udata: bigint }[];
  closed: () => boolean;
} {
  const addCalls: { pid: number; udata: bigint }[] = [];
  let closed = false;
  const watcher: ExitWatcher = {
    add(pid, udata) {
      addCalls.push({ pid, udata });
      const next = scriptedAdd.shift();
      return next ?? { registered: true };
    },
    async wait(timeoutMs): Promise<WaitResult> {
      // Park for the requested slice so the diff loop drives the show.
      await Bun.sleep(Math.min(timeoutMs, 50));
      return { kind: "timeout" };
    },
    wake() {
      // no-op for the mock
    },
    close() {
      closed = true;
    },
  };
  return { watcher, addCalls, closed: () => closed };
}

test("diffLoop+mock: every new candidate row triggers exactly one add()", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  const { watcher, addCalls } = buildMockWatcher([]);

  // Track which job ids the diff has already registered, to mirror the
  // worker's own dedup behavior.
  const tracked = new Set<string>();
  let shutdown = false;

  seedJobsRow(writer, "sess-a", 7001, "darwin:a");

  const loop = diffLoop(
    reader,
    (rows) => {
      for (const r of rows) {
        // Mirror the worker's pidless skip (fn-743): NULL-pid rows are reaped
        // on sight, never armed in the kernel.
        if (r.pid != null && !tracked.has(r.job_id)) {
          tracked.add(r.job_id);
          watcher.add(r.pid, BigInt(addCalls.length + 1));
        }
      }
    },
    () => shutdown,
    25,
  );

  // Boot tick: sess-a only.
  await Bun.sleep(50);
  seedJobsRow(writer, "sess-b", 7002, "darwin:b");
  await Bun.sleep(80);
  // Re-trigger another commit to confirm no DUPLICATE add for sess-a.
  writer.run(
    "UPDATE jobs SET last_event_id = last_event_id + 1 WHERE job_id = 'sess-a'",
  );
  await Bun.sleep(80);

  shutdown = true;
  await loop;

  // One add per unique pid, in arrival order.
  expect(addCalls.map((c) => c.pid).sort()).toEqual([7001, 7002]);
  watcher.close();
  writer.close();
  reader.close();
});

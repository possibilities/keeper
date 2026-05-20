/**
 * End-to-end integration smoke. Exercises the FULL path the production system
 * runs — hook write → events row → DB commit (data_version bump) → wake worker
 * → main-thread drain → jobs projection — by driving real processes, not
 * in-process shortcuts.
 *
 * Deliberately does NOT call `drain()` directly: the whole point is to prove
 * the wake-worker → reducer path actually fires. The daemon runs as a spawned
 * `bun run src/daemon.ts` (its `import.meta.main` guard means a real Worker is
 * spawned and signal handlers are installed); the hook runs as a spawned
 * `bun plugin/hooks/events-writer.ts` per event.
 *
 * Timing discipline: the wake worker polls `PRAGMA data_version` at 50ms and
 * the reducer drains asynchronously, so every assertion uses `retryUntil`
 * (bounded poll) rather than a fixed sleep. Daemon stdout/stderr is captured
 * and only surfaced on failure to keep test output clean.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { openDb } from "../src/db";
import { encodeFrame, LineBuffer, type ServerFrame } from "../src/protocol";

/** Repo root — this file lives at <root>/test, so one level up. */
const ROOT = join(import.meta.dir, "..");
const DAEMON_ENTRY = join(ROOT, "src", "daemon.ts");
const HOOK_ENTRY = join(ROOT, "plugin", "hooks", "events-writer.ts");

let tmpDir: string;
let dbPath: string;
let sockPath: string;
let daemon: Subprocess<"ignore", "pipe", "pipe"> | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-integration-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // BOTH KEEPER_DB and KEEPER_SOCK live in the tmpdir: a test that set only
  // KEEPER_DB would bind the REAL default socket and collide across isolates.
  sockPath = join(tmpDir, "keeperd.sock");
  daemon = null;
});

afterEach(async () => {
  // Best-effort: if a test left the daemon running (e.g. it failed before the
  // SIGTERM assertion), kill it so it can't leak into the next isolate.
  if (daemon && daemon.exitCode === null) {
    try {
      daemon.kill("SIGKILL");
      await daemon.exited;
    } catch {
      // already gone
    }
  }
  // A SIGKILLed daemon never runs its socket-release teardown, so unlink the
  // socket (+ lock) here too — a leftover would collide with the next isolate.
  for (const p of [sockPath, `${sockPath}.lock`]) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
      }
    } catch {
      // best-effort
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Poll `predicate` until it returns a truthy value or the deadline elapses.
 * Returns the truthy value, or `null` on timeout. Used instead of fixed sleeps
 * so a fast machine doesn't waste time and a slow one doesn't flake.
 */
async function retryUntil<T>(
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

/** Drain a piped stream to a string (for failure diagnostics). */
async function readStream(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

/**
 * Pipe one hook payload through the events-writer hook as a fresh process,
 * exactly as Claude Code invokes it. Awaits the hook's exit (always 0 by
 * contract) so the row is committed before the caller proceeds.
 */
async function fireHook(payload: Record<string, unknown>): Promise<void> {
  const proc = Bun.spawn(["bun", HOOK_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, KEEPER_DB: dbPath },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  // The hook contract is "always exit 0"; a non-zero exit is a real regression.
  if (code !== 0) {
    const err = await readStream(proc.stderr);
    throw new Error(`hook exited ${code}: ${err}`);
  }
}

test("end-to-end: hook writes → wake worker → reducer folds → jobs projection", async () => {
  const sessionId = "sess-e2e";

  // Spawn the daemon as a real process so the wake worker actually runs.
  // KEEPER_SOCK points at the tmpdir so the server worker can't bind the real
  // default socket (which would collide across isolates).
  daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, KEEPER_DB: dbPath, KEEPER_SOCK: sockPath },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Give the daemon time to open the writer connection, run boot drain (the DB
  // is empty so it's instant), and spawn the wake worker.
  await Bun.sleep(300);

  // A read-only connection mirrors the inspect CLI / external observer. Open it
  // AFTER the daemon has bootstrapped the schema (readers fail if the DB is
  // missing).
  const { db: reader } = openDb(dbPath, { readonly: true });

  try {
    // Drive a full session lifecycle. Pause between events so the 50ms wake
    // worker has a chance to observe each commit and the reducer can drain —
    // but assertions still use retryUntil, so this is just pacing, not a
    // correctness crutch.
    const sequence: Array<Record<string, unknown>> = [
      {
        hook_event_name: "SessionStart",
        session_id: sessionId,
        cwd: "/tmp/work",
        permission_mode: "default",
      },
      {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        permission_mode: "plan",
      },
      {
        hook_event_name: "Stop",
        session_id: sessionId,
        stop_hook_active: true,
      },
      {
        hook_event_name: "SessionEnd",
        session_id: sessionId,
      },
    ];

    for (const payload of sequence) {
      await fireHook(payload);
      await Bun.sleep(200);
    }

    // --- events table: exactly the four rows we fired, in id order. ---
    const events = await retryUntil(() => {
      const rows = reader
        .query(
          "SELECT id, hook_event, permission_mode FROM events ORDER BY id ASC",
        )
        .all() as Array<{
        id: number;
        hook_event: string;
        permission_mode: string | null;
      }>;
      return rows.length === sequence.length ? rows : null;
    });
    if (!events) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `events never reached 4 rows.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    expect(events.map((e) => e.hook_event)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
    ]);
    const lastEvent = events.at(-1);
    if (!lastEvent) {
      throw new Error("unreachable: events length asserted above");
    }
    const maxEventId = lastEvent.id;

    // --- jobs projection: one row, ended (terminal). ---
    const job = await retryUntil(() => {
      const row = reader
        .query(
          "SELECT job_id, state, last_event_id FROM jobs WHERE job_id = ?",
        )
        .get(sessionId) as {
        job_id: string;
        state: string;
        last_event_id: number;
      } | null;
      return row && row.state === "ended" ? row : null;
    });
    if (!job) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `job never reached ended.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }

    // Exactly one jobs row total.
    const jobCount = (
      reader.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
    ).n;
    expect(jobCount).toBe(1);

    expect(job.state).toBe("ended");

    // --- cursor caught up to the last event. ---
    const cursor = await retryUntil(() => {
      const row = reader
        .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
        .get() as { last_event_id: number };
      return row.last_event_id === maxEventId ? row : null;
    });
    if (!cursor) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `reducer cursor never caught up to ${maxEventId}.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    expect(cursor.last_event_id).toBe(maxEventId);
  } finally {
    reader.close();
  }

  // --- clean shutdown: SIGTERM → exit 0 (the only clean exit path). ---
  daemon.kill("SIGTERM");
  const exitCode = await daemon.exited;
  expect(exitCode).toBe(0);
}, 15000);

/**
 * Connect to the daemon's UDS as an in-test client (the ONLY thing that ever
 * connects — no consumer ships this epic). De-frames inbound NDJSON with the
 * SAME `LineBuffer` the server uses, accumulating decoded `ServerFrame`s into a
 * shared array the test polls via `retryUntil`. Returns the live socket plus
 * the frame sink and a `send` that encodes a client frame onto the wire.
 */
async function connectClient(unix: string): Promise<{
  socket: import("bun").Socket<undefined>;
  frames: ServerFrame[];
  send(frame: object): void;
}> {
  const frames: ServerFrame[] = [];
  const buffer = new LineBuffer();
  const socket = await Bun.connect({
    unix,
    socket: {
      data(_sock, chunk) {
        // Reuse the protocol de-framer: arbitrary chunk boundaries → lines.
        for (const line of buffer.push(chunk.toString("utf8"))) {
          if (line.trim().length > 0) {
            frames.push(JSON.parse(line) as ServerFrame);
          }
        }
      },
    },
  });
  return {
    socket,
    frames,
    send(frame: object): void {
      socket.write(encodeFrame(frame as never));
    },
  };
}

test("end-to-end: UDS subscribe server — query→result, then patch after a fold", async () => {
  const sessionId = "sess-subscribe-e2e";

  daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, KEEPER_DB: dbPath, KEEPER_SOCK: sockPath },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Boot: writer conn + boot drain + spawn both workers + bind the socket. The
  // server worker binds AFTER migrate, so poll for the socket file rather than
  // racing it with a fixed sleep.
  const bound = await retryUntil(
    () => (existsSync(sockPath) ? true : null),
    3000,
  );
  if (!bound) {
    const out = await readStream(daemon.stdout);
    const err = await readStream(daemon.stderr);
    throw new Error(`socket never bound.\nstdout:\n${out}\nstderr:\n${err}`);
  }

  // Fold one job so the query has a row to page + watch.
  await fireHook({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: "/tmp/work",
    permission_mode: "default",
  });

  // Wait for the reducer to project the job (read-only observer mirrors the
  // server's own view) before we query, so the result page is non-empty.
  const reader = openDb(dbPath, { readonly: true }).db;
  const projected = await retryUntil(() => {
    const row = reader
      .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
      .get(sessionId) as { last_event_id: number } | null;
    return row ? row : null;
  });
  reader.close();
  if (!projected) {
    const out = await readStream(daemon.stdout);
    const err = await readStream(daemon.stderr);
    throw new Error(`job never projected.\nstdout:\n${out}\nstderr:\n${err}`);
  }

  const client = await connectClient(sockPath);
  try {
    // --- query → result: ordered page, frozen membership, world rev. The
    // query now carries a required `collection`; result/patch echo it and the
    // patch payload is `row` (not `job`). ---
    client.send({ type: "query", collection: "jobs", id: "q1" });
    const result = await retryUntil(
      () => client.frames.find((f) => f.type === "result") ?? null,
    );
    if (!result || result.type !== "result") {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `result never arrived.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    expect(result.id).toBe("q1");
    expect(result.collection).toBe("jobs");
    // The result carries the filtered-set total (≥ the one job we folded).
    expect(typeof result.total).toBe("number");
    expect(result.total).toBeGreaterThanOrEqual(1);
    const baselineTotal = result.total;
    expect(result.rows.some((r) => r.job_id === sessionId)).toBe(true);
    const watchedRow = result.rows.find((r) => r.job_id === sessionId);
    if (!watchedRow) {
      throw new Error("unreachable: row presence asserted above");
    }
    const baselineEventId = watchedRow.last_event_id as number;

    // --- fold a change to the watched row → expect a patch (live cell). ---
    await fireHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      permission_mode: "plan",
    });

    const patch = await retryUntil(
      () =>
        client.frames.find(
          (f) =>
            f.type === "patch" &&
            f.row.job_id === sessionId &&
            (f.row.last_event_id as number) > baselineEventId,
        ) ?? null,
    );
    if (!patch || patch.type !== "patch") {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(`patch never arrived.\nstdout:\n${out}\nstderr:\n${err}`);
    }
    expect(patch.collection).toBe("jobs");
    expect(patch.row.job_id).toBe(sessionId);
    expect(patch.row.state).toBe("working");
    expect(patch.rev).toBeGreaterThanOrEqual(patch.row.last_event_id as number);

    // --- a NEW session enters the (unfiltered) set → a live `meta` with the
    // incremented total. Frozen membership means the new row is NOT pushed; the
    // meta is just the "set changed" count signal. ---
    const otherSession = "sess-subscribe-e2e-2";
    await fireHook({
      hook_event_name: "SessionStart",
      session_id: otherSession,
      cwd: "/tmp/work2",
      permission_mode: "default",
    });

    const meta = await retryUntil(
      () =>
        client.frames.find(
          (f) =>
            f.type === "meta" &&
            f.collection === "jobs" &&
            f.total > baselineTotal,
        ) ?? null,
    );
    if (!meta || meta.type !== "meta") {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(`meta never arrived.\nstdout:\n${out}\nstderr:\n${err}`);
    }
    expect(meta.total).toBe(baselineTotal + 1);
    // The new member's row never arrived as a patch (frozen membership).
    expect(
      client.frames.some(
        (f) => f.type === "patch" && f.row.job_id === otherSession,
      ),
    ).toBe(false);

    // --- and a leave decrements it. End the new session → SessionEnd folds it
    // to `ended`, but it remains a row (state sticky) so the unfiltered total is
    // unchanged. To prove a decrement, filter is the cleaner lever — but this
    // e2e watches the unfiltered set, where rows are never deleted in v1. The
    // decrement path is covered by the diffTick unit tests (row leave / delete).
  } finally {
    client.socket.end();
  }

  // --- clean shutdown: SIGTERM removes the socket file + exits 0. ---
  daemon.kill("SIGTERM");
  const exitCode = await daemon.exited;
  expect(exitCode).toBe(0);
  // The server worker's shutdown handler unlinks the socket (it's process-owned;
  // terminate() alone wouldn't release it).
  expect(existsSync(sockPath)).toBe(false);
}, 15000);

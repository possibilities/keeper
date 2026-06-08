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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { openDb } from "../src/db";
import { epicNumberFromId, taskNumberFromId } from "../src/plan-worker";
import { encodeFrame, LineBuffer, type ServerFrame } from "../src/protocol";
import { withInProcessDaemon } from "./helpers/in-process-daemon";
import { retryUntil } from "./helpers/retry-until";
import { sandboxEnv } from "./helpers/sandbox-env";
import { waitForDaemon } from "./helpers/wait-for-daemon";

/** Repo root — this file lives at <root>/test, so one level up. */
const ROOT = join(import.meta.dir, "..");
const DAEMON_ENTRY = join(ROOT, "src", "daemon.ts");
const HOOK_ENTRY = join(ROOT, "plugin", "hooks", "events-writer.ts");

let tmpDir: string;
let dbPath: string;
let sockPath: string;
let watchRoot: string;
let planRoot: string;
let configPath: string;
let daemon: Subprocess<"ignore", "pipe", "pipe"> | null = null;
/**
 * Registry of every victim-launcher subprocess spawned by a test. The
 * launcher parks forever once its inner hook commits, so a test that throws
 * or times out before its happy-path SIGKILL leaks the child — observed in
 * the wild at >24h uptime, pegging a CPU at ~100% and cascading e2e
 * timeouts. `afterEach` unconditionally reaps every entry (process-group
 * kill so any in-flight grandchild hook also dies), mirroring `daemon`.
 */
const victimLaunchers: Subprocess<"ignore", "pipe", "pipe">[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-integration-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // BOTH KEEPER_DB and KEEPER_SOCK live in the tmpdir: a test that set only
  // KEEPER_DB would bind the REAL default socket and collide across isolates.
  sockPath = join(tmpDir, "keeperd.sock");
  // Hermetic transcript watch root for the transcript-worker e2e — overrides
  // the default `~/.claude/projects` so the test never touches the real tree.
  watchRoot = join(tmpDir, "projects");
  mkdirSync(watchRoot, { recursive: true });
  // Hermetic plan root for the plan-worker e2e — a tmp dir the daemon watches
  // for `.planctl/{epics,tasks}/*.json` instead of the real `~/code`. The
  // daemon resolves it via a tmp `KEEPER_CONFIG` YAML so the watcher can never
  // touch the real `~/code`/`~/src` trees.
  planRoot = join(tmpDir, "plan-root");
  mkdirSync(planRoot, { recursive: true });
  // Hermetic agentuse root for the usage-worker e2e — a tmp dir the daemon
  // watches for `<id>.json` envelopes instead of the real
  // `~/.local/state/agentuse`. The daemon resolves it via the same tmp
  // `KEEPER_CONFIG` YAML so the usage worker never picks up the user's real
  // per-profile envelopes (which would mint synthetic UsageSnapshot events
  // and break the strict events-row-count assertions below).
  const usageRoot = join(tmpDir, "agentuse");
  mkdirSync(usageRoot, { recursive: true });
  configPath = join(tmpDir, "config.yaml");
  // Write a hermetic config pointing to planRoot (which has no .planctl/ dirs
  // yet) AND to the hermetic transcript watch root via `claude_projects_root`
  // AND to the hermetic agentuse root via `agentuse_root`. Passed to EVERY
  // daemon spawn so the plan worker never boots-scans the real ~/code tree
  // (which would flood the daemon with synthetic events and cause FSEvents
  // congestion), the transcript worker watches our tmp dir instead of the
  // real ~/.claude/projects, and the usage worker watches an empty tmp dir
  // instead of the real per-profile state dir.
  writeFileSync(
    configPath,
    `roots:\n  - ${JSON.stringify(planRoot)}\nclaude_projects_root: ${JSON.stringify(watchRoot)}\nagentuse_root: ${JSON.stringify(usageRoot)}\n`,
  );
  daemon = null;
});

afterEach(async () => {
  // Teardown is layered in try/finally so EVERY reclaim phase runs even if an
  // earlier one throws unexpectedly: a leaked daemon-kill must not strand a
  // parked victim-launcher (CPU-pegging leak observed in the wild), and neither
  // must strand the socket/lock unlink or the tmpdir rm. The inner per-victim /
  // per-path try/catches stay (they swallow the expected already-gone races);
  // the outer try/finally is the belt-and-suspenders for the unexpected throw.
  try {
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
  } finally {
    try {
      // Reap every spawned victim-launcher. The happy path SIGKILLs and awaits
      // exit, but a thrown / timed-out test bypasses that — and the launcher
      // parks forever, so without this sweep it leaks. We spawn launchers
      // `detached: true` (own process group), so a negative-pid kill takes out
      // the launcher AND any in-flight grandchild hook in one shot.
      while (victimLaunchers.length > 0) {
        const v = victimLaunchers.pop();
        if (!v || v.exitCode !== null) {
          continue;
        }
        try {
          // SIGKILL the whole process group. ESRCH is fine (already dead);
          // EPERM shouldn't happen in tests but is also swallowed.
          try {
            process.kill(-v.pid, "SIGKILL");
          } catch {
            // pgid kill may fail if the leader already exited — fall back to
            // direct-pid kill so we still reap the launcher itself.
            v.kill("SIGKILL");
          }
          await v.exited;
        } catch {
          // already gone
        }
      }
    } finally {
      try {
        // A SIGKILLed daemon never runs its socket-release teardown, so unlink
        // the socket (+ lock) here too — a leftover would collide with the next
        // isolate.
        for (const p of [sockPath, `${sockPath}.lock`]) {
          try {
            if (existsSync(p)) {
              unlinkSync(p);
            }
          } catch {
            // best-effort
          }
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }
});

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
 * Shared sandboxed base env for every test spawn that fires the real hook
 * (Family B: ambient ids kept, zellij feed included). Routes the state-bearing
 * env vars under the live per-test `tmpDir` so no spawn falls through to the
 * production `~/.local/state/keeper/` paths. See `test/helpers/sandbox-env.ts`.
 * fn-657 / fn-684 / fn-720.
 */
function sandboxedBaseEnv(): Record<string, string> {
  return sandboxEnv({
    tmpDir,
    dbPath,
    clearAmbientIds: false,
    includeZellij: true,
  });
}

/**
 * Sandboxed env for every spawned daemon (`bun run src/daemon.ts`). Routes ALL
 * SIX keeper state paths under the per-test tmpdir via `sandboxEnv`, PLUS the
 * two daemon-only knobs `KEEPER_SOCK` and `KEEPER_CONFIG`.
 *
 * Why this matters (and why the old hand-rolled `{ ...process.env, KEEPER_DB,
 * KEEPER_SOCK, KEEPER_CONFIG }` was a real bug, not just style): a daemon spawn
 * that strands `KEEPER_DEAD_LETTER_DIR` at its production default boot-IMPORTS
 * the human's REAL dead-letter backlog (`scanDeadLetterDir` at boot) — observed
 * live as a 45MB tmp DB that never finished booting (socket never bound, every
 * test timed out) AND a write into the real `~/.local/state/keeper/`
 * restore/backstop/drop sidecars. Sandboxing all six closes the CLAUDE.md
 * isolation invariant for the daemon spawn exactly as it's closed for the hook.
 */
function daemonSpawnEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  return sandboxEnv({
    tmpDir,
    dbPath,
    clearAmbientIds: false,
    includeZellij: true,
    extra: { KEEPER_SOCK: sockPath, KEEPER_CONFIG: configPath, ...extra },
  });
}

/**
 * fn-629 observation-gate helper: initialize a git repo in `dir` (so HEAD
 * resolves) with one empty commit. The plan-worker's fn-629 gate suppresses
 * snapshot emission for any `.planctl/*.json` not in HEAD — every
 * integration test that pre-writes plan files (mimicking what planctl
 * eventually commits at the seam) must init + commit, or the gate
 * (correctly) keeps them out of the projection.
 */
function gitInitPlanRoot(dir: string): void {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["config", "commit.gpgsign", "false"],
    ["commit", "--allow-empty", "-q", "-m", "init"],
  ] as const) {
    const res = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!res.success) {
      throw new Error(`git ${args.join(" ")} failed in ${dir}`);
    }
  }
}

/**
 * fn-629 observation-gate helper: stage + commit every `.planctl/*.json`
 * already present in `dir`, so the plan-worker's `isPathInHead` predicate
 * passes them through the gate. Mirrors what planctl does at the
 * `output.emit()` seam (commits the tree before the envelope returns) —
 * the keeper-side gate trusts that contract.
 */
function gitCommitPlanRoot(dir: string, message: string = "plan files"): void {
  for (const args of [
    ["add", ".planctl"],
    ["commit", "-q", "-m", message],
  ] as const) {
    const res = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!res.success) {
      throw new Error(`git ${args.join(" ")} failed in ${dir}`);
    }
  }
}

/**
 * Pipe one hook payload through the events-writer hook as a fresh process,
 * exactly as Claude Code invokes it. Awaits the hook's exit (always 0 by
 * contract) so the row is committed before the caller proceeds.
 */
async function fireHook(payload: Record<string, unknown>): Promise<void> {
  const proc = Bun.spawn(["bun", HOOK_ENTRY], {
    cwd: ROOT,
    env: sandboxedBaseEnv(),
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

/**
 * fn-747: inject one lifecycle event straight into the sandboxed DB via a
 * SECOND writer connection — the in-process-daemon analogue of {@link fireHook}.
 * The daemon's wake worker polls `PRAGMA data_version`, sees the cross-
 * connection commit, and drains it through main's reducer exactly as a
 * hook-sourced events-log row would once main ingests it (mirrors the keystone
 * in daemon.test.ts). Used by the tests migrated onto {@link withInProcessDaemon}
 * — the real subprocess hook stays in the retained subprocess smoke tests.
 */
function injectLifecycleEvent(
  dbFile: string,
  sessionId: string,
  hookEvent: string,
  opts: {
    pid?: number;
    cwd?: string | null;
    permissionMode?: string | null;
    data?: string;
  } = {},
): void {
  const writer = openDb(dbFile).db;
  try {
    writer.run(
      `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, permission_mode, data)
         VALUES (?, ?, ?, ?, 'lifecycle', ?, ?, ?)`,
      [
        Date.now() / 1000,
        sessionId,
        // Default to a LIVE pid (the test runner's own) so the liveness sweep
        // doesn't reap the synthetic job to `killed` — which would drop it from
        // the default `jobs` query scope (`state NOT IN (ended,killed)`). Tests
        // that need a dead pid pass one explicitly.
        opts.pid ?? process.pid,
        hookEvent,
        opts.cwd ?? null,
        opts.permissionMode ?? null,
        opts.data ?? "{}",
      ],
    );
  } finally {
    writer.close();
  }
}

test("end-to-end: hook writes → wake worker → reducer folds → jobs projection", async () => {
  const sessionId = "sess-e2e";

  // Spawn the daemon as a real process so the wake worker actually runs.
  // KEEPER_SOCK points at the tmpdir so the server worker can't bind the real
  // default socket (which would collide across isolates).
  daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
    cwd: ROOT,
    env: daemonSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the daemon to bind its socket — a strict happens-after signal for
  // migrate + boot drain + worker spawn. A fixed sleep raced the bootstrap and
  // tripped the reader's open below with SQLITE_CANTOPEN on a loaded machine.
  await waitForDaemon(sockPath);

  // A read-only connection mirrors the inspect CLI / external observer. Open it
  // AFTER the daemon has bootstrapped the schema (readers fail if the DB is
  // missing) — the readiness gate above guarantees the file is migrated.
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

    // --- events table: exactly the four rows we fired, in id order.
    // Filter out EVERY synthetic boot-append event, keyed by the
    // `event_type = 'autopilot_state'` tag rather than by hook_event name.
    // Main writes these from the boot drain on session_id="autopilot":
    // the `AutopilotPaused{paused:true}` re-arm (fn-661 / fn-667) AND the
    // `AutopilotCapSet` cap snapshot (fn-725 task .2) — and any future
    // boot synthetic carrying the same tag. They ride on the synthetic
    // "autopilot" session, not our test session, so the lifecycle
    // assertions on `sessionId` are unaffected; the tag-based exclude keeps
    // this raw-events count + ordering check stable as boot synthetics grow.
    const events = await retryUntil(() => {
      const rows = reader
        .query(
          `SELECT id, hook_event, permission_mode FROM events
             WHERE event_type != 'autopilot_state'
             ORDER BY id ASC`,
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
        .query("SELECT job_id, state, last_event_id FROM jobs WHERE job_id = ?")
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
}, 30000);

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
  // fn-747: in-process daemon. The clean-shutdown / socket-unlink contract is a
  // subprocess concern, covered by the retained subprocess smoke tests; here we
  // assert only the fold→serve→subscribe path, which is process-model-agnostic.
  // fn-749: minimal worker set — the fold runs on MAIN (pumped by `wake`), and
  // `server` serves it over the UDS. NO watcher worker spawns, so the
  // `@parcel/watcher` seam is irrelevant here; events arrive via direct DB
  // INSERT (injectLifecycleEvent), which the wake worker's data_version poll
  // catches.
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      const sessionId = "sess-subscribe-e2e";

      // Fold one job so the query has a row to page + watch.
      injectLifecycleEvent(dbPath, sessionId, "SessionStart", {
        cwd: "/tmp/work",
        permissionMode: "default",
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
      expect(projected).not.toBeNull();

      const client = await connectClient(sockPath);
      try {
        // --- query → result: ordered page, frozen membership, world rev. The
        // query now carries a required `collection`; result/patch echo it and the
        // patch payload is `row` (not `job`). ---
        client.send({ type: "query", collection: "jobs", id: "q1" });
        const result = await retryUntil(
          () => client.frames.find((f) => f.type === "result") ?? null,
        );
        expect(result).not.toBeNull();
        if (!result || result.type !== "result") {
          throw new Error("unreachable: result presence asserted above");
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
        injectLifecycleEvent(dbPath, sessionId, "UserPromptSubmit", {
          permissionMode: "plan",
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
        expect(patch).not.toBeNull();
        if (!patch || patch.type !== "patch") {
          throw new Error("unreachable: patch presence asserted above");
        }
        expect(patch.collection).toBe("jobs");
        expect(patch.row.job_id).toBe(sessionId);
        expect(patch.row.state).toBe("working");
        expect(patch.rev).toBeGreaterThanOrEqual(
          patch.row.last_event_id as number,
        );

        // --- a NEW session enters the (unfiltered) set → a live `meta` with the
        // incremented total. Frozen membership means the new row is NOT pushed; the
        // meta is just the "set changed" count signal. ---
        const otherSession = "sess-subscribe-e2e-2";
        injectLifecycleEvent(dbPath, otherSession, "SessionStart", {
          cwd: "/tmp/work2",
          permissionMode: "default",
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
        expect(meta).not.toBeNull();
        if (!meta || meta.type !== "meta") {
          throw new Error("unreachable: meta presence asserted above");
        }
        expect(meta.total).toBe(baselineTotal + 1);
        // The new member's row never arrived as a patch (frozen membership).
        expect(
          client.frames.some(
            (f) => f.type === "patch" && f.row.job_id === otherSession,
          ),
        ).toBe(false);
      } finally {
        client.socket.end();
      }
    },
    { workers: ["wake", "server"] },
  );
}, 30000);

test("end-to-end: set_task_approval / set_epic_approval RPC → atomic SIDECAR write, committed def untouched (fn-732)", async () => {
  // Hermetic plan tree: write two real planctl files into the tmp planRoot
  // so the daemon's plan worker can see them via @parcel/watcher (the
  // watcher path is exercised more thoroughly in plan-worker.test.ts; here
  // we just prove the RPC writes the gitignored runtime SIDECAR with the right
  // shape and LEAVES THE COMMITTED DEF UNTOUCHED (fn-732 retarget).
  const { mkdirSync, readFileSync, writeFileSync } =
    require("node:fs") as typeof import("node:fs");
  const { serializePlanctlJson } =
    require("../src/db") as typeof import("../src/db");
  const epicsDir = join(planRoot, ".planctl", "epics");
  const tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  const epicPath = join(epicsDir, "fn-99-rpc-e2e.json");
  const taskPath = join(tasksDir, "fn-99-rpc-e2e.1.json");
  writeFileSync(
    epicPath,
    serializePlanctlJson({
      id: "fn-99-rpc-e2e",
      title: "RPC E2E",
      status: "open",
      approval: "pending",
    }),
  );
  writeFileSync(
    taskPath,
    serializePlanctlJson({
      id: "fn-99-rpc-e2e.1",
      epic: "fn-99-rpc-e2e",
      title: "T1",
      approval: "pending",
    }),
  );

  // fn-747: in-process daemon, with the hermetic plan root wired through
  // `KEEPER_CONFIG` so the RPC handler scans `planRoot` for the committed def
  // before writing the sidecar next to it. (The watcher is disabled in-process;
  // the RPC's root scan is filesystem-direct and never touches the projection.)
  await withInProcessDaemon(
    async ({ sockPath }) => {
      // Build a one-shot RPC client (inline — no scripts/approve.ts dependency
      // since that CLI is updated to the new RPCs in a later task).
      async function rpc(
        method: string,
        params: Record<string, unknown>,
      ): Promise<unknown> {
        const buffer = new LineBuffer();
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          Bun.connect({
            unix: sockPath,
            socket: {
              open(s) {
                s.write(encodeFrame({ type: "rpc", id, method, params }));
              },
              data(s, chunk) {
                for (const line of buffer.push(chunk.toString("utf8"))) {
                  if (line.trim().length === 0) continue;
                  const frame = JSON.parse(line) as ServerFrame;
                  if ((frame as { id?: string }).id !== id) continue;
                  if (frame.type === "rpc_result") {
                    resolve(frame.value);
                  } else if (frame.type === "error") {
                    reject(
                      new Error(
                        `${(frame as { code: string }).code}: ${(frame as { message: string }).message}`,
                      ),
                    );
                  }
                  s.end();
                  return;
                }
              },
              close() {
                // resolved/rejected already, nothing to do
              },
              error(_s, err) {
                reject(err);
              },
            },
          }).catch(reject);
        });
      }

      const taskSidecarPath = join(
        planRoot,
        ".planctl",
        "state",
        "tasks",
        "fn-99-rpc-e2e.1.state.json",
      );
      const epicSidecarPath = join(
        planRoot,
        ".planctl",
        "state",
        "epics",
        "fn-99-rpc-e2e.state.json",
      );

      // --- set_task_approval: writes the task SIDECAR's `approval` field. ---
      const taskResult = (await rpc("set_task_approval", {
        epic_id: "fn-99-rpc-e2e",
        task_id: "fn-99-rpc-e2e.1",
        status: "approved",
      })) as {
        ok: boolean;
        epic_id: string;
        task_id: string;
        approval: string;
      };
      expect(taskResult).toEqual({
        ok: true,
        epic_id: "fn-99-rpc-e2e",
        task_id: "fn-99-rpc-e2e.1",
        approval: "approved",
      });
      // Sidecar carries the approval.
      const taskSidecar = JSON.parse(readFileSync(taskSidecarPath, "utf8")) as {
        approval: string;
      };
      expect(taskSidecar.approval).toBe("approved");
      // Committed def is UNTOUCHED — still `pending`, title intact.
      const taskDefAfter = JSON.parse(readFileSync(taskPath, "utf8")) as {
        approval: string;
        title: string;
      };
      expect(taskDefAfter.approval).toBe("pending");
      expect(taskDefAfter.title).toBe("T1");

      // --- set_epic_approval: writes the epic SIDECAR's `approval` field. ---
      const epicResult = (await rpc("set_epic_approval", {
        epic_id: "fn-99-rpc-e2e",
        status: "rejected",
      })) as { ok: boolean; epic_id: string; approval: string };
      expect(epicResult).toEqual({
        ok: true,
        epic_id: "fn-99-rpc-e2e",
        approval: "rejected",
      });
      const epicSidecar = JSON.parse(readFileSync(epicSidecarPath, "utf8")) as {
        approval: string;
      };
      expect(epicSidecar.approval).toBe("rejected");
      // Committed def untouched.
      const epicDefAfter = JSON.parse(readFileSync(epicPath, "utf8")) as {
        approval: string;
        title: string;
      };
      expect(epicDefAfter.approval).toBe("pending");
      expect(epicDefAfter.title).toBe("RPC E2E");

      // --- bad enum: server returns `bad_params`, the connection survives. ---
      try {
        await rpc("set_task_approval", {
          epic_id: "fn-99-rpc-e2e",
          task_id: "fn-99-rpc-e2e.1",
          status: "garbage",
        });
        throw new Error("expected rejection");
      } catch (e) {
        expect(String(e)).toMatch(/bad_params/);
      }
    },
    // fn-749: minimal set — the set_{task,epic}_approval RPCs are handled
    // server-worker-side (filesystem-direct sidecar write + scan), so only
    // `server` is load-bearing; `wake` rides along for boot-drain readiness.
    // No watcher worker spawns despite the hermetic plan tree — the RPC's root
    // scan never touches the projection.
    { env: { KEEPER_CONFIG: configPath }, workers: ["wake", "server"] },
  );
}, 30000);

test("end-to-end: replay_dead_letter RPC routes board→worker→main, appends real event, flips waiting→recovered, session reappears", async () => {
  // fn-747: in-process daemon. The replay path is pure DB + RPC + fold (no file
  // watch), so it converts cleanly. We INSERT the seed `waiting` rows AFTER boot
  // (the harness creates + migrates the DB at boot) via a SECOND writer
  // connection, mirroring what the dead-letter boot scan would have produced.
  // fn-749: minimal set — replay routes board→`server`→main bridge (appends a
  // real event + pumps a wake on MAIN), then the fold reappears the session
  // which `server` serves; `wake` is the backstop poll. No watcher worker.
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      // Seed two `waiting` rows by hand. We INSERT directly into `dead_letters`
      // (mirroring what the scan would have produced) so the test is hermetic
      // against the dead-letter parser and the NDJSON file format. The post-replay
      // assertions still drive the full worker→main→reducer round-trip.
      {
        const { db } = openDb(dbPath);
        try {
          const insertStmt = db.prepare(
            `INSERT INTO dead_letters
             (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
              status, recovered_at, replayed_event_id, source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL)`,
          );
          // First (oldest) waiting row: a dropped SessionStart for sess-replay-1.
          insertStmt.run(
            "dl-first",
            "sess-replay-1",
            "SessionStart",
            1_700_000_000,
            100,
            4321,
            JSON.stringify({
              ts: 1_700_000_000,
              session_id: "sess-replay-1",
              pid: 4321,
              hook_event: "SessionStart",
              event_type: "lifecycle",
              data: "{}",
              cwd: "/tmp/replay",
            }),
          );
          // Second waiting row — newer dl_written_at; should NOT be picked first.
          insertStmt.run(
            "dl-second",
            "sess-replay-2",
            "SessionStart",
            1_700_000_005,
            200,
            4322,
            JSON.stringify({
              ts: 1_700_000_005,
              session_id: "sess-replay-2",
              pid: 4322,
              hook_event: "SessionStart",
              event_type: "lifecycle",
              data: "{}",
              cwd: "/tmp/replay-2",
            }),
          );
        } finally {
          db.close();
        }
      }

      async function rpc(
        method: string,
        params: Record<string, unknown> | undefined,
      ): Promise<unknown> {
        const buffer = new LineBuffer();
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          Bun.connect({
            unix: sockPath,
            socket: {
              open(s) {
                s.write(
                  encodeFrame(
                    params === undefined
                      ? { type: "rpc", id, method }
                      : { type: "rpc", id, method, params },
                  ),
                );
              },
              data(s, chunk) {
                for (const line of buffer.push(chunk.toString("utf8"))) {
                  if (line.trim().length === 0) continue;
                  const frame = JSON.parse(line) as ServerFrame;
                  if ((frame as { id?: string }).id !== id) continue;
                  if (frame.type === "rpc_result") {
                    resolve(frame.value);
                  } else if (frame.type === "error") {
                    reject(
                      new Error(
                        `${(frame as { code: string }).code}: ${(frame as { message: string }).message}`,
                      ),
                    );
                  }
                  s.end();
                  return;
                }
              },
              close() {},
              error(_s, err) {
                reject(err);
              },
            },
          }).catch(reject);
        });
      }

      // First replay: oldest waiting row (dl-first, sess-replay-1) flips to
      // recovered; the events log gains a real SessionStart row; the reducer
      // folds it into a fresh `jobs` row.
      const first = (await rpc("replay_dead_letter", {})) as {
        ok: boolean;
        recovered_dl_id: string | null;
      };
      expect(first).toEqual({ ok: true, recovered_dl_id: "dl-first" });

      // Poll the jobs projection for the recovered session.
      const verify = await retryUntil(() => {
        const { db } = openDb(dbPath, { readonly: true });
        try {
          const job = db
            .query(
              "SELECT job_id, state, cwd FROM jobs WHERE job_id = 'sess-replay-1'",
            )
            .get() as { job_id: string; state: string; cwd: string } | null;
          const dl = db
            .query(
              "SELECT status, replayed_event_id FROM dead_letters WHERE dl_id = 'dl-first'",
            )
            .get() as {
            status: string;
            replayed_event_id: number | null;
          } | null;
          if (
            job &&
            dl &&
            dl.status === "recovered" &&
            dl.replayed_event_id !== null
          ) {
            return { job, dl };
          }
          return null;
        } finally {
          db.close();
        }
      }, 3000);
      expect(verify).not.toBeNull();
      expect(verify?.job.job_id).toBe("sess-replay-1");
      expect(verify?.job.cwd).toBe("/tmp/replay");

      // Second replay: drains the next oldest (dl-second).
      const second = (await rpc("replay_dead_letter", {})) as {
        ok: boolean;
        recovered_dl_id: string | null;
      };
      expect(second).toEqual({ ok: true, recovered_dl_id: "dl-second" });

      // Third replay: backlog empty → clean ack, NOT an error.
      const third = (await rpc("replay_dead_letter", undefined)) as {
        ok: boolean;
        recovered_dl_id: string | null;
      };
      expect(third).toEqual({ ok: true, recovered_dl_id: null });

      // A bad params payload is rejected as `bad_params` and the connection
      // survives — the dispatcher contract for typed validation throws.
      try {
        await rpc("replay_dead_letter", { dl_id: "nope" });
        throw new Error("expected bad_params rejection");
      } catch (e) {
        expect(String(e)).toMatch(/bad_params/);
      }
    },
    { workers: ["wake", "server"] },
  );
}, 30000);

test("end-to-end: transcript worker → custom-title write flips jobs.title to 'transcript'", async () => {
  const sessionId = "sess-transcript-e2e";

  // Spawn the daemon. The hermetic watch root is supplied via the tmp config's
  // `claude_projects_root` key (set in beforeEach), so the transcript worker
  // watches our tmp dir instead of the real ~/.claude/projects.
  daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
    cwd: ROOT,
    env: daemonSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the daemon to bind its socket (happens-after migrate + boot drain
  // + worker spawn — the transcript worker subscribes to the watch root in the
  // same boot phase). Replaces a fixed sleep that raced the bootstrap.
  await waitForDaemon(sockPath);

  // Fold a SessionStart so the job row exists for the title to land on. The
  // transcript title only updates an existing job (the title rule no-ops when
  // no row matches).
  await fireHook({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: "/tmp/work",
    permission_mode: "default",
  });

  const { db: reader } = openDb(dbPath, { readonly: true });
  try {
    // Wait for the job to project before we touch the transcript.
    const projected = await retryUntil(() => {
      const row = reader
        .query("SELECT job_id FROM jobs WHERE job_id = ?")
        .get(sessionId) as { job_id: string } | null;
      return row ? row : null;
    });
    if (!projected) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(`job never projected.\nstdout:\n${out}\nstderr:\n${err}`);
    }

    // Write a transcript file with a `custom-title` line under the watch root.
    // The filename mirrors Claude Code's `<session-id>.jsonl` convention (the
    // worker routes by the line's `sessionId`, not the path, but keep it real).
    const transcriptPath = join(watchRoot, `${sessionId}.jsonl`);
    // Create empty first so the worker anchors at EOF, then append the title
    // line — exercising the live forward-tail (append-after-watch) path.
    writeFileSync(transcriptPath, "");
    await Bun.sleep(150);
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "custom-title",
        customTitle: "Live Renamed Title",
        sessionId,
      })}\n`,
    );

    // The watcher fires → worker tails the line → posts to main → main inserts a
    // synthetic TranscriptTitle event → reducer folds it at priority-3. The 8s
    // budget gives FSEvents-grade latency headroom under serial slow-tier load.
    const titled = await retryUntil(() => {
      const row = reader
        .query("SELECT title, title_source FROM jobs WHERE job_id = ?")
        .get(sessionId) as {
        title: string | null;
        title_source: string | null;
      } | null;
      return row && row.title_source === "transcript" ? row : null;
    }, 8000);
    if (!titled) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `transcript title never folded.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    expect(titled.title).toBe("Live Renamed Title");
    expect(titled.title_source).toBe("transcript");
  } finally {
    reader.close();
  }

  // Clean shutdown: SIGTERM → all three workers tear down → exit 0. The
  // transcript worker unsubscribes its watcher in its shutdown handler.
  daemon.kill("SIGTERM");
  const exitCode = await daemon.exited;
  expect(exitCode).toBe(0);
  // fn-747: one of the retained TRUE-watcher subprocess smoke tests (live
  // FSEvents transcript tail). It boots a real subprocess daemon WITH the native
  // watcher — one of the two reasons `test:slow` stays SERIAL (concurrent
  // subprocess-daemon addon teardown segfaults under --parallel). Real boot +
  // FSEvents latency is still load-variable (fn-722.7 saw 10s→36s under box
  // load), so a 60s budget keeps it pass/fail-stable. Soak gates on pass/fail
  // only, never timing.
}, 60000);

test("end-to-end: rename-while-down → folded at boot via the startup transcript scan", async () => {
  const sessionId = "sess-rename-while-down";
  const transcriptPath = join(watchRoot, `${sessionId}.jsonl`);

  // --- Daemon run #1: establish the job row with its transcript_path ---------
  // The startup scan is scoped via `jobs.transcript_path`, so the row (with its
  // path) must already exist. SessionStart captures transcript_path from the
  // payload. Start the file EMPTY so run #1's live tail anchors at EOF and folds
  // no title — exactly the state at a normal session start.
  writeFileSync(transcriptPath, "");
  daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
    cwd: ROOT,
    env: daemonSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for run #1's daemon to bind its socket (happens-after migrate + boot
  // drain + worker spawn). Replaces a fixed boot sleep that raced the bootstrap.
  await waitForDaemon(sockPath);

  await fireHook({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: "/tmp/work",
    permission_mode: "default",
    transcript_path: transcriptPath,
  });

  const { db: reader } = openDb(dbPath, { readonly: true });
  try {
    const projected = await retryUntil(() => {
      const row = reader
        .query("SELECT transcript_path FROM jobs WHERE job_id = ?")
        .get(sessionId) as { transcript_path: string | null } | null;
      return row && row.transcript_path === transcriptPath ? row : null;
    });
    if (!projected) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `job/transcript_path never projected.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }

    // --- Stop the daemon, THEN rename (the "while down" window) --------------
    daemon.kill("SIGTERM");
    const code1 = await daemon.exited;
    expect(code1).toBe(0);
    daemon = null;

    // The custom-title written while the daemon is down — the live tail will
    // never see this append (the daemon isn't watching). Only the boot scan of
    // run #2 can fold it.
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "custom-title",
        customTitle: "Renamed While Down",
        sessionId,
      })}\n`,
    );

    // --- Daemon run #2: the boot scan folds the current title ---------------
    daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
      cwd: ROOT,
      env: daemonSpawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Gate the title-fold poll on run #2's socket bind so the poll budget below
    // measures only the boot-SCAN latency, not the (load-variable) migrate +
    // boot-drain + worker-spawn that precedes it. Without this, under serial
    // slow-tier contention the bare 5s `retryUntil` was consumed by boot alone
    // and flaked before the scan ever ran.
    await waitForDaemon(sockPath);

    const titled = await retryUntil(() => {
      const row = reader
        .query("SELECT title, title_source FROM jobs WHERE job_id = ?")
        .get(sessionId) as {
        title: string | null;
        title_source: string | null;
      } | null;
      return row && row.title_source === "transcript" ? row : null;
    }, 8000);
    if (!titled) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `rename-while-down title never folded at boot.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    expect(titled.title).toBe("Renamed While Down");
    expect(titled.title_source).toBe("transcript");
  } finally {
    reader.close();
  }

  daemon.kill("SIGTERM");
  const code2 = await daemon.exited;
  expect(code2).toBe(0);
  // fn-747: the second retained TRUE-watcher subprocess smoke test (boot-scan
  // transcript fold across a restart). Two real subprocess-daemon boots WITH the
  // native watcher — part of why `test:slow` stays SERIAL; a 60s budget absorbs
  // the load-variable boot latency (fn-722.7). Soak gates on pass/fail only.
}, 60000);

test("end-to-end: plan worker → .planctl write → synthetic event → fold → epics/tasks projection + UDS subscribe", async () => {
  const epicId = "fn-9-keeper-e2e-plans";
  const taskId = `${epicId}.1`;

  // Point the daemon's plan worker at a hermetic tmp root via a tmp config YAML
  // (KEEPER_CONFIG override) so the watcher never touches the real ~/code/~/src.
  writeFileSync(configPath, `roots:\n  - ${JSON.stringify(planRoot)}\n`);
  const epicsDir = join(planRoot, ".planctl", "epics");
  const tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  const epicFile = join(epicsDir, `${epicId}.json`);
  const taskFile = join(tasksDir, `${taskId}.json`);

  // Write the plan files BEFORE starting the daemon. The plan worker does a
  // boot scan after its subscribe resolves, so pre-existing files are emitted
  // without waiting for an FSEvents delivery. This removes the race between
  // "daemon subscribes" and "test writes files" that caused flakes under full
  // --isolate suite pressure.
  writeFileSync(
    epicFile,
    JSON.stringify({
      id: epicId,
      title: "Keeper E2E Plans Epic",
      // planctl epic statuses are open|done (EPIC_STATUSES); "open" keeps it in
      // the epics collection's default scope so the unfiltered subscribe sees it.
      status: "open",
      primary_repo: "/tmp/keeper-e2e-repo",
      // The daemon's v13 boot-time approval migration backfills `approval`
      // to "approved" on any epic file lacking the field — which the
      // unfiltered subscribe would then HIDE via the
      // `{ approval: { ne: "approved" } }` default filter. We write
      // "pending" up front to opt out of the backfill and stay in scope.
      approval: "pending",
    }),
  );
  writeFileSync(
    taskFile,
    JSON.stringify({
      id: taskId,
      epic: epicId,
      title: "First plans task",
      target_repo: "/tmp/keeper-e2e-repo",
      // No worker_done_at → derived status "open".
      approval: "pending",
    }),
  );

  // fn-629 observation gate: plan-worker suppresses snapshot emission for
  // any .planctl/*.json not yet in git HEAD. Mirror the planctl
  // `output.emit()` contract by initializing a repo and committing the
  // plan tree before the daemon boots — otherwise the boot scan correctly
  // gates these files into the pending set and no synthetic event lands.
  gitInitPlanRoot(planRoot);
  gitCommitPlanRoot(planRoot, "add epic + task");

  // fn-747: in-process daemon, plan root wired through `KEEPER_CONFIG`. The plan
  // worker's `disableNativeWatcher` degrade still runs its BOOT SCAN per root, so
  // the pre-committed plan files are emitted as synthetic snapshot events without
  // any FSEvents involvement; the later live-patch assertions already drive the
  // event→fold→UDS-patch chain via direct event INSERT, so they are unaffected by
  // the watcher being off.
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      const { db: reader } = openDb(dbPath, { readonly: true });
      try {
        // --- synthetic events land, with the right hook_event + entity key. ---
        const events = await retryUntil(() => {
          const rows = reader
            .query(
              "SELECT session_id, hook_event FROM events WHERE hook_event IN ('EpicSnapshot', 'TaskSnapshot') ORDER BY id ASC",
            )
            .all() as Array<{ session_id: string; hook_event: string }>;
          return rows.length >= 2 ? rows : null;
        }, 8000);
        if (!events) {
          throw new Error("synthetic plan events never landed");
        }
        expect(events).toContainEqual({
          session_id: epicId,
          hook_event: "EpicSnapshot",
        });
        expect(events).toContainEqual({
          session_id: taskId,
          hook_event: "TaskSnapshot",
        });

        // --- epics projection: one row with the folded columns. ---
        const epic = await retryUntil(() => {
          const row = reader
            .query(
              "SELECT epic_id, epic_number, title, project_dir, status, last_event_id FROM epics WHERE epic_id = ?",
            )
            .get(epicId) as {
            epic_id: string;
            epic_number: number | null;
            title: string | null;
            project_dir: string | null;
            status: string | null;
            last_event_id: number;
          } | null;
          return row ? row : null;
        }, 8000);
        if (!epic) {
          throw new Error("epic never projected");
        }
        expect(epic.epic_number).toBe(9);
        expect(epic.title).toBe("Keeper E2E Plans Epic");
        expect(epic.project_dir).toBe("/tmp/keeper-e2e-repo");
        expect(epic.status).toBe("open");
        const baselineEpicEventId = epic.last_event_id;

        // --- tasks projection: embedded in the parent epic's `tasks` array (schema
        // v7 — no standalone tasks table). Read the epic's array and find the task. ---
        interface EmbeddedTask {
          task_id: string;
          epic_id: string | null;
          task_number: number | null;
          title: string | null;
          target_repo: string | null;
          // Schema v19: legacy `status` was renamed to `worker_phase` (derived
          // worker-phase binary) to free up `runtime_status` (planctl-native
          // enum) as a sibling field. Both ride inside the embedded element.
          worker_phase: string | null;
          runtime_status: string;
        }
        const task = await retryUntil(() => {
          const row = reader
            .query("SELECT tasks FROM epics WHERE epic_id = ?")
            .get(epicId) as { tasks: string | null } | null;
          if (row == null || row.tasks == null || row.tasks.length === 0) {
            return null;
          }
          const arr = JSON.parse(row.tasks) as EmbeddedTask[];
          return arr.find((t) => t.task_id === taskId) ?? null;
        }, 8000);
        if (!task) {
          throw new Error("task never projected");
        }
        expect(task.epic_id).toBe(epicId);
        expect(task.task_number).toBe(1);
        expect(task.title).toBe("First plans task");
        expect(task.target_repo).toBe("/tmp/keeper-e2e-repo");
        // Schema v19: assert both task-status fields. `worker_phase` is the
        // derived binary (was `status`); `runtime_status` defaults to "todo"
        // when the task has no `.planctl/state/tasks/<id>.state.json` sidecar.
        expect(task.worker_phase).toBe("open");
        expect(task.runtime_status).toBe("todo");

        // --- UDS subscribe over the epics collection: query → result, then a live
        // patch when the epic file changes (state-on-disk → snapshot → fold). ---
        const client = await connectClient(sockPath);
        try {
          client.send({ type: "query", collection: "epics", id: "qe" });
          const result = await retryUntil(
            () => client.frames.find((f) => f.type === "result") ?? null,
          );
          if (!result || result.type !== "result") {
            throw new Error("epics result never arrived");
          }
          expect(result.collection).toBe("epics");
          expect(result.rows.some((r) => r.epic_id === epicId)).toBe(true);

          // Trigger a live patch by inserting a synthetic EpicSnapshot event
          // directly — the same thing the plan worker emits on a file change. This
          // tests the key event→fold→UDS-patch chain without relying on FSEvents
          // delivery timing under full-suite load (FSEvents is unreliable when
          // many test processes run concurrently).
          const { db: patchWriter, stmts: patchStmts } = openDb(dbPath);
          patchStmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: epicId,
            $pid: null,
            $hook_event: "EpicSnapshot",
            $event_type: "plan_snapshot",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({
              epic_number: epicNumberFromId(epicId),
              title: "Keeper E2E Plans Epic",
              project_dir: "/tmp/keeper-e2e-repo",
              status: "done",
            }),
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
          });
          patchWriter.close();

          const patch = await retryUntil(
            () =>
              client.frames.find(
                (f) =>
                  f.type === "patch" &&
                  f.collection === "epics" &&
                  f.row.epic_id === epicId &&
                  (f.row.last_event_id as number) > baselineEpicEventId,
              ) ?? null,
            8000,
          );
          if (!patch || patch.type !== "patch") {
            throw new Error("epics patch never arrived");
          }
          expect(patch.collection).toBe("epics");
          expect(patch.row.status).toBe("done");

          // A TaskSnapshot folds into its PARENT epic's embedded array — it arrives
          // as a `patch` on the epic row (not its own collection). Insert a
          // synthetic TaskSnapshot for the same task with a flipped status and
          // assert the parent epic patches with the updated element in `tasks`.
          const epicEventIdAfterEpicPatch = patch.row.last_event_id as number;
          const { db: taskWriter, stmts: taskStmts } = openDb(dbPath);
          taskStmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: taskId,
            $pid: null,
            $hook_event: "TaskSnapshot",
            $event_type: "plan_snapshot",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({
              epic_id: epicId,
              task_number: taskNumberFromId(taskId),
              title: "First plans task",
              target_repo: "/tmp/keeper-e2e-repo",
              status: "done",
            }),
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
          });
          taskWriter.close();

          const taskPatch = await retryUntil(
            () =>
              client.frames.find(
                (f) =>
                  f.type === "patch" &&
                  f.collection === "epics" &&
                  f.row.epic_id === epicId &&
                  (f.row.last_event_id as number) > epicEventIdAfterEpicPatch,
              ) ?? null,
            8000,
          );
          if (!taskPatch || taskPatch.type !== "patch") {
            throw new Error("task-into-epic patch never arrived");
          }
          // The embedded array (a decoded `Task[]` on the wire) carries the task
          // with its flipped worker-phase. Schema v19: the legacy `status` blob
          // field is read defensively (`worker_phase ?? status`) by the reducer
          // for re-fold determinism across the v18→v19 boundary, so a pre-v19
          // shape with `status: "done"` lands as `worker_phase: "done"`.
          const embedded = taskPatch.row.tasks as {
            task_id: string;
            worker_phase: string;
          }[];
          expect(Array.isArray(embedded)).toBe(true);
          const folded = embedded.find((t) => t.task_id === taskId);
          expect(folded?.worker_phase).toBe("done");

          // --- deletion retraction: a TaskDeleted tombstone splices the element
          // out of the parent epic's array; the epic patches with `tasks` empty.
          // Inserted directly (same as the snapshots above) to test the
          // event→fold→UDS-patch chain without FSEvents delivery timing. ---
          const epicEventIdAfterTaskPatch = taskPatch.row
            .last_event_id as number;
          const { db: delTaskWriter, stmts: delTaskStmts } = openDb(dbPath);
          delTaskStmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: taskId,
            $pid: null,
            $hook_event: "TaskDeleted",
            $event_type: "plan_snapshot",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({ epic_id: epicId }),
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
          });
          delTaskWriter.close();

          const taskDeletePatch = await retryUntil(
            () =>
              client.frames.find(
                (f) =>
                  f.type === "patch" &&
                  f.collection === "epics" &&
                  f.row.epic_id === epicId &&
                  (f.row.last_event_id as number) > epicEventIdAfterTaskPatch,
              ) ?? null,
            8000,
          );
          if (!taskDeletePatch || taskDeletePatch.type !== "patch") {
            throw new Error("task-delete patch never arrived");
          }
          const afterDelete = taskDeletePatch.row.tasks as {
            task_id: string;
          }[];
          expect(Array.isArray(afterDelete)).toBe(true);
          expect(afterDelete.some((t) => t.task_id === taskId)).toBe(false);

          // --- an EpicDeleted tombstone removes the epic row; it leaves the page.
          const { db: delEpicWriter, stmts: delEpicStmts } = openDb(dbPath);
          delEpicStmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: epicId,
            $pid: null,
            $hook_event: "EpicDeleted",
            $event_type: "plan_snapshot",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: "",
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
          });
          delEpicWriter.close();

          const epicGone = await retryUntil(() => {
            const row = reader
              .query("SELECT epic_id FROM epics WHERE epic_id = ?")
              .get(epicId) as { epic_id: string } | null;
            return row == null ? true : null;
          }, 8000);
          if (!epicGone) {
            throw new Error("epic row never deleted");
          }
        } finally {
          client.socket.end();
        }
      } finally {
        reader.close();
      }
    },
    // fn-749: this is the ONE migrated test that boots the `plan` worker — it
    // proves a partial set still satisfies a watcher-driven assertion. The plan
    // worker's `disableNativeWatcher` degrade runs its boot scan per root, so
    // the pre-committed plan files emit synthetic snapshots; `wake` pumps the
    // fold on MAIN and `server` serves the resulting epics/tasks rows.
    { env: { KEEPER_CONFIG: configPath }, workers: ["wake", "server", "plan"] },
  );
}, 30000);

test("end-to-end: downtime file deletion is reconciled on restart via the boot sweep", async () => {
  // Two epics under the configured plan root: `survivor` keeps its epic file but
  // LOSES one of its two task files during downtime; `gone` loses its epic file
  // AND its task file. After a restart with no live onDelete, the boot sweep
  // must retract exactly the deleted ids and leave the survivors intact.
  const repo = join(planRoot, "repo");
  const survivorEpic = "fn-10-survivor";
  const goneEpic = "fn-11-gone";
  const keepTask = `${survivorEpic}.1`;
  const dropTask = `${survivorEpic}.2`;
  const goneTask = `${goneEpic}.1`;

  const epicsDir = join(planRoot, ".planctl", "epics");
  const tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  const survivorEpicFile = join(epicsDir, `${survivorEpic}.json`);
  const goneEpicFile = join(epicsDir, `${goneEpic}.json`);
  const keepTaskFile = join(tasksDir, `${keepTask}.json`);
  const dropTaskFile = join(tasksDir, `${dropTask}.json`);
  const goneTaskFile = join(tasksDir, `${goneTask}.json`);

  // `primary_repo` (→ epics.project_dir) is INSIDE planRoot so the sweep scopes
  // these epics in. Write all files BEFORE the first boot (boot scan folds them).
  writeFileSync(
    survivorEpicFile,
    JSON.stringify({
      id: survivorEpic,
      title: "Survivor",
      status: "open",
      primary_repo: repo,
    }),
  );
  writeFileSync(
    goneEpicFile,
    JSON.stringify({
      id: goneEpic,
      title: "Gone",
      status: "open",
      primary_repo: repo,
    }),
  );
  writeFileSync(
    keepTaskFile,
    JSON.stringify({
      id: keepTask,
      epic: survivorEpic,
      title: "Keep",
      target_repo: repo,
    }),
  );
  writeFileSync(
    dropTaskFile,
    JSON.stringify({
      id: dropTask,
      epic: survivorEpic,
      title: "Drop",
      target_repo: repo,
    }),
  );
  writeFileSync(
    goneTaskFile,
    JSON.stringify({
      id: goneTask,
      epic: goneEpic,
      title: "GoneTask",
      target_repo: repo,
    }),
  );

  // fn-629 observation gate: plan-worker only emits snapshots for files in
  // git HEAD. Init + commit the plan tree before the first boot — the
  // boot sweep folds the committed files, and the second boot's downtime
  // delete + sweep retraction is unaffected by the gate (onDelete is
  // ungated; the boot sweep diffs the projection against disk, not git).
  gitInitPlanRoot(planRoot);
  gitCommitPlanRoot(planRoot, "add survivor + gone");

  const spawnDaemon = (): Subprocess<"ignore", "pipe", "pipe"> =>
    Bun.spawn(["bun", "run", DAEMON_ENTRY], {
      cwd: ROOT,
      env: daemonSpawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });

  // --- First boot: fold all plan files into the projection. ---
  daemon = spawnDaemon();
  const bound = await retryUntil(
    () => (existsSync(sockPath) ? true : null),
    3000,
  );
  if (!bound) {
    const err = await readStream(daemon.stderr);
    throw new Error(`socket never bound (first boot).\nstderr:\n${err}`);
  }

  let reader = openDb(dbPath, { readonly: true }).db;
  try {
    // Both epics present, survivor carries TWO embedded tasks.
    const folded = await retryUntil(() => {
      const rows = reader
        .query("SELECT epic_id, tasks FROM epics ORDER BY epic_id ASC")
        .all() as { epic_id: string; tasks: string | null }[];
      if (rows.length < 2) {
        return null;
      }
      const surv = rows.find((r) => r.epic_id === survivorEpic);
      const survTasks = surv?.tasks ? JSON.parse(surv.tasks) : [];
      return survTasks.length === 2 ? rows : null;
    }, 8000);
    if (!folded) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `plan files never folded.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
  } finally {
    reader.close();
  }

  // --- Downtime: stop the daemon, then delete files (no live onDelete). ---
  daemon.kill("SIGTERM");
  expect(await daemon.exited).toBe(0);
  for (const p of [sockPath, `${sockPath}.lock`]) {
    if (existsSync(p)) {
      unlinkSync(p);
    }
  }
  unlinkSync(dropTaskFile); // survivor loses one task
  unlinkSync(goneEpicFile); // gone epic's file removed
  unlinkSync(goneTaskFile); // gone epic's task removed

  // --- Restart: the boot sweep reconciles the projection to disk. ---
  daemon = spawnDaemon();
  const reBound = await retryUntil(
    () => (existsSync(sockPath) ? true : null),
    3000,
  );
  if (!reBound) {
    const err = await readStream(daemon.stderr);
    throw new Error(`socket never bound (restart).\nstderr:\n${err}`);
  }

  reader = openDb(dbPath, { readonly: true }).db;
  try {
    // The gone epic row is removed; the survivor keeps exactly the kept task.
    const reconciled = await retryUntil(() => {
      const goneRow = reader
        .query("SELECT epic_id FROM epics WHERE epic_id = ?")
        .get(goneEpic) as { epic_id: string } | null;
      if (goneRow != null) {
        return null; // gone epic not yet retracted
      }
      const survRow = reader
        .query("SELECT tasks FROM epics WHERE epic_id = ?")
        .get(survivorEpic) as { tasks: string | null } | null;
      if (survRow == null) {
        return null;
      }
      const tasks = survRow.tasks
        ? (JSON.parse(survRow.tasks) as { task_id: string }[])
        : [];
      // Survivor keeps the kept task and has dropped the deleted one.
      const hasKeep = tasks.some((t) => t.task_id === keepTask);
      const hasDrop = tasks.some((t) => t.task_id === dropTask);
      return hasKeep && !hasDrop ? { tasks } : null;
    }, 10000);
    if (!reconciled) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `projection never reconciled after restart.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    // The retraction rode the SAME synthetic tombstone events as a live delete.
    const tombstones = reader
      .query(
        "SELECT session_id, hook_event FROM events WHERE hook_event IN ('EpicDeleted', 'TaskDeleted') ORDER BY id ASC",
      )
      .all() as { session_id: string; hook_event: string }[];
    expect(tombstones).toContainEqual({
      session_id: goneEpic,
      hook_event: "EpicDeleted",
    });
    expect(tombstones).toContainEqual({
      session_id: dropTask,
      hook_event: "TaskDeleted",
    });
    expect(tombstones).toContainEqual({
      session_id: goneTask,
      hook_event: "TaskDeleted",
    });
  } finally {
    reader.close();
  }

  daemon.kill("SIGTERM");
  expect(await daemon.exited).toBe(0);
}, 40000);

test("end-to-end: exit-watcher folds a SIGKILL'd victim to killed within 2s; SessionStart resume re-opens", async () => {
  // The Killed match in main requires (pid, start_time) to align with what the
  // jobs row persists. The hook stamps `events.pid = process.ppid` and (on
  // SessionStart only) `events.start_time = <scrape of process.ppid>`, so the
  // VICTIM must be the hook's PARENT process — only then do jobs.pid +
  // jobs.start_time describe a process we can SIGKILL and observe via the
  // exit-watcher.
  //
  // Pattern (mirrors test/events-writer.test.ts): write a tiny launcher script
  // into the tmpdir; spawn IT; once it has spawned the hook on stdin and that
  // hook has returned (committing the SessionStart row), keep the launcher
  // alive forever so SIGKILL targets a real, watchable pid.
  const sessionId = "sess-victim";
  const launcherPath = join(tmpDir, "victim-launcher.ts");
  writeFileSync(
    launcherPath,
    `
const HOOK = ${JSON.stringify(HOOK_ENTRY)};
const payload = JSON.stringify(${JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: "/tmp/work",
      permission_mode: "default",
    })});
// Spawn the hook so this launcher IS its parent (process.ppid). Wait for it
// to commit, then park forever so the test can SIGKILL us at a deterministic
// moment.
const proc = Bun.spawn(["bun", HOOK], {
  env: { ...process.env },
  stdin: new TextEncoder().encode(payload),
  stdout: "inherit",
  stderr: "inherit",
});
await proc.exited;
// Tell the test we're ready (the hook row is committed) via a single stdout
// line, then park. The launcher's pid is what jobs.pid will hold.
process.stdout.write("READY\\n");
// Park on a long-running keep-alive timer rather than \`await new Promise(() => {})\`.
// A bare never-resolving promise in Bun keeps the event loop pinned at
// ~100% CPU when there's no I/O — observed in the wild as multi-day leaked
// launchers saturating cores. A pending timer holds the loop cheaply
// (event loop sleeps until the next due timer; we set it to ~24.8d so it
// never fires in practice). The test SIGKILLs us long before then.
await new Promise(() => {
  setTimeout(() => {}, 2_147_483_647);
});
`,
  );

  daemon = Bun.spawn(["bun", "run", DAEMON_ENTRY], {
    cwd: ROOT,
    env: daemonSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  // Boot drain + spawn all five workers + bind the socket.
  const bound = await retryUntil(
    () => (existsSync(sockPath) ? true : null),
    3000,
  );
  if (!bound) {
    const err = await readStream(daemon.stderr);
    throw new Error(`socket never bound.\nstderr:\n${err}`);
  }

  // Spawn the victim launcher. Its pid is the hook's process.ppid, so
  // events.pid + events.start_time describe it. The launcher's own inner
  // hook spawn uses `env: { ...process.env }`, so the sandboxed state-path
  // overrides propagate down one level to the hook process (fn-657).
  //
  // `detached: true` puts the launcher in its own process group so a
  // negative-pid SIGKILL in `afterEach` reaps the whole tree (launcher +
  // any in-flight grandchild hook) if this test throws before its
  // happy-path teardown — see the `victimLaunchers` registry above.
  const victim = Bun.spawn(["bun", "run", launcherPath], {
    cwd: ROOT,
    env: sandboxedBaseEnv(),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  victimLaunchers.push(victim);
  const victimPid = victim.pid;

  // Wait for the launcher's "READY" line — the hook's SessionStart row has
  // committed by the time it prints. The launcher then parks forever.
  const victimStdout = victim.stdout;
  let readyLine = "";
  const decoder = new TextDecoder();
  if (victimStdout) {
    const r = victimStdout.getReader();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await r.read();
      if (done) break;
      readyLine += decoder.decode(value);
      if (readyLine.includes("READY")) {
        break;
      }
    }
    // Release the reader so the launcher's stdout buffer doesn't fill up.
    try {
      r.releaseLock();
    } catch {
      // best-effort
    }
  }
  expect(readyLine).toContain("READY");

  const { db: reader } = openDb(dbPath, { readonly: true });
  try {
    // The SessionStart row folds the job to its non-terminal seed state
    // (`stopped` per the schema default), carrying our victim pid + start_time.
    const projected = await retryUntil(() => {
      const row = reader
        .query("SELECT pid, start_time, state FROM jobs WHERE job_id = ?")
        .get(sessionId) as {
        pid: number | null;
        start_time: string | null;
        state: string;
      } | null;
      return row && row.pid === victimPid ? row : null;
    });
    if (!projected) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `victim job never projected.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    // Non-terminal — alive enough for the exit-watcher to register.
    expect(["working", "stopped"]).toContain(projected.state);
    expect(projected.pid).toBe(victimPid);

    // --- SIGKILL the victim → exit-watcher detects, posts to main, main
    //     folds Killed. The whole loop must complete within 2s. ---
    victim.kill("SIGKILL");
    await victim.exited;

    const killed = await retryUntil(
      () => {
        const row = reader
          .query("SELECT state FROM jobs WHERE job_id = ?")
          .get(sessionId) as { state: string } | null;
        return row && row.state === "killed" ? row : null;
      },
      2500,
      50,
    );
    if (!killed) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `victim row never folded to killed.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    expect(killed.state).toBe("killed");

    // The synthetic Killed event landed in the events log.
    const killedEventCount = (
      reader
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = ?",
        )
        .get(sessionId) as { n: number }
    ).n;
    expect(killedEventCount).toBeGreaterThanOrEqual(1);

    // --- Resume: fire a fresh SessionStart for the same session_id. The
    //     reducer's ON CONFLICT branch re-opens 'killed' → 'stopped' and
    //     refreshes pid + start_time. We don't need a live victim for the
    //     resume — we just need the SessionStart event to fold. ---
    await fireHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: "/tmp/work",
      permission_mode: "default",
    });

    const reopened = await retryUntil(() => {
      const row = reader
        .query("SELECT state FROM jobs WHERE job_id = ?")
        .get(sessionId) as { state: string } | null;
      return row && row.state !== "killed" ? row : null;
    }, 3000);
    if (!reopened) {
      const out = await readStream(daemon.stdout);
      const err = await readStream(daemon.stderr);
      throw new Error(
        `victim row never re-opened from killed.\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    // SessionStart re-opens a terminal row to 'stopped' (the resume seed).
    expect(reopened.state).toBe("stopped");
  } finally {
    reader.close();
  }

  daemon.kill("SIGTERM");
  expect(await daemon.exited).toBe(0);
}, 30000);

test("fn-684.4: keeper source carries NO `start-or-reload-plugin` argv (the retired keeper-side per-session-load mechanism stays retired)", async () => {
  // The original task .4 plan had keeper imperatively load the plugin into
  // each session via `zellij action start-or-reload-plugin` and seed
  // `~/.cache/zellij/permissions.kdl` from the daemon. That mechanism was
  // RETIRED — the plugin is now loaded GLOBALLY by the human's dotfiles
  // `config.kdl` `load_plugins` block, so keeper owns NEITHER the load nor
  // the permission seed. This test is a regression guard: scan every
  // production source file under src/ for the retired argv literals and
  // fail loud if they reappear. (Comments referencing the contract are
  // allowed and helpful; the assertion is scoped to .ts source under src/.)
  //
  // Bun's filesystem reads from the same import.meta.dir-rooted ROOT the
  // daemon spawn uses above.
  const { Glob } = await import("bun");
  const glob = new Glob("**/*.ts");
  const srcDir = join(ROOT, "src");
  const offenders: Array<{ path: string; line: number; text: string }> = [];
  for await (const rel of glob.scan({ cwd: srcDir })) {
    const abs = join(srcDir, rel);
    const text = await Bun.file(abs).text();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      // A line that mentions the argv literal AND is not a comment
      // discussing its retirement is a regression. The simple rule: if
      // the line contains the literal `start-or-reload-plugin` AND does
      // NOT start (after trim) with `*` or `//`, treat it as code.
      if (line.includes("start-or-reload-plugin")) {
        const trimmed = line.trimStart();
        const isComment = trimmed.startsWith("//") || trimmed.startsWith("*");
        if (!isComment) {
          offenders.push({ path: rel, line: i + 1, text: line });
        }
      }
    }
  }
  expect(offenders).toEqual([]);
}, 5000);

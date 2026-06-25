/**
 * End-to-end integration smoke. Exercises the FULL daemon path — DB commit
 * (data_version bump) → wake worker → main-thread drain → projection → UDS
 * subscribe/RPC — via the in-process daemon harness (`withInProcessDaemon`),
 * which boots the real worker fleet against a sandboxed DB but inside the test
 * process. Events are injected straight into the sandboxed DB on a second
 * writer connection (`injectLifecycleEvent`), the in-process analogue of a
 * hook-sourced events-log row; the wake worker's `PRAGMA data_version` poll
 * sees the cross-connection commit and drains it through main's reducer.
 *
 * The OS-coupled subprocess-daemon variants (real `bun run src/daemon.ts` boot,
 * the spawned hook, live FSEvents transcript-tail, real SIGKILL exit-watcher
 * stitch) were deleted in fn-752 — their keeper-logic seams are unit-tested in
 * the fast tier (reducer folds, transcript `scanFile`/`scanJobsForTitles`,
 * PlanScanner sweep, events-writer hook append, exit-watcher FFI), and the OS
 * layer itself is the backstop of continuous dogfooding, not a test target.
 *
 * Timing discipline: the wake worker polls `PRAGMA data_version` and the
 * reducer drains asynchronously, so every assertion uses `retryUntil` (bounded
 * poll) rather than a fixed sleep.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { epicNumberFromId, taskNumberFromId } from "../src/plan-worker";
import { encodeFrame, LineBuffer, type ServerFrame } from "../src/protocol";
import { withInProcessDaemon } from "./helpers/in-process-daemon";
import { retryUntil } from "./helpers/retry-until";

/** Repo root — this file lives at <root>/test, so one level up. */
const ROOT = join(import.meta.dir, "..");

let tmpDir: string;
let planRoot: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-integration-test-"));
  // The in-process daemon harness mints its OWN sandboxed db/socket/tmp paths
  // and hands them to the test body — this `tmpDir` only roots the plan-worker
  // survivor's hermetic plan root + config YAML.
  //
  // Hermetic plan root for the plan-worker e2e — a tmp dir the daemon watches
  // for `.keeper/{epics,tasks}/*.json` instead of the real `~/code`, resolved
  // via the `KEEPER_CONFIG` YAML the survivor passes to the harness so the
  // watcher can never touch the real `~/code`/`~/src` trees.
  planRoot = join(tmpDir, "plan-root");
  mkdirSync(planRoot, { recursive: true });
  configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, `roots:\n  - ${JSON.stringify(planRoot)}\n`);
});

afterEach(() => {
  // The in-process daemon harness owns daemon/worker lifecycle (and its own
  // sandboxed db/socket paths), tearing them down before returning — so there's
  // nothing to reap here beyond rm-ing this file's own plan-root tmpdir.
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * fn-629 observation-gate helper: initialize a git repo in `dir` (so HEAD
 * resolves) with one empty commit. The plan-worker's fn-629 gate suppresses
 * snapshot emission for any `.keeper/*.json` not in HEAD — every
 * integration test that pre-writes plan files (mimicking what plan
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
 * fn-629 observation-gate helper: stage + commit every `.keeper/*.json`
 * already present in `dir`, so the plan-worker's `isPathInHead` predicate
 * passes them through the gate. Mirrors what `keeper plan` does at the
 * `output.emit()` seam (commits the tree before the envelope returns) —
 * the keeper-side gate trusts that contract.
 */
function gitCommitPlanRoot(dir: string, message: string = "plan files"): void {
  for (const args of [
    ["add", ".keeper"],
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
 * fn-747: inject one lifecycle event straight into the sandboxed DB via a
 * SECOND writer connection — the in-process-daemon analogue of a hook-sourced
 * events-log row. The daemon's wake worker polls `PRAGMA data_version`, sees
 * the cross-connection commit, and drains it through main's reducer exactly as
 * the events-log ingester would once main lands the row (mirrors the keystone
 * in daemon.test.ts). The OS-coupled real-subprocess-hook variant was deleted
 * in fn-752; the hook's own append path is unit-tested in events-writer.test.ts.
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
  // subprocess concern (now exercised only by dogfooding, per fn-752); here we
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

test("end-to-end: request_handoff routes a >8KB doc via a spill file → daemon inlines it into the event → handoffs projection carries the full doc", async () => {
  // The handoff doc (up to 64KB) overflows the ~8 KiB UDS send buffer when inlined
  // in the frame, so the CLI spills it to a file and sends only `doc_path`. Drive
  // the full board→server→main path with a raw RPC frame (bypassing the CLI guard)
  // pointing at a >8KB spill file, and assert the daemon reads it back and inlines
  // the FULL doc into the event — so `handoffs.doc` is byte-identical to the spill.
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      const handoffId = "hr-e2e-1";
      // 40KB — comfortably past the send-buffer boundary that hung the inline path,
      // but under the 64KB cap.
      const bigDoc = "Z".repeat(40 * 1024);
      const spillPath = join(tmpDir, `${handoffId}.txt`);
      writeFileSync(spillPath, bigDoc, "utf8");

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
              close() {},
              error(_s, err) {
                reject(err);
              },
            },
          }).catch(reject);
        });
      }

      // Enqueue: small wire frame (carries the PATH), big doc rides the file.
      const ack = (await rpc("request_handoff", {
        handoff_id: handoffId,
        doc_path: spillPath,
        title: "big brief",
        target_session: "work",
      })) as { ok: boolean; handoff_id: string };
      expect(ack).toEqual({ ok: true, handoff_id: handoffId });

      // Durability: the daemon inlined the FULL doc into the event, so the
      // `handoffs` projection row carries it byte-identically.
      const row = await retryUntil(() => {
        const { db } = openDb(dbPath, { readonly: true });
        try {
          return (
            (db
              .query("SELECT doc, status FROM handoffs WHERE handoff_id = ?")
              .get(handoffId) as { doc: string; status: string } | null) ?? null
          );
        } finally {
          db.close();
        }
      }, 3000);
      expect(row).not.toBeNull();
      expect(row?.doc).toBe(bigDoc);
      expect(row?.status).toBe("requested");

      // Loud-fail: a missing spill path is an `ok:false` rpc error, never a hang.
      try {
        await rpc("request_handoff", {
          handoff_id: "hr-e2e-missing",
          doc_path: join(tmpDir, "does-not-exist.txt"),
          target_session: "work",
        });
        throw new Error("expected a loud failure for a missing spill file");
      } catch (e) {
        expect(String(e)).toMatch(/cannot read handoff spill file|rpc_failed/);
      }
    },
    { workers: ["wake", "server"] },
  );
}, 30000);

test("end-to-end: plan worker → .keeper write → synthetic event → fold → epics/tasks projection + UDS subscribe", async () => {
  const epicId = "fn-9-keeper-e2e-plans";
  const taskId = `${epicId}.1`;

  // Point the daemon's plan worker at a hermetic tmp root via a tmp config YAML
  // (KEEPER_CONFIG override) so the watcher never touches the real ~/code/~/src.
  writeFileSync(configPath, `roots:\n  - ${JSON.stringify(planRoot)}\n`);
  const epicsDir = join(planRoot, ".keeper", "epics");
  const tasksDir = join(planRoot, ".keeper", "tasks");
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
      // plan epic statuses are open|done (EPIC_STATUSES); "open" keeps it in
      // the epics collection's default scope so the unfiltered subscribe sees it.
      status: "open",
      primary_repo: "/tmp/keeper-e2e-repo",
      // fn-756 stripped the `approval` surface and fn-759 deleted the boot-time
      // approval backfill, so this field is inert here — kept as a harmless
      // explicit value so the fixture stays a faithful plan-file shape.
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
  // any .keeper/*.json not yet in git HEAD. Mirror the plan
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
          // worker-phase binary) to free up `runtime_status` (plan-native
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
        // when the task has no `.keeper/state/tasks/<id>.state.json` sidecar.
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

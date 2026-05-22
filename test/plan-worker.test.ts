/**
 * Plan-worker tests, in three layers (mirrors transcript-worker.test.ts):
 *
 * (a) DETERMINISM unit tests against the PURE `PlanScanner` core — no Worker, no
 *     watcher, just files + `onChange`. Cover the path classifier, number-parse
 *     edge cases, task-status derivation, the change-gate (unchanged snapshot
 *     suppressed, a real change re-emits), safe-parse skips (malformed JSON,
 *     oversize, missing-id, read-vs-delete race), the restart-seed suppressing a
 *     redundant re-emit, and onDelete dropping the change-gate.
 * (b) A SMOKE test that `@parcel/watcher`'s native addon loads + fires under
 *     `bun test` (the keystone CI risk — N-API load failure is a hard dyld
 *     crash, not catchable).
 * (c) A real spawned Worker that shuts down cleanly on `{ type: "shutdown" }`
 *     across MULTIPLE roots (the subsystem teardown — every watcher unsubscribe
 *     must let the thread exit).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  buildEpicMessage,
  buildTaskMessage,
  classifyPlanPath,
  epicNumberFromId,
  type PlanMessage,
  PlanScanner,
  seedFromDb,
  taskNumberFromId,
} from "../src/plan-worker";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-plan-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Make a `.planctl/<dir>` tree under tmpDir and return the dir path. */
function planctlDir(kind: "epics" | "tasks"): string {
  const dir = join(tmpDir, ".planctl", kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an epic JSON file and return its path. */
function writeEpic(id: string, body: Record<string, unknown>): string {
  const path = join(planctlDir("epics"), `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

/** Write a task JSON file and return its path. */
function writeTask(id: string, body: Record<string, unknown>): string {
  const path = join(planctlDir("tasks"), `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — path classifier + number parse
// ---------------------------------------------------------------------------

test("classifyPlanPath: epics/tasks json under .planctl, else null", () => {
  expect(classifyPlanPath("/a/b/.planctl/epics/fn-1-x.json")).toBe("epic");
  expect(classifyPlanPath("/a/b/.planctl/tasks/fn-1-x.2.json")).toBe("task");
  // Wrong subdir, wrong extension, not under .planctl, deeper nesting all reject.
  expect(classifyPlanPath("/a/.planctl/specs/fn-1-x.md")).toBeNull();
  expect(classifyPlanPath("/a/.planctl/epics/fn-1-x.md")).toBeNull();
  expect(classifyPlanPath("/a/epics/fn-1-x.json")).toBeNull();
  expect(classifyPlanPath("/a/.planctl/epics/sub/fn-1-x.json")).toBeNull();
});

test("epicNumberFromId / taskNumberFromId: parse + null on no match", () => {
  expect(epicNumberFromId("fn-558-keeper-plans")).toBe(558);
  expect(epicNumberFromId("fn-1-x")).toBe(1);
  expect(epicNumberFromId("no-number-here")).toBeNull();
  expect(taskNumberFromId("fn-558-keeper-plans.3")).toBe(3);
  expect(taskNumberFromId("fn-1-x.12")).toBe(12);
  expect(taskNumberFromId("fn-1-x")).toBeNull();
});

test("buildTaskMessage derives status from worker_done_at", () => {
  const open = buildTaskMessage({ id: "fn-1-x.1" });
  expect(open?.status).toBe("open");
  const done = buildTaskMessage({
    id: "fn-1-x.2",
    worker_done_at: "2026-05-22T00:00:00Z",
  });
  expect(done?.status).toBe("done");
  // No id → null (can't key the projection).
  expect(buildTaskMessage({})).toBeNull();
});

test("buildEpicMessage maps primary_repo → projectDir, parses number", () => {
  const msg = buildEpicMessage({
    id: "fn-558-x",
    title: "T",
    status: "open",
    primary_repo: "/Users/mike/code/keeper",
  });
  expect(msg).toEqual({
    kind: "plan-epic",
    id: "fn-558-x",
    number: 558,
    title: "T",
    projectDir: "/Users/mike/code/keeper",
    status: "open",
  });
  expect(buildEpicMessage({})).toBeNull();
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — onChange over real tmp files
// ---------------------------------------------------------------------------

test("onChange emits an epic snapshot then change-gates an identical re-scan", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });

  scanner.onChange(path);
  expect(emitted).toEqual([
    {
      kind: "plan-epic",
      id: "fn-3-demo",
      number: 3,
      title: "Demo",
      projectDir: "/repo",
      status: "open",
    },
  ]);

  // An identical re-scan is suppressed by the change-gate.
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // A real change (status flips) re-emits.
  writeFileSync(
    path,
    JSON.stringify({
      id: "fn-3-demo",
      title: "Demo",
      status: "done",
      primary_repo: "/repo",
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
  expect((emitted[1] as { status: string }).status).toBe("done");
});

test("onChange emits a task snapshot with derived status + epicId", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeTask("fn-3-demo.2", {
    epic: "fn-3-demo",
    title: "Subtask",
    target_repo: "/repo",
  });
  scanner.onChange(path);
  expect(emitted).toEqual([
    {
      kind: "plan-task",
      id: "fn-3-demo.2",
      epicId: "fn-3-demo",
      number: 2,
      title: "Subtask",
      targetRepo: "/repo",
      status: "open",
    },
  ]);
});

test("malformed JSON skips-and-logs without emitting", () => {
  const emitted: PlanMessage[] = [];
  const logs: string[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );

  const path = join(planctlDir("epics"), "fn-9-bad.json");
  writeFileSync(path, "{ not json");
  scanner.onChange(path);

  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("malformed JSON"))).toBe(true);
});

test("a non-.planctl path is a no-op (classifier rejects)", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = join(tmpDir, "random.json");
  writeFileSync(path, JSON.stringify({ id: "fn-1-x" }));
  scanner.onChange(path);
  expect(emitted).toEqual([]);
});

test("a vanished file (read-vs-delete race) skips-and-logs, no emit", () => {
  const emitted: PlanMessage[] = [];
  const logs: string[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );

  // A path under a real .planctl/epics dir that does not exist on disk → the
  // stat fails (the race), skip-and-log.
  const path = join(planctlDir("epics"), "fn-7-gone.json");
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("stat failed"))).toBe(true);
});

test("onDelete drops the change-gate so a re-created file re-emits", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeTask("fn-3-demo.1", { epic: "fn-3-demo", title: "T" });
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Delete drops tracking (no emit).
  scanner.onDelete(path);
  expect(emitted.length).toBe(1);

  // The same content re-arriving now re-emits (change-gate was cleared).
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
});

test("seedFromDb suppresses a re-emit of an already-folded projection row", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // Insert a row matching exactly what a scan of the file would produce.
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["fn-3-demo", 3, "Demo", "/repo", "open", 1, 0],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  db.close();

  // A file byte-identical to the seeded row is suppressed.
  const path = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });
  scanner.onChange(path);
  expect(emitted).toEqual([]);

  // A genuinely changed file still emits.
  writeFileSync(
    path,
    JSON.stringify({
      id: "fn-3-demo",
      title: "Demo",
      status: "done",
      primary_repo: "/repo",
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { status: string }).status).toBe("done");
});

// ---------------------------------------------------------------------------
// (b) Native addon smoke test
// ---------------------------------------------------------------------------

test("smoke: @parcel/watcher loads + fires a create event under bun test", async () => {
  const watcher = await import("@parcel/watcher");
  expect(typeof watcher.subscribe).toBe("function");

  const fired: string[] = [];
  const sub = await watcher.subscribe(tmpDir, (err, events) => {
    if (err) {
      return;
    }
    for (const ev of events) {
      fired.push(ev.path);
    }
  });

  try {
    const dir = join(tmpDir, ".planctl", "epics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fn-1-x.json"),
      JSON.stringify({ id: "fn-1-x", title: "T" }),
    );

    const deadline = Date.now() + 3000;
    while (fired.length === 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(fired.length).toBeGreaterThanOrEqual(1);
  } finally {
    await sub.unsubscribe();
  }
});

// ---------------------------------------------------------------------------
// (c) Real spawned Worker — clean shutdown across multiple roots
// ---------------------------------------------------------------------------

test("spawned Worker shuts down cleanly on shutdown message", async () => {
  const dbPath = join(tmpDir, "keeper.db");
  // Bootstrap the schema with a writer so the worker's read-only open succeeds.
  openDb(dbPath).db.close();

  // Two roots, exercising the per-root subscription array + teardown.
  const rootA = join(tmpDir, "rootA");
  const rootB = join(tmpDir, "rootB");
  mkdirSync(rootA);
  mkdirSync(rootB);

  const worker = new Worker(
    new URL("../src/plan-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath, roots: [rootA, rootB] },
    } as WorkerOptions & { workerData: unknown },
  );

  const exited = new Promise<void>((resolve) => {
    worker.addEventListener("close", () => resolve());
  });

  // Let it boot, open its connection, and subscribe both roots.
  await Bun.sleep(200);
  worker.postMessage({ type: "shutdown" });

  const result = await Promise.race([
    exited.then(() => "exited" as const),
    Bun.sleep(3000).then(() => "timeout" as const),
  ]);

  expect(result).toBe("exited");
});

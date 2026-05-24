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
  isWithinRoots,
  type PlanMessage,
  PlanScanner,
  scanRoot,
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
    // Missing `approval` defaults silently to "pending" (forward-compat with
    // files written by old planctl that predate the field).
    approval: "pending",
    dependsOnEpics: [],
    // Missing `last_validated_at` (schema v16) collapses to null via asString.
    lastValidatedAt: null,
  });
  expect(buildEpicMessage({})).toBeNull();
});

test("buildEpicMessage extracts depends_on_epics; non-array/garbage → []", () => {
  expect(
    buildEpicMessage({
      id: "fn-9-x",
      depends_on_epics: ["fn-3-a", "fn-5-b"],
    })?.dependsOnEpics,
  ).toEqual(["fn-3-a", "fn-5-b"]);
  // Non-string elements are dropped; a non-array value yields [].
  expect(
    buildEpicMessage({ id: "fn-9-x", depends_on_epics: ["ok", 7, ""] })
      ?.dependsOnEpics,
  ).toEqual(["ok"]);
  expect(
    buildEpicMessage({ id: "fn-9-x", depends_on_epics: "fn-3-a" })
      ?.dependsOnEpics,
  ).toEqual([]);
});

test("buildTaskMessage extracts depends_on; non-array → []", () => {
  expect(
    buildTaskMessage({
      id: "fn-9-x.3",
      epic: "fn-9-x",
      depends_on: ["fn-9-x.1", "fn-9-x.2"],
    })?.dependsOn,
  ).toEqual(["fn-9-x.1", "fn-9-x.2"]);
  expect(
    buildTaskMessage({ id: "fn-9-x.3", depends_on: null })?.dependsOn,
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// (a.approval) Approval coercion — schema v13 (fn-592-approval-as-planctl-field)
// ---------------------------------------------------------------------------

test("buildEpicMessage: valid approval enum passes through verbatim", () => {
  for (const v of ["approved", "rejected", "pending"] as const) {
    expect(buildEpicMessage({ id: "fn-9-x", approval: v })?.approval).toBe(v);
  }
});

test("buildTaskMessage: valid approval enum passes through verbatim", () => {
  for (const v of ["approved", "rejected", "pending"] as const) {
    expect(buildTaskMessage({ id: "fn-9-x.1", approval: v })?.approval).toBe(v);
  }
});

test("buildEpicMessage / buildTaskMessage default missing approval to 'pending' SILENTLY (no log)", () => {
  // Missing field is the forward-compat path — files written by old planctl
  // simply omit it. The default must not log (would spam stderr on every
  // legacy scan).
  const logs: string[] = [];
  const epic = buildEpicMessage({ id: "fn-9-x" }, (l) => logs.push(l));
  expect(epic?.approval).toBe("pending");
  const task = buildTaskMessage({ id: "fn-9-x.1" }, (l) => logs.push(l));
  expect(task?.approval).toBe("pending");
  expect(logs).toEqual([]);
});

test("buildEpicMessage coerces an invalid approval value to 'pending' with a stderr log", () => {
  const logs: string[] = [];
  const msg = buildEpicMessage(
    { id: "fn-9-x", approval: "approvedd" }, // typo
    (l) => logs.push(l),
  );
  expect(msg?.approval).toBe("pending");
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("invalid approval value on epic fn-9-x");
  expect(logs[0]).toContain('"approvedd"');
  expect(logs[0]).toContain('coercing to "pending"');
});

test("buildTaskMessage coerces an invalid approval value (wrong type) to 'pending' with a stderr log", () => {
  const logs: string[] = [];
  const msg = buildTaskMessage(
    { id: "fn-9-x.1", approval: 42 }, // number, not the enum
    (l) => logs.push(l),
  );
  expect(msg?.approval).toBe("pending");
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("invalid approval value on task fn-9-x.1");
  expect(logs[0]).toContain("42");
});

test("PlanScanner.onChange routes invalid approval log through its `log` sink", () => {
  // End-to-end: the scanner's per-instance logger receives the coercion log,
  // proving the build* signature change is wired into the actual scan path.
  const emitted: PlanMessage[] = [];
  const logs: string[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  const path = writeEpic("fn-9-x", {
    title: "Demo",
    status: "open",
    approval: "approvedd", // typo
  });
  scanner.onChange(path);
  // The snapshot still emits — approval safe-falls to "pending".
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { approval: string }).approval).toBe("pending");
  // The scanner's log captured the coercion notice.
  expect(logs.some((l) => l.includes("invalid approval value on epic"))).toBe(
    true,
  );
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
      approval: "pending",
      dependsOnEpics: [],
      lastValidatedAt: null,
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
      approval: "pending",
      dependsOn: [],
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

test("onDelete emits a task tombstone with recovered epicId, then re-created file re-emits", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeTask("fn-3-demo.1", { epic: "fn-3-demo", title: "T" });
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Delete emits a tombstone carrying the epicId recovered from the change-gate.
  scanner.onDelete(path);
  expect(emitted.length).toBe(2);
  expect(emitted[1]).toEqual({
    kind: "plan-task-deleted",
    id: "fn-3-demo.1",
    epicId: "fn-3-demo",
  });

  // The change-gate was cleared, so the same content re-arriving re-emits.
  scanner.onChange(path);
  expect(emitted.length).toBe(3);
  expect((emitted[2] as { kind: string }).kind).toBe("plan-task");
});

test("onDelete emits an epic tombstone for a deleted epic file", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEpic("fn-3-demo", { title: "Demo", status: "open" });
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  scanner.onDelete(path);
  expect(emitted.length).toBe(2);
  expect(emitted[1]).toEqual({ kind: "plan-epic-deleted", id: "fn-3-demo" });
});

test("onDelete on an un-seeded path emits nothing (nothing to retract)", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // Never folded this path → no change-gate entry → no tombstone.
  const path = join(planctlDir("tasks"), "fn-9-never.1.json");
  scanner.onDelete(path);
  expect(emitted).toEqual([]);
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

test("seedFromDb reconstructs from epics.tasks so an embedded task is not re-emitted on restart", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // Seed an epic carrying ONE task in its embedded array — the element shape
  // the reducer folds. `task_number` matches taskNumberFromId("fn-3-demo.1").
  const tasks = JSON.stringify([
    {
      task_id: "fn-3-demo.1",
      epic_id: "fn-3-demo",
      task_number: 1,
      title: "T",
      target_repo: "/repo",
      status: "open",
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["fn-3-demo", 3, "Demo", "/repo", "open", 1, 0, tasks],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  db.close();

  // The task file byte-identical to the embedded element is suppressed.
  const taskPath = writeTask("fn-3-demo.1", {
    epic: "fn-3-demo",
    title: "T",
    target_repo: "/repo",
  });
  scanner.onChange(taskPath);
  expect(emitted).toEqual([]);

  // A genuinely changed task (title flip) still emits.
  writeFileSync(
    taskPath,
    JSON.stringify({
      id: "fn-3-demo.1",
      epic: "fn-3-demo",
      title: "T2",
      target_repo: "/repo",
    }),
  );
  scanner.onChange(taskPath);
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { kind: string; title: string }).kind).toBe(
    "plan-task",
  );
  expect((emitted[0] as { title: string }).title).toBe("T2");
});

test("seedFromDb is jobs-blind: epic.jobs / task.jobs never re-emit on restart", () => {
  // Schema v11 embeds jobs into epics. The change-gate seed signature must
  // EXCLUDE `epic.jobs` AND `task.jobs` — otherwise every plan-file fingerprint
  // changes whenever a job tick fans into the embedded arrays, and the boot
  // scan re-emits a synthetic snapshot for every epic and task on every boot
  // (the worst-case feedback loop documented in the epic's Risks section).
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);

  // Seed an epic carrying BOTH epic-level jobs AND a task whose own embedded
  // jobs sub-array is populated. A jobs-blind seed signature must produce the
  // same fingerprint as the on-disk file (which has NO jobs data).
  const tasks = JSON.stringify([
    {
      task_id: "fn-3-demo.1",
      epic_id: "fn-3-demo",
      task_number: 1,
      title: "T",
      target_repo: "/repo",
      status: "open",
      // Stored task element carries a populated jobs sub-array (live state
      // from a work-verb session that fanned in via the reducer). MUST NOT
      // affect the seed signature.
      jobs: [
        {
          job_id: "work-session-1",
          plan_verb: "work",
          state: "working",
          title: "live work",
          created_at: 1000,
          updated_at: 1000,
          last_event_id: 99,
        },
      ],
    },
  ]);
  const epicJobs = JSON.stringify([
    {
      job_id: "plan-session-1",
      plan_verb: "plan",
      state: "stopped",
      title: "live plan",
      created_at: 500,
      updated_at: 500,
      last_event_id: 7,
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, jobs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["fn-3-demo", 3, "Demo", "/repo", "open", 1, 0, tasks, epicJobs],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  db.close();

  // Now write the on-disk files that match the projection's PLAN-SHAPED
  // content (no jobs sections — plan files never carry jobs). The seed
  // signature must match these byte-for-byte, so neither plan-epic nor
  // plan-task emits.
  const epicPath = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });
  scanner.onChange(epicPath);
  const taskPath = writeTask("fn-3-demo.1", {
    epic: "fn-3-demo",
    title: "T",
    target_repo: "/repo",
  });
  scanner.onChange(taskPath);

  // Both files match — no re-emit. This is the boot-idempotency guarantee:
  // jobs-driven bumps to epics.last_event_id must NEVER cause the change-gate
  // to flag plan files as changed.
  expect(emitted).toEqual([]);
});

test("seedFromDb reconstructs approval field-identically (no synthetic re-emit on boot, schema v13)", () => {
  // The boot trap (plan-worker.ts:759-764): if the seed reconstruction does
  // not reproduce `approval` byte-identically with what `buildEpicMessage` /
  // `buildTaskMessage` produce, every plan file re-emits a synthetic snapshot
  // on every boot — the events table grows unboundedly. Cover BOTH:
  //   (a) an epic + task with explicit "approved" values
  //   (b) the legacy default "pending" pre-stored on the column
  // The on-disk file matches in both cases → no re-emit.
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // Two epics: explicit approved + legacy default pending. Each carries one
  // embedded task with a matching approval to exercise the task-side path too.
  const approvedTasks = JSON.stringify([
    {
      task_id: "fn-3-demo.1",
      epic_id: "fn-3-demo",
      task_number: 1,
      title: "T",
      target_repo: "/repo",
      status: "open",
      approval: "approved",
    },
  ]);
  const pendingTasks = JSON.stringify([
    {
      task_id: "fn-4-demo.1",
      epic_id: "fn-4-demo",
      task_number: 1,
      title: "T",
      target_repo: "/repo",
      status: "open",
      approval: "pending",
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, approval, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "fn-3-demo",
      3,
      "Demo",
      "/repo",
      "open",
      "approved",
      1,
      0,
      approvedTasks,
      "fn-4-demo",
      4,
      "Demo",
      "/repo",
      "open",
      "pending",
      1,
      0,
      pendingTasks,
    ],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  db.close();

  // Approved-side files match exactly → no re-emit.
  scanner.onChange(
    writeEpic("fn-3-demo", {
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
      approval: "approved",
    }),
  );
  scanner.onChange(
    writeTask("fn-3-demo.1", {
      epic: "fn-3-demo",
      title: "T",
      target_repo: "/repo",
      approval: "approved",
    }),
  );
  // Pending-side files match exactly (and the on-disk file omits `approval`
  // entirely — `coerceApproval(undefined) === "pending"` matches the schema's
  // NOT NULL DEFAULT 'pending') → no re-emit.
  scanner.onChange(
    writeEpic("fn-4-demo", {
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
    }),
  );
  scanner.onChange(
    writeTask("fn-4-demo.1", {
      epic: "fn-4-demo",
      title: "T",
      target_repo: "/repo",
    }),
  );
  expect(emitted).toEqual([]);

  // A real approval flip on the approved epic DOES re-emit (proves the seed
  // didn't blanket-suppress — the change-gate is keyed on the field).
  writeFileSync(
    join(planctlDir("epics"), "fn-3-demo.json"),
    JSON.stringify({
      id: "fn-3-demo",
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
      approval: "rejected",
    }),
  );
  scanner.onChange(join(planctlDir("epics"), "fn-3-demo.json"));
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { approval: string }).approval).toBe("rejected");
});

test("seedFromDb reconstructs last_validated_at field-identically (no synthetic re-emit on boot, schema v16)", () => {
  // The boot trap: if the seed reconstruction doesn't place `lastValidatedAt`
  // in the SAME object-literal slot as buildEpicMessage (or coerces it
  // differently), the change-gate fires on every plan file on every boot —
  // one synthetic EpicSnapshot per epic, forever. This test pins the
  // byte-identity invariant by serializing BOTH sides and demanding match.
  //
  // Two epics cover both branches:
  //   (a) a stored last_validated_at TEXT → reconstructed string passes through
  //   (b) NULL stored → reconstructed `null` matches a file that omits the field
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, approval, last_event_id, updated_at, tasks, last_validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "fn-1-val",
      1,
      "Demo",
      "/repo",
      "open",
      "pending",
      1,
      0,
      "[]",
      "2026-05-24T00:00:00Z",
      "fn-2-val",
      2,
      "Demo",
      "/repo",
      "open",
      "pending",
      1,
      0,
      "[]",
      null,
    ],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  db.close();

  // (a) Stored validated → on-disk file carries the same value → no re-emit.
  scanner.onChange(
    writeEpic("fn-1-val", {
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
      last_validated_at: "2026-05-24T00:00:00Z",
    }),
  );
  // (b) Stored NULL → on-disk file omits the field → asString(undefined)===null
  // matches the NULL seed → no re-emit.
  scanner.onChange(
    writeEpic("fn-2-val", {
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
    }),
  );
  expect(emitted).toEqual([]);

  // Direct byte-for-byte: a fresh buildEpicMessage for the same RawEpic data
  // serializes to the SAME bytes the seed would reconstruct from the DB
  // row. Mismatched object-literal slot position would diverge here.
  const fromBuild = buildEpicMessage({
    id: "fn-1-val",
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
    approval: "pending",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  const fromSeed = {
    kind: "plan-epic" as const,
    id: "fn-1-val",
    number: 1,
    title: "Demo",
    projectDir: "/repo",
    status: "open",
    approval: "pending" as const,
    dependsOnEpics: [],
    lastValidatedAt: "2026-05-24T00:00:00Z",
  };
  expect(JSON.stringify(fromBuild)).toBe(JSON.stringify(fromSeed));

  // A real change to last_validated_at DOES re-emit (proves the seed didn't
  // blanket-suppress — the change-gate is keyed on the field).
  writeFileSync(
    join(planctlDir("epics"), "fn-1-val.json"),
    JSON.stringify({
      id: "fn-1-val",
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
      last_validated_at: "2026-05-25T00:00:00Z",
    }),
  );
  scanner.onChange(join(planctlDir("epics"), "fn-1-val.json"));
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { lastValidatedAt: string }).lastValidatedAt).toBe(
    "2026-05-25T00:00:00Z",
  );
});

// ---------------------------------------------------------------------------
// (a*) Boot reconciliation sweep — retract projection ids whose backing file
// was deleted while the daemon was down (no live onDelete fired). Scoped to
// configured roots via the epic's project_dir; runs after the boot scan's
// on-disk census is complete.
// ---------------------------------------------------------------------------

test("isWithinRoots: segment-aware prefix scoping", () => {
  expect(isWithinRoots("/a/code/proj", ["/a/code"])).toBe(true);
  expect(isWithinRoots("/a/code", ["/a/code"])).toBe(true);
  // A sibling that merely shares a string prefix is NOT inside.
  expect(isWithinRoots("/a/code-x/proj", ["/a/code"])).toBe(false);
  expect(isWithinRoots("/elsewhere/proj", ["/a/code"])).toBe(false);
  expect(isWithinRoots(null, ["/a/code"])).toBe(false);
  expect(isWithinRoots("", ["/a/code"])).toBe(false);
  // Multi-root: in scope if inside ANY configured root.
  expect(isWithinRoots("/b/src/proj", ["/a/code", "/b/src"])).toBe(true);
});

test("sweep retracts a deleted epic + embedded task, leaves present ones", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // Two epics, each with one task, both project_dir inside the configured root
  // (tmpDir). On disk we keep only the SURVIVING epic's files.
  const survivorTasks = JSON.stringify([
    {
      task_id: "fn-1-keep.1",
      epic_id: "fn-1-keep",
      task_number: 1,
      title: "K",
      target_repo: tmpDir,
      status: "open",
    },
  ]);
  const goneTasks = JSON.stringify([
    {
      task_id: "fn-2-gone.1",
      epic_id: "fn-2-gone",
      task_number: 1,
      title: "G",
      target_repo: tmpDir,
      status: "open",
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "fn-1-keep",
      1,
      "Keep",
      tmpDir,
      "open",
      1,
      0,
      survivorTasks,
      "fn-2-gone",
      2,
      "Gone",
      tmpDir,
      "open",
      2,
      0,
      goneTasks,
    ],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);

  // Only the survivor's files exist on disk. Boot scan records the census.
  writeEpic("fn-1-keep", {
    title: "Keep",
    status: "open",
    primary_repo: tmpDir,
  });
  writeTask("fn-1-keep.1", {
    epic: "fn-1-keep",
    title: "K",
    target_repo: tmpDir,
  });
  scanRoot(tmpDir, scanner);
  // Seeded survivor files are byte-identical → change-gate suppresses them.
  expect(emitted).toEqual([]);

  // Sweep: the absent epic + its embedded task are retracted; survivors untouched.
  scanner.sweep(db, [tmpDir]);
  db.close();

  expect(emitted).toContainEqual({
    kind: "plan-task-deleted",
    id: "fn-2-gone.1",
    epicId: "fn-2-gone",
  });
  expect(emitted).toContainEqual({
    kind: "plan-epic-deleted",
    id: "fn-2-gone",
  });
  // The surviving ids are NOT retracted.
  expect(
    emitted.some(
      (m) =>
        (m.kind === "plan-epic-deleted" && m.id === "fn-1-keep") ||
        (m.kind === "plan-task-deleted" && m.id === "fn-1-keep.1"),
    ),
  ).toBe(false);
});

test("sweep never retracts an epic whose project_dir is outside the configured roots", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // An epic from an UNCONFIGURED root: no file on disk under tmpDir, but its
  // project_dir is elsewhere — the sweep must leave it entirely alone (its file
  // lives under a tree this boot never scanned).
  const tasks = JSON.stringify([
    {
      task_id: "fn-9-other.1",
      epic_id: "fn-9-other",
      task_number: 1,
      title: "O",
      target_repo: "/some/other/root/proj",
      status: "open",
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["fn-9-other", 9, "Other", "/some/other/root/proj", "open", 1, 0, tasks],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  // The configured root (tmpDir) has no files; census stays empty.
  scanRoot(tmpDir, scanner);
  scanner.sweep(db, [tmpDir]);
  db.close();

  // Nothing retracted — the out-of-scope epic and task are untouched.
  expect(emitted).toEqual([]);
});

test("sweep does not retract a file mid-rewrite that fails to parse", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["fn-1-keep", 1, "Keep", tmpDir, "open", 1, 0, "[]"],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);

  // The file EXISTS on disk but holds torn JSON (mid-rewrite). The boot scan's
  // onChange skips-and-logs it, but markSeen records it from the filename — so
  // the sweep treats it as present and never retracts it.
  const epicPath = join(planctlDir("epics"), "fn-1-keep.json");
  writeFileSync(epicPath, "{ this is not valid json");
  scanRoot(tmpDir, scanner);
  scanner.sweep(db, [tmpDir]);
  db.close();

  // No retraction — a parse failure on an existing file is not a deletion.
  expect(
    emitted.some((m) => m.kind === "plan-epic-deleted" && m.id === "fn-1-keep"),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// (a') Drop-recovery via scanRoot — the change-gated re-scan primitive the
// per-root drop scheduler reuses. Boot scan + a simulated drop-recovery scan
// over the SAME warm scanner must not double-emit; a file changed between the
// two scans emits exactly its delta.
// ---------------------------------------------------------------------------

test("scanRoot: boot then drop-recovery over unchanged files emits nothing the second time", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  writeEpic("fn-3-demo", { title: "Demo", status: "open", primary_repo: "/r" });
  writeTask("fn-3-demo.1", { epic: "fn-3-demo", title: "T" });

  // Boot scan: both files emit.
  scanRoot(tmpDir, scanner);
  expect(emitted.length).toBe(2);

  // Simulated drop-recovery re-scan over the SAME warm scanner: change-gate
  // (PlanScanner.lastEmitted) suppresses both — zero duplicate snapshots.
  scanRoot(tmpDir, scanner);
  expect(emitted.length).toBe(2);
});

test("scanRoot: a file changed between boot and recovery emits exactly its delta", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const epicPath = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/r",
  });
  writeTask("fn-3-demo.1", { epic: "fn-3-demo", title: "T" });

  scanRoot(tmpDir, scanner);
  expect(emitted.length).toBe(2);

  // Mutate ONLY the epic, then run the recovery scan: exactly one delta emits.
  writeFileSync(
    epicPath,
    JSON.stringify({
      id: "fn-3-demo",
      title: "Demo",
      status: "done",
      primary_repo: "/r",
    }),
  );
  scanRoot(tmpDir, scanner);
  expect(emitted.length).toBe(3);
  expect((emitted[2] as { id: string; status: string }).id).toBe("fn-3-demo");
  expect((emitted[2] as { status: string }).status).toBe("done");
});

// ---------------------------------------------------------------------------
// (a'') Recursive boot scan — plan files live at <root>/<project>/.planctl/…,
// not at <root>/.planctl. The boot scan must recurse (the live watcher does) or
// pre-existing files are only ever folded via a live write. Heavy dirs are
// pruned so a broad root stays cheap.
// ---------------------------------------------------------------------------

test("scanRoot: discovers .planctl nested under a project subdir", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // The real layout: <root>/<project>/.planctl/{epics,tasks}/*.json — NOT a
  // .planctl directly under the watched root.
  const proj = join(tmpDir, "myproject");
  mkdirSync(join(proj, ".planctl", "epics"), { recursive: true });
  mkdirSync(join(proj, ".planctl", "tasks"), { recursive: true });
  writeFileSync(
    join(proj, ".planctl", "epics", "fn-9-nested.json"),
    JSON.stringify({ id: "fn-9-nested", title: "Nested", status: "open" }),
  );
  writeFileSync(
    join(proj, ".planctl", "tasks", "fn-9-nested.1.json"),
    JSON.stringify({ id: "fn-9-nested.1", epic: "fn-9-nested", title: "T" }),
  );

  scanRoot(tmpDir, scanner);
  expect(emitted.map((m) => m.id).sort()).toEqual([
    "fn-9-nested",
    "fn-9-nested.1",
  ]);
});

test("scanRoot: prunes node_modules/.git so their .planctl trees are skipped", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // A stray .planctl buried inside node_modules must NOT be scanned — pruning
  // is what keeps a broad root (~/code) cheap and avoids vendored noise.
  for (const heavy of ["node_modules", ".git"]) {
    const dir = join(tmpDir, heavy, "pkg", ".planctl", "epics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fn-666-vendored.json"),
      JSON.stringify({ id: "fn-666-vendored", title: "Nope", status: "open" }),
    );
  }
  // A real project alongside them IS found.
  const dir = join(tmpDir, "real", ".planctl", "epics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fn-7-real.json"),
    JSON.stringify({ id: "fn-7-real", title: "Real", status: "open" }),
  );

  scanRoot(tmpDir, scanner);
  expect(emitted.map((m) => m.id)).toEqual(["fn-7-real"]);
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

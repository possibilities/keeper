/**
 * Plan-worker tests — DETERMINISM unit tests against the PURE `PlanScanner`
 * core + the pure reflog watch-set / missed-wake helpers — no Worker, no
 * watcher, no real git spawn against the host. Cover the path classifier,
 * number-parse edge cases, task-status derivation, the change-gate (unchanged
 * snapshot suppressed, a real change re-emits), safe-parse skips (malformed
 * JSON, oversize, missing-id, read-vs-delete race), the restart-seed
 * suppressing a redundant re-emit, onDelete dropping the change-gate, the
 * fn-737 reflog watch-set wiring (`resolveReflogTarget` / `desiredReflogRepos`
 * / `reflogWatchDiff`), and the fn-720 backstop missed-wake records.
 *
 * The OS-coupled layers — the `@parcel/watcher` native-addon load smoke, the
 * real spawned-Worker shutdown/realtime tests, and the fn-737 real-git
 * fold-latency/lever harness — were deleted in fn-752: they assert OS/runtime
 * behavior (native dlopen, FSEvents/reflog delivery timing) rather than
 * keeper's own logic, and the wiring they exercised is now covered by the pure
 * helpers above. Dogfooding is the backstop for the OS layer.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackstopMessage,
  BackstopRecord,
  BackstopRollup,
} from "../src/backstop-telemetry";
import { buildMissedWakeRecord } from "../src/backstop-telemetry";
import { openDb } from "../src/db";
import {
  attributePlanDirToRoot,
  buildEpicMessage,
  buildTaskMessage,
  classifyPlanPath,
  coerceEpicQuestion,
  coerceRuntimeStatus,
  decidePlanResubscribe,
  desiredReflogRepos,
  discoverPlanDirs,
  discoverPlanRepos,
  epicDefPathFromStatePath,
  epicIdFromStatePath,
  epicNumberFromId,
  isPathInHead,
  isPathInHeadBatch,
  isWithinRoots,
  MAX_SUBSCRIBES_PER_CYCLE,
  makeSingleFlight,
  PLAN_DB_POLL_MS,
  type PlanMessage,
  PlanScanner,
  reconcilePlanDirs,
  reflogWatchDiff,
  repoRootFromPlanPath,
  resolveReflogTarget,
  scanRepoDataDirs,
  scanRoot,
  seedFromDb,
  taskDefPathFromStatePath,
  taskIdFromStatePath,
  taskNumberFromId,
} from "../src/plan-worker";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-plan-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Make a `.keeper/<dir>` tree under tmpDir and return the dir path. */
function planDir(kind: "epics" | "tasks"): string {
  const dir = join(tmpDir, ".keeper", kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an epic JSON file and return its path. */
function writeEpic(id: string, body: Record<string, unknown>): string {
  const path = join(planDir("epics"), `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

/** Write a task JSON file and return its path. */
function writeTask(id: string, body: Record<string, unknown>): string {
  const path = join(planDir("tasks"), `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

/** Make a `<dataDir>/<kind>` tree under a project root and return the dir path.
 * `dataDir` is the data-dir basename (`.keeper`; tests also pass `.planctl` to
 * verify it is ignored). */
function dataDirOf(
  projectRoot: string,
  dataDir: string,
  kind: "epics" | "tasks",
): string {
  const dir = join(projectRoot, dataDir, kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an epic JSON under `<projectRoot>/<dataDir>/epics/` and return its path. */
function writeEpicIn(
  projectRoot: string,
  dataDir: string,
  id: string,
  body: Record<string, unknown>,
): string {
  const path = join(dataDirOf(projectRoot, dataDir, "epics"), `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — path classifier + number parse
// ---------------------------------------------------------------------------

test("classifyPlanPath: epics/tasks json under .keeper, else null", () => {
  expect(classifyPlanPath("/a/b/.keeper/epics/fn-1-x.json")).toBe("epic");
  expect(classifyPlanPath("/a/b/.keeper/tasks/fn-1-x.2.json")).toBe("task");
  // Wrong subdir, wrong extension, not under .keeper, deeper nesting all reject.
  expect(classifyPlanPath("/a/.keeper/specs/fn-1-x.md")).toBeNull();
  expect(classifyPlanPath("/a/.keeper/epics/fn-1-x.md")).toBeNull();
  expect(classifyPlanPath("/a/epics/fn-1-x.json")).toBeNull();
  expect(classifyPlanPath("/a/.keeper/epics/sub/fn-1-x.json")).toBeNull();
});

test("classifyPlanPath: .keeper/state/tasks/*.state.json → task-state, else null", () => {
  // Positive: the plan LocalFileStateStore shape — 4-segment tail with the
  // `.state.json` suffix on the basename.
  expect(classifyPlanPath("/a/b/.keeper/state/tasks/fn-1-x.2.state.json")).toBe(
    "task-state",
  );
  // Negative: a stray non-state `.json` under the same dir rejects (the suffix
  // probe excludes it).
  expect(classifyPlanPath("/a/b/.keeper/state/tasks/fn-1-x.2.json")).toBeNull();
  // Negative: a 3-segment match under `.keeper/state/...` (wrong middle dir
  // for the 3-tail probe AND wrong shape for the 4-tail probe) rejects.
  expect(classifyPlanPath("/a/.keeper/state/fn-1-x.state.json")).toBeNull();
  // Negative: a non-state file with the same tail depth rejects (wrong dir
  // chain).
  expect(
    classifyPlanPath("/a/.keeper/snapshots/tasks/fn-1-x.state.json"),
  ).toBeNull();
  // Negative: a 5-segment match (deeper nesting) rejects — the probe is exact
  // on the trailing 4 segments.
  expect(
    classifyPlanPath("/a/.keeper/state/tasks/sub/fn-1-x.state.json"),
  ).toBeNull();
});

test("taskIdFromStatePath / taskDefPathFromStatePath: pure path arithmetic", () => {
  // Strip the `.state.json` suffix from the basename to recover the task id.
  expect(
    taskIdFromStatePath("/a/.keeper/state/tasks/fn-1-x.2.state.json"),
  ).toBe("fn-1-x.2");
  // A basename without the suffix rejects.
  expect(
    taskIdFromStatePath("/a/.keeper/state/tasks/fn-1-x.2.json"),
  ).toBeNull();
  // Map a state-file path to the sibling task-definition path.
  expect(
    taskDefPathFromStatePath("/a/b/.keeper/state/tasks/fn-1-x.2.state.json"),
  ).toBe("/a/b/.keeper/tasks/fn-1-x.2.json");
  // A path that doesn't match the 4-segment shape rejects.
  expect(taskDefPathFromStatePath("/a/.keeper/tasks/fn-1-x.json")).toBeNull();
});

test("classifyPlanPath: .keeper/state/epics/*.state.json → epic-state (fn-732)", () => {
  // Positive: the plan LocalFileStateStore shape for the epic runtime-state
  // sidecar — 4-segment tail under `state/epics/` with `.state.json` suffix.
  // Keeper ingests no field from this sidecar, but the path classifies so it
  // is recognized, not mis-routed.
  expect(classifyPlanPath("/a/b/.keeper/state/epics/fn-1-x.state.json")).toBe(
    "epic-state",
  );
  // Sibling task-state arm still classifies independently.
  expect(classifyPlanPath("/a/b/.keeper/state/tasks/fn-1-x.2.state.json")).toBe(
    "task-state",
  );
  // Negative: a stray non-state `.json` under state/epics/ rejects.
  expect(classifyPlanPath("/a/b/.keeper/state/epics/fn-1-x.json")).toBeNull();
  // Negative: a deeper-nested match rejects (exact trailing-4 probe).
  expect(
    classifyPlanPath("/a/.keeper/state/epics/sub/fn-1-x.state.json"),
  ).toBeNull();
  // Negative: an unrelated leaf dir under state/ rejects.
  expect(
    classifyPlanPath("/a/.keeper/state/sessions/fn-1-x.state.json"),
  ).toBeNull();
});

test("scanRoot folds the root .keeper plan", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // keeper's OWN root plan — must fold.
  writeEpic("fn-822-keeper", {
    title: "keeper epic",
    status: "open",
    primary_repo: tmpDir,
  });

  scanRoot(tmpDir, scanner);

  const epicIds = emitted
    .filter((m) => m.kind === "plan-epic")
    .map((m) => (m as { id: string }).id);
  expect(epicIds).toContain("fn-822-keeper");
});

// ---------------------------------------------------------------------------
// data dir — the worker folds the `.keeper/` data dir only. A `.planctl/` dir
// is not a recognized plan data dir: it is ignored entirely (never folded), so
// the `epics` projection (and autopilot's board) sources from `.keeper/`.
// ---------------------------------------------------------------------------

test("classifyPlanPath: recognizes .keeper/, ignores .planctl/", () => {
  expect(classifyPlanPath("/a/b/.keeper/epics/fn-1-x.json")).toBe("epic");
  expect(classifyPlanPath("/a/b/.keeper/tasks/fn-1-x.2.json")).toBe("task");
  expect(classifyPlanPath("/a/b/.keeper/state/tasks/fn-1-x.2.state.json")).toBe(
    "task-state",
  );
  expect(classifyPlanPath("/a/b/.keeper/state/epics/fn-1-x.state.json")).toBe(
    "epic-state",
  );
  // A non-data-dir basename — including the unrecognized `.planctl/` — rejects.
  expect(classifyPlanPath("/a/b/.other/epics/fn-1-x.json")).toBeNull();
  expect(classifyPlanPath("/a/b/.planctl/epics/fn-1-x.json")).toBeNull();
});

test("repoRootFromPlanPath: resolves the repo root for the .keeper/ data dir", () => {
  expect(repoRootFromPlanPath("/a/b/.keeper/epics/fn-1-x.json")).toBe("/a/b");
  // A `.planctl/` path is not under a recognized data dir, so no root resolves.
  expect(repoRootFromPlanPath("/a/b/.planctl/epics/fn-1-x.json")).toBeNull();
});

test("taskDefPathFromStatePath / epicDefPathFromStatePath: preserve the .keeper/ data dir", () => {
  expect(
    taskDefPathFromStatePath("/a/b/.keeper/state/tasks/fn-1-x.2.state.json"),
  ).toBe("/a/b/.keeper/tasks/fn-1-x.2.json");
  expect(
    epicDefPathFromStatePath("/a/b/.keeper/state/epics/fn-1-x.state.json"),
  ).toBe("/a/b/.keeper/epics/fn-1-x.json");
});

test("scanRoot: a .keeper/ epic folds; a .planctl/ dir is ignored", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Two sibling projects under the same configured root — one on `.keeper/`,
  // one on `.planctl/`. Only the `.keeper/` epic folds.
  const keeperProj = join(tmpDir, "on-keeper");
  const planProj = join(tmpDir, "on-plan");
  writeEpicIn(keeperProj, ".keeper", "fn-900-keeper-dir", {
    title: "keeper-dir epic",
    status: "open",
    primary_repo: keeperProj,
  });
  writeEpicIn(planProj, ".planctl", "fn-901-plan-dir", {
    title: "plan-dir epic",
    status: "open",
    primary_repo: planProj,
  });

  scanRoot(tmpDir, scanner);

  const epicIds = emitted
    .filter((m) => m.kind === "plan-epic")
    .map((m) => (m as { id: string }).id);
  expect(epicIds).toContain("fn-900-keeper-dir");
  expect(epicIds).not.toContain("fn-901-plan-dir");
});

test("scanRoot: a repo holding both dir names folds only the .keeper/ epic", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  const proj = join(tmpDir, "both-dirs");
  // Same epic id in both dirs, differing only by a field — `.keeper/` is the
  // only recognized data dir, so only its file folds; the `.planctl/` file is
  // ignored entirely.
  writeEpicIn(proj, ".keeper", "fn-902-both", {
    title: "from keeper",
    status: "open",
    primary_repo: proj,
  });
  writeEpicIn(proj, ".planctl", "fn-902-both", {
    title: "from plan",
    status: "open",
    primary_repo: proj,
  });

  scanRoot(proj, scanner);

  const epics = emitted.filter(
    (m) => m.kind === "plan-epic" && (m as { id: string }).id === "fn-902-both",
  );
  // Folded exactly once from `.keeper/`; the `.planctl/` file never emits.
  expect(epics.length).toBe(1);
  expect((epics[0] as { title: string }).title).toBe("from keeper");
});

test("discoverPlanDirs: surfaces .keeper/ dirs only; reconcilePlanDirs folds them", () => {
  const keeperProj = join(tmpDir, "k");
  const planProj = join(tmpDir, "p");
  writeEpicIn(keeperProj, ".keeper", "fn-903-k", {
    title: "k",
    status: "open",
    primary_repo: keeperProj,
  });
  writeEpicIn(planProj, ".planctl", "fn-904-p", {
    title: "p",
    status: "open",
    primary_repo: planProj,
  });

  const dirs = discoverPlanDirs([tmpDir]);
  expect(dirs).toContain(join(keeperProj, ".keeper"));
  expect(dirs).not.toContain(join(planProj, ".planctl"));

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  reconcilePlanDirs([tmpDir], scanner);
  const epicIds = emitted
    .filter((m) => m.kind === "plan-epic")
    .map((m) => (m as { id: string }).id);
  expect(epicIds).toContain("fn-903-k");
  expect(epicIds).not.toContain("fn-904-p");
});

test("scanRepoDataDirs: re-scans whichever data dir(s) a repo holds", () => {
  // The reflog-watch re-scan path: given a repo root, fold its present data
  // dirs. A repo on `.keeper/` only folds via `.keeper/`; the absent
  // `.planctl/` is silently skipped.
  const proj = join(tmpDir, "repo");
  writeEpicIn(proj, ".keeper", "fn-905-rescan", {
    title: "rescan",
    status: "open",
    primary_repo: proj,
  });
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  scanRepoDataDirs(proj, scanner);
  const epicIds = emitted
    .filter((m) => m.kind === "plan-epic")
    .map((m) => (m as { id: string }).id);
  expect(epicIds).toEqual(["fn-905-rescan"]);
});

test("epicIdFromStatePath / epicDefPathFromStatePath: pure path arithmetic (fn-732)", () => {
  // Strip the `.state.json` suffix from the basename to recover the epic id.
  expect(epicIdFromStatePath("/a/.keeper/state/epics/fn-1-x.state.json")).toBe(
    "fn-1-x",
  );
  // A basename without the suffix rejects.
  expect(epicIdFromStatePath("/a/.keeper/state/epics/fn-1-x.json")).toBeNull();
  // Map an epic state-file path to the committed epic-definition path.
  expect(
    epicDefPathFromStatePath("/a/b/.keeper/state/epics/fn-1-x.state.json"),
  ).toBe("/a/b/.keeper/epics/fn-1-x.json");
  // A path under the WRONG leaf dir (state/tasks/) rejects — the epic mapper is
  // dir-specific even though the id-from-basename transform is shared.
  expect(
    epicDefPathFromStatePath("/a/b/.keeper/state/tasks/fn-1-x.state.json"),
  ).toBeNull();
  // A path that doesn't match the 4-segment shape rejects.
  expect(epicDefPathFromStatePath("/a/.keeper/epics/fn-1-x.json")).toBeNull();
});

test("coerceRuntimeStatus: enum passes through; missing → 'todo' silently; invalid → 'todo' with log", () => {
  const logs: unknown[] = [];
  // Every enum value passes through verbatim.
  for (const v of ["todo", "in_progress", "done", "blocked"]) {
    expect(coerceRuntimeStatus(v, (bad) => logs.push(bad))).toBe(v);
  }
  // Missing / null silently defaults to "todo" (plan's merge_task_state
  // convention — a fresh clone with no `state/` tree reads every task as
  // `todo`); the onInvalid callback is NOT fired for absent fields.
  expect(coerceRuntimeStatus(undefined, (bad) => logs.push(bad))).toBe("todo");
  expect(coerceRuntimeStatus(null, (bad) => logs.push(bad))).toBe("todo");
  expect(logs).toEqual([]);
  // An unrecognized string / wrong-type value coerces to "todo" AND fires
  // onInvalid so the producer can log to stderr.
  expect(coerceRuntimeStatus("garbage", (bad) => logs.push(bad))).toBe("todo");
  expect(coerceRuntimeStatus(42, (bad) => logs.push(bad))).toBe("todo");
  expect(logs).toEqual(["garbage", 42]);
});

test("buildTaskMessage carries runtimeStatus passed in by the caller; defaults to 'todo' when omitted", () => {
  // Default arg behaviour — no runtime status threaded → "todo".
  const taskA = buildTaskMessage({ id: "fn-1-x.1" });
  expect(taskA?.runtimeStatus).toBe("todo");
  // Explicit pass-through (the cache value the PlanScanner threads in).
  const taskB = buildTaskMessage({ id: "fn-1-x.1" }, "in_progress");
  expect(taskB?.runtimeStatus).toBe("in_progress");
});

test("coerceEpicQuestion: non-empty string passes through; missing/null/empty → null silently; wrong type → null with log (fn-1083.2)", () => {
  const logs: unknown[] = [];
  expect(
    coerceEpicQuestion("why did commit X fail?", (bad) => logs.push(bad)),
  ).toBe("why did commit X fail?");
  // Missing / null / empty-string silently default to null — no onInvalid fire.
  expect(coerceEpicQuestion(undefined, (bad) => logs.push(bad))).toBeNull();
  expect(coerceEpicQuestion(null, (bad) => logs.push(bad))).toBeNull();
  expect(coerceEpicQuestion("", (bad) => logs.push(bad))).toBeNull();
  expect(logs).toEqual([]);
  // A wrong-type value coerces to null AND fires onInvalid.
  expect(coerceEpicQuestion(42, (bad) => logs.push(bad))).toBeNull();
  expect(coerceEpicQuestion({ q: "x" }, (bad) => logs.push(bad))).toBeNull();
  expect(logs).toEqual([42, { q: "x" }]);
});

test("buildEpicMessage carries question passed in by the caller; defaults to null when omitted (fn-1083.2)", () => {
  const epicA = buildEpicMessage({ id: "fn-1-x" });
  expect(epicA?.question).toBeNull();
  const epicB = buildEpicMessage({ id: "fn-1-x" }, "ship or hold?");
  expect(epicB?.question).toBe("ship or hold?");
});

test("epicNumberFromId / taskNumberFromId: parse + null on no match", () => {
  expect(epicNumberFromId("fn-558-keeper-plans")).toBe(558);
  expect(epicNumberFromId("fn-1-x")).toBe(1);
  expect(epicNumberFromId("no-number-here")).toBeNull();
  expect(taskNumberFromId("fn-558-keeper-plans.3")).toBe(3);
  expect(taskNumberFromId("fn-1-x.12")).toBe(12);
  expect(taskNumberFromId("fn-1-x")).toBeNull();
});

test("buildTaskMessage derives workerPhase from worker_done_at", () => {
  const open = buildTaskMessage({ id: "fn-1-x.1" });
  expect(open?.workerPhase).toBe("open");
  const done = buildTaskMessage({
    id: "fn-1-x.2",
    worker_done_at: "2026-05-22T00:00:00Z",
  });
  expect(done?.workerPhase).toBe("done");
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
    dependsOnEpics: [],
    // Missing `last_validated_at` (schema v16) collapses to null via asString.
    lastValidatedAt: null,
    // No `question` arg passed — defaults to null (no parked question).
    question: null,
    // No `blocks_closing_of` on the raw epic → null (an ordinary epic).
    blocksClosingOf: null,
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
      dependsOnEpics: [],
      lastValidatedAt: null,
      question: null,
      blocksClosingOf: null,
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

test("onChange emits a task snapshot with derived workerPhase + epicId", () => {
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
      // fn-602: `tier` rides FREE in the embedded JSON; pre-fn-602 task files
      // lack the field and `buildTaskMessage` coerces to `null`.
      tier: null,
      // `model` rides FREE alongside `tier`; a model-less task file coerces to null.
      model: null,
      workerPhase: "open",
      runtimeStatus: "todo",
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

  const path = join(planDir("epics"), "fn-9-bad.json");
  writeFileSync(path, "{ not json");
  scanner.onChange(path);

  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("malformed JSON"))).toBe(true);
});

test("a non-.keeper path is a no-op (classifier rejects)", () => {
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

  // A path under a real .keeper/epics dir that does not exist on disk → the
  // stat fails (the race), skip-and-log.
  const path = join(planDir("epics"), "fn-7-gone.json");
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
  const path = join(planDir("tasks"), "fn-9-never.1.json");
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
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, last_validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "fn-1-val",
      1,
      "Demo",
      "/repo",
      "open",
      1,
      0,
      "[]",
      "2026-05-24T00:00:00Z",
      "fn-2-val",
      2,
      "Demo",
      "/repo",
      "open",
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
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  const fromSeed = {
    kind: "plan-epic" as const,
    id: "fn-1-val",
    number: 1,
    title: "Demo",
    projectDir: "/repo",
    status: "open",
    dependsOnEpics: [],
    lastValidatedAt: "2026-05-24T00:00:00Z",
    question: null,
    blocksClosingOf: null,
  };
  expect(JSON.stringify(fromBuild)).toBe(JSON.stringify(fromSeed));

  // A real change to last_validated_at DOES re-emit (proves the seed didn't
  // blanket-suppress — the change-gate is keyed on the field).
  writeFileSync(
    join(planDir("epics"), "fn-1-val.json"),
    JSON.stringify({
      id: "fn-1-val",
      title: "Demo",
      status: "open",
      primary_repo: "/repo",
      last_validated_at: "2026-05-25T00:00:00Z",
    }),
  );
  scanner.onChange(join(planDir("epics"), "fn-1-val.json"));
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { lastValidatedAt: string }).lastValidatedAt).toBe(
    "2026-05-25T00:00:00Z",
  );
});

test("buildEpicMessage extracts blocks_closing_of; seedFromDb reconstructs it identically (no re-emit, schema v117)", () => {
  // A follow-up epic file carries a top-level `blocks_closing_of`. The producer
  // must extract it AND the boot-seed reconstruct it in the SAME object-literal
  // slot, or the change-gate re-emits one synthetic EpicSnapshot per epic every
  // boot. Two epics cover both branches: (a) a stored pointer round-trips; (b)
  // NULL stored matches a file that omits the field.
  expect(
    buildEpicMessage({
      id: "fn-9-followup",
      title: "FU",
      status: "open",
      primary_repo: "/repo",
      blocks_closing_of: "fn-1-source",
    })?.blocksClosingOf,
  ).toBe("fn-1-source");

  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, blocks_closing_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "fn-9-followup",
      9,
      "FU",
      "/repo",
      "open",
      1,
      0,
      "[]",
      "fn-1-source",
      "fn-8-ordinary",
      8,
      "Ord",
      "/repo",
      "open",
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

  // (a) Stored pointer → on-disk file carries the same value → no re-emit.
  scanner.onChange(
    writeEpic("fn-9-followup", {
      title: "FU",
      status: "open",
      primary_repo: "/repo",
      blocks_closing_of: "fn-1-source",
    }),
  );
  // (b) Stored NULL → on-disk file omits the field → asString(undefined)===null
  // matches the NULL seed → no re-emit.
  scanner.onChange(
    writeEpic("fn-8-ordinary", {
      title: "Ord",
      status: "open",
      primary_repo: "/repo",
    }),
  );
  expect(emitted).toEqual([]);

  // A real change to blocks_closing_of DOES re-emit — the change-gate is keyed
  // on the field, so the seed did not blanket-suppress.
  scanner.onChange(
    writeEpic("fn-9-followup", {
      title: "FU",
      status: "open",
      primary_repo: "/repo",
      blocks_closing_of: "fn-2-other-source",
    }),
  );
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { blocksClosingOf: string }).blocksClosingOf).toBe(
    "fn-2-other-source",
  );
});

test("seedFromDb reconstructs workerPhase + runtimeStatus field-identically (no synthetic re-emit on boot, schema v19)", () => {
  // The #1 silent regression risk for schema v19 (per the task spec): if the
  // seed reconstruction places `workerPhase` / `runtimeStatus` in different
  // object-literal SLOTS than `buildTaskMessage`, `JSON.stringify` byte-
  // compares diverge and every embedded task element re-emits a synthetic
  // TaskSnapshot on every daemon boot — silently. This test pins the
  // byte-identity invariant by direct serialization compare, exercising both
  // the live-stored shape (`worker_phase` + `runtime_status` keys) and the
  // bare shape (`status` only) to prove defensive parity.
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // Live v19 shape: embedded task carries BOTH new keys. A re-fold from the
  // event log writes this shape; the seed reconstruction must read it back
  // identically.
  const tasksV19 = JSON.stringify([
    {
      task_id: "fn-9-x.1",
      epic_id: "fn-9-x",
      task_number: 1,
      title: "T",
      target_repo: "/repo",
      worker_phase: "done",
      runtime_status: "in_progress",
      depends_on: [],
      jobs: [],
    },
  ]);
  // Legacy pre-v19 shape: only `status`. seedFromDb reads
  // `t.worker_phase ?? t.status ?? "open"` so this row still reconstructs to
  // `workerPhase: "open"` and defaults `runtimeStatus` to `"todo"`.
  const tasksLegacy = JSON.stringify([
    {
      task_id: "fn-9-y.1",
      epic_id: "fn-9-y",
      task_number: 1,
      title: "L",
      target_repo: "/repo",
      status: "open",
      depends_on: [],
      jobs: [],
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "fn-9-x",
      9,
      "X",
      "/repo",
      "open",
      1,
      0,
      tasksV19,
      "fn-9-y",
      9,
      "Y",
      "/repo",
      "open",
      1,
      0,
      tasksLegacy,
    ],
  );

  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  db.close();

  // The on-disk task definition file for the v19-shaped row carries the
  // fields that derive worker_phase: `worker_done_at` is present so the
  // derived phase is "done". The state file is NOT written (the cache
  // defaults to "todo"); but the seeded row has runtime_status="in_progress",
  // so a state-less scan would NOT match and a re-emit IS expected. To
  // pin parity, we instead pass the seeded runtimeStatus explicitly into
  // buildTaskMessage and compare bytes — the load-bearing invariant for
  // the seed change-gate.
  const fromBuildV19 = buildTaskMessage(
    {
      id: "fn-9-x.1",
      epic: "fn-9-x",
      title: "T",
      target_repo: "/repo",
      worker_done_at: "2026-05-22T00:00:00Z", // derives workerPhase="done"
    },
    "in_progress", // runtimeStatus the scanner would thread in from the cache
  );
  const fromSeedV19 = {
    kind: "plan-task" as const,
    id: "fn-9-x.1",
    epicId: "fn-9-x",
    number: 1,
    title: "T",
    targetRepo: "/repo",
    // fn-602: legacy stored element lacks `tier`; seedFromDb reconstructs
    // `tier: null` via `?? null`, and `buildTaskMessage` on the equivalent
    // tier-less raw task file coerces to `null` via `asString(undefined)`.
    // Bytes match because the slot order is identical across both sites.
    tier: null,
    // `model` rides in the same slot (right after `tier`) on both sides.
    model: null,
    workerPhase: "done",
    runtimeStatus: "in_progress",
    dependsOn: [],
  };
  // The load-bearing assertion: bytes must match. A reorder of either side's
  // object-literal keys breaks this immediately.
  expect(JSON.stringify(fromBuildV19)).toBe(JSON.stringify(fromSeedV19));

  // Legacy pre-v19 stored row → seedFromDb reads `worker_phase ?? status`
  // (= "open") and defaults `runtime_status` (= "todo"). A buildTaskMessage
  // for the equivalent on-disk file (no worker_done_at, no state file) must
  // serialize to the same bytes.
  const fromBuildLegacy = buildTaskMessage(
    {
      id: "fn-9-y.1",
      epic: "fn-9-y",
      title: "L",
      target_repo: "/repo",
    },
    "todo",
  );
  const fromSeedLegacy = {
    kind: "plan-task" as const,
    id: "fn-9-y.1",
    epicId: "fn-9-y",
    number: 1,
    title: "L",
    targetRepo: "/repo",
    // fn-602: same byte-parity invariant — tier defaults to `null` on both
    // the seed side (`t.tier ?? null`) and the build side (`asString(raw.tier)`
    // → `null` when `raw.tier` is undefined on a tier-less task file).
    tier: null,
    model: null,
    workerPhase: "open",
    runtimeStatus: "todo",
    dependsOn: [],
  };
  expect(JSON.stringify(fromBuildLegacy)).toBe(JSON.stringify(fromSeedLegacy));

  // The seed must have suppressed re-emits on the bootstrap (parity above
  // proves the byte-compare holds for both shapes — no synthetic emission
  // happened during seedFromDb itself).
  expect(emitted).toEqual([]);
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
  const epicPath = join(planDir("epics"), "fn-1-keep.json");
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
// (a'') Recursive boot scan — plan files live at <root>/<project>/.keeper/…,
// not at <root>/.keeper. The boot scan must recurse (the live watcher does) or
// pre-existing files are only ever folded via a live write. Heavy dirs are
// pruned so a broad root stays cheap.
// ---------------------------------------------------------------------------

test("scanRoot: discovers .keeper nested under a project subdir", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // The real layout: <root>/<project>/.keeper/{epics,tasks}/*.json — NOT a
  // .keeper directly under the watched root.
  const proj = join(tmpDir, "myproject");
  mkdirSync(join(proj, ".keeper", "epics"), { recursive: true });
  mkdirSync(join(proj, ".keeper", "tasks"), { recursive: true });
  writeFileSync(
    join(proj, ".keeper", "epics", "fn-9-nested.json"),
    JSON.stringify({ id: "fn-9-nested", title: "Nested", status: "open" }),
  );
  writeFileSync(
    join(proj, ".keeper", "tasks", "fn-9-nested.1.json"),
    JSON.stringify({ id: "fn-9-nested.1", epic: "fn-9-nested", title: "T" }),
  );

  scanRoot(tmpDir, scanner);
  expect(emitted.map((m) => m.id).sort()).toEqual([
    "fn-9-nested",
    "fn-9-nested.1",
  ]);
});

test("scanRoot: prunes node_modules/.git so their .keeper trees are skipped", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // A stray .keeper buried inside node_modules must NOT be scanned — pruning
  // is what keeps a broad root (~/code) cheap and avoids vendored noise.
  for (const heavy of ["node_modules", ".git"]) {
    const dir = join(tmpDir, heavy, "pkg", ".keeper", "epics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fn-666-vendored.json"),
      JSON.stringify({ id: "fn-666-vendored", title: "Nope", status: "open" }),
    );
  }
  // A real project alongside them IS found.
  const dir = join(tmpDir, "real", ".keeper", "epics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fn-7-real.json"),
    JSON.stringify({ id: "fn-7-real", title: "Real", status: "open" }),
  );

  scanRoot(tmpDir, scanner);
  expect(emitted.map((m) => m.id)).toEqual(["fn-7-real"]);
});

test("scanRoot: primes runtimeStatusCache from state/tasks/ BEFORE the tasks/ loop — first TaskSnapshot carries the on-disk runtime_status (regression: fn-607.F1)", () => {
  // Boot-path regression: a pre-existing `.keeper/state/tasks/<id>.state.json`
  // must seed the runtime-status cache before the task definition file is
  // scanned, so the FIRST emitted TaskSnapshot already carries the correct
  // `runtime_status`. Pre-fix, scanPlanDir iterated only ["epics","tasks"]
  // and never read state/, so every restart silently lied with "todo" until
  // the next live state-file write.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // Set up the state file FIRST (mirrors the boot path: state file already
  // exists on disk when the daemon comes up).
  const plan = join(tmpDir, ".keeper");
  mkdirSync(join(plan, "state", "tasks"), { recursive: true });
  writeFileSync(
    join(plan, "state", "tasks", "fn-1-x.1.state.json"),
    JSON.stringify({ status: "in_progress" }),
  );

  // Then the task definition file under the canonical tasks/ tree.
  writeTask("fn-1-x.1", { epic: "fn-1-x", title: "T" });

  scanRoot(tmpDir, scanner);

  // Exactly one task snapshot, carrying the state-file value, NOT "todo".
  const taskMsgs = emitted.filter((m) => m.kind === "plan-task");
  expect(taskMsgs.length).toBe(1);
  expect(
    (taskMsgs[0] as { id: string; runtimeStatus: string }).runtimeStatus,
  ).toBe("in_progress");
  expect((taskMsgs[0] as { id: string }).id).toBe("fn-1-x.1");
});

test("scanRoot: invalid runtime_status in a state file skips the cache prime (task reads default 'todo')", () => {
  // Mirrors the live `task-state` onChange arm's safe-value discipline:
  // a bad value is logged and NOT written to the cache, so the task falls
  // through to the plan default "todo" rather than absorbing garbage.
  const emitted: PlanMessage[] = [];
  const logs: string[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    (msg) => logs.push(msg),
  );

  const plan = join(tmpDir, ".keeper");
  mkdirSync(join(plan, "state", "tasks"), { recursive: true });
  writeFileSync(
    join(plan, "state", "tasks", "fn-1-x.1.state.json"),
    JSON.stringify({ status: "garbage" }),
  );
  writeTask("fn-1-x.1", { epic: "fn-1-x", title: "T" });

  scanRoot(tmpDir, scanner);

  const taskMsgs = emitted.filter((m) => m.kind === "plan-task");
  expect(taskMsgs.length).toBe(1);
  expect(
    (taskMsgs[0] as { id: string; runtimeStatus: string }).runtimeStatus,
  ).toBe("todo");
});

test("scanRoot: primes epicQuestionCache from state/epics/ BEFORE the epics/ loop — first EpicSnapshot carries the on-disk question (fn-1083.2)", () => {
  // Epic mirror of the task runtime-status boot-prime regression above: a
  // pre-existing `.keeper/state/epics/<id>.state.json` must seed the
  // question cache before the epic definition file is scanned, so the FIRST
  // emitted EpicSnapshot already carries the parked question.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const plan = join(tmpDir, ".keeper");
  mkdirSync(join(plan, "state", "epics"), { recursive: true });
  writeFileSync(
    join(plan, "state", "epics", "fn-1-x.state.json"),
    JSON.stringify({ question: "does the evidence check out?" }),
  );
  writeEpic("fn-1-x", { title: "T", status: "open" });

  scanRoot(tmpDir, scanner);

  const epicMsgs = emitted.filter((m) => m.kind === "plan-epic");
  expect(epicMsgs.length).toBe(1);
  expect((epicMsgs[0] as { question: string | null }).question).toBe(
    "does the evidence check out?",
  );
});

test("scanRoot: invalid question in a state file skips the cache prime (epic reads default null) (fn-1083.2)", () => {
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const plan = join(tmpDir, ".keeper");
  mkdirSync(join(plan, "state", "epics"), { recursive: true });
  writeFileSync(
    join(plan, "state", "epics", "fn-1-x.state.json"),
    JSON.stringify({ question: 42 }),
  );
  writeEpic("fn-1-x", { title: "T", status: "open" });

  scanRoot(tmpDir, scanner);

  const epicMsgs = emitted.filter((m) => m.kind === "plan-epic");
  expect(epicMsgs.length).toBe(1);
  expect((epicMsgs[0] as { question: string | null }).question).toBeNull();
});

test("epic-state onChange: setting then clearing the question re-emits an EpicSnapshot each time (fn-1083.2)", () => {
  // Live-write flow (not the boot scan): epic def lands first, then its
  // `.state.json` sidecar is written/deleted — mirrors `keeper plan
  // epic-question <id> "…"` / `--clear`.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const epicPath = writeEpic("fn-1-x", { title: "T", status: "open" });
  scanner.onChange(epicPath);
  expect(emitted.length).toBe(1);
  expect((emitted[0] as { question: string | null }).question).toBeNull();

  const plan = join(tmpDir, ".keeper");
  mkdirSync(join(plan, "state", "epics"), { recursive: true });
  const statePath = join(plan, "state", "epics", "fn-1-x.state.json");
  writeFileSync(statePath, JSON.stringify({ question: "ship or hold?" }));
  scanner.onChange(statePath);
  expect(emitted.length).toBe(2);
  expect((emitted[1] as { id: string; question: string | null }).id).toBe(
    "fn-1-x",
  );
  expect((emitted[1] as { question: string | null }).question).toBe(
    "ship or hold?",
  );

  // An identical re-write is suppressed by the change-gate (cached value
  // unchanged).
  writeFileSync(statePath, JSON.stringify({ question: "ship or hold?" }));
  scanner.onChange(statePath);
  expect(emitted.length).toBe(2);

  // Deleting the sidecar reverts the question to null and re-emits.
  unlinkSync(statePath);
  scanner.onDelete(statePath);
  expect(emitted.length).toBe(3);
  expect((emitted[2] as { question: string | null }).question).toBeNull();
});

// ---------------------------------------------------------------------------
// (a'''') fn-681 shallow `.keeper` discovery + periodic reconcile backstop
// — the cheap convergence layer that catches a brand-new repo's first
// scaffold (git-worker isn't watching the repo's `.git` yet, so the commit
// path can't fire) and the drop-recovery rescan (now O(#projects), not the
// whole `~/code` tree). All paths are ADDITIVE — they NEVER tombstone an
// epic, so a transient read failure can't produce a false retraction.
// ---------------------------------------------------------------------------

test("discoverPlanDirs: finds <root>/<project>/.keeper exactly one level deep", () => {
  // Real layout the heartbeat needs to cover: each project sits as a top-
  // level dir under the watched root, with its `.keeper` immediately
  // inside. A bare root with no project dirs returns [].
  const projA = join(tmpDir, "proja");
  const projB = join(tmpDir, "projb");
  mkdirSync(join(projA, ".keeper", "epics"), { recursive: true });
  mkdirSync(join(projB, ".keeper", "tasks"), { recursive: true });
  // A project WITHOUT `.keeper` is silently skipped (the common case for
  // unrelated repos under a broad root like `~/code`).
  mkdirSync(join(tmpDir, "projc"), { recursive: true });

  const dirs = discoverPlanDirs([tmpDir]);
  expect(dirs.sort()).toEqual(
    [join(projA, ".keeper"), join(projB, ".keeper")].sort(),
  );
});

test("discoverPlanDirs: prunes node_modules/.git (no descent through heavy vendored trees)", () => {
  // A stray `.keeper` buried inside `node_modules/<pkg>/` MUST NOT be
  // discovered — the prune set is what keeps the shallow walk cheap. A
  // sibling `.git` dir is excluded for the same reason.
  for (const heavy of ["node_modules", ".git", "dist", "target"]) {
    const dir = join(tmpDir, heavy, "pkg", ".keeper", "epics");
    mkdirSync(dir, { recursive: true });
  }
  // A real project alongside them IS found.
  mkdirSync(join(tmpDir, "real", ".keeper"), { recursive: true });

  const dirs = discoverPlanDirs([tmpDir]);
  expect(dirs).toEqual([join(tmpDir, "real", ".keeper")]);
});

test("discoverPlanDirs: a missing root skip-and-logs and yields no entries", () => {
  // Missing roots must not throw — the shallow walk mirrors `scanRoot`'s
  // skip-and-log discipline. (Stderr is captured in production via the
  // module log; here we just assert the call doesn't throw and returns
  // entries only for the real root.)
  mkdirSync(join(tmpDir, "real", ".keeper"), { recursive: true });
  const ghost = join(tmpDir, "does-not-exist");

  const dirs = discoverPlanDirs([ghost, tmpDir]);
  expect(dirs).toEqual([join(tmpDir, "real", ".keeper")]);
});

test("discoverPlanDirs: does NOT recurse — a project nested 2 levels deep is out of scope", () => {
  // The shallow walk is exactly one level. A `.keeper` under
  // `<root>/group/<project>/.keeper` is intentionally NOT discovered —
  // the recursive boot scan and the live FSEvents watch cover that case;
  // the heartbeat backstop trades coverage of unusual nesting for
  // predictable O(#projects) cost.
  mkdirSync(join(tmpDir, "group", "nested", ".keeper"), { recursive: true });
  mkdirSync(join(tmpDir, "flat", ".keeper"), { recursive: true });

  const dirs = discoverPlanDirs([tmpDir]);
  expect(dirs).toEqual([join(tmpDir, "flat", ".keeper")]);
});

// fn-737 reflog watch-set wiring, extracted to PURE module-scope helpers
// (fn-752) so the "which repos get watched" logic stays covered after the live
// spawned-Worker reflog tests are deleted in `.2`. No Worker, no
// `@parcel/watcher`, no real `~/code` access — just tmp files + plain sets.

test("resolveReflogTarget: prefers .git/logs/HEAD when present", () => {
  // A repo with reflogs ON has `.git/logs/HEAD` — the strong signal (appended
  // on every commit). Write both files; the ladder must pick logs/HEAD first.
  mkdirSync(join(tmpDir, ".git", "logs"), { recursive: true });
  writeFileSync(join(tmpDir, ".git", "logs", "HEAD"), "");
  writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");

  expect(resolveReflogTarget(tmpDir)).toBe(
    join(tmpDir, ".git", "logs", "HEAD"),
  );
});

test("resolveReflogTarget: falls back to .git/HEAD when logs/HEAD is absent", () => {
  // Reflogs OFF (`core.logAllRefUpdates=false`, no `.git/logs/HEAD`): the
  // weaker `.git/HEAD` fallback (rewritten on branch-switch) is the target.
  mkdirSync(join(tmpDir, ".git"), { recursive: true });
  writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");

  expect(resolveReflogTarget(tmpDir)).toBe(join(tmpDir, ".git", "HEAD"));
});

test("resolveReflogTarget: returns null when neither file exists", () => {
  // Neither `.git/logs/HEAD` nor `.git/HEAD` (not a git repo, or a torn-down
  // `.git`): no reflog watch — the worker degrades to the heartbeat floor.
  expect(resolveReflogTarget(tmpDir)).toBeNull();
});

test("discoverPlanRepos: returns the repo roots (parents of discovered .keeper dirs)", () => {
  // Each `<root>/<project>/.keeper` parent IS its repo root. Build a couple of
  // real `.keeper` trees under a tmp root (no real `~/code` touched) and
  // confirm the FS wrapper yields the project dirs, not the `.keeper` dirs.
  const projA = join(tmpDir, "proja");
  const projB = join(tmpDir, "projb");
  mkdirSync(join(projA, ".keeper", "epics"), { recursive: true });
  mkdirSync(join(projB, ".keeper", "tasks"), { recursive: true });
  // A project WITHOUT `.keeper` contributes no repo.
  mkdirSync(join(tmpDir, "projc"), { recursive: true });

  const repos = discoverPlanRepos([tmpDir]);
  expect([...repos].sort()).toEqual([projA, projB].sort());
});

test("desiredReflogRepos: the union of pending repos and discovered plan repos", () => {
  // The fn-737 widening: watch every pending repo UNION every discovered
  // `.keeper` repo. A repo present in BOTH inputs appears once (set union).
  const pending = new Set(["/r/a", "/r/b"]);
  const discovered = new Set(["/r/b", "/r/c"]);

  const desired = desiredReflogRepos(pending, discovered);
  expect([...desired].sort()).toEqual(["/r/a", "/r/b", "/r/c"]);
  // READ-only: the inputs are not mutated.
  expect([...pending].sort()).toEqual(["/r/a", "/r/b"]);
  expect([...discovered].sort()).toEqual(["/r/b", "/r/c"]);
});

test("reflogWatchDiff: toAdd = desired - live, toDrop = live - desired", () => {
  // The watch-set reconcile diff. `/r/new` is desired but not yet live (add);
  // `/r/gone` is live but no longer desired — e.g. a removed `.keeper` repo —
  // so it lands in toDrop; `/r/keep` is in both (no churn).
  const desired = new Set(["/r/keep", "/r/new"]);
  const live = new Set(["/r/keep", "/r/gone"]);

  const { toAdd, toDrop } = reflogWatchDiff(desired, live);
  expect([...toAdd]).toEqual(["/r/new"]);
  expect([...toDrop]).toEqual(["/r/gone"]);
  // READ-only: neither input set is mutated.
  expect([...desired].sort()).toEqual(["/r/keep", "/r/new"]);
  expect([...live].sort()).toEqual(["/r/gone", "/r/keep"]);
});

test("reflogWatchDiff: a removed .keeper repo lands in toDrop (drops its watch)", () => {
  // The drop-side of the fn-737 lifecycle: a repo that held a `.keeper` tree
  // (so it was watched) no longer appears in the desired union, so its live
  // subscription must be reclaimed.
  const desired = new Set<string>(); // nothing pending, no `.keeper` repos
  const live = new Set(["/r/removed"]);

  const { toAdd, toDrop } = reflogWatchDiff(desired, live);
  expect([...toAdd]).toEqual([]);
  expect([...toDrop]).toEqual(["/r/removed"]);
});

// ---------------------------------------------------------------------------
// fn-788 mute-watcher re-arm — the PURE decision helpers + the per-root
// attribution out-param. The heartbeat flags exactly the rescued configured
// root(s); the drain tears down + re-subscribes each sequentially with the
// identical options, bounded by MAX_SUBSCRIBES_PER_CYCLE. These tests cover the
// decision surface only — no live-watcher tests (the sequential teardown / flap
// guard / generation guard are exercised by the slow-tier worker integration).
// ---------------------------------------------------------------------------

test("decidePlanResubscribe: an empty flag set yields no tear-downs", () => {
  expect(
    decidePlanResubscribe(new Set<string>(), MAX_SUBSCRIBES_PER_CYCLE),
  ).toEqual([]);
});

test("decidePlanResubscribe: returns the flagged roots in insertion order (deterministic drain)", () => {
  const flagged = new Set(["/code", "/work", "/other"]);
  // Under the cap → every flagged root drains this cycle, in insertion order.
  expect(decidePlanResubscribe(flagged, MAX_SUBSCRIBES_PER_CYCLE)).toEqual([
    "/code",
    "/work",
    "/other",
  ]);
  // READ-only: the flag set is not mutated by the decision (the caller owns the
  // one-shot clear as it drains).
  expect([...flagged]).toEqual(["/code", "/work", "/other"]);
});

test("decidePlanResubscribe: caps at MAX per cycle; the overflow stays flagged for the next drain", () => {
  // Flag one more than the cap — only the first `cap` drain this cycle.
  const flagged = new Set(
    Array.from({ length: MAX_SUBSCRIBES_PER_CYCLE + 3 }, (_, i) => `/r/${i}`),
  );
  const toRearm = decidePlanResubscribe(flagged, MAX_SUBSCRIBES_PER_CYCLE);
  expect(toRearm.length).toBe(MAX_SUBSCRIBES_PER_CYCLE);
  expect(toRearm[0]).toBe("/r/0");
  expect(toRearm[MAX_SUBSCRIBES_PER_CYCLE - 1]).toBe(
    `/r/${MAX_SUBSCRIBES_PER_CYCLE - 1}`,
  );
  // The overflow (`/r/16`, `/r/17`, `/r/18`) is NOT in this drain — it stays in
  // the flag set for the next cycle (the caller deletes only what it drains).
  expect(toRearm).not.toContain(`/r/${MAX_SUBSCRIBES_PER_CYCLE}`);
});

test("decidePlanResubscribe: a zero/negative cap drains nothing (defensive clamp)", () => {
  const flagged = new Set(["/r/a", "/r/b"]);
  expect(decidePlanResubscribe(flagged, 0)).toEqual([]);
  expect(decidePlanResubscribe(flagged, -5)).toEqual([]);
});

test("attributePlanDirToRoot: a discovered .keeper dir maps back to its configured root", () => {
  // The heartbeat scan surfaces <root>/<project>/.keeper; the re-arm operates
  // on the broad CONFIGURED root (the subscription key), so the dir must
  // attribute back to it.
  expect(
    attributePlanDirToRoot("/code/keeper/.keeper", ["/code", "/work"]),
  ).toBe("/code");
  expect(attributePlanDirToRoot("/work/proj/.keeper", ["/code", "/work"])).toBe(
    "/work",
  );
});

test("attributePlanDirToRoot: the LONGEST matching configured root wins (nested root over its ancestor)", () => {
  // A configured nested root (`/code/keeper`) and a broad ancestor (`/code`)
  // both contain the dir — the subscription that actually covers it is the
  // nested one, so attribute to the longest prefix.
  expect(
    attributePlanDirToRoot("/code/keeper/sub/.keeper", [
      "/code",
      "/code/keeper",
    ]),
  ).toBe("/code/keeper");
});

test("attributePlanDirToRoot: a dir under no configured root attributes to null (no mis-attribution)", () => {
  expect(
    attributePlanDirToRoot("/elsewhere/proj/.keeper", ["/code", "/work"]),
  ).toBeNull();
  // A root that is a substring-but-not-path-prefix must NOT match (`/cod` is not
  // a path ancestor of `/code/...`).
  expect(attributePlanDirToRoot("/code/x/.keeper", ["/cod"])).toBeNull();
});

test("reconcilePlanDirs(emittedRoots): only the configured root whose scan emitted is reported; a quiescent root is not", () => {
  // Two configured roots; only rootA has a fresh scaffold to emit. The
  // attribution out-param must carry rootA ONLY — a healthy (quiescent) root is
  // never flagged for a re-arm.
  const rootA = mkdtempSync(join(tmpdir(), "keeper-plan-attrA-"));
  const rootB = mkdtempSync(join(tmpdir(), "keeper-plan-attrB-"));
  try {
    mkdirSync(join(rootA, "p", ".keeper", "epics"), { recursive: true });
    // rootB holds a `.keeper` tree too, but it is EMPTY (nothing to emit).
    mkdirSync(join(rootB, "q", ".keeper", "epics"), { recursive: true });
    writeFileSync(
      join(rootA, "p", ".keeper", "epics", "fn-1-a.json"),
      JSON.stringify({ id: "fn-1-a", title: "A", status: "open" }),
    );

    const emitted: PlanMessage[] = [];
    const scanner = new PlanScanner(
      (m) => emitted.push(m),
      () => {},
    );

    const emittedRoots = new Set<string>();
    const rescued = reconcilePlanDirs(
      [rootA, rootB],
      scanner,
      "heartbeat",
      undefined,
      emittedRoots,
    );
    // Aggregate boolean unchanged (rootA emitted) — byte-compatible for the
    // backstop record.
    expect(rescued).toBe(true);
    // Attribution: rootA implicated (its scan emitted), rootB NOT (quiescent).
    expect([...emittedRoots]).toEqual([rootA]);

    // No-phantom-re-fold: a SECOND reconcile over the unchanged tree (the
    // post-re-arm full rescan) emits nothing — the PlanScanner change-gate is
    // preserved across a (simulated) re-arm, so no plan re-emits.
    const emitted2: PlanMessage[] = [];
    const scanner2Roots = new Set<string>();
    const before = emitted.length;
    reconcilePlanDirs(
      [rootA, rootB],
      scanner,
      "heartbeat",
      undefined,
      scanner2Roots,
    );
    expect(emitted.length).toBe(before); // change-gate suppressed the re-emit
    expect([...scanner2Roots]).toEqual([]); // nothing emitted → nothing flagged
    expect(emitted2).toEqual([]);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("reconcilePlanDirs: a new-repo first scaffold converges on one call (no FSEvents, no DB row)", () => {
  // The exact bug fn-681 fixes: a fresh repo's first `keeper plan scaffold` is
  // dropped by FSEvents AND git-worker isn't yet watching the repo's
  // `.git` (no epic row drives `discoverProjectRoots`). The periodic
  // reconcile must converge it from disk alone, on a single tick.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // Layout: <root>/freshrepo/.keeper/epics/<id>.json — what `plan
  // scaffold` writes on first use.
  const proj = join(tmpDir, "freshrepo");
  mkdirSync(join(proj, ".keeper", "epics"), { recursive: true });
  mkdirSync(join(proj, ".keeper", "tasks"), { recursive: true });
  writeFileSync(
    join(proj, ".keeper", "epics", "fn-99-fresh.json"),
    JSON.stringify({ id: "fn-99-fresh", title: "Fresh", status: "open" }),
  );
  writeFileSync(
    join(proj, ".keeper", "tasks", "fn-99-fresh.1.json"),
    JSON.stringify({ id: "fn-99-fresh.1", epic: "fn-99-fresh", title: "T" }),
  );

  reconcilePlanDirs([tmpDir], scanner);
  expect(emitted.map((m) => m.id).sort()).toEqual([
    "fn-99-fresh",
    "fn-99-fresh.1",
  ]);
});

test("reconcilePlanDirs: an in-sync reconcile emits nothing (change-gate)", () => {
  // The steady-state cost: after one converged ingest, every subsequent
  // reconcile over unchanged bytes is a stat/read/parse + change-gate
  // suppress. Zero re-emits.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const proj = join(tmpDir, "p");
  mkdirSync(join(proj, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(proj, ".keeper", "epics", "fn-1-x.json"),
    JSON.stringify({ id: "fn-1-x", title: "X", status: "open" }),
  );

  reconcilePlanDirs([tmpDir], scanner);
  expect(emitted.length).toBe(1);

  // Second reconcile over the same warm scanner: zero deltas.
  reconcilePlanDirs([tmpDir], scanner);
  expect(emitted.length).toBe(1);

  // A real change DOES emit on the next reconcile (the change-gate is the
  // gate, not a one-shot mute).
  writeFileSync(
    join(proj, ".keeper", "epics", "fn-1-x.json"),
    JSON.stringify({ id: "fn-1-x", title: "X", status: "done" }),
  );
  reconcilePlanDirs([tmpDir], scanner);
  expect(emitted.length).toBe(2);
});

test("reconcilePlanDirs: ADDITIVE — does NOT retract existing epics (no false tombstones)", () => {
  // The load-bearing safety property: the periodic reconcile must NEVER
  // emit a `plan-epic-deleted` or `plan-task-deleted`. Deletions stay
  // owned exclusively by the commit path (`plan-commit-changed`,
  // `git rm` → zero-oid sentinel), the live `onDelete` FSEvents arm, and
  // the one-shot boot {@link PlanScanner.sweep}. A reconcile run with the
  // file still present (or temporarily missing) must not produce a
  // tombstone message.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const proj = join(tmpDir, "p");
  mkdirSync(join(proj, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(proj, ".keeper", "epics", "fn-1-x.json"),
    JSON.stringify({ id: "fn-1-x", title: "X", status: "open" }),
  );

  reconcilePlanDirs([tmpDir], scanner);
  expect(emitted.length).toBe(1);
  expect(emitted[0]?.kind).toBe("plan-epic");

  // Delete the file on disk, then reconcile: the periodic path does NOT
  // run a sweep, so no tombstone fires. (A real deletion is caught by
  // the commit channel or live FSEvents.)
  unlinkSync(join(proj, ".keeper", "epics", "fn-1-x.json"));
  reconcilePlanDirs([tmpDir], scanner);
  // Still 1 emit — no `plan-epic-deleted` message added.
  expect(emitted.length).toBe(1);
  expect(emitted.every((m) => m.kind !== "plan-epic-deleted")).toBe(true);
});

test("reconcilePlanDirs: on-drop callback is `.keeper`-scoped (visits only project `.keeper`s, NOT the whole root tree)", () => {
  // The on-drop {@link RescanScheduler} callback was repointed from
  // `scanRoot(root, scanner)` (whole-tree walk) to
  // `reconcilePlanDirs([root], scanner)` (`.keeper` dirs only).
  // Confirm the semantic difference: a heavy non-plan subtree under
  // the root must NOT be visited by the reconcile path. The proof: an
  // epic NOT under any `.keeper/epics/` is invisible to the reconcile,
  // while the same epic in a real `.keeper` IS picked up. This is the
  // O(#projects) vs O(`~/code` tree) cost difference.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // A real plan-bearing project (the reconcile target).
  const proj = join(tmpDir, "real");
  mkdirSync(join(proj, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(proj, ".keeper", "epics", "fn-1-real.json"),
    JSON.stringify({ id: "fn-1-real", title: "Real", status: "open" }),
  );

  // A stray `.keeper`-look-alike nested deeper than one level — the
  // recursive {@link scanRoot} would discover this; the shallow
  // reconcile does NOT.
  const nested = join(tmpDir, "group", "nested-proj");
  mkdirSync(join(nested, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(nested, ".keeper", "epics", "fn-2-nested.json"),
    JSON.stringify({ id: "fn-2-nested", title: "Nested", status: "open" }),
  );

  reconcilePlanDirs([tmpDir], scanner);
  // Only the top-level project's epic was reached — the nested one is
  // out of scope for the on-drop path (covered by live FSEvents and the
  // boot scan).
  expect(emitted.map((m) => m.id)).toEqual(["fn-1-real"]);
});

test("reconcilePlanDirs: covers multiple roots in one call", () => {
  // The heartbeat passes the worker's entire `data.roots` array — a multi-
  // root deployment must reconcile each independently. A failure to read
  // one root is independent of the others.
  const rootA = mkdtempSync(join(tmpdir(), "keeper-plan-rootA-"));
  const rootB = mkdtempSync(join(tmpdir(), "keeper-plan-rootB-"));
  try {
    mkdirSync(join(rootA, "p", ".keeper", "epics"), { recursive: true });
    mkdirSync(join(rootB, "q", ".keeper", "epics"), { recursive: true });
    writeFileSync(
      join(rootA, "p", ".keeper", "epics", "fn-1-a.json"),
      JSON.stringify({ id: "fn-1-a", title: "A", status: "open" }),
    );
    writeFileSync(
      join(rootB, "q", ".keeper", "epics", "fn-1-b.json"),
      JSON.stringify({ id: "fn-1-b", title: "B", status: "open" }),
    );

    const emitted: PlanMessage[] = [];
    const scanner = new PlanScanner(
      (m) => emitted.push(m),
      () => {},
    );

    reconcilePlanDirs([rootA, rootB], scanner);
    expect(emitted.map((m) => m.id).sort()).toEqual(["fn-1-a", "fn-1-b"]);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a''') fn-629 observation gate — plan-worker emits epic/task snapshots ONLY
// for files in git HEAD. Uncommitted files land in the pending set; a
// `recheckPending()` (driven by the live worker on every git-worker snapshot
// pulse, since `git commit` does not change file content and FSEvents will
// not re-fire on the worktree path) drains the set once the file is
// committed.
// ---------------------------------------------------------------------------

test("repoRootFromPlanPath: walks up to .keeper's parent (the repo root)", () => {
  // Pure path arithmetic — no I/O required.
  expect(repoRootFromPlanPath("/a/b/proj/.keeper/epics/fn-1-x.json")).toBe(
    "/a/b/proj",
  );
  expect(repoRootFromPlanPath("/a/b/proj/.keeper/tasks/fn-1-x.2.json")).toBe(
    "/a/b/proj",
  );
  // No .keeper in the ancestry → null.
  expect(repoRootFromPlanPath("/a/b/proj/foo/fn-1-x.json")).toBeNull();
});

// ---------------------------------------------------------------------------
// fn-759: the cheap change-gate runs BEFORE the fn-629 in-HEAD probe, so an
// unchanged re-scan never forks `git cat-file -e`. These cases spy on the
// injected `isTracked` predicate (3rd ctor arg) to PIN that the probe fires
// only on changed / first-seen snapshots, without weakening the gate
// bookkeeping invariants (plan-worker.ts onChange doc block).
// ---------------------------------------------------------------------------

test("fn-759: unchanged re-scan calls isTracked zero times and emits nothing", () => {
  const emitted: PlanMessage[] = [];
  const probed: string[] = [];
  // A committed-everywhere spy: tracks every probe but always returns true so
  // the first emit lands; the SECOND (unchanged) scan must not reach it.
  const isTracked = (path: string): boolean => {
    probed.push(path);
    return true;
  };
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
    isTracked,
  );

  const path = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });

  // First scan: changed (first-seen) → probe fires once, emits.
  scanner.onChange(path);
  expect(emitted.length).toBe(1);
  expect(probed).toEqual([path]);

  // Unchanged re-scan: the change-gate suppresses BEFORE the probe — isTracked
  // is NOT called again, and nothing emits.
  scanner.onChange(path);
  expect(emitted.length).toBe(1);
  expect(probed).toEqual([path]); // still exactly one probe, total.
});

test("fn-759: first-seen uncommitted lands pending; isTracked fires; lastEmitted untouched (gate semantics preserved)", () => {
  const emitted: PlanMessage[] = [];
  const probed: string[] = [];
  const isTracked = (path: string): boolean => {
    probed.push(path);
    return false; // not in HEAD → gated.
  };
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
    isTracked,
  );

  const path = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });

  // First-seen, uncommitted: change-gate has no entry → probe fires → gated.
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(probed).toEqual([path]);
  expect(scanner.pendingSize()).toBe(1);

  // A re-scan of the SAME uncommitted content must NOT be suppressed by the
  // change-gate — a gated path never earned a lastEmitted entry, so the probe
  // fires AGAIN (re-confirming HEAD-membership). This is the fn-627/fn-629
  // pin: advancing lastEmitted before the probe would make the post-commit
  // drain see "unchanged" and never emit.
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(probed).toEqual([path, path]); // probed twice — gate did NOT shortcut.
  expect(scanner.pendingSize()).toBe(1);
});

test("fn-759: changed committed snapshot probes once per change and emits", () => {
  const emitted: PlanMessage[] = [];
  const probed: string[] = [];
  const isTracked = (path: string): boolean => {
    probed.push(path);
    return true;
  };
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
    isTracked,
  );

  const path = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });

  scanner.onChange(path);
  expect(emitted.length).toBe(1);
  expect(probed.length).toBe(1);

  // Real content change (status flip) → change-gate misses → probe fires
  // again, emits the new snapshot.
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
  expect(probed.length).toBe(2);
  expect((emitted[1] as { status: string }).status).toBe("done");
});

test("fn-759: boot-seed asymmetry — seeded lastEmitted + empty pathToId → unchanged scan still routes a later delete tombstone", () => {
  const emitted: PlanMessage[] = [];
  const probed: string[] = [];
  const isTracked = (path: string): boolean => {
    probed.push(path);
    return true;
  };
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
    isTracked,
  );

  const path = writeEpic("fn-3-demo", {
    title: "Demo",
    status: "open",
    primary_repo: "/repo",
  });

  // Simulate boot: seed the change-gate from the projection (matching the
  // serialization onChange would produce) WITHOUT populating pathToId — the
  // boot-seed asymmetry the unchanged-branch pathToId.set guards against.
  const expectedMsg: PlanMessage = {
    kind: "plan-epic",
    id: "fn-3-demo",
    number: 3,
    title: "Demo",
    projectDir: "/repo",
    status: "open",
    dependsOnEpics: [],
    lastValidatedAt: null,
    question: null,
    blocksClosingOf: null,
  };
  scanner.seed("fn-3-demo", JSON.stringify(expectedMsg));

  // Boot scan reads the unchanged file: change-gate suppresses (no emit, no
  // probe), but pathToId IS populated on this branch.
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(probed).toEqual([]); // unchanged → probe never forked.

  // Now delete the file. Without the unchanged-branch pathToId.set, onDelete
  // would find no id and emit no tombstone — a permanent projection ghost.
  // With it, the tombstone fires.
  scanner.onDelete(path);
  expect(emitted.length).toBe(1);
  expect(emitted[0]).toEqual({ kind: "plan-epic-deleted", id: "fn-3-demo" });
});

test("pendingRepos: derives repo roots from pending paths; empties as paths drain (fn-705)", () => {
  // Pure-core: drive the gate with an always-untracked predicate so every
  // onChange bounces to pending, and assert pendingRepos() reflects the repo
  // roots the live worker watches `.git/logs/HEAD` for.
  const scanner = new PlanScanner(
    () => {},
    () => {},
    () => false, // nothing is in HEAD → everything pends
  );

  // Two distinct repos, each with one epic file (paths need a `.keeper`
  // ancestor for repoRootFromPlanPath to resolve; the files need not exist
  // on disk because the untracked predicate short-circuits before any read…
  // but onChange DOES read the file, so write them under tmpDir).
  const repoA = join(tmpDir, "repoA");
  const repoB = join(tmpDir, "repoB");
  const epicA = join(repoA, ".keeper", "epics", "fn-1-a.json");
  const epicB = join(repoB, ".keeper", "epics", "fn-2-b.json");
  mkdirSync(join(repoA, ".keeper", "epics"), { recursive: true });
  mkdirSync(join(repoB, ".keeper", "epics"), { recursive: true });
  writeFileSync(epicA, JSON.stringify({ id: "fn-1-a", title: "A" }));
  writeFileSync(epicB, JSON.stringify({ id: "fn-2-b", title: "B" }));

  expect(scanner.pendingRepos().size).toBe(0);

  scanner.onChange(epicA);
  expect([...scanner.pendingRepos()]).toEqual([repoA]);

  scanner.onChange(epicB);
  expect(scanner.pendingRepos()).toEqual(new Set([repoA, repoB]));

  // Drop one pending path via onDelete (unwind) — repoA leaves the set.
  unlinkSync(epicA);
  scanner.onDelete(epicA);
  expect([...scanner.pendingRepos()]).toEqual([repoB]);

  unlinkSync(epicB);
  scanner.onDelete(epicB);
  expect(scanner.pendingRepos().size).toBe(0);
});

test("onPendingChange observer fires on every pending mutation (fn-705 reflog-watch driver)", () => {
  // The live worker passes this observer to reconcile its `.git/logs/HEAD`
  // watches; assert it fires on both the gate-fail add AND the drain delete.
  let calls = 0;
  const scanner = new PlanScanner(
    () => {},
    () => {},
    () => false,
    undefined, // fn-712: isTrackedBatch slot — default per-path fallback.
    () => {
      calls += 1;
    },
  );

  const repo = join(tmpDir, "repo");
  const epicPath = join(repo, ".keeper", "epics", "fn-1-x.json");
  mkdirSync(join(repo, ".keeper", "epics"), { recursive: true });
  writeFileSync(epicPath, JSON.stringify({ id: "fn-1-x", title: "X" }));

  scanner.onChange(epicPath); // gate-fail add → fires
  expect(calls).toBe(1);
  expect(scanner.pendingRepos().has(repo)).toBe(true);

  unlinkSync(epicPath);
  scanner.onDelete(epicPath); // pending drop → fires
  expect(calls).toBe(2);
  expect(scanner.pendingRepos().size).toBe(0);
});

test("onChange(triggeredByCommit=true): emits WITHOUT invoking isPathInHead (fn-701 commit bypass)", () => {
  // No git tree at all — the gate probe is the ONLY thing that would block,
  // and the commit bypass must skip it. We inject an `isTracked` that THROWS
  // if called, so the test fails loudly if the bypass regresses to re-probing.
  const emitted: PlanMessage[] = [];
  let probed = false;
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
    () => {
      probed = true;
      throw new Error("isPathInHead must NOT be called on the commit path");
    },
  );

  // Write an UNCOMMITTED epic file — a gated onChange would bounce it to
  // pending; the commit-driven bypass must emit it directly.
  const epicPath = writeEpic("fn-7-bypass", {
    title: "Bypass",
    status: "open",
    primary_repo: tmpDir,
  });

  const didEmit = scanner.onChange(epicPath, true);
  expect(didEmit).toBe(true);
  expect(probed).toBe(false);
  expect(emitted.length).toBe(1);
  expect(emitted[0].kind).toBe("plan-epic");
  expect((emitted[0] as { id: string }).id).toBe("fn-7-bypass");
  expect(scanner.pendingSize()).toBe(0);
});

// ---------------------------------------------------------------------------
// (a''''') fn-705 fast `data_version` poll: db-poll trigger semantics +
// single-flight coalescing. The poll itself (timer + PRAGMA read) lives inside
// the worker `main`; here we exercise the PURE pieces it composes — the
// `reconcilePlanDirs(..., "db-poll")` trigger tag and the `makeSingleFlight`
// coalescing wrapper — and assert idempotency on repeated triggers. The
// realtime end-to-end behavior is covered by the spawned-Worker test below.
// ---------------------------------------------------------------------------

test("makeSingleFlight: a re-entrant trigger mid-work coalesces into EXACTLY ONE trailing re-run (fn-705)", () => {
  // The poll's coalescing contract: a `data_version` bump landing while the
  // previous bump's wake body runs must NOT queue a second full cycle — it
  // sets `wakePending` and the running cycle loops once more. We simulate the
  // re-entrancy by having `work` re-trigger on its FIRST run only.
  let runs = 0;
  let trigger: () => void = () => {};
  trigger = makeSingleFlight(
    () => {
      runs += 1;
      if (runs === 1) {
        // A bump arrives mid-work. The guard sets `wakePending`; the running
        // cycle loops once more — NOT a re-entrant second cycle.
        trigger();
      }
    },
    () => false,
  );

  trigger();
  // One outer call + one re-entrant call = exactly two body runs (the trailing
  // coalesced re-run), never three+ and never a queued backlog.
  expect(runs).toBe(2);

  // A burst of triggers after the cycle is idle each run once (no in-flight to
  // coalesce against), proving the guard only coalesces CONCURRENT triggers.
  trigger();
  trigger();
  expect(runs).toBe(4);
});

test("makeSingleFlight: a burst of triggers DURING one cycle yields one trailing re-run, not a queue (fn-705)", () => {
  let runs = 0;
  let trigger: () => void = () => {};
  trigger = makeSingleFlight(
    () => {
      runs += 1;
      if (runs === 1) {
        // Five bumps land mid-work — they must collapse to a SINGLE trailing
        // re-run, not five queued cycles.
        trigger();
        trigger();
        trigger();
        trigger();
        trigger();
      }
    },
    () => false,
  );

  trigger();
  expect(runs).toBe(2);
});

test("makeSingleFlight: a throw in work is swallowed (log+continue) and never wedges the loop or leaks the in-flight guard (fn-705)", () => {
  const errors: unknown[] = [];
  let runs = 0;
  const trigger = makeSingleFlight(
    () => {
      runs += 1;
      throw new Error("boom");
    },
    () => false,
    (err) => errors.push(err),
  );

  // First trigger throws — swallowed via onError, guard cleared by `finally`.
  trigger();
  expect(runs).toBe(1);
  expect(errors.length).toBe(1);

  // A subsequent trigger still runs (the guard did not leak), proving a throw
  // doesn't wedge the poll loop.
  trigger();
  expect(runs).toBe(2);
  expect(errors.length).toBe(2);
});

test("makeSingleFlight: isShutdown short-circuits the trailing re-run (fn-705)", () => {
  let runs = 0;
  let shuttingDown = false;
  let trigger: () => void = () => {};
  trigger = makeSingleFlight(
    () => {
      runs += 1;
      if (runs === 1) {
        // A bump lands mid-work, then shutdown is requested. The trailing
        // re-run must NOT fire against a closing worker.
        trigger();
        shuttingDown = true;
      }
    },
    () => shuttingDown,
  );

  trigger();
  expect(runs).toBe(1);
});

test("PLAN_DB_POLL_MS is the documented 25ms-floor cadence (mirrors git-worker DB_POLL_MS)", () => {
  // The poll must not run faster than the 25ms macOS-kqueue floor and matches
  // the sibling producer's cadence so all workers share one schedule.
  expect(PLAN_DB_POLL_MS).toBe(100);
  expect(PLAN_DB_POLL_MS).toBeGreaterThanOrEqual(25);
});

// ---------------------------------------------------------------------------
// fn-712: batched + scoped recheck. `isPathInHeadBatch` probes a whole repo's
// pending paths in ONE `git cat-file --batch-check` spawn (fail-closed on any
// anomaly), and `recheckPending(root?)` scopes the drain to a single repo and
// batches one git call per repo instead of one per path (the ~74s storm fix).
// ---------------------------------------------------------------------------

test("recheckPending(root): batched, ONE git call per repo, not per path (fn-712 storm fix)", () => {
  // Inject a SPY batch predicate so we can assert exactly how many times it
  // fires and with how many rels — proving one batched call per repo, never a
  // per-path spawn. The per-path `isTracked` is set to throw so a regression to
  // the old per-path loop fails loudly.
  const calls: { root: string; relCount: number }[] = [];
  const emitted: PlanMessage[] = [];
  // During setup the per-path predicate bounces files into pending (returns
  // false). Once `forbidPerPath` flips, ANY per-path call is a regression to
  // the old per-path loop and throws loudly.
  let forbidPerPath = false;
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
    () => {
      if (forbidPerPath) {
        throw new Error(
          "per-path isTracked must NOT be called by recheckPending",
        );
      }
      return false; // setup: bounce to pending
    },
    (root, rels) => {
      // Record the call shape, then report NOTHING in-HEAD — so the drain
      // never re-enters onChange (which would hit the throwing per-path
      // predicate). This isolates the BATCH behavior: we assert one call per
      // repo carrying all that repo's rels, never a per-path probe.
      calls.push({ root, relCount: rels.length });
      return rels.map(() => false);
    },
  );

  // Two repos, three pending epics each (six files → would be six per-path
  // spawns under the old loop).
  const repoA = join(tmpDir, "repoA");
  const repoB = join(tmpDir, "repoB");
  for (const [repo, n] of [
    [repoA, 3],
    [repoB, 3],
  ] as const) {
    mkdirSync(join(repo, ".keeper", "epics"), { recursive: true });
    for (let i = 1; i <= n; i++) {
      const p = join(repo, ".keeper", "epics", `fn-${i}-x.json`);
      writeFileSync(p, JSON.stringify({ id: `fn-${i}-x`, title: "X" }));
      scanner.onChange(p); // bounces to pending (batch says false at drain time)
    }
  }
  expect(scanner.pendingSize()).toBe(6);

  // From here on, a per-path probe is forbidden — recheckPending must use the
  // batch predicate ONLY.
  forbidPerPath = true;

  // Scoped recheck: ONLY repoA's pending — ONE batched call with all 3 rels.
  calls.length = 0;
  scanner.recheckPending(repoA);
  expect(calls.length).toBe(1);
  expect(calls[0]?.root).toBe(repoA);
  expect(calls[0]?.relCount).toBe(3);

  // Global recheck (no root): ONE batched call PER repo (two repos → two
  // calls), each carrying its repo's 3 rels — never one call per path.
  calls.length = 0;
  scanner.recheckPending();
  expect(calls.length).toBe(2);
  expect(new Set(calls.map((c) => c.root))).toEqual(new Set([repoA, repoB]));
  expect(calls.every((c) => c.relCount === 3)).toBe(true);
});

test("default scanner (no isTracked) emits unconditionally — back-compat with pre-fn-629 tests", () => {
  // Construct without the predicate. The default `() => true` means a
  // freshly-written, uncommitted epic still emits — preserves the test
  // pattern every existing pure-core test uses.
  const emitted: PlanMessage[] = [];
  const scanner = new PlanScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const epicPath = writeEpic("fn-9-default", { title: "Default" });
  scanner.onChange(epicPath);
  expect(emitted.length).toBe(1);
  expect(emitted[0].kind).toBe("plan-epic");
  expect(scanner.pendingSize()).toBe(0);
});

// ---------------------------------------------------------------------------
// (z) fn-720 backstop telemetry — the plan-heartbeat / rescan-drop missed-wake
//     records + the denominator. Drives the pure `PlanScanner` primitives with
//     a synthetic clock + a captured `postBackstop` sink (no Worker, no bus).
// ---------------------------------------------------------------------------

/** A PlanScanner wired with a synthetic clock + record sink for backstop tests. */
function backstopScanner(): {
  scanner: PlanScanner;
  records: BackstopRecord[];
  rollups: BackstopRollup[];
  setNow: (ms: number) => void;
} {
  let now = 0;
  const records: BackstopRecord[] = [];
  const rollups: BackstopRollup[] = [];
  const post = (msg: BackstopMessage): void => {
    if (msg.record.kind === "backstop-rescue") records.push(msg.record);
    else rollups.push(msg.record);
  };
  const scanner = new PlanScanner(
    () => {},
    () => {},
    isPathInHead,
    isPathInHeadBatch,
    () => {},
    post,
    () => now,
  );
  const setNow = (ms: number): void => {
    now = ms;
  };
  return { scanner, records, rollups, setNow };
}

test("fn-720 plan-heartbeat: a fast-path stamp then a heartbeat rescue posts a missed-wake record with correct staleness", () => {
  const { scanner, records, setNow } = backstopScanner();
  // A db-poll fast path fired at t=1000.
  setNow(1000);
  scanner.markFastPath();
  // Heartbeat fires at t=61240 and the change-gated scan rescued (rescued=true).
  setNow(61240);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", true);

  expect(records).toHaveLength(1);
  expect(records[0]).toEqual({
    ts: 61240,
    kind: "backstop-rescue",
    class: "missed-wake",
    backstop: "plan-heartbeat",
    worker: "plan-worker",
    fast_path: "data_version_poll",
    rescued: true,
    staleness_ms: 60240, // 61240 - 1000
    last_fast_path_at: 1000,
  });
});

test("fn-720 plan-heartbeat: a no-op heartbeat posts NO record but still bumps the denominator", () => {
  const { scanner, records, rollups, setNow } = backstopScanner();
  setNow(5000);
  scanner.markFastPath();
  // A no-op heartbeat fire (rescued=false) writes no NDJSON line...
  setNow(10000);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", false);
  expect(records).toHaveLength(0);

  // ...but the denominator counts it (one no-op fire, zero rescues).
  setNow(10001);
  scanner.flushBackstopRollups();
  expect(rollups).toHaveLength(1);
  expect(rollups[0]).toEqual({
    ts: 10001,
    kind: "backstop-rollup",
    backstop: "plan-heartbeat",
    class: "missed-wake",
    fires_total: 1,
    rescues_total: 0,
  });
});

test("fn-720 plan-heartbeat: cold-boot heartbeat (no fast path yet) reports NULL staleness, not a giant false alarm", () => {
  const { scanner, records, setNow } = backstopScanner();
  // No markFastPath() ever — lastFastPathAt is null.
  setNow(999999);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", true);
  expect(records).toHaveLength(1);
  expect(records[0]?.staleness_ms).toBeNull();
  expect(records[0]?.last_fast_path_at).toBeNull();
});

test("fn-720 rescan-drop: an FSEvents-drop rescue posts a rescan-drop missed-wake record", () => {
  const { scanner, records, setNow } = backstopScanner();
  setNow(2000);
  scanner.markFastPath();
  setNow(7000);
  scanner.fireBackstop("rescan-drop", "fsevents", true);
  expect(records).toHaveLength(1);
  expect(records[0]?.backstop).toBe("rescan-drop");
  expect(records[0]?.fast_path).toBe("fsevents");
  expect(records[0]?.staleness_ms).toBe(5000);
});

test("fn-720 denominator: fires across both backstops snapshot to one rollup per (backstop,class)", () => {
  const { scanner, rollups, setNow } = backstopScanner();
  setNow(0);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", true);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", false);
  scanner.fireBackstop("rescan-drop", "fsevents", false);
  setNow(100);
  scanner.flushBackstopRollups();
  expect(rollups).toHaveLength(2);
  const plan = rollups.find((r) => r.backstop === "plan-heartbeat");
  const drop = rollups.find((r) => r.backstop === "rescan-drop");
  expect(plan).toEqual({
    ts: 100,
    kind: "backstop-rollup",
    backstop: "plan-heartbeat",
    class: "missed-wake",
    fires_total: 2,
    rescues_total: 1,
  });
  expect(drop?.fires_total).toBe(1);
  expect(drop?.rescues_total).toBe(0);
});

// ---------------------------------------------------------------------------
// (z2) fn-737 per-wake-path attribution — the missed-wake record now names
//      WHICH fast paths recently stamped (recent_fast_paths) and whether a
//      reflog watch was present, so a slow fold can be attributed to a coverage
//      gap (no reflog watch) vs an FSEvents-reliability miss. Producer-side
//      only — driven through the pure PlanScanner + buildMissedWakeRecord.
// ---------------------------------------------------------------------------

test("fn-737 attribution: a heartbeat rescue carries recent_fast_paths naming the labels that recently stamped (most-recent first, de-duped)", () => {
  const { scanner, records, setNow } = backstopScanner();
  // Three labelled fast-path stamps within the attribution window, db-poll
  // twice (the de-dup case).
  setNow(1000);
  scanner.markFastPath("db-poll");
  setNow(2000);
  scanner.markFastPath("fsevents");
  setNow(3000);
  scanner.markFastPath("db-poll");

  // Heartbeat fires at t=4000 — well inside the 60s window.
  setNow(4000);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", true);

  expect(records).toHaveLength(1);
  // Most-recent first, each label once: db-poll (t=3000) then fsevents (t=2000).
  expect(records[0]?.recent_fast_paths).toEqual(["db-poll", "fsevents"]);
});

test("fn-737 attribution: stamps older than the attribution window are pruned out of recent_fast_paths", () => {
  const { scanner, records, setNow } = backstopScanner();
  // A stamp far in the past (outside the 60s window when the heartbeat fires).
  setNow(0);
  scanner.markFastPath("db-poll");
  // A recent stamp inside the window.
  setNow(100_000);
  scanner.markFastPath("fsevents");

  // Heartbeat at t=100_001 — only the fsevents stamp is within the 60s window.
  setNow(100_001);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", true);
  expect(records[0]?.recent_fast_paths).toEqual(["fsevents"]);
});

test("fn-737 attribution: a missed-wake record with NO fast path in window OMITS recent_fast_paths (legacy shape preserved)", () => {
  const { scanner, records, setNow } = backstopScanner();
  // No markFastPath ever → cold boot.
  setNow(5000);
  scanner.fireBackstop("plan-heartbeat", "data_version_poll", true);
  expect(records).toHaveLength(1);
  // Field absent (not undefined-keyed) — exact legacy shape.
  expect("recent_fast_paths" in (records[0] as object)).toBe(false);
  expect("reflog_watch" in (records[0] as object)).toBe(false);
});

test("fn-737 attribution: buildMissedWakeRecord carries reflog_watch present|absent when supplied, omits it otherwise", () => {
  const present = buildMissedWakeRecord({
    backstop: "plan-heartbeat",
    worker: "plan-worker",
    fastPath: "data_version_poll",
    rescued: true,
    now: 10,
    lastFastPathAt: 5,
    reflogWatch: "present",
  });
  expect(present.reflog_watch).toBe("present");

  const absent = buildMissedWakeRecord({
    backstop: "plan-heartbeat",
    worker: "plan-worker",
    fastPath: "data_version_poll",
    rescued: true,
    now: 10,
    lastFastPathAt: 5,
    reflogWatch: "absent",
  });
  expect(absent.reflog_watch).toBe("absent");

  const omitted = buildMissedWakeRecord({
    backstop: "plan-heartbeat",
    worker: "plan-worker",
    fastPath: "data_version_poll",
    rescued: true,
    now: 10,
    lastFastPathAt: 5,
  });
  expect("reflog_watch" in omitted).toBe(false);
});

test("fn-737 attribution: an empty recentFastPaths array is omitted (no empty-array noise on the record)", () => {
  const rec = buildMissedWakeRecord({
    backstop: "plan-heartbeat",
    worker: "plan-worker",
    fastPath: "data_version_poll",
    rescued: true,
    now: 10,
    lastFastPathAt: 5,
    recentFastPaths: [],
  });
  expect("recent_fast_paths" in rec).toBe(false);
});

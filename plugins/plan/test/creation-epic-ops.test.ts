// Engine-agnostic conformance spec for the epic-graph + task-attribute mutating
// verbs — translated from tests/test_epic_add_dep.py, tests/test_epic_add_deps.py,
// tests/test_epic_close.py, tests/test_run_epic_queue_jump.py,
// tests/test_task_set_tier.py, and tests/test_set_primary_repo_warning.py. Every
// node is mapped by a source-comment (translated | cited bun unit | drop-with-
// reason).
//
// epic add-dep / add-deps: cycle rejection + rollback, per-edge status results
// (WIRED / ALREADY_PRESENT / SKIPPED_*), assert-all-no-partial-write, bare-fn-N
// normalization + the fn-1-vs-fn-10 prefix trap. epic close: closer_done_at-only
// stamp, the removed --no-audit-required flag, op=close envelope. queue-jump +
// set-tier core behavior is already pinned in verbs-restamp.test.ts — here only
// the error/validation/envelope nodes those files add are translated, the rest
// cited. set-primary-repo / set-touched-repos: the non-blocking warning contract
// (envelope.warnings + WARN: on stderr, write still lands, exit 0).
//
// Graph + close + queue-jump + set-tier run on the withProject handle (real git
// + planctl init) so the auto-commit is exercised honestly; the set-primary-repo
// / set-touched-repos warning tests run on a git-FREE planctl project (mirroring
// the Python _create_project, which never `git init`s) so the non-blocking
// warning path returns exit 0 without an auto-commit. Epics are minted via the
// real `epic create` primitive; tasks via the harness scaffoldEpic helper.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  firstJsonPayload,
  gitInit,
  type ProjectHandle,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
  withTmpdir,
} from "./harness.ts";

let project: ProjectHandle;
const getProject = withProject("planctl-epic-ops-");
beforeEach(() => {
  project = getProject();
});

function run(args: string[], env?: Record<string, string>) {
  return runCli(args, {
    cwd: project.root,
    home: project.home,
    env,
  });
}

// epic create primitive -> the allocated epic id. Port of the _create_epic helper.
function createEpic(title: string): string {
  const r = run(["epic", "create", "--title", title]);
  expect(r.code).toBe(0);
  return (firstJsonPayload(r.output).epic as Record<string, unknown>)
    .id as string;
}

function readEpic(epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "epics", `${epicId}.json`),
      "utf-8",
    ),
  );
}

// dep_id -> status map off the per-edge results list. Port of the {r["dep_id"]:
// r["status"]} comprehension the add-deps tests use.
function statusMap(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of payload.results as Record<string, unknown>[]) {
    out[r.dep_id as string] = r.status as string;
  }
  return out;
}

function countInvocationLines(output: string): number {
  return output
    .trim()
    .split("\n")
    .filter((ln) => ln.trim().startsWith("{") && ln.includes("plan_invocation"))
    .length;
}

// The bare-number form of a full slug (`fn-7-foo` -> `fn-7`). Replaces the
// python parse_id import — the number is the second dash-delimited field.
function bareNumber(epicId: string): string {
  return `fn-${epicId.split("-")[1]}`;
}

// ---------------------------------------------------------------------------
// epic add-dep (singular) — post-write cycle gate rejects + rolls back
// ---------------------------------------------------------------------------

describe("epic add-dep", () => {
  test("cycle rejected by the post-write gate + rolled back on disk", () => {
    // test_epic_add_dep.py::test_add_dep_cycle_rejected_and_rolled_back
    const a = createEpic("Epic A");
    const b = createEpic("Epic B");

    const r1 = run(["epic", "add-dep", a, b]);
    expect(r1.code).toBe(0);

    const r2 = run(["epic", "add-dep", b, a]);
    expect(r2.code).not.toBe(0);
    const payload = firstJsonPayload(r2.output);
    expect(payload.success).toBe(false);
    const err = payload.error as Record<string, unknown>;
    const details = (err.details as string[]) ?? [];
    expect(
      err.code === "integrity_failed" ||
        details.some((d) => d.includes("epic-dep cycle detected")),
    ).toBe(true);

    // Rollback: B's dep list untouched after the rejected write.
    expect(readEpic(b).depends_on_epics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// epic add-deps (batch) — multi-edge wire, idempotency, per-edge errors,
// cycle rejection, --skip-invalid routing, bare-fn-N normalization
// ---------------------------------------------------------------------------

describe("epic add-deps", () => {
  test("wires multiple edges in one envelope", () => {
    // test_epic_add_deps.py::test_add_deps_wires_multiple_edges_one_envelope
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");
    const dep2 = createEpic("Dep two");

    const r = run(["epic", "add-deps", epicId, dep1, dep2]);
    expect(r.code).toBe(0);

    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.depends_on_epics).toEqual([dep1, dep2]);
    expect(statusMap(payload)).toStrictEqual({
      [dep1]: "WIRED",
      [dep2]: "WIRED",
    });

    expect(countInvocationLines(r.output)).toBe(1);
    const pc = payload.plan_invocation as Record<string, unknown>;
    expect(pc.op).toBe("add-deps");
    expect(pc.target).toBe(epicId);
    expect(pc.subject).toBe(`chore(plan): add-deps ${epicId}`);

    expect(readEpic(epicId).depends_on_epics).toEqual([dep1, dep2]);
  });

  test("duplicate edge is ALREADY_PRESENT (no-op success)", () => {
    // test_epic_add_deps.py::test_add_deps_dup_edge_is_already_present
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");

    expect(run(["epic", "add-deps", epicId, dep1]).code).toBe(0);
    const r2 = run(["epic", "add-deps", epicId, dep1]);
    expect(r2.code).toBe(0);
    const payload = firstJsonPayload(r2.output);
    expect(payload.success).toBe(true);
    expect(statusMap(payload)).toStrictEqual({ [dep1]: "ALREADY_PRESENT" });
    expect(payload.depends_on_epics).toEqual([dep1]);
  });

  test("mixed new + already-present", () => {
    // test_epic_add_deps.py::test_add_deps_mixed_new_and_present
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");
    const dep2 = createEpic("Dep two");

    run(["epic", "add-deps", epicId, dep1]);
    const r = run(["epic", "add-deps", epicId, dep1, dep2]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(statusMap(payload)).toStrictEqual({
      [dep1]: "ALREADY_PRESENT",
      [dep2]: "WIRED",
    });
    expect(payload.depends_on_epics).toEqual([dep1, dep2]);
  });

  test("self-reference collected as bad_id, nothing wired", () => {
    // test_epic_add_deps.py::test_add_deps_self_reference_collected
    const epicId = createEpic("Target epic");
    const r = run(["epic", "add-deps", epicId, epicId]);
    expect(r.code).not.toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(false);
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("bad_id");
    expect((err.details as string[]).some((d) => d.includes("itself"))).toBe(
      true,
    );
    expect(readEpic(epicId).depends_on_epics).toEqual([]);
  });

  test("nonexistent target collected, no partial write", () => {
    // test_epic_add_deps.py::test_add_deps_nonexistent_target_collected
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");

    const r = run(["epic", "add-deps", epicId, dep1, "fn-9999-does-not-exist"]);
    expect(r.code).not.toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(false);
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("epic_not_found");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("fn-9999-does-not-exist"),
      ),
    ).toBe(true);
    expect(readEpic(epicId).depends_on_epics).toEqual([]);
  });

  test("cycle rejected, dep list untouched", () => {
    // test_epic_add_deps.py::test_add_deps_cycle_rejected
    const a = createEpic("Epic A");
    const b = createEpic("Epic B");

    expect(run(["epic", "add-deps", a, b]).code).toBe(0);
    const r2 = run(["epic", "add-deps", b, a]);
    expect(r2.code).not.toBe(0);
    const payload = firstJsonPayload(r2.output);
    expect(payload.success).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe("dep_cycle");
    expect(readEpic(b).depends_on_epics).toEqual([]);
  });

  test("--skip-invalid routes a bad id into results", () => {
    // test_epic_add_deps.py::test_add_deps_skip_invalid_routes_bad_id_into_results
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");

    const r = run([
      "epic",
      "add-deps",
      "--skip-invalid",
      epicId,
      "not-an-id",
      dep1,
    ]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(statusMap(payload)).toStrictEqual({
      "not-an-id": "SKIPPED_BAD_ID",
      [dep1]: "WIRED",
    });
    expect(readEpic(epicId).depends_on_epics).toEqual([dep1]);
  });

  test("--skip-invalid routes a missing dep into results", () => {
    // test_epic_add_deps.py::test_add_deps_skip_invalid_routes_not_found_into_results
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");

    const r = run([
      "epic",
      "add-deps",
      "--skip-invalid",
      epicId,
      "fn-9999-missing",
      dep1,
    ]);
    expect(r.code).toBe(0);
    expect(statusMap(firstJsonPayload(r.output))).toStrictEqual({
      "fn-9999-missing": "SKIPPED_NOT_FOUND",
      [dep1]: "WIRED",
    });
  });

  test("--skip-invalid with every edge skipping exits zero", () => {
    // test_epic_add_deps.py::test_add_deps_skip_invalid_all_skip_exits_zero
    const epicId = createEpic("Target epic");
    const r = run([
      "epic",
      "add-deps",
      "--skip-invalid",
      epicId,
      "fn-9999-missing",
      "not-an-id",
    ]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(statusMap(payload)).toStrictEqual({
      "fn-9999-missing": "SKIPPED_NOT_FOUND",
      "not-an-id": "SKIPPED_BAD_ID",
    });
    expect(readEpic(epicId).depends_on_epics).toEqual([]);
  });

  test("without --skip-invalid the fail-loud behavior is preserved", () => {
    // test_epic_add_deps.py::test_add_deps_default_fail_loud_unchanged
    const epicId = createEpic("Target epic");
    const dep1 = createEpic("Dep one");

    const r = run(["epic", "add-deps", epicId, "fn-9999-missing", dep1]);
    expect(r.code).not.toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe(
      "epic_not_found",
    );
    expect(readEpic(epicId).depends_on_epics).toEqual([]);
  });

  test("bare fn-N wires the unique match + persists the full slug", () => {
    // test_epic_add_deps.py::test_add_deps_number_only_wires_and_persists_full_slug
    const epicId = createEpic("Target epic");
    const depFull = createEpic("Dep one");
    const numberOnly = bareNumber(depFull);
    expect(numberOnly).not.toBe(depFull);

    const r = run(["epic", "add-deps", epicId, numberOnly]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(payload.depends_on_epics).toEqual([depFull]);
    expect(readEpic(epicId).depends_on_epics).toEqual([depFull]);
    expect(statusMap(payload)).toStrictEqual({ [depFull]: "WIRED" });
  });

  test("bare fn-N re-wire of a full-slug edge is ALREADY_PRESENT", () => {
    // test_epic_add_deps.py::test_add_deps_number_only_already_present_via_full_slug
    const epicId = createEpic("Target epic");
    const depFull = createEpic("Dep one");

    expect(run(["epic", "add-deps", epicId, depFull]).code).toBe(0);
    const r2 = run(["epic", "add-deps", epicId, bareNumber(depFull)]);
    expect(r2.code).toBe(0);
    expect(statusMap(firstJsonPayload(r2.output))).toStrictEqual({
      [depFull]: "ALREADY_PRESENT",
    });
    expect(readEpic(epicId).depends_on_epics).toEqual([depFull]);
  });

  test("fn-1 must not match fn-10 — integer equality, never prefix", () => {
    // test_epic_add_deps.py::test_add_deps_number_only_prefix_trap_fn1_not_fn10
    const created: Record<number, string> = {};
    while (!(1 in created && 10 in created)) {
      const full = createEpic(`Filler ${Object.keys(created).length}`);
      const n = Number.parseInt(full.split("-")[1] as string, 10);
      created[n] = full;
    }
    const epicId = createEpic("Target epic");

    const r = run(["epic", "add-deps", epicId, "fn-1"]);
    expect(r.code).toBe(0);
    expect(firstJsonPayload(r.output).depends_on_epics).toEqual([created[1]]);
    expect(created[1]).not.toBe(created[10]);
  });
});

// ---------------------------------------------------------------------------
// epic close — closer_done_at-only stamp, removed flag, op=close envelope
// ---------------------------------------------------------------------------

describe("epic close", () => {
  test("stamps closer_done_at and never writes auditor_done_at", () => {
    // test_epic_close.py::test_close_stamps_only_closer_done_at
    const epicId = createEpic("Close");
    const r = run(["epic", "close", epicId, "--force"]);
    expect(r.code).toBe(0);

    const epic = readEpic(epicId);
    expect(epic.closer_done_at).not.toBeNull();
    expect("auditor_done_at" in epic).toBe(false);
  });

  test("the removed --no-audit-required flag is rejected", () => {
    // test_epic_close.py::test_close_rejects_removed_audit_required_flag
    const epicId = createEpic("Flag gone");
    const r = run(["epic", "close", epicId, "--force", "--no-audit-required"]);
    expect(r.code).not.toBe(0);
    const out = r.output.toLowerCase();
    expect(
      out.includes("no such option") || out.includes("no-audit-required"),
    ).toBe(true);
  });

  test("close envelope carries op=close / target", () => {
    // test_epic_close.py::test_close_envelope_carries_planctl_invocation
    const epicId = createEpic("Envelope test");
    const r = run(["epic", "close", epicId, "--force"]);
    expect(r.code).toBe(0);
    const last = r.output.trim().split("\n").at(-1) as string;
    const inv = (JSON.parse(last).plan_invocation ?? {}) as Record<
      string,
      unknown
    >;
    expect(inv.op).toBe("close");
    expect(inv.target).toBe(epicId);
  });
});

// ---------------------------------------------------------------------------
// epic queue-jump — false→true + already-true short-circuit are pinned in
// verbs-restamp.test.ts (test_queue_jump_sets_flag_and_commits /
// test_queue_jump_short_circuit_when_already_true). Here the error path + the
// VALIDATION_RESTAMP_VERBS membership + the richer envelope assertions.
// ---------------------------------------------------------------------------

describe("epic queue-jump (errors + envelope)", () => {
  test("false→true sets the flag + envelope carries queue_jump:true", () => {
    // test_run_epic_queue_jump.py::test_queue_jump_false_to_true_sets_flag_and_envelope
    const epicId = createEpic("Jumpable epic");
    expect(readEpic(epicId).queue_jump).not.toBe(true);

    const r = run(["epic", "queue-jump", epicId]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.short_circuited).toBe(false);
    expect(readEpic(epicId).queue_jump).toBe(true);

    const inv = (payload.plan_invocation ?? {}) as Record<string, unknown>;
    expect(inv.op).toBe("queue-jump");
    expect(inv.target).toBe(epicId);
    expect(inv.queue_jump).toBe(true);
  });

  test("already-true short-circuits read-only: no rewrite, null subject/files", () => {
    // test_run_epic_queue_jump.py::test_queue_jump_already_true_short_circuits_readonly
    const epicId = createEpic("Jumpable epic");
    expect(run(["epic", "queue-jump", epicId]).code).toBe(0);
    const first = readEpic(epicId);
    expect(first.queue_jump).toBe(true);

    const r = run(["epic", "queue-jump", epicId]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.short_circuited).toBe(true);
    expect(readEpic(epicId)).toStrictEqual(first);

    const inv = (payload.plan_invocation ?? {}) as Record<string, unknown>;
    expect(inv.op).toBe("queue-jump");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });

  test("missing epic errors", () => {
    // test_run_epic_queue_jump.py::test_queue_jump_missing_epic_errors
    const r = run(["epic", "queue-jump", "fn-9999-no-epic"]);
    expect(r.code).not.toBe(0);
    const out = r.output.toLowerCase();
    expect(out.includes("not found") || out.includes("fn-9999")).toBe(true);
  });

  // test_queue_jump_not_in_validation_restamp_verbs — CITED: the
  // VALIDATION_RESTAMP_VERBS membership (queue-jump absent) is pinned by
  // verbs-restamp.test.ts's queue-jump-leaves-marker assertion; the Python
  // node imports planctl.validation_restamp in-process (python_only surface).
});

// ---------------------------------------------------------------------------
// task set-tier — write/round-trip/heuristic-fallback core is pinned in
// verbs-restamp.test.ts (test_set_tier_writes_and_leaves_marker) and the null-
// tier default in src-models.test.ts. Here the validation + envelope nodes.
// ---------------------------------------------------------------------------

describe("task set-tier (validation + envelope)", () => {
  // Mint an epic + one task via the harness scaffoldEpic helper (set-tier needs
  // a real task; scaffold is the only mint path). Returns {epicId, taskId}.
  function scaffoldOne(): { epicId: string; taskId: string } {
    const { epicId, taskIds } = scaffoldEpic(project, {
      title: "Tier epic",
      nTasks: 1,
    });
    return { epicId, taskId: taskIds[0] as string };
  }

  function readTask(taskId: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(
        join(project.root, ".keeper", "tasks", `${taskId}.json`),
        "utf-8",
      ),
    );
  }

  // Hand-null a task's persisted tier to simulate a legacy on-disk record.
  function handNullTier(taskId: string): void {
    const path = join(project.root, ".keeper", "tasks", `${taskId}.json`);
    const def = readTask(taskId);
    def.tier = null;
    writeFileSync(path, JSON.stringify(def), "utf-8");
  }

  test("set-tier writes medium onto a hand-nulled legacy task", () => {
    // test_task_set_tier.py::test_set_tier_writes_medium
    const { taskId } = scaffoldOne();
    handNullTier(taskId);
    expect(readTask(taskId).tier).toBeNull();

    const r = run(["task", "set-tier", taskId, "--tier", "medium"]);
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.task_id).toBe(taskId);
    expect(payload.tier).toBe("medium");
    expect(readTask(taskId).tier).toBe("medium");
  });

  test("set-tier overwrites an existing tier", () => {
    // test_task_set_tier.py::test_set_tier_overwrites_existing
    const { taskId } = scaffoldOne();
    expect(run(["task", "set-tier", taskId, "--tier", "medium"]).code).toBe(0);
    expect(run(["task", "set-tier", taskId, "--tier", "xhigh"]).code).toBe(0);
    expect(readTask(taskId).tier).toBe("xhigh");
  });

  test("warm-write medium → cold-read via show round-trips", () => {
    // test_task_set_tier.py::test_warm_write_cold_read_round_trip
    const { taskId } = scaffoldOne();
    expect(run(["task", "set-tier", taskId, "--tier", "medium"]).code).toBe(0);
    const r = run(["show", taskId]);
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    const task = (payload.task ?? payload) as Record<string, unknown>;
    expect(task.tier).toBe("medium");
  });

  test("tier=null surfaces null via show (heuristic-fallback signal)", () => {
    // test_task_set_tier.py::test_tier_null_triggers_heuristic_fallback
    const { taskId } = scaffoldOne();
    handNullTier(taskId);

    const r = run(["show", taskId]);
    expect(r.code).toBe(0);
    const task = (parseCliOutput(r.output).task ?? {}) as Record<
      string,
      unknown
    >;
    expect(task.tier).toBeNull();
  });

  test("an out-of-vocabulary tier is rejected", () => {
    // test_task_set_tier.py::test_set_tier_rejects_invalid_tier
    const { taskId } = scaffoldOne();
    const r = run(["task", "set-tier", taskId, "--tier", "ultra"]);
    expect(r.code).not.toBe(0);
    const out = r.output.toLowerCase();
    expect(out.includes("invalid") || out.includes("ultra")).toBe(true);
  });

  test("set-tier on a non-existent task errors", () => {
    // test_task_set_tier.py::test_set_tier_unknown_task_errors
    const r = run([
      "task",
      "set-tier",
      "fn-9999-no-task.1",
      "--tier",
      "medium",
    ]);
    expect(r.code).not.toBe(0);
    const out = r.output.toLowerCase();
    expect(out.includes("not found") || out.includes("fn-9999")).toBe(true);
  });

  test("set-tier on an epic id (not a task id) fails-visibly", () => {
    // test_task_set_tier.py::test_set_tier_invalid_id_type_errors
    const { epicId } = scaffoldOne();
    const r = run(["task", "set-tier", epicId, "--tier", "medium"]);
    expect(r.code).not.toBe(0);
    expect(r.output.toLowerCase()).toContain("invalid");
  });

  test("set-tier envelope carries op=task-set-tier", () => {
    // test_task_set_tier.py::test_set_tier_envelope_carries_planctl_invocation
    const { taskId } = scaffoldOne();
    const r = run(["task", "set-tier", taskId, "--tier", "medium"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('"plan_invocation"');
    expect(r.output).toContain("task-set-tier");
  });

  // test_normalize_task_adds_null_tier_on_legacy — CITED: src-models.test.ts
  //   pins normalize_task's null-tier default (python_only in-process import).
  // test_normalize_task_preserves_existing_tier — CITED: src-models.test.ts.
  // test_set_tier_not_in_validation_restamp_verbs — CITED: verbs-restamp.test.ts
  //   pins set-tier as a non-restamp setter (python_only in-process import).
});

// ---------------------------------------------------------------------------
// set-primary-repo / set-touched-repos — the non-blocking warning contract:
// envelope.warnings + WARN: on stderr, the write still lands, exit stays 0.
// ---------------------------------------------------------------------------

describe("set-primary-repo / set-touched-repos warnings", () => {
  // A git-FREE planctl project, mirroring the Python _create_project (which runs
  // `planctl init` WITHOUT `git init`). The non-blocking warning path then
  // returns exit 0 with no auto-commit. Each test mints its own under a fresh
  // tmpdir + dedicated HOME.
  const getTmp = withTmpdir("planctl-warn-");
  let root: string;
  let home: string;
  beforeEach(() => {
    root = getTmp();
    home = join(root, ".warn-home");
    mkdirSync(home, { recursive: true });
    const i = runCli(["init"], { cwd: root, home });
    expect(i.code).toBe(0);
  });

  function warnRun(args: string[]) {
    return runCli(args, { cwd: root, home });
  }

  function warnEpic(): string {
    const r = warnRun(["epic", "create", "--title", "Warning test epic"]);
    expect(r.code).toBe(0);
    return (firstJsonPayload(r.output).epic as Record<string, unknown>)
      .id as string;
  }

  function warnReadEpic(epicId: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(root, ".keeper", "epics", `${epicId}.json`), "utf-8"),
    );
  }

  // A git repo under the project tree (a valid touched/primary target).
  function freshDir(name: string, withGit: boolean): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (withGit) {
      gitInit(dir);
    }
    return dir;
  }

  test("set-primary-repo nonexistent path warns, writes, exits 0", () => {
    // test_set_primary_repo_warning.py::test_set_primary_repo_nonexistent_path_warns
    const epicId = warnEpic();
    const bogus = join(root, "does-not-exist");
    const r = warnRun(["epic", "set-primary-repo", epicId, "--path", bogus]);
    expect(r.code).toBe(0);

    expect(warnReadEpic(epicId).primary_repo).toBe(bogus);
    const envelope = JSON.parse(r.stdout.trim().split("\n")[0] as string);
    expect((envelope.warnings as string[]).length).toBe(1);
    expect((envelope.warnings as string[])[0]).toContain("does not exist");
    expect((envelope.warnings as string[])[0]).toContain(
      "keeper plan validate",
    );
    expect(r.stderr).toContain("WARN:");
    expect(r.stderr).toContain("does not exist");
  });

  test("set-primary-repo path without .git warns, writes, exits 0", () => {
    // test_set_primary_repo_warning.py::test_set_primary_repo_exists_but_no_git_warns
    const epicId = warnEpic();
    const noGit = freshDir("no-git-dir", false);
    const r = warnRun(["epic", "set-primary-repo", epicId, "--path", noGit]);
    expect(r.code).toBe(0);

    expect(warnReadEpic(epicId).primary_repo).toBe(noGit);
    const envelope = JSON.parse(r.stdout.trim().split("\n")[0] as string);
    expect((envelope.warnings as string[]).length).toBe(1);
    expect((envelope.warnings as string[])[0]).toContain("no .git/");
    expect(r.stderr).toContain("WARN:");
  });

  test("set-primary-repo valid git repo: no warning", () => {
    // test_set_primary_repo_warning.py::test_set_primary_repo_valid_git_repo_no_warning
    const epicId = warnEpic();
    const valid = freshDir("valid-repo", true);
    const r = warnRun(["epic", "set-primary-repo", epicId, "--path", valid]);
    expect(r.code).toBe(0);

    expect(warnReadEpic(epicId).primary_repo).toBe(valid);
    const envelope = JSON.parse(r.stdout.trim().split("\n")[0] as string);
    expect((envelope.warnings ?? []) as string[]).toEqual([]);
    expect(r.stderr).not.toContain("WARN:");
  });

  test("set-touched-repos one bad path in three: one warning", () => {
    // test_set_primary_repo_warning.py::test_set_touched_repos_one_bad_path_warns
    const epicId = warnEpic();
    const v1 = freshDir("valid-1", true);
    const v2 = freshDir("valid-2", true);
    const bogus = join(root, "nonexistent-repo");

    const r = warnRun([
      "epic",
      "set-touched-repos",
      epicId,
      "--paths",
      `${v1},${bogus},${v2}`,
    ]);
    expect(r.code).toBe(0);

    expect((warnReadEpic(epicId).touched_repos as string[]).length).toBe(3);
    const envelope = JSON.parse(r.stdout.trim().split("\n")[0] as string);
    expect((envelope.warnings as string[]).length).toBe(1);
    expect((envelope.warnings as string[])[0]).toContain("does not exist");
    const warnLines = r.stderr
      .split("\n")
      .filter((ln) => ln.startsWith("WARN:"));
    expect(warnLines.length).toBe(1);
  });

  test("set-touched-repos all bad: one warning each", () => {
    // test_set_primary_repo_warning.py::test_set_touched_repos_all_bad_warns_each
    const epicId = warnEpic();
    const b1 = join(root, "no-such-dir-1");
    const b2 = join(root, "no-such-dir-2");
    const r = warnRun([
      "epic",
      "set-touched-repos",
      epicId,
      "--paths",
      `${b1},${b2}`,
    ]);
    expect(r.code).toBe(0);

    const envelope = JSON.parse(r.stdout.trim().split("\n")[0] as string);
    expect(((envelope.warnings ?? []) as string[]).length).toBe(2);
    const warnLines = r.stderr
      .split("\n")
      .filter((ln) => ln.startsWith("WARN:"));
    expect(warnLines.length).toBe(2);
  });

  test("set-touched-repos all valid: no warning", () => {
    // test_set_primary_repo_warning.py::test_set_touched_repos_valid_paths_no_warning
    const epicId = warnEpic();
    const valid = freshDir("valid-repo", true);
    const r = warnRun(["epic", "set-touched-repos", epicId, "--paths", valid]);
    expect(r.code).toBe(0);

    const envelope = JSON.parse(r.stdout.trim().split("\n")[0] as string);
    expect((envelope.warnings ?? []) as string[]).toEqual([]);
    expect(r.stderr).not.toContain("WARN:");
  });
});

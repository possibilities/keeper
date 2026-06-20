// Engine-agnostic conformance spec for the read-only `planctl refine-context`
// verb — translated from tests/test_refine_context.py, every node mapped by a
// source-comment. The /plan:plan Phase R2 fetch behind one envelope: epic-route
// per-task specs (ordered, distinguishable markers), single-task, the task-route
// strip-.M variant, empty-epic tasks:[], the BAD_EPIC_ID / EPIC_NOT_FOUND gates,
// and the --invalidate conditionally-mutating path (clear + one commit / short-
// circuit-when-null / read-only-without-flag).
//
// Every fixture is a real-git withProject (scaffold seed + the --invalidate commit
// path both need real git).

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  firstJsonPayload,
  gitHeadMessage,
  gitLogCount,
  type ProjectHandle,
  runCli,
  withProject,
} from "./harness.ts";

let project: ProjectHandle;
const getProject = withProject("planctl-rctx-");
beforeEach(() => {
  project = getProject();
});

function run(args: string[]) {
  return runCli(args, { cwd: project.root, home: project.home });
}

// Parse the primary envelope, skipping a trailing read-only invocation line.
// Port of _envelope: the first object carrying a payload key.
function envelope(output: string): Record<string, unknown> {
  const payloadKeys = ["success", "error", "epic_id", "epic_spec_md"];
  for (const raw of output.trim().split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (payloadKeys.some((k) => k in obj)) {
        return obj;
      }
    } catch {
      // not a single-line JSON object — keep scanning
    }
  }
  // Fall back to the multi-line pretty payload (read verbs emit pretty JSON).
  const lines = output
    .trim()
    .split("\n")
    .filter((ln) => !ln.trim().startsWith('{"planctl_invocation"'));
  while (lines.length > 0 && !lines[0]?.trimStart().startsWith("{")) {
    lines.shift();
  }
  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

// Scaffold an epic + N tasks, each Description carrying marker-<i>. Returns
// {epicId, taskIds}. Port of _make_epic — the harness scaffoldEpic helper writes
// `seed-<i>` markers, so this uses a custom YAML to carry marker-<i>.
function makeEpic(nTasks: number): { epicId: string; taskIds: string[] } {
  const taskSpec = (marker: string) =>
    `## Description\n${marker}\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n`;
  const tasksYaml = Array.from({ length: nTasks }, (_, idx) => {
    const i = idx + 1;
    const specLines = taskSpec(`marker-${i}`)
      .split("\n")
      .map((ln) => `      ${ln}`)
      .join("\n");
    return `  - title: task ${i}\n    tier: medium\n    spec: |\n${specLines}`;
  }).join("\n");
  const yaml =
    "epic:\n  title: Demo epic\n  branch: demo-branch\n  spec: |\n" +
    `    ## Overview\n    demo overview\ntasks:\n${tasksYaml}\n`;
  const planPath = join(project.root, "plan.yaml");
  writeFileSync(planPath, yaml, "utf-8");
  const r = run(["scaffold", "--file", planPath]);
  expect(r.code).toBe(0);
  const env = firstJsonPayload(r.output);
  return { epicId: env.epic_id as string, taskIds: env.task_ids as string[] };
}

function readEpic(epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "epics", `${epicId}.json`),
      "utf-8",
    ),
  );
}

// ---------------------------------------------------------------------------
// Epic route: per-task specs
// ---------------------------------------------------------------------------

describe("epic route", () => {
  test("multi-task epic returns all per-task specs, ordered", () => {
    // test_refine_context.py::TestEpicRoute::test_multi_task_returns_all_specs
    const { epicId, taskIds } = makeEpic(3);
    const r = run(["refine-context", epicId]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.epic_id).toBe(epicId);
    expect(env.title).toBe("Demo epic");
    expect(env.branch).toBe("demo-branch");
    const stamp = env.last_validated_at as string;
    expect(stamp).not.toBeNull();
    expect(stamp.endsWith("Z")).toBe(true);
    expect(stamp.includes(".")).toBe(true);
    expect(env.epic_spec_md as string).toContain("## Overview");
    expect(env.epic_spec_md as string).toContain("demo overview");

    const tasks = env.tasks as Record<string, unknown>[];
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    tasks.forEach((t, idx) => {
      expect(t.status).toBe("todo");
      expect(t.deps).toEqual([]);
      expect(t.snippets).toEqual([]);
      expect(t.bundles).toEqual([]);
      expect(t.spec_md as string).toContain(`marker-${idx + 1}`);
    });
  });

  test("single-task epic", () => {
    // test_refine_context.py::TestEpicRoute::test_single_task_epic
    const { epicId, taskIds } = makeEpic(1);
    const r = run(["refine-context", epicId]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    const tasks = env.tasks as Record<string, unknown>[];
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe(taskIds[0]);
    expect(tasks[0]?.spec_md as string).toContain("marker-1");
  });
});

// ---------------------------------------------------------------------------
// Task route: strip .M, reuse the same envelope
// ---------------------------------------------------------------------------

describe("task route", () => {
  test("strip .M yields the parent epic spec + the captured task", () => {
    // test_refine_context.py::TestTaskRoute::test_task_route_includes_parent_epic_spec
    const { epicId, taskIds } = makeEpic(2);
    const derived = (taskIds[0] as string).split(".").slice(0, -1).join(".");
    expect(derived).toBe(epicId);
    const r = run(["refine-context", derived]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.epic_spec_md as string).toContain("## Overview");
    expect((env.tasks as Record<string, unknown>[]).map((t) => t.id)).toContain(
      taskIds[0],
    );
  });
});

// ---------------------------------------------------------------------------
// Empty epic + gates
// ---------------------------------------------------------------------------

describe("empty epic + gates", () => {
  test("an epic with zero tasks returns tasks: []", () => {
    // test_refine_context.py::test_empty_epic_yields_empty_tasks
    const create = run(["epic", "create", "--title", "Bare epic"]);
    expect(create.code).toBe(0);
    const epicId = (
      firstJsonPayload(create.output).epic as Record<string, unknown>
    ).id as string;
    const r = run(["refine-context", epicId]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.tasks).toEqual([]);
    expect(env.epic_id).toBe(epicId);
  });

  test("bad epic id -> BAD_EPIC_ID", () => {
    // test_refine_context.py::TestGates::test_bad_epic_id
    const r = run(["refine-context", "not-an-id"]);
    expect(r.code).toBe(1);
    expect((envelope(r.output).error as Record<string, unknown>).code).toBe(
      "BAD_EPIC_ID",
    );
  });

  test("missing epic -> EPIC_NOT_FOUND", () => {
    // test_refine_context.py::TestGates::test_epic_not_found
    const r = run(["refine-context", "fn-99-missing"]);
    expect(r.code).toBe(1);
    expect((envelope(r.output).error as Record<string, unknown>).code).toBe(
      "EPIC_NOT_FOUND",
    );
  });

  // test_run_directly_no_click_context — DROP (python_only): calls
  //   run_refine_context.run(SimpleNamespace(...)) in-process to exercise the
  //   no-click-context sentinel; not a CLI-observable surface.
});

// ---------------------------------------------------------------------------
// --invalidate (conditionally-mutating)
// ---------------------------------------------------------------------------

describe("--invalidate", () => {
  test("clears the marker + lands exactly one commit", () => {
    // test_refine_context.py::TestInvalidate::test_invalidate_clears_marker_one_envelope_one_commit
    const { epicId } = makeEpic(1);
    expect(readEpic(epicId).last_validated_at).not.toBeNull();
    const before = gitLogCount(project.root);

    const r = run(["refine-context", epicId, "--invalidate"]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.success).toBe(true);
    expect(env.last_validated_at ?? null).toBeNull();
    expect(env.invalidated).toBe(true);
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    expect(gitLogCount(project.root)).toBe(before + 1);
    const subj = gitHeadMessage(project.root).split("\n")[0] as string;
    expect(subj).toContain("refine-context");
    expect(subj).toContain(epicId);
  });

  test("short-circuits when the marker is already null (no commit)", () => {
    // test_refine_context.py::TestInvalidate::test_invalidate_short_circuits_when_already_null
    const { epicId } = makeEpic(1);
    expect(run(["refine-context", epicId, "--invalidate"]).code).toBe(0);
    const headAfterFirst = gitLogCount(project.root);

    const r = run(["refine-context", epicId, "--invalidate"]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.last_validated_at ?? null).toBeNull();
    expect(env.invalidated).toBe(false);
    expect(gitLogCount(project.root)).toBe(headAfterFirst);
  });

  test("without --invalidate the path is read-only", () => {
    // test_refine_context.py::TestInvalidate::test_no_flag_is_read_only
    const { epicId } = makeEpic(1);
    const before = readEpic(epicId);
    const r = run(["refine-context", epicId]);
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.last_validated_at).toBe(before.last_validated_at);
    expect("invalidated" in env).toBe(false);
    expect(readEpic(epicId)).toEqual(before);
  });
});

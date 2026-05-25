/**
 * Tests for `scripts/autopilot.ts`'s block-2 filtered renderer.
 *
 * Block 2 in autopilot's frame body lists only the task pairs + close
 * pair whose readiness verdict is `{ tag: "ready" }`. The filtering is
 * driven by `renderEpicCommandsFiltered(epic, isReady)` — a pure
 * function over the embedded epic shape and a per-row verdict predicate.
 * A bug in the predicate or filter could silently drop ready epics from
 * (or add non-ready epics to) the autopilot work list, so this file
 * pins the three boundary cases the spec calls out:
 *
 *   (a) all-pass — every task and the close row pass; the filtered
 *       output is byte-identical to `renderEpicCommands` for the same
 *       epic.
 *   (b) some-pass — only a subset of the task pairs survive; the close
 *       row may or may not survive independently. Order is preserved
 *       and the dropped rows are gone from the output entirely.
 *   (c) none-pass — every kind returns false → renderer returns `null`
 *       and the epic is dropped from block 2.
 *
 * Importing the renderers directly from `scripts/autopilot.ts` avoids
 * spawning a subprocess (matches the keeper convention used by the
 * other `test/*.test.ts` pure-function suites).
 */

import { expect, test } from "bun:test";
import {
  renderEpicCommands,
  renderEpicCommandsFiltered,
} from "../scripts/autopilot";
import type { Epic, Task } from "../src/types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    worker_phase: "open",
    runtime_status: "todo",
    approval: "approved",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic>): Epic {
  return {
    epic_id: "fn-1-foo",
    epic_number: 1,
    title: "epic",
    project_dir: "/repo",
    status: "open",
    approval: "approved",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

const ALWAYS_READY = (_kind: "task" | "close", _id: string): boolean => true;
const NEVER_READY = (_kind: "task" | "close", _id: string): boolean => false;

test("renderEpicCommandsFiltered — all-pass matches renderEpicCommands byte-for-byte", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/other-repo",
      }),
      makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
    ],
  });

  const filtered = renderEpicCommandsFiltered(epic, ALWAYS_READY);
  const unfiltered = renderEpicCommands(epic);

  expect(filtered).not.toBeNull();
  expect(filtered).toBe(unfiltered);

  // Sanity-check the rendered shape: includes all three work commands,
  // the per-task target_repo override, and the close pair.
  expect(filtered).toContain("cd /repo && claude '/plan:work fn-1-foo.1'");
  expect(filtered).toContain(
    "cd /other-repo && claude '/plan:work fn-1-foo.2'",
  );
  expect(filtered).toContain("cd /repo && claude '/plan:work fn-1-foo.3'");
  expect(filtered).toContain("cd /repo && claude '/plan:close fn-1-foo'");
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo");
});

test("renderEpicCommandsFiltered — some-pass keeps only ready rows, preserves order", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
      makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
    ],
  });

  // Only task .2 passes; close row drops out.
  const isReady = (kind: "task" | "close", id: string): boolean =>
    kind === "task" && id === "fn-1-foo.2";

  const filtered = renderEpicCommandsFiltered(epic, isReady);
  expect(filtered).not.toBeNull();

  // .2 work + approve pair present.
  expect(filtered).toContain("cd /repo && claude '/plan:work fn-1-foo.2'");
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo.2");

  // .1, .3, and the close pair are gone.
  expect(filtered).not.toContain("fn-1-foo.1");
  expect(filtered).not.toContain("fn-1-foo.3");
  expect(filtered).not.toContain("claude '/plan:close fn-1-foo'");
});

test("renderEpicCommandsFiltered — some-pass with surviving close row", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });

  // Only the close row passes; both task pairs drop.
  const isReady = (kind: "task" | "close", _id: string): boolean =>
    kind === "close";

  const filtered = renderEpicCommandsFiltered(epic, isReady);
  expect(filtered).not.toBeNull();
  expect(filtered).toContain("cd /repo && claude '/plan:close fn-1-foo'");
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo");
  expect(filtered).not.toContain("plan:work");
});

test("renderEpicCommandsFiltered — none-pass returns null (epic dropped from block 2)", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });

  const filtered = renderEpicCommandsFiltered(epic, NEVER_READY);
  expect(filtered).toBeNull();
});

test("renderEpicCommandsFiltered — empty-task epic with no ready close returns null", () => {
  // Epic with zero tasks and an unready close row: nothing to emit.
  const epic = makeEpic({ tasks: [] });
  expect(renderEpicCommandsFiltered(epic, NEVER_READY)).toBeNull();
});

test("renderEpicCommandsFiltered — empty-task epic with ready close emits close pair only", () => {
  const epic = makeEpic({ tasks: [] });
  const filtered = renderEpicCommandsFiltered(epic, ALWAYS_READY);
  expect(filtered).not.toBeNull();
  expect(filtered).toContain("claude '/plan:close fn-1-foo'");
  expect(filtered).not.toContain("plan:work");
});

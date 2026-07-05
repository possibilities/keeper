import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

const getProject = withProject("selection-brief-");

function run(args: string[]) {
  const project = getProject();
  return runCli(args, { cwd: project.root, home: project.home });
}

describe("selection-brief", () => {
  test("writes the selector context to gitignored state and emits a content-blind envelope", () => {
    const project = getProject();
    const { epicId, taskIds } = scaffoldEpic(project, {
      title: "Select cells",
      nTasks: 2,
    });

    const r = run(["selection-brief", epicId, "--project", project.root]);
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.task_ids).toEqual(taskIds);
    expect(payload.brief_ref).toBeString();
    expect(payload.candidate_cells).toHaveLength(10);

    // The envelope is deliberately blind: specs and policy YAML stay in the
    // brief artifact that only the selector subagent reads.
    expect(r.output).not.toContain("seed overview");
    expect(r.output).not.toContain("selector_config_yaml");

    const briefPath = payload.brief_ref as string;
    const brief = JSON.parse(readFileSync(briefPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(brief.schema_version).toBe(1);
    expect(brief.epic_id).toBe(epicId);
    expect(brief.primary_repo).toBe(project.root);
    expect(brief.selector_config_yaml).toBeString();
    expect(brief.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(brief.models).toEqual(["opus", "sonnet"]);

    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.task_id)).toEqual(taskIds);
    for (const task of tasks) {
      expect(task.spec_md).toContain("## Acceptance");
      expect(task.candidate_cells).toHaveLength(10);
    }
  });

  test("bad epic ids fail with the selection-brief error shape", () => {
    const r = run(["selection-brief", "not-an-epic"]);
    expect(r.code).toBe(1);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe("BAD_EPIC_ID");
  });
});

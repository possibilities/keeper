import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { followupPath, writeArtifact } from "../src/audit_artifacts.ts";
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

/** A two-task follow-up document keyed back to `sourceEpicId`, task 1 stamped
 * high/sonnet and task 2 medium/opus, distinct specs. */
function seedTwoTaskFollowup(root: string, sourceEpicId: string): void {
  const specA =
    "      ## Description\n      follow one\n\n" +
    "      ## Acceptance\n      - [ ] a\n\n" +
    "      ## Done summary\n\n      ## Evidence\n";
  const specB =
    "      ## Description\n      follow two\n\n" +
    "      ## Acceptance\n      - [ ] b\n\n" +
    "      ## Done summary\n\n      ## Evidence\n";
  const yaml =
    `epic:\n  title: Follow-up of ${sourceEpicId}\n` +
    `  depends_on_epics: [${sourceEpicId}]\n` +
    "  spec: |\n    ## Overview\n    follow overview\n" +
    "tasks:\n" +
    `  - title: Follow task one\n    tier: high\n    model: sonnet\n    spec: |\n${specA}` +
    `  - title: Follow task two\n    tier: medium\n    model: opus\n    deps: [1]\n    spec: |\n${specB}`;
  writeArtifact(followupPath(root, sourceEpicId), yaml);
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

describe("selection-brief --from-followup", () => {
  test("briefs the stored follow-up document with ordinal task keys", () => {
    const project = getProject();
    const { epicId } = scaffoldEpic(project, {
      title: "Close source",
      nTasks: 1,
    });
    seedTwoTaskFollowup(project.root, epicId);

    const r = run([
      "selection-brief",
      epicId,
      "--from-followup",
      "--project",
      project.root,
    ]);
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.from_followup).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    // Tasks key by 1-based ordinal (the follow-up has no ids yet).
    expect(payload.task_ids).toEqual(["1", "2"]);
    expect(payload.candidate_cells).toHaveLength(10);
    expect(payload.brief_ref as string).toEndWith("followup-brief.json");

    const brief = JSON.parse(
      readFileSync(payload.brief_ref as string, "utf-8"),
    ) as Record<string, unknown>;
    expect(brief.schema_version).toBe(1);
    expect(brief.from_followup).toBe(true);
    // input_hash anchors on the stored document's raw bytes — reproducible.
    const docText = readFileSync(followupPath(project.root, epicId), "utf-8");
    expect(brief.input_hash).toBe(
      createHash("sha256").update(docText).digest("hex"),
    );

    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.task_id)).toEqual(["1", "2"]);
    // The document's stamped cells surface as current_tier / current_model.
    expect(tasks[0].current_tier).toBe("high");
    expect(tasks[0].current_model).toBe("sonnet");
    expect(tasks[1].current_tier).toBe("medium");
    expect(tasks[1].current_model).toBe("opus");
    expect(tasks[1].depends_on).toEqual(["1"]);
    expect(tasks[0].spec_md).toContain("follow one");
    for (const task of tasks) {
      expect(task.candidate_cells).toHaveLength(10);
    }

    // The follow-up brief lands beside — never overwriting — a live-epic brief.
    expect(payload.brief_ref as string).toBe(
      join(
        project.root,
        ".keeper",
        "state",
        "selections",
        epicId,
        "followup-brief.json",
      ),
    );
  });

  test("a missing stored follow-up document fails closed", () => {
    const project = getProject();
    const { epicId } = scaffoldEpic(project, { title: "No doc", nTasks: 1 });
    const r = run([
      "selection-brief",
      epicId,
      "--from-followup",
      "--project",
      project.root,
    ]);
    expect(r.code).toBe(1);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe(
      "FOLLOWUP_MISSING",
    );
  });
});

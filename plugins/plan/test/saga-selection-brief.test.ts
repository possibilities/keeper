import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("selection-brief with a host provider matrix", () => {
  const cfgDirs: string[] = [];
  afterAll(() => {
    for (const d of cfgDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /** A tracked temp config dir carrying a `matrix.yaml`, so effectiveMatrix()
   *  reads it via KEEPER_CONFIG_DIR (os.homedir ignores $HOME on macOS). */
  function cfgWithMatrix(matrixYaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "selbrief-cfg-"));
    cfgDirs.push(dir);
    writeFileSync(join(dir, "matrix.yaml"), matrixYaml);
    return dir;
  }

  // A guided roster: claude serves opus (native), codex serves the wrapped
  // capability gpt-5.5 (a committed guidance block covers it).
  const GUIDED_MATRIX = [
    "efforts: [medium, high]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "  - name: codex",
    "    models:",
    "      - name: gpt-5.5",
    "        native: gpt-5.5-codex",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: xhigh",
    "",
  ].join("\n");

  // A roster naming a wrapped capability with NO model-selector.yaml block.
  const UNGUIDED_MATRIX = [
    "efforts: [medium, high]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "  - name: codex",
    "    models: [mystery-model]",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: xhigh",
    "",
  ].join("\n");

  test("offers wrapped-model candidate cells from the effective matrix", () => {
    const project = getProject();
    const { epicId, taskIds } = scaffoldEpic(project, {
      title: "Wrapped select",
      nTasks: 1,
    });
    const cfg = cfgWithMatrix(GUIDED_MATRIX);

    const r = runCli(["selection-brief", epicId, "--project", project.root], {
      cwd: project.root,
      home: project.home,
      env: { KEEPER_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);

    const brief = JSON.parse(
      readFileSync(payload.brief_ref as string, "utf-8"),
    ) as Record<string, unknown>;
    // The host matrix overrides the embedded claude-only axes.
    expect(brief.efforts).toEqual(["medium", "high"]);
    expect(brief.models).toEqual(["opus", "gpt-5.5"]);
    // model axis {opus, gpt-5.5} × efforts {medium, high} = 4 cells; the wrapped
    // model is now selectable.
    expect(payload.candidate_cells).toHaveLength(4);
    const cellModels = new Set(
      (payload.candidate_cells as Array<{ model: string }>).map((c) => c.model),
    );
    expect(cellModels).toEqual(new Set(["opus", "gpt-5.5"]));

    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.task_id)).toEqual(taskIds);
    for (const task of tasks) {
      expect(task.candidate_cells).toHaveLength(4);
    }
  });

  // A ragged roster: opus renders only [high], gpt-5.5 renders [medium, high].
  // Both carry committed guidance blocks. The candidate enumeration must be the
  // ragged product (3 cells), not the rectangular {2 models × 2 efforts = 4}.
  const RAGGED_MATRIX = [
    "efforts: [medium, high]",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - name: opus",
    "        efforts: [high]",
    "  - name: codex",
    "    models:",
    "      - name: gpt-5.5",
    "        native: gpt-5.5-codex",
    "        efforts: [medium, high]",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: xhigh",
    "",
  ].join("\n");

  test("candidate cells are the ragged per-model product, not a rectangular cartesian", () => {
    const project = getProject();
    const { epicId, taskIds } = scaffoldEpic(project, {
      title: "Ragged select",
      nTasks: 1,
    });
    const cfg = cfgWithMatrix(RAGGED_MATRIX);

    const r = runCli(["selection-brief", epicId, "--project", project.root], {
      cwd: project.root,
      home: project.home,
      env: { KEEPER_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);

    const cells = payload.candidate_cells as Array<{
      model: string;
      tier: string;
    }>;
    // opus→[high] (1) + gpt-5.5→[medium, high] (2) = 3, NOT the 2×2 rectangle.
    expect(cells).toHaveLength(3);
    const pairs = new Set(cells.map((c) => `${c.model}::${c.tier}`));
    expect(pairs).toEqual(
      new Set(["opus::high", "gpt-5.5::medium", "gpt-5.5::high"]),
    );
    // opus never offers `medium`; gpt-5.5 offers both.
    expect(pairs.has("opus::medium")).toBe(false);

    const brief = JSON.parse(
      readFileSync(payload.brief_ref as string, "utf-8"),
    ) as Record<string, unknown>;
    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.task_id)).toEqual(taskIds);
    for (const task of tasks) {
      expect(task.candidate_cells).toHaveLength(3);
    }
  });

  test("a roster model with no guidance block fails loud, naming the model and file", () => {
    const project = getProject();
    const { epicId } = scaffoldEpic(project, {
      title: "Unguided select",
      nTasks: 1,
    });
    const cfg = cfgWithMatrix(UNGUIDED_MATRIX);

    const r = runCli(["selection-brief", epicId, "--project", project.root], {
      cwd: project.root,
      home: project.home,
      env: { KEEPER_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(1);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    const error = payload.error as Record<string, unknown>;
    expect(error.code).toBe("MODEL_GUIDANCE_MISSING");
    expect(error.message as string).toContain("mystery-model");
    expect(error.message as string).toContain("model-selector.yaml");
    expect((error.details as Record<string, unknown>).model).toBe(
      "mystery-model",
    );
  });
});

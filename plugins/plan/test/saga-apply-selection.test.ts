// Conformance spec for `keeper plan apply-selection` — the one trusted apply seam
// for model-selector verdicts (ADR 0027). Covers: the guided LIVE apply (cells
// land, brief-pinned provenance sidecar, single auto-commit); the guided
// FOLLOW-UP apply (the staged verdict document round-trips through a real
// in-process close-finalize call, so follow-up tasks are born with the selected
// cells); --degraded with and without a brief on disk; the verdict_invalid /
// brief_missing / cell_invalid collect-all envelopes; fenced-block stripping; the
// in-lock non-todo rejection; and the --degraded + --from-followup rejection.
//
// Every fixture scaffolds through the binary and builds the brief through the real
// selection-brief verb, so the provenance pins apply-selection reads are the
// selector's own artifact — never a value re-derived by the verb under test.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeCommitSetHash,
  followupPath,
  verdictPath,
  writeArtifact,
  writeBriefArtifact,
} from "../src/audit_artifacts.ts";
import { INTEGRITY_GATE_VERBS } from "../src/integrity_gate.ts";
import {
  firstJsonPayload,
  gitFilesInHead,
  gitLogCount,
  type ProjectHandle,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  seedRuntime,
  withProject,
} from "./harness.ts";

let project: ProjectHandle;
const getProject = withProject("planctl-apply-selection-");
beforeEach(() => {
  project = getProject();
});

function run(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
) {
  return runCli(args, {
    cwd: project.root,
    home: project.home,
    input: opts.input,
    env: opts.env,
  });
}

function readTask(taskId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "tasks", `${taskId}.json`),
      "utf-8",
    ),
  );
}

function sidecarPath(epicId: string): string {
  return join(project.root, ".keeper", "selections", `${epicId}.json`);
}

function readSidecar(epicId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(sidecarPath(epicId), "utf-8"));
}

function briefFilePath(epicId: string, basename: string): string {
  return join(project.root, ".keeper", "state", "selections", epicId, basename);
}

function errCode(output: string): unknown {
  return (firstJsonPayload(output).error as Record<string, unknown>).code;
}

function errDetails(output: string): string[] {
  return (firstJsonPayload(output).error as Record<string, unknown>)
    .details as string[];
}

function nonSparkCell(
  taskId: string,
  tier: string,
  model = "opus",
  opts: {
    rationale?: string;
    confidence?: number;
    sparkExclusion?: string;
  } = {},
): Record<string, unknown> {
  return {
    task_id: taskId,
    tier,
    model,
    rationale: opts.rationale ?? "not a Spark fit",
    confidence: opts.confidence ?? 0.8,
    spark_fit: false,
    spark_exclusion: opts.sparkExclusion ?? "spark-not-on-axis",
  };
}

function sparkCell(
  taskId: string,
  tier = "high",
  opts: { rationale?: string; confidence?: number } = {},
): Record<string, unknown> {
  return {
    task_id: taskId,
    tier,
    model: "gpt-5.3-codex-spark",
    rationale: opts.rationale ?? "fixed-shape Spark fit",
    confidence: opts.confidence ?? 0.84,
    spark_fit: true,
    spark_exclusion: null,
  };
}

const CLAUDE_AND_PI_MATRIX = readFileSync(
  join(import.meta.dir, "fixtures", "matrix-claude-and-pi.yaml"),
  "utf-8",
);

function writeMatrixEnv(
  name: string,
  matrixYaml: string,
): Record<string, string> {
  const dir = join(project.home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "matrix.yaml"), matrixYaml, "utf-8");
  return { KEEPER_CONFIG_DIR: dir };
}

function sparkMatrixEnv(): Record<string, string> {
  return writeMatrixEnv("spark-matrix", CLAUDE_AND_PI_MATRIX);
}

function restrictedSparkMatrixEnv(): Record<string, string> {
  return writeMatrixEnv(
    "restricted-spark-matrix",
    CLAUDE_AND_PI_MATRIX.replace(
      "      - openai-codex/gpt-5.3-codex-spark",
      "      - id: openai-codex/gpt-5.3-codex-spark\n" +
        "        efforts: [low, medium, high]",
    ),
  );
}

/** Build + write the live brief through the real selection-brief verb; returns
 * its {config_hash, input_hash, shuffle_seed} for the provenance-pinning
 * assertions (the selector's own artifact, not re-derived by apply-selection). */
function makeLiveBrief(
  epicId: string,
  env?: Record<string, string>,
): {
  configHash: string;
  inputHash: string;
  shuffleSeed: number;
} {
  const r = run(["selection-brief", epicId, "--project", project.root], {
    env,
  });
  expect(r.code).toBe(0);
  const payload = parseCliOutput(r.output);
  return {
    configHash: payload.config_hash as string,
    inputHash: payload.input_hash as string,
    shuffleSeed: payload.shuffle_seed as number,
  };
}

// ---------------------------------------------------------------------------
// Guided live apply
// ---------------------------------------------------------------------------

describe("apply-selection guided live", () => {
  test("valid verdict lands every cell + brief-pinned sidecar + one auto-commit", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const pins = makeLiveBrief(epicId);

    const verdict = JSON.stringify({
      cells: [
        nonSparkCell(taskIds[0] as string, "high", "sonnet", {
          rationale: "task 1 is subtle",
          confidence: 0.9,
        }),
        nonSparkCell(taskIds[1] as string, "max", "opus", {
          rationale: "task 2 is not Spark",
        }),
      ],
    });

    const before = gitLogCount(project.root);
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: verdict,
    });
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.assigned_task_ids).toEqual(taskIds);
    expect(payload.outcome).toBe("completed");

    // Cells overwritten on both task JSONs (the equivalent assign-cells effect).
    expect(readTask(taskIds[0] as string).tier).toBe("high");
    expect(readTask(taskIds[0] as string).model).toBe("sonnet");
    expect(readTask(taskIds[1] as string).tier).toBe("max");
    expect(readTask(taskIds[1] as string).model).toBe("opus");

    // Sidecar: provenance synthesized by the verb + hashes pinned from the brief.
    const sc = readSidecar(epicId);
    expect(sc.schema_version).toBe(1);
    expect(sc.epic_id).toBe(epicId);
    expect(sc.selector).toEqual({
      harness: "subagent",
      model: "plan:model-selector",
    });
    expect(sc.config_hash).toBe(pins.configHash);
    expect(sc.input_hash).toBe(pins.inputHash);
    expect(sc.shuffle_seed).toBe(pins.shuffleSeed);
    expect(sc.outcome).toBe("completed");
    expect(sc.verdict_raw).toBe(verdict);
    const cells = sc.cells as Record<string, unknown>[];
    expect(cells[0]).toEqual({
      task_id: taskIds[0],
      tier: "high",
      model: "sonnet",
      rationale: "task 1 is subtle",
      confidence: 0.9,
      spark_fit: false,
      spark_exclusion: "spark-not-on-axis",
      label_source: "heuristic-guided",
    });
    expect(cells[1]?.label_source).toBe("heuristic-guided");
    expect(cells[1]?.rationale).toBe("task 2 is not Spark");
    expect(cells[1]?.spark_fit).toBe(false);
    expect(cells[1]?.spark_exclusion).toBe("spark-not-on-axis");

    // Exactly one auto-commit carrying the cells AND the sidecar.
    expect(gitLogCount(project.root)).toBe(before + 1);
    const files = gitFilesInHead(project.root);
    expect(files).toContain(`.keeper/tasks/${taskIds[0]}.json`);
    expect(files).toContain(`.keeper/selections/${epicId}.json`);
  });

  test("a fenced ```json block is tolerated and stripped", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    makeLiveBrief(epicId);
    const inner = JSON.stringify({
      cells: [nonSparkCell(taskIds[0] as string, "high")],
    });
    const fenced = `\`\`\`json\n${inner}\n\`\`\`\n`;
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: fenced,
    });
    expect(r.code).toBe(0);
    expect(firstJsonPayload(r.output).success).toBe(true);
    expect(readTask(taskIds[0] as string).tier).toBe("high");
    // The raw (pre-strip) text is preserved verbatim in the sidecar.
    expect(readSidecar(epicId).verdict_raw).toBe(fenced);
  });

  test("Spark selection requires fit=true/exclusion=null and persists the evidence", () => {
    const env = sparkMatrixEnv();
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1, env });
    makeLiveBrief(epicId, env);
    const verdict = JSON.stringify({
      cells: [sparkCell(taskIds[0] as string)],
    });

    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: verdict,
      env,
    });
    expect(r.code).toBe(0);
    expect(readTask(taskIds[0] as string).model).toBe("gpt-5.3-codex-spark");
    const cell = (readSidecar(epicId).cells as Record<string, unknown>[])[0];
    expect(cell?.spark_fit).toBe(true);
    expect(cell?.spark_exclusion).toBeNull();
  });

  test("rejects a Spark effort absent from that task's exact candidate_cells", () => {
    const env = restrictedSparkMatrixEnv();
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1, env });
    makeLiveBrief(epicId, env);

    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [sparkCell(taskIds[0] as string, "xhigh")],
      }),
      env,
    });

    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(errDetails(r.output).some((d) => d.includes("candidate"))).toBe(
      true,
    );
    expect(existsSync(sidecarPath(epicId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guided follow-up apply — round-trips through a real close-finalize call
// ---------------------------------------------------------------------------

// The empty-set canonical hash close-finalize re-derives for an epic with no
// source commits (seeded tasks carry no Task: trailers).
function emptySetHash(): string {
  return computeCommitSetHash([]);
}

function markAllDone(root: string, taskIds: string[]): void {
  for (const tid of taskIds) {
    // No source commits in this fixture → each task carries a typed no-op
    // receipt (the close ancestry gate's (b) branch).
    seedRuntime(root, tid, {
      status: "done",
      no_op_reason: "fixture: no code",
    });
  }
}

function seedBrief(root: string, epicId: string, commitSetHash: string): void {
  writeBriefArtifact(root, epicId, {
    schema_version: 1,
    epic_id: epicId,
    primary_repo: root,
    commit_set_hash: commitSetHash,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  });
}

function seedVerdict(
  root: string,
  epicId: string,
  commitSetHash: string,
  nKept: number,
): void {
  const decisions = [];
  for (let i = 1; i <= nKept; i += 1) {
    decisions.push({
      fid: `f${i}`,
      action: "kept",
      task: i,
      rationale: "real",
    });
  }
  const record = {
    schema_version: 1,
    commit_set_hash: commitSetHash,
    fatal: false,
    fatal_reason: "",
    decisions,
  };
  writeArtifact(
    verdictPath(root, epicId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** A valid scaffold-plan followup.yaml (nTasks tasks, all medium/opus) wiring
 * back to the source epic. */
function seedFollowupYaml(root: string, epicId: string, nTasks: number): void {
  const blocks: string[] = [];
  for (let i = 1; i <= nTasks; i += 1) {
    const spec =
      "      ## Description\n      follow-up\n\n" +
      "      ## Acceptance\n      - [ ] x\n\n" +
      "      ## Done summary\n\n      ## Evidence\n";
    blocks.push(
      `  - title: Follow task ${i}\n    tier: medium\n    model: opus\n    spec: |\n${spec}`,
    );
  }
  const yaml =
    `epic:\n  title: Follow-up of ${epicId}\n` +
    `  depends_on_epics: [${epicId}]\n` +
    "  spec: |\n    ## Overview\n    follow overview\n" +
    `tasks:\n${blocks.join("\n")}\n`;
  writeArtifact(followupPath(root, epicId), yaml);
}

function taskCell(taskId: string): { tier: string; model: string } {
  const def = readTask(taskId);
  return { tier: def.tier as string, model: def.model as string };
}

describe("apply-selection guided follow-up", () => {
  test("rejects a Spark effort absent from follow-up task candidate_cells before staging", () => {
    const env = restrictedSparkMatrixEnv();
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1, env });
    markAllDone(project.root, taskIds);
    const hash = emptySetHash();
    seedBrief(project.root, epicId, hash);
    seedVerdict(project.root, epicId, hash, 1);
    seedFollowupYaml(project.root, epicId, 1);

    const brief = run(
      ["selection-brief", epicId, "--from-followup", "--project", project.root],
      { env },
    );
    expect(brief.code).toBe(0);

    const r = run(
      ["apply-selection", epicId, "--from-followup", "--file", "-"],
      { input: JSON.stringify({ cells: [sparkCell("1", "xhigh")] }), env },
    );

    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(errDetails(r.output).some((d) => d.includes("candidate"))).toBe(
      true,
    );
    expect(existsSync(briefFilePath(epicId, "followup-verdict.json"))).toBe(
      false,
    );
  });

  test("staged verdict round-trips through close-finalize; follow-up tasks born selected", () => {
    // A done epic with a 2-cluster verdict + a 2-task followup document.
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    markAllDone(project.root, taskIds);
    const hash = emptySetHash();
    seedBrief(project.root, epicId, hash);
    seedVerdict(project.root, epicId, hash, 2);
    seedFollowupYaml(project.root, epicId, 2);

    // Brief the stored follow-up document (ordinal-keyed tasks).
    const brief = run([
      "selection-brief",
      epicId,
      "--from-followup",
      "--project",
      project.root,
    ]);
    expect(brief.code).toBe(0);
    expect(parseCliOutput(brief.output).task_ids).toEqual(["1", "2"]);

    // Apply the ordinal verdict → stage the follow-up verdict document.
    const verdict = JSON.stringify({
      cells: [
        nonSparkCell("1", "high", "sonnet", { rationale: "subtle" }),
        nonSparkCell("2", "max", "opus", { rationale: "not Spark" }),
      ],
    });
    const before = gitLogCount(project.root);
    const applied = run(
      ["apply-selection", epicId, "--from-followup", "--file", "-"],
      { input: verdict },
    );
    expect(applied.code).toBe(0);
    const ap = firstJsonPayload(applied.output);
    expect(ap.success).toBe(true);
    expect(ap.from_followup).toBe(true);
    const stagedPath = ap.verdict_path as string;
    expect(stagedPath).toEndWith("followup-verdict.json");
    expect(existsSync(stagedPath)).toBe(true);
    // The follow-up branch is commit-free (a gitignored state/ file).
    expect(gitLogCount(project.root)).toBe(before);

    // The staged document is in the exact shape close-finalize consumes.
    const doc = JSON.parse(readFileSync(stagedPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(doc.schema_version).toBe(2);
    expect((doc.cells as Record<string, unknown>)["1"]).toMatchObject({
      tier: "high",
      model: "sonnet",
      spark_fit: false,
      spark_exclusion: "spark-not-on-axis",
    });
    expect((doc.selection as Record<string, unknown>).harness).toBe("subagent");
    expect((doc.selection as Record<string, unknown>).spark_axis_present).toBe(
      false,
    );

    // Real in-process close-finalize consumes the staged path — no degrade.
    const cf = runCli(
      [
        "close-finalize",
        epicId,
        "--project",
        project.root,
        "--selection-verdict",
        stagedPath,
      ],
      { cwd: project.root, home: project.home },
    );
    expect(cf.code).toBe(0);
    const cfEnv = parseCliOutput(cf.output);
    expect(cfEnv.outcome).toBe("closed_with_followup");
    const newEpicId = cfEnv.new_epic_id as string;

    // Follow-up tasks are BORN with the selected cells (not the doc's medium/opus).
    expect(taskCell(`${newEpicId}.1`)).toEqual({
      tier: "high",
      model: "sonnet",
    });
    expect(taskCell(`${newEpicId}.2`)).toEqual({ tier: "max", model: "opus" });
    const side = readSidecar(newEpicId);
    const sideCells = side.cells as Record<string, unknown>[];
    expect(side.outcome).toBe("completed");
    expect(sideCells[0]).toMatchObject({
      task_id: `${newEpicId}.1`,
      spark_fit: false,
      spark_exclusion: "spark-not-on-axis",
    });
  });
});

// ---------------------------------------------------------------------------
// Degraded (live-only)
// ---------------------------------------------------------------------------

describe("apply-selection --degraded", () => {
  test("with a brief on disk: re-asserts current cells, pins brief hashes", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const pins = makeLiveBrief(epicId);

    const r = run([
      "apply-selection",
      epicId,
      "--degraded",
      "selector-crashed",
    ]);
    expect(r.code).toBe(0);
    expect(firstJsonPayload(r.output).outcome).toBe(
      "degraded:selector-crashed",
    );

    // The scaffolded default cell is re-asserted, never re-hardcoded elsewhere.
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
    expect(readTask(taskIds[0] as string).model).toBe("opus");

    const sc = readSidecar(epicId);
    expect(sc.outcome).toBe("degraded:selector-crashed");
    expect(sc.selector).toEqual({ harness: "none", model: "none" });
    expect(sc.config_hash).toBe(pins.configHash);
    expect(sc.input_hash).toBe(pins.inputHash);
    expect(sc.shuffle_seed).toBeNull();
    expect(sc.verdict_raw).toBeNull();
    const degradedCell = (sc.cells as Record<string, unknown>[])[0];
    expect(degradedCell?.label_source).toBe("heuristic-default");
    expect(degradedCell?.spark_fit).toBeNull();
    expect(degradedCell?.spark_exclusion).toBeNull();
  });

  test("with no brief on disk: hashes fall back to the `unavailable` sentinel", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    // No selection-brief run.
    const r = run(["apply-selection", epicId, "--degraded", "no-selector"]);
    expect(r.code).toBe(0);
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
    const sc = readSidecar(epicId);
    expect(sc.outcome).toBe("degraded:no-selector");
    expect(sc.config_hash).toBe("unavailable");
    expect(sc.input_hash).toBe("unavailable");
    const degradedCell = (sc.cells as Record<string, unknown>[])[0];
    expect(degradedCell?.label_source).toBe("heuristic-default");
    expect(degradedCell?.spark_fit).toBeNull();
    expect(degradedCell?.spark_exclusion).toBeNull();
  });

  test("rejects --degraded combined with --from-followup", () => {
    const { epicId } = scaffoldEpic(project, { nTasks: 1 });
    const r = run([
      "apply-selection",
      epicId,
      "--from-followup",
      "--degraded",
      "x",
    ]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(
      errDetails(r.output).some((d) => d.includes("--from-followup")),
    ).toBe(true);
    // No sidecar written on the flag-combo reject.
    expect(existsSync(sidecarPath(epicId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure envelopes — verdict_invalid / brief_missing / cell_invalid
// ---------------------------------------------------------------------------

describe("apply-selection verdict_invalid", () => {
  test("unparseable stdin rejects", () => {
    const { epicId } = scaffoldEpic(project, { nTasks: 1 });
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: "not json at all",
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
  });

  test("an error-shaped return rejects", () => {
    const { epicId } = scaffoldEpic(project, { nTasks: 1 });
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({ error: "selector failed" }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(errDetails(r.output).some((d) => d.includes("error-shaped"))).toBe(
      true,
    );
  });

  test("a smuggled `selection:` block is an unknown top-level key", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    makeLiveBrief(epicId);
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [nonSparkCell(taskIds[0] as string, "high")],
        selection: { harness: "evil", model: "evil", config_hash: "x" },
      }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(errDetails(r.output).some((d) => d.includes("selection"))).toBe(
      true,
    );
    // The smuggled provenance never reached a sidecar.
    expect(existsSync(sidecarPath(epicId))).toBe(false);
  });

  test("an out-of-axis cell fails the brief enum-clamp (collect-all)", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    makeLiveBrief(epicId);
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [nonSparkCell(taskIds[0] as string, "bogus")],
      }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(errDetails(r.output).some((d) => d.includes("candidate"))).toBe(
      true,
    );
  });

  test("a coverage-violating verdict names the uncovered brief task", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    makeLiveBrief(epicId);
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [nonSparkCell(taskIds[0] as string, "high")],
      }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    expect(
      errDetails(r.output).some(
        (d) => d.includes("coverage") && d.includes(taskIds[1] as string),
      ),
    ).toBe(true);
  });

  test("Spark evidence contradictions are collected before any write", () => {
    const env = sparkMatrixEnv();
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1, env });
    makeLiveBrief(epicId, env);
    const bad = {
      ...sparkCell(taskIds[0] as string),
      spark_fit: false,
      spark_exclusion: "fixed-shape-too-large",
      extra: "nope",
    };
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({ cells: [bad] }),
      env,
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    const details = errDetails(r.output);
    expect(details.some((d) => d.includes("unknown key `extra`"))).toBe(true);
    expect(details.some((d) => d.includes("spark_fit` true"))).toBe(true);
    expect(details.some((d) => d.includes("spark_exclusion` null"))).toBe(true);
    expect(existsSync(sidecarPath(epicId))).toBe(false);
  });

  test("Spark absent from the brief axis rejects Spark evidence with an axis reason", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    makeLiveBrief(epicId);
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({ cells: [sparkCell(taskIds[0] as string)] }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("verdict_invalid");
    const details = errDetails(r.output);
    expect(details.some((d) => d.includes("not a candidate"))).toBe(true);
    expect(
      details.some((d) => d.includes("Spark is not on the brief axis")),
    ).toBe(true);
  });
});

describe("apply-selection brief_missing", () => {
  test("no brief on disk for a guided apply rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    // No selection-brief run.
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [nonSparkCell(taskIds[0] as string, "high")],
      }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("brief_missing");
  });

  test("a from_followup flag mismatch rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    makeLiveBrief(epicId);
    // Corrupt the live brief's flag so it no longer matches a live invocation.
    const bp = briefFilePath(epicId, "brief.json");
    const brief = JSON.parse(readFileSync(bp, "utf-8"));
    brief.from_followup = true;
    writeFileSync(bp, JSON.stringify(brief), "utf-8");

    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [nonSparkCell(taskIds[0] as string, "high")],
      }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("brief_missing");
    expect(errDetails(r.output).some((d) => d.includes("from_followup"))).toBe(
      true,
    );
  });
});

describe("apply-selection cell_invalid", () => {
  test("a task claimed after the brief (non-todo) rejects in-lock", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    makeLiveBrief(epicId);
    // Take task 2 out of todo AFTER the brief captured it — the brief still
    // lists both, so brief coverage passes; the in-lock re-read rejects it.
    seedRuntime(project.root, taskIds[1] as string, { status: "in_progress" });
    const r = run(["apply-selection", epicId, "--file", "-"], {
      input: JSON.stringify({
        cells: [
          nonSparkCell(taskIds[0] as string, "high"),
          nonSparkCell(taskIds[1] as string, "max"),
        ],
      }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    expect(errDetails(r.output).some((d) => d.includes("not in `todo`"))).toBe(
      true,
    );
    // No cells landed on the reject.
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
    expect(existsSync(sidecarPath(epicId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry membership
// ---------------------------------------------------------------------------

describe("apply-selection registry", () => {
  test("epic_not_found on a missing epic", () => {
    scaffoldEpic(project, { nTasks: 1 });
    const r = run(["apply-selection", "fn-99999-nope", "--file", "-"], {
      input: JSON.stringify({ cells: [] }),
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("epic_not_found");
  });

  test("apply-selection is a canonical integrity-gate verb", () => {
    expect(INTEGRITY_GATE_VERBS).toContain("apply-selection");
  });
});

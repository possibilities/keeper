// Conformance spec for `keeper plan assign-cells` — the batch model-effort
// selector write-path. Covers: the happy batch overwrite (cells applied + sidecar
// present + single envelope + same-commit membership); the arm-exclusive latch
// (an armed marker byte-identical after the write, a dep-less ghost still a ghost
// that only the trailing validate arms); every cell_invalid variant (unknown /
// duplicate / missing coverage / non-todo target / out-of-axis tier / out-of-axis
// model); the bad_yaml shape fork; the degrade-shaped invocation (identical cells,
// degraded outcome, heuristic-default provenance); re-run REPLACES the sidecar;
// epic_not_found; stdin; and the canonical integrity-gate-verb + problem-code
// registry membership.
//
// Every fixture is a withProject epic scaffolded through the binary (tasks land
// tier=medium/model=opus), so assign-cells overwrites real committed defs.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoveryForPlanCode } from "../src/emit.ts";
import { INTEGRITY_GATE_VERBS } from "../src/integrity_gate.ts";
import {
  firstJsonPayload,
  gitFilesInHead,
  gitLogCount,
  type ProjectHandle,
  runCli,
  scaffoldEpic,
  seedRuntime,
  withProject,
} from "./harness.ts";

let project: ProjectHandle;
const getProject = withProject("planctl-assign-");
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

interface CellInput {
  taskId: string;
  tier: string;
  model: string;
  rationale?: string;
  confidence?: number | string;
  labelSource?: string;
}

interface SelectionInput {
  harness?: string;
  model?: string;
  configHash?: string;
  inputHash?: string;
  shuffleSeed?: number | null;
  outcome?: string;
  verdictRaw?: string | null;
}

/** Build an assign-cells `--file` YAML from cell + selection inputs. */
function assignYaml(cells: CellInput[], sel: SelectionInput = {}): string {
  const cellBlocks = cells.map((c) => {
    const lines = [
      `  - task_id: ${c.taskId}`,
      `    tier: ${c.tier}`,
      `    model: ${c.model}`,
      `    label_source: ${c.labelSource ?? "heuristic-guided"}`,
    ];
    if (c.rationale !== undefined) {
      lines.push(`    rationale: ${JSON.stringify(c.rationale)}`);
    }
    if (c.confidence !== undefined) {
      lines.push(`    confidence: ${c.confidence}`);
    }
    return lines.join("\n");
  });
  const selLines = [
    "selection:",
    `  harness: ${sel.harness ?? "claude"}`,
    `  model: ${sel.model ?? "opus"}`,
    `  config_hash: ${sel.configHash ?? "cfg-abc"}`,
    `  input_hash: ${sel.inputHash ?? "in-xyz"}`,
    `  outcome: ${JSON.stringify(sel.outcome ?? "completed")}`,
  ];
  if (sel.shuffleSeed !== undefined) {
    selLines.push(
      `  shuffle_seed: ${sel.shuffleSeed === null ? "null" : sel.shuffleSeed}`,
    );
  }
  if (sel.verdictRaw !== undefined) {
    selLines.push(
      `  verdict_raw: ${sel.verdictRaw === null ? "null" : JSON.stringify(sel.verdictRaw)}`,
    );
  }
  return `cells:\n${cellBlocks.join("\n")}\n${selLines.join("\n")}\n`;
}

function writeInput(content: string, name = "cells.yaml"): string {
  const path = join(project.root, name);
  require("node:fs").writeFileSync(path, content, "utf-8");
  return path;
}

function readTask(taskId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "tasks", `${taskId}.json`),
      "utf-8",
    ),
  );
}

function readEpic(epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "epics", `${epicId}.json`),
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

function errCode(output: string): unknown {
  return (firstJsonPayload(output).error as Record<string, unknown>).code;
}

function stampOldMarker(epicId: string): void {
  const data = readEpic(epicId);
  data.last_validated_at = "2020-01-01T00:00:00.000000Z";
  require("node:fs").writeFileSync(
    join(project.root, ".keeper", "epics", `${epicId}.json`),
    JSON.stringify(data),
    "utf-8",
  );
}

/** The canonical `label_source` a real (non-degrade) runtime selection
 * persists — the exact string the plan Phase 6.5g, defer Phase 4b, and README
 * verb-entry callers write. A degrade stamps `heuristic-default` instead. This
 * is the independent source of truth (the caller docs), not a value the verb
 * derives. */
const REAL_SELECTION_LABEL_SOURCE = "heuristic-guided";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("assign-cells happy path", () => {
  test("batch-overwrites tier/model, writes the sidecar, single envelope", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const yaml = assignYaml(
      [
        {
          taskId: taskIds[0] as string,
          tier: "xhigh",
          model: "opus",
          rationale: "needs strong reasoning",
          confidence: 0.9,
        },
        { taskId: taskIds[1] as string, tier: "high", model: "opus" },
      ],
      { shuffleSeed: 7, verdictRaw: "picked xhigh for task 1" },
    );

    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.assigned_task_ids).toEqual(taskIds);

    // Exactly one envelope carrying the invocation.
    expect(
      r.output
        .trim()
        .split("\n")
        .filter((ln) => ln.includes("plan_invocation")).length,
    ).toBe(1);

    // Cells overwritten on both task JSONs.
    expect(readTask(taskIds[0] as string).tier).toBe("xhigh");
    expect(readTask(taskIds[1] as string).tier).toBe("high");

    // Sidecar present with the full provenance record.
    expect(existsSync(sidecarPath(epicId))).toBe(true);
    const sc = readSidecar(epicId);
    expect(sc.schema_version).toBe(1);
    expect(sc.epic_id).toBe(epicId);
    expect(sc.selector).toEqual({ harness: "claude", model: "opus" });
    expect(sc.config_hash).toBe("cfg-abc");
    expect(sc.input_hash).toBe("in-xyz");
    expect(sc.shuffle_seed).toBe(7);
    expect(sc.outcome).toBe("completed");
    expect(sc.verdict_raw).toBe("picked xhigh for task 1");
    const cells = sc.cells as Record<string, unknown>[];
    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual({
      task_id: taskIds[0],
      tier: "xhigh",
      model: "opus",
      rationale: "needs strong reasoning",
      confidence: 0.9,
      label_source: "heuristic-guided",
    });
    // Omitted rationale/confidence default to null (stable key set).
    expect(cells[1]?.rationale).toBeNull();
    expect(cells[1]?.confidence).toBeNull();
  });

  test("cells + sidecar land in ONE auto-commit", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
      { taskId: taskIds[1] as string, tier: "high", model: "opus" },
    ]);
    const before = gitLogCount(project.root);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    // Exactly one new commit.
    expect(gitLogCount(project.root)).toBe(before + 1);
    // Both the cell writes AND the sidecar appear in that HEAD commit's tree.
    const files = gitFilesInHead(project.root);
    expect(files).toContain(`.keeper/tasks/${taskIds[0]}.json`);
    expect(files).toContain(`.keeper/selections/${epicId}.json`);
  });

  test("leaves an armed validation marker byte-identical", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    stampOldMarker(epicId);
    const pre = readEpic(epicId).last_validated_at as string;
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    // The arm-exclusive latch: the select-window write never refreshes the marker.
    expect(readEpic(epicId).last_validated_at).toBe(pre);
  });

  test("incident: a select-window write on a dep-less ghost leaves it a ghost; only validate arms it", () => {
    // The dispatch-safety regression: assign-cells on a freshly-scaffolded epic
    // whose depends_on_epics is still empty must NOT arm it — a ghost that armed
    // here would let autopilot dispatch before deps are wired.
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    expect(readEpic(epicId).depends_on_epics ?? []).toEqual([]);
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    // Still a ghost after the cell write.
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    // Only the trailing validate --epic arms it (null → timestamp).
    const armed = run(["validate", "--epic", epicId]);
    expect(armed.code).toBe(0);
    expect(readEpic(epicId).last_validated_at).not.toBeNull();
  });

  test("a real runtime selection persists the canonical label_source", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    // Feed the label a real caller writes (plan/defer/README), then assert the
    // sidecar persists exactly that canonical string — a hand-written literal
    // matching the caller docs, not a value re-derived from the input.
    const yaml = assignYaml([
      {
        taskId: taskIds[0] as string,
        tier: "xhigh",
        model: "opus",
        labelSource: REAL_SELECTION_LABEL_SOURCE,
      },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    const cell = (readSidecar(epicId).cells as Record<string, unknown>[])[0];
    expect(cell?.label_source).toBe("heuristic-guided");
  });

  test("a string-valued confidence round-trips opaque into the sidecar", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      {
        taskId: taskIds[0] as string,
        tier: "xhigh",
        model: "opus",
        confidence: "high",
      },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    const cell = (readSidecar(epicId).cells as Record<string, unknown>[])[0];
    expect(cell?.confidence).toBe("high");
  });

  test("reads the cell set from stdin (--file -)", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "max", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", "-"], { input: yaml });
    expect(r.code).toBe(0);
    expect(firstJsonPayload(r.output).success).toBe(true);
    expect(readTask(taskIds[0] as string).tier).toBe("max");
  });
});

// ---------------------------------------------------------------------------
// cell_invalid variants — assert-all, zero writes
// ---------------------------------------------------------------------------

describe("assign-cells cell_invalid", () => {
  test("unknown task id rejects the batch, nothing written", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
      { taskId: taskIds[1] as string, tier: "high", model: "opus" },
      { taskId: `${epicId}.99`, tier: "high", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    // No writes: task 1 keeps its scaffolded tier, no sidecar.
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
    expect(existsSync(sidecarPath(epicId))).toBe(false);
  });

  test("duplicate cell for a task rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
      { taskId: taskIds[0] as string, tier: "high", model: "opus" },
      { taskId: taskIds[1] as string, tier: "high", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    const details = (
      firstJsonPayload(r.output).error as Record<string, unknown>
    ).details as string[];
    expect(details.some((d) => d.includes("duplicate"))).toBe(true);
  });

  test("missing coverage of a todo task rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    const details = (
      firstJsonPayload(r.output).error as Record<string, unknown>
    ).details as string[];
    expect(
      details.some(
        (d) => d.includes("not covered") && d.includes(taskIds[1] as string),
      ),
    ).toBe(true);
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
  });

  test("a cell targeting a non-todo task rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    // Take task 2 out of todo via a runtime overlay.
    seedRuntime(project.root, taskIds[1] as string, { status: "done" });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
      { taskId: taskIds[1] as string, tier: "high", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    const details = (
      firstJsonPayload(r.output).error as Record<string, unknown>
    ).details as string[];
    expect(details.some((d) => d.includes("not in `todo`"))).toBe(true);
  });

  test("out-of-axis tier rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "bogus", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    const details = (
      firstJsonPayload(r.output).error as Record<string, unknown>
    ).details as string[];
    expect(details.some((d) => d.includes("'bogus'"))).toBe(true);
  });

  test("out-of-axis model rejects", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "gpt" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    const details = (
      firstJsonPayload(r.output).error as Record<string, unknown>
    ).details as string[];
    expect(details.some((d) => d.includes("'gpt'"))).toBe(true);
  });

  // Ragged host roster: opus's own effort list is narrowed to [medium], so a tier
  // valid in the top-level axis but outside that model's list is rejected, naming
  // the model. This is the per-model (ragged) axis gate — a flat global check would
  // silently accept a tier the model cannot render.
  const cfgDirs: string[] = [];
  afterAll(() => {
    for (const d of cfgDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });
  function cfgWithMatrix(matrixYaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "assign-ragged-cfg-"));
    cfgDirs.push(dir);
    writeFileSync(join(dir, "matrix.yaml"), matrixYaml);
    return dir;
  }
  const RAGGED_MATRIX = [
    "efforts: [medium, high]",
    "subagent_templates: [template/agents/worker.md.tmpl]",
    "subagent_models: [opus]",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - id: opus",
    "        efforts: [medium]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: medium",
    "",
  ].join("\n");

  test("a tier outside the model's own effort list rejects, naming the model", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const cfg = cfgWithMatrix(RAGGED_MATRIX);
    // `high` is in the top-level axis but NOT in opus's narrowed list [medium].
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "high", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)], {
      env: { KEEPER_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("cell_invalid");
    const details = (
      firstJsonPayload(r.output).error as Record<string, unknown>
    ).details as string[];
    const tierErr = details.find((d) => d.includes("'high'"));
    expect(tierErr).toBeDefined();
    // Ragged: the rejection names the model and the model's own list.
    expect(tierErr as string).toContain("for model 'opus'");
    expect(tierErr as string).toContain("medium");
    // No write landed — the task keeps its scaffolded default cell.
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
  });

  test("no host matrix present fails loud with the typed MATRIX_INVALID envelope", () => {
    // assign-cells reads the axes but does not catch internally — the dispatch-level
    // catch converts the required-matrix-absent throw into a typed error envelope
    // rather than an uncaught stack (v2 has no embedded fallback).
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const emptyCfg = mkdtempSync(join(tmpdir(), "assign-nomatrix-"));
    cfgDirs.push(emptyCfg);
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "xhigh", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)], {
      env: { KEEPER_CONFIG_DIR: emptyCfg },
    });
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("MATRIX_INVALID");
  });

  test("the same tier inside the model's own effort list is accepted", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const cfg = cfgWithMatrix(RAGGED_MATRIX);
    // `medium` IS in opus's narrowed list — the ragged gate accepts it.
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "medium", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)], {
      env: { KEEPER_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(0);
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
    expect(readTask(taskIds[0] as string).model).toBe("opus");
  });

  test("a non-string tier is bad_yaml (shape), not cell_invalid", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml =
      `cells:\n  - task_id: ${taskIds[0]}\n    tier: 42\n    model: opus\n` +
      "    label_source: heuristic-guided\n" +
      "selection:\n  harness: claude\n  model: opus\n" +
      "  config_hash: c\n  input_hash: i\n  outcome: completed\n";
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("bad_yaml");
  });

  // The selection-block guards (requireSelStr / shuffle_seed integer / verdict_raw
  // string) — a well-formed cell set with ONE malformed selection field rejects
  // as bad_yaml, before any membership/axis check.
  test("a malformed selection: block rejects with bad_yaml", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const goodCell =
      `cells:\n  - task_id: ${taskIds[0]}\n    tier: xhigh\n    model: opus\n` +
      "    label_source: heuristic-guided\n";
    // Each variant swaps exactly one selection field to an invalid shape.
    const variants: [string, string][] = [
      // empty harness — requireSelStr rejects a blank required string
      [
        "empty harness",
        'selection:\n  harness: ""\n  model: opus\n' +
          "  config_hash: c\n  input_hash: i\n  outcome: completed\n",
      ],
      // non-integer shuffle_seed
      [
        "non-integer shuffle_seed",
        "selection:\n  harness: claude\n  model: opus\n" +
          "  config_hash: c\n  input_hash: i\n  outcome: completed\n" +
          "  shuffle_seed: 1.5\n",
      ],
      // non-string verdict_raw
      [
        "non-string verdict_raw",
        "selection:\n  harness: claude\n  model: opus\n" +
          "  config_hash: c\n  input_hash: i\n  outcome: completed\n" +
          "  verdict_raw: 42\n",
      ],
    ];
    for (const [label, selBlock] of variants) {
      const r = run([
        "assign-cells",
        epicId,
        "--file",
        writeInput(
          goodCell + selBlock,
          `sel-${label.replace(/\s+/g, "-")}.yaml`,
        ),
      ]);
      expect(r.code).toBe(1);
      expect(errCode(r.output)).toBe("bad_yaml");
      // No sidecar written on any shape rejection.
      expect(existsSync(sidecarPath(epicId))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Degrade shape + idempotent re-select
// ---------------------------------------------------------------------------

describe("assign-cells degrade + re-select", () => {
  test("identical cells + degraded outcome succeeds, records heuristic-default", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    // Cells equal to the scaffolded default values, tagged as a degrade.
    const yaml = assignYaml(
      [
        {
          taskId: taskIds[0] as string,
          tier: "medium",
          model: "opus",
          labelSource: "heuristic-default",
        },
      ],
      { outcome: "degraded:selector-error", verdictRaw: null },
    );
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    expect(firstJsonPayload(r.output).outcome).toBe("degraded:selector-error");
    const sc = readSidecar(epicId);
    expect(sc.outcome).toBe("degraded:selector-error");
    expect(sc.verdict_raw).toBeNull();
    expect((sc.cells as Record<string, unknown>[])[0]?.label_source).toBe(
      "heuristic-default",
    );
    // Value is unchanged (still the default), but the run is captured as data.
    expect(readTask(taskIds[0] as string).tier).toBe("medium");
  });

  test("re-run REPLACES the sidecar (no append)", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const first = assignYaml(
      [{ taskId: taskIds[0] as string, tier: "high", model: "opus" }],
      { configHash: "h1" },
    );
    expect(
      run(["assign-cells", epicId, "--file", writeInput(first, "a.yaml")]).code,
    ).toBe(0);
    expect(readSidecar(epicId).config_hash).toBe("h1");

    const second = assignYaml(
      [{ taskId: taskIds[0] as string, tier: "max", model: "opus" }],
      { configHash: "h2" },
    );
    expect(
      run(["assign-cells", epicId, "--file", writeInput(second, "b.yaml")])
        .code,
    ).toBe(0);
    const sc = readSidecar(epicId);
    // Replaced, not appended: one object, latest config + latest cell.
    expect(sc.config_hash).toBe("h2");
    expect((sc.cells as Record<string, unknown>[])[0]?.tier).toBe("max");
    expect(readTask(taskIds[0] as string).tier).toBe("max");
  });
});

// ---------------------------------------------------------------------------
// audit_required stamping (audit-policy.yaml) + degrade provenance
// ---------------------------------------------------------------------------

describe("assign-cells audit_required stamping", () => {
  test("a policy-flagged tier stamps audit_required=true; an unflagged tier stays false", () => {
    // The committed audit-policy.yaml flags `max` only (conservative rollout),
    // so a max cell parks for a per-task audit and a high cell does not. The
    // flag values are the config's contract, not re-derived here.
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "max", model: "opus" },
      { taskId: taskIds[1] as string, tier: "high", model: "opus" },
    ]);
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(0);
    expect(readTask(taskIds[0] as string).audit_required).toBe(true);
    expect(readTask(taskIds[1] as string).audit_required).toBe(false);

    // The sidecar records applied provenance naming the flagged task.
    const ap = readSidecar(epicId).audit_policy as Record<string, unknown>;
    expect(ap.status).toBe("applied");
    expect(ap.reason).toBeNull();
    expect(ap.flagged_task_ids).toEqual([taskIds[0]]);
  });

  test("an absent policy degrades to no flag, recorded in the sidecar", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "max", model: "opus" },
    ]);
    // Point the policy path at a file that does not exist -> degrade.
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)], {
      env: { KEEPER_PLAN_AUDIT_POLICY: join(project.root, "no-policy.yaml") },
    });
    expect(r.code).toBe(0);
    // Even a would-be-flagged max tier is unflagged under a degrade.
    expect(readTask(taskIds[0] as string).audit_required).toBe(false);
    const ap = readSidecar(epicId).audit_policy as Record<string, unknown>;
    expect(ap.status).toBe("degraded");
    expect(ap.reason).toBe("absent");
    expect(ap.flagged_task_ids).toEqual([]);
  });

  test("a malformed policy degrades (never an error)", () => {
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      { taskId: taskIds[0] as string, tier: "max", model: "opus" },
    ]);
    // tier_audit as a scalar (not a mapping) is malformed for the runtime read.
    const badPolicy = writeInput("tier_audit: nope\n", "bad-policy.yaml");
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)], {
      env: { KEEPER_PLAN_AUDIT_POLICY: badPolicy },
    });
    expect(r.code).toBe(0);
    expect(readTask(taskIds[0] as string).audit_required).toBe(false);
    const ap = readSidecar(epicId).audit_policy as Record<string, unknown>;
    expect(ap.status).toBe("degraded");
    expect(ap.reason).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// Failure shapes + registry membership
// ---------------------------------------------------------------------------

describe("assign-cells misc", () => {
  test("epic_not_found on a missing epic", () => {
    scaffoldEpic(project, { nTasks: 1 });
    const yaml = assignYaml([
      { taskId: "fn-99999-nope.1", tier: "xhigh", model: "opus" },
    ]);
    const r = run([
      "assign-cells",
      "fn-99999-nope",
      "--file",
      writeInput(yaml),
    ]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("epic_not_found");
  });

  test("empty cells is bad_yaml", () => {
    const { epicId } = scaffoldEpic(project, { nTasks: 1 });
    const yaml =
      "cells: []\nselection:\n  harness: claude\n  model: opus\n" +
      "  config_hash: c\n  input_hash: i\n  outcome: completed\n";
    const r = run(["assign-cells", epicId, "--file", writeInput(yaml)]);
    expect(r.code).toBe(1);
    expect(errCode(r.output)).toBe("bad_yaml");
  });

  test("assign-cells is a canonical integrity-gate verb", () => {
    expect(INTEGRITY_GATE_VERBS).toContain("assign-cells");
  });

  test("cell_invalid carries a registered (non-default) recovery", () => {
    const rec = recoveryForPlanCode("cell_invalid");
    expect(rec).not.toBe(recoveryForPlanCode("totally_unknown_code"));
    expect(rec.toLowerCase()).toContain("cell");
  });
});

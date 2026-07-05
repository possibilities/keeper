// selection-brief verb — content-blind handoff for the post-scaffold
// model/effort selector.
//
// Builds a gitignored brief under `.keeper/state/selections/<epic_id>/brief.json`
// carrying the selector policy config, epic spec, todo task specs, and candidate
// {model, effort} cells. `/plan:plan` and `/plan:defer` pass only the brief path
// to the `plan:model-selector` subagent; the planner stays content-blind to the
// selector's read context just like `/plan:work` and `/plan:close` do.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import {
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import { loadSubagentsMatrixFromDisk } from "../subagents_config.ts";
import { atomicWriteRaw, serializeStateJson } from "../store.ts";
import { loadYamlInput } from "../yaml_input.ts";

export const SELECTION_BRIEF_SCHEMA_VERSION = 1;

export interface SelectionBriefArgs {
  epicId: string;
  project: string | null;
  format: OutputFormat | null;
}

function emitSelectionBriefError(
  code: string,
  message: string,
  format: OutputFormat | null,
  details?: Record<string, unknown>,
): never {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  formatOutput({ success: false, error }, format);
  process.exit(1);
}

function planPluginRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readUtf8(
  path: string,
  code: string,
  format: OutputFormat | null,
): string {
  if (!existsSync(path)) {
    emitSelectionBriefError(code, `required file missing: ${path}`, format, {
      path,
    });
  }
  return readFileSync(path, "utf-8");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function taskStatus(t: Record<string, unknown>): string {
  const raw = t.status ?? t.runtime_status;
  return typeof raw === "string" && raw !== "" ? raw : "todo";
}

function selectionBriefPath(stateDir: string, epicId: string): string {
  return join(stateDir, "selections", epicId, "brief.json");
}

function preflightEpicResolution(
  epicId: string,
  project: string | null,
  format: OutputFormat | null,
): void {
  const res = tryResolveOwningProjectForId(epicId, project);
  if (res.ok) {
    return;
  }
  if (res.reason === "no_project") {
    emitSelectionBriefError(
      "NOT_A_PROJECT",
      `no plan project found at ${res.projectRoot}`,
      format,
      { project: res.projectRoot },
    );
  }
  if (res.reason === "ambiguous") {
    emitSelectionBriefError(
      "AMBIGUOUS_EPIC_ID",
      `epic ${res.id} exists in multiple projects; pass --project`,
      format,
      { owners: res.owners },
    );
  }
  emitSelectionBriefError(
    "EPIC_NOT_FOUND",
    `epic not found: ${res.id}`,
    format,
    { epic_id: res.id },
  );
}

function validateYamlFile(
  path: string,
  code: string,
  format: OutputFormat | null,
): void {
  try {
    loadYamlInput(path);
  } catch (exc) {
    emitSelectionBriefError(
      code,
      `required YAML file is missing or invalid: ${path}`,
      format,
      { path, error: exc instanceof Error ? exc.message : String(exc) },
    );
  }
}

function shuffledCellsForTask(
  base: readonly { model: string; tier: string }[],
  inputHash: string,
  taskId: string,
): { model: string; tier: string }[] {
  return [...base].sort((a, b) => {
    const ah = sha256(`${inputHash}:${taskId}:${a.model}:${a.tier}`);
    const bh = sha256(`${inputHash}:${taskId}:${b.model}:${b.tier}`);
    return ah.localeCompare(bh);
  });
}

export function runSelectionBrief(args: SelectionBriefArgs): void {
  const { epicId, project, format } = args;
  if (!isEpicId(epicId)) {
    emitSelectionBriefError(
      "BAD_EPIC_ID",
      `invalid epic id: ${epicId || "<empty>"}`,
      format,
    );
  }

  preflightEpicResolution(epicId, project, format);
  const ctx = resolvePlanStateContext(epicId, project, format);
  const root = planPluginRoot();
  const configPath = join(root, "model-selector.yaml");
  const subagentsPath = join(root, "subagents.yaml");
  const selectorConfigYaml = readUtf8(
    configPath,
    "CONFIG_MISSING",
    format,
  );
  validateYamlFile(configPath, "CONFIG_MISSING", format);
  const subagentsYaml = readUtf8(subagentsPath, "MATRIX_MISSING", format);
  validateYamlFile(subagentsPath, "MATRIX_MISSING", format);
  let matrix: ReturnType<typeof loadSubagentsMatrixFromDisk>;
  try {
    matrix = loadSubagentsMatrixFromDisk(subagentsPath);
  } catch (exc) {
    emitSelectionBriefError(
      "MATRIX_MISSING",
      `configured model/effort matrix is missing or invalid: ${subagentsPath}`,
      format,
      {
        path: subagentsPath,
        error: exc instanceof Error ? exc.message : String(exc),
      },
    );
  }

  const epicDef = loadEpic(ctx, epicId);
  const primaryRepo =
    typeof epicDef.primary_repo === "string" && epicDef.primary_repo !== ""
      ? epicDef.primary_repo
      : ctx.projectPath;

  const epicSpecPath = join(ctx.dataDir, "specs", `${epicId}.md`);
  const epicSpecMd = readUtf8(epicSpecPath, "EPIC_SPEC_MISSING", format);
  const tasks = loadTasksForEpic(ctx, epicId).sort(
    (a, b) => taskSortKey(asString(a.id)) - taskSortKey(asString(b.id)),
  );
  const todoTasks = tasks.filter((t) => taskStatus(t) === "todo");
  if (todoTasks.length === 0) {
    emitSelectionBriefError(
      "NO_TODO_TASKS",
      `epic ${epicId} has no todo tasks for cell selection`,
      format,
    );
  }

  const candidateCells = matrix.models.flatMap((model) =>
    matrix.efforts.map((effort) => ({ model, tier: effort })),
  );
  const briefTasksBase = todoTasks.map((t) => {
    const taskId = asString(t.id);
    const specPath = join(ctx.dataDir, "specs", `${taskId}.md`);
    const specMd = readUtf8(specPath, "TASK_SPEC_MISSING", format);
    return {
      task_id: taskId,
      title: asString(t.title),
      current_tier: typeof t.tier === "string" ? t.tier : null,
      current_model: typeof t.model === "string" ? t.model : null,
      target_repo: typeof t.target_repo === "string" ? t.target_repo : null,
      depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [],
      spec_chars: specMd.length,
      spec_md: specMd,
    };
  });

  const inputForHash = JSON.stringify({
    epic_id: epicId,
    epic_spec_md: epicSpecMd,
    tasks: briefTasksBase.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      target_repo: t.target_repo,
      depends_on: t.depends_on,
      spec_md: t.spec_md,
    })),
    subagents_yaml: subagentsYaml,
  });
  const configHash = sha256(selectorConfigYaml);
  const inputHash = sha256(inputForHash);
  const shuffleSeed = Number.parseInt(inputHash.slice(0, 8), 16);
  const briefTasks = briefTasksBase.map((t) => ({
    ...t,
    candidate_cells: shuffledCellsForTask(candidateCells, inputHash, t.task_id),
  }));

  const brief = {
    schema_version: SELECTION_BRIEF_SCHEMA_VERSION,
    epic_id: epicId,
    primary_repo: primaryRepo,
    selector_config_path: configPath,
    selector_config_hash: configHash,
    selector_config_yaml: selectorConfigYaml,
    subagents_path: subagentsPath,
    subagents_yaml: subagentsYaml,
    efforts: matrix.efforts,
    models: matrix.models,
    input_hash: inputHash,
    shuffle_seed: shuffleSeed,
    epic: {
      epic_id: epicId,
      spec_chars: epicSpecMd.length,
      spec_md: epicSpecMd,
    },
    tasks: briefTasks,
  };

  const briefRef = selectionBriefPath(ctx.stateDir, epicId);
  atomicWriteRaw(briefRef, serializeStateJson(brief));

  formatOutput(
    {
      success: true,
      epic_id: epicId,
      primary_repo: primaryRepo,
      brief_ref: briefRef,
      config_hash: configHash,
      input_hash: inputHash,
      shuffle_seed: shuffleSeed,
      task_ids: briefTasks.map((t) => t.task_id),
      candidate_cells: candidateCells,
    },
    format,
  );
}

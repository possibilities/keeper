// selection-brief verb — content-blind handoff for the post-scaffold
// model/effort selector.
//
// Builds a gitignored brief under `.keeper/state/selections/<epic_id>/brief.json`
// carrying the selector policy config, epic spec, todo task specs, and candidate
// {model, effort} cells. `/plan:plan` and `/plan:defer` pass only the brief path
// to the `plan:model-selector` subagent; the planner stays content-blind to the
// selector's read context just like `/plan:work` and `/plan:close` do.
//
// Two sources, one envelope: the default source briefs a LIVE epic's todo tasks
// (keyed by real task id). The `--from-followup` source instead briefs the stored
// follow-up document of a source epic (`audits/<epic>/followup.yaml`) — its tasks
// have no ids yet, so they key by 1-based ordinal and the input_hash anchors on
// the stored document, letting a close pre-select cells before finalize mints the
// follow-up tree. Both emit the same envelope fields.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import { followupPath } from "../audit_artifacts.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import {
  type ProjectContext,
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import { atomicWriteRaw, serializeStateJson } from "../store.ts";
import { loadSubagentsMatrixFromDisk } from "../subagents_config.ts";
import { loadYamlInput, parseYamlInput } from "../yaml_input.ts";

export const SELECTION_BRIEF_SCHEMA_VERSION = 1;

export interface SelectionBriefArgs {
  epicId: string;
  project: string | null;
  format: OutputFormat | null;
  /** Brief the stored follow-up document of `epicId` (ordinal-keyed tasks)
   * instead of the live epic's todo tasks. */
  fromFollowup: boolean;
}

/** One task row of a brief, before its per-task candidate-cell shuffle is added.
 * `task_id` is the real task id in the live source, a 1-based ordinal string in
 * the follow-up source. */
interface BriefTaskBase {
  task_id: string;
  title: string;
  current_tier: string | null;
  current_model: string | null;
  target_repo: string | null;
  depends_on: string[];
  spec_chars: number;
  spec_md: string;
}

/** The mode-specific inputs the shared brief assembly consumes. */
interface BriefSource {
  briefTasksBase: BriefTaskBase[];
  epicSpecMd: string;
  /** The exact string hashed into `input_hash` — mode-specific so provenance is
   * reproducible from the same source. */
  inputForHash: string;
  /** Brief-file basename under `selections/<epic_id>/`. */
  briefBasename: string;
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

function selectionBriefPath(
  stateDir: string,
  epicId: string,
  basename = "brief.json",
): string {
  return join(stateDir, "selections", epicId, basename);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  const selectorConfigYaml = readUtf8(configPath, "CONFIG_MISSING", format);
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

  const candidateCells = matrix.models.flatMap((model) =>
    matrix.efforts.map((effort) => ({ model, tier: effort })),
  );

  const source = args.fromFollowup
    ? collectFollowupSource(epicId, primaryRepo, format)
    : collectLiveSource(ctx, epicId, format, subagentsYaml);

  const configHash = sha256(selectorConfigYaml);
  const inputHash = sha256(source.inputForHash);
  const shuffleSeed = Number.parseInt(inputHash.slice(0, 8), 16);
  const briefTasks = source.briefTasksBase.map((t) => ({
    ...t,
    candidate_cells: shuffledCellsForTask(candidateCells, inputHash, t.task_id),
  }));

  const brief = {
    schema_version: SELECTION_BRIEF_SCHEMA_VERSION,
    epic_id: epicId,
    primary_repo: primaryRepo,
    from_followup: args.fromFollowup,
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
      spec_chars: source.epicSpecMd.length,
      spec_md: source.epicSpecMd,
    },
    tasks: briefTasks,
  };

  const briefRef = selectionBriefPath(
    ctx.stateDir,
    epicId,
    source.briefBasename,
  );
  atomicWriteRaw(briefRef, serializeStateJson(brief));

  formatOutput(
    {
      success: true,
      epic_id: epicId,
      primary_repo: primaryRepo,
      from_followup: args.fromFollowup,
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

/** Collect the brief source from a LIVE epic's todo tasks (keyed by real task
 * id). Preserves the exact input-hash shape the selector's provenance rides. */
function collectLiveSource(
  ctx: ProjectContext,
  epicId: string,
  format: OutputFormat | null,
  subagentsYaml: string,
): BriefSource {
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
  const briefTasksBase: BriefTaskBase[] = todoTasks.map((t) => {
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
  return {
    briefTasksBase,
    epicSpecMd,
    inputForHash,
    briefBasename: "brief.json",
  };
}

/** Collect the brief source from the stored follow-up document of `epicId`
 * (`audits/<epic>/followup.yaml`). Tasks key by 1-based ordinal (the follow-up
 * has no ids yet); the input_hash anchors on the stored document's raw bytes so a
 * later pre-select against this brief is reproducible. Missing / unparseable
 * documents fail closed with a typed error. */
function collectFollowupSource(
  epicId: string,
  primaryRepo: string,
  format: OutputFormat | null,
): BriefSource {
  const fp = followupPath(primaryRepo, epicId);
  if (!existsSync(fp)) {
    emitSelectionBriefError(
      "FOLLOWUP_MISSING",
      `no stored follow-up document for ${epicId} at ${fp}; run ` +
        "`keeper plan followup submit` (via /plan:close) first",
      format,
      { expected: fp },
    );
  }
  const text = readFileSync(fp, "utf-8");
  let doc: unknown;
  try {
    doc = parseYamlInput(Buffer.from(text, "utf-8"), fp);
  } catch (exc) {
    emitSelectionBriefError(
      "FOLLOWUP_INVALID",
      `stored follow-up document for ${epicId} is not valid YAML: ${fp}`,
      format,
      { path: fp, error: exc instanceof Error ? exc.message : String(exc) },
    );
  }
  if (
    !isPlainObject(doc) ||
    !Array.isArray(doc.tasks) ||
    doc.tasks.length === 0
  ) {
    emitSelectionBriefError(
      "FOLLOWUP_INVALID",
      `stored follow-up document for ${epicId} has no task list: ${fp}`,
      format,
      { path: fp },
    );
  }
  const docObj = doc as Record<string, unknown>;
  const epicNode = isPlainObject(docObj.epic) ? docObj.epic : {};
  const epicSpecMd = typeof epicNode.spec === "string" ? epicNode.spec : "";
  const briefTasksBase: BriefTaskBase[] = (docObj.tasks as unknown[]).map(
    (entry, idx) => {
      const e = isPlainObject(entry) ? entry : {};
      const spec = typeof e.spec === "string" ? e.spec : "";
      const deps = Array.isArray(e.deps)
        ? e.deps
            .filter((d) => typeof d === "number" && Number.isInteger(d))
            .map(String)
        : [];
      return {
        task_id: String(idx + 1),
        title: typeof e.title === "string" ? e.title : "",
        current_tier: typeof e.tier === "string" ? e.tier : null,
        current_model: typeof e.model === "string" ? e.model : null,
        target_repo: typeof e.target_repo === "string" ? e.target_repo : null,
        depends_on: deps,
        spec_chars: spec.length,
        spec_md: spec,
      };
    },
  );
  return {
    briefTasksBase,
    epicSpecMd,
    inputForHash: text,
    briefBasename: "followup-brief.json",
  };
}

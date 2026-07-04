// assign-cells verb — batch-overwrite the {tier, model} cells of a ghost epic's
// todo tasks during the post-scaffold ghost window, landing the cell writes AND a
// git-committed selection sidecar in ONE auto-commit.
//
// BATCH-ONLY by contract: it reads one YAML cell set that must cover EVERY todo
// task of the epic exactly once (choosing the default is an explicit cell) plus a
// `selection:` provenance block, asserts the whole batch (assert-all,
// collect-all), mutates every task JSON under the epic flock, writes the
// provenance sidecar, then re-stamps last_validated_at through the shared restamp
// gate. There is no single-task form, ever — that is what keeps assign-cells
// outside the removed incremental `task set-tier` verb class.
//
// Failure codes, priority-ordered:
//   - bad_yaml     — shape/type errors (top-level not a mapping, cells not a
//                    non-empty list, a cell/selection field of the wrong type).
//   - cell_invalid — out-of-axis tier/model, or an unknown / duplicate / missing
//                    / non-todo task id (the full-set + todo-only contract).
// No partial writes on any failure: shape + axis + membership + coverage all
// assert BEFORE the flock mutate, and the flock RE-READS task status so a task
// claimed between the outer read and the lock still rejects the batch.
//
// The verb NEVER reads model-selector.yaml — axis validation comes from the
// embedded subagents matrix only (configuredEfforts/configuredModels), keeping
// the guidance config off the verb/embed path. The `selection:` block is captured
// verbatim into the sidecar; the verb does not police its values beyond shape.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { emitFailureEnvelope, emitMutating } from "../emit.ts";
import { withEpicIdLock } from "../flock.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import {
  configuredEfforts,
  configuredModels,
  mergeTaskState,
} from "../models.ts";
import { resolveProject } from "../project.ts";
import {
  SELECTION_SCHEMA_VERSION,
  type SelectionSidecar,
  writeSelectionSidecar,
} from "../selection_sidecar.ts";
import {
  atomicWriteJson,
  LocalFileStateStore,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";
import { restampEpicOrFail } from "../validation_restamp.ts";
import {
  parseYamlInput,
  readYamlBytes,
  YamlInputError,
} from "../yaml_input.ts";

interface AssignCellsArgs {
  epicId: string;
  file: string;
}

/** A cell parsed + shape-validated from the input YAML. Axis / membership /
 * coverage checks run later (cell_invalid), so a value here may still be
 * out-of-axis or target a non-todo / unknown task. */
interface ParsedCell {
  taskId: string;
  tier: string;
  model: string;
  rationale: string | null;
  confidence: number | string | null;
  labelSource: string;
}

export function runAssignCells(args: AssignCellsArgs): number {
  const { epicId, file: fileArg } = args;

  // ------------------------------------------------------------------
  // Phase 0: epic id shape + existence.
  // ------------------------------------------------------------------
  if (!isEpicId(epicId)) {
    emitFailureEnvelope("bad_yaml", `Invalid epic id: ${epicId}`, [
      `epic_id: ${epicId}`,
    ]);
    return 1;
  }

  const ctx = resolveProject(null);
  const dataDir = ctx.dataDir;
  const primaryRepo = ctx.projectPath;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitFailureEnvelope(
      "epic_not_found",
      `Epic not found in ${ctx.projectPath}: ${epicId}`,
      [`epic_id: ${epicId}`],
    );
    return 1;
  }

  // ------------------------------------------------------------------
  // Phase 1: read (1 MiB cap) + parse YAML (pyyaml-safe_load parity).
  // ------------------------------------------------------------------
  let doc: unknown;
  try {
    doc = parseYamlInput(readYamlBytes(fileArg), fileArg);
  } catch (exc) {
    if (exc instanceof YamlInputError) {
      emitFailureEnvelope(exc.code, exc.message, exc.details);
      return 1;
    }
    throw exc;
  }

  // ------------------------------------------------------------------
  // Phase 2: shape validation — accumulate ALL type errors before returning
  // (bad_yaml). Membership / axis checks (cell_invalid) come after a clean shape.
  // ------------------------------------------------------------------
  const errors: string[] = [];

  if (!isPlainObject(doc)) {
    emitFailureEnvelope(
      "bad_yaml",
      "Top-level YAML must be a mapping with `cells:` and `selection:`",
      [`got: ${typeName(doc)}`],
    );
    return 1;
  }

  const cellsNode = "cells" in doc ? doc.cells : undefined;
  const selectionNode = "selection" in doc ? doc.selection : undefined;

  if (!Array.isArray(cellsNode)) {
    errors.push("cells: must be a list of cell mappings");
  }
  if (!isPlainObject(selectionNode)) {
    errors.push("selection: must be a mapping (the selector provenance block)");
  }
  if (errors.length > 0) {
    emitFailureEnvelope("bad_yaml", "Invalid assign-cells YAML shape", errors);
    return 1;
  }

  const cellsList = cellsNode as unknown[];
  if (cellsList.length === 0) {
    emitFailureEnvelope(
      "bad_yaml",
      "cells: must be non-empty — a batch covering every todo task of the epic",
      [],
    );
    return 1;
  }

  // --- per-cell shape (collect-all) ---------------------------------
  const parsedCells: ParsedCell[] = [];
  for (let idx = 0; idx < cellsList.length; idx += 1) {
    const prefix = `cells #${idx + 1}`;
    const entry = cellsList[idx];
    if (!isPlainObject(entry)) {
      errors.push(`${prefix}: must be a mapping`);
      continue;
    }

    const tidRaw = "task_id" in entry ? entry.task_id : undefined;
    let taskId = "";
    if (!isStr(tidRaw) || !isTaskId(tidRaw)) {
      errors.push(`${prefix}: \`task_id\` must be a valid task id`);
    } else {
      taskId = tidRaw;
    }

    const tierRaw = "tier" in entry ? entry.tier : undefined;
    let tier = "";
    if (!isStr(tierRaw)) {
      errors.push(`${prefix}: \`tier\` must be a string`);
    } else {
      tier = tierRaw;
    }

    const modelRaw = "model" in entry ? entry.model : undefined;
    let model = "";
    if (!isStr(modelRaw)) {
      errors.push(`${prefix}: \`model\` must be a string`);
    } else {
      model = modelRaw;
    }

    const lsRaw = "label_source" in entry ? entry.label_source : undefined;
    let labelSource = "";
    if (!isStr(lsRaw) || lsRaw.trim() === "") {
      errors.push(`${prefix}: \`label_source\` must be a non-empty string`);
    } else {
      labelSource = lsRaw;
    }

    let rationale: string | null = null;
    const ratRaw = "rationale" in entry ? entry.rationale : undefined;
    if (ratRaw !== null && ratRaw !== undefined) {
      if (!isStr(ratRaw)) {
        errors.push(`${prefix}: \`rationale\` must be a string when present`);
      } else {
        rationale = ratRaw;
      }
    }

    let confidence: number | string | null = null;
    const confRaw = "confidence" in entry ? entry.confidence : undefined;
    if (confRaw !== null && confRaw !== undefined) {
      if (typeof confRaw === "number" || typeof confRaw === "string") {
        confidence = confRaw;
      } else {
        errors.push(
          `${prefix}: \`confidence\` must be a number or string when present`,
        );
      }
    }

    parsedCells.push({
      taskId,
      tier,
      model,
      rationale,
      confidence,
      labelSource,
    });
  }

  // --- selection provenance block shape (collect-all) ---------------
  const selection = selectionNode as Record<string, unknown>;
  const requireSelStr = (key: string): string => {
    const v = selection[key];
    if (!isStr(v) || v.trim() === "") {
      errors.push(`selection: \`${key}\` must be a non-empty string`);
      return "";
    }
    return v;
  };
  const selHarness = requireSelStr("harness");
  const selModel = requireSelStr("model");
  const configHash = requireSelStr("config_hash");
  const inputHash = requireSelStr("input_hash");
  const outcome = requireSelStr("outcome");

  let shuffleSeed: number | null = null;
  const seedRaw =
    "shuffle_seed" in selection ? selection.shuffle_seed : undefined;
  if (seedRaw !== null && seedRaw !== undefined) {
    if (typeof seedRaw === "number" && Number.isInteger(seedRaw)) {
      shuffleSeed = seedRaw;
    } else {
      errors.push("selection: `shuffle_seed` must be an integer or null");
    }
  }

  let verdictRaw: string | null = null;
  const vrRaw = "verdict_raw" in selection ? selection.verdict_raw : undefined;
  if (vrRaw !== null && vrRaw !== undefined) {
    if (isStr(vrRaw)) {
      verdictRaw = vrRaw;
    } else {
      errors.push("selection: `verdict_raw` must be a string or null");
    }
  }

  if (errors.length > 0) {
    emitFailureEnvelope("bad_yaml", "Invalid assign-cells YAML shape", errors);
    return 1;
  }

  // ------------------------------------------------------------------
  // Phase 3+4: assert membership/axis/coverage + mutate, under the epic flock.
  // The flock guards the enumerate-status -> validate -> write region so the
  // full-set + todo-only contract holds against a concurrently-claimed task. On
  // any failure the closure returns a sentinel so emit/restamp run OUTSIDE the
  // lock; success carries out the applied task-id list for the emit payload.
  // ------------------------------------------------------------------
  const efforts = configuredEfforts();
  const models = configuredModels();

  type FlockOutcome =
    | { kind: "failure"; code: string; message: string; details: string[] }
    | { kind: "success"; taskIds: string[] };

  const outcomeResult = withEpicIdLock<FlockOutcome>(() => {
    const stateStore = new LocalFileStateStore(ctx.stateDir);

    // Enumerate the epic's tasks + their live status (re-read INSIDE the lock).
    const epicTaskIds = new Set(epicTaskStems(dataDir, epicId));
    const todo = new Set<string>();
    for (const tid of epicTaskIds) {
      const def = loadJsonSafe(join(dataDir, "tasks", `${tid}.json`)) ?? {};
      const status = mergeTaskState(def, stateStore.loadRuntime(tid)).status;
      if (status === "todo") {
        todo.add(tid);
      }
    }

    const cellErrors: string[] = [];
    const seen = new Set<string>();
    for (let idx = 0; idx < parsedCells.length; idx += 1) {
      const c = parsedCells[idx] as ParsedCell;
      const prefix = `cells #${idx + 1} (${c.taskId})`;
      if (!efforts.includes(c.tier)) {
        cellErrors.push(
          `${prefix}: tier ${pyReprStr(c.tier)} is not one of ${efforts.join(", ")}`,
        );
      }
      if (!models.includes(c.model)) {
        cellErrors.push(
          `${prefix}: model ${pyReprStr(c.model)} is not one of ${models.join(", ")}`,
        );
      }
      if (!epicTaskIds.has(c.taskId)) {
        cellErrors.push(
          `${prefix}: unknown task id — not a task of epic ${epicId}`,
        );
      } else if (!todo.has(c.taskId)) {
        cellErrors.push(
          `${prefix}: task is not in \`todo\` status — assign-cells targets ` +
            "todo tasks only",
        );
      }
      if (seen.has(c.taskId)) {
        cellErrors.push(`${prefix}: duplicate cell for task ${c.taskId}`);
      }
      seen.add(c.taskId);
    }

    // Full-set contract: every todo task must be covered by exactly one cell.
    for (const tid of [...todo].sort()) {
      if (!seen.has(tid)) {
        cellErrors.push(
          `coverage: todo task ${tid} is not covered by any cell ` +
            "(full-set contract — choosing the default is an explicit cell)",
        );
      }
    }

    if (cellErrors.length > 0) {
      return {
        kind: "failure",
        code: "cell_invalid",
        message: "One or more selection cells are invalid",
        details: cellErrors,
      };
    }

    // --- mutate: overwrite tier/model on every cell's task JSON ------
    const now = nowIso();
    for (const c of parsedCells) {
      const tp = join(dataDir, "tasks", `${c.taskId}.json`);
      const tdef = loadJson(tp);
      tdef.tier = c.tier;
      tdef.model = c.model;
      tdef.updated_at = now;
      atomicWriteJson(tp, tdef, dataDir);
    }

    // --- sidecar: schema-versioned provenance, REPLACE (no append) --
    const sidecar: SelectionSidecar = {
      schema_version: SELECTION_SCHEMA_VERSION,
      epic_id: epicId,
      created_at: now,
      selector: { harness: selHarness, model: selModel },
      config_hash: configHash,
      input_hash: inputHash,
      shuffle_seed: shuffleSeed,
      outcome,
      verdict_raw: verdictRaw,
      cells: parsedCells.map((c) => ({
        task_id: c.taskId,
        tier: c.tier,
        model: c.model,
        rationale: c.rationale,
        confidence: c.confidence,
        label_source: c.labelSource,
      })),
    };
    writeSelectionSidecar(dataDir, sidecar);

    return { kind: "success", taskIds: parsedCells.map((c) => c.taskId) };
  });

  if (outcomeResult.kind === "failure") {
    emitFailureEnvelope(
      outcomeResult.code,
      outcomeResult.message,
      outcomeResult.details,
    );
    return 1;
  }

  // ------------------------------------------------------------------
  // Phase 4.5: post-write re-stamp of last_validated_at (OUTSIDE the lock).
  // assign-cells IS a VALIDATION_RESTAMP_VERBS member: validate the post-mutation
  // tree and re-stamp on a clean result. checkFilesystemRepos stays false — the
  // verb changes only tier/model, never repo paths, so re-probing repos on disk
  // would add nothing but a spurious failure surface.
  // ------------------------------------------------------------------
  const newStamp = restampEpicOrFail(epicId, dataDir, { verb: "assign-cells" });
  const epicDefAfter = loadJson(epicPath);
  epicDefAfter.updated_at = nowIso();
  epicDefAfter.last_validated_at = newStamp;
  atomicWriteJson(epicPath, epicDefAfter, dataDir);

  // ------------------------------------------------------------------
  // Phase 5: emit ONE envelope covering the whole batch (OUTSIDE the lock). The
  // auto-commit stages the mutated task JSONs, the epic re-stamp, AND the sidecar
  // (a non-gitignored `selections/` path) in one commit before this prints.
  // ------------------------------------------------------------------
  emitMutating(
    {
      epic_id: epicId,
      assigned_task_ids: outcomeResult.taskIds,
      outcome,
    },
    {
      verb: "assign-cells",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo,
    },
  );
  return 0;
}

// --- Local helpers ---------------------------------------------------------

/** YAML implicit-typing guard: an actual string, not a bool/number/Date the
 * parser coerced from a norway boolean / numeric / ISO-date scalar. */
function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

/** Python type(doc).__name__ for the top-level shape error message. */
function typeName(v: unknown): string {
  if (v === null || v === undefined) {
    return "NoneType";
  }
  if (Array.isArray(v)) {
    return "list";
  }
  if (typeof v === "boolean") {
    return "bool";
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? "int" : "float";
  }
  if (typeof v === "string") {
    return "str";
  }
  if (v instanceof Date) {
    return "datetime.date";
  }
  return "dict";
}

/** Python `!r` for a string scalar — single-quoted, for the out-of-axis message. */
function pyReprStr(v: string): string {
  return `'${v}'`;
}

/** Stems of direct-child `tasks/<epicId>.<m>.json` files (one directory glob),
 * excluding nested-dot ids. Mirrors refine-apply's globTaskStems. */
function epicTaskStems(dataDir: string, epicId: string): string[] {
  const tasksDir = join(dataDir, "tasks");
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }
  const prefix = `${epicId}.`;
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry.endsWith(".json")) {
      const stem = entry.slice(0, -".json".length);
      const middle = stem.slice(prefix.length);
      if (middle.length > 0 && !middle.includes(".")) {
        out.push(stem);
      }
    }
  }
  return out;
}

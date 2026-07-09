// assign-cells verb — batch-overwrite the {tier, model} cells of a ghost epic's
// todo tasks during the post-scaffold ghost window, landing the cell writes AND a
// git-committed selection sidecar in ONE auto-commit.
//
// BATCH-ONLY by contract: it reads one YAML cell set that must cover EVERY todo
// task of the epic exactly once (choosing the default is an explicit cell) plus a
// `selection:` provenance block, asserts the whole batch (assert-all,
// collect-all), then routes the applied cells through the shared apply core
// (selection_apply_core.ts) — the flock mutate + provenance sidecar + integrity
// gate + auto-commit spine it shares with apply-selection. There is no
// single-task form, ever.
//
// Failure codes, priority-ordered:
//   - bad_yaml     — shape/type errors (top-level not a mapping, cells not a
//                    non-empty list, a cell/selection field of the wrong type).
//   - cell_invalid — out-of-axis tier/model, or an unknown / duplicate / missing
//                    / non-todo task id (the full-set + todo-only contract), or a
//                    brief-vs-live axis divergence at apply time.
// No partial writes on any failure: shape asserts BEFORE the core, and the core's
// flock RE-READS task status so a task claimed between the outer read and the lock
// still rejects the batch.
//
// The verb NEVER reads model-selector.yaml — axis validation comes from the
// effective composed matrix (embedded subagents snapshot plus a host
// provider matrix.yaml overlay when present), via configuredEfforts /
// configuredModels. The `selection:` block is captured verbatim into the
// sidecar; the verb does not police its values beyond shape. The tier-audit
// stamp + degrade-SOFT policy read live in the shared core.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitFailureEnvelope } from "../emit.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import { configuredEfforts, configuredModels } from "../models.ts";
import { resolveProject } from "../project.ts";
import {
  parseYamlInput,
  readYamlBytes,
  YamlInputError,
} from "../yaml_input.ts";
import {
  isPlainObject,
  isStr,
  landSelectionCells,
  type SelectionCoreCell,
  type SelectionCoreProvenance,
  validateSelectionCells,
} from "./selection_apply_core.ts";

interface AssignCellsArgs {
  epicId: string;
  file: string;
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
  const parsedCells: SelectionCoreCell[] = [];
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
  // Phase 3+: assert membership/axis/coverage + mutate + commit, through the
  // shared apply core. The final axis gate reads the LIVE configuredEfforts/Models
  // (computed once here, before the flock); the core re-reads todo status in-lock.
  // ------------------------------------------------------------------
  const efforts = configuredEfforts();
  const models = configuredModels();
  const provenance: SelectionCoreProvenance = {
    harness: selHarness,
    model: selModel,
    configHash,
    inputHash,
    shuffleSeed,
    outcome,
    verdictRaw,
  };

  return landSelectionCells({
    verb: "assign-cells",
    epicId,
    ctx,
    provenance,
    resolveCells: ({ todo, epicTaskIds }) => {
      const cellErrors = validateSelectionCells(parsedCells, {
        epicId,
        verb: "assign-cells",
        todo,
        epicTaskIds,
        efforts,
        models,
      });
      return cellErrors.length > 0
        ? {
            kind: "invalid",
            code: "cell_invalid",
            message: "One or more selection cells are invalid",
            details: cellErrors,
          }
        : { kind: "ok", cells: parsedCells };
    },
  });
}

// --- Local helpers ---------------------------------------------------------

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

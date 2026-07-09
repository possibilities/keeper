// apply-selection verb — the ONE trusted apply seam for model-selector verdicts
// (ADR 0027). The selector subagent stays read-only; the calling skill pipes its
// raw JSON verbatim to this verb, which validates it against the on-disk selection
// brief and either lands the cells (live) or stages the verdict document
// close-finalize consumes (follow-up).
//
//   keeper plan apply-selection <epic_id> [--from-followup] [--degraded <reason>]
//     [--project <abs_path>] --file -
//
// --project bypasses the cwd-walk to LOCATE the epic; plan-state reads/writes
// always re-root through the located epic's primary_repo regardless (matching
// close_preflight/close_finalize), so an apply from a worktree lane (cwd !=
// primary_repo) finds the brief primary wrote and stages the verdict there.
//
// GUIDED (default): read the selector's raw JSON from stdin (`--file -`; a single
// optional ```json fenced block is tolerated so a Task return pipes verbatim),
// then validate in layers, collect-all:
//   - shape: a `cells:` list of {task_id, tier, model, rationale?, confidence?};
//     unknown top-level keys and an error-shaped {"error": ...} return fail here
//     (verdict_invalid).
//   - brief: locate `.keeper/state/selections/<epic>/brief.json` (or
//     followup-brief.json under --from-followup), assert its `from_followup` flag
//     matches the invocation (brief_missing on absence / mismatch).
//   - enum-clamp against the brief's candidate cells + exact coverage of the
//     brief's task set (live task ids) or ordinals 1..N (follow-up) — verdict_invalid.
// Provenance is synthesized by the verb, NEVER transcribed: harness `subagent`,
// model `plan:model-selector`, config/input/shuffle pinned from the on-disk brief,
// outcome `completed`, verdict_raw the raw stdin, label_source `heuristic-guided`.
// A smuggled `selection:` block in the verdict is an unknown top-level key.
//
// LIVE branch: land through the shared apply core (selection_apply_core.ts) — the
// same flock/mutate/sidecar/integrity-gate/auto-commit spine assign-cells uses.
// FOLLOW-UP branch: atomically stage a gitignored `followup-verdict.json` in the
// exact shape loadSelectionVerdict consumes, then self-emit a commit-free payload
// carrying the staged absolute path as `verdict_path`.
//
// --degraded <reason> (LIVE-ONLY, rejected with --from-followup): no stdin — under
// the flock, re-assert each current todo task's own stamped cell (never a second
// hardcode of the scaffold default), label_source `heuristic-default`, outcome
// `degraded:<reason>`, hashes pinned from the brief when one is on disk else the
// literal `unavailable` sentinel, shuffle_seed/verdict_raw null. It leaves the
// board armable — exits 0 whenever the sidecar write lands.
//
// Failure envelopes use the collect-all details-array discipline so callers relay
// them as VALIDATION_ERRORS: verdict_invalid, brief_missing, cell_invalid (from
// the shared core), plus the standard epic_not_found.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import { loadEpic } from "../api.ts";
import { emitFailureEnvelope, emitReadonly } from "../emit.ts";
import { isEpicId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { configuredEfforts, configuredModels } from "../models.ts";
import {
  contextForRoot,
  type ProjectContext,
  resolveProject,
} from "../project.ts";
import { SELECTION_SCHEMA_VERSION } from "../selection_sidecar.ts";
import { hasDataDir } from "../state_path.ts";
import { atomicWriteRaw, serializeStateJson } from "../store.ts";
import { readPayloadCapped, SubmitError } from "../submit_common.ts";
import {
  isPlainObject,
  landSelectionCells,
  type SelectionCoreCell,
  type SelectionCoreProvenance,
  validateSelectionCells,
} from "./selection_apply_core.ts";
import { selectionBriefPath } from "./selection_brief.ts";

export interface ApplySelectionArgs {
  epicId: string;
  fromFollowup: boolean;
  /** The `--degraded <reason>` value, or null when the flag is absent. */
  degraded: string | null;
  /** `-` (stdin) by default; the guided branch reads the verdict from here. */
  file: string;
  /** `--project <abs_path>`, or null to resolve from cwd. Locates the epic
   * (cwd-walk or this override), then plan-state re-roots through the epic's
   * `primary_repo` regardless — matching close_preflight/close_finalize's
   * `contextForRoot(primaryRepo)` reroot, so an apply from a worktree lane
   * (cwd != primary_repo) still finds the brief primary wrote and stages the
   * verdict under primary's `state/` instead of the lane's stale/empty copy. */
  project: string | null;
}

/** A cell parsed + shape-validated from the selector verdict. `taskId` is a real
 * task id (live) or a 1-based ordinal string (follow-up); the brief-coverage
 * layer validates which. */
interface VerdictCell {
  taskId: string;
  tier: string;
  model: string;
  rationale: string | null;
  confidence: number | string | null;
}

export function runApplySelection(args: ApplySelectionArgs): number {
  const { epicId, fromFollowup, degraded, project } = args;
  const fileArg = args.file || "-";

  // --degraded is live-only — reject the flag combined with --from-followup.
  if (degraded !== null && fromFollowup) {
    emitFailureEnvelope(
      "verdict_invalid",
      "--degraded is live-only and cannot be combined with --from-followup",
      ["--degraded conflicts with --from-followup"],
    );
    return 1;
  }

  // Phase 0: epic id shape + existence.
  if (!isEpicId(epicId)) {
    emitFailureEnvelope("epic_not_found", `Invalid epic id: ${epicId}`, [
      `epic_id: ${epicId}`,
    ]);
    return 1;
  }

  // --project <abs_path> bypasses the cwd-walk (absolute-only, matching
  // close_preflight's guard). Unset falls through to the ordinary cwd-walk.
  let locateCtx: ProjectContext;
  if (project !== null) {
    const projectPathObj = expandUser(project);
    if (!isAbsolute(projectPathObj)) {
      usageError(`--project requires an absolute path, got: ${project}`);
    }
    const projectRoot = realpathOr(resolveAbs(projectPathObj));
    if (!hasDataDir(projectRoot)) {
      emitFailureEnvelope(
        "epic_not_found",
        `No plan project found at ${projectRoot}. Run 'keeper plan init' first.`,
        [`project: ${projectRoot}`],
      );
      return 1;
    }
    locateCtx = contextForRoot(projectRoot);
  } else {
    locateCtx = resolveProject(null);
  }
  const epicPath = join(locateCtx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitFailureEnvelope(
      "epic_not_found",
      `Epic not found in ${locateCtx.projectPath}: ${epicId}`,
      [`epic_id: ${epicId}`],
    );
    return 1;
  }

  // Re-root plan-state through the epic's primary_repo — matching
  // close_preflight's contextForRoot(primaryRepo) reroot — so a worktree-lane
  // cwd (or --project pointed at a lane) still reads/writes primary's state.
  // A null primary_repo (single-repo board) degrades to the locate root (a
  // no-op when it already equals the primary).
  const epicDef = loadEpic(locateCtx, epicId);
  const primaryRepo = realpathOr(
    (epicDef.primary_repo as string | null | undefined) ||
      locateCtx.projectPath,
  );
  const ctx = contextForRoot(primaryRepo);

  // --degraded: live-only re-assert, no stdin, no brief requirement.
  if (degraded !== null) {
    return runDegraded(epicId, ctx, degraded);
  }

  // ------------------------------------------------------------------
  // Guided: read + shape-validate the selector verdict from stdin.
  // ------------------------------------------------------------------
  let rawText: string;
  try {
    rawText = readPayloadCapped(fileArg, "selector verdict");
  } catch (exc) {
    if (exc instanceof SubmitError) {
      emitFailureEnvelope("verdict_invalid", exc.message, [
        `stdin: ${exc.code}`,
      ]);
      return 1;
    }
    throw exc;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(rawText));
  } catch (exc) {
    emitFailureEnvelope(
      "verdict_invalid",
      `selector verdict is not valid JSON: ${describeError(exc)}`,
      ["verdict is not parseable JSON"],
    );
    return 1;
  }

  const shape = parseVerdictShape(parsed);
  if (shape.kind === "invalid") {
    emitFailureEnvelope(
      "verdict_invalid",
      "selector verdict shape is invalid",
      shape.details,
    );
    return 1;
  }

  // ------------------------------------------------------------------
  // Brief: locate + validate the on-disk selection brief.
  // ------------------------------------------------------------------
  const briefBasename = fromFollowup ? "followup-brief.json" : "brief.json";
  const briefRef = selectionBriefPath(ctx.stateDir, epicId, briefBasename);
  const brief = loadBrief(briefRef);
  if (brief === null) {
    emitFailureEnvelope(
      "brief_missing",
      `no selection brief for ${epicId} at ${briefRef}; run ` +
        `\`keeper plan selection-brief ${epicId}` +
        `${fromFollowup ? " --from-followup" : ""}\` first`,
      [`expected: ${briefRef}`],
    );
    return 1;
  }
  if (Boolean(brief.from_followup) !== fromFollowup) {
    emitFailureEnvelope(
      "brief_missing",
      `selection brief at ${briefRef} has from_followup=` +
        `${JSON.stringify(brief.from_followup)}, which does not match this ` +
        `${fromFollowup ? "--from-followup " : ""}invocation`,
      [`brief_from_followup: ${JSON.stringify(brief.from_followup)}`],
    );
    return 1;
  }

  // Enum-clamp against the brief's candidate cells + exact coverage of its task
  // set (live ids) or ordinals 1..N (follow-up).
  const briefShape = readBriefShape(brief);
  if (briefShape === null) {
    emitFailureEnvelope(
      "brief_missing",
      `selection brief at ${briefRef} is missing its task set or axes`,
      [`corrupt: ${briefRef}`],
    );
    return 1;
  }
  const briefErrors = validateAgainstBrief(shape.cells, briefShape);
  if (briefErrors.length > 0) {
    emitFailureEnvelope(
      "verdict_invalid",
      "selector verdict cells do not match the selection brief",
      briefErrors,
    );
    return 1;
  }

  // Provenance is synthesized by the verb + pinned from the on-disk brief.
  const provenance: SelectionCoreProvenance = {
    harness: "subagent",
    model: "plan:model-selector",
    configHash: pinnedString(brief.selector_config_hash),
    inputHash: pinnedString(brief.input_hash),
    shuffleSeed:
      typeof brief.shuffle_seed === "number" &&
      Number.isInteger(brief.shuffle_seed)
        ? brief.shuffle_seed
        : null,
    outcome: "completed",
    verdictRaw: rawText,
  };

  if (fromFollowup) {
    return stageFollowupVerdict(epicId, ctx, shape.cells, provenance);
  }

  // ------------------------------------------------------------------
  // Live branch: land the cells through the shared apply core.
  // ------------------------------------------------------------------
  const cells: SelectionCoreCell[] = shape.cells.map((c) => ({
    taskId: c.taskId,
    tier: c.tier,
    model: c.model,
    rationale: c.rationale,
    confidence: c.confidence,
    labelSource: "heuristic-guided",
  }));
  const efforts = configuredEfforts();
  const models = configuredModels();
  return landSelectionCells({
    verb: "apply-selection",
    epicId,
    ctx,
    provenance,
    resolveCells: ({ todo, epicTaskIds }) => {
      const cellErrors = validateSelectionCells(cells, {
        epicId,
        verb: "apply-selection",
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
        : { kind: "ok", cells };
    },
  });
}

/** Degraded (live-only): re-assert each current todo task's own stamped cell
 * through the shared core, label_source heuristic-default, hashes pinned from the
 * brief when one is on disk else the `unavailable` sentinel. */
function runDegraded(
  epicId: string,
  ctx: ProjectContext,
  reason: string,
): number {
  let configHash = "unavailable";
  let inputHash = "unavailable";
  const brief = loadBrief(
    selectionBriefPath(ctx.stateDir, epicId, "brief.json"),
  );
  if (brief !== null) {
    configHash = pinnedString(brief.selector_config_hash);
    inputHash = pinnedString(brief.input_hash);
  }
  const provenance: SelectionCoreProvenance = {
    harness: "none",
    model: "none",
    configHash,
    inputHash,
    shuffleSeed: null,
    outcome: `degraded:${reason}`,
    verdictRaw: null,
  };
  return landSelectionCells({
    verb: "apply-selection",
    epicId,
    ctx,
    provenance,
    resolveCells: ({ todo, loadTaskDef }) => {
      const cells: SelectionCoreCell[] = [...todo].sort().map((tid) => {
        const def = loadTaskDef(tid);
        return {
          taskId: tid,
          tier: typeof def.tier === "string" ? def.tier : "",
          model: typeof def.model === "string" ? def.model : "",
          rationale: null,
          confidence: null,
          labelSource: "heuristic-default",
        };
      });
      return { kind: "ok", cells };
    },
  });
}

/** Assemble + atomically stage the follow-up verdict document in the exact shape
 * loadSelectionVerdict consumes ({schema_version, cells: {"<ordinal>": {...}},
 * selection: {...}}) as a gitignored sibling of the brief, then self-emit a
 * commit-free payload carrying its absolute path. close-finalize threads that
 * path to `--selection-verdict`. */
function stageFollowupVerdict(
  epicId: string,
  ctx: ProjectContext,
  cells: readonly VerdictCell[],
  provenance: SelectionCoreProvenance,
): number {
  const cellMap: Record<string, Record<string, unknown>> = {};
  for (const c of cells) {
    cellMap[c.taskId] = {
      tier: c.tier,
      model: c.model,
      rationale: c.rationale,
      confidence: c.confidence,
    };
  }
  const doc = {
    schema_version: SELECTION_SCHEMA_VERSION,
    cells: cellMap,
    selection: {
      harness: provenance.harness,
      model: provenance.model,
      config_hash: provenance.configHash,
      input_hash: provenance.inputHash,
      shuffle_seed: provenance.shuffleSeed,
      outcome: provenance.outcome,
      verdict_raw: provenance.verdictRaw,
    },
  };
  const verdictPath = selectionBriefPath(
    ctx.stateDir,
    epicId,
    "followup-verdict.json",
  );
  atomicWriteRaw(verdictPath, serializeStateJson(doc));

  emitReadonly(
    {
      epic_id: epicId,
      from_followup: true,
      verdict_path: verdictPath,
      staged_cells: cells.length,
    },
    buildPlanInvocationReadonly("apply-selection", ctx.projectPath, epicId),
  );
  return 0;
}

// --- Local helpers ---------------------------------------------------------

/** Strip a single optional fenced code block wrapping the verdict, so a skill can
 * pipe a Task return verbatim. A leading ```json / ``` fence line and the trailing
 * ``` are removed; text without an opening fence is returned unchanged. */
function stripJsonFence(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) {
    return text;
  }
  const firstNl = t.indexOf("\n");
  if (firstNl === -1) {
    return text;
  }
  let inner = t.slice(firstNl + 1);
  const lastFence = inner.lastIndexOf("```");
  if (lastFence !== -1) {
    inner = inner.slice(0, lastFence);
  }
  return inner;
}

/** Shape-validate the parsed verdict (collect-all): a top-level object whose ONLY
 * key is `cells` (a list of {task_id, tier, model, rationale?, confidence?}). An
 * error-shaped `{"error": ...}` return and any other unknown top-level key fail. */
function parseVerdictShape(
  parsed: unknown,
):
  | { kind: "ok"; cells: VerdictCell[] }
  | { kind: "invalid"; details: string[] } {
  if (!isPlainObject(parsed)) {
    return {
      kind: "invalid",
      details: ["top-level verdict must be a JSON object with a `cells` list"],
    };
  }
  const details: string[] = [];
  if ("error" in parsed) {
    details.push(
      `verdict is an error-shaped response: ${JSON.stringify(parsed.error)}`,
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "cells") {
      details.push(`unknown top-level key: \`${key}\``);
    }
  }

  const cellsNode = "cells" in parsed ? parsed.cells : undefined;
  const cells: VerdictCell[] = [];
  if (!Array.isArray(cellsNode)) {
    details.push("`cells` must be a list of cell objects");
    return { kind: "invalid", details };
  }
  if (cellsNode.length === 0) {
    details.push("`cells` must be non-empty");
  }
  for (let idx = 0; idx < cellsNode.length; idx += 1) {
    const prefix = `cells #${idx + 1}`;
    const entry = cellsNode[idx];
    if (!isPlainObject(entry)) {
      details.push(`${prefix}: must be an object`);
      continue;
    }
    const tidRaw = entry.task_id;
    let taskId = "";
    if (typeof tidRaw !== "string" || tidRaw.trim() === "") {
      details.push(`${prefix}: \`task_id\` must be a non-empty string`);
    } else {
      taskId = tidRaw;
    }
    const tierRaw = entry.tier;
    let tier = "";
    if (typeof tierRaw !== "string") {
      details.push(`${prefix}: \`tier\` must be a string`);
    } else {
      tier = tierRaw;
    }
    const modelRaw = entry.model;
    let model = "";
    if (typeof modelRaw !== "string") {
      details.push(`${prefix}: \`model\` must be a string`);
    } else {
      model = modelRaw;
    }
    let rationale: string | null = null;
    if (entry.rationale !== null && entry.rationale !== undefined) {
      if (typeof entry.rationale !== "string") {
        details.push(`${prefix}: \`rationale\` must be a string when present`);
      } else {
        rationale = entry.rationale;
      }
    }
    let confidence: number | string | null = null;
    if (entry.confidence !== null && entry.confidence !== undefined) {
      if (
        typeof entry.confidence === "number" ||
        typeof entry.confidence === "string"
      ) {
        confidence = entry.confidence;
      } else {
        details.push(
          `${prefix}: \`confidence\` must be a number or string when present`,
        );
      }
    }
    cells.push({ taskId, tier, model, rationale, confidence });
  }

  return details.length > 0
    ? { kind: "invalid", details }
    : { kind: "ok", cells };
}

/** The brief fields apply-selection validates against: the expected task-id
 * coverage set + the candidate {model, tier} axes. */
interface BriefShape {
  taskIds: string[];
  models: string[];
  efforts: string[];
}

/** Extract the coverage set + axes from a loaded brief, or null when either is
 * absent / malformed (a corrupt brief the caller surfaces as brief_missing). */
function readBriefShape(brief: Record<string, unknown>): BriefShape | null {
  if (
    !Array.isArray(brief.tasks) ||
    !Array.isArray(brief.models) ||
    !Array.isArray(brief.efforts)
  ) {
    return null;
  }
  const taskIds: string[] = [];
  for (const t of brief.tasks) {
    if (isPlainObject(t) && typeof t.task_id === "string") {
      taskIds.push(t.task_id);
    }
  }
  const models = brief.models.filter((m): m is string => typeof m === "string");
  const efforts = brief.efforts.filter(
    (e): e is string => typeof e === "string",
  );
  if (taskIds.length === 0 || models.length === 0 || efforts.length === 0) {
    return null;
  }
  return { taskIds, models, efforts };
}

/** Validate the verdict cells against the brief (collect-all): each cell's
 * {model, tier} must be a candidate cell (model x effort), each task_id must be in
 * the brief's coverage set with no duplicates, and every brief task must be
 * covered exactly once. */
function validateAgainstBrief(
  cells: readonly VerdictCell[],
  brief: BriefShape,
): string[] {
  const expected = new Set(brief.taskIds);
  const candidates = new Set<string>();
  for (const model of brief.models) {
    for (const tier of brief.efforts) {
      candidates.add(`${model}::${tier}`);
    }
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let idx = 0; idx < cells.length; idx += 1) {
    const c = cells[idx] as VerdictCell;
    const prefix = `cells #${idx + 1} (${c.taskId})`;
    if (!expected.has(c.taskId)) {
      errors.push(`${prefix}: task_id is not in the selection brief`);
    } else if (seen.has(c.taskId)) {
      errors.push(`${prefix}: duplicate cell for task ${c.taskId}`);
    }
    seen.add(c.taskId);
    if (!candidates.has(`${c.model}::${c.tier}`)) {
      errors.push(
        `${prefix}: {tier: ${c.tier}, model: ${c.model}} is not a candidate ` +
          "cell in the brief",
      );
    }
  }
  for (const tid of [...expected].sort()) {
    if (!seen.has(tid)) {
      errors.push(`coverage: brief task ${tid} is not covered by any cell`);
    }
  }
  return errors;
}

/** Load + JSON-parse a brief file, or null when it is absent or unparseable. */
function loadBrief(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Pin a hash string from the brief, falling back to the `unavailable` sentinel
 * so the sidecar's non-empty invariant holds even against a hash-less brief. */
function pinnedString(v: unknown): string {
  return typeof v === "string" && v !== "" ? v : "unavailable";
}

function describeError(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** click UsageError shape: usage + try-help on stderr, exit 2. Mirrors
 * close_preflight's / close_finalize's --project absolute-path guard. */
function usageError(message: string): never {
  process.stderr.write(
    "Usage: keeper plan apply-selection [OPTIONS] EPIC_ID\n",
  );
  process.stderr.write(
    "Try 'keeper plan apply-selection --help' for help.\n\n",
  );
  process.stderr.write(`Error: ${message}\n`);
  process.exit(2);
}

function realpathOr(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}

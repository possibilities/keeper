// close-finalize verb — the byte-parity port of planctl/run_close_finalize.py.
//
// Encodes the /plan:close saga, deriving its position purely from observable
// state (the persisted audit artifacts + the epic's own status) — there is NO
// saga-state file. Every reversible check runs FIRST and the irreversible
// `epic close` mutation runs LAST, so a crash mid-saga always leaves the source
// epic OPEN and the verb re-runnable.
//
// Saga order (pinned by the truth-table tests):
//  1. Resolve project + load the epic. ALREADY done → return the prior terminal
//     outcome idempotently (follow-up wired → closed_with_followup; else
//     closed_clean). epic close is NEVER called twice.
//  2. Re-derive commit_set_hash FRESH; a mismatch vs the verdict's stamp →
//     STALE_ARTIFACTS (a commit landed after the audit; refuse, never delete).
//  3. Read verdict.json: missing → VERDICT_MISSING (or synthesized-empty when
//     report.meta says findings==0); fatal:true → fatal_halt (no close).
//  4. Zero surviving decisions → epic close → closed_clean.
//  5. Else the kept/merged findings need a follow-up. Completeness in-process:
//     expected = distinct non-null kept/merged ordinals. Wired+complete → adopt
//     (crash-resume); wired+partial → partial_followup (stop); absent →
//     scaffold from followup.yaml → closed_with_followup.
//
// On the fresh-scaffold branch an optional `--selection-verdict` pre-selects the
// follow-up cells: its ordinal-keyed {tier, model} fold into the scaffold input
// (a merged temp YAML) so the tasks are BORN selected, scaffold's own tier/model
// validation still enforcing the axes. A committed selection sidecar records the
// outcome (heuristic-guided with a verdict, else heuristic-default + a degrade
// reason). A malformed/absent verdict DEGRADES to the document's stamped defaults
// rather than rejecting the finalize; the crash-resume adopt paths run no
// selection and stay pure idempotent re-arms.
//
// finalize itself draws no .planctl/ commit — epic close and scaffold land their
// own, and the sidecar rides epic close's auto-commit sweep. In-process
// delegation calls bun's OWN ported runEpicClose / runScaffold with stdout
// captured (never a subprocess of itself).

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolveAbs } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import {
  computeCommitSetHash,
  followupPath,
  reportMetaPath,
  verdictPath,
} from "../audit_artifacts.ts";
import {
  AllReposBrokenError,
  type CommitGroupResult,
  findCommitGroups,
} from "../commit_lookup.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { configuredEfforts, configuredModels } from "../models.ts";
import {
  contextForRoot,
  type ProjectContext,
  resolveProject,
} from "../project.ts";
import {
  SELECTION_SCHEMA_VERSION,
  type SelectionSidecar,
  writeSelectionSidecar,
} from "../selection_sidecar.ts";
import { clearCloseMarker } from "../session_markers.ts";
import { hasDataDir } from "../state_path.ts";
import { loadJsonSafe, nowIso } from "../store.ts";
import { parseYamlInput } from "../yaml_input.ts";
import { runEpicClose } from "./epic_close.ts";
import { runScaffold } from "./scaffold.ts";
import { armEpicValidated } from "./validate.ts";

/** The four terminal outcomes the close coordinator switches on. Every member
 * MUST have a /plan:close skill handler — the exhaustiveness test pins it.
 * Mirrors CloseOutcome. */
export const CLOSE_OUTCOMES = {
  CLOSED_CLEAN: "closed_clean",
  CLOSED_WITH_FOLLOWUP: "closed_with_followup",
  FATAL_HALT: "fatal_halt",
  PARTIAL_FOLLOWUP: "partial_followup",
} as const;

export type CloseOutcome = (typeof CLOSE_OUTCOMES)[keyof typeof CLOSE_OUTCOMES];

/** The epic whose close claim this finalize invocation holds — stashed by
 * runCloseFinalize (its sole caller) so the shared error chokepoint releases the
 * claim on any terminal error. A failed close attempt MUST free the epic, else a
 * leaked marker jams every re-run's preflight with CLOSE_ALREADY_CLAIMED;
 * process.exit() in the chokepoint precludes a finally, and one CLI invocation is
 * one process, so a per-invocation stash is single-writer. */
let finalizeClaimEpicId: string | null = null;

/** Emit a typed close-finalize error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no plan_invocation line.
 * Releases the close claim first (symmetric with emitOutcome's clear on the
 * success outcomes). Mirrors _emit_finalize_error. */
function emitFinalizeError(
  code: string,
  message: string,
  format: OutputFormat | null,
  details?: Record<string, unknown>,
): never {
  if (finalizeClaimEpicId !== null) {
    clearCloseMarker(finalizeClaimEpicId);
  }
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  formatOutput({ success: false, error }, format);
  process.exit(1);
}

/** Resolve the owning project (--project abs bypass / cwd-walk). Mirrors
 * _resolve_project. */
function resolveFinalizeProject(
  project: string | null,
  format: OutputFormat | null,
): ProjectContext {
  if (project !== null) {
    const projectPathObj = expandUser(project);
    if (!isAbsolute(projectPathObj)) {
      usageError(`--project requires an absolute path, got: ${project}`);
    }
    const projectRoot = realpathOr(resolveAbs(projectPathObj));
    if (!hasDataDir(projectRoot)) {
      emitFinalizeError(
        "NOT_A_PROJECT",
        `No plan project found at ${projectRoot}. Run 'keeper plan init' first.`,
        format,
      );
    }
    return contextForRoot(projectRoot);
  }
  return resolveProject(format);
}

/** Distinct non-null integer kept/merged ordinals in the verdict (booleans
 * excluded — JSON has no bool/int subtype issue, but a literal true/false task
 * field must not count). Mirrors _expected_cluster_ordinals. */
function expectedClusterOrdinals(
  verdict: Record<string, unknown>,
): Set<number> {
  const ordinals = new Set<number>();
  const decisions = (verdict.decisions as unknown[] | undefined) ?? [];
  for (const d of decisions) {
    if (d === null || typeof d !== "object") {
      continue;
    }
    const task = (d as Record<string, unknown>).task;
    if (typeof task === "number" && Number.isInteger(task)) {
      ordinals.add(task);
    }
  }
  return ordinals;
}

/** Return the open epic the close saga itself scaffolded for sourceEpicId.
 * Discovery rides positive provenance: created_by_close_of === sourceEpicId.
 * depends_on_epics is never consulted. First-seen wins via sorted glob. Returns
 * {epicId, actualTasks, dependsOnEpics, status} or null. Mirrors
 * _find_followup_epic. */
function findFollowupEpic(
  dataDir: string,
  sourceEpicId: string,
): {
  epicId: string;
  actualTasks: number;
  dependsOnEpics: string[];
  status: string | undefined;
} | null {
  const epicsDir = join(dataDir, "epics");
  const tasksDir = join(dataDir, "tasks");
  if (!existsSync(epicsDir)) {
    return null;
  }

  const epicFiles = readdirSync(epicsDir)
    .filter((n) => n.endsWith(".json"))
    .sort();
  for (const file of epicFiles) {
    const stem = file.slice(0, -".json".length);
    if (stem === sourceEpicId) {
      continue;
    }
    const epDef = loadJsonSafe(join(epicsDir, file));
    if (epDef === null) {
      continue;
    }
    if (epDef.status !== "open") {
      continue;
    }
    if (epDef.created_by_close_of !== sourceEpicId) {
      continue;
    }

    const dependsOnEpics = [
      ...((epDef.depends_on_epics as string[] | undefined) ?? []),
    ];
    const candidateId = (epDef.id as string | undefined) ?? stem;
    let actualTasks = 0;
    if (existsSync(tasksDir)) {
      const prefix = `${candidateId}.`;
      actualTasks = readdirSync(tasksDir).filter((n) => {
        if (!n.startsWith(prefix) || !n.endsWith(".json")) {
          return false;
        }
        // Match `<id>.*.json`: the middle is a single ordinal, no deeper dots.
        const middle = n.slice(prefix.length, -".json".length);
        return middle.length > 0 && !middle.includes(".");
      }).length;
    }
    return {
      epicId: candidateId,
      actualTasks,
      dependsOnEpics,
      status: epDef.status as string | undefined,
    };
  }
  return null;
}

/** Run a delegate (epic close / scaffold) in-process with cwd set to the
 * project path and stdout captured (finalize emits its OWN terminal envelope —
 * the delegate's envelope is internal plumbing). Returns the delegate's return
 * value + the captured stdout. Mirrors the os.chdir + redirect_stdout dance. */
function runCaptured<T>(
  projectPath: string,
  fn: () => T,
): { result: T; output: string } {
  const prevCwd = process.cwd();
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // Replace stdout.write with a buffer collector. The signature matches the
  // overloaded Node stream write; we always return true and ignore the
  // encoding/callback args (the delegate's callers fire no callback).
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (
    chunk: unknown,
  ): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    process.chdir(projectPath);
    const result = fn();
    return { result, output: chunks.join("") };
  } finally {
    process.chdir(prevCwd);
    (process.stdout as unknown as { write: typeof origWrite }).write =
      origWrite;
  }
}

/** Run the real epic close against epicId (delegates the commit). Reached only
 * when the epic is still open, so run_epic_close's "already done" path is never
 * hit. Mirrors _close_epic. */
function closeEpic(ctx: ProjectContext, epicId: string): void {
  runCaptured(ctx.projectPath, () => {
    runEpicClose({
      epicId,
      force: false,
      reason: null,
      project: null,
      format: null,
    });
  });
}

/** Mint the follow-up tree via the REAL scaffold, returning the new epic id.
 * Captures scaffold's stdout to parse the minted epic_id; createdByCloseOf is
 * the internal-only provenance arg scaffold stamps. A non-zero exit surfaces as
 * SCAFFOLD_FAILED (source epic still open, re-runnable). Mirrors
 * _scaffold_followup. */
function scaffoldFollowup(
  ctx: ProjectContext,
  followupYamlPath: string,
  sourceEpicId: string,
  format: OutputFormat | null,
): string {
  const { result: rc, output } = runCaptured(ctx.projectPath, () =>
    runScaffold({
      file: followupYamlPath,
      allowDuplicate: false,
      createdByCloseOf: sourceEpicId,
    }),
  );

  if (rc) {
    // A follow-up scaffold that REFUSED because the state repo is mid-operation
    // (merge/cherry-pick/revert/rebase) wrote nothing and is retryable — surface
    // it as a distinct re-runnable outcome, not terminal SCAFFOLD_FAILED (which
    // reads as a broken plan). A re-close once the window closes completes.
    if (scaffoldRefusedMidOperation(output)) {
      emitFinalizeError(
        "MERGE_IN_PROGRESS",
        "the follow-up scaffold hit an in-progress operation in the state " +
          "repo; nothing was written and the source epic is still open — " +
          "re-run the close once the operation finishes",
        format,
        { scaffold_output: output.trim() },
      );
    }
    emitFinalizeError(
      "SCAFFOLD_FAILED",
      "scaffold of the follow-up plan failed; the source epic is still " +
        "open and the close is re-runnable once the plan is fixed",
      format,
      { scaffold_output: output.trim() },
    );
  }

  const newEpicId = parseScaffoldEpicId(output);
  if (newEpicId === null) {
    emitFinalizeError(
      "SCAFFOLD_FAILED",
      "scaffold returned success but no epic_id could be parsed from its " +
        "envelope; refusing to close without a follow-up handle",
      format,
      { scaffold_output: output.trim() },
    );
  }
  return newEpicId;
}

/** True when scaffold's captured output carries the retryable merge_in_progress
 * failure envelope ({success:false, error:{code:"merge_in_progress", ...}}). The
 * follow-up scaffold refuses (writing nothing) when the state repo is
 * mid-operation; scaffoldFollowup passes that class through as a re-runnable
 * outcome rather than mapping it to terminal SCAFFOLD_FAILED. Scans every JSON
 * object on the captured stream, matching parseScaffoldEpicId's decode dance. */
function scaffoldRefusedMidOperation(output: string): boolean {
  let idx = 0;
  while (idx < output.length) {
    const brace = output.indexOf("{", idx);
    if (brace === -1) {
      break;
    }
    const decoded = rawDecode(output, brace);
    if (decoded === null) {
      idx = brace + 1;
      continue;
    }
    const [obj, end] = decoded;
    if (obj !== null && typeof obj === "object") {
      const err = (obj as Record<string, unknown>).error;
      if (
        err !== null &&
        typeof err === "object" &&
        (err as Record<string, unknown>).code === "merge_in_progress"
      ) {
        return true;
      }
    }
    idx = end;
  }
  return false;
}

/** Pull epic_id from scaffold's success envelope on stdout, skipping the
 * trailing plan_invocation line. Scans every JSON object on stdout for the
 * first carrying a string epic_id. Mirrors _parse_scaffold_epic_id. */
function parseScaffoldEpicId(output: string): string | null {
  let idx = 0;
  while (idx < output.length) {
    const brace = output.indexOf("{", idx);
    if (brace === -1) {
      break;
    }
    const decoded = rawDecode(output, brace);
    if (decoded === null) {
      idx = brace + 1;
      continue;
    }
    const [obj, end] = decoded;
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as Record<string, unknown>).epic_id === "string"
    ) {
      return (obj as Record<string, unknown>).epic_id as string;
    }
    idx = end;
  }
  return null;
}

/** Decode the first complete JSON value starting at `start`, returning
 * [value, endIndex] or null. Emulates json.JSONDecoder().raw_decode by scanning
 * for the matching close brace and JSON.parse-ing that slice. */
function rawDecode(text: string, start: number): [unknown, number] | null {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return [JSON.parse(slice), i + 1];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Return a synthetic empty verdict when the audit found 0 findings. Reads the
 * commit_set_hash + findings count from report.meta.json; the findings==0 guard
 * keeps it safe (a >0-findings audit with no verdict means the planner crashed →
 * still fails closed). Mirrors _synthesize_verdict_if_zero_findings. */
function synthesizeVerdictIfZeroFindings(
  vp: string,
  primaryRepo: string,
  epicId: string,
  format: OutputFormat | null,
): Record<string, unknown> {
  const mp = reportMetaPath(primaryRepo, epicId);
  if (!existsSync(mp)) {
    emitFinalizeError(
      "VERDICT_MISSING",
      `no verdict for ${epicId} at ${vp}; run \`keeper plan verdict submit\` ` +
        "(via /plan:close) before close-finalize",
      format,
      { expected: vp },
    );
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(mp, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    emitFinalizeError(
      "VERDICT_MISSING",
      `no verdict for ${epicId} at ${vp}; report.meta.json unreadable: ` +
        `${(exc as Error).message}`,
      format,
      { expected: vp },
    );
  }
  const auditFindings = typeof meta.findings === "number" ? meta.findings : -1;
  if (auditFindings !== 0) {
    emitFinalizeError(
      "VERDICT_MISSING",
      `no verdict for ${epicId} at ${vp}; audit reported ${auditFindings} ` +
        "finding(s) but no verdict was submitted — run `keeper plan verdict " +
        "submit` (via /plan:close) before close-finalize",
      format,
      { expected: vp, audit_findings: auditFindings },
    );
  }
  return {
    fatal: false,
    fatal_reason: "",
    decisions: [],
    commit_set_hash: meta.commit_set_hash ?? null,
  };
}

export interface CloseFinalizeArgs {
  epicId: string;
  project: string | null;
  format: OutputFormat | null;
  /** Optional path to a pre-selection verdict (ordinal-keyed cells + a selection
   * provenance block) folded into a fresh follow-up scaffold. */
  selectionVerdict: string | null;
}

export function runCloseFinalize(args: CloseFinalizeArgs): void {
  const { epicId, project, format, selectionVerdict } = args;
  // Stash the claim so any terminal error (via emitFinalizeError) releases it —
  // a failed close must free the epic for a clean re-run. Set fresh every
  // invocation before any error path can fire.
  finalizeClaimEpicId = epicId;

  // 1. validate id (epic-shape; a task-shaped id names its parent epic).
  if (!isEpicId(epicId)) {
    if (isTaskId(epicId)) {
      const parent = epicId.slice(0, epicId.lastIndexOf("."));
      emitFinalizeError(
        "BAD_EPIC_ID",
        `close operates on epics, not tasks — parent epic is ${parent}`,
        format,
        { task_id: epicId, parent_epic: parent },
      );
    }
    emitFinalizeError("BAD_EPIC_ID", `Invalid epic ID: ${epicId}`, format);
  }

  // 2. resolve project + load the epic.
  const ctx = resolveFinalizeProject(project, format);
  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitFinalizeError(
      "EPIC_NOT_FOUND",
      `Epic not found in ${ctx.projectPath}: ${epicId}`,
      format,
    );
  }
  const epicDef = loadEpic(ctx, epicId);
  const primaryRepo = realpathOr(
    (epicDef.primary_repo as string | null | undefined) || ctx.projectPath,
  );
  const touchedRepos = epicDef.touched_repos as string[] | null | undefined;

  // The irreversible epic-close tally + the follow-up mint route STATE through a
  // primary-rooted context, never the cwd ctx. In worktree mode the close runs
  // from the epic's lane, but the runtime overlay (the tally reads task status
  // from it) and a minted follow-up tree live ONLY in the primary repo — a
  // cwd-resolved ctx would tally stale lane state and orphan the follow-up into
  // the lane. When cwd==primary (non-worktree / --project), stateCtx == ctx.
  const stateCtx = contextForRoot(primaryRepo);

  // 3. idempotent re-run: an already-done epic returns its prior terminal
  //    outcome WITHOUT calling close again.
  if (epicDef.status === "done") {
    const priorFollowup = findFollowupEpic(stateCtx.dataDir, epicId);
    if (priorFollowup !== null) {
      emitOutcome(
        CLOSE_OUTCOMES.CLOSED_WITH_FOLLOWUP,
        epicId,
        ctx,
        format,
        stateCtx,
        { newEpicId: priorFollowup.epicId },
      );
      return;
    }
    emitOutcome(CLOSE_OUTCOMES.CLOSED_CLEAN, epicId, ctx, format, stateCtx);
    return;
  }

  // 4. read the persisted verdict — synthesize empty when findings==0.
  const vp = verdictPath(primaryRepo, epicId);
  let verdict: Record<string, unknown>;
  if (!existsSync(vp)) {
    verdict = synthesizeVerdictIfZeroFindings(vp, primaryRepo, epicId, format);
  } else {
    try {
      verdict = JSON.parse(readFileSync(vp, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch (exc) {
      emitFinalizeError(
        "VERDICT_CORRUPT",
        `could not read verdict ${vp}: ${(exc as Error).message}`,
        format,
      );
    }
  }

  // 5. re-derive commit_set_hash FRESH; mismatch → STALE_ARTIFACTS.
  const taskIds = loadTasksForEpic(stateCtx, epicId)
    .sort(
      (a, b) =>
        taskSortKey((a.id as string) ?? "") -
        taskSortKey((b.id as string) ?? ""),
    )
    .map((t) => t.id as string | undefined)
    .filter((id): id is string => Boolean(id));
  let commitGroups: CommitGroupResult[];
  try {
    // Pass epicId so the scan is lane-aware, IDENTICAL to close-preflight: both run
    // while the epic's commits still live on the `keeper/epic/<epic_id>` lane (the
    // merge to default happens post-finalize), so a HEAD-only re-derive here would
    // miss lane-only commits and drift the hash → a spurious STALE_ARTIFACTS on
    // every worktree close.
    commitGroups = findCommitGroups(taskIds, primaryRepo, touchedRepos, epicId);
  } catch (exc) {
    if (exc instanceof AllReposBrokenError) {
      emitFinalizeError(
        "COMMIT_LOOKUP_FAILED",
        "commit-trailer scan found no usable repo: every repo in the scan " +
          "set is missing or not a git repo",
        format,
        { broken_repos: exc.brokenRepos },
      );
    }
    throw exc;
  }
  const freshHash = computeCommitSetHash(commitGroups);
  const stampedHash = verdict.commit_set_hash ?? null;
  if (stampedHash !== freshHash) {
    emitFinalizeError(
      "STALE_ARTIFACTS",
      `commit_set_hash drift for ${epicId}: a source commit landed after ` +
        "the audit ran. Re-run /plan:close to re-audit against the current " +
        "commit set (the verb refuses, never deletes, the stale artifacts).",
      format,
      { stamped_hash: stampedHash, fresh_hash: freshHash },
    );
  }

  // 6. fatal verdict → halt. No close, no scaffold; the epic stays open.
  if (verdict.fatal === true) {
    emitOutcome(CLOSE_OUTCOMES.FATAL_HALT, epicId, ctx, format, stateCtx, {
      fatalReason: (verdict.fatal_reason as string | undefined) ?? "",
    });
    return;
  }

  // 7. zero surviving decisions → clean close.
  const expected = expectedClusterOrdinals(verdict);
  if (expected.size === 0) {
    closeEpic(stateCtx, epicId);
    emitOutcome(CLOSE_OUTCOMES.CLOSED_CLEAN, epicId, ctx, format, stateCtx);
    return;
  }

  // 8. surviving findings need a follow-up. Found+complete → adopt; found+
  //    partial → stop; absent → scaffold.
  const expectedCount = expected.size;
  const existing = findFollowupEpic(stateCtx.dataDir, epicId);
  if (existing !== null) {
    if (existing.actualTasks === expectedCount) {
      closeEpic(stateCtx, epicId);
      emitOutcome(
        CLOSE_OUTCOMES.CLOSED_WITH_FOLLOWUP,
        epicId,
        ctx,
        format,
        stateCtx,
        { newEpicId: existing.epicId },
      );
      return;
    }
    emitOutcome(
      CLOSE_OUTCOMES.PARTIAL_FOLLOWUP,
      epicId,
      ctx,
      format,
      stateCtx,
      {
        newEpicId: existing.epicId,
        expectedTasks: expectedCount,
        actualTasks: existing.actualTasks,
      },
    );
    return;
  }

  // Absent: scaffold from the persisted followup.yaml. A missing followup.yaml
  // with surviving decisions is a fail-closed typed error.
  const fp = followupPath(primaryRepo, epicId);
  if (!existsSync(fp)) {
    emitFinalizeError(
      "FOLLOWUP_MISSING",
      `no follow-up plan for ${epicId} at ${fp}, but the verdict has ` +
        `${expectedCount} surviving finding cluster(s); run ` +
        "`keeper plan followup submit` (via /plan:close) before close-finalize",
      format,
      { expected: fp, expected_tasks: expectedCount },
    );
  }
  // Pre-select: fold the optional selection verdict's ordinal-keyed cells into
  // the scaffold input so the follow-up tasks are BORN selected. A valid verdict
  // rewrites a merged temp YAML (scaffold's own tier/model validation re-enforces
  // the axes); an absent / malformed verdict DEGRADES to the document's stamped
  // defaults (never rejects the finalize). Both write a committed sidecar.
  const followupText = readFileSync(fp, "utf-8");
  const followupDoc = parseFollowupDoc(followupText, fp);
  const selection = loadSelectionVerdict(
    selectionVerdict,
    followupText,
    followupDoc?.taskCount ?? null,
  );

  let scaffoldFile = fp;
  let mergedFile: string | null = null;
  if (selection.kind === "guided" && followupDoc !== null) {
    mergedFile = writeMergedFollowup(followupDoc.doc, selection.cells, format);
    scaffoldFile = mergedFile;
  }
  let newEpicId: string;
  try {
    newEpicId = scaffoldFollowup(stateCtx, scaffoldFile, epicId, format);
  } finally {
    if (mergedFile !== null) {
      unlinkQuiet(mergedFile);
    }
  }

  // Sidecar BEFORE closeEpic: its atomic write records the touched path, and epic
  // close's auto-commit sweeps the (dirty) top-level selections/ file into the
  // close commit — finalize itself draws no commit.
  writeCloseSelectionSidecar(stateCtx.dataDir, newEpicId, selection);

  closeEpic(stateCtx, epicId);
  emitOutcome(
    CLOSE_OUTCOMES.CLOSED_WITH_FOLLOWUP,
    epicId,
    ctx,
    format,
    stateCtx,
    { newEpicId },
  );
}

/** Emit the typed close-finalize outcome envelope (read-only invocation line).
 * finalize draws no .planctl/ commit — epic close / scaffold already landed
 * theirs — so the terminal envelope rides the read-only invocation footer.
 * Clears this session's close marker (single chokepoint for all outcomes).
 * Mirrors _emit_outcome. */
function emitOutcome(
  outcome: CloseOutcome,
  epicId: string,
  ctx: ProjectContext,
  format: OutputFormat | null,
  stateCtx: ProjectContext,
  extra?: {
    newEpicId?: string;
    fatalReason?: string;
    expectedTasks?: number;
    actualTasks?: number;
  },
): void {
  clearCloseMarker(epicId);

  const data: Record<string, unknown> = {
    outcome,
    epic_id: epicId,
    finalized_at: nowIso(),
  };
  if (extra?.newEpicId !== undefined) {
    data.new_epic_id = extra.newEpicId;
  }
  if (extra?.fatalReason !== undefined) {
    data.fatal_reason = extra.fatalReason;
  }
  if (extra?.expectedTasks !== undefined) {
    data.expected_tasks = extra.expectedTasks;
  }
  if (extra?.actualTasks !== undefined) {
    data.actual_tasks = extra.actualTasks;
  }

  // Arm the follow-up at the single terminal chokepoint. A closed_with_followup
  // epic is dispatchable only once its validation marker flips null→timestamp;
  // this covers ALL three closing paths (fresh scaffold + both crash-resume
  // adopt paths) and deliberately EXCLUDES partial_followup (a half-built tree
  // must stay a non-dispatchable ghost). The seam is idempotent, so an adopt
  // path re-arming an already-armed follow-up is a no-op. State routes through
  // stateCtx (the primary repo): in worktree mode the follow-up lives there, not
  // in the cwd lane. An arm failure folds INTO this envelope (surfaced verbatim)
  // rather than hard-exiting after the irreversible close — the dashed ghost is
  // swept by the next .keeper/ commit.
  if (
    outcome === CLOSE_OUTCOMES.CLOSED_WITH_FOLLOWUP &&
    extra?.newEpicId !== undefined
  ) {
    const arm = armEpicValidated(
      extra.newEpicId,
      stateCtx.dataDir,
      stateCtx.projectPath,
    );
    if (arm.kind === "commit_failed") {
      data.followup_arm = arm.failure;
    }
  }

  const pc = buildPlanInvocationReadonly(
    "close-finalize",
    ctx.projectPath,
    epicId,
  );
  // emitReadonly embeds the invocation into the payload line (self-emit), so the
  // dispatcher's generic trailer is suppressed — matching Python's
  // emit(data, plan_invocation=pc). format is honored upstream by the caller.
  void format;
  emitReadonly(data, pc);
}

// ---------------------------------------------------------------------------
// Follow-up cell pre-selection.
// ---------------------------------------------------------------------------

/** A validated, in-axis {tier, model} cell keyed by 1-based ordinal, carrying
 * the selector's optional per-cell provenance. */
interface VerdictCell {
  tier: string;
  model: string;
  rationale: string | null;
  confidence: number | string | null;
}

/** The selector's own provenance block, shape-mirroring the sidecar's. */
interface SelectionProvenance {
  selector: { harness: string; model: string };
  configHash: string;
  inputHash: string;
  shuffleSeed: number | null;
  outcome: string;
  verdictRaw: string | null;
}

/** The verdict-load result: a guided selection (all cells in-axis + full
 * coverage) or a degrade carrying a reason and the follow-up document hash (the
 * reproducible input anchor for the degraded sidecar). */
type SelectionResult =
  | {
      kind: "guided";
      cells: Map<number, VerdictCell>;
      provenance: SelectionProvenance;
    }
  | { kind: "degraded"; reason: string; inputHash: string };

/** Parse the stored follow-up document to its task count (for verdict coverage)
 * plus the mutable doc (for the merge rewrite). Returns null when the document is
 * unparseable or carries no task list — scaffold then runs on the raw file and
 * surfaces its own error. */
function parseFollowupDoc(
  text: string,
  label: string,
): { doc: Record<string, unknown>; taskCount: number } | null {
  let doc: unknown;
  try {
    doc = parseYamlInput(Buffer.from(text, "utf-8"), label);
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) {
    return null;
  }
  const tasks = doc.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return null;
  }
  return { doc, taskCount: tasks.length };
}

/** Load + fail-closed validate the optional selection verdict. Any absence,
 * unreadability, malformed shape, out-of-axis cell, or coverage mismatch DEGRADES
 * (returns a reason) rather than throwing — a malformed verdict must never reject
 * the finalize. `taskCount` is the follow-up document's task count (null when it
 * could not be parsed); a null count forces a degrade. */
function loadSelectionVerdict(
  path: string | null,
  followupText: string,
  taskCount: number | null,
): SelectionResult {
  const followupHash = sha256(followupText);
  const degrade = (reason: string): SelectionResult => ({
    kind: "degraded",
    reason,
    inputHash: followupHash,
  });

  if (path === null) {
    return degrade("no-selection-verdict-supplied");
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return degrade("verdict-unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return degrade("verdict-unparseable");
  }
  if (!isPlainObject(parsed)) {
    return degrade("verdict-not-object");
  }
  const sv = parsed.schema_version;
  if (typeof sv === "number" && sv > SELECTION_SCHEMA_VERSION) {
    return degrade("verdict-schema-too-new");
  }
  if (!isPlainObject(parsed.cells)) {
    return degrade("verdict-cells-missing");
  }
  if (!isPlainObject(parsed.selection)) {
    return degrade("verdict-provenance-missing");
  }
  const provenance = parseSelectionProvenance(parsed.selection);
  if (provenance === null) {
    return degrade("verdict-provenance-invalid");
  }
  if (taskCount === null) {
    return degrade("followup-unparseable");
  }

  const efforts = configuredEfforts();
  const models = configuredModels();
  const cells = new Map<number, VerdictCell>();
  for (const [key, raw] of Object.entries(parsed.cells)) {
    if (!/^[1-9][0-9]*$/.test(key)) {
      return degrade("verdict-cell-key-invalid");
    }
    if (!isPlainObject(raw)) {
      return degrade("verdict-cell-not-object");
    }
    const tier = raw.tier;
    const model = raw.model;
    if (typeof tier !== "string" || !efforts.includes(tier)) {
      return degrade("verdict-cell-out-of-axis");
    }
    if (typeof model !== "string" || !models.includes(model)) {
      return degrade("verdict-cell-out-of-axis");
    }
    const rationale = typeof raw.rationale === "string" ? raw.rationale : null;
    const confidence =
      typeof raw.confidence === "number" || typeof raw.confidence === "string"
        ? raw.confidence
        : null;
    cells.set(Number.parseInt(key, 10), { tier, model, rationale, confidence });
  }

  // Full-set coverage: exactly the ordinals 1..taskCount, no gaps or extras.
  if (cells.size !== taskCount) {
    return degrade("verdict-coverage-mismatch");
  }
  for (let i = 1; i <= taskCount; i += 1) {
    if (!cells.has(i)) {
      return degrade("verdict-coverage-mismatch");
    }
  }

  return { kind: "guided", cells, provenance };
}

/** Validate the verdict's `selection:` provenance block — harness, model,
 * config_hash, input_hash, outcome as non-empty strings; shuffle_seed an integer
 * or absent; verdict_raw a string or absent. Returns null on any violation. */
function parseSelectionProvenance(
  sel: Record<string, unknown>,
): SelectionProvenance | null {
  const reqStr = (key: string): string | null => {
    const v = sel[key];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const harness = reqStr("harness");
  const model = reqStr("model");
  const configHash = reqStr("config_hash");
  const inputHash = reqStr("input_hash");
  const outcome = reqStr("outcome");
  if (
    harness === null ||
    model === null ||
    configHash === null ||
    inputHash === null ||
    outcome === null
  ) {
    return null;
  }
  let shuffleSeed: number | null = null;
  const seedRaw = sel.shuffle_seed;
  if (seedRaw !== null && seedRaw !== undefined) {
    if (typeof seedRaw === "number" && Number.isInteger(seedRaw)) {
      shuffleSeed = seedRaw;
    } else {
      return null;
    }
  }
  let verdictRaw: string | null = null;
  const vr = sel.verdict_raw;
  if (vr !== null && vr !== undefined) {
    if (typeof vr === "string") {
      verdictRaw = vr;
    } else {
      return null;
    }
  }
  return {
    selector: { harness, model },
    configHash,
    inputHash,
    shuffleSeed,
    outcome,
    verdictRaw,
  };
}

/** Rewrite the follow-up document with the selected {tier, model} folded in by
 * ordinal, serialized YAML 1.1 (so a 1.1-ambiguous scalar is re-quoted, never
 * silently coerced on scaffold's re-parse), to a throwaway temp file scaffold
 * consumes. The caller unlinks it. */
function writeMergedFollowup(
  doc: Record<string, unknown>,
  cells: Map<number, VerdictCell>,
  format: OutputFormat | null,
): string {
  const tasks = doc.tasks as unknown[];
  for (let i = 0; i < tasks.length; i += 1) {
    const cell = cells.get(i + 1);
    const entry = tasks[i];
    if (cell !== undefined && isPlainObject(entry)) {
      entry.tier = cell.tier;
      entry.model = cell.model;
    }
  }
  let text: string;
  try {
    text = stringifyYaml(doc, { version: "1.1" });
  } catch (exc) {
    emitFinalizeError(
      "SELECTION_MERGE_FAILED",
      `could not merge the selected cells into the follow-up plan: ${
        (exc as Error).message
      }`,
      format,
    );
  }
  const dest = join(
    tmpdir(),
    `keeper-plan-followup-${randomBytes(16).toString("hex")}.yaml`,
  );
  writeFileSync(dest, text, "utf-8");
  return dest;
}

/** The minted follow-up tasks in ascending ordinal order, each with its on-disk
 * {tier, model} — the cell values the sidecar records regardless of path (the
 * verdict-selected values on the guided path, the document defaults on degrade). */
function readMintedCells(
  dataDir: string,
  epicId: string,
): { ordinal: number; taskId: string; tier: string; model: string }[] {
  const tasksDir = join(dataDir, "tasks");
  if (!existsSync(tasksDir)) {
    return [];
  }
  const prefix = `${epicId}.`;
  const ordinals: number[] = [];
  for (const name of readdirSync(tasksDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) {
      continue;
    }
    const middle = name.slice(prefix.length, -".json".length);
    if (middle.length === 0 || middle.includes(".")) {
      continue;
    }
    const ord = Number.parseInt(middle, 10);
    if (Number.isInteger(ord) && String(ord) === middle) {
      ordinals.push(ord);
    }
  }
  ordinals.sort((a, b) => a - b);
  return ordinals.map((ord) => {
    const taskId = `${epicId}.${ord}`;
    const def = loadJsonSafe(join(tasksDir, `${taskId}.json`)) ?? {};
    return {
      ordinal: ord,
      taskId,
      tier: typeof def.tier === "string" ? def.tier : "",
      model: typeof def.model === "string" ? def.model : "",
    };
  });
}

/** Write the committed selection sidecar for the minted follow-up epic. A guided
 * selection stamps label_source heuristic-guided + the selector provenance; a
 * degrade stamps heuristic-default + a `degraded:<reason>` outcome anchored on
 * the follow-up document hash. The cell {tier, model} always mirror the minted
 * tasks on disk. */
function writeCloseSelectionSidecar(
  dataDir: string,
  epicId: string,
  selection: SelectionResult,
): void {
  const minted = readMintedCells(dataDir, epicId);
  const now = nowIso();
  let sidecar: SelectionSidecar;
  if (selection.kind === "guided") {
    sidecar = {
      schema_version: SELECTION_SCHEMA_VERSION,
      epic_id: epicId,
      created_at: now,
      selector: selection.provenance.selector,
      config_hash: selection.provenance.configHash,
      input_hash: selection.provenance.inputHash,
      shuffle_seed: selection.provenance.shuffleSeed,
      outcome: selection.provenance.outcome,
      verdict_raw: selection.provenance.verdictRaw,
      cells: minted.map((m) => {
        const c = selection.cells.get(m.ordinal);
        return {
          task_id: m.taskId,
          tier: m.tier,
          model: m.model,
          rationale: c?.rationale ?? null,
          confidence: c?.confidence ?? null,
          label_source: "heuristic-guided",
        };
      }),
    };
  } else {
    sidecar = {
      schema_version: SELECTION_SCHEMA_VERSION,
      epic_id: epicId,
      created_at: now,
      selector: { harness: "none", model: "none" },
      config_hash: "",
      input_hash: selection.inputHash,
      shuffle_seed: null,
      outcome: `degraded:${selection.reason}`,
      verdict_raw: null,
      cells: minted.map((m) => ({
        task_id: m.taskId,
        tier: m.tier,
        model: m.model,
        rationale: null,
        confidence: null,
        label_source: "heuristic-default",
      })),
    };
  }
  writeSelectionSidecar(dataDir, sidecar);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unlink best-effort — a temp merged-YAML cleanup that never masks a real
 * error. */
function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup.
  }
}

/** click UsageError shape: usage + try-help on stderr, exit 2. */
function usageError(message: string): never {
  process.stderr.write("Usage: keeper plan close-finalize [OPTIONS] EPIC_ID\n");
  process.stderr.write("Try 'keeper plan close-finalize --help' for help.\n\n");
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

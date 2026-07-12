// selection-audit-brief verb — the mechanical, committed capture beat a
// human-invoked out-of-band grading skill later hands its auditor.
//
// Assembles, for one closed epic, the grading context for each AUDITABLE
// completed task: the task spec, the assigned {tier, model} the selector
// picked, the DISPATCHED {tier, model} that actually ran (`tier`/`model` —
// equal to the assigned cell absent a worker-provider constraint) plus its
// `constraint` (null when unconstrained), the selection run's config + input
// hashes, per-task diff stats derived from the Task-trailer source commits
// (files touched + line counts), and the done summary. The brief carries no
// selector rationale/confidence/label_source — those stay in the selection
// sidecar for calibration only, kept out of the blinded grading pass. The
// brief lands committed so a future grading run has a stable, git-recoverable
// snapshot to grade from; no auditor runs at close time.
//
// AUDITABLE excludes two non-decisions whose grading would poison the dataset:
//   - a task whose cell was a degraded default (sidecar label_source
//     `heuristic-default`) — the selector never made a real choice, and
//   - a task with no executed-worker evidence (no Task-trailer commit AND no job
//     claim) — nothing exercised the cell.
// Every other done task is auditable; the brief also lists the exclusions + why.
//
// Write-once on the brief's OWN existence: a re-close after a brief already
// landed is idempotent — success, no rewrite, no second commit — since a
// re-close is not a re-audit. `--force` deliberately re-derives it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import { AllReposBrokenError, findCommitGroups } from "../commit_lookup.ts";
import { emitMutating } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import {
  resolvePlanStateContext,
  tryResolveOwningProjectForId,
} from "../project.ts";
import {
  SELECTION_AUDIT_BRIEF_SCHEMA_VERSION,
  selectionAuditBriefExists,
  selectionAuditBriefPath,
  writeSelectionAuditBriefFile,
} from "../selection_review_file.ts";
import {
  readSelectionSidecar,
  type SidecarCell,
} from "../selection_sidecar.ts";
import { getTaskSection } from "../specs.ts";
import { nowIso } from "../store.ts";
import { getVcs } from "../vcs.ts";

export interface SelectionAuditBriefArgs {
  epicId: string;
  project: string | null;
  force: boolean;
  format: OutputFormat | null;
}

/** Exclusion reasons the brief records for a non-auditable task. */
type ExclusionReason =
  | "not-done"
  | "no-sidecar-cell"
  | "degraded-default"
  | "no-execution-evidence";

interface ExcludedTask {
  task_id: string;
  reason: ExclusionReason;
}

interface DiffStats {
  commit_count: number;
  files_changed: number;
  insertions: number;
  deletions: number;
}

function emitAuditBriefError(
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

/** Typed epic-resolution preflight (mirrors selection-brief): a typed
 * NOT_A_PROJECT / AMBIGUOUS_EPIC_ID / EPIC_NOT_FOUND envelope before the state
 * context resolves. */
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
    emitAuditBriefError(
      "NOT_A_PROJECT",
      `no plan project found at ${res.projectRoot}`,
      format,
      { project: res.projectRoot },
    );
  }
  if (res.reason === "ambiguous") {
    emitAuditBriefError(
      "AMBIGUOUS_EPIC_ID",
      `epic ${res.id} exists in multiple projects; pass --project`,
      format,
      { owners: res.owners },
    );
  }
  emitAuditBriefError("EPIC_NOT_FOUND", `epic not found: ${res.id}`, format, {
    epic_id: res.id,
  });
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function taskStatus(t: Record<string, unknown>): string {
  const raw = t.status ?? t.runtime_status;
  return typeof raw === "string" && raw !== "" ? raw : "todo";
}

/** A task has job evidence when a worker CLAIMED it (`claimed_at` set) — the plan
 * board's decoupled-from-the-jobs-DB proxy for "a worker session ran". `assignee`
 * is NOT a proxy: `done` stamps it to the done actor even on a manual/forced
 * completion, so it would read true for a task no worker ever exercised. */
function hasJobEvidence(t: Record<string, unknown>): boolean {
  const claimedAt = t.claimed_at;
  return typeof claimedAt === "string" && claimedAt !== "";
}

/** The assigned (sidecar) cell vs the dispatched (actually-ran) cell for one
 * task, per the merged runtime state. A worker-provider constraint records
 * `dispatched_model`/`dispatched_tier`/`dispatch_constraint` on the task
 * runtime at claim (claim.ts); an unconstrained claim clears any stale values,
 * so their absence — or a pre-feature brief's runtime predating the keys —
 * both fall to the one documented rule: dispatched == assigned, constraint
 * null. */
function assignedAndDispatchedCell(
  t: Record<string, unknown>,
  cell: SidecarCell,
): {
  assignedTier: string;
  assignedModel: string;
  dispatchedTier: string;
  dispatchedModel: string;
  constraint: string | null;
} {
  const assignedTier = cell.tier;
  const assignedModel = cell.model;
  const rawDispatchedModel = t.dispatched_model;
  const rawDispatchedTier = t.dispatched_tier;
  const hasDispatch =
    typeof rawDispatchedModel === "string" &&
    rawDispatchedModel !== "" &&
    typeof rawDispatchedTier === "string" &&
    rawDispatchedTier !== "";
  if (!hasDispatch) {
    return {
      assignedTier,
      assignedModel,
      dispatchedTier: assignedTier,
      dispatchedModel: assignedModel,
      constraint: null,
    };
  }
  const rawConstraint = t.dispatch_constraint;
  return {
    assignedTier,
    assignedModel,
    dispatchedTier: rawDispatchedTier,
    dispatchedModel: rawDispatchedModel,
    constraint:
      typeof rawConstraint === "string" && rawConstraint !== ""
        ? rawConstraint
        : null,
  };
}

/** The `## Done summary` section of a task's spec markdown ("" when absent). */
function doneSummary(dataDir: string, taskId: string): string {
  const specPath = join(dataDir, "specs", `${taskId}.md`);
  if (!existsSync(specPath)) {
    return "";
  }
  return getTaskSection(readFileSync(specPath, "utf-8"), "## Done summary");
}

/** The Task-trailer source shas for `taskId`, grouped by repo, lane-aware. An
 * all-repos-broken scan degrades to an empty result (the audit is best-effort;
 * an unreadable repo must not hard-fail a close). */
function taskCommitGroups(
  taskId: string,
  primaryRepo: string,
  touchedRepos: string[] | null | undefined,
  epicId: string,
): { repo: string; shas: string[] }[] {
  try {
    return findCommitGroups([taskId], primaryRepo, touchedRepos, epicId);
  } catch (exc) {
    if (exc instanceof AllReposBrokenError) {
      return [];
    }
    throw exc;
  }
}

/** Aggregate diff stats across a task's source commits: distinct changed paths
 * (namespaced per repo) + summed insertions/deletions. */
function aggregateDiffStats(
  groups: { repo: string; shas: string[] }[],
): DiffStats {
  const vcs = getVcs();
  const paths = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  let commitCount = 0;
  for (const g of groups) {
    for (const sha of g.shas) {
      commitCount += 1;
      for (const row of vcs.commitNumstat(sha, g.repo)) {
        paths.add(`${g.repo}\0${row.path}`);
        insertions += row.insertions;
        deletions += row.deletions;
      }
    }
  }
  return {
    commit_count: commitCount,
    files_changed: paths.size,
    insertions,
    deletions,
  };
}

export function runSelectionAuditBrief(args: SelectionAuditBriefArgs): void {
  const { epicId, project, force, format } = args;

  if (!isEpicId(epicId)) {
    emitAuditBriefError(
      "BAD_EPIC_ID",
      `invalid epic id: ${epicId || "<empty>"}`,
      format,
    );
  }

  preflightEpicResolution(epicId, project, format);
  const ctx = resolvePlanStateContext(epicId, project, format);
  const dataDir = ctx.dataDir;

  // Write-once guard on the brief's OWN existence: a re-close after a brief
  // already landed is idempotent (a re-close is not a re-audit), not an error.
  if (!force && selectionAuditBriefExists(dataDir, epicId)) {
    emitMutating(
      {
        epic_id: epicId,
        brief_ref: selectionAuditBriefPath(dataDir, epicId),
        skipped: true,
      },
      {
        verb: "selection-audit-brief",
        target: epicId,
        repoRoot: ctx.projectPath,
        primaryRepo: ctx.projectPath,
      },
    );
    return;
  }

  // The selection sidecar is the grading provenance — no sidecar means the epic
  // never ran through the cell selector, so there is nothing to audit.
  const sidecar = readSelectionSidecar(dataDir, epicId);
  if (sidecar === null) {
    emitAuditBriefError(
      "SIDECAR_MISSING",
      `no selection sidecar for ${epicId}; the epic was never run through ` +
        "cell selection, so there are no cells to audit",
      format,
      { epic_id: epicId },
    );
  }

  const cellByTask = new Map<string, SidecarCell>();
  for (const cell of sidecar.cells) {
    cellByTask.set(cell.task_id, cell);
  }

  const epicDef = loadEpic(ctx, epicId);
  const primaryRepo =
    typeof epicDef.primary_repo === "string" && epicDef.primary_repo !== ""
      ? epicDef.primary_repo
      : ctx.projectPath;
  const touchedRepos = Array.isArray(epicDef.touched_repos)
    ? (epicDef.touched_repos as unknown[]).map(String)
    : null;

  const tasks = loadTasksForEpic(ctx, epicId).sort(
    (a, b) => taskSortKey(asString(a.id)) - taskSortKey(asString(b.id)),
  );

  const auditableTasks: Record<string, unknown>[] = [];
  const excluded: ExcludedTask[] = [];

  for (const t of tasks) {
    const taskId = asString(t.id);
    if (taskId === "") {
      continue;
    }
    // Exclusion order: a non-done task is never gradable; a task the selector
    // never carried a cell for has no provenance; a degraded default is a
    // non-decision; a never-executed task has no outcome to grade against.
    if (taskStatus(t) !== "done") {
      excluded.push({ task_id: taskId, reason: "not-done" });
      continue;
    }
    const cell = cellByTask.get(taskId);
    if (cell === undefined) {
      excluded.push({ task_id: taskId, reason: "no-sidecar-cell" });
      continue;
    }
    if (cell.label_source === "heuristic-default") {
      excluded.push({ task_id: taskId, reason: "degraded-default" });
      continue;
    }

    const groups = taskCommitGroups(taskId, primaryRepo, touchedRepos, epicId);
    const hasCommit = groups.some((g) => g.shas.length > 0);
    if (!hasCommit && !hasJobEvidence(t)) {
      excluded.push({ task_id: taskId, reason: "no-execution-evidence" });
      continue;
    }

    const specPath = join(dataDir, "specs", `${taskId}.md`);
    const specMd = existsSync(specPath) ? readFileSync(specPath, "utf-8") : "";

    const {
      assignedTier,
      assignedModel,
      dispatchedTier,
      dispatchedModel,
      constraint,
    } = assignedAndDispatchedCell(t, cell);

    auditableTasks.push({
      task_id: taskId,
      title: asString(t.title),
      // The DISPATCHED cell — the one the auditor grades, since it is what
      // actually ran. Equal to the assigned cell absent a constraint.
      tier: dispatchedTier,
      model: dispatchedModel,
      // The selector's original pick, unaffected by any worker-provider
      // translation — kept so a constrained run's evidence can still be
      // routed back to the equivalence map, never conflated with the grade.
      assigned_tier: assignedTier,
      assigned_model: assignedModel,
      constraint,
      config_hash: sidecar.config_hash,
      input_hash: sidecar.input_hash,
      spec_chars: specMd.length,
      spec_md: specMd,
      done_summary: doneSummary(dataDir, taskId),
      diff_stats: aggregateDiffStats(groups),
    });
  }

  const brief = {
    schema_version: SELECTION_AUDIT_BRIEF_SCHEMA_VERSION,
    epic_id: epicId,
    primary_repo: primaryRepo,
    created_at: nowIso(),
    selector: sidecar.selector,
    selection_config_hash: sidecar.config_hash,
    selection_input_hash: sidecar.input_hash,
    auditable_tasks: auditableTasks,
    excluded_tasks: excluded,
  };

  const briefRef = writeSelectionAuditBriefFile(dataDir, epicId, brief);

  emitMutating(
    {
      epic_id: epicId,
      primary_repo: primaryRepo,
      brief_ref: briefRef,
      auditable_task_ids: auditableTasks.map((t) => t.task_id),
      excluded,
      selection_config_hash: sidecar.config_hash,
      selection_input_hash: sidecar.input_hash,
    },
    {
      verb: "selection-audit-brief",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo: ctx.projectPath,
    },
  );
}

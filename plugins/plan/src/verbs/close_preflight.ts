// close-preflight verb — the byte-parity port of planctl/run_close_preflight.py.
//
// The close-phase brief handoff (the symmetric bookend to claim's worker brief):
// assemble the audit brief — source commit groups, the ordinal task list with
// status + done summaries, and the canonical commit_set_hash — persist it
// commit-free under gitignored audits/<epic_id>/brief.json, then emit a
// content-blind envelope {primary_repo, tasks, all_done, brief_ref,
// commit_set_hash}. The commit_groups prose lives ONLY in the brief file.
//
// all_done is always true on success: a not-all-done epic is a typed
// TASKS_NOT_DONE error, not a false data field. The brief is assembled fully
// BEFORE any write; the writer is commit-free, so this verb mutates only
// gitignored state/ and draws no .planctl/ commit — it rides the dispatcher's
// auto-readonly invocation trailer (NOT a self-emit). On the error path it
// emits the typed envelope + exit 1.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolveAbs } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import {
  AUDIT_SCHEMA_VERSION,
  computeCommitSetHash,
  taskFindingPath,
  writeBriefArtifact,
} from "../audit_artifacts.ts";
import {
  AllReposBrokenError,
  type CommitGroupResult,
  findCommitGroups,
} from "../commit_lookup.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import {
  contextForRoot,
  type ProjectContext,
  resolveProject,
} from "../project.ts";
import { claimCloseExclusive } from "../session_markers.ts";
import { getTaskSection } from "../specs.ts";
import { hasDataDir } from "../state_path.ts";
import { getVcs } from "../vcs.ts";
import { parseYamlInput } from "../yaml_input.ts";
import { findFollowupByBlocksClosingOf } from "./close_finalize.ts";

/** Emit a typed close-preflight error envelope and exit 1. Shape
 * {success:false, error:{code,message,details?}} — no plan_invocation line
 * (a failed read-only fetch mutates nothing). Mirrors _emit_preflight_error. */
function emitPreflightError(
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

/** Read a task's `## Done summary` straight from its spec markdown. The summary
 * is patched into specs/<task_id>.md by done (not a runtime field). A missing
 * spec or empty section yields "". Mirrors _done_summary. */
function doneSummary(dataDir: string, taskId: string): string {
  const specPath = join(dataDir, "specs", `${taskId}.md`);
  if (!existsSync(specPath)) {
    return "";
  }
  return getTaskSection(readFileSync(specPath, "utf-8"), "## Done summary");
}

// ---------------------------------------------------------------------------
// Variable-depth close audit — the plan-time-derived sizing signals the brief
// carries so the close auditor runs more or fewer dimensions. Every signal
// degrades independently: a numstat git error, a missing / malformed policy, or
// an unreadable per-task finding artifact each records a reason and lands the
// band at lean — the close proceeds, never fails, on a depth-signal error.
// ---------------------------------------------------------------------------

/** The audit depth band, deepest last. `lean` is today's single pass (and the
 * degrade floor); `standard` / `deep` run progressively more dimensions. */
export type DepthBand = "lean" | "standard" | "deep";

/** The epic-level signals the depth band is sized from — task count, total diff
 * churn (insertions + deletions summed over every source commit), and the count
 * of repos that actually carry source commits. */
export interface DepthSignals {
  task_count: number;
  diff_lines: number;
  touched_repo_count: number;
}

/** A per-task finding artifact reference — path + status only, content-light so
 * the close auditor reads the full artifact itself. `status` is the artifact's
 * top-level `status` string (open / fixed / clean …) or null when absent. */
interface FindingRef {
  path: string;
  status: string | null;
}

/** The `depth_bands` entry threshold keys `bandMatches` reads, in the exact
 * property names `audit-policy.yaml` uses, paired with the `DepthSignals`
 * field each measures against. `plugins/plan/scripts/audit-policy-check.ts`
 * imports this same list to require these exact keys off every band it
 * coerces, so the runtime consumer and the config's schema cannot silently
 * diverge again. */
export const DEPTH_BAND_THRESHOLD_KEYS = [
  "min_task_count",
  "min_diff_loc",
  "min_touched_repos",
] as const;

const SIGNAL_FOR_THRESHOLD_KEY: Record<
  (typeof DEPTH_BAND_THRESHOLD_KEYS)[number],
  keyof DepthSignals
> = {
  min_task_count: "task_count",
  min_diff_loc: "diff_lines",
  min_touched_repos: "touched_repo_count",
};

function isDepthBand(value: unknown): value is DepthBand {
  return value === "lean" || value === "standard" || value === "deep";
}

/** The plan plugin root (`plugins/plan/`), where the drift-gated config files
 * — model-selector.yaml, subagents.yaml, audit-policy.yaml — sit. Mirrors
 * selection_brief's resolution: three dirs up from `src/verbs/<verb>.ts`. */
function planPluginRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** Best-effort read + parse of the close-depth policy at `policyPath`. Returns
 * the parsed mapping, or null with a typed degrade reason: a missing file is
 * `policy_missing`, an unreadable / non-UTF8 / syntactically-invalid / non-map
 * file is `policy_malformed`. NEVER throws — a policy failure degrades the depth
 * band to lean, it never fails the close. */
export function readAuditPolicyDoc(policyPath: string): {
  doc: Record<string, unknown> | null;
  reason: string | null;
} {
  if (!existsSync(policyPath)) {
    return { doc: null, reason: "policy_missing" };
  }
  let parsed: unknown;
  try {
    parsed = parseYamlInput(readFileSync(policyPath), policyPath);
  } catch {
    return { doc: null, reason: "policy_malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { doc: null, reason: "policy_malformed" };
  }
  return { doc: parsed as Record<string, unknown>, reason: null };
}

/** True when the policy band `entry` matches `signals`: a plain-object entry
 * with at least one numeric threshold from DEPTH_BAND_THRESHOLD_KEYS, every
 * present threshold numeric and met by its paired signal. A missing entry, a
 * non-object, an empty band, or any present-but-non-numeric threshold never
 * matches (conservative bias-lean — a malformed band must not over-claim
 * depth). */
function bandMatches(entry: unknown, signals: DepthSignals): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const thresholds = entry as Record<string, unknown>;
  let constraints = 0;
  for (const key of DEPTH_BAND_THRESHOLD_KEYS) {
    if (!(key in thresholds)) {
      continue;
    }
    const threshold = thresholds[key];
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      return false;
    }
    constraints += 1;
    if (signals[SIGNAL_FOR_THRESHOLD_KEY[key]] < threshold) {
      return false;
    }
  }
  return constraints > 0;
}

/** Derive the depth band from `signals` and the parsed policy's `depth_bands`
 * list — richest-first entries of `{depth, min_task_count, min_diff_loc,
 * min_touched_repos}` (see audit-policy.yaml). The first entry, in file order,
 * whose every present threshold is met wins; none met → lean. Pure over
 * (signals, doc): a null doc is lean with no reason (the caller records the
 * file-level reason), a doc with no usable `depth_bands` is lean with
 * `policy_no_depth_bands`. The caller folds in the file + numstat + finding
 * reasons and forces lean on ANY degrade. */
export function deriveDepthBand(
  signals: DepthSignals,
  policyDoc: Record<string, unknown> | null,
): { band: DepthBand; reasons: string[] } {
  if (policyDoc === null) {
    return { band: "lean", reasons: [] };
  }
  const bands = policyDoc.depth_bands;
  if (!Array.isArray(bands) || bands.length === 0) {
    return { band: "lean", reasons: ["policy_no_depth_bands"] };
  }
  for (const entry of bands) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const depth = (entry as Record<string, unknown>).depth;
    if (isDepthBand(depth) && bandMatches(entry, signals)) {
      return { band: depth, reasons: [] };
    }
  }
  return { band: "lean", reasons: [] };
}

/** The per-task finding-artifact reference under
 * `audits/<epic_id>/tasks/<task_id>.json` (the pure path — this never creates
 * it). A present artifact yields its path + top-level `status`; an unparseable
 * one yields the path with a null status and flags `unreadable` so the caller
 * records the degrade. An absent artifact is the ordinary no-prior-finding case
 * (null ref, not a degrade). */
function findingRefFor(
  primaryRepo: string,
  epicId: string,
  taskId: string,
): { ref: FindingRef | null; unreadable: boolean } {
  const path = taskFindingPath(primaryRepo, epicId, taskId);
  if (!existsSync(path)) {
    return { ref: null, unreadable: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const status = typeof parsed?.status === "string" ? parsed.status : null;
    return { ref: { path, status }, unreadable: false };
  } catch {
    return { ref: { path, status: null }, unreadable: true };
  }
}

export interface ClosePreflightArgs {
  epicId: string;
  project: string | null;
  format: OutputFormat | null;
}

export function runClosePreflight(args: ClosePreflightArgs): void {
  const { epicId, project, format } = args;

  // Three-way id branch: epic-shape proceeds; a task-shape id names the parent
  // epic in the error; garbage is bad.
  if (!isEpicId(epicId)) {
    if (isTaskId(epicId)) {
      const parent = epicId.slice(0, epicId.lastIndexOf("."));
      emitPreflightError(
        "BAD_EPIC_ID",
        `close operates on epics, not tasks — parent epic is ${parent}`,
        format,
        { task_id: epicId, parent_epic: parent },
      );
    }
    emitPreflightError("BAD_EPIC_ID", `Invalid epic ID: ${epicId}`, format);
  }

  // --project <abs_path> bypasses the cwd-walk. Absolute only; relative raises
  // UsageError (exit 2). Unset → resolveProject() cwd-walk.
  let ctx: ProjectContext;
  if (project !== null) {
    const projectPathObj = expandUser(project);
    if (!isAbsolute(projectPathObj)) {
      usageError(`--project requires an absolute path, got: ${project}`);
    }
    const projectRoot = realpathOr(resolveAbs(projectPathObj));
    if (!hasDataDir(projectRoot)) {
      emitPreflightError(
        "NOT_A_PROJECT",
        `No plan project found at ${projectRoot}. Run 'keeper plan init' first.`,
        format,
      );
    }
    ctx = contextForRoot(projectRoot);
  } else {
    ctx = resolveProject(format);
  }

  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitPreflightError(
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

  // Route EVERY plan-state read through a primary-rooted context, never the
  // cwd ctx. In worktree mode the close runs from the epic's lane, but plan
  // STATE (the runtime status overlay + done summaries) lives ONLY in the
  // primary repo (`.keeper/.gitignore` is `state/`) — the committed defs are
  // identical lane vs primary, so a cwd-resolved ctx silently reads stale
  // lane state and reports TASKS_NOT_DONE. When cwd==primary (non-worktree /
  // --project), contextForRoot(primaryRepo) is identical to ctx (a no-op).
  const stateCtx = contextForRoot(primaryRepo);

  // Tasks, ordinal-sorted, with runtime state merged in (from primary).
  const mergedTasks = loadTasksForEpic(stateCtx, epicId).sort(
    (a, b) =>
      taskSortKey((a.id as string) ?? "") - taskSortKey((b.id as string) ?? ""),
  );
  const tasks = mergedTasks.map((t) => ({
    id: t.id as string | undefined,
    title: t.title as string | undefined,
    status: (t.status as string | undefined) ?? "todo",
    target_repo: (t.target_repo as string | null) ?? null,
  }));
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");

  // Close operates only on a fully-done epic; not-all-done is a typed error.
  if (!allDone) {
    const notDone = tasks.filter((t) => t.status !== "done").map((t) => t.id);
    emitPreflightError(
      "TASKS_NOT_DONE",
      `epic ${epicId} is not ready to close — ${notDone.length} task(s) not done`,
      format,
      { not_done: notDone },
    );
  }

  // commit_groups via the in-process native trailer scan; fail loud (nothing
  // written) on an all-repos-broken condition.
  let commitGroups: CommitGroupResult[];
  try {
    commitGroups = findCommitGroups(
      tasks.filter((t) => t.id).map((t) => t.id as string),
      primaryRepo,
      touchedRepos,
      epicId,
    );
  } catch (exc) {
    if (exc instanceof AllReposBrokenError) {
      emitPreflightError(
        "COMMIT_LOOKUP_FAILED",
        "commit-trailer scan found no usable repo: every repo in the scan " +
          "set is missing or not a git repo",
        format,
        { broken_repos: exc.brokenRepos },
      );
    }
    throw exc;
  }
  const commitSetHash = computeCommitSetHash(commitGroups);

  // Depth signals. Per-repo diff stats come from the commit-set numstat; the
  // task / diff-line / touched-repo counts feed the policy that sizes the audit
  // band. Every degrade (numstat git error, missing / malformed policy,
  // unreadable finding artifact) records a reason and forces the band to lean —
  // close-preflight never fails on a depth-signal error.
  const vcs = getVcs();
  const depthReasons: string[] = [];

  const diffStatsByRepo = commitGroups.map((g) => {
    const totals = vcs.commitSetNumstat(g.shas, g.repo);
    if (totals.error) {
      depthReasons.push(`numstat_error:${g.repo}`);
    }
    return {
      repo: g.repo,
      commit_count: g.shas.length,
      insertions: totals.insertions,
      deletions: totals.deletions,
      files: totals.files,
    };
  });

  // Prior per-task finding refs (path + status only) — absent until a per-task
  // audit has persisted one; an unreadable artifact degrades but never fails.
  const findingRefByTask = new Map<string, FindingRef | null>();
  for (const t of mergedTasks) {
    const id = t.id as string | undefined;
    if (id === undefined || id === "") {
      continue;
    }
    const { ref, unreadable } = findingRefFor(primaryRepo, epicId, id);
    findingRefByTask.set(id, ref);
    if (unreadable) {
      depthReasons.push(`finding_ref_unreadable:${id}`);
    }
  }

  const signals: DepthSignals = {
    task_count: tasks.length,
    diff_lines: diffStatsByRepo.reduce(
      (n, s) => n + s.insertions + s.deletions,
      0,
    ),
    touched_repo_count: commitGroups.filter((g) => g.shas.length > 0).length,
  };

  // The band derives from the drift-gated audit-policy.yaml (task-owned config,
  // co-located with model-selector.yaml). An absent policy — the pre-rollout
  // default — degrades to lean by construction.
  const { doc: policyDoc, reason: policyReason } = readAuditPolicyDoc(
    join(planPluginRoot(), "audit-policy.yaml"),
  );
  const derived = deriveDepthBand(signals, policyDoc);
  if (policyReason !== null) {
    depthReasons.push(policyReason);
  }
  depthReasons.push(...derived.reasons);

  const depth = {
    band: (depthReasons.length > 0 ? "lean" : derived.band) as DepthBand,
    signals,
    degraded: depthReasons.length > 0,
    degrade_reasons: depthReasons,
  };

  // Assemble the full brief, then write it atomically + commit-free. The brief
  // carries commit_groups, the ordinal task list (tier + done summary + finding
  // ref), the per-repo diff stats, and the derived depth band; the envelope
  // carries only the handle + hash.
  const brief = {
    schema_version: AUDIT_SCHEMA_VERSION,
    epic_id: epicId,
    primary_repo: primaryRepo,
    touched_repos: touchedRepos ?? null,
    commit_set_hash: commitSetHash,
    commit_groups: commitGroups,
    snippet_context: "",
    tasks: mergedTasks.map((t) => {
      const id = t.id as string | undefined;
      return {
        id,
        title: t.title as string | undefined,
        status: (t.status as string | undefined) ?? "todo",
        target_repo: (t.target_repo as string | null) ?? null,
        tier: (t.tier as string | null) ?? null,
        done_summary: id ? doneSummary(stateCtx.dataDir, id) : "",
        finding_ref: id ? (findingRefByTask.get(id) ?? null) : null,
      };
    }),
    diff_stats_by_repo: diffStatsByRepo,
    depth,
  };
  const briefRef = writeBriefArtifact(primaryRepo, epicId, brief);

  // Claim the close exclusively (guard contract + duplicate-close guard). Writes
  // this session's close marker, then asserts no rival live closer holds the
  // epic — a second concurrent claimant fails loud so it exits instead of
  // re-running the whole audit. Success path only; fail-open on marker IO.
  const lost = claimCloseExclusive(epicId);
  if (lost !== null) {
    emitPreflightError(
      "CLOSE_ALREADY_CLAIMED",
      `epic ${epicId} is already being closed by another live session — ` +
        "resume that closer over the bus rather than starting a second one",
      format,
      { held_by_session: lost.heldBy },
    );
  }

  // Surface an in-flight blocking follow-up (discovered by its committed
  // `blocks_closing_of` pointer, any status) so the close skill can short-circuit
  // past the audit phases on re-entry — a second audit would re-author a divergent
  // verdict and risk a duplicate mint. Null on the ordinary (non-gated) close.
  const gated = findFollowupByBlocksClosingOf(stateCtx.dataDir, epicId);
  const blockingFollowup =
    gated !== null ? { id: gated.epicId, status: gated.status ?? null } : null;

  formatOutput(
    {
      success: true,
      primary_repo: primaryRepo,
      tasks,
      all_done: true,
      brief_ref: briefRef,
      commit_set_hash: commitSetHash,
      blocking_followup: blockingFollowup,
    },
    format,
  );
}

/** click UsageError shape: usage + try-help on stderr, exit 2. */
function usageError(message: string): never {
  process.stderr.write(
    "Usage: keeper plan close-preflight [OPTIONS] EPIC_ID\n",
  );
  process.stderr.write(
    "Try 'keeper plan close-preflight --help' for help.\n\n",
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

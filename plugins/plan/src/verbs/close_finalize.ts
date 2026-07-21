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
// Blocking close-gate: a verdict carrying `blocks_closing:true` routes the
// scaffold branch to followup_blocks_close — the follow-up is minted with the
// source's still-resolving deps substituted (never the source, a cycle) and a
// committed `blocks_closing_of` pointer, but the source epic stays OPEN, holding
// every dependent. A durable minted-marker records the mint. A re-dispatched
// closer re-enters FIRST (before any verdict re-derive): a done follow-up adopts
// into closed_with_followup, an alive one re-emits followup_blocks_close, and a
// deleted-while-gated follow-up (marker but no pointer) is a typed failure.
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

import { randomBytes } from "node:crypto";
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

import { CommitWorkLock } from "../../../../src/commit-work/flock.ts";
import {
  decideTrunkIntegrationFence,
  readTrunkLeaseLeaf,
  TRUNK_LEASE_REQUEST_SCHEMA_VERSION,
  type TrunkLeaseLeaf,
  trunkLeaseIsValid,
  writeTrunkLeaseRequest,
} from "../../../../src/grant-leaf.ts";
import { keeperStateDir } from "../../../../src/keeper-state-dir.ts";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import {
  computeCommitSetHash,
  followupPath,
  readBlockingFollowupMarker,
  reportMetaPath,
  verdictPath,
  writeBlockingFollowupMarker,
} from "../audit_artifacts.ts";
import {
  AllReposBrokenError,
  type CommitGroupResult,
  findCommitGroups,
} from "../commit_lookup.ts";
import { resolveEpicGlobally } from "../discovery.ts";
import { emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { effectiveMatrix } from "../host_matrix.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import {
  contextForRoot,
  type ProjectContext,
  resolveProject,
} from "../project.ts";
import { computeSelectionInputHash } from "../selection_input_hash.ts";
import {
  FOLLOWUP_VERDICT_SCHEMA_VERSION,
  isSparkExclusionReason,
  SELECTION_SCHEMA_VERSION,
  type SelectionSidecar,
  SPARK_MODEL,
  type SparkExclusionReason,
  writeSelectionSidecar,
} from "../selection_sidecar.ts";
import { resolvePlanSessionId } from "../session_id.ts";
import { clearCloseMarker } from "../session_markers.ts";
import { hasDataDir } from "../state_path.ts";
import { loadJsonSafe, nowIso } from "../store.ts";
import { parseYamlInput } from "../yaml_input.ts";
import { runEpicClose } from "./epic_close.ts";
import { runScaffold } from "./scaffold.ts";
import { armEpicValidated } from "./validate.ts";

/** The terminal outcomes the close coordinator switches on. Every member MUST
 * have a /plan:close skill handler — the exhaustiveness test pins it. Mirrors
 * CloseOutcome. `followup_blocks_close` is the sole member that leaves the
 * source epic OPEN after a successful (non-error) run: the blocking follow-up
 * gate holds the close until the follow-up lands. */
export const CLOSE_OUTCOMES = {
  CLOSED_CLEAN: "closed_clean",
  CLOSED_WITH_FOLLOWUP: "closed_with_followup",
  FATAL_HALT: "fatal_halt",
  PARTIAL_FOLLOWUP: "partial_followup",
  FOLLOWUP_BLOCKS_CLOSE: "followup_blocks_close",
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

/** Return the follow-up epic a blocking close-gate minted for sourceEpicId,
 * discovered by its committed `blocks_closing_of === sourceEpicId` pointer in
 * ANY status (open OR done — a done follow-up is what an adopt closes on).
 * Separate from findFollowupEpic so that finder's two open-only, provenance-keyed
 * callers stay byte-identical. First-seen wins via sorted glob. Returns
 * {epicId, status} or null. close-preflight reuses it to surface the in-flight
 * gate so the skill short-circuits the audit phases on re-entry. */
export function findFollowupByBlocksClosingOf(
  dataDir: string,
  sourceEpicId: string,
): { epicId: string; status: string | undefined } | null {
  const epicsDir = join(dataDir, "epics");
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
    if (epDef === null || epDef.blocks_closing_of !== sourceEpicId) {
      continue;
    }
    return {
      epicId: (epDef.id as string | undefined) ?? stem,
      status: epDef.status as string | undefined,
    };
  }
  return null;
}

/** The still-resolving subset of the source epic's epic-deps, canonicalized to
 * their full slug ids — the dep substitution a blocking follow-up inherits so it
 * never depends on the source it gates (a cycle) yet keeps every upstream the
 * source itself waited on. A dep is KEPT iff it resolves to exactly one project
 * (exists, unambiguous — status is irrelevant, matching scaffold's status-blind
 * validator) and is not the source. Dedupes; never the source. */
function substituteGateDeps(
  sourceEpicId: string,
  sourceDeps: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dep of sourceDeps) {
    const res = resolveEpicGlobally(dep);
    if (!res.resolved || res.ambiguous || res.resolvedId === null) {
      continue;
    }
    const id = res.resolvedId;
    if (id === sourceEpicId || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
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
      onCleanCommitFailureRollback: () => clearCloseMarker(epicId),
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
  gate?: { blocksClosingOf: string; dependsOnEpicsOverride: string[] },
): string {
  const { result: rc, output } = runCaptured(ctx.projectPath, () =>
    runScaffold({
      file: followupYamlPath,
      allowDuplicate: false,
      createdByCloseOf: sourceEpicId,
      blocksClosingOf: gate?.blocksClosingOf ?? null,
      dependsOnEpicsOverride: gate?.dependsOnEpicsOverride ?? null,
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

export interface TrunkGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The verdict of running a merge-suite gate against the merged tree in the
 * private scratch worktree (ADR 0102), mirroring the daemon's own
 * `MergeSuiteVerdict`. `green` clears the integration to land; `red` is a
 * semantic-merge breakage (two individually-green sides whose merged tree fails
 * the suite) that aborts the land visibly; `cannot-run` is a gate that could not
 * produce a verdict (install/suite crash/timeout) and DEFERS — never a silent
 * land, never a false red. */
export type MergeSuiteVerdict =
  | { kind: "green" }
  | { kind: "red"; detail: string }
  | { kind: "cannot-run"; detail: string };

/** The result of a bounded lease-acquire request/poll round-trip — a typed
 * value instead of an in-band `emitFinalizeError` exit, so the caller decides
 * which typed error to raise (and a test can inject a deps bundle that never
 * touches process.exit). */
export type TrunkLeaseRequestResult =
  | { ok: true; lease: TrunkLeaseLeaf }
  | { ok: false; reason: "request_failed" | "pending" };

/** The trunk-merge orchestration's pure seam: every git spawn, the commit-work
 * lock, and the lease request/release round-trip the verb performs, bundled
 * behind one injectable object. Production threads {@link
 * realTrunkIntegrationDeps} through every call by default; a saga test injects
 * a fake bundle so `integrateRepoUnderLease` / `integrateEpicBases` run
 * against scripted git + lease responses with zero real git or daemon
 * round-trip. Mirrors the daemon-side `TrunkLeaseSweepDeps` seam. */
export interface TrunkIntegrationDeps {
  git(args: string[], cwd: string): TrunkGitResult;
  acquireLock(repoRoot: string): { release(): void } | null;
  requestLease(
    stateDir: string,
    epicId: string,
    repoRoot: string,
    sourceBranch: string,
    claimantSessionId: string,
    minimumToken: number,
  ): TrunkLeaseRequestResult;
  releaseLease(stateDir: string, lease: TrunkLeaseLeaf): boolean;
  readLeaseLeaf(stateDir: string, repoRoot: string): TrunkLeaseLeaf | null;
  /** OPTIONAL merge-suite gate probe (ADR 0102) run against the merged tree in
   * the private scratch worktree BEFORE the epic lands. `worktreePath` is the
   * scratch checkout holding the merge; `mergedCommit` is its HEAD. Undefined →
   * the plan CLI skips the gate: the AUTHORITATIVE merge-suite gate stays
   * daemon-owned (it re-runs against the same integrated commit the closer
   * produces), so `realTrunkIntegrationDeps` leaves this unset and the saga tests
   * inject a fake to drive the green / red / cannot-run decision deterministically. */
  runMergeSuite?(args: {
    worktreePath: string;
    mergedCommit: string;
  }): MergeSuiteVerdict;
}

function trunkGit(args: string[], cwd: string): TrunkGitResult {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      env,
      timeout: 30_000,
    });
    return {
      code: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function waitBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireTrunkLock(repoRoot: string): CommitWorkLock | null {
  const gitDir = trunkGit(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    repoRoot,
  );
  const path =
    gitDir.code === 0 && gitDir.stdout.trim() !== ""
      ? join(gitDir.stdout.trim(), "keeper-commit-work.lock")
      : join(repoRoot, ".git", "keeper-commit-work.lock");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lock = CommitWorkLock.tryAcquire(path);
    if (lock !== null) return lock;
    waitBriefly(50);
  }
  return null;
}

function requestTrunkLease(
  stateDir: string,
  epicId: string,
  repoRoot: string,
  sourceBranch: string,
  claimantSessionId: string,
  minimumToken: number,
): TrunkLeaseRequestResult {
  const requestId = randomBytes(16).toString("hex");
  const requested = writeTrunkLeaseRequest(stateDir, {
    schema_version: TRUNK_LEASE_REQUEST_SCHEMA_VERSION,
    action: "acquire",
    epic_id: epicId,
    repo_root: repoRoot,
    source_branch: sourceBranch,
    claimant_session_id: claimantSessionId,
    request_id: requestId,
    fencing_token: null,
    requested_at: Date.now(),
  });
  if (requested === null) {
    return { ok: false, reason: "request_failed" };
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const leaf = readTrunkLeaseLeaf(stateDir, repoRoot);
    if (
      leaf !== null &&
      leaf.fencing_token >= minimumToken &&
      leaf.acquisition_id === requestId &&
      trunkLeaseIsValid(
        leaf,
        {
          epicId,
          repoRoot,
          sourceBranch,
          claimantSessionId,
        },
        Date.now(),
      )
    ) {
      return { ok: true, lease: leaf };
    }
    waitBriefly(100);
  }
  return { ok: false, reason: "pending" };
}

function releaseTrunkLease(stateDir: string, lease: TrunkLeaseLeaf): boolean {
  const requested = writeTrunkLeaseRequest(stateDir, {
    schema_version: TRUNK_LEASE_REQUEST_SCHEMA_VERSION,
    action: "release",
    epic_id: lease.epic_id,
    repo_root: lease.repo_root,
    source_branch: lease.source_branch,
    claimant_session_id: lease.claimant_session_id,
    request_id: randomBytes(16).toString("hex"),
    fencing_token: lease.fencing_token,
    requested_at: Date.now(),
  });
  if (requested === null) return false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = readTrunkLeaseLeaf(stateDir, lease.repo_root);
    if (
      current !== null &&
      (current.fencing_token !== lease.fencing_token || !current.active)
    ) {
      return true;
    }
    waitBriefly(100);
  }
  return false;
}

/** Production wiring for {@link TrunkIntegrationDeps} — verbatim git spawns,
 * the real flock-backed commit-work lock, and the real daemon-mediated lease
 * request/release round-trip. Every trunk-merge call site defaults to this;
 * a saga test overrides it with a fake bundle. `runMergeSuite` is deliberately
 * unset: the AUTHORITATIVE merge-suite gate stays daemon-owned (it re-runs
 * against the same integrated commit the closer publishes), so the plan CLI
 * relocates the merge into a private worktree without shelling a heavyweight
 * suite of its own — the saga tests inject a fake gate to drive the decision. */
const realTrunkIntegrationDeps: TrunkIntegrationDeps = {
  git: trunkGit,
  acquireLock: acquireTrunkLock,
  requestLease: requestTrunkLease,
  releaseLease: releaseTrunkLease,
  readLeaseLeaf: readTrunkLeaseLeaf,
};

function ancestryProbe(
  repoRoot: string,
  sourceBranch: string,
  defaultBranch: string,
  deps: TrunkIntegrationDeps,
): "ancestor" | "not-ancestor" | "inconclusive" {
  const probe = deps.git(
    ["merge-base", "--is-ancestor", sourceBranch, defaultBranch],
    repoRoot,
  );
  return probe.code === 0
    ? "ancestor"
    : probe.code === 1
      ? "not-ancestor"
      : "inconclusive";
}

/** Reconciles the ancestor re-grade path with the SKILL.md recovery contract
 * (Phase 4: "its integration grade adopts and releases the still-live trunk
 * lease before close"). A prior attempt may have conflicted mid-merge,
 * retained its fenced lease (TRUNK_INTEGRATION_CONFLICT), and then been
 * resolved out-of-band (the deconflict/merge-resolver path lands the merge
 * directly against the checkout) — a re-grade here reads "ancestor" with that
 * ORIGINAL lease still active. Adopting means releasing it under the SAME
 * claimant identity that acquired it (this closer's own session, re-entering
 * finalize per the Phase 4 recovery contract), never a fresh acquire. A leaf
 * absent, expired, or held by a different claimant/epic/branch is left alone.
 * Best-effort: a release failure here is never fatal — the daemon's
 * claimant-death reclaim remains the fallback once the lease's TTL or
 * claimant liveness lapses. */
function adoptLingeringLease(
  stateDir: string,
  epicId: string,
  repoRoot: string,
  sourceBranch: string,
  claimantSessionId: string,
  deps: TrunkIntegrationDeps,
): void {
  const leaf = deps.readLeaseLeaf(stateDir, repoRoot);
  if (leaf === null) {
    return;
  }
  if (
    !trunkLeaseIsValid(
      leaf,
      { epicId, repoRoot, sourceBranch, claimantSessionId },
      Date.now(),
    )
  ) {
    return;
  }
  deps.releaseLease(stateDir, leaf);
}

/** The private scratch worktree + temp branch one lease attempt cuts from the
 * local default tip: the epic base merges HERE, never in the shared checkout, so
 * the shared checkout is only ever fast-forwarded and no `MERGE_HEAD` is ever
 * visible in it (ADR 0102). Keyed on the epic + a random suffix so a retried or
 * concurrent attempt never collides; reaped on EVERY exit path. */
interface TrunkScratch {
  path: string;
  branch: string;
}

function trunkScratchFor(epicId: string): TrunkScratch {
  const token = randomBytes(8).toString("hex");
  const slug = epicId.replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    path: join(tmpdir(), `keeper-trunk-integrate-${slug}-${token}`),
    branch: `keeper/trunk-integrate/${slug}-${token}`,
  };
}

/** Best-effort teardown of the scratch worktree + temp branch — run on EVERY exit
 * path (success, conflict, gate-red, publish-fail, drift) so an integration attempt
 * never leaks a worktree or branch. Each step ignores its own result; a leftover
 * admin husk is swept by the trailing prune. `--force` clears a scratch tree left
 * dirty or mid-merge (the conflict path). */
function reapTrunkScratch(
  deps: TrunkIntegrationDeps,
  repoRoot: string,
  scratch: TrunkScratch,
): void {
  deps.git(["worktree", "remove", "--force", scratch.path], repoRoot);
  deps.git(["branch", "-D", scratch.branch], repoRoot);
  deps.git(["worktree", "prune"], repoRoot);
}

/** Cut the private scratch worktree at the leased default tip on a fresh temp
 * branch. Reaps any stale residue first (a crashed prior attempt) so the add never
 * collides. Returns a typed failure the caller defers on rather than throwing. */
function provisionTrunkScratch(
  deps: TrunkIntegrationDeps,
  repoRoot: string,
  scratch: TrunkScratch,
  baseOid: string,
): { ok: true } | { ok: false; detail: string } {
  reapTrunkScratch(deps, repoRoot, scratch);
  const add = deps.git(
    ["worktree", "add", "-b", scratch.branch, scratch.path, baseOid],
    repoRoot,
  );
  if (add.code !== 0) {
    reapTrunkScratch(deps, repoRoot, scratch);
    return { ok: false, detail: (add.stdout + add.stderr).trim() };
  }
  return { ok: true };
}

export function integrateRepoUnderLease(
  epicId: string,
  repoRoot: string,
  sourceBranch: string,
  claimantSessionId: string,
  format: OutputFormat | null,
  deps: TrunkIntegrationDeps = realTrunkIntegrationDeps,
): void {
  const stateDir = keeperStateDir();
  let minimumToken = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requested = deps.requestLease(
      stateDir,
      epicId,
      repoRoot,
      sourceBranch,
      claimantSessionId,
      minimumToken,
    );
    if (!requested.ok) {
      if (requested.reason === "request_failed") {
        emitFinalizeError(
          "TRUNK_LEASE_REQUEST_FAILED",
          `could not publish the trunk-integration lease request for ${repoRoot}`,
          format,
          { repo_root: repoRoot },
        );
      }
      emitFinalizeError(
        "TRUNK_LEASE_PENDING",
        `the trunk-integration lease for ${repoRoot} was not published before the bounded wait expired; release any live holder and re-run /plan:close ${epicId}`,
        format,
        { repo_root: repoRoot },
      );
    }
    const lease = requested.lease;
    const releaseOrFail = (): void => {
      if (!deps.releaseLease(stateDir, lease)) {
        emitFinalizeError(
          "TRUNK_LEASE_RELEASE_FAILED",
          `the daemon did not acknowledge release of trunk lease ${lease.fencing_token} for ${repoRoot}; no successor may integrate until claimant death is observed`,
          format,
          { repo_root: repoRoot, fencing_token: lease.fencing_token },
        );
      }
    };

    const lock = deps.acquireLock(repoRoot);
    if (lock === null) {
      releaseOrFail();
      emitFinalizeError(
        "TRUNK_INTEGRATION_LOCK_TIMEOUT",
        `the commit-work lock for ${repoRoot} stayed occupied through the bounded deadline; no merge was attempted`,
        format,
        { repo_root: repoRoot, fencing_token: lease.fencing_token },
      );
    }
    // ADR 0102: the epic base merges in a PRIVATE scratch worktree cut from the
    // leased default tip, never in the shared checkout. Unrelated dirt or an
    // off-branch shared checkout no longer BLOCKS integration — the any-dirt
    // TRUNK_INTEGRATION_DIRTY refusal, the off-branch refusal, and the shared-
    // checkout MERGE_HEAD residue check all retire — and no MERGE_HEAD is ever
    // visible in the shared checkout. The shared checkout is only ever
    // fast-forwarded, and only when it is clean AND on the default branch.
    const sourceTip = deps.git(
      ["rev-parse", "--verify", `refs/heads/${sourceBranch}^{commit}`],
      repoRoot,
    );
    const sourceOid = sourceTip.stdout.trim();
    if (sourceTip.code !== 0 || !/^[0-9a-f]{7,64}$/.test(sourceOid)) {
      lock.release();
      releaseOrFail();
      emitFinalizeError(
        "TRUNK_INTEGRATION_DEFERRED",
        `the in-fence source tip for ${sourceBranch} could not be resolved; no merge was attempted`,
        format,
        { repo_root: repoRoot, fencing_token: lease.fencing_token },
      );
    }
    const liveTip = deps.git(
      ["rev-parse", "--verify", `refs/heads/${lease.default_branch}^{commit}`],
      repoRoot,
    );
    const liveOid = liveTip.stdout.trim();
    const reprobe = ancestryProbe(
      repoRoot,
      sourceBranch,
      lease.default_branch,
      deps,
    );
    const fence = deps.readLeaseLeaf(stateDir, repoRoot);
    const decision = decideTrunkIntegrationFence({
      leaseValid:
        fence !== null &&
        trunkLeaseIsValid(
          fence,
          {
            epicId,
            repoRoot,
            sourceBranch,
            claimantSessionId,
            fencingToken: lease.fencing_token,
          },
          Date.now(),
        ),
      ancestry: reprobe,
      observedDefaultTip: lease.observed_default_tip,
      liveDefaultTip: liveTip.code === 0 ? liveOid : null,
    });
    if (decision.kind === "already-integrated") {
      lock.release();
      releaseOrFail();
      return;
    }
    if (decision.kind === "defer") {
      lock.release();
      releaseOrFail();
      if (decision.reason === "ancestry-inconclusive") {
        emitFinalizeError(
          "TRUNK_INTEGRATION_DEFERRED",
          `the in-fence ancestry re-probe for ${sourceBranch} and ${lease.default_branch} was inconclusive; no merge was attempted`,
          format,
          { repo_root: repoRoot, fencing_token: lease.fencing_token },
        );
      }
      minimumToken = lease.fencing_token + 1;
      waitBriefly(150);
      continue;
    }

    // Cut the private scratch worktree at the leased default tip and merge the epic
    // base THERE — reaped on EVERY exit path below (success, conflict, gate-red,
    // drift), so an attempt never leaks a worktree or branch.
    const scratch = trunkScratchFor(epicId);
    const provisioned = provisionTrunkScratch(deps, repoRoot, scratch, liveOid);
    if (!provisioned.ok) {
      lock.release();
      releaseOrFail();
      emitFinalizeError(
        "TRUNK_INTEGRATION_DEFERRED",
        `could not provision a scratch worktree at ${lease.default_branch} (${liveOid}) in ${repoRoot}: ${provisioned.detail}; no merge was attempted`,
        format,
        { repo_root: repoRoot, fencing_token: lease.fencing_token },
      );
    }

    const merged = deps.git(["merge", "--no-edit", sourceOid], scratch.path);
    if (merged.code !== 0) {
      const conflictHead = deps.git(
        ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
        scratch.path,
      );
      const conflicts = deps.git(
        ["diff", "--name-only", "--diff-filter=U"],
        scratch.path,
      );
      const conflicted =
        conflictHead.code === 0 && conflictHead.stdout.trim() !== "";
      const mergeHeadOid = conflictHead.stdout.trim();
      const conflictedFiles = conflicts.stdout
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      // Reap the conflicted scratch worktree (its MERGE_HEAD never touches the
      // shared checkout) BEFORE surfacing the typed receipt.
      reapTrunkScratch(deps, repoRoot, scratch);
      if (conflicted) {
        // Preserve the existing conflict outcome: the closer RETAINS its fenced
        // lease (no release) so the downstream worktree-merge-conflict resolver /
        // plan:deconflicter path owns resolution while this closer stays the live
        // trunk owner.
        lock.release();
        emitFinalizeError(
          "TRUNK_INTEGRATION_CONFLICT",
          `merging ${sourceBranch} into ${lease.default_branch} conflicted under trunk lease ${lease.fencing_token}; route the typed receipt through plan:deconflicter`,
          format,
          {
            repo_root: repoRoot,
            source_branch: sourceBranch,
            default_branch: lease.default_branch,
            fencing_token: lease.fencing_token,
            merge_head: mergeHeadOid,
            conflicted_files: conflictedFiles,
          },
        );
      }
      lock.release();
      releaseOrFail();
      emitFinalizeError(
        "TRUNK_INTEGRATION_FAILED",
        `git merge failed without merge residue in the scratch worktree for ${repoRoot}: ${(merged.stdout + merged.stderr).trim()}`,
        format,
        { repo_root: repoRoot, fencing_token: lease.fencing_token },
      );
    }
    const mergedCommit = deps
      .git(["rev-parse", "HEAD"], scratch.path)
      .stdout.trim();
    // Objective containment: git merge reported success, but prove the source tip
    // is actually contained in the merged HEAD before landing anything.
    const contained = deps.git(
      ["merge-base", "--is-ancestor", sourceOid, "HEAD"],
      scratch.path,
    );
    if (contained.code !== 0) {
      reapTrunkScratch(deps, repoRoot, scratch);
      lock.release();
      releaseOrFail();
      emitFinalizeError(
        "TRUNK_INTEGRATION_UNVERIFIED",
        `git merge returned success but ${sourceBranch} is not provably contained in the merged tree; teardown remains fenced off`,
        format,
        { repo_root: repoRoot, fencing_token: lease.fencing_token },
      );
    }

    // Merge-suite gate (ADR 0102): run the injected gate against the MERGED tree in
    // the scratch worktree. red aborts the land visibly; cannot-run DEFERS; a
    // missing probe means the authoritative gate is daemon-owned (see the dep doc).
    if (deps.runMergeSuite !== undefined) {
      const verdict = deps.runMergeSuite({
        worktreePath: scratch.path,
        mergedCommit,
      });
      if (verdict.kind === "red") {
        reapTrunkScratch(deps, repoRoot, scratch);
        lock.release();
        releaseOrFail();
        emitFinalizeError(
          "TRUNK_INTEGRATION_SUITE_RED",
          `the merge-suite gate failed against the merged tree for ${epicId} in ${repoRoot} (merged commit ${mergedCommit}): ${verdict.detail}`,
          format,
          {
            repo_root: repoRoot,
            fencing_token: lease.fencing_token,
            merged_commit: mergedCommit,
          },
        );
      }
      if (verdict.kind === "cannot-run") {
        reapTrunkScratch(deps, repoRoot, scratch);
        lock.release();
        releaseOrFail();
        emitFinalizeError(
          "TRUNK_INTEGRATION_DEFERRED",
          `the merge-suite gate could not run against the merged tree for ${epicId} in ${repoRoot} (${verdict.detail}); no merge was landed`,
          format,
          { repo_root: repoRoot, fencing_token: lease.fencing_token },
        );
      }
    }

    // Publish the merge to the LOCAL default branch. The shared checkout is only
    // ever fast-forwarded, and only when it is clean AND on the default branch;
    // otherwise ONLY the fast-forward is deferred — the ref still advances so the
    // epic lands, and the trailing shared checkout is left to the existing
    // shared-checkout-desync producer (a visible, self-clearing signal), never a
    // refusal of the whole integration.
    const sharedHead = deps.git(["symbolic-ref", "--short", "HEAD"], repoRoot);
    const onDefault =
      sharedHead.code === 0 &&
      sharedHead.stdout.trim() === lease.default_branch;
    const sharedDirty = deps.git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      repoRoot,
    );
    const sharedClean =
      sharedDirty.code === 0 && sharedDirty.stdout.trim() === "";
    if (onDefault && sharedClean) {
      // Clean, on-branch shared checkout: fast-forward it (ref + working tree) to
      // the merged commit exactly as before.
      const ff = deps.git(["merge", "--ff-only", mergedCommit], repoRoot);
      if (ff.code !== 0) {
        // The default drifted out from under the fence between the tip read and the
        // fast-forward; reap and retry from a fresh tip.
        reapTrunkScratch(deps, repoRoot, scratch);
        lock.release();
        releaseOrFail();
        minimumToken = lease.fencing_token + 1;
        waitBriefly(150);
        continue;
      }
    } else {
      // Dirty or off-branch shared checkout: DEFER ONLY THE FF. Advance the default
      // ref (compare-and-swap against the leased tip) so the merge lands locally,
      // leaving the working tree trailing for the shared-checkout-desync producer.
      const advance = deps.git(
        [
          "update-ref",
          `refs/heads/${lease.default_branch}`,
          mergedCommit,
          liveOid,
        ],
        repoRoot,
      );
      if (advance.code !== 0) {
        // A concurrent local advance won the CAS (the default moved under the
        // fence); reap and retry from a fresh tip.
        reapTrunkScratch(deps, repoRoot, scratch);
        lock.release();
        releaseOrFail();
        minimumToken = lease.fencing_token + 1;
        waitBriefly(150);
        continue;
      }
    }

    reapTrunkScratch(deps, repoRoot, scratch);
    lock.release();
    releaseOrFail();
    return;
  }
  emitFinalizeError(
    "TRUNK_TIP_DRIFT",
    `${repoRoot} default advanced during three independently fenced lease attempts; no stale merge was attempted`,
    format,
    { repo_root: repoRoot },
  );
}

function resolveTrunkDefaultBranch(
  repoRoot: string,
  deps: TrunkIntegrationDeps,
): string | null {
  const symbolic = deps.git(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    repoRoot,
  );
  const fromOrigin =
    symbolic.code === 0 ? symbolic.stdout.trim().replace(/^origin\//, "") : "";
  if (fromOrigin !== "") return fromOrigin;
  for (const candidate of ["main", "master", "trunk"]) {
    if (
      deps.git(
        ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
        repoRoot,
      ).code === 0
    ) {
      return candidate;
    }
  }
  return null;
}

export function integrateEpicBases(
  epicId: string,
  primaryRepo: string,
  touchedRepos: string[] | null | undefined,
  format: OutputFormat | null,
  deps: TrunkIntegrationDeps = realTrunkIntegrationDeps,
): void {
  if ((process.env.KEEPER_PLAN_WORKTREE ?? "").trim() === "") return;
  const claimantSessionId = resolvePlanSessionId();
  if (claimantSessionId === null) {
    emitFinalizeError(
      "TRUNK_LEASE_IDENTITY_MISSING",
      `worktree close for ${epicId} has no tracked session identity; refusing ownerless trunk integration`,
      format,
    );
  }
  const stateDir = keeperStateDir();
  const sourceBranch = `keeper/epic/${epicId}`;
  const repos = new Set<string>([primaryRepo]);
  for (const repo of touchedRepos ?? []) {
    try {
      repos.add(realpathOr(repo));
    } catch {
      // The source probe below owns the typed defer for a usable repo.
    }
  }
  for (const repoRoot of [...repos].sort()) {
    const toplevel = deps.git(["rev-parse", "--show-toplevel"], repoRoot);
    const observedRoot = toplevel.stdout.trim();
    if (
      toplevel.code !== 0 ||
      observedRoot === "" ||
      realpathOr(observedRoot) !== repoRoot
    ) {
      emitFinalizeError(
        "TRUNK_INTEGRATION_DEFERRED",
        `could not verify ${repoRoot} as an available git checkout; refusing to grade its epic base as absent`,
        format,
        { repo_root: repoRoot },
      );
    }
    const source = deps.git(
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${sourceBranch}^{commit}`,
      ],
      repoRoot,
    );
    if (source.code === 1) continue;
    if (source.code !== 0) {
      emitFinalizeError(
        "TRUNK_INTEGRATION_DEFERRED",
        `could not resolve ${sourceBranch} in ${repoRoot}; no trunk lease was acquired`,
        format,
        { repo_root: repoRoot },
      );
    }
    const defaultBranch = resolveTrunkDefaultBranch(repoRoot, deps);
    if (defaultBranch === null) {
      emitFinalizeError(
        "TRUNK_INTEGRATION_DEFERRED",
        `could not resolve the local default branch in ${repoRoot}; no trunk lease was acquired`,
        format,
        { repo_root: repoRoot },
      );
    }
    const grade = ancestryProbe(repoRoot, sourceBranch, defaultBranch, deps);
    if (grade === "ancestor") {
      // Phase 4's recovery contract (SKILL.md): a conflicted attempt that
      // retained its fenced lease and was later resolved out-of-band leaves
      // this re-grade reading "ancestor" with that lease still active —
      // adopt and release it here rather than leaving it for daemon
      // claimant-death reclaim.
      adoptLingeringLease(
        stateDir,
        epicId,
        repoRoot,
        sourceBranch,
        claimantSessionId,
        deps,
      );
      continue;
    }
    if (grade === "inconclusive") {
      emitFinalizeError(
        "TRUNK_INTEGRATION_DEFERRED",
        `could not grade ${sourceBranch} against ${defaultBranch} in ${repoRoot}; no trunk lease was acquired`,
        format,
        { repo_root: repoRoot },
      );
    }
    integrateRepoUnderLease(
      epicId,
      repoRoot,
      sourceBranch,
      claimantSessionId,
      format,
      deps,
    );
  }
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

  // 3.5 Blocking close-gate RE-ENTRY — runs BEFORE any verdict/audit machinery
  //     so a re-dispatched closer never re-derives (and cannot re-scaffold) a
  //     live gate. Discovery rides the committed `blocks_closing_of` pointer
  //     (authoritative, any status); the durable minted-marker only disambiguates
  //     the no-pointer case. Reached only while the source stays OPEN, which the
  //     gate holds it — a non-blocking close carries neither pointer nor marker
  //     and falls straight through.
  const gatedFollowup = findFollowupByBlocksClosingOf(stateCtx.dataDir, epicId);
  if (gatedFollowup !== null) {
    if (gatedFollowup.status === "done") {
      // The follow-up landed — adopt it and close the source (the ordinary
      // closed_with_followup terminal).
      integrateEpicBases(epicId, primaryRepo, touchedRepos, format);
      closeEpic(stateCtx, epicId);
      emitOutcome(
        CLOSE_OUTCOMES.CLOSED_WITH_FOLLOWUP,
        epicId,
        ctx,
        format,
        stateCtx,
        { newEpicId: gatedFollowup.epicId },
      );
      return;
    }
    // Alive but not done — re-emit the gate outcome idempotently (no re-scaffold),
    // leaving the source open.
    emitOutcome(
      CLOSE_OUTCOMES.FOLLOWUP_BLOCKS_CLOSE,
      epicId,
      ctx,
      format,
      stateCtx,
      { newEpicId: gatedFollowup.epicId },
    );
    return;
  }
  const blockingMarker = readBlockingFollowupMarker(primaryRepo, epicId);
  if (blockingMarker !== null) {
    // A mint happened (marker present) but the pointer resolves to nothing — the
    // follow-up was deleted while gating. NEVER an implicit close, never a blind
    // re-scaffold: a typed failure surfaced through the sticky dispatch-failure
    // needs-human machinery (a failed close dispatch stays parked and visible).
    emitFinalizeError(
      "BLOCKING_FOLLOWUP_DELETED",
      `the blocking follow-up ${
        blockingMarker.followupEpicId || "(id unrecorded)"
      } minted for ${epicId} no longer exists — it was deleted while gating the ` +
        "source close. Restore or re-plan the follow-up (the source epic stays " +
        "open); close-finalize refuses to close against a vanished gate.",
      format,
      { minted_followup_id: blockingMarker.followupEpicId },
    );
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

  // A strict-true blocking decision routes the surviving-findings scaffold down
  // the gate branch (mint but do NOT close). Anything else — absent, false, or a
  // non-boolean the submit verb would have rejected anyway — is legacy
  // non-blocking. The re-entry above already handled a gate that was minted on a
  // prior pass, so reaching here with a true flag is a FIRST pass.
  const blockingDecision = verdict.blocks_closing === true;

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
    integrateEpicBases(epicId, primaryRepo, touchedRepos, format);
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
      integrateEpicBases(epicId, primaryRepo, touchedRepos, format);
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
  // On a blocking first pass the follow-up must never depend on the source it
  // gates (a cycle). Substitute the source's still-resolving epic-deps and stamp
  // the `blocks_closing_of` pointer — both ride scaffold's SAME internal-arg path
  // createdByCloseOf uses, so pointer and epic land atomically in the one scaffold
  // commit. Computed before the scaffold so a substitution failure never leaves a
  // half-minted tree.
  const gate = blockingDecision
    ? {
        blocksClosingOf: epicId,
        dependsOnEpicsOverride: substituteGateDeps(
          epicId,
          (epicDef.depends_on_epics as string[] | undefined) ?? [],
        ),
      }
    : undefined;
  let newEpicId: string;
  try {
    newEpicId = scaffoldFollowup(stateCtx, scaffoldFile, epicId, format, gate);
  } finally {
    if (mergedFile !== null) {
      unlinkQuiet(mergedFile);
    }
  }

  // Sidecar BEFORE the terminal: its atomic write records the touched path, and
  // the next auto-commit (epic close on the non-blocking path, the follow-up arm
  // on the gate path) sweeps the (dirty) top-level selections/ file — finalize
  // itself draws no commit.
  writeCloseSelectionSidecar(stateCtx.dataDir, newEpicId, selection);

  if (blockingDecision) {
    // Blocking gate: persist the durable minted-marker AFTER a successful
    // scaffold (so it never claims a mint that did not land — this is what later
    // distinguishes an adopt from a deleted follow-up), then terminate WITHOUT
    // closing the source. emitOutcome arms the follow-up and releases the
    // close-exclusive claim exactly as the closing outcomes do — without the
    // release the re-dispatched closer would die on the claim.
    writeBlockingFollowupMarker(primaryRepo, epicId, newEpicId);
    emitOutcome(
      CLOSE_OUTCOMES.FOLLOWUP_BLOCKS_CLOSE,
      epicId,
      ctx,
      format,
      stateCtx,
      { newEpicId },
    );
    return;
  }

  integrateEpicBases(epicId, primaryRepo, touchedRepos, format);
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

  // Arm the follow-up at the single terminal chokepoint. A follow-up epic is
  // dispatchable only once its validation marker flips null→timestamp; this
  // covers every path that mints or adopts one — a closed_with_followup fresh
  // scaffold, both crash-resume adopt paths, AND a followup_blocks_close gate
  // (armed so an armed-mode board cannot wedge waiting on it) — and deliberately
  // EXCLUDES partial_followup (a half-built tree must stay a non-dispatchable
  // ghost). The seam is idempotent, so a re-emit re-arming an already-armed
  // follow-up is a no-op. State routes through stateCtx (the primary repo): in
  // worktree mode the follow-up lives there, not in the cwd lane. An arm failure
  // folds INTO this envelope (surfaced verbatim) rather than hard-exiting — the
  // dashed ghost is swept by the next .keeper/ commit.
  if (
    (outcome === CLOSE_OUTCOMES.CLOSED_WITH_FOLLOWUP ||
      outcome === CLOSE_OUTCOMES.FOLLOWUP_BLOCKS_CLOSE) &&
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
  rationale: string;
  confidence: number;
  sparkFit: boolean;
  sparkExclusion: SparkExclusionReason | null;
}

/** The selector's own provenance block, shape-mirroring the sidecar's. */
interface SelectionProvenance {
  selector: { harness: string; model: string };
  configHash: string;
  inputHash: string;
  shuffleSeed: number | null;
  outcome: string;
  verdictRaw: string | null;
  sparkAxisPresent: boolean;
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
  const followupHash = computeSelectionInputHash(followupText);
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
  if (typeof sv !== "number" || !Number.isInteger(sv)) {
    return degrade("verdict-schema-invalid");
  }
  if (sv < FOLLOWUP_VERDICT_SCHEMA_VERSION) {
    return degrade("verdict-schema-legacy");
  }
  if (sv > FOLLOWUP_VERDICT_SCHEMA_VERSION) {
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
  if (provenance.inputHash !== followupHash) {
    return degrade("verdict-input-hash-mismatch");
  }
  if (taskCount === null) {
    return degrade("followup-unparseable");
  }

  const effective = effectiveMatrix();
  const models = effective.models;
  const sparkAxisPresent = provenance.sparkAxisPresent;
  const cells = new Map<number, VerdictCell>();
  const allowedCellKeys = new Set([
    "tier",
    "model",
    "rationale",
    "confidence",
    "spark_fit",
    "spark_exclusion",
  ]);
  for (const [key, raw] of Object.entries(parsed.cells)) {
    if (!/^[1-9][0-9]*$/.test(key)) {
      return degrade("verdict-cell-key-invalid");
    }
    if (!isPlainObject(raw)) {
      return degrade("verdict-cell-not-object");
    }
    for (const rawKey of Object.keys(raw)) {
      if (!allowedCellKeys.has(rawKey)) {
        return degrade("verdict-cell-shape-invalid");
      }
    }
    for (const requiredKey of allowedCellKeys) {
      if (!(requiredKey in raw)) {
        return degrade("verdict-cell-shape-invalid");
      }
    }
    const tier = raw.tier;
    const model = raw.model;
    if (typeof model !== "string" || !models.includes(model)) {
      return degrade("verdict-cell-out-of-axis");
    }
    if (
      typeof tier !== "string" ||
      !effective.effortsFor(model).includes(tier)
    ) {
      return degrade("verdict-cell-out-of-axis");
    }
    const rationale = raw.rationale;
    if (typeof rationale !== "string" || rationale.trim() === "") {
      return degrade("verdict-cell-shape-invalid");
    }
    const confidence = raw.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return degrade("verdict-cell-shape-invalid");
    }
    const sparkFit = raw.spark_fit;
    if (typeof sparkFit !== "boolean") {
      return degrade("verdict-cell-shape-invalid");
    }
    const sparkExclusionRaw = raw.spark_exclusion;
    let sparkExclusion: SparkExclusionReason | null = null;
    if (sparkExclusionRaw !== null) {
      if (!isSparkExclusionReason(sparkExclusionRaw)) {
        return degrade("verdict-cell-shape-invalid");
      }
      sparkExclusion = sparkExclusionRaw;
    }
    if (model === SPARK_MODEL) {
      if (sparkFit !== true || sparkExclusion !== null) {
        return degrade("verdict-cell-spark-inconsistent");
      }
    } else if (sparkFit !== false || sparkExclusion === null) {
      return degrade("verdict-cell-spark-inconsistent");
    }
    if (!sparkAxisPresent) {
      if (sparkFit !== false || sparkExclusion !== "spark-not-on-axis") {
        return degrade("verdict-cell-spark-axis-mismatch");
      }
    } else if (
      model !== SPARK_MODEL &&
      sparkExclusion === "spark-not-on-axis"
    ) {
      return degrade("verdict-cell-spark-axis-mismatch");
    }
    cells.set(Number.parseInt(key, 10), {
      tier,
      model,
      rationale,
      confidence,
      sparkFit,
      sparkExclusion,
    });
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
 * or absent; verdict_raw a string or absent; spark_axis_present a required
 * boolean. Returns null on any violation. */
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
  const sap = sel.spark_axis_present;
  if (typeof sap !== "boolean") {
    return null;
  }
  const sparkAxisPresent = sap;
  return {
    selector: { harness, model },
    configHash,
    inputHash,
    shuffleSeed,
    outcome,
    verdictRaw,
    sparkAxisPresent,
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
          spark_fit: c?.sparkFit ?? null,
          spark_exclusion: c?.sparkExclusion ?? null,
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
        spark_fit: null,
        spark_exclusion: null,
        label_source: "heuristic-default",
      })),
    };
  }
  writeSelectionSidecar(dataDir, sidecar);
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

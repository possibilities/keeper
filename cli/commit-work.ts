#!/usr/bin/env bun

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { CommitWorkLock } from "../src/commit-work/flock";
import {
  GIT_LOCAL_TIMEOUT_MS,
  type GitRunner,
  gitExec,
} from "../src/commit-work/git-exec";
import {
  IdentityConflictError,
  InvalidIdentityError,
  resolveInvocationIdentity,
} from "../src/commit-work/identity";
import { LintFailure, runScopedLint } from "../src/commit-work/lint-matrix";
import {
  classifyFrozenHeadAdvance,
  cleanupPrivateIndex,
  commitFrozenPrivateIndex,
  createFrozenPrivateIndex,
  exactEntriesFromTree,
  type FrozenPrivateIndex,
  MAX_COMMIT_MESSAGE_BYTES,
  PrivateIndexError,
  type PrivateIndexFs,
  privateIndexGit,
  reconcileAmbientAfterPublication,
  reconcileAmbientIndexEntries,
  refreshFrozenPublicationBaseline,
  sameFrozenSelectedIdentity,
  verifyFrozenPublicationBaseline,
  verifyFrozenSurface,
} from "../src/commit-work/private-index";
import {
  invocationDescendsFrom,
  type ProcessIdentityReader,
} from "../src/commit-work/process-identity";
import { pushExactCommit } from "../src/commit-work/push";
import {
  analyzeReversionSweep,
  detectInProgressOperation,
  type InProgressOperation,
  isMassReversion,
  type SharedCheckoutJam,
  sharedCheckoutJam,
} from "../src/commit-work/repo-state";
import {
  type ClaimLiveness,
  type CommitWorkSurfaceSummary,
  claimIsExclusiveOwnership,
  type DirectSurfaceEvidence,
  discoverCommitWorkSurface,
  type OwnershipClaim,
  type SurfaceDiscoveryDeps,
  type SurfaceDiscoveryResult,
  summarizeReceiptLag,
  unsafeForeignSessions,
} from "../src/commit-work/surface";
import { emitCommitWorkOutcome } from "../src/commit-work/telemetry";
import { defaultDbPath, openDb } from "../src/db";
import { parsePlanRef } from "../src/derivers";

const HELP = `keeper commit-work [MSG] [options]

Commit exact work selected by ownership or explicit invocation-local adoption.
Preview explains the complete dirty surface. Attribution gaps are covered with
explicit, invocation-local adoption; adoption never creates a durable claim.

Options:
  --session-id <uuid>  Tracked harness identity (carrier + process ancestry required)
  --adopt <path>       Adopt one exact dirty path; repeat for multiple paths
  --adopt-from <file>  Read paths from a versioned JSON adoption manifest
  --message-file <file>
                       Read the commit message without shell interpolation
  --task-id <task>     Append the active work job's bound Task trailer
  --preview-files      Emit an advisory surface envelope; make no commit
  --max-files <n>      Refuse a selected set larger than n (default 500; 0 disables)
  --allow-stale-unstage
                       Unstage ambient paths outside the selected set
  --override-jam       Proceed past a shared-checkout jam
  --allow-mass-reversion
                       Proceed past an intentional bulk reversion
  --help, -h           Show this help

A coverage gap is resolved by re-running with --adopt <path>, or by passing a
manifest shaped {"schema_version":1,"kind":"commit-work-adoption","paths":[...]}.
Lint failures are fixed in the live worktree and retried through commit-work;
never bypass hooks or use --no-verify.
`;

const AGENT_HELP = `keeper commit-work — operator runbook

Run --preview-files first. Automatic selection is attribution-backed; add an
exact missing dirty path with repeatable --adopt <path> or a versioned
--adopt-from manifest. Adoption is local to this invocation and refuses a live
foreign owner. Fix lint failures in the live worktree and re-run the same
command. Commit hooks and signing remain on.
`;

const FORBIDDEN_TRAILER_RE =
  /^(Job-Id:|Keeper-Commit-Id:|Session-Id:|Signed-off-by:|Planctl-Op:|Planctl-Target:|Planctl-Prev-Op:|Planctl-[A-Za-z]+:)/im;
const TASK_TRAILER_RE = /^Task:/im;
const DEFAULT_MAX_FILES = 500;
const SAMPLE_LIMIT = 20;
const RESULT_FILE_LIMIT = DEFAULT_MAX_FILES;
const RESULT_PATH_BYTES = 1_024;
const STDERR_LIMIT = 4000;
const MAX_ADOPTION_MANIFEST_BYTES = 1_048_576;
const MAX_ADOPTION_MANIFEST_TOTAL_BYTES = 1_048_576;
const MAX_ADOPTION_MANIFEST_FILES = 32;
const MAX_ADOPTION_MANIFEST_PATHS = 10_000;
const MAX_ADOPTION_PATH_BYTES = 4_096;
const MAX_ADOPTION_TOTAL_PATH_BYTES = 1_048_576;
const PUBLICATION_MAX_ATTEMPTS = 3;
const PUBLICATION_RETRY_JITTER_MIN_MS = 10;
const PUBLICATION_RETRY_JITTER_SPAN_MS = 20;
/** Atomic nonblocking open: FIFOs/devices cannot hang before descriptor fstat. */
export const BOUNDED_INPUT_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK;

export interface ParsedArgs {
  msg: string | null;
  sessionId: string | null;
  adopt: string[];
  adoptFrom: string[];
  messageFile: string | null;
  taskId: string | null;
  previewFiles: boolean;
  allowStaleUnstage: boolean;
  overrideJam: boolean;
  allowMassReversion: boolean;
  maxFiles: number;
  help: boolean;
  agentHelp: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  return value;
}

function parseMaxFiles(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`--max-files must be an integer >= 0 (got '${raw}')`);
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    msg: null,
    sessionId: null,
    adopt: [],
    adoptFrom: [],
    messageFile: null,
    taskId: null,
    previewFiles: false,
    allowStaleUnstage: false,
    overrideJam: false,
    allowMassReversion: false,
    maxFiles: DEFAULT_MAX_FILES,
    help: false,
    agentHelp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--agent-help") parsed.agentHelp = true;
    else if (arg === "--preview-files") parsed.previewFiles = true;
    else if (arg === "--allow-stale-unstage") parsed.allowStaleUnstage = true;
    else if (arg === "--override-jam") parsed.overrideJam = true;
    else if (arg === "--allow-mass-reversion") parsed.allowMassReversion = true;
    else if (arg === "--session-id") {
      parsed.sessionId = valueAfter(argv, i, arg);
      i += 1;
    } else if (arg.startsWith("--session-id=")) {
      parsed.sessionId = arg.slice("--session-id=".length);
    } else if (arg === "--adopt") {
      parsed.adopt.push(valueAfter(argv, i, arg));
      i += 1;
    } else if (arg.startsWith("--adopt=")) {
      parsed.adopt.push(arg.slice("--adopt=".length));
    } else if (arg === "--adopt-from") {
      parsed.adoptFrom.push(valueAfter(argv, i, arg));
      i += 1;
    } else if (arg.startsWith("--adopt-from=")) {
      parsed.adoptFrom.push(arg.slice("--adopt-from=".length));
    } else if (arg === "--message-file") {
      if (parsed.messageFile !== null) {
        throw new UsageError("--message-file may be passed only once");
      }
      parsed.messageFile = valueAfter(argv, i, arg);
      i += 1;
    } else if (arg.startsWith("--message-file=")) {
      if (parsed.messageFile !== null) {
        throw new UsageError("--message-file may be passed only once");
      }
      parsed.messageFile = arg.slice("--message-file=".length);
    } else if (arg === "--task-id") {
      if (parsed.taskId !== null) {
        throw new UsageError("--task-id may be passed only once");
      }
      parsed.taskId = valueAfter(argv, i, arg);
      i += 1;
    } else if (arg.startsWith("--task-id=")) {
      if (parsed.taskId !== null) {
        throw new UsageError("--task-id may be passed only once");
      }
      parsed.taskId = arg.slice("--task-id=".length);
    } else if (arg === "--max-files") {
      parsed.maxFiles = parseMaxFiles(valueAfter(argv, i, arg));
      i += 1;
    } else if (arg.startsWith("--max-files=")) {
      parsed.maxFiles = parseMaxFiles(arg.slice("--max-files=".length));
    } else if (arg === "--") {
      if (i + 1 < argv.length) parsed.msg = argv[i + 1];
      if (i + 2 < argv.length)
        throw new UsageError("too many positional arguments");
      break;
    } else if (!arg.startsWith("-") && parsed.msg === null) parsed.msg = arg;
    else throw new UsageError(`unexpected argument '${arg}'`);
  }
  if (parsed.taskId !== null) {
    const task = parsePlanRef(parsed.taskId);
    if (task?.kind !== "task" || task.task_id !== parsed.taskId) {
      throw new UsageError(
        `--task-id must be a valid task ref (got '${parsed.taskId}')`,
      );
    }
  }
  return parsed;
}

/** Read one regular file through a single descriptor with a hard byte cap. */
function readBoundedInputFile(
  path: string,
  flag: "--adopt-from" | "--message-file",
  maxBytes: number,
): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, BOUNDED_INPUT_OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new UsageError(`${flag} '${path}' must name a regular file`);
    }
    if (stat.size > maxBytes) {
      throw new UsageError(`${flag} '${path}' exceeds ${maxBytes} bytes`);
    }
    // Read from the already-open descriptor into a bounded buffer. This binds
    // validation to one file identity and detects growth without a stat/read
    // pathname race or an unbounded allocation.
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxBytes) {
      throw new UsageError(`${flag} '${path}' exceeds ${maxBytes} bytes`);
    }
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `cannot read ${flag} '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The bounded input has already been copied; close failure cannot make
        // an untrusted pathname authoritative or alter the invocation payload.
      }
    }
  }
}

function validateAdoptionPaths(paths: readonly string[]): void {
  if (paths.length > MAX_ADOPTION_MANIFEST_PATHS) {
    throw new UsageError(
      `adoption inputs exceed ${MAX_ADOPTION_MANIFEST_PATHS} paths`,
    );
  }
  let totalBytes = 0;
  for (const path of paths) {
    if (path.includes("\0")) {
      throw new UsageError("adoption paths may not contain NUL");
    }
    const bytes = Buffer.byteLength(path, "utf8");
    if (bytes > MAX_ADOPTION_PATH_BYTES) {
      throw new UsageError(
        `an adoption path exceeds ${MAX_ADOPTION_PATH_BYTES} bytes`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_ADOPTION_TOTAL_PATH_BYTES) {
      throw new UsageError(
        `adoption paths exceed ${MAX_ADOPTION_TOTAL_PATH_BYTES} total bytes`,
      );
    }
  }
}

/** Expand invocation files without granting durable ownership. */
function expandInvocationFiles(args: ParsedArgs): ParsedArgs {
  if (args.adoptFrom.length > MAX_ADOPTION_MANIFEST_FILES) {
    throw new UsageError(
      `too many --adopt-from files (maximum ${MAX_ADOPTION_MANIFEST_FILES})`,
    );
  }
  const manifestPaths: string[] = [];
  let manifestBytes = 0;
  for (const manifestPath of args.adoptFrom) {
    const text = readBoundedInputFile(
      manifestPath,
      "--adopt-from",
      MAX_ADOPTION_MANIFEST_BYTES,
    );
    manifestBytes += Buffer.byteLength(text, "utf8");
    if (manifestBytes > MAX_ADOPTION_MANIFEST_TOTAL_BYTES) {
      throw new UsageError(
        `--adopt-from files exceed ${MAX_ADOPTION_MANIFEST_TOTAL_BYTES} total bytes`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UsageError(`--adopt-from '${manifestPath}' is not valid JSON`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new UsageError(
        `--adopt-from '${manifestPath}' must contain a commit-work-adoption object`,
      );
    }
    const manifest = parsed as Record<string, unknown>;
    if (
      manifest.schema_version !== 1 ||
      manifest.kind !== "commit-work-adoption" ||
      !Array.isArray(manifest.paths) ||
      manifest.paths.some((path) => typeof path !== "string")
    ) {
      throw new UsageError(
        `--adopt-from '${manifestPath}' must match {"schema_version":1,"kind":"commit-work-adoption","paths":[...]}`,
      );
    }
    const paths = manifest.paths as string[];
    if (paths.length > MAX_ADOPTION_MANIFEST_PATHS - manifestPaths.length) {
      throw new UsageError(
        `--adopt-from manifests exceed ${MAX_ADOPTION_MANIFEST_PATHS} paths`,
      );
    }
    // Append iteratively only after the count check. Spreading an attacker-sized
    // JSON array can exceed the JavaScript argument limit before a typed refusal.
    for (const path of paths) manifestPaths.push(path);
  }

  if (args.adopt.length > MAX_ADOPTION_MANIFEST_PATHS - manifestPaths.length) {
    throw new UsageError(
      `adoption inputs exceed ${MAX_ADOPTION_MANIFEST_PATHS} paths`,
    );
  }
  const adoptionPaths = args.adopt.slice();
  for (const path of manifestPaths) adoptionPaths.push(path);
  validateAdoptionPaths(adoptionPaths);

  let message = args.msg;
  if (args.messageFile !== null) {
    if (message !== null) {
      throw new UsageError(
        "pass either positional MSG or --message-file, not both",
      );
    }
    message = readBoundedInputFile(
      args.messageFile,
      "--message-file",
      MAX_COMMIT_MESSAGE_BYTES,
    );
    if (message.includes("\0")) {
      throw new UsageError("--message-file may not contain NUL");
    }
  }
  if (message !== null) {
    if (message.includes("\0")) {
      throw new UsageError("commit message may not contain NUL");
    }
    if (Buffer.byteLength(message, "utf8") > MAX_COMMIT_MESSAGE_BYTES) {
      throw new UsageError(
        `commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes`,
      );
    }
  }
  return {
    ...args,
    msg: message,
    adopt: adoptionPaths,
  };
}

export type CommitWorkOutcome =
  | "preview"
  | "committed_pushed"
  | "committed_push_skipped"
  | "nothing_to_commit"
  | "argument_error"
  | "identity_conflict"
  | "invalid_identity"
  | "no_session_id"
  | "identity_untrusted"
  | "task_unbound"
  | "surface_unavailable"
  | "receipts_pending"
  | "ownership_conflict"
  | "ownership_ambiguous"
  | "adoption_rejected"
  | "message_required"
  | "forbidden_trailer"
  | "operation_in_progress"
  | "shared_checkout_jam"
  | "commit_state_indeterminate"
  | "lock_timeout"
  | "file_list_too_large"
  | "stale_index_carryover"
  | "unmerged_paths"
  | "detached_head"
  | "head_read_failed"
  | "index_seed_failed"
  | "stage_failed"
  | "directory_file_conflict"
  | "tree_write_failed"
  | "mass_reversion"
  | "lint_failed"
  | "surface_changed"
  | "ref_conflict"
  | "commit_failed"
  | "commit_signing_failed"
  | "commit_hook_mutated"
  | "post_commit_hook_failed"
  | "ambient_reconcile_failed"
  | "push_state_indeterminate"
  | "push_failed"
  | "internal_error";

export interface CommitWorkResult {
  schema_version: 1;
  kind: "commit-work-result";
  outcome: CommitWorkOutcome;
  success: boolean;
  identity?: string | null;
  selection?: Record<string, unknown>;
  surface?: CommitWorkSurfaceSummary;
  commit?: Record<string, unknown>;
  push?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

function result(
  kind: CommitWorkResult["kind"],
  outcome: CommitWorkOutcome,
  success: boolean,
  extra: Record<string, unknown> = {},
): CommitWorkResult {
  return {
    schema_version: 1,
    kind,
    outcome,
    success,
    ...(success ? {} : { error: outcome }),
    ...extra,
  };
}

function capStderr(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  return stderr.slice(0, STDERR_LIMIT);
}

function pathSample(paths: string[]): string[] {
  return paths
    .slice(0, SAMPLE_LIMIT)
    .map((path) => path.slice(0, RESULT_PATH_BYTES));
}

/** Bounded compatibility array plus explicit cardinality for every result. */
function resultFileFields(paths: readonly string[]): Record<string, unknown> {
  return {
    files: paths
      .slice(0, RESULT_FILE_LIMIT)
      .map((path) => path.slice(0, RESULT_PATH_BYTES)),
    file_total: paths.length,
    files_truncated: paths.length > RESULT_FILE_LIMIT,
  };
}

function pushAliases(push: Record<string, unknown>): Record<string, unknown> {
  return {
    pushed: push.pushed,
    ...(push.remote === undefined ? {} : { remote: push.remote }),
    ...(push.branch === undefined ? {} : { branch: push.branch }),
    ...(push.skipped === undefined ? {} : { skipped: push.skipped }),
    ...(push.push_error === undefined ? {} : { push_error: push.push_error }),
    ...(push.push_error_class === undefined
      ? {}
      : { push_error_class: push.push_error_class }),
    ...(push.tracking_warning === undefined
      ? {}
      : { tracking_warning: push.tracking_warning }),
    ...(push.tracking_warning_class === undefined
      ? {}
      : { tracking_warning_class: push.tracking_warning_class }),
  };
}

function selectionEnvelope(
  surface: SurfaceDiscoveryResult,
  identity: string | null,
): Record<string, unknown> {
  return {
    identity,
    total: surface.selected.length,
    sample: pathSample(surface.selected),
    automatic_total: surface.automatic.length,
    automatic_sample: pathSample(surface.automatic),
    adopted_total: surface.adopted.length,
    adopted_sample: pathSample(surface.adopted),
    rejections: surface.rejections.slice(0, SAMPLE_LIMIT).map((rejection) => ({
      ...rejection,
      input: rejection.input.slice(0, 1024),
      path: rejection.path?.slice(0, 1024),
      conflicting_sessions: rejection.conflicting_sessions?.map((session) =>
        session.slice(0, 256),
      ),
      pending_sessions: rejection.pending_sessions?.map((session) =>
        session.slice(0, 256),
      ),
    })),
    rejection_total: surface.rejections.length,
  };
}

async function resolveWorktreeRoot(
  cwd: string,
  git: GitRunner,
): Promise<string> {
  const root = await git(["rev-parse", "--show-toplevel"], { cwd });
  return root.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
}

async function stagedFileNames(
  cwd: string,
  git: GitRunner,
): Promise<string[] | null> {
  const staged = await git(
    [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACDMRT",
    ],
    { cwd },
  );
  if (staged.code !== 0) return null;
  return staged.stdout.split("\0").filter(Boolean).sort();
}

async function unmergedFileNames(
  cwd: string,
  git: GitRunner,
): Promise<string[] | null> {
  const unmerged = await git(["diff", "--name-only", "-z", "--diff-filter=U"], {
    cwd,
  });
  if (unmerged.code !== 0) return null;
  return unmerged.stdout.split("\0").filter(Boolean).sort();
}

/** Every local Git boundary in commit-work has a finite default. Callers may
 * select another explicit positive bound (the push leg does), but omission can
 * never turn config/FIFO/filesystem trouble into an unbounded publication. */
export function boundedCommitWorkGit(run: GitRunner): GitRunner {
  return (args, options = {}) =>
    run(args, {
      ...options,
      timeoutMs:
        options.timeoutMs !== undefined && options.timeoutMs > 0
          ? options.timeoutMs
          : GIT_LOCAL_TIMEOUT_MS,
    });
}

export interface CommitWorkDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  gitRunner?: GitRunner;
  directEvidence?: (
    identity: string | null,
    worktree: string,
  ) => DirectSurfaceEvidence | undefined;
  readClaims?: (worktree: string) => OwnershipClaim[] | null;
  classifyClaim?: (claim: OwnershipClaim) => ClaimLiveness;
  runLint?: (files: string[], cwd: string) => Promise<void>;
  acquireLock?: (
    lockPath: string,
  ) => { release: () => void } | null | Promise<{ release: () => void } | null>;
  detectInProgress?: (
    worktree: string,
    git: GitRunner,
  ) => Promise<InProgressOperation | null>;
  checkSharedCheckoutJam?: (
    worktree: string,
  ) => boolean | SharedCheckoutJam | null;
  publicationRetrySleep?: (ms: number) => Promise<void>;
  publicationRetryRandom?: () => number;
  push?: typeof pushExactCommit;
  privateIndexFs?: PrivateIndexFs;
  emitOutcome?: (result: CommitWorkResult, identity: string | null) => void;
  validateIdentity?: (identity: string) => boolean | Promise<boolean>;
  validateTaskBinding?: (
    identity: string,
    taskId: string,
  ) => boolean | Promise<boolean>;
}

function probeSharedCheckoutJam(
  worktree: string,
  deps: CommitWorkDeps,
): SharedCheckoutJam | null {
  const observed = deps.checkSharedCheckoutJam
    ? deps.checkSharedCheckoutJam(worktree)
    : sharedCheckoutJam(worktree);
  if (!observed) return null;
  if (observed === true) {
    return {
      distressRowId: "unknown",
      clearCondition:
        "the producer level-trigger observes the shared checkout recovered",
    };
  }
  return observed;
}

function sharedCheckoutJamFields(
  jam: SharedCheckoutJam,
): Record<string, unknown> {
  return {
    distress_row_id: jam.distressRowId,
    clear_condition: jam.clearCondition,
    recovery:
      `Wait until distress row ${jam.distressRowId} clears when ${jam.clearCondition}, ` +
      "or use --override-jam only after inspecting it.",
  };
}

async function discover(
  args: ParsedArgs,
  identity: string | null,
  worktree: string,
  git: GitRunner,
  deps: CommitWorkDeps,
): Promise<SurfaceDiscoveryResult> {
  const surfaceDeps: SurfaceDiscoveryDeps = {
    readClaims: deps.readClaims,
    classifyClaim: deps.classifyClaim,
  };
  const supplied = deps.directEvidence?.(identity, worktree);
  return discoverCommitWorkSurface({
    worktree,
    identity,
    adoptedPaths: args.adopt,
    git,
    directEvidence: supplied,
    sampleLimit: SAMPLE_LIMIT,
    deps: surfaceDeps,
  });
}

function automaticClaimIdentityDrift(
  surface: SurfaceDiscoveryResult,
  frozen: FrozenPrivateIndex,
  identity: string | null,
  automaticPaths: string[] = surface.automatic,
): string[] {
  if (identity === null) return [];
  const byPath = new Map(frozen.entries.map((entry) => [entry.path, entry]));
  const drifted: string[] = [];
  for (const path of automaticPaths) {
    const entry = byPath.get(path);
    if (!entry) {
      drifted.push(path);
      continue;
    }
    const mine = (surface.claimsByPath.get(path) ?? []).filter(
      (claim) =>
        claimIsExclusiveOwnership(claim) && claim.sessionId === identity,
    );
    const frozenMode = entry.kind === "absent" ? "000000" : entry.mode;
    if (
      mine.some(
        (claim) =>
          (claim.oid !== null &&
            claim.oid !== undefined &&
            claim.oid !== entry.oid) ||
          (claim.mode !== null &&
            claim.mode !== undefined &&
            claim.mode !== frozenMode),
      )
    ) {
      drifted.push(path);
    }
  }
  return drifted.sort();
}

function selectedForeignConflicts(
  surface: SurfaceDiscoveryResult,
  selected: string[],
  identity: string | null,
): {
  conflicts: Array<{ path: string; sessions: string[] }>;
  receiptsPending: ReturnType<typeof summarizeReceiptLag>;
  pending: boolean;
} {
  const conflicts: Array<{ path: string; sessions: string[] }> = [];
  const receipts = new Map<
    string,
    Parameters<typeof summarizeReceiptLag>[0][number]
  >();
  for (const path of selected) {
    const blockers = unsafeForeignSessions(
      surface.claimsByPath.get(path) ?? [],
      identity,
    );
    if (blockers.conflicts.length > 0) {
      conflicts.push({
        path,
        sessions: blockers.conflicts.slice(0, SAMPLE_LIMIT),
      });
    }
    for (const receipt of blockers.receiptsPending) {
      receipts.set(receipt.sessionId, receipt);
    }
  }
  return {
    conflicts,
    receiptsPending: summarizeReceiptLag([...receipts.values()]),
    pending: receipts.size > 0,
  };
}

function receiptsPendingFields(
  surface: SurfaceDiscoveryResult,
  identity: string | null,
): Record<string, unknown> {
  const receipts = new Map<
    string,
    Parameters<typeof summarizeReceiptLag>[0][number]
  >();
  for (const rejection of surface.rejections) {
    if (rejection.code !== "receipts_pending" || rejection.path === undefined) {
      continue;
    }
    for (const receipt of unsafeForeignSessions(
      surface.claimsByPath.get(rejection.path) ?? [],
      identity,
    ).receiptsPending) {
      receipts.set(receipt.sessionId, receipt);
    }
  }
  const lag = summarizeReceiptLag([...receipts.values()]);
  return {
    ingest_lag_events: lag.events,
    ingest_lag_seconds: lag.seconds,
    stalled_ingester: lag.stalledIngester,
  };
}

function surfaceFailure(
  surface: SurfaceDiscoveryResult,
  identity: string | null,
): CommitWorkResult | null {
  if (!surface.dirtyAvailable) {
    return result("commit-work-result", "surface_unavailable", false, {
      identity,
      selection: selectionEnvelope(surface, identity),
      surface: surface.summary,
    });
  }
  const conflict = surface.rejections.some(
    (rejection) => rejection.code === "ownership_conflict",
  );
  const receiptsPending = surface.rejections.some(
    (rejection) => rejection.code === "receipts_pending",
  );
  const unavailable = surface.rejections.some(
    (rejection) => rejection.code === "ownership_unavailable",
  );
  if (surface.rejections.length > 0) {
    return result(
      "commit-work-result",
      conflict
        ? "ownership_conflict"
        : receiptsPending
          ? "receipts_pending"
          : unavailable
            ? "ownership_ambiguous"
            : "adoption_rejected",
      false,
      {
        identity,
        ...(receiptsPending ? receiptsPendingFields(surface, identity) : {}),
        selection: selectionEnvelope(surface, identity),
        surface: surface.summary,
      },
    );
  }
  return null;
}

class PublicationValidationError extends Error {
  readonly result: CommitWorkResult;

  constructor(failure: CommitWorkResult) {
    super(failure.outcome);
    this.name = "PublicationValidationError";
    this.result = failure;
  }
}

function finalOwnershipFailure(
  initial: SurfaceDiscoveryResult,
  current: SurfaceDiscoveryResult,
  frozen: FrozenPrivateIndex,
  identity: string | null,
): CommitWorkResult | null {
  const invalid = surfaceFailure(current, identity);
  if (invalid) return invalid;

  const foreign = selectedForeignConflicts(current, frozen.paths, identity);
  if (foreign.conflicts.length > 0) {
    return result("commit-work-result", "ownership_conflict", false, {
      identity,
      reason: "foreign_claim_before_publication",
      count: foreign.conflicts.length,
      sample: foreign.conflicts.slice(0, SAMPLE_LIMIT),
      ...resultFileFields(frozen.paths),
      selection: selectionEnvelope(current, identity),
      surface: current.summary,
    });
  }
  if (foreign.pending) {
    return result("commit-work-result", "receipts_pending", false, {
      identity,
      reason: "foreign_receipts_before_publication",
      ingest_lag_events: foreign.receiptsPending.events,
      ingest_lag_seconds: foreign.receiptsPending.seconds,
      stalled_ingester: foreign.receiptsPending.stalledIngester,
      ...resultFileFields(frozen.paths),
      selection: selectionEnvelope(current, identity),
      surface: current.summary,
    });
  }

  const automaticLost = initial.automatic.filter(
    (path) => !current.automatic.includes(path),
  );
  if (automaticLost.length > 0) {
    return result("commit-work-result", "ownership_ambiguous", false, {
      identity,
      reason: "automatic_ownership_changed_before_publication",
      count: automaticLost.length,
      sample: pathSample(automaticLost),
      ...resultFileFields(frozen.paths),
      selection: selectionEnvelope(current, identity),
      surface: current.summary,
    });
  }

  const claimDrift = automaticClaimIdentityDrift(
    current,
    frozen,
    identity,
    frozen.paths,
  );
  if (claimDrift.length > 0) {
    return result("commit-work-result", "surface_changed", false, {
      identity,
      reason: "claim_identity_changed_before_publication",
      count: claimDrift.length,
      sample: pathSample(claimDrift),
      ...resultFileFields(frozen.paths),
      selection: selectionEnvelope(current, identity),
      surface: current.summary,
    });
  }

  return null;
}

interface CommitWorkAuthorityRow {
  state: unknown;
  harness: unknown;
  pid: unknown;
  start_time: unknown;
  plan_verb: unknown;
  plan_ref: unknown;
}

export type CommitWorkAuthorityVerdict =
  | "ok"
  | "identity_untrusted"
  | "task_unbound";

function readCommitWorkAuthorityRow(
  identity: string,
  dbPath: string,
): CommitWorkAuthorityRow | null {
  const { db } = openDb(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT state, harness, pid, start_time, plan_verb, plan_ref
           FROM jobs
          WHERE job_id = ?`,
      )
      .get(identity) as CommitWorkAuthorityRow | null;
  } finally {
    db.close();
  }
}

function validCommitWorkAuthorityRow(
  row: CommitWorkAuthorityRow | null,
): row is CommitWorkAuthorityRow & {
  harness: "claude" | "pi";
  pid: number;
  start_time: string;
} {
  return (
    row?.state === "working" &&
    (row.harness === "claude" || row.harness === "pi") &&
    typeof row.pid === "number" &&
    Number.isSafeInteger(row.pid) &&
    row.pid > 1 &&
    typeof row.start_time === "string" &&
    row.start_time.length > 0
  );
}

export async function trustedCommitWorkAuthority(
  identity: string,
  taskId: string | null,
  dbPath = defaultDbPath(),
  processOptions: {
    currentPid?: number;
    read?: ProcessIdentityReader;
    maxDepth?: number;
  } = {},
): Promise<CommitWorkAuthorityVerdict> {
  try {
    const before = readCommitWorkAuthorityRow(identity, dbPath);
    if (!validCommitWorkAuthorityRow(before)) return "identity_untrusted";
    if (
      !(await invocationDescendsFrom(
        before.pid,
        before.start_time,
        processOptions,
      ))
    ) {
      return "identity_untrusted";
    }
    // PID identity and task authority are one generation-bound row. Sandwich
    // the ancestry walk with every authority field, not two independent reads.
    const after = readCommitWorkAuthorityRow(identity, dbPath);
    if (
      !validCommitWorkAuthorityRow(after) ||
      after.state !== before.state ||
      after.harness !== before.harness ||
      after.pid !== before.pid ||
      after.start_time !== before.start_time ||
      after.plan_verb !== before.plan_verb ||
      after.plan_ref !== before.plan_ref
    ) {
      return "identity_untrusted";
    }
    return taskId !== null &&
      (after.plan_verb !== "work" || after.plan_ref !== taskId)
      ? "task_unbound"
      : "ok";
  } catch {
    return "identity_untrusted";
  }
}

export async function trustedCommitWorkIdentity(
  identity: string,
  dbPath = defaultDbPath(),
  processOptions: {
    currentPid?: number;
    read?: ProcessIdentityReader;
    maxDepth?: number;
  } = {},
): Promise<boolean> {
  return (
    (await trustedCommitWorkAuthority(
      identity,
      null,
      dbPath,
      processOptions,
    )) === "ok"
  );
}

export function taskBoundToIdentity(
  identity: string,
  taskId: string,
  dbPath = defaultDbPath(),
): boolean {
  try {
    const { db } = openDb(dbPath, { readonly: true });
    try {
      const row = db
        .query(
          `SELECT plan_verb, plan_ref, state, harness
             FROM jobs
            WHERE job_id = ?`,
        )
        .get(identity) as {
        plan_verb: unknown;
        plan_ref: unknown;
        state: unknown;
        harness: unknown;
      } | null;
      return (
        row?.plan_verb === "work" &&
        row.plan_ref === taskId &&
        row.state === "working" &&
        (row.harness === "claude" || row.harness === "pi")
      );
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function runAttempt(
  args: ParsedArgs,
  deps: CommitWorkDeps,
): Promise<{
  code: number;
  result: CommitWorkResult;
  identity: string | null;
}> {
  const invocationKind: CommitWorkResult["kind"] = "commit-work-result";
  let identity: string | null = null;
  try {
    const resolved = resolveInvocationIdentity(
      args.sessionId,
      deps.env ?? process.env,
    );
    identity = resolved.value;
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      return {
        code: 1,
        identity: null,
        result: result(invocationKind, "identity_conflict", false, {
          identity: null,
          identity_sources: Object.keys(error.carriers),
        }),
      };
    }
    if (error instanceof InvalidIdentityError) {
      return {
        code: 1,
        identity: null,
        result: result(invocationKind, "invalid_identity", false, {
          identity: null,
          identity_sources: error.sources,
        }),
      };
    }
    throw error;
  }

  if (identity === null) {
    return {
      code: 1,
      identity,
      result: result(invocationKind, "no_session_id", false, {
        identity,
        hint: "Pass --session-id <uuid> or run from a git worktree tracked by Keeper.",
      }),
    };
  }

  const validateInvocationAuthority =
    async (): Promise<CommitWorkAuthorityVerdict> => {
      if (
        deps.validateIdentity === undefined &&
        deps.validateTaskBinding === undefined
      ) {
        return await trustedCommitWorkAuthority(identity, args.taskId);
      }
      if (
        !(await (deps.validateIdentity ?? trustedCommitWorkIdentity)(identity))
      ) {
        return "identity_untrusted";
      }
      if (
        args.taskId !== null &&
        !(await (deps.validateTaskBinding ?? taskBoundToIdentity)(
          identity,
          args.taskId,
        ))
      ) {
        return "task_unbound";
      }
      return "ok";
    };

  const initialAuthority = await validateInvocationAuthority();
  if (initialAuthority === "identity_untrusted") {
    return {
      code: 1,
      identity,
      result: result(invocationKind, "identity_untrusted", false, {
        identity,
        hint: "Run from the active Claude session whose Keeper job owns this invocation.",
      }),
    };
  }
  if (initialAuthority === "task_unbound") {
    return {
      code: 1,
      identity,
      result: result(invocationKind, "task_unbound", false, {
        identity,
        task_id: args.taskId,
        hint: "--task-id must equal this active work session's bound plan task.",
      }),
    };
  }

  const git = boundedCommitWorkGit(deps.gitRunner ?? gitExec);
  const worktree = await resolveWorktreeRoot(deps.cwd ?? process.cwd(), git);
  // Ownership discovery is immediate: durable claims are used when available,
  // while fold-lagged or otherwise unattributed dirt is surfaced as explicitly
  // adoptable. A fixed delay cannot establish a happens-before relationship.
  const advisory = await discover(args, identity, worktree, git, deps);
  const ambient = await stagedFileNames(worktree, git);
  if (ambient !== null) {
    advisory.summary.ambient_staged_carryover = {
      total: ambient.length,
      sample: pathSample(ambient),
    };
  }

  if (args.maxFiles > 0 && advisory.selected.length > args.maxFiles) {
    return {
      code: 1,
      identity,
      result: result(invocationKind, "file_list_too_large", false, {
        identity,
        ...resultFileFields(advisory.selected),
        count: advisory.selected.length,
        limit: args.maxFiles,
        sample: pathSample(advisory.selected),
        selection: selectionEnvelope(advisory, identity),
        surface: advisory.summary,
      }),
    };
  }

  if (args.previewFiles) {
    return {
      code: 0,
      identity,
      result: result("commit-work-result", "preview", true, {
        identity,
        ...resultFileFields(advisory.selected),
        selection: selectionEnvelope(advisory, identity),
        surface: advisory.summary,
      }),
    };
  }

  if (!args.msg) {
    return {
      code: 1,
      identity,
      result: result("commit-work-result", "message_required", false, {
        identity,
        selection: selectionEnvelope(advisory, identity),
        surface: advisory.summary,
      }),
    };
  }
  if (FORBIDDEN_TRAILER_RE.test(args.msg) || TASK_TRAILER_RE.test(args.msg)) {
    return {
      code: 1,
      identity,
      result: result("commit-work-result", "forbidden_trailer", false, {
        identity,
        selection: selectionEnvelope(advisory, identity),
        surface: advisory.summary,
      }),
    };
  }
  const commitMessage =
    args.taskId === null
      ? args.msg
      : `${args.msg.replace(/\n+$/, "")}\n\nTask: ${args.taskId}`;

  const detect = deps.detectInProgress ?? detectInProgressOperation;
  const inProgress = await detect(worktree, git);
  if (inProgress !== null) {
    return {
      code: 1,
      identity,
      result: result("commit-work-result", "operation_in_progress", false, {
        identity,
        operation: inProgress,
        recovery: `Finish or abort the in-progress ${inProgress} operation, then re-run keeper commit-work.`,
        selection: selectionEnvelope(advisory, identity),
        surface: advisory.summary,
      }),
    };
  }
  if (!args.overrideJam) {
    let jam: SharedCheckoutJam | null = null;
    try {
      jam = probeSharedCheckoutJam(worktree, deps);
    } catch {
      jam = null;
    }
    if (jam) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "shared_checkout_jam", false, {
          identity,
          ...sharedCheckoutJamFields(jam),
          selection: selectionEnvelope(advisory, identity),
          surface: advisory.summary,
        }),
      };
    }
  }

  const gitDirResult = await git(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd: worktree },
  );
  const lockDir =
    gitDirResult.code === 0 && gitDirResult.stdout.trim()
      ? gitDirResult.stdout.trim()
      : `${worktree}/.git`;
  const acquire =
    deps.acquireLock ?? ((path: string) => CommitWorkLock.acquire(path));
  let lock: { release: () => void } | null;
  try {
    lock = await acquire(`${lockDir}/keeper-commit-work.lock`);
  } catch (error) {
    return {
      code: 1,
      identity,
      result: result("commit-work-result", "lock_timeout", false, {
        identity,
        detail: error instanceof Error ? error.name : "lock_error",
      }),
    };
  }
  if (lock === null) {
    return {
      code: 1,
      identity,
      result: result("commit-work-result", "lock_timeout", false, { identity }),
    };
  }

  let frozen: FrozenPrivateIndex | null = null;
  try {
    const underLockOperation = await detect(worktree, git);
    if (underLockOperation !== null) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "operation_in_progress", false, {
          identity,
          operation: underLockOperation,
          recovery: `Finish or abort the in-progress ${underLockOperation} operation, then re-run keeper commit-work.`,
        }),
      };
    }
    if (!args.overrideJam) {
      let underLockJam: SharedCheckoutJam | null = null;
      try {
        underLockJam = probeSharedCheckoutJam(worktree, deps);
      } catch {
        underLockJam = null;
      }
      if (underLockJam) {
        return {
          code: 1,
          identity,
          result: result("commit-work-result", "shared_checkout_jam", false, {
            identity,
            ...sharedCheckoutJamFields(underLockJam),
          }),
        };
      }
    }

    // Preview is advisory. Definitive ownership discovery follows the lock and
    // binds exact live identities; unattributed dirt requires explicit adoption.
    const surface = await discover(args, identity, worktree, git, deps);
    const ambientNow = await stagedFileNames(worktree, git);
    if (ambientNow === null) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "stage_failed", false, {
          identity,
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }
    surface.summary.ambient_staged_carryover = {
      total: ambientNow.length,
      sample: pathSample(ambientNow),
    };
    const invalid = surfaceFailure(surface, identity);
    if (invalid) return { code: 1, identity, result: invalid };

    if (args.maxFiles > 0 && surface.selected.length > args.maxFiles) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "file_list_too_large", false, {
          identity,
          ...resultFileFields(surface.selected),
          count: surface.selected.length,
          limit: args.maxFiles,
          sample: pathSample(surface.selected),
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }
    if (
      surface.selected.length === 0 &&
      surface.summary.multi_ambiguous.total > 0
    ) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "ownership_ambiguous", false, {
          identity,
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }
    if (surface.selected.length === 0) {
      return {
        code: 0,
        identity,
        result: result("commit-work-result", "nothing_to_commit", true, {
          identity,
          ...resultFileFields([]),
          committed: false,
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }

    const selectedSet = new Set(surface.selected);
    const stale = ambientNow.filter((path) => !selectedSet.has(path));
    if (stale.length > 0 && !args.allowStaleUnstage) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "stale_index_carryover", false, {
          identity,
          count: stale.length,
          sample: pathSample(stale),
          hint: "Ambient staged paths are outside this invocation's selected surface.",
          recovery:
            "If an ambient path is yours, add that exact path with --adopt and preview again; otherwise preserve the other work and use --allow-stale-unstage to restore only those ambient entries.",
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }

    const unmerged = await unmergedFileNames(worktree, git);
    if (unmerged === null) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "stage_failed", false, {
          identity,
        }),
      };
    }
    if (unmerged.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "unmerged_paths", false, {
          identity,
          count: unmerged.length,
          sample: pathSample(unmerged),
        }),
      };
    }

    try {
      frozen = await createFrozenPrivateIndex(
        worktree,
        surface.selected,
        git,
        deps.privateIndexFs,
      );
      if (stale.length > 0) {
        const baseEntries = await exactEntriesFromTree(
          stale,
          frozen.expectedHead,
          worktree,
          git,
        );
        await reconcileAmbientIndexEntries(
          baseEntries,
          frozen.expectedHead,
          worktree,
          git,
        );
        await refreshFrozenPublicationBaseline(
          frozen,
          worktree,
          git,
          deps.privateIndexFs,
        );
      }
      // The first verification makes the binding explicit before lint starts.
      await verifyFrozenSurface(frozen, worktree, git, deps.privateIndexFs);
    } catch (error) {
      const typed = error instanceof PrivateIndexError ? error : null;
      return {
        code: 1,
        identity,
        result: result(
          "commit-work-result",
          typed?.code ?? "stage_failed",
          false,
          {
            identity,
            stderr_sample: capStderr(typed?.stderr),
            affected_total: typed?.paths?.length,
            affected_paths: typed?.paths ? pathSample(typed.paths) : undefined,
            selection: selectionEnvelope(surface, identity),
            surface: surface.summary,
          },
        ),
      };
    }

    const claimDrift = automaticClaimIdentityDrift(surface, frozen, identity);
    if (claimDrift.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "surface_changed", false, {
          identity,
          reason: "automatic_claim_identity_changed",
          count: claimDrift.length,
          sample: pathSample(claimDrift),
          ...resultFileFields(surface.selected),
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }

    const privateGit = privateIndexGit(frozen, worktree, git);
    const sweep = await analyzeReversionSweep(
      surface.selected,
      worktree,
      privateGit,
    );
    if (sweep.unmergedPaths.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "unmerged_paths", false, {
          identity,
          count: sweep.unmergedPaths.length,
          sample: pathSample(sweep.unmergedPaths),
        }),
      };
    }
    if (
      !args.allowMassReversion &&
      isMassReversion(sweep.reversionCandidates.length, sweep.stagedCount)
    ) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "mass_reversion", false, {
          identity,
          count: sweep.reversionCandidates.length,
          staged: sweep.stagedCount,
          sample: pathSample(sweep.reversionCandidates),
        }),
      };
    }

    const lintFiles = frozen.entries
      .filter((entry) => entry.kind !== "absent")
      .map((entry) => entry.path);
    try {
      await (deps.runLint ?? runScopedLint)(lintFiles, worktree);
    } catch (error) {
      if (error instanceof LintFailure) {
        return {
          code: 1,
          identity,
          result: result("commit-work-result", "lint_failed", false, {
            identity,
            linter: error.linter,
            file_total: error.files.length,
            files: pathSample(error.files),
            stderr: capStderr(error.stderr),
            stderr_sample: capStderr(error.stderr),
            recovery:
              "Fix the reported files in the live worktree, then re-invoke `keeper commit-work` with the same message and adoption arguments. A lint failure is not a coverage gap.",
          }),
        };
      }
      throw error;
    }

    // Lint can run arbitrary tools and lasts long enough for ownership to
    // change. Re-read durable and direct evidence before trusting identical
    // bytes: a new live/unknown foreign claimant always blocks adoption.
    const postLintSurface = await discover(args, identity, worktree, git, deps);
    const postLintInvalid = surfaceFailure(postLintSurface, identity);
    if (postLintInvalid) return { code: 1, identity, result: postLintInvalid };

    const foreignAfterLint = selectedForeignConflicts(
      postLintSurface,
      surface.selected,
      identity,
    );
    if (foreignAfterLint.conflicts.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "ownership_conflict", false, {
          identity,
          reason: "foreign_claim_after_lint",
          count: foreignAfterLint.conflicts.length,
          sample: foreignAfterLint.conflicts.slice(0, SAMPLE_LIMIT),
          ...resultFileFields(surface.selected),
          selection: selectionEnvelope(postLintSurface, identity),
          surface: postLintSurface.summary,
        }),
      };
    }
    if (foreignAfterLint.pending) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "receipts_pending", false, {
          identity,
          reason: "foreign_receipts_after_lint",
          ingest_lag_events: foreignAfterLint.receiptsPending.events,
          ingest_lag_seconds: foreignAfterLint.receiptsPending.seconds,
          stalled_ingester: foreignAfterLint.receiptsPending.stalledIngester,
          ...resultFileFields(surface.selected),
          selection: selectionEnvelope(postLintSurface, identity),
          surface: postLintSurface.summary,
        }),
      };
    }

    const automaticLost = surface.automatic.filter(
      (path) => !postLintSurface.automatic.includes(path),
    );
    if (automaticLost.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "ownership_ambiguous", false, {
          identity,
          reason: "automatic_ownership_changed_after_lint",
          count: automaticLost.length,
          sample: pathSample(automaticLost),
          ...resultFileFields(surface.selected),
          selection: selectionEnvelope(postLintSurface, identity),
          surface: postLintSurface.summary,
        }),
      };
    }

    const postLintClaimDrift = automaticClaimIdentityDrift(
      postLintSurface,
      frozen,
      identity,
      surface.automatic,
    );
    if (postLintClaimDrift.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "surface_changed", false, {
          identity,
          reason: "automatic_claim_identity_changed_after_lint",
          count: postLintClaimDrift.length,
          sample: pathSample(postLintClaimDrift),
          ...resultFileFields(surface.selected),
          selection: selectionEnvelope(postLintSurface, identity),
          surface: postLintSurface.summary,
        }),
      };
    }

    try {
      // Re-hash the selected tree and require the complete pre-lint worktree,
      // ambient index, Git config, hooks, and signing policy to remain frozen.
      await verifyFrozenSurface(frozen, worktree, git, deps.privateIndexFs);
      await verifyFrozenPublicationBaseline(
        frozen,
        worktree,
        git,
        deps.privateIndexFs,
      );
    } catch (error) {
      const typed = error instanceof PrivateIndexError ? error : null;
      return {
        code: 1,
        identity,
        result: result(
          "commit-work-result",
          typed?.code ?? "surface_changed",
          false,
          {
            identity,
            stderr_sample: capStderr(typed?.stderr),
          },
        ),
      };
    }

    let committed: Awaited<ReturnType<typeof commitFrozenPrivateIndex>>;
    let publicationAttempts = 0;
    try {
      for (;;) {
        publicationAttempts += 1;
        const publicationFrozen = frozen;
        try {
          committed = await commitFrozenPrivateIndex(
            publicationFrozen,
            commitMessage,
            worktree,
            git,
            deps.privateIndexFs,
            {
              beforeCommit: async () => await detect(worktree, git),
              validateOwnership: async () => {
                const validateAuthority = async (): Promise<void> => {
                  const verdict = await validateInvocationAuthority();
                  if (verdict !== "ok") {
                    throw new PublicationValidationError(
                      result("commit-work-result", verdict, false, {
                        identity,
                        ...(verdict === "task_unbound"
                          ? { task_id: args.taskId }
                          : {}),
                      }),
                    );
                  }
                };
                await validateAuthority();
                const current = await discover(
                  args,
                  identity,
                  worktree,
                  git,
                  deps,
                );
                const failure = finalOwnershipFailure(
                  surface,
                  current,
                  publicationFrozen,
                  identity,
                );
                if (failure) throw new PublicationValidationError(failure);
                await validateAuthority();
              },
              jobId: identity,
            },
          );
          break;
        } catch (error) {
          if (
            !(error instanceof PrivateIndexError) ||
            error.code !== "ref_conflict"
          ) {
            throw error;
          }
          const refusal = () =>
            new PrivateIndexError("ref_conflict", error.stderr, {
              commitSha: error.commitSha,
              attempts: publicationAttempts,
            });
          if (publicationAttempts >= PUBLICATION_MAX_ATTEMPTS) throw refusal();
          const advance = await classifyFrozenHeadAdvance(
            publicationFrozen,
            worktree,
            git,
          );
          if (advance.kind !== "non_overlapping") throw refusal();

          const random = Math.min(
            1,
            Math.max(0, (deps.publicationRetryRandom ?? Math.random)()),
          );
          const delay =
            PUBLICATION_RETRY_JITTER_MIN_MS +
            random * PUBLICATION_RETRY_JITTER_SPAN_MS;
          await (
            deps.publicationRetrySleep ??
            ((ms: number) =>
              new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(delay);

          await verifyFrozenSurface(
            publicationFrozen,
            worktree,
            git,
            deps.privateIndexFs,
          );
          await verifyFrozenPublicationBaseline(
            publicationFrozen,
            worktree,
            git,
            deps.privateIndexFs,
          );
          const replacement = await createFrozenPrivateIndex(
            worktree,
            publicationFrozen.paths,
            git,
            deps.privateIndexFs,
          );
          const latestAdvance = await classifyFrozenHeadAdvance(
            publicationFrozen,
            worktree,
            git,
          );
          if (
            latestAdvance.kind !== "non_overlapping" ||
            latestAdvance.head !== replacement.expectedHead
          ) {
            cleanupPrivateIndex(replacement, deps.privateIndexFs);
            throw refusal();
          }
          if (!sameFrozenSelectedIdentity(publicationFrozen, replacement)) {
            cleanupPrivateIndex(replacement, deps.privateIndexFs);
            throw new PrivateIndexError("surface_changed");
          }
          cleanupPrivateIndex(publicationFrozen, deps.privateIndexFs);
          frozen = replacement;
        }
      }
    } catch (error) {
      if (error instanceof PublicationValidationError) {
        return { code: 1, identity, result: error.result };
      }
      const typed = error instanceof PrivateIndexError ? error : null;
      const code = typed?.code ?? "commit_failed";
      return {
        code: 1,
        identity,
        result: result("commit-work-result", code, false, {
          identity,
          stderr: capStderr(typed?.stderr),
          stderr_sample: capStderr(typed?.stderr),
          commit_sha: typed?.commitSha,
          attempts:
            typed?.attempts ??
            (code === "ref_conflict" ? publicationAttempts : undefined),
          ...resultFileFields(surface.selected),
          affected_paths: typed?.paths ? pathSample(typed.paths) : undefined,
          commit: typed?.commitSha ? { sha: typed.commitSha } : undefined,
          committed: typed?.committed || undefined,
          indeterminate: typed?.indeterminate || undefined,
          operation: typed?.operation,
          recovery:
            code === "operation_in_progress" && typed?.operation
              ? `Finish or abort the in-progress ${typed.operation} operation, then re-run keeper commit-work.`
              : undefined,
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
        }),
      };
    }

    const ambient = await reconcileAmbientAfterPublication(
      frozen,
      committed.sha,
      worktree,
      git,
    );
    const ambientWarning =
      "warning" in ambient
        ? {
            ...ambient.warning,
            detail: ambient.warning.detail?.slice(0, STDERR_LIMIT),
          }
        : undefined;
    const commitEnvelope = {
      sha: committed.sha,
      tree: committed.tree,
      files: {
        total: surface.selected.length,
        sample: pathSample(surface.selected),
      },
      identities: frozen.entries.slice(0, SAMPLE_LIMIT).map((entry) => ({
        ...entry,
        path: entry.path.slice(0, 1024),
      })),
      identity_total: frozen.entries.length,
      ...(ambientWarning
        ? { ambient_reconciliation_warning: ambientWarning }
        : {}),
    };

    // The ref is already published. A post-commit hook failure is therefore a
    // typed committed-local result; it never rewinds and never claims a push.
    if (committed.postCommitHookWarning) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "post_commit_hook_failed", false, {
          identity,
          commit_sha: committed.sha,
          ...resultFileFields(surface.selected),
          committed: true,
          pushed: false,
          stderr: capStderr(committed.postCommitHookWarning.stderr),
          stderr_sample: capStderr(committed.postCommitHookWarning.stderr),
          ambient_reconciliation_warning: ambientWarning,
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
          commit: commitEnvelope,
        }),
      };
    }

    const pushed = await (deps.push ?? pushExactCommit)(
      worktree,
      committed.sha,
      frozen.branchRef,
      git,
    );
    const pushEnvelope = pushed.success
      ? {
          ...pushed,
          branch: pushed.branch.slice(0, 1024),
          ...(!("tracking_warning" in pushed) ||
          pushed.tracking_warning === undefined
            ? {}
            : {
                tracking_warning: pushed.tracking_warning.slice(
                  0,
                  STDERR_LIMIT,
                ),
              }),
        }
      : {
          ...pushed,
          push_error:
            "push_error" in pushed
              ? pushed.push_error.slice(0, STDERR_LIMIT)
              : "unknown push failure",
        };
    if (!pushed.success) {
      return {
        code: 1,
        identity,
        result: result(
          "commit-work-result",
          pushed.pushed === null ? "push_state_indeterminate" : "push_failed",
          false,
          {
            identity,
            commit_sha: committed.sha,
            ...resultFileFields(surface.selected),
            committed: true,
            ...pushAliases(pushEnvelope),
            ambient_reconciliation_warning: ambientWarning,
            selection: selectionEnvelope(surface, identity),
            surface: surface.summary,
            commit: commitEnvelope,
            push: pushEnvelope,
          },
        ),
      };
    }
    const pushOutcome = pushed.pushed
      ? "committed_pushed"
      : "committed_push_skipped";
    return {
      code: 0,
      identity,
      result: result("commit-work-result", pushOutcome, true, {
        identity,
        commit_sha: committed.sha,
        ...resultFileFields(surface.selected),
        committed: true,
        ...pushAliases(pushEnvelope),
        ambient_reconciliation_warning: ambientWarning,
        selection: selectionEnvelope(surface, identity),
        surface: surface.summary,
        commit: commitEnvelope,
        push: pushEnvelope,
      }),
    };
  } finally {
    if (frozen !== null) cleanupPrivateIndex(frozen, deps.privateIndexFs);
    lock.release();
  }
}

let writeOut: (chunk: string) => void = (chunk) => process.stdout.write(chunk);

async function runParsed(
  args: ParsedArgs,
  deps: CommitWorkDeps,
): Promise<{ code: number; result: CommitWorkResult }> {
  let attempt: {
    code: number;
    result: CommitWorkResult;
    identity: string | null;
  };
  let effectiveArgs = args;
  try {
    effectiveArgs = expandInvocationFiles(args);
    attempt = await runAttempt(effectiveArgs, deps);
  } catch (error) {
    const usage = error instanceof UsageError;
    attempt = {
      code: usage ? 2 : 1,
      identity: null,
      result: usage
        ? result("commit-work-result", "argument_error", false, {
            message: error.message,
          })
        : result("commit-work-result", "internal_error", false, {
            detail: error instanceof Error ? error.name : "unknown",
          }),
    };
  }
  writeOut(`${JSON.stringify(attempt.result)}\n`);
  if (!effectiveArgs.previewFiles) {
    try {
      (deps.emitOutcome ?? emitCommitWorkOutcome)(
        attempt.result,
        attempt.identity,
      );
    } catch {
      // The injectable seam obeys the same fail-open contract as production.
    }
  }
  return { code: attempt.code, result: attempt.result };
}

export async function main(argv: string[]): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const envelope = result("commit-work-result", "argument_error", false, {
      message: error instanceof Error ? error.message : String(error),
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    emitCommitWorkOutcome(envelope, null);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.agentHelp) {
    process.stdout.write(AGENT_HELP);
    return;
  }
  const { code } = await runParsed(args, {});
  if (code !== 0) process.exitCode = code;
}

export async function runForTest(
  argv: string[],
  deps: CommitWorkDeps = {},
): Promise<{ code: number; stdout: string }> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const envelope = result("commit-work-result", "argument_error", false, {
      message: error instanceof Error ? error.message : String(error),
    });
    return { code: 2, stdout: `${JSON.stringify(envelope)}\n` };
  }
  const previous = writeOut;
  let stdout = "";
  writeOut = (chunk) => {
    stdout += chunk;
  };
  try {
    const { code } = await runParsed(args, {
      ...deps,
      emitOutcome: deps.emitOutcome ?? (() => {}),
    });
    return { code, stdout };
  } finally {
    writeOut = previous;
  }
}

if (import.meta.main) void main(Bun.argv.slice(3));

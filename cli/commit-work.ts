#!/usr/bin/env bun

import { waitForAttributionCaughtUp } from "../src/commit-work/attribution";
import { CommitWorkLock } from "../src/commit-work/flock";
import { type GitRunner, gitExec } from "../src/commit-work/git-exec";
import {
  IdentityConflictError,
  InvalidIdentityError,
  resolveInvocationIdentity,
} from "../src/commit-work/identity";
import { LintFailure, runScopedLint } from "../src/commit-work/lint-matrix";
import {
  cleanupPrivateIndex,
  commitFrozenPrivateIndex,
  createFrozenPrivateIndex,
  exactEntriesFromTree,
  type FrozenPrivateIndex,
  PrivateIndexError,
  type PrivateIndexFs,
  privateIndexGit,
  reconcileAmbientAfterPublication,
  reconcileAmbientIndexEntries,
  verifyFrozenSurface,
} from "../src/commit-work/private-index";
import { pushExactCommit } from "../src/commit-work/push";
import {
  analyzeReversionSweep,
  detectInProgressOperation,
  type InProgressOperation,
  isMassReversion,
  sharedCheckoutJamActive,
} from "../src/commit-work/repo-state";
import {
  type ClaimLiveness,
  type CommitWorkSurfaceSummary,
  type DirectSurfaceEvidence,
  discoverCommitWorkSurface,
  type OwnershipClaim,
  type SurfaceDiscoveryDeps,
  type SurfaceDiscoveryResult,
} from "../src/commit-work/surface";
import { emitCommitWorkOutcome } from "../src/commit-work/telemetry";

const HELP = `keeper commit-work [MSG] [options]

Commit only work owned by this invocation through an isolated Git index.
Preview explains the complete dirty surface. Attribution gaps are covered with
explicit, invocation-local adoption; adoption never creates a durable claim.

Options:
  --session-id <uuid>  Invocation identity (must agree with non-empty env carriers)
  --adopt <path>       Adopt one exact dirty path; repeat for multiple paths
  --preview-files      Emit an advisory surface envelope; make no commit
  --max-files <n>      Refuse a selected set larger than n (default 500; 0 disables)
  --allow-stale-unstage
                       Unstage ambient paths outside the selected set
  --override-jam       Proceed past a shared-checkout jam
  --allow-mass-reversion
                       Proceed past an intentional bulk reversion
  --help, -h           Show this help

A coverage gap is resolved by re-running with --adopt <path>. Lint failures are
fixed in the live worktree and retried through keeper commit-work; never bypass
hooks or use --no-verify.
`;

const AGENT_HELP = `keeper commit-work — operator runbook

Run --preview-files first. Automatic selection is attribution-backed; add an
exact missing dirty path with repeatable --adopt <path>. Adoption is local to
this invocation and refuses a live foreign owner. Fix lint failures in the live
worktree and re-run the same command. Commit hooks and signing remain on.
`;

const FORBIDDEN_TRAILER_RE =
  /^(Job-Id:|Keeper-Commit-Id:|Session-Id:|Signed-off-by:|Planctl-Op:|Planctl-Target:|Planctl-Prev-Op:|Planctl-[A-Za-z]+:)/im;
const DEFAULT_MAX_FILES = 500;
const SAMPLE_LIMIT = 20;
const STDERR_LIMIT = 4000;

export interface ParsedArgs {
  msg: string | null;
  sessionId: string | null;
  adopt: string[];
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
  return parsed;
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
  | "surface_unavailable"
  | "ownership_conflict"
  | "ownership_ambiguous"
  | "adoption_rejected"
  | "message_required"
  | "forbidden_trailer"
  | "operation_in_progress"
  | "shared_checkout_jam"
  | "initial_commit_unsupported"
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
  | "push_failed"
  | "internal_error";

export interface CommitWorkResult {
  schema_version: 1;
  kind: "commit-work-preview" | "commit-work-result";
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
  return paths.slice(0, SAMPLE_LIMIT).map((path) => path.slice(0, 1024));
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

export interface CommitWorkDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  gitRunner?: GitRunner;
  directEvidence?: (
    identity: string | null,
    worktree: string,
  ) => DirectSurfaceEvidence | undefined;
  waitForAttribution?: (identity: string, worktree: string) => Promise<boolean>;
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
  checkSharedCheckoutJam?: (worktree: string) => boolean;
  push?: typeof pushExactCommit;
  privateIndexFs?: PrivateIndexFs;
  emitOutcome?: (result: CommitWorkResult, identity: string | null) => void;
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
      (claim) => claim.sessionId === identity,
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
): Array<{ path: string; sessions: string[] }> {
  const conflicts: Array<{ path: string; sessions: string[] }> = [];
  for (const path of selected) {
    const sessions = [
      ...new Set(
        (surface.claimsByPath.get(path) ?? [])
          .filter(
            (claim) =>
              claim.sessionId !== identity && claim.liveness !== "terminal",
          )
          .map((claim) => claim.sessionId),
      ),
    ].sort();
    if (sessions.length > 0) conflicts.push({ path, sessions });
  }
  return conflicts;
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
  if (surface.rejections.length > 0) {
    return result(
      "commit-work-result",
      conflict ? "ownership_conflict" : "adoption_rejected",
      false,
      {
        identity,
        selection: selectionEnvelope(surface, identity),
        surface: surface.summary,
      },
    );
  }
  return null;
}

async function runAttempt(
  args: ParsedArgs,
  deps: CommitWorkDeps,
): Promise<{
  code: number;
  result: CommitWorkResult;
  identity: string | null;
}> {
  const invocationKind = args.previewFiles
    ? "commit-work-preview"
    : "commit-work-result";
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

  if (identity === null && args.adopt.length === 0) {
    return {
      code: 1,
      identity,
      result: result(invocationKind, "no_session_id", false, {
        identity,
        hint: "Pass --session-id <uuid> or run from a git worktree tracked by Keeper.",
      }),
    };
  }

  const git = deps.gitRunner ?? gitExec;
  const worktree = await resolveWorktreeRoot(deps.cwd ?? process.cwd(), git);
  // Receipt evidence is an injectable extension seam, not a wired production
  // source yet. Keep the established 1.5s bounded fold-lag wait in production
  // until such a source is actually supplied.
  if (identity !== null && deps.directEvidence === undefined) {
    try {
      await (deps.waitForAttribution ?? waitForAttributionCaughtUp)(
        identity,
        worktree,
      );
    } catch {
      // Attribution waiting is bounded and fail-open; an unavailable DB must
      // not turn into an unbounded commit-work failure.
    }
  }
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
        files: advisory.selected,
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
      result: result("commit-work-preview", "preview", true, {
        identity,
        files: advisory.selected,
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
  if (FORBIDDEN_TRAILER_RE.test(args.msg)) {
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
    let jam = false;
    try {
      jam = (deps.checkSharedCheckoutJam ?? sharedCheckoutJamActive)(worktree);
    } catch {
      jam = false;
    }
    if (jam) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "shared_checkout_jam", false, {
          identity,
          recovery:
            "Resolve the shared-checkout jam, or use --override-jam only after inspecting it.",
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
    // The advisory wait does not cover time spent contending for the lock. Keep
    // the bounded wait inside the lock until direct receipts are production-wired.
    if (identity !== null && deps.directEvidence === undefined) {
      try {
        await (deps.waitForAttribution ?? waitForAttributionCaughtUp)(
          identity,
          worktree,
        );
      } catch {
        // Bounded attribution waiting remains fail-open.
      }
    }

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
      let underLockJam = false;
      try {
        underLockJam = (deps.checkSharedCheckoutJam ?? sharedCheckoutJamActive)(
          worktree,
        );
      } catch {
        underLockJam = false;
      }
      if (underLockJam) {
        return {
          code: 1,
          identity,
          result: result("commit-work-result", "shared_checkout_jam", false, {
            identity,
            recovery:
              "Resolve the shared-checkout jam, or use --override-jam only after inspecting it.",
          }),
        };
      }
    }

    // Preview is advisory. Definitive ownership discovery follows both the lock
    // and its attribution wait, then binds exact live identities.
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
          files: surface.selected,
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
          files: [],
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
            "Commit the ambient paths separately, restore them with git add, or explicitly use --allow-stale-unstage.",
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
          files: surface.selected,
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
              "Fix the reported files in the live worktree, restage as needed, then re-invoke `keeper commit-work` with the same message. A lint failure is not a coverage gap; use --adopt only for missing attribution.",
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
    if (foreignAfterLint.length > 0) {
      return {
        code: 1,
        identity,
        result: result("commit-work-result", "ownership_conflict", false, {
          identity,
          reason: "foreign_claim_after_lint",
          count: foreignAfterLint.length,
          sample: foreignAfterLint.slice(0, SAMPLE_LIMIT),
          files: surface.selected,
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
          files: surface.selected,
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
          files: surface.selected,
          selection: selectionEnvelope(postLintSurface, identity),
          surface: postLintSurface.summary,
        }),
      };
    }

    try {
      // Re-hash and compare the same selected OIDs, modes, and whole tree only
      // after the post-lint ownership read has accepted the claim set.
      await verifyFrozenSurface(frozen, worktree, git, deps.privateIndexFs);
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
    try {
      committed = await commitFrozenPrivateIndex(
        frozen,
        args.msg,
        worktree,
        git,
        deps.privateIndexFs,
        {
          beforeCommit: async () => await detect(worktree, git),
          jobId: identity,
        },
      );
    } catch (error) {
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
          files: surface.selected,
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
          files: surface.selected,
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
        result: result("commit-work-result", "push_failed", false, {
          identity,
          commit_sha: committed.sha,
          files: surface.selected,
          committed: true,
          ...pushAliases(pushEnvelope),
          ambient_reconciliation_warning: ambientWarning,
          selection: selectionEnvelope(surface, identity),
          surface: surface.summary,
          commit: commitEnvelope,
          push: pushEnvelope,
        }),
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
        files: surface.selected,
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
  try {
    attempt = await runAttempt(args, deps);
  } catch (error) {
    attempt = {
      code: 1,
      identity: null,
      result: result(
        args.previewFiles ? "commit-work-preview" : "commit-work-result",
        "internal_error",
        false,
        { detail: error instanceof Error ? error.name : "unknown" },
      ),
    };
  }
  writeOut(`${JSON.stringify(attempt.result)}\n`);
  if (!args.previewFiles) {
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

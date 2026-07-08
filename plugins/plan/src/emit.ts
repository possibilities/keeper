// Verb emit paths — the port of planctl/output.py's emit().
//
// Shapes share one commit-ordering contract (auto-commit BEFORE printing, so an
// envelope success:true on stdout means the .planctl/ commit landed):
//
//  - emitMutating: committing verbs (done). Builds the mutating invocation
//    (fail-closed session id), auto-commits, then prints ONE compact NDJSON
//    success line — or, on a commit failure, ONE compact failure line + exit 1.
//  - emitMutatingLiteral: init's committing path. Takes a HAND-BUILT literal
//    payload (no session id, no touched-log), auto-commits, prints the compact
//    NDJSON line — same ordering/failure contract, no invocation build.
//  - emitReadonly: runtime-state-only verbs (claim/block). Takes a pre-built
//    READONLY invocation (files=null), runs auto-commit (a no-op on null files,
//    so ZERO commits), then prints the same ONE compact NDJSON success line with
//    the readonly invocation embedded. This is Python emit()'s pre-built-
//    invocation branch: the auto-commit no-ops, the compact envelope prints.
//  - emitReadonlyData: init's read-only path (nothing written / non-git). No
//    invocation, no commit — formatOutput per --format. The CLI then fires the
//    generic readonly trailer on top (sentinel left unset).
//
// selfEmitted is the runtime sentinel the CLI dispatcher reads to decide whether
// to fire the generic readonly trailer — the port of output.py's
// INVOCATION_EMITTED_SENTINEL. init is the one verb whose self-emit is
// conditional (committing path sets it; read-only path leaves it false).

import {
  autoCommitFromInvocation,
  CommitFailed,
  type RollbackResult,
} from "./commit.ts";
import { compactJson, formatOutput, type OutputFormat } from "./format.ts";
import {
  buildPlanInvocation,
  type MutatingInvocation,
  type ReadonlyInvocation,
} from "./invocation.ts";

// Runtime self-emit sentinel — set when a verb prints its own NDJSON envelope
// (with the plan_invocation embedded), so the dispatcher suppresses the
// generic trailer. Reset per process invocation; read once after the verb runs.
let selfEmitted = false;

/** True iff the verb just run printed its own invocation-bearing envelope. */
export function didSelfEmit(): boolean {
  return selfEmitted;
}

/** Reset the self-emit sentinel. A compiled-binary run never needs this (the
 * sentinel lives one process), but an in-process caller (the bun:test harness's
 * runCli, which dispatches main(argv) directly) must clear it before each call
 * or the prior verb's self-emit leaks into the next. */
export function resetSelfEmit(): void {
  selfEmitted = false;
}

/** Mark that the running verb self-emitted its invocation envelope. */
function markSelfEmitted(): void {
  selfEmitted = true;
}

/** Emit the success envelope for a runtime-state-only verb with a pre-built
 * readonly invocation. autoCommitFromInvocation is a no-op on files=null (ZERO
 * commits), then the compact NDJSON envelope {success:true, ...data,
 * plan_invocation} prints. Mirrors emit() with a pre-built readonly
 * invocation. */
export function emitReadonly(
  data: Record<string, unknown>,
  invocation: ReadonlyInvocation,
): void {
  // Read-only: files=null -> no-op, never an empty commit. Kept for ordering
  // parity with emit() (auto-commit runs against every invocation it is given).
  autoCommitFromInvocation(invocation);
  const envelope = {
    success: true,
    ...data,
    plan_invocation: invocation,
  };
  markSelfEmitted();
  process.stdout.write(`${compactJson(envelope)}\n`);
}

/** The committing-seam emit path for mutating verbs. Build the plan_invocation
 * (a fail-closed session id or a bad touched-path throws, surfacing verbatim),
 * run the auto-commit BEFORE printing, then:
 *  - on a commit failure, print ONE compact line
 *    {"success":false,"error":"commit_failed","details":...,"plan_invocation":...}
 *    and process.exit(1) — the success envelope is NEVER printed;
 *  - on success, embed the invocation and print ONE compact NDJSON line
 *    {"success":true, ...data, plan_invocation}.
 * Mirrors emit()'s mutating branch + the runner's commit ordering. */
export function emitMutating(
  data: Record<string, unknown>,
  opts: {
    verb: string;
    target: string;
    detail?: string | null;
    repoRoot: string;
    primaryRepo?: string | null;
    // Optional unwind a committing verb registers to restore any state files it
    // wrote when the commit fails, so a failed commit never leaves a durable
    // half-stamp on disk (the mid-merge window). Runs BEFORE the failure envelope
    // prints; its own throw is swallowed so the authoritative commit_failed
    // envelope always surfaces. A returned RollbackResult (the unwind could not
    // fully restore the tree) is stamped into the failure details + a stderr line,
    // making a reopened destruction window visible without masking commit_failed.
    onCommitFailure?: () => RollbackResult | null;
  },
): void {
  const invocation = buildPlanInvocation(opts.verb, opts.target, opts.detail, {
    repoRoot: opts.repoRoot,
    primaryRepo: opts.primaryRepo,
  });

  try {
    autoCommitFromInvocation(invocation);
  } catch (exc) {
    if (!(exc instanceof CommitFailed)) {
      throw exc;
    }
    let rollback: RollbackResult | undefined;
    if (opts.onCommitFailure) {
      try {
        rollback = opts.onCommitFailure() ?? undefined;
      } catch {
        // Best-effort unwind — never let a restore slip mask the commit failure.
      }
    }
    const failure = {
      success: false,
      error: "commit_failed",
      details: {
        error: exc.error,
        message: exc.detail,
        ...exc.extra,
        ...(rollback ?? {}),
      },
      plan_invocation: invocation,
    };
    if (rollback) {
      // The commit failed AND the unwind could not fully restore the tree: a
      // staged / working-tree half-write may survive into a later full-index
      // merge-completion. Surface it on stderr so the reopened destruction window
      // is visible — the stdout envelope stays the authoritative commit_failed.
      process.stderr.write(
        `planctl: commit_failed rollback incomplete for ` +
          `${rollback.rollback_failed_paths.length} path(s): ` +
          `${rollback.rollback_failed_paths.join(", ")} — inspect for staged ` +
          `residue before re-running\n`,
      );
    }
    process.stdout.write(`${compactJson(failure)}\n`);
    process.exit(1);
  }

  const envelope = {
    success: true,
    ...data,
    plan_invocation: invocation,
  };
  markSelfEmitted();
  process.stdout.write(`${compactJson(envelope)}\n`);
}

/** init's committing path: a HAND-BUILT literal invocation payload (sorted file
 * list, no session_id key, no touched-log). Runs the auto-commit BEFORE printing
 * — on a commit failure print ONE compact failure line + exit 1 (success NEVER
 * printed); on success embed the literal invocation and print ONE compact NDJSON
 * line. Mirrors run_init.py's emit(planctl_invocation=payload) branch (the
 * Python kwarg name is the upstream symbol; the emitted key is plan_invocation). */
export function emitMutatingLiteral(
  data: Record<string, unknown>,
  invocation: Record<string, unknown>,
): void {
  // The literal payload carries no `session_id` key — Cast to the mutating
  // invocation shape autoCommitFromInvocation consumes (files/op/target/subject/
  // repo_root/state_repo are all present; the missing session_id key simply
  // yields no Session-Id trailer, exactly as Python's literal does).
  try {
    autoCommitFromInvocation(invocation as unknown as MutatingInvocation);
  } catch (exc) {
    if (!(exc instanceof CommitFailed)) {
      throw exc;
    }
    const failure = {
      success: false,
      error: "commit_failed",
      details: {
        error: exc.error,
        message: exc.detail,
        ...exc.extra,
      },
      plan_invocation: invocation,
    };
    markSelfEmitted();
    process.stdout.write(`${compactJson(failure)}\n`);
    process.exit(1);
  }

  const envelope = {
    success: true,
    ...data,
    plan_invocation: invocation,
  };
  markSelfEmitted();
  process.stdout.write(`${compactJson(envelope)}\n`);
}

/** init's read-only path (nothing written / non-git): no invocation, no commit.
 * Prints {success:true, ...data} via formatOutput so --format is honored, and
 * leaves the self-emit sentinel UNSET so the CLI fires the generic readonly
 * trailer afterward. Mirrors emit(data) with no plan_invocation. */
export function emitReadonlyData(
  data: Record<string, unknown>,
  format: OutputFormat | null = null,
): void {
  formatOutput({ success: true, ...data }, format);
}

// Recovery guidance keyed on the accumulate-all failure code — the plan family's
// converged error sub-object carries {code, message, details, recovery}, so an
// agent gets an actionable next step without hand-rolling one per code. An
// unlisted code falls back to DEFAULT_PLAN_RECOVERY.
const DEFAULT_PLAN_RECOVERY =
  "Fix the reported problems in the input and re-run the verb; the details " +
  "list every issue found.";

const PLAN_ERROR_RECOVERY: Record<string, string> = {
  bad_yaml:
    "The scaffold/refine YAML is malformed. Fix the reported parse or shape " +
    "error in the input and re-run the verb.",
  cell_invalid:
    "A selection cell set is invalid (an out-of-axis tier/model, or an unknown, " +
    "duplicate, missing, or non-todo task id). Correct the cells so every todo " +
    "task of the epic is covered exactly once with in-axis values, then re-run.",
  dep_cycle:
    "The task dependency graph has a cycle. Break the cycle among the listed " +
    "tasks so the graph is acyclic, then re-run.",
  dep_invalid:
    "A declared task dependency does not resolve. Correct the referenced task " +
    "id (or remove the edge) and re-run.",
  epic_dep_invalid:
    "A declared epic dependency does not resolve. Correct the referenced epic " +
    "id (or remove the edge) and re-run.",
  duplicate_epic:
    "An epic with this slug already exists. Choose a distinct slug, or pass " +
    "--allow-duplicate to intentionally create a sibling.",
  id_collision:
    "A generated id collides with an existing artifact. Re-run with a distinct " +
    "slug or id.",
  integrity_failed:
    "The post-write integrity check failed and the write was not committed. " +
    "Re-run the verb; if it persists, inspect the reported artifacts.",
  merge_in_progress:
    "The plan state repo is mid-operation (a merge/cherry-pick/revert/rebase, " +
    "or the shared commit-work lock is held by a concurrent commit/base-merge). " +
    "Nothing was written — wait for it to finish, then re-run the verb.",
  target_invalid:
    "The target id is not well-formed or does not exist. Correct the target " +
    "and re-run.",
  spec_invalid:
    "A task or epic spec field is missing or malformed. Fix the reported spec " +
    "field and re-run.",
  model_invalid:
    "The declared model is not recognized. Set a supported model value and " +
    "re-run.",
  tier_invalid:
    "The declared tier is out of range. Set a supported tier value and re-run.",
  repo_invalid:
    "The repo path is not a valid git repo root. Correct the repo path and " +
    "re-run.",
  missing_session_id:
    "No session id is available for this mutating verb. Ensure the invocation " +
    "carries a session id and re-run.",
};

/** Resolve the recovery string for a plan failure code (fallback on an unlisted
 * code). Exposed so the problem-code registry doc and callers stay in sync. */
export function recoveryForPlanCode(code: string): string {
  return PLAN_ERROR_RECOVERY[code] ?? DEFAULT_PLAN_RECOVERY;
}

/** The accumulate-all failure emit path — the port of run_scaffold._emit_failure.
 * Prints ONE compact NDJSON line
 *   {"success":false,"error":{"code","message","details":[strings],"recovery"}}
 * BYPASSING the invocation builder (a pre-commit failure has no invocation to
 * embed) — a sibling of the landed emit paths, never a modification of them.
 * Scaffold / refine-apply accumulate every error across buckets and emit one
 * envelope describing the dominant code with all details; this is that single
 * write. `recovery` defaults to the code registry but a caller may override it.
 * Does NOT exit on its own — the caller returns the non-zero code so the
 * dispatcher owns process exit. */
export function emitFailureEnvelope(
  code: string,
  message: string,
  details: string[],
  recovery: string = recoveryForPlanCode(code),
): void {
  const envelope = {
    success: false,
    error: { code, message, details, recovery },
  };
  process.stdout.write(`${compactJson(envelope)}\n`);
}

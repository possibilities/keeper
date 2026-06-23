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

import { autoCommitFromInvocation, CommitFailed } from "./commit.ts";
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
    queueJump?: boolean;
  },
): void {
  const invocation = buildPlanInvocation(opts.verb, opts.target, opts.detail, {
    repoRoot: opts.repoRoot,
    primaryRepo: opts.primaryRepo,
    queueJump: opts.queueJump,
  });

  try {
    autoCommitFromInvocation(invocation);
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

/** The accumulate-all failure emit path — the port of run_scaffold._emit_failure.
 * Prints ONE compact NDJSON line
 *   {"success":false,"error":{"code","message","details":[strings]}}
 * BYPASSING the invocation builder (a pre-commit failure has no invocation to
 * embed) — a sibling of the landed emit paths, never a modification of them.
 * Scaffold / refine-apply accumulate every error across buckets and emit one
 * envelope describing the dominant code with all details; this is that single
 * write. Does NOT exit on its own — the caller returns the non-zero code so the
 * dispatcher owns process exit. */
export function emitFailureEnvelope(
  code: string,
  message: string,
  details: string[],
): void {
  const envelope = {
    success: false,
    error: { code, message, details },
  };
  process.stdout.write(`${compactJson(envelope)}\n`);
}

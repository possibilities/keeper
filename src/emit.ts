// Verb emit paths — the port of planctl/output.py's emit().
//
// Two shapes share one commit-ordering contract (auto-commit BEFORE printing,
// so an envelope success:true on stdout means the .planctl/ commit landed):
//
//  - emitMutating: committing verbs (done/init). Builds the mutating invocation
//    (fail-closed session id), auto-commits, then prints ONE compact NDJSON
//    success line — or, on a commit failure, ONE compact failure line + exit 1.
//  - emitReadonly: runtime-state-only verbs (claim/block). Takes a pre-built
//    READONLY invocation (files=null), runs auto-commit (a no-op on null files,
//    so ZERO commits), then prints the same ONE compact NDJSON success line with
//    the readonly invocation embedded. This is Python emit()'s pre-built-
//    invocation branch: the auto-commit no-ops, the compact envelope prints.

import { autoCommitFromInvocation, CommitFailed } from "./commit.ts";
import { compactJson } from "./format.ts";
import {
  buildPlanctlInvocation,
  type ReadonlyInvocation,
} from "./invocation.ts";

/** Emit the success envelope for a runtime-state-only verb with a pre-built
 * readonly invocation. autoCommitFromInvocation is a no-op on files=null (ZERO
 * commits), then the compact NDJSON envelope {success:true, ...data,
 * planctl_invocation} prints. Mirrors emit() with a pre-built readonly
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
    planctl_invocation: invocation,
  };
  process.stdout.write(`${compactJson(envelope)}\n`);
}

/** The committing-seam emit path for mutating verbs. Build the planctl_invocation
 * (a fail-closed session id or a bad touched-path throws, surfacing verbatim),
 * run the auto-commit BEFORE printing, then:
 *  - on a commit failure, print ONE compact line
 *    {"success":false,"error":"commit_failed","details":...,"planctl_invocation":...}
 *    and process.exit(1) — the success envelope is NEVER printed;
 *  - on success, embed the invocation and print ONE compact NDJSON line
 *    {"success":true, ...data, planctl_invocation}.
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
  const invocation = buildPlanctlInvocation(
    opts.verb,
    opts.target,
    opts.detail,
    {
      repoRoot: opts.repoRoot,
      primaryRepo: opts.primaryRepo,
      queueJump: opts.queueJump,
    },
  );

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
      planctl_invocation: invocation,
    };
    process.stdout.write(`${compactJson(failure)}\n`);
    process.exit(1);
  }

  const envelope = {
    success: true,
    ...data,
    planctl_invocation: invocation,
  };
  process.stdout.write(`${compactJson(envelope)}\n`);
}

#!/usr/bin/env bun

/**
 * `keeper session <state|files|events|summary>` — the session-scoped read group.
 * Each verb maps to its own leaf main (`cli/{session-state,show-session-files,
 * show-session-events,session-summary}.ts`). The leaves share Session-reference
 * resolution while retaining their established success payloads.
 *
 * The leaf mains are lazy-imported ONLY on the dispatch path, so group `--help`
 * (and the help-purity walk) never boots a leaf or opens keeper.db. Each leaf
 * owns its own `--help`, so a verb's `--help` renders that leaf's help. An
 * unknown verb is an argument fault (exit 2).
 */

import { clearDeadSessionMarker } from "../plugins/plan/src/session_markers.ts";
import type { OwnershipClaim } from "../src/commit-work/surface";
import type { SessionTerminationResult, TerminableSession } from "./agent";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  successEnvelope,
} from "./envelope";
import type { LoadedTrackedSessionResolution } from "./session-reference";

interface Subverb {
  readonly summary: string;
  readonly run: (rest: string[]) => void | Promise<void>;
}

/** Authority row backing a release: the exact recorded process of a working session. */
interface ReleaseAuthorityRow {
  state: string;
  harness: string;
  pid: number;
  startTime: string;
}

export interface ReleaseDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  dir?: string;
  sink?: EnvelopeSink;
  gitToplevel?: (cwd: string) => string | null;
  readClaims?: (
    worktree: string,
  ) => OwnershipClaim[] | null | Promise<OwnershipClaim[] | null>;
  readAuthority?: (
    identity: string,
  ) => ReleaseAuthorityRow | null | Promise<ReleaseAuthorityRow | null>;
  descendsFrom?: (pid: number, startTime: string) => Promise<boolean>;
}

/** Registration order is the help/listing order. */
const SUBVERBS: Record<string, Subverb> = {
  state: {
    summary: "Current session git context + on-hook files (JSON)",
    run: async (rest) => (await import("./session-state")).main(rest),
  },
  files: {
    summary: "Session's on-hook dirty files grouped by repo (JSON)",
    run: async (rest) => (await import("./show-session-files")).main(rest),
  },
  events: {
    summary: "Prompt/tool-call spine for one session (JSON)",
    run: async (rest) => (await import("./show-session-events")).main(rest),
  },
  summary: {
    summary: "Bounded one-shot summary of one session (JSON)",
    run: async (rest) => (await import("./session-summary")).main(rest),
  },
  terminate: {
    summary: "Identity-rechecked TERM-then-KILL of a non-working session",
    run: terminateMain,
  },
  release: {
    summary: "Voluntarily release named paths so a blocked peer can adopt them",
    run: (rest) => releaseMain(rest),
  },
};

const VERB_WIDTH = Math.max(...Object.keys(SUBVERBS).map((v) => v.length));
const VERB_LINES = Object.entries(SUBVERBS)
  .map(([name, spec]) => `  ${name.padEnd(VERB_WIDTH)}  ${spec.summary}`)
  .join("\n");

const TERMINATE_HELP = `keeper session terminate <session-reference>

Resolve one tracked Session, refuse a working Session, then re-check its exact
pid, start time, and harness command before TERM and before bounded KILL.
This signals only the process and never writes keeper.db.
`;

export interface TerminateMainDeps {
  resolveTrackedCliSession?: (
    reference: string,
  ) => LoadedTrackedSessionResolution;
  terminateSessionProcess?: (
    session: TerminableSession,
  ) => Promise<SessionTerminationResult>;
  sink?: EnvelopeSink;
}

export async function terminateMain(
  argv: string[],
  deps: TerminateMainDeps = {},
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(TERMINATE_HELP);
    return;
  }
  if (argv.length !== 1 || argv[0] === "") {
    process.stderr.write(
      `${TERMINATE_HELP}\nExpected exactly one Session reference.\n`,
    );
    process.exit(2);
  }
  const { resolveTrackedCliSession, trackedSessionProblem } = await import(
    "./session-reference"
  );
  const resolution =
    deps.resolveTrackedCliSession?.(argv[0] as string) ??
    resolveTrackedCliSession(argv[0] as string);
  if (resolution.kind !== "resolved") {
    emitEnvelope(
      errorEnvelope(1, trackedSessionProblem(resolution)),
      deps.sink ?? processEnvelopeSink,
    );
    return;
  }
  const { terminateSessionProcess } = await import("./agent");
  const result = await (
    deps.terminateSessionProcess ?? terminateSessionProcess
  )({
    jobId: resolution.job.jobId,
    state: resolution.job.state,
    harness: resolution.job.harness,
    pid: resolution.job.pid,
    startTime: resolution.job.startTime,
  });
  if (result.ok) {
    clearDeadSessionMarker(resolution.job.jobId);
    emitEnvelope(
      successEnvelope(1, {
        job_id: resolution.job.jobId,
        pid: resolution.job.pid,
        signal: result.signal,
        exited: result.exited,
        database_written: false,
      }),
      deps.sink ?? processEnvelopeSink,
    );
    return;
  }
  const problems = {
    working: {
      code: "session_working",
      message: "the resolved Session is working and cannot be terminated",
      recovery:
        "Let the Session finish or stop before retrying; do not terminate active work.",
    },
    identity_unproven: {
      code: "session_identity_unproven",
      message: "the recorded process identity could not be confirmed",
      recovery:
        "Refresh the Session state and retry only when its pid-and-start-time witness is readable.",
    },
    command_unowned: {
      code: "session_command_unowned",
      message:
        "the recorded process does not identify as the Session's harness command",
      recovery:
        "Do not signal the pid; inspect the Session record for stale or recycled process identity. A stopped managed Session remains eligible for the daemon's identity-rechecked reap path.",
    },
    signal_failed: {
      code: "session_signal_failed",
      message: "the identity-confirmed Session process could not be signaled",
      recovery:
        "Check process permissions and current identity, then retry from a fresh Session resolution.",
    },
  } as const;
  emitEnvelope(
    errorEnvelope(1, problems[result.reason]),
    deps.sink ?? processEnvelopeSink,
  );
}

const RELEASE_HELP = `keeper session release <path> [<path>...] [--session-id <uuid>] [--worktree <path>]

Voluntarily release named paths held under this session's Exclusive file claim
so a blocked peer's next commit-work classifies exactly those paths adoptable —
the cooperative third out beside waiting for or terminating the claimant.

The current session proves its own recycle-safe identity (pid + start time, the
same ancestry proof commit-work uses) and is the sole writer of its durable,
size-bounded release record. The record self-fences: this session's own later
commit-work excludes the released paths from its owned set. Unreleased paths
stay protected. Only YOU can judge a path is safe to give away — the verb
validates identity and record shape, never whether your in-flight work still
depends on the path. This never signals the peer and never writes keeper.db.
`;

function releaseProblem(
  code: string,
  message: string,
  recovery: string,
): Parameters<typeof errorEnvelope>[1] {
  return { code, message, recovery };
}

async function defaultReadReleaseAuthority(
  identity: string,
): Promise<ReleaseAuthorityRow | null> {
  const { openDb, defaultDbPath } = await import("../src/db");
  const { db } = openDb(defaultDbPath(), { readonly: true });
  try {
    const row = db
      .query(
        "SELECT state, harness, pid, start_time FROM jobs WHERE job_id = ?",
      )
      .get(identity) as {
      state: unknown;
      harness: unknown;
      pid: unknown;
      start_time: unknown;
    } | null;
    if (
      row?.state !== "working" ||
      (row.harness !== "claude" && row.harness !== "pi") ||
      typeof row.pid !== "number" ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 1 ||
      typeof row.start_time !== "string" ||
      row.start_time.length === 0
    ) {
      return null;
    }
    return {
      state: row.state,
      harness: row.harness,
      pid: row.pid,
      startTime: row.start_time,
    };
  } finally {
    db.close();
  }
}

function defaultGitToplevel(cwd: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success || result.exitCode !== 0) return null;
    const top = result.stdout.toString().trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

export async function releaseMain(
  argv: string[],
  deps: ReleaseDeps = {},
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(RELEASE_HELP);
    return;
  }
  const sink = deps.sink ?? processEnvelopeSink;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  let sessionIdFlag: string | null = null;
  let worktreeFlag: string | null = null;
  let worktreeSupplied = false;
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--session-id") {
      sessionIdFlag = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--session-id=")) {
      sessionIdFlag = arg.slice("--session-id=".length);
    } else if (arg === "--worktree") {
      worktreeSupplied = true;
      worktreeFlag = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--worktree=")) {
      worktreeSupplied = true;
      worktreeFlag = arg.slice("--worktree=".length);
    } else if (arg === "--") {
      inputs.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`${RELEASE_HELP}\nUnknown option '${arg}'.\n`);
      process.exit(2);
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) {
    process.stderr.write(`${RELEASE_HELP}\nExpected at least one path.\n`);
    process.exit(2);
  }

  const { resolveInvocationIdentity } = await import(
    "../src/commit-work/identity"
  );
  let identity: string | null;
  try {
    identity = resolveInvocationIdentity(sessionIdFlag, env).value;
  } catch (error) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "invalid_identity",
          `invocation identity could not be resolved: ${(error as Error).message}`,
          "Pass a single valid --session-id <uuid> or run inside a tracked session.",
        ),
      ),
      sink,
    );
    return;
  }
  if (identity === null) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "no_session_id",
          "no invocation identity resolved for this release",
          "Pass --session-id <uuid> or run inside a tracked harness session.",
        ),
      ),
      sink,
    );
    return;
  }

  const readAuthority = deps.readAuthority ?? defaultReadReleaseAuthority;
  const row = await readAuthority(identity);
  if (row === null) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "session_identity_unproven",
          "this session is not a working, tracked harness session",
          "Release only from the live session that owns the paths; a peer can never release another session's claims.",
        ),
      ),
      sink,
    );
    return;
  }

  const { invocationDescendsFrom } = await import(
    "../src/commit-work/process-identity"
  );
  const descendsFrom = deps.descendsFrom ?? invocationDescendsFrom;
  if (!(await descendsFrom(row.pid, row.startTime))) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "session_identity_unproven",
          "the current process does not descend from the recorded session process",
          "Run the release from within the owning session's own process tree.",
        ),
      ),
      sink,
    );
    return;
  }

  const {
    canonicalizeAdoptedPath,
    claimIsExclusiveOwnership,
    defaultReadClaims,
    writeReleaseRecord,
    defaultReleaseRecordDir,
  } = await import("../src/commit-work/surface");
  const { isAbsolute, resolve } = await import("node:path");
  const gitToplevel = deps.gitToplevel ?? defaultGitToplevel;
  const cwdWorktree = gitToplevel(cwd);
  let worktree = cwdWorktree ?? cwd;
  if (worktreeSupplied) {
    const requestedWorktree =
      worktreeFlag === null || worktreeFlag.length === 0
        ? null
        : resolve(cwd, worktreeFlag);
    if (
      cwdWorktree === null ||
      requestedWorktree === null ||
      requestedWorktree !== resolve(cwd, cwdWorktree)
    ) {
      emitEnvelope(
        errorEnvelope(
          1,
          releaseProblem(
            "worktree_mismatch",
            "--worktree does not match the invoking cwd's git worktree",
            "Run the release from the claimant's worktree and pass that same worktree with --worktree.",
          ),
        ),
        sink,
      );
      return;
    }
    worktree = cwdWorktree;
  }

  const canonicalized: Array<{ input: string; path: string }> = [];
  const rejected: Array<{ input: string; code: string }> = [];
  for (const input of inputs) {
    const absolute = isAbsolute(input) ? input : resolve(cwd, input);
    const result = canonicalizeAdoptedPath(worktree, absolute);
    if ("code" in result) {
      rejected.push({ input, code: result.code });
      continue;
    }
    canonicalized.push({ input, path: result.path });
  }
  if (canonicalized.length === 0) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "no_releasable_paths",
          "no named path canonicalized inside this worktree",
          "Name paths inside the current worktree; nothing was released.",
        ),
      ),
      sink,
    );
    return;
  }

  let claims: OwnershipClaim[] | null;
  try {
    claims = await (deps.readClaims ?? defaultReadClaims)(worktree);
  } catch {
    claims = null;
  }
  if (claims === null) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "claim_evidence_unavailable",
          "exclusive ownership claims could not be read for this worktree",
          "Retry when claim evidence is available; nothing was released.",
        ),
      ),
      sink,
    );
    return;
  }

  const released: string[] = [];
  for (const candidate of canonicalized) {
    const claimed = claims.some(
      (claim) =>
        claim.path === candidate.path &&
        claim.sessionId === identity &&
        claim.liveness === "live" &&
        claimIsExclusiveOwnership(claim),
    );
    if (!claimed) {
      rejected.push({ input: candidate.input, code: "no_live_owned_claim" });
      continue;
    }
    released.push(candidate.path);
  }
  if (released.length === 0) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "no_live_owned_claims",
          `none of the named paths has a live exclusive claim held by this session in worktree ${worktree}`,
          "Run the release from the worktree holding this session's live claims; nothing was released.",
        ),
      ),
      sink,
    );
    return;
  }

  let written: ReturnType<typeof writeReleaseRecord>;
  try {
    written = writeReleaseRecord({
      sessionId: identity,
      pid: row.pid,
      startTime: row.startTime,
      worktree,
      paths: released,
      dir: deps.dir ?? defaultReleaseRecordDir(),
    });
  } catch (error) {
    emitEnvelope(
      errorEnvelope(
        1,
        releaseProblem(
          "release_write_failed",
          `the release record could not be written: ${(error as Error).message}`,
          "Check state-dir permissions and disk, then retry; nothing was released.",
        ),
      ),
      sink,
    );
    return;
  }

  emitEnvelope(
    successEnvelope(1, {
      session_id: identity,
      worktree,
      released: [...written.record.paths].sort(),
      rejected,
      record: written.file,
      database_written: false,
    }),
    sink,
  );
}

const HELP = `keeper session — session-scoped reads and process control

Usage:
  keeper session <${Object.keys(SUBVERBS).join("|")}> [<session-reference>] [options]

Verbs:
${VERB_LINES}

Run 'keeper session <verb> --help' for a verb's options. Every verb emits JSON
on stdout; reads and terminate use no daemon RPC, commit, or lock.
`;

export async function main(argv: string[]): Promise<void> {
  const verb = argv[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const spec = SUBVERBS[verb];
  if (spec === undefined) {
    process.stderr.write(`keeper session: unknown verb '${verb}'\n\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }
  await spec.run(argv.slice(1));
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}

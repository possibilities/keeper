#!/usr/bin/env bun
/**
 * `keeper session state` — emit the current session's git context (branch,
 * head sha, porcelain status, recent log) plus its on-hook dirty file list as a
 * pretty JSON envelope. The native port of jobctl's `run_session_state.py`
 * (epic fn-715 task 3).
 *
 * Purely informational — NO flock (a momentary inconsistency is fine). Combines:
 *   - `status_porcelain` — raw `git status --porcelain=v2 --branch` stdout.
 *   - `log_oneline`      — raw `git log -<N> --oneline` stdout (default N=5).
 *   - `head_sha`         — full HEAD SHA, or `null` in an empty repo.
 *   - `branch`           — current branch, or `null` on detached HEAD.
 *   - `session_files`    — repo-relative on-hook dirty paths (cwd repo, minus
 *     the `.keeper/` board) via task 1's attribution reader. A DB hiccup degrades this to
 *     `[]` (the Python's bare-except swallow) — NEVER throws the verb.
 *
 * Null parity is load-bearing: an empty repo's `head_sha` and a detached HEAD's
 * `branch` are JSON `null`, NOT `""` and NOT a throw.
 */

import type { AttributionDeps } from "../src/commit-work/attribution";
import { discoverSessionFiles } from "../src/commit-work/attribution";
import { type GitRunner, gitExec } from "../src/commit-work/git-exec";
import { resolveSessionId } from "../src/commit-work/session-id";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
} from "./envelope";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference";

export const SESSION_STATE_SCHEMA_VERSION = 1;

/**
 * Injectable seams for {@link run} / {@link buildSessionState}. Production omits
 * them (the real `git` runner + DB-backed attribution); tests inject a faked git
 * runner + synthetic `discoverSessionFiles` deps so the verb's DECISIONS (null
 * parity, the envelope shape, the attribution swallow) are exercised in-process
 * with ZERO real git.
 */
export interface SessionStateDeps {
  /** Git runner threaded into every git read. Defaults to the real {@link gitExec}. */
  gitRunner?: GitRunner;
  /** Attribution deps forwarded to {@link discoverSessionFiles}. */
  attribution?: AttributionDeps;
  /** Ambient id carriers used only by the zero-reference auto-detection path. */
  env?: Record<string, string | undefined>;
}

export type SessionStateMainDeps = SessionStateDeps & SessionReferenceCliDeps;

const HELP = `keeper session state [<session-reference>] [options]

Emit git context plus on-hook dirty files for one shared Session reference.
Qualified native ids, exact job/native ids, and exact current/historical titles
are accepted. With no reference, the existing ambient id auto-detection remains.

Options:
  --session <ref>       Shared Session reference (alternative to positional)
  --session-id <ref>    Compatibility alias of --session
  --log-count <n>       Number of log lines (default 5)
  --help, -h            Show this help
`;

interface ParsedArgs {
  sessionReference: string | null;
  logCount: number;
  help: boolean;
}

const DEFAULT_LOG_COUNT = 5;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sessionReference: null,
    logCount: DEFAULT_LOG_COUNT,
    help: false,
  };
  const setReference = (value: string | undefined, spelling: string): void => {
    if (value === undefined || value.length === 0) {
      process.stderr.write(
        `keeper session state: ${spelling} requires a value\n`,
      );
      process.exit(2);
    }
    if (parsed.sessionReference !== null) {
      process.stderr.write(
        "keeper session state: specify the Session reference only once\n",
      );
      process.exit(2);
    }
    parsed.sessionReference = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--session" || a === "--session-id") {
      setReference(argv[++i], a);
    } else if (a.startsWith("--session=") || a.startsWith("--session-id=")) {
      const spelling = a.startsWith("--session-id=")
        ? "--session-id"
        : "--session";
      setReference(a.slice(a.indexOf("=") + 1), spelling);
    } else if (a === "--log-count") {
      parsed.logCount = parseLogCount(argv[++i]);
    } else if (a.startsWith("--log-count=")) {
      parsed.logCount = parseLogCount(a.slice("--log-count=".length));
    } else if (!a.startsWith("-")) {
      setReference(a, "<session-reference>");
    } else {
      process.stderr.write(
        `keeper session state: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseLogCount(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write(
      "keeper session state: --log-count requires a value\n",
    );
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `keeper session state: --log-count must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

/** Full HEAD SHA, or `null` in an empty repo (no commits yet). */
async function getHeadSha(git: GitRunner, cwd: string): Promise<string | null> {
  const res = await git(["rev-parse", "HEAD"], { cwd });
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * Current branch name, or `null` on detached HEAD. `git symbolic-ref --short
 * HEAD` exits non-zero on a detached HEAD (and an empty repo before the first
 * commit, which keeps the same null shape).
 */
async function getBranch(git: GitRunner, cwd: string): Promise<string | null> {
  const res = await git(["symbolic-ref", "--short", "HEAD"], { cwd });
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

/** Raw `git status --porcelain=v2 --branch` stdout. */
async function getStatusPorcelain(
  git: GitRunner,
  cwd: string,
): Promise<string> {
  const res = await git(["status", "--porcelain=v2", "--branch"], { cwd });
  return res.stdout;
}

/** Raw `git log -<count> --oneline` stdout. */
async function getLogOneline(
  git: GitRunner,
  cwd: string,
  count: number,
): Promise<string> {
  const res = await git(["log", `-${count}`, "--oneline"], { cwd });
  return res.stdout;
}

/** The JSON envelope `session-state` emits. */
export interface SessionStateEnvelope {
  success: true;
  status_porcelain: string;
  log_oneline: string;
  head_sha: string | null;
  branch: string | null;
  session_files: string[];
}

/**
 * Build the session-state envelope. The git boundary is the threaded
 * {@link GitRunner} (defaulting to the real {@link gitExec}); attribution reads
 * the sandboxed DB via {@link discoverSessionFiles} (injectable deps). Exported
 * so tests assert the verb's decisions in-process with a faked runner.
 */
export async function buildSessionState(
  args: { sessionId: string | null; logCount: number; cwd?: string },
  deps: SessionStateDeps = {},
): Promise<SessionStateEnvelope> {
  const git = deps.gitRunner ?? gitExec;
  const cwd = args.cwd ?? process.cwd();
  const sessionId = resolveSessionId(args.sessionId, deps.env);

  // The Python wraps discover_files in a bare `except` so a DB hiccup degrades
  // to `[]` instead of throwing the verb. Mirror that exactly — attribution is
  // informational here, never load-bearing.
  let sessionFiles: string[] = [];
  if (sessionId !== null) {
    try {
      sessionFiles = discoverSessionFiles(sessionId, cwd, deps.attribution);
    } catch {
      sessionFiles = [];
    }
  }

  const headSha = await getHeadSha(git, cwd);
  const branch = await getBranch(git, cwd);
  const statusPorcelain = await getStatusPorcelain(git, cwd);
  const logOneline = await getLogOneline(git, cwd, args.logCount);

  return {
    success: true,
    status_porcelain: statusPorcelain,
    log_oneline: logOneline,
    head_sha: headSha,
    branch,
    session_files: sessionFiles,
  };
}

export async function main(
  argv: string[],
  deps: SessionStateMainDeps = {},
  sink: EnvelopeSink = processEnvelopeSink,
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    sink.writeStdout(HELP);
    return;
  }

  let jobId: string | null = null;
  let targetCwd = process.cwd();
  if (args.sessionReference !== null) {
    const resolution = resolveTrackedCliSession(args.sessionReference, deps);
    if (resolution.kind !== "resolved") {
      emitEnvelope(
        errorEnvelope(
          SESSION_STATE_SCHEMA_VERSION,
          trackedSessionProblem(resolution),
        ),
        sink,
      );
      return;
    }
    jobId = resolution.job.jobId;
    targetCwd =
      resolution.job.project ?? resolution.session.project ?? targetCwd;
  }

  const stateDeps: SessionStateDeps =
    deps.dbPath !== undefined && deps.attribution?.dbPath === undefined
      ? {
          ...deps,
          attribution: { ...deps.attribution, dbPath: deps.dbPath },
        }
      : deps;
  const value = await buildSessionState(
    { sessionId: jobId, logCount: args.logCount, cwd: targetCwd },
    stateDeps,
  );
  sink.writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}

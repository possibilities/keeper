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
}

const HELP = `keeper session state [options]

Emit the current session's git context (branch, head sha, porcelain status,
recent log) plus its on-hook dirty files as a pretty JSON envelope. Purely
informational — no commit, no lock.

Options:
  --session-id <id>    Claude Code session id (auto-resolved if omitted)
  --log-count <n>      Number of log lines (default 5)
  --help, -h           Show this help
`;

interface ParsedArgs {
  sessionId: string | null;
  logCount: number;
  help: boolean;
}

const DEFAULT_LOG_COUNT = 5;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sessionId: null,
    logCount: DEFAULT_LOG_COUNT,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--session-id") {
      parsed.sessionId = argv[++i] ?? null;
    } else if (a.startsWith("--session-id=")) {
      parsed.sessionId = a.slice("--session-id=".length);
    } else if (a === "--log-count") {
      parsed.logCount = parseLogCount(argv[++i]);
    } else if (a.startsWith("--log-count=")) {
      parsed.logCount = parseLogCount(a.slice("--log-count=".length));
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

/** Emit a pretty (`indent=2`, trailing `\n`) JSON envelope. */
function printPretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  args: { sessionId: string | null; logCount: number },
  deps: SessionStateDeps = {},
): Promise<SessionStateEnvelope> {
  const git = deps.gitRunner ?? gitExec;
  const cwd = process.cwd();
  const sessionId = resolveSessionId(args.sessionId);

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

async function run(args: ParsedArgs): Promise<number> {
  printPretty(
    await buildSessionState({
      sessionId: args.sessionId,
      logCount: args.logCount,
    }),
  );
  return 0;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const code = await run(args);
  if (code !== 0) process.exit(code);
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}

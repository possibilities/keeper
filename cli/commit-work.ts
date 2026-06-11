#!/usr/bin/env bun
/**
 * `keeper commit-work` — stage session-attributed dirty files, run the polyglot
 * lint matrix, commit with a `Job-Id:` trailer, and push. The native port of
 * jobctl's `run_commit_work.py` (epic fn-715).
 *
 * Pipeline (parity with the Python `run()`):
 *   resolve session-id (fail+exit 1, never a silent no-op)
 *     → discover session-attributed dirty files (src/commit-work/attribution)
 *     → gitignore-filter (`git check-ignore -z --stdin`, fail-open ≥128)
 *     → `--max-files` guard on the POST-filter count (default 500, 0 disables)
 *     → `--preview-files` branch (pretty envelope, NO lock, NO commit)
 *     → require message · sanitize (`_FORBIDDEN_TRAILER_RE`, multi-line only)
 *     → no-files branch (pretty `committed:false`)
 *     → acquire flock ($GIT_COMMON_DIR/keeper-commit-work.lock)
 *       → `git add -A -- <pathspecs>` (pathspec-scoped; deletions stage as removals)
 *       → unstage stale (`all_staged − caller_files`) BEFORE lint
 *       → lint matrix (src/commit-work/lint-matrix) — fail → release + emit
 *       → sanitize-safe `git commit -F -` with appended `Job-Id:` trailer
 *       → NDJSON line 1 (COMPACT `{success,commit_sha,files}`)
 *       → push (src/commit-work/push) → NDJSON line 2 (compact push envelope)
 *     → release flock (every path, no double-release)
 *
 * **Byte-parity envelopes.** Python emits two distinct JSON shapes:
 *   - bare `print(json.dumps(...))` — COMPACT, single line, Python's default
 *     `", "`/`": "` separators, `ensure_ascii=True`, plus a trailing `\n`. Used
 *     for the two NDJSON lines and EVERY error envelope. {@link printCompact}.
 *   - `format_output(...)` → `json_dumps` — pretty `indent=2`,
 *     `ensure_ascii=False`, trailing `\n`. Used for `--preview-files` and the
 *     no-files `committed:false` envelope. {@link printPretty}.
 * Line-oriented consumers (planctl, the worker dispatch) depend on the compact
 * two-line form — these serializers reproduce Python's exact bytes.
 */

import { existsSync } from "node:fs";
import { discoverSessionFiles } from "../src/commit-work/attribution";
import { CommitWorkLock } from "../src/commit-work/flock";
import { gitExec } from "../src/commit-work/git-exec";
import { LintFailure, runScopedLint } from "../src/commit-work/lint-matrix";
import { pushCommitted } from "../src/commit-work/push";
import { resolveSessionId } from "../src/commit-work/session-id";

const HELP = `keeper commit-work [MSG] [options]

Stage session-touched work files, run the lint matrix, commit, and push.
Always run \`--preview-files\` first to inspect the file list. .planctl/**
files are excluded (they commit via the planctl-commit hook). Untracked
gitignored files are filtered before staging; a runaway file list
(> --max-files, default 500) aborts with a file_list_too_large envelope.

Arguments:
  MSG                  Commit message (required unless --preview-files)

Options:
  --session-id <id>    Claude Code session id (auto-resolved if omitted)
  --preview-files      List files that would be committed; no commit is made
  --max-files <n>      Abort when the post-filter file count exceeds <n>
                       (default 500; pass 0 to disable)
  --help, -h           Show this help

Escape hatch: if commit-work won't stage every file you need to commit, use
plain git — \`git add <explicit paths>\` (never -A / .) then \`git commit\`.
Temporary; you're empowered to bypass for now.
`;

// Trailer patterns forbidden in a multi-line commit message body. Forged
// trailers could confuse downstream hooks that parse commit metadata. Mirrors
// the Python `_FORBIDDEN_TRAILER_RE` exactly (MULTILINE; the catch-all
// `Planctl-[A-Za-z]+:` makes the explicit Planctl-* alternatives redundant but
// they are kept verbatim for parity).
const FORBIDDEN_TRAILER_RE =
  /^(Job-Id:|Session-Id:|Signed-off-by:|Planctl-Op:|Planctl-Target:|Planctl-Prev-Op:|Planctl-[A-Za-z]+:)/m;

const FORBIDDEN_TRAILER_ERROR =
  "commit message contains a forbidden trailer pattern (Job-Id:, " +
  "Session-Id:, Signed-off-by:, Planctl-*:); rewrite the message and retry";

const DEFAULT_MAX_FILES = 500;

// ---------------------------------------------------------------------------
// Python-byte-parity JSON serializers
// ---------------------------------------------------------------------------

/**
 * Serialize a single string with Python `json.dumps(ensure_ascii=True)` bytes:
 * `JSON.stringify` handles the control-char + quote/backslash escapes (its
 * table matches Python's for `\b \t \n \f \r " \\` and `\uXXXX` for other
 * `< 0x20`), then every char `>= 0x7f` is escaped to `\uXXXX` to match
 * `ensure_ascii`. Verified byte-identical against CPython.
 */
function pyStr(s: string): string {
  return JSON.stringify(s).replace(
    /[-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Compact JSON matching Python's `json.dumps()` DEFAULT output: `", "` between
 * items, `": "` after keys, single line, `ensure_ascii=True`. This is the byte
 * shape line-oriented consumers parse.
 */
function pyCompact(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyStr(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => pyCompact(v)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyStr(k)}: ${pyCompact(v)}`,
    );
    return `{${pairs.join(", ")}}`;
  }
  return "null";
}

/** Emit a compact envelope (Python `print(json.dumps(...))` — adds `\n`). */
function printCompact(value: unknown): void {
  process.stdout.write(`${pyCompact(value)}\n`);
}

/**
 * Emit a pretty envelope matching `format_output` → `json_dumps`: `indent=2`,
 * `ensure_ascii=False`, trailing `\n`. JS `JSON.stringify(obj, null, 2)`
 * reproduces Python's `indent=2` framing byte-for-byte (including `[]` and
 * nested-array indentation); the payloads here are ASCII-only so the
 * ensure_ascii=False distinction never bites.
 */
function printPretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  msg: string | null;
  sessionId: string | null;
  previewFiles: boolean;
  maxFiles: number;
  help: boolean;
}

/**
 * Parse the commit-work argv. Mirrors the Click surface: one optional
 * positional MSG, `--session-id`, `--preview-files` flag, `--max-files` int
 * (min 0). An unparseable `--max-files` mirrors Click's IntRange rejection
 * (exit 2 with a stderr message); the verb's own envelopes are all exit 1.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    msg: null,
    sessionId: null,
    previewFiles: false,
    maxFiles: DEFAULT_MAX_FILES,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--preview-files") {
      parsed.previewFiles = true;
    } else if (a === "--session-id") {
      parsed.sessionId = argv[++i] ?? null;
    } else if (a.startsWith("--session-id=")) {
      parsed.sessionId = a.slice("--session-id=".length);
    } else if (a === "--max-files") {
      parsed.maxFiles = parseMaxFiles(argv[++i]);
    } else if (a.startsWith("--max-files=")) {
      parsed.maxFiles = parseMaxFiles(a.slice("--max-files=".length));
    } else if (a === "--") {
      // Everything after `--` is the positional message.
      if (i + 1 < argv.length) parsed.msg = argv[i + 1];
      break;
    } else if (!a.startsWith("-") && parsed.msg === null) {
      parsed.msg = a;
    } else {
      process.stderr.write(`keeper commit-work: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }
  return parsed;
}

/** Parse `--max-files` as a non-negative int (Click `IntRange(min=0)` parity). */
function parseMaxFiles(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write("keeper commit-work: --max-files requires a value\n");
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write(
      `keeper commit-work: --max-files must be an integer >= 0 (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

// ---------------------------------------------------------------------------
// gitignore filter + git pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Strip untracked-gitignored paths (order-preserving) — the port of jobctl's
 * `filter_gitignored`. Shells `git check-ignore -z --stdin` with NUL-framed
 * input so odd-encoded paths round-trip and we sidestep ARG_MAX. `--no-index`
 * is deliberately NOT used (it would mis-report tracked files as ignored).
 * Exit codes: 0 = some ignored, 1 = none ignored (normal), >=128 = fatal →
 * fail-open (return `files` unchanged rather than dropping everything).
 */
async function filterGitignored(
  files: string[],
  cwd: string,
): Promise<string[]> {
  if (files.length === 0) return [];
  const stdin = new TextEncoder().encode(`${files.join("\0")}\0`);
  const res = await gitExec(["check-ignore", "-z", "--stdin"], { cwd, stdin });
  if (res.code >= 128) return files;
  const raw = res.stdout.replace(/\0+$/, "");
  if (raw.length === 0) return [...files];
  const ignored = new Set(raw.split("\0").filter((c) => c.length > 0));
  return files.filter((p) => !ignored.has(p));
}

/** Git common dir (shared across worktrees), or `.git` on failure. */
async function gitCommonDir(cwd: string): Promise<string> {
  const res = await gitExec(["rev-parse", "--git-common-dir"], { cwd });
  return res.code === 0 ? res.stdout.trim() : ".git";
}

/**
 * Stage `files` with `git add -A -- <files>`. The `-A` is PATHSPEC-SCOPED, so
 * deleted paths stage as removals instead of erroring "did not match any
 * files"; it is NOT a tree-wide `git add -A`. Returns a failure envelope-like
 * string on error, or `null` on success.
 */
async function gitStage(files: string[], cwd: string): Promise<string | null> {
  const res = await gitExec(["add", "-A", "--", ...files], { cwd });
  if (res.code !== 0) return res.stderr.trim();
  return null;
}

/**
 * Repo-relative names currently staged (incl. deletions, so deleted-file
 * session entries are not dropped from stale-cleanup or the commit envelope).
 *
 * Uses `-z` (NUL-delimited): without it git QUOTES non-ASCII paths
 * (`"caf\303\251.txt"`), which would never intersect the raw-UTF-8
 * `callerFiles` set (sourced from the porcelain-v2 `-z` attribution reader),
 * silently dropping a unicode-named file from BOTH the commit `files` list and
 * the stale-unstage set. For ASCII paths `-z` is byte-identical to the
 * line-delimited form, so the common-case envelope is unchanged — this only
 * FIXES the unicode case (the Python source carried the latent quoting bug).
 */
async function stagedFileNames(cwd: string): Promise<string[]> {
  const res = await gitExec(
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD"],
    { cwd },
  );
  if (res.code !== 0) return [];
  return res.stdout.split("\0").filter((l) => l.length > 0);
}

/**
 * Resolve the `Job-Id:` trailer value, or `null`. Mirrors the Python's
 * `current_job_id()`: `JOBCTL_JOB_ID` override first, then the resolved session
 * id (the keeper invariant is `job_id === session_id`). The psutil ancestor-pid
 * walk is dropped — `CLAUDE_CODE_SESSION_ID` is present in every real session,
 * so it never fired in practice (same rationale as session-id.ts).
 */
function resolveJobId(): string | null {
  const envJob = process.env.JOBCTL_JOB_ID;
  if (envJob) return envJob;
  return resolveSessionId(null);
}

/**
 * Append a `Job-Id: <id>` trailer to `msg` when resolvable, via
 * `git interpret-trailers --if-exists doNothing` (idempotent on re-runs of the
 * same prepared message). Returns `msg` unchanged when no job id resolves or
 * the git call fails. Runs AFTER sanitize — a user-supplied `Job-Id:` line is
 * already rejected by {@link FORBIDDEN_TRAILER_RE}; this is the one legitimate
 * injection path.
 */
async function appendJobIdTrailer(msg: string, cwd: string): Promise<string> {
  const jobId = resolveJobId();
  if (!jobId) return msg;
  const res = await gitExec(
    [
      "-c",
      "trailer.job-id.ifExists=doNothing",
      "interpret-trailers",
      "--trailer",
      `Job-Id=${jobId}`,
    ],
    { cwd, stdin: new TextEncoder().encode(msg) },
  );
  if (res.code !== 0) return msg;
  return res.stdout;
}

/**
 * Commit whatever is staged with `msg` (passed via `-F -` stdin so the message
 * cannot be argv-injected). Returns the short SHA, or a failure envelope-like
 * string (prefixed `ERR:`) on commit failure.
 */
async function gitCommitStaged(
  msg: string,
  cwd: string,
): Promise<{ sha: string } | { error: string }> {
  const withTrailer = await appendJobIdTrailer(msg, cwd);
  const commit = await gitExec(["commit", "-F", "-"], {
    cwd,
    stdin: new TextEncoder().encode(withTrailer),
  });
  if (commit.code !== 0) {
    return { error: commit.stderr.trim() };
  }
  const sha = await gitExec(["rev-parse", "--short", "HEAD"], { cwd });
  return { sha: sha.stdout.trim() };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/** Print a compact failure envelope and exit 1 (the Python `sys.exit(1)`). */
function fail(payload: Record<string, unknown>): never {
  printCompact(payload);
  process.exit(1);
}

/**
 * Run the commit-work pipeline. Returns the process exit code (0 success, 1
 * failure); never calls `process.exit` itself inside the lock window so the
 * `finally` lock-release always runs (Bun's `process.exit` skips `finally`).
 */
async function run(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();

  const sessionId = resolveSessionId(args.sessionId);
  if (sessionId === null) {
    fail({
      success: false,
      error:
        "no session id available — pass --session-id or run inside a Claude " +
        "Code session (or set JOBCTL_SESSION_ID)",
    });
  }

  // Discover + gitignore-filter OUTSIDE the lock (pure reads, no mutation).
  let files = discoverSessionFiles(sessionId, cwd);
  files = await filterGitignored(files, cwd);

  // Hard-stop on a runaway POST-filter file list (the fn-684 incident shape).
  // `--max-files 0` disables the guard.
  if (args.maxFiles && files.length > args.maxFiles) {
    fail({
      success: false,
      error: "file_list_too_large",
      count: files.length,
      limit: args.maxFiles,
      sample: [...files].sort().slice(0, 20),
      hint:
        "Add a .gitignore rule for the runaway tree, then re-run; or pass " +
        "--max-files N to raise the cap (0 disables).",
    });
  }

  if (args.previewFiles) {
    printPretty({ success: true, files });
    return 0;
  }

  if (!args.msg) {
    fail({
      success: false,
      error:
        "commit message is required (pass a message as the positional argument)",
    });
  }
  const msg = args.msg;

  // Forbidden-trailer gate fires ONLY when the message is multi-line.
  if (msg.includes("\n") && FORBIDDEN_TRAILER_RE.test(msg)) {
    fail({ success: false, error: FORBIDDEN_TRAILER_ERROR });
  }

  if (files.length === 0) {
    printPretty({ success: true, committed: false, files: [] });
    return 0;
  }

  // Acquire the per-repo commit lock for the full stage → lint → commit → push
  // window. The lock path is under the git common dir so every worktree of the
  // repo coordinates through the same lock.
  let common = await gitCommonDir(cwd);
  if (!common.startsWith("/")) common = `${cwd}/${common}`;
  const lockPath = `${common}/keeper-commit-work.lock`;

  const lock = CommitWorkLock.acquire(lockPath);
  let exitCode = 0;
  try {
    const stageErr = await gitStage(files, cwd);
    if (stageErr !== null) {
      printCompact({ success: false, error: `git add failed: ${stageErr}` });
      return 1;
    }

    // Unstage any stale carryover (a previous worker that died between stage
    // and commit) so the commit + lint see ONLY the caller's files.
    const allStaged = new Set(await stagedFileNames(cwd));
    const callerFiles = new Set(files);
    const stale = [...allStaged].filter((f) => !callerFiles.has(f)).sort();
    if (stale.length > 0) {
      await gitExec(["reset", "HEAD", "--", ...stale], { cwd });
    }
    const stagedNames = [...allStaged].filter((f) => callerFiles.has(f)).sort();

    // Linters operate on file CONTENTS — skip paths deleted in this commit.
    const lintNames = stagedNames.filter((n) => existsSync(`${cwd}/${n}`));
    try {
      await runScopedLint(lintNames, cwd);
    } catch (err) {
      if (err instanceof LintFailure) {
        // Release the lock BEFORE printing (mirrors the Python finally-guard
        // that nulls the fd on the lint-fail path). The lock's release() is
        // idempotent, so the outer finally is a harmless no-op afterward.
        lock.release();
        printCompact({
          success: false,
          error: "lint_failed",
          linter: err.linter,
          files: err.files,
          stderr: err.stderr,
        });
        return 1;
      }
      throw err;
    }

    const committed = await gitCommitStaged(msg, cwd);
    if ("error" in committed) {
      printCompact({
        success: false,
        error: `git commit failed: ${committed.error}`,
      });
      return 1;
    }

    // NDJSON line 1 — commit envelope (COMPACT).
    printCompact({
      success: true,
      commit_sha: committed.sha,
      files: stagedNames,
    });

    // NDJSON line 2 — push envelope (COMPACT). Lock held through the push.
    const pushResult = await pushCommitted(cwd);
    printCompact(pushResult);
    if (!pushResult.success) exitCode = 1;
  } finally {
    lock.release();
  }
  return exitCode;
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

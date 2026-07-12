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
 *     → acquire flock (<per-worktree --git-dir>/keeper-commit-work.lock)
 *       → `git add -A -- <pathspecs>` (pathspec-scoped; deletions stage as removals)
 *       → index-purity gate: staged content outside the attributed set fails
 *         loud (`stale_index_carryover`) unless `--allow-stale-unstage` unstages it
 *       → lint matrix (src/commit-work/lint-matrix) — fail → release + emit
 *       → sanitize-safe `git commit -F - -- <attributed pathspec>` (GIT_LITERAL_PATHSPECS=1),
 *         appended `Job-Id:` trailer — poisoned index cannot leak into the tree
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
 * Line-oriented consumers (keeper plan, the worker dispatch) depend on the compact
 * two-line form — these serializers reproduce Python's exact bytes.
 */

import { existsSync } from "node:fs";
import {
  discoverSessionFiles,
  resolveCwdRepo,
  waitForAttributionCaughtUp,
} from "../src/commit-work/attribution";
import { CommitWorkLock } from "../src/commit-work/flock";
import { type GitRunner, gitExec } from "../src/commit-work/git-exec";
import { LintFailure, runScopedLint } from "../src/commit-work/lint-matrix";
import { pushCommitted } from "../src/commit-work/push";
import { resolveSessionId } from "../src/commit-work/session-id";

const HELP = `keeper commit-work [MSG] [options]

Stage session-touched work files, run the lint matrix, commit, and push.
Always run \`--preview-files\` first to inspect the file list. .keeper/**
board files are excluded (they commit via the plan-commit hook). Untracked
gitignored files are filtered before staging; a runaway file list
(> --max-files, default 500) aborts with a file_list_too_large envelope.

The commit is scoped to the session-attributed set. Staged content outside
that set (a dead worker's residue, a shared checkout that trails landed
history, or a git-apply/codegen write the attribution hooks never saw) aborts
with a stale_index_carryover envelope, and the commit itself is pathspec-
limited so nothing outside the attributed set can enter the tree.

Arguments:
  MSG                  Commit message (required unless --preview-files)

Options:
  --session-id <id>    Tracked agent session id (auto-resolved if omitted)
  --preview-files      List files that would be committed; no commit is made
  --max-files <n>      Abort when the post-filter file count exceeds <n>
                       (default 500; pass 0 to disable)
  --allow-stale-unstage
                       On a stale_index_carryover abort, unstage the extra
                       paths and commit the attributed set only. Recovery
                       opt-in, not a default; if the extra paths are yours,
                       prefer plain git with explicit paths instead.
  --help, -h           Show this help

Escape hatch: if commit-work won't stage every file you need to commit, use
plain git — \`git add <explicit paths>\` (never -A / .) then \`git commit\` and
\`git push\`. Temporary; you're empowered to bypass for now.

Run \`keeper commit-work --agent-help\` for the terse operator runbook.
`;

/** Terse operator runbook (agent-facing), distinct from the full `--help`. */
const AGENT_HELP = `keeper commit-work — operator runbook (agent-facing)

Stage session-touched files, run the lint matrix, commit, and push. .keeper/**
board files are excluded (the plan-commit hook owns them).

  keeper commit-work --preview-files          # inspect the scoped file list first
  keeper commit-work "<type>(<scope>): <summary>

  Task: fn-N.M"                               # source commit carries the Task: trailer

On a {"error":"lint_failed"} envelope: read the named files, fix per stderr,
\`git add\` the fixes, then re-invoke the SAME message — never --no-verify. A
runaway list (> --max-files, default 500) aborts with file_list_too_large. Every
verb envelope is exit 1; an arg fault is exit 2. Escape hatch: if it won't stage
a file you need, \`git add <explicit paths>\` then plain git commit/push.

On a {"error":"stale_index_carryover"} envelope: the index carries staged paths
outside your session's attributed set (a dead worker's residue or a desynced
checkout). Do NOT reflexively override. Either \`git add <explicit paths>\` +
plain git commit if those paths are genuinely yours, or --allow-stale-unstage to
unstage the extras and commit the attributed set only. The commit is always
pathspec-limited to the attributed set, so nothing else can enter the tree.
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

// Recovery contract carried in the lint_failed envelope, injected at the agent's
// decision point. A lint failure is never a staging-coverage gap, so the only
// permitted recovery loops back through commit-work — never a bare-git bypass.
const LINT_FAILED_RECOVERY =
  "Fix the reported lint errors in the files listed, re-stage them with " +
  "`git add <files>`, then re-invoke `keeper commit-work` with the same " +
  "message. Do NOT fall back to bare `git commit` or use `--no-verify` — a " +
  "lint failure is not a coverage gap.";

// Carried in the stale_index_carryover envelope. The attributed set derives
// ONLY from Write/Edit-class PostToolUse hooks, so a git-apply / codegen /
// script-written file is invisible to it and would otherwise DROP silently —
// and a desynced shared checkout surfaces as exactly this stale set. Both must
// be loud, so the default is to refuse rather than silently unstage.
const STALE_INDEX_CARRYOVER_HINT =
  "The index has staged content outside this session's attributed file set — " +
  "stale carryover from a prior worker that died mid-commit, a shared checkout " +
  "trailing landed history, or a git-apply/codegen/script write the attribution " +
  "hooks never saw. Committing it would sweep unrelated (possibly stale) paths " +
  "into your commit.";

// Recovery contract naming BOTH paths forward, so the operator chooses without
// running another git command. `--allow-stale-unstage` is the explicit opt-in
// for the old silent behavior; plain git is the path when the extras are yours.
const STALE_INDEX_CARRYOVER_RECOVERY =
  "Two ways forward: (1) if the extra paths are genuinely yours, commit the " +
  "mixed set with plain git and explicit paths — `git add <path> …` (never -A " +
  "/ .) then `git commit`; or (2) re-run `keeper commit-work --allow-stale-" +
  "unstage` to unstage the extras and commit ONLY your attributed files.";

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

/**
 * The stdout sink for every envelope. Defaults to `process.stdout.write`; the
 * test suite swaps it for an in-memory buffer so it can assert the exact compact
 * NDJSON / pretty bytes WITHOUT spawning the CLI binary. A single module-level
 * seam keeps the byte-parity serializers (`printCompact`/`printPretty`) intact.
 */
let writeOut: (chunk: string) => void = (chunk) => {
  process.stdout.write(chunk);
};

/** Emit a compact envelope (Python `print(json.dumps(...))` — adds `\n`). */
function printCompact(value: unknown): void {
  writeOut(`${pyCompact(value)}\n`);
}

/**
 * Emit a pretty envelope matching `format_output` → `json_dumps`: `indent=2`,
 * `ensure_ascii=False`, trailing `\n`. JS `JSON.stringify(obj, null, 2)`
 * reproduces Python's `indent=2` framing byte-for-byte (including `[]` and
 * nested-array indentation); the payloads here are ASCII-only so the
 * ensure_ascii=False distinction never bites.
 */
function printPretty(value: unknown): void {
  writeOut(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  msg: string | null;
  sessionId: string | null;
  previewFiles: boolean;
  allowStaleUnstage: boolean;
  maxFiles: number;
  help: boolean;
  agentHelp: boolean;
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
    allowStaleUnstage: false,
    maxFiles: DEFAULT_MAX_FILES,
    help: false,
    agentHelp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--agent-help") {
      parsed.agentHelp = true;
    } else if (a === "--preview-files") {
      parsed.previewFiles = true;
    } else if (a === "--allow-stale-unstage") {
      parsed.allowStaleUnstage = true;
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
  run: GitRunner,
): Promise<string[]> {
  if (files.length === 0) return [];
  const stdin = new TextEncoder().encode(`${files.join("\0")}\0`);
  const res = await run(["check-ignore", "-z", "--stdin"], { cwd, stdin });
  if (res.code >= 128) return files;
  const raw = res.stdout.replace(/\0+$/, "");
  if (raw.length === 0) return [...files];
  const ignored = new Set(raw.split("\0").filter((c) => c.length > 0));
  return files.filter((p) => !ignored.has(p));
}

/**
 * Resolve the worktree root for `cwd` via `git -C <cwd> rev-parse --show-toplevel`.
 * Every subsequent git op runs with `cwd: <this>`, so the whole pipeline is PINNED
 * to one canonical (git-realpath'd) worktree path — robust to a symlinked cwd and
 * to a concurrent producer perturbing ambient git-dir discovery mid-sequence. A
 * non-repo cwd (or any git error) falls back to `cwd` unchanged.
 */
async function resolveWorktreeRoot(
  cwd: string,
  run: GitRunner,
): Promise<string> {
  const res = await run(["rev-parse", "--show-toplevel"], { cwd });
  const top = res.stdout.trim();
  return res.code === 0 && top.length > 0 ? top : cwd;
}

/**
 * Stage `files` with `git add -A -- <files>`. The `-A` is PATHSPEC-SCOPED, so
 * deleted paths stage as removals instead of erroring "did not match any
 * files"; it is NOT a tree-wide `git add -A`. Returns a failure envelope-like
 * string on error, or `null` on success.
 */
async function gitStage(
  files: string[],
  cwd: string,
  run: GitRunner,
): Promise<string | null> {
  const res = await run(["add", "-A", "--", ...files], { cwd });
  if (res.code !== 0) return res.stderr.trim();
  return null;
}

/**
 * Repo-relative names currently staged (incl. deletions, so deleted-file
 * session entries are not dropped from the purity gate or the commit pathspec).
 *
 * `--no-renames` is load-bearing: with rename detection a rename reports ONLY
 * the new path, so the old path would neither land in the attributed pathspec
 * (leaving half a rename → a broken tree) nor surface in the stale set. Forcing
 * no-renames splits a rename into its A (new) and D (old) halves, so both ride
 * the pathspec when attributed, and a rename with one un-attributed half falls
 * into the stale set (the gate fires — all-or-nothing).
 *
 * Uses `-z` (NUL-delimited): without it git QUOTES non-ASCII paths
 * (`"caf\303\251.txt"`), which would never intersect the raw-UTF-8
 * `callerFiles` set (sourced from the porcelain-v2 `-z` attribution reader),
 * silently dropping a unicode-named file from BOTH the commit `files` list and
 * the stale set. For ASCII paths `-z` is byte-identical to the line-delimited
 * form, so the common-case envelope is unchanged.
 */
async function stagedFileNames(cwd: string, run: GitRunner): Promise<string[]> {
  const res = await run(
    [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACMRD",
    ],
    { cwd },
  );
  if (res.code !== 0) return [];
  return res.stdout.split("\0").filter((l) => l.length > 0);
}

/**
 * Resolve the `Job-Id:` trailer value, or `null`. Mirrors the Python's
 * `current_job_id()`: `JOBCTL_JOB_ID` override first, then the resolved session
 * id (the keeper invariant is `job_id === session_id`). The psutil ancestor-pid
 * walk is dropped because tracked harnesses carry an explicit session identity
 * (same rationale as session-id.ts).
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
async function appendJobIdTrailer(
  msg: string,
  cwd: string,
  run: GitRunner,
): Promise<string> {
  const jobId = resolveJobId();
  if (!jobId) return msg;
  const res = await run(
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
 * Commit the attributed staged set with `msg` (passed via `-F -` stdin so the
 * message cannot be argv-injected). PATHSPEC-LIMITED: `git commit -- <pathspec>`
 * uses git's `--only` mode, building the commit tree from HEAD plus the worktree
 * content of ONLY the named paths — staged entries OUTSIDE the pathspec are
 * physically held back, so a poisoned index cannot leak into the tree even if
 * the purity gate was overridden. `GIT_LITERAL_PATHSPECS=1` + the `--` separator
 * defeat leading-dash options and pathspec magic on attacker-influenced paths.
 * `pathspec` is the rename-complete staged-name set (deletions included), never
 * the lint list (which drops deleted paths). Returns the short SHA, or git's
 * verbatim stderr on commit failure (e.g. a mid-merge partial-commit refusal).
 */
async function gitCommitStaged(
  msg: string,
  pathspec: string[],
  cwd: string,
  run: GitRunner,
): Promise<{ sha: string } | { error: string }> {
  const withTrailer = await appendJobIdTrailer(msg, cwd, run);
  const commit = await run(["commit", "-F", "-", "--", ...pathspec], {
    cwd,
    stdin: new TextEncoder().encode(withTrailer),
    env: { GIT_LITERAL_PATHSPECS: "1" },
  });
  if (commit.code !== 0) {
    return { error: commit.stderr.trim() };
  }
  const sha = await run(["rev-parse", "--short", "HEAD"], { cwd });
  return { sha: sha.stdout.trim() };
}

/**
 * Default read-side wait: resolve the cwd's git toplevel, then block (bounded +
 * fail-open) until the session's attribution is caught up with its latest edits
 * in that repo. A non-repo cwd has nothing to wait on, so this is a no-op there.
 * Never throws — the bounded wait fails open on a slow/wedged producer, and a
 * resolution miss simply skips the wait, preserving the pre-`.1` read behavior.
 */
async function defaultWaitCaughtUp(
  sessionId: string,
  cwd: string,
): Promise<void> {
  const cwdRepo = resolveCwdRepo(cwd);
  if (!cwdRepo) return;
  await waitForAttributionCaughtUp(sessionId, cwdRepo);
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * Sentinel thrown by {@link fail} to unwind to the {@link run} boundary with a
 * fixed exit code, in place of an inline `process.exit`. `run` catches it and
 * returns the code so the in-process test path never kills the test process and
 * the production path still surfaces the same exit 1.
 */
class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitError";
    this.code = code;
  }
}

/** Print a compact failure envelope and unwind to {@link run} with exit 1. */
function fail(payload: Record<string, unknown>): never {
  printCompact(payload);
  throw new ExitError(1);
}

/**
 * Injectable seams for {@link run}. Every field defaults to the real production
 * implementation; the test suite overrides them to exercise the commit-work
 * DECISIONS (file discovery → gitignore filter → stage → lint gate → commit →
 * push) IN-PROCESS with zero real git, no real linters, and no compiled binary
 * spawn. Plain function params — no DI framework.
 */
export interface CommitWorkDeps {
  /**
   * Starting working directory, resolved to the worktree root before any git op
   * (default: `process.cwd()`). A test seam: the real-git suite points the
   * pipeline at a linked worktree path without a global `process.chdir`.
   */
  cwd?: string;
  /** Git runner threaded to every git boundary (default: real {@link gitExec}). */
  gitRunner?: GitRunner;
  /** Session-attributed dirty file discovery (default: real attribution read). */
  discoverFiles?: (sessionId: string, cwd: string) => string[];
  /**
   * Read-side wait that lets the `.1` poll-only git producer catch up so a file
   * edited immediately before commit-work is attributed before the read. Bounded
   * + fail-open by contract (default: real {@link waitForAttributionCaughtUp}).
   */
  waitCaughtUp?: (sessionId: string, cwd: string) => Promise<void>;
  /** Lint matrix; throws {@link LintFailure} on a violation (default: real). */
  runLint?: (stagedFiles: string[], cwd: string) => Promise<void>;
  /** Commit-work flock acquire (default: real {@link CommitWorkLock.acquire}). */
  acquireLock?: (lockPath: string) => { release: () => void };
}

/**
 * Run the commit-work pipeline. Returns the process exit code (0 success, 1
 * failure); never calls `process.exit` itself inside the lock window so the
 * `finally` lock-release always runs (Bun's `process.exit` skips `finally`).
 * Catches the {@link ExitError} that the early-validation {@link fail} throws and
 * returns its code — no `process.exit` ever fires inside the pipeline.
 *
 * `deps` injects the git runner, file discovery, lint matrix, and lock so the
 * suite can drive the full decision pipeline with no real git / lint / binary.
 */
async function run(
  args: ParsedArgs,
  deps: CommitWorkDeps = {},
): Promise<number> {
  try {
    return await runInner(args, deps);
  } catch (err) {
    if (err instanceof ExitError) return err.code;
    throw err;
  }
}

async function runInner(
  args: ParsedArgs,
  deps: CommitWorkDeps,
): Promise<number> {
  const startCwd = deps.cwd ?? process.cwd();
  const git = deps.gitRunner ?? gitExec;
  const discoverFiles = deps.discoverFiles ?? discoverSessionFiles;
  const waitCaughtUp = deps.waitCaughtUp ?? defaultWaitCaughtUp;
  const runLint = deps.runLint ?? runScopedLint;
  const acquireLock = deps.acquireLock ?? CommitWorkLock.acquire;

  const sessionId = resolveSessionId(args.sessionId);
  if (sessionId === null) {
    fail({
      success: false,
      error: "no_session_id",
      hint:
        "commit-work attributes files by tracked agent session id, which isn't " +
        "set here. Commit with git directly instead: stage ONLY the files you " +
        "changed, by explicit path (git add <path> … — never -A or .), then " +
        "git commit and git push.",
    });
  }

  // Pin the whole pipeline to the resolved worktree root: every git op below runs
  // with `cwd: worktree`, so a concurrent producer perturbing ambient git-dir
  // discovery cannot make a commit land on the wrong branch (the env strip in
  // git-exec closes the GIT_DIR/GIT_WORK_TREE side of the same hazard).
  const worktree = await resolveWorktreeRoot(startCwd, git);

  // Read-side wait (fn-921.4): let the `.1` poll-only git producer fold a
  // GitSnapshot covering any just-landed edit so its attribution is charged
  // before we read. Bounded + fail-open — a wedged/slow producer never blocks
  // the commit; on timeout we fall back to the on-hook ∩ live read below.
  await waitCaughtUp(sessionId, worktree);

  // Discover + gitignore-filter OUTSIDE the lock (pure reads, no mutation).
  let files = discoverFiles(sessionId, worktree);
  files = await filterGitignored(files, worktree, git);

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

  // Acquire the per-worktree commit lock for the full stage → lint → commit →
  // push window, keyed on the worktree's OWN git dir (`--git-dir`). The git index,
  // index.lock, and HEAD are per-worktree, so a commit-work serializes only against
  // another commit-work in the SAME worktree; disjoint linked worktrees share no
  // staging state and take distinct locks. Argv-identical to `commitWorkLockPath`
  // in src/worktree-git.ts, so a lane's commit-work and its fan-in lane merge
  // (`mergeBranchInto`, same `--git-dir`) still collide in that lane.
  //
  // The autopilot base→default merge is the DELIBERATE exception: it keys its lock
  // on `--git-common-dir` (`baseMergeLockPath`), because it advances the SHARED
  // `refs/heads/<default>` rather than a per-worktree branch. In the MAIN checkout
  // `--git-dir` == `--git-common-dir`, so a main-checkout commit-work still
  // serializes against the base merge; a linked lane's commit-work (its own
  // `--git-dir`) does not (correctly — the base merge never runs in a lane).
  const gitDirRes = await git(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd: worktree },
  );
  const gitDir = gitDirRes.stdout.trim();
  // Fallback (git error / empty stdout): the worktree-anchored absolute `.git` —
  // never a bare relative `.git` (it would resolve against the daemon's ambient
  // cwd, not the pinned worktree) and never `/keeper-commit-work.lock` (root).
  const lockDir =
    gitDirRes.code === 0 && gitDir.length > 0 ? gitDir : `${worktree}/.git`;
  const lockPath = `${lockDir}/keeper-commit-work.lock`;

  const lock = acquireLock(lockPath);
  let exitCode = 0;
  try {
    const stageErr = await gitStage(files, worktree, git);
    if (stageErr !== null) {
      printCompact({ success: false, error: `git add failed: ${stageErr}` });
      return 1;
    }

    // Index-purity gate. Any staged path outside the session-attributed set is
    // stale carryover — a prior worker that died between stage and commit, a
    // shared checkout trailing landed history, or a git-apply/codegen write the
    // attribution hooks never saw. All of those must be LOUD, not silently
    // dropped, so the default refuses and `--allow-stale-unstage` is the explicit
    // opt-in for the old unstage-and-proceed behavior. `--no-renames` in
    // `stagedFileNames` splits a rename into both halves, so a rename with one
    // un-attributed half lands in `stale` and the gate fires all-or-nothing.
    const allStaged = new Set(await stagedFileNames(worktree, git));
    const callerFiles = new Set(files);
    const stale = [...allStaged].filter((f) => !callerFiles.has(f)).sort();
    if (stale.length > 0) {
      if (args.allowStaleUnstage) {
        await git(["reset", "HEAD", "--", ...stale], { cwd: worktree });
      } else {
        printCompact({
          success: false,
          error: "stale_index_carryover",
          count: stale.length,
          sample: stale.slice(0, 20),
          hint: STALE_INDEX_CARRYOVER_HINT,
          recovery: STALE_INDEX_CARRYOVER_RECOVERY,
        });
        return 1;
      }
    }

    // The pathspec the commit is scoped to: the attributed ∩ staged set,
    // rename-complete and deletion-inclusive (built from staged NAMES, never the
    // lint list, which filters to paths still on disk).
    const stagedNames = [...allStaged].filter((f) => callerFiles.has(f)).sort();

    // Empty resolved pathspec: files were discovered + staged, but none of them
    // carry an actual index change (already committed, or reverted). Skip commit
    // and push rather than issue an empty-tree commit.
    if (stagedNames.length === 0) {
      printCompact({
        success: false,
        error: "nothing_to_commit",
        hint:
          "The session-attributed files produced no staged change (already " +
          "committed, or their edits were reverted). Nothing to commit.",
      });
      return 1;
    }

    // Linters operate on file CONTENTS — skip paths deleted in this commit.
    const lintNames = stagedNames.filter((n) => existsSync(`${worktree}/${n}`));
    try {
      await runLint(lintNames, worktree);
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
          recovery: LINT_FAILED_RECOVERY,
        });
        return 1;
      }
      throw err;
    }

    const committed = await gitCommitStaged(msg, stagedNames, worktree, git);
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
    const pushResult = await pushCommitted(worktree, git);
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
  if (args.agentHelp) {
    process.stdout.write(AGENT_HELP);
    return;
  }
  const code = await run(args);
  if (code !== 0) process.exit(code);
}

/**
 * In-process test entry — parse `argv`, run the pipeline with injected `deps`,
 * and return the captured stdout + exit code WITHOUT spawning the CLI binary,
 * touching real git, or calling `process.exit`. Routes every envelope through an
 * in-memory `writeOut` so the byte-parity serializers are still under test. The
 * help path is exercised separately; this asserts the verb's decisions.
 */
export async function runForTest(
  argv: string[],
  deps: CommitWorkDeps = {},
): Promise<{ code: number; stdout: string }> {
  const args = parseArgs(argv);
  const prevWrite = writeOut;
  let buf = "";
  writeOut = (chunk) => {
    buf += chunk;
  };
  try {
    const code = await run(args, deps);
    return { code, stdout: buf };
  } finally {
    writeOut = prevWrite;
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}

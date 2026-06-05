#!/usr/bin/env bun
/**
 * `keeper find-task-commit <task-id>` — emit the commit(s) carrying a matching
 * `Task: <task-id>` trailer as a pretty JSON envelope (planctl consumes this).
 *
 * The native port of jobctl's `run_find_task_commit.py` (epic fn-715 task 3).
 * **The stdout envelope is a planctl fail-loud contract** — `run_close_preflight`
 * parses `{success, commits:[{sha, repo}, ...]}` and treats any shape drift or
 * wrong exit code as COMMIT_LOOKUP_FAILED — so the shape + exit codes here are
 * byte-for-byte the Python's.
 *
 * Two-stage match per scanned repo:
 *   1. `git log --grep="Task: <id>" -F --pretty=format:%H` — cheap pre-filter.
 *      `-F` (fixed-string) DISABLES regex, so the `^`/`$` anchors are OMITTED
 *      (re-adding them under `-F` matches nothing); anchoring is the job of the
 *      post-filter trailer parse.
 *   2. Per candidate, `loadTrailers` (`git log -1 --format=%B` →
 *      `git interpret-trailers --parse`) confirms a REAL `Task:` trailer,
 *      dropping prose false-matches ("fixes the Task: fn-X issue").
 *
 * Repo resolution (the `touched_repos` walk-up + `--repos` override):
 *   - `--repos <comma-list>` overrides everything — only those paths are scanned
 *     (`~` expanded, relative paths resolved against cwd).
 *   - Otherwise derive `epic_id` from `task_id` (strip the `.N` suffix), walk up
 *     from cwd looking for `.planctl/epics/<epic_id>.json`, and read its
 *     `touched_repos`:
 *       * field absent / `null` (legacy epic) OR no epic JSON found → cwd-only.
 *       * `[]` (human set "scan nothing") → success with empty commits.
 *       * non-empty list → scan each; a path that is missing / not-a-git-repo is
 *         skipped with a stderr note. If EVERY listed path fails → exit 1.
 *   - A clean miss (no matching commit) is NEVER `success:false` — empty
 *     `commits` list, exit 0.
 *
 * Coupling note (per CLAUDE.md): this reads the planctl epic JSON layout
 * directly (`.planctl/epics/<id>.json`) — intentional, mirrors the `Task:`
 * trailer convention; the layout is stable.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitExec } from "../src/commit-work/git-exec";
import { hasRealTaskTrailer } from "../src/commit-work/trailers";

const HELP = `keeper find-task-commit <task-id> [options]

Find the commit(s) carrying a \`Task: <task-id>\` trailer. Emits a pretty JSON
envelope \`{success, commits:[{sha, repo}, ...]}\` — an empty commits list is a
clean miss (success, exit 0), not an error. planctl consumes this.

By default the repo list is derived from the epic's \`touched_repos\` (walk up
from cwd to \`.planctl/epics/<epic_id>.json\`); a legacy epic with no
\`touched_repos\` falls back to a cwd-only scan.

Arguments:
  TASK-ID            planctl task id (e.g. fn-1-foo.3)

Options:
  --repos <list>     Comma-separated repo paths to scan (overrides touched_repos;
                     ~ and relative paths are resolved)
  --max-count <n>    Pass through to git log --max-count on the pre-filter
  --help, -h         Show this help
`;

interface ParsedArgs {
  taskId: string | null;
  repos: string | null;
  maxCount: number | null;
  help: boolean;
}

/** Parse the find-task-commit argv: one positional TASK-ID + two options. */
function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    taskId: null,
    repos: null,
    maxCount: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--repos") {
      parsed.repos = argv[++i] ?? null;
    } else if (a.startsWith("--repos=")) {
      parsed.repos = a.slice("--repos=".length);
    } else if (a === "--max-count") {
      parsed.maxCount = parseMaxCount(argv[++i]);
    } else if (a.startsWith("--max-count=")) {
      parsed.maxCount = parseMaxCount(a.slice("--max-count=".length));
    } else if (!a.startsWith("-") && parsed.taskId === null) {
      parsed.taskId = a;
    } else {
      process.stderr.write(
        `keeper find-task-commit: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseMaxCount(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write(
      "keeper find-task-commit: --max-count requires a value\n",
    );
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(
      `keeper find-task-commit: --max-count must be an integer >= 1 (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

/**
 * Emit a pretty (`indent=2`, trailing `\n`) JSON envelope — the same shape as
 * the Python `format_output` reader path. NOT the compact commit-work form.
 */
function printPretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Expand a leading `~` to the home dir; resolve relative paths against cwd. */
function expandUser(p: string, cwd: string): string {
  let expanded = p;
  if (p === "~") {
    expanded = homedir();
  } else if (p.startsWith("~/")) {
    expanded = join(homedir(), p.slice(2));
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * git log --grep pre-filter (`-F` fixed-string, loose `Task: <id>`). Returns the
 * candidate SHAs (one per line). Non-zero exit → empty list (e.g. an empty repo
 * with no commits yet).
 */
async function grepCandidates(
  taskId: string,
  cwd: string,
  maxCount: number | null,
): Promise<string[]> {
  const args = [
    "log",
    `--grep=Task: ${taskId}`,
    "-F", // fixed-string (no regex) — anchoring is the post-filter's job
    "--pretty=format:%H",
  ];
  if (maxCount !== null) args.push(`--max-count=${maxCount}`);
  const res = await gitExec(args, { cwd });
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Scan a single repo → `[{sha, repo}, ...]` for trailer-confirmed commits. */
async function scanRepo(
  taskId: string,
  repoPath: string,
  maxCount: number | null,
): Promise<Array<{ sha: string; repo: string }>> {
  const candidates = await grepCandidates(taskId, repoPath, maxCount);
  const results: Array<{ sha: string; repo: string }> = [];
  for (const sha of candidates) {
    if (await hasRealTaskTrailer(sha, taskId, repoPath)) {
      results.push({ sha, repo: repoPath });
    }
  }
  return results;
}

/** Return true if `path` is an existing dir containing a git repo. */
async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const res = await gitExec(["-C", path, "rev-parse", "--git-dir"]);
  return res.code === 0;
}

/**
 * Walk up from `startDir` for `.planctl/epics/<epicId>.json`, returning its path
 * or `null`. Resolution: cwd's `.planctl/...` first, then each parent up to the
 * filesystem root.
 */
function findEpicJson(epicId: string, startDir: string): string | null {
  let current = resolve(startDir);
  const target = join("epics", `${epicId}.json`);
  for (;;) {
    const candidate = join(current, ".planctl", target);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null; // reached filesystem root
    current = parent;
  }
}

/**
 * Determine the repos to scan. Returns:
 *   - a list of repo paths (possibly empty — `[]` = "scan nothing"),
 *   - `null` = "fall back to cwd-only" (legacy epic OR no planctl state found).
 *
 * Throws a `RuntimeError`-shaped Error on a malformed (un-parseable) epic JSON —
 * the Python raises and the caller exits 1 (fail-loud, no silent fallback).
 */
function resolveRepos(
  taskId: string,
  reposOverride: string | null,
  cwd: string,
): string[] | null {
  if (reposOverride !== null) {
    return reposOverride
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => expandUser(p, cwd));
  }

  // Derive epic_id by stripping the trailing `.N` task suffix.
  const epicId = taskId.includes(".")
    ? taskId.slice(0, taskId.lastIndexOf("."))
    : taskId;

  const epicJsonPath = findEpicJson(epicId, cwd);
  if (epicJsonPath === null) return null; // no planctl state → cwd-only

  let raw: string;
  try {
    raw = readFileSync(epicJsonPath, "utf8");
  } catch {
    // File truly unreadable — cwd-only fallback is the documented contract.
    process.stderr.write(
      `keeper find-task-commit: could not read epic JSON at ${epicJsonPath}, ` +
        "falling back to cwd-only.\n",
    );
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // Malformed JSON — fail visibly (arthack "no fallback code paths" rule).
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `keeper find-task-commit: epic JSON parse failed at ${epicJsonPath}: ${msg}`,
    );
  }

  const touchedRepos = data.touched_repos;
  if (touchedRepos === null || touchedRepos === undefined) {
    return null; // legacy epic → cwd-only
  }
  if (!Array.isArray(touchedRepos)) {
    // Defensive: a non-array touched_repos is not the documented shape; treat
    // like legacy (cwd-only) rather than crashing.
    return null;
  }
  return touchedRepos.map((r) => String(r));
}

/** Run the find-task-commit pipeline; returns the process exit code. */
async function run(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const taskId = args.taskId as string;

  let repos: string[] | null;
  try {
    repos = resolveRepos(taskId, args.repos, cwd);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (repos === null) {
    // No planctl state / legacy epic → cwd-only scan.
    const confirmed = await scanRepo(taskId, cwd, args.maxCount);
    printPretty({ success: true, commits: confirmed });
    return 0;
  }

  if (repos.length === 0) {
    // `[]` = "scan nothing" = intentional success (DISTINCT from all-broken).
    process.stderr.write(
      `keeper find-task-commit: touched_repos is empty for epic derived from ` +
        `'${taskId}'; no repos to scan.\n`,
    );
    printPretty({ success: true, commits: [] });
    return 0;
  }

  const allCommits: Array<{ sha: string; repo: string }> = [];
  let anySuccess = false;
  for (const repoPath of repos) {
    if (!existsSync(repoPath)) {
      process.stderr.write(
        `keeper find-task-commit: repo path does not exist, skipping: ${repoPath}\n`,
      );
      continue;
    }
    if (!(await isGitRepo(repoPath))) {
      process.stderr.write(
        `keeper find-task-commit: path is not a git repo, skipping: ${repoPath}\n`,
      );
      continue;
    }
    anySuccess = true;
    allCommits.push(...(await scanRepo(taskId, repoPath, args.maxCount)));
  }

  if (!anySuccess) {
    // Non-empty-but-all-broken = error (DISTINCT from the `[]` success above).
    process.stderr.write(
      "keeper find-task-commit: all repo paths failed (not found or not a git repo).\n",
    );
    return 1;
  }

  printPretty({ success: true, commits: allCommits });
  return 0;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.taskId === null) {
    process.stderr.write(
      "keeper find-task-commit: missing required TASK-ID argument\n\n",
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  const code = await run(args);
  if (code !== 0) process.exit(code);
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}

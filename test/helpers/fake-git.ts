/**
 * Fake git runners for the de-git commit/push suites (epic fn-904, task 3). The
 * commit-work / doc-commit / docs-pusher surfaces all funnel their git calls
 * through an injectable runner; these helpers stand in for real `git` so the
 * tests assert keeper's DECISIONS (the staged pathspec, the commit subject /
 * trailer, the push skip + classified skip-log, the exit-0 fail-open) with zero
 * real git, no network, and no compiled binary spawn.
 *
 * Each runner is RULE-DRIVEN: the caller supplies an ordered list of matchers
 * (a predicate over the argv) → a canned `{ exitCode|code, stdout, stderr }`.
 * The first matching rule wins; an unmatched call falls back to a default (exit
 * 0, empty output) so a surface can issue probe calls a test does not care
 * about. Every call is RECORDED so the test can assert the exact argv sequence
 * (e.g. `add -A -- a.txt b.txt`, `commit -F -`, `push --no-progress`).
 */

import type { PusherGitRunner } from "../../plugins/keeper/plugin/hooks/docs-pusher";
import type {
  GitExecOptions,
  GitExecResult,
  GitRunner,
} from "../../src/commit-work/git-exec";
import type { DocGitRunner, GitRunResult } from "../../src/doc-commit";

/** A canned outcome for a matched git call (sync runner shape). */
export interface FakeGitOutcome {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** One rule: match the argv, return a canned outcome. */
export interface FakeGitRule {
  when: (args: string[]) => boolean;
  result: FakeGitOutcome;
}

/** A recorded call: the argv, the stdin text fed (commit -F - messages), and —
 * for the async commit-work runner — the spawn `cwd` + extra `env` so a test can
 * assert every git op is worktree-pinned. */
export interface RecordedGitCall {
  args: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Helpers shared across the three runner flavors. */
function applyRules(args: string[], rules: FakeGitRule[]): FakeGitOutcome {
  for (const rule of rules) {
    if (rule.when(args)) return rule.result;
  }
  return {};
}

/** True when `args` begins with the given subcommand token sequence. */
export function argvStartsWith(args: string[], ...prefix: string[]): boolean {
  return prefix.every((p, i) => args[i] === p);
}

/** True when `args` contains the given token. */
export function argvHas(args: string[], token: string): boolean {
  return args.includes(token);
}

// ---------------------------------------------------------------------------
// Async runner — the commit-work family (GitRunner).
// ---------------------------------------------------------------------------

/** A recording async {@link GitRunner} for commit-work, plus its call log. */
export interface FakeAsyncGit {
  run: GitRunner;
  calls: RecordedGitCall[];
}

/**
 * Build a recording async git runner. `rules` are tried in order; an unmatched
 * call returns exit 0 with empty output. `options.stdin` is decoded to text and
 * recorded so a test can assert the commit message / trailer fed via `-F -`.
 */
export function fakeAsyncGit(rules: FakeGitRule[] = []): FakeAsyncGit {
  const calls: RecordedGitCall[] = [];
  const run: GitRunner = async (
    args: string[],
    options: GitExecOptions = {},
  ): Promise<GitExecResult> => {
    const stdin =
      options.stdin !== undefined
        ? new TextDecoder().decode(options.stdin)
        : undefined;
    calls.push({
      args: [...args],
      stdin,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    const out = applyRules(args, rules);
    return {
      code: out.exitCode ?? 0,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
    };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Sync runner — doc-commit (DocGitRunner).
// ---------------------------------------------------------------------------

/** A recording sync {@link DocGitRunner} for the docs committer + its log. */
export interface FakeDocGit {
  run: DocGitRunner;
  calls: RecordedGitCall[];
}

/**
 * Build a recording sync doc-commit git runner. `rules` are tried in order; an
 * unmatched call returns exit 0 with empty output. The `input` (commit message)
 * is recorded as `stdin`.
 */
export function fakeDocGit(rules: FakeGitRule[] = []): FakeDocGit {
  const calls: RecordedGitCall[] = [];
  const run: DocGitRunner = (
    args: string[],
    _cwd: string,
    input?: string,
  ): GitRunResult => {
    calls.push({ args: [...args], stdin: input });
    const out = applyRules(args, rules);
    return {
      exitCode: out.exitCode ?? 0,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
    };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Sync runner — docs-pusher (PusherGitRunner).
// ---------------------------------------------------------------------------

/** A recording sync {@link PusherGitRunner} for the docs pusher + its log. */
export interface FakePusherGit {
  run: PusherGitRunner;
  calls: RecordedGitCall[];
}

/**
 * Build a recording sync docs-pusher git runner. `rules` are tried in order; an
 * unmatched call returns exit 0 with empty output (so the mid-op / detached
 * probes default to "clean" unless a rule says otherwise).
 */
export function fakePusherGit(rules: FakeGitRule[] = []): FakePusherGit {
  const calls: RecordedGitCall[] = [];
  const run: PusherGitRunner = (
    args: string[],
    _cwd: string,
    _extraEnv?: Record<string, string>,
  ): GitRunResult => {
    calls.push({ args: [...args] });
    const out = applyRules(args, rules);
    return {
      exitCode: out.exitCode ?? 0,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
    };
  };
  return { run, calls };
}

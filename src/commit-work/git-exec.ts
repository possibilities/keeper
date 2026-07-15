/**
 * Write-capable git spawn helper for the `keeper commit-work` family.
 *
 * Distinct from the daemon's read-only `gitOutput` (src/git-worker.ts:600),
 * which passes `--no-optional-locks` because the daemon is a pure OBSERVER
 * that must never take `.git/index.lock`. The commit-work verbs are the
 * opposite: they `git add` / `git commit` / `git push` and DO need the
 * opportunistic index stat-cache refresh that `--no-optional-locks` defeats —
 * so this helper deliberately OMITS that flag.
 *
 * Both stdout and stderr are drained CONCURRENTLY via `Promise.all`. A linter
 * or `git` subprocess that fills one pipe buffer while we await the other
 * sequentially would deadlock once its output exceeds the OS pipe capacity
 * (~64KB on macOS) — the classic single-pipe-drain hang. The array-form
 * `Bun.spawn` with `shell: false` (Bun's default for array args) keeps the
 * argv unsplit, sidestepping shell-injection on paths.
 */

/** Result of a {@link gitExec} run. `code` is the process exit code. */
export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options for {@link gitExec}. */
export interface GitExecOptions {
  /** Working directory for the spawned `git` (sets git's cwd). */
  cwd?: string;
  /** Bytes piped to the child's stdin (e.g. `--stdin`-fed pathspecs). */
  stdin?: Uint8Array;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  /**
   * Wall-clock bound (ms) for the spawn. On expiry the child is SIGKILLed and the
   * result's `code` is {@link GIT_SPAWN_TIMEOUT_CODE}, distinct from git's own
   * 0/1/128 so a caller maps a TRANSIENT stall to a retry, never a hard failure.
   * Omitted / non-positive ⟹ no timeout. The backstop for an SSH TCP stall that
   * `GIT_TERMINAL_PROMPT` + ssh `ConnectTimeout` do not catch.
   */
  timeoutMs?: number;
}

/**
 * Exit code {@link spawnGitExec} reports when a spawn exceeds its `timeoutMs` —
 * the GNU `timeout(1)` convention, chosen so it never collides with git's real
 * exit codes (0 success, 1 generic, 128 fatal). A caller keys a transient-retry
 * degrade on this code.
 */
export const GIT_SPAWN_TIMEOUT_CODE = 124;

/**
 * Exit code {@link spawnGitExec} reports when the spawn ITSELF fails synchronously
 * — `Bun.spawn` throws at `posix_spawn` before the child ever runs. The dominant
 * cause is an ENOENT because the requested `cwd` has VANISHED (a lane dir removed
 * out from under a reconcile sweep); a `git` missing from PATH throws the same way.
 * The GNU 127 "command not found" convention, chosen so it never collides with
 * git's real 0/1/128 nor the {@link GIT_SPAWN_TIMEOUT_CODE} 124. Surfacing a spawn
 * failure as a nonzero RESULT — rather than letting the throw propagate — keeps
 * every {@link GitRunner} caller on its normal `code !== 0` error path, so a single
 * vanished-cwd probe (e.g. {@link classifyLinkedWorktree}) DEFERS that repo instead
 * of unwinding an entire recover/finalize sweep.
 */
export const GIT_SPAWN_FAILED_CODE = 127;

/**
 * Default wall-clock bound (ms) for a NETWORK git op (push / push --dry-run)
 * spawned via {@link spawnGitExec}. Generous so a legitimately-progressing push
 * is never killed, while still bounding a post-connect SSH stall that would
 * otherwise wedge the reconcile cycle indefinitely.
 */
export const GIT_PUSH_TIMEOUT_MS = 120_000;

/**
 * Wall-clock bound (ms) for a LOCAL git op (merge / merge --abort / worktree
 * remove / worktree prune / branch -D / rev-parse / merge-base) on the worktree
 * merge + teardown path. SMALLER than {@link GIT_PUSH_TIMEOUT_MS}: a local op
 * touches only the on-disk repo, so the only thing that makes one hang is a
 * blocking git HOOK (a `merge`'s pre-merge-commit / post-merge running an
 * interactive or wedged command). Generous enough that a legitimately slow hook
 * (a linter) is never killed, while bounding a hung hook that would otherwise
 * freeze the reconcile worker thread. A spawn that exceeds it reports
 * {@link GIT_SPAWN_TIMEOUT_CODE}, which the worktree merge path degrades to a
 * transient retry-skip (never a freeze, never a sticky conflict).
 */
export const GIT_LOCAL_TIMEOUT_MS = 60_000;

/**
 * The function shape every commit-work git boundary depends on. Production uses
 * {@link spawnGitExec} (a real `git` subprocess); tests inject a fake recording
 * runner so the suite exercises keeper's DECISIONS (pathspec, subject, push
 * skip/log) with zero real git. A plain function param — no DI framework.
 */
export type GitRunner = (
  args: string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

/**
 * The git env vars that override cwd-based repo discovery. An ancestor process
 * (or a git hook) that exported any of these would pin EVERY child `git` to that
 * repo/index regardless of the `cwd` we pass — the classic cause of a commit made
 * inside a linked worktree landing on `main` instead of its lane branch. We strip
 * them so git ALWAYS discovers the repo from the explicit cwd. (`GIT_TERMINAL_PROMPT`
 * and other non-discovery vars are deliberately NOT stripped.)
 */
export const GIT_DISCOVERY_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;

/**
 * Build the child env for a git spawn: the ambient env with the
 * {@link GIT_DISCOVERY_ENV_VARS} stripped, then `extra` merged over. `source`
 * defaults to `process.env` (overridable so the fast tier unit-tests the strip
 * with a synthetic env and zero global mutation). Caller-supplied `extra` wins —
 * it is applied AFTER the strip, so a deliberate caller override (none today) is
 * never clobbered, while inherited discovery vars are always removed.
 */
export function buildGitEnv(
  extra?: Record<string, string>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  for (const key of GIT_DISCOVERY_ENV_VARS) {
    delete env[key];
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

/**
 * Run `git <args>` as a real subprocess with both output streams drained
 * concurrently.
 *
 * NEVER passes `--no-optional-locks` — see the module header. The caller is
 * responsible for never issuing tree-wide `git add -A/./*` (always pathspec-
 * scoped with a `--` separator per the epic's best-practices) and for holding
 * the commit-work flock around the stage→commit→push window.
 *
 * The env ALWAYS routes through {@link buildGitEnv}, so the
 * {@link GIT_DISCOVERY_ENV_VARS} are stripped on every spawn and `git` discovers
 * the repo from the explicit `cwd` — never from an inherited `GIT_DIR`/`GIT_WORK_TREE`
 * an ancestor may have exported. PATH/HOME and the rest of the ambient env still
 * ride through so git's credential + config discovery keeps working.
 */
export async function spawnGitExec(
  args: string[],
  options: GitExecOptions = {},
): Promise<GitExecResult> {
  // `Bun.spawn` throws SYNCHRONOUSLY when posix_spawn fails before the child runs
  // — an ENOENT on a vanished `cwd` (a lane dir removed out from under a sweep) or
  // a `git` missing from PATH. Convert that throw into a nonzero RESULT so every
  // caller stays on its `code !== 0` path instead of the exception unwinding a
  // whole reconcile sweep. The IIFE keeps the `stdout`/`stderr` "pipe" narrowing
  // that a `let`-typed binding would lose.
  const proc = (() => {
    try {
      return Bun.spawn(["git", ...args], {
        cwd: options.cwd,
        stdin: options.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: buildGitEnv(options.env),
        // Timed Git commands may launch SSH, credential, signing, or hook
        // descendants which retain their pipes. Isolate a process group so the
        // timeout closes the complete subprocess tree.
        detached:
          options.timeoutMs !== undefined &&
          options.timeoutMs > 0 &&
          process.platform !== "win32",
      });
    } catch (err) {
      return {
        spawnFailed: err instanceof Error ? err.message : String(err),
      } as const;
    }
  })();
  if ("spawnFailed" in proc) {
    return {
      code: GIT_SPAWN_FAILED_CODE,
      stdout: "",
      stderr: proc.spawnFailed,
    };
  }

  // A bounded spawn SIGKILLs the child on expiry so a stalled network git op
  // (an SSH TCP stall that does not trip GIT_TERMINAL_PROMPT) cannot hang the
  // caller forever. The kill closes both pipes, so the concurrent drain below
  // resolves promptly with whatever partial output arrived.
  let timedOut = false;
  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          if (process.platform !== "win32") {
            try {
              process.kill(-proc.pid, "SIGKILL");
              return;
            } catch {
              // The child may have exited between the timer and group signal.
            }
          }
          try {
            proc.kill("SIGKILL");
          } catch {
            // A concurrently exited child already closed its descriptors.
          }
        }, options.timeoutMs)
      : undefined;

  try {
    // Drain both pipes CONCURRENTLY. Awaiting stdout fully before stderr would
    // deadlock on any child whose stderr fills the pipe buffer mid-run (and
    // vice-versa) — the pipe-buffer-backpressure hang the epic's best-practices
    // call out. `Bun.readableStreamToText` consumes the whole stream.
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // A timeout-kill reports as GIT_SPAWN_TIMEOUT_CODE regardless of the signal's
    // raw exit so the caller's transient/hard classification stays unambiguous.
    return { code: timedOut ? GIT_SPAWN_TIMEOUT_CODE : code, stdout, stderr };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The git runner the commit-work family calls. Defaults to the real
 * {@link spawnGitExec}; kept as a named export so a single re-export point is
 * available, but production callers thread an injectable {@link GitRunner}
 * parameter (defaulting to this) rather than reaching for a mutable global.
 */
export const gitExec: GitRunner = spawnGitExec;

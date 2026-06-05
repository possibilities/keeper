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
}

/**
 * Run `git <args>` with both output streams drained concurrently.
 *
 * NEVER passes `--no-optional-locks` — see the module header. The caller is
 * responsible for never issuing tree-wide `git add -A/./*` (always pathspec-
 * scoped with a `--` separator per the epic's best-practices) and for holding
 * the commit-work flock around the stage→commit→push window.
 */
export async function gitExec(
  args: string[],
  options: GitExecOptions = {},
): Promise<GitExecResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: options.cwd,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Merge caller env over the ambient environment; a bare `env` would drop
    // PATH/HOME and break git's credential + config discovery.
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });

  // Drain both pipes CONCURRENTLY. Awaiting stdout fully before stderr would
  // deadlock on any child whose stderr fills the pipe buffer mid-run (and
  // vice-versa) — the pipe-buffer-backpressure hang the epic's best-practices
  // call out. `Bun.readableStreamToText` consumes the whole stream.
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

// The external-command facade seam for verbs that shell out to a non-git binary
// (gist's `gh` spawn + the platform browser opener). Every such spawn routes
// through the single PlanExec installed here.
//
// Production installs nothing: getExec() returns realExec, the verbatim
// Bun.spawnSync(...) implementation passing the live env, so the binary's
// behavior is untouched. The bun:test harness installs a driver registry (setExec)
// that matches a command name to a canned {exitCode, stdout, stderr} and records
// the argv, so the default test tier spawns zero real binaries and needs no
// PATH-shim executable.

/** Result of an external-command invocation — decoded stdout/stderr + exit. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for an external-command run. `env` overrides the inherited
 * environment; timeout/output caps make read helpers fail closed instead of
 * letting a wedged or noisy child pin the plan verb. */
export interface ExecOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/** The external-command surface verbs perform. A real implementation shells the
 * binary; the test driver matches the command name to a canned result. */
export interface PlanExec {
  /** Run `command` with `argv`, returning the decoded {exitCode, stdout, stderr}.
   * A spawn failure (missing binary) surfaces as a non-zero exit. */
  run(command: string, argv: string[], opts?: ExecOptions): ExecResult;
}

/** The production facade — verbatim binary spawns passing the live env. */
export const realExec: PlanExec = {
  run(command, argv, opts): ExecResult {
    try {
      const proc = Bun.spawnSync([command, ...argv], {
        env: opts?.env ?? process.env,
        ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts?.maxBufferBytes !== undefined
          ? { maxBuffer: opts.maxBufferBytes }
          : {}),
      });
      return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    } catch (exc) {
      return { exitCode: 127, stdout: "", stderr: (exc as Error).message };
    }
  },
};

let installed: PlanExec = realExec;

/** The currently installed facade. Defaults to realExec; the test harness swaps
 * in a driver registry via setExec. */
export function getExec(): PlanExec {
  return installed;
}

/** Install `exec` as the active facade (tests only). */
export function setExec(exec: PlanExec): void {
  installed = exec;
}

/** Restore the real exec facade (test teardown). */
export function resetExec(): void {
  installed = realExec;
}

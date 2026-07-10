/**
 * Session-id resolution for the `keeper commit-work` family — the port of
 * jobctl's `resolve_session_id` (apps/jobctl/jobctl/helpers.py:19).
 *
 * Resolution order, most-specific first:
 *   1. explicit `arg` (e.g. a `--session-id` flag);
 *   2. `JOBCTL_SESSION_ID` — the deliberate per-invocation override (kept under
 *      the legacy name so in-flight agent prompts that set it keep working
 *      through the jobctl→keeper rename);
 *   3. `CLAUDE_CODE_SESSION_ID` — the ambient Claude harness id;
 *   4. `KEEPER_JOB_ID` — the stable identity carried by tracked Pi and other
 *      Keeper-launched harnesses.
 *
 * The Python's ancestor-pid fallback is dropped: tracked harnesses carry an
 * explicit identity. The id is a spoofable correlation hint, not auth — this is
 * attribution, not access control — so fail-open (`null`) is correct when no
 * source is set.
 */

/** Resolve a tracked agent session id, or `null`. */
export function resolveSessionId(
  arg: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (arg) return arg;
  const jobctlSid = env.JOBCTL_SESSION_ID;
  if (jobctlSid) return jobctlSid;
  const claudeSid = env.CLAUDE_CODE_SESSION_ID;
  if (claudeSid) return claudeSid;
  const keeperJobId = env.KEEPER_JOB_ID;
  if (keeperJobId) return keeperJobId;
  return null;
}

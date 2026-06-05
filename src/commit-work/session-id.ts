/**
 * Session-id resolution for the `keeper commit-work` family — the port of
 * jobctl's `resolve_session_id` (apps/jobctl/jobctl/helpers.py:19).
 *
 * Resolution order, most-specific first:
 *   1. explicit `arg` (e.g. a `--session-id` flag);
 *   2. `JOBCTL_SESSION_ID` — the deliberate per-invocation override (kept under
 *      the legacy name so in-flight agent prompts that set it keep working
 *      through the jobctl→keeper rename);
 *   3. `CLAUDE_CODE_SESSION_ID` — the ambient harness id, set in every real
 *      Claude Code session, so commit-work self-resolves with NO flag.
 *
 * The Python's 4th fallback — a `cli_common.session_context` psutil
 * ancestor-pid walk — is DROPPED: there is no TS equivalent, and
 * `CLAUDE_CODE_SESSION_ID` is present in every real session, so the walk never
 * fired in practice. The id is a spoofable correlation hint, not auth — this is
 * attribution, not access control — so fail-open (`null`) is correct when no
 * source is set.
 */

/**
 * Resolve a Claude Code session id, or `null`. `env` defaults to
 * `process.env`; tests inject a controlled map.
 */
export function resolveSessionId(
  arg: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (arg) return arg;
  const jobctlSid = env.JOBCTL_SESSION_ID;
  if (jobctlSid) return jobctlSid;
  const claudeSid = env.CLAUDE_CODE_SESSION_ID;
  if (claudeSid) return claudeSid;
  return null;
}

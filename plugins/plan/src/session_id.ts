/** Resolve the session identity used by plan mutation, touched-path, and marker
 * state. An explicit neutral override wins; native Claude identity preserves the
 * existing Claude path; Keeper's job id supplies the same stable identity to Pi.
 */
export function resolvePlanSessionId(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const key of [
    "KEEPER_PLAN_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "KEEPER_JOB_ID",
  ] as const) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

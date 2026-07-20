export const TERMINAL_PROOF_LIFECYCLE_HOOKS_SQL =
  "'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Killed', 'RateLimited', 'ApiError', 'InputRequest', 'Notification'";

export interface OrderedTerminalProofInput {
  mutationEventId: number | null;
  state: string | null;
  sessionLifecycleTailEventId: number | null;
  sessionLifecycleTailHook: string | null;
  reducerCursorEventId: number | null;
}

/** A terminal lifecycle tail proves a session ended only after the relevant
 * mutation has folded. */
export function hasOrderedTerminalProof(
  row: OrderedTerminalProofInput,
): boolean {
  return (
    row.mutationEventId !== null &&
    row.sessionLifecycleTailEventId !== null &&
    row.sessionLifecycleTailEventId > row.mutationEventId &&
    row.reducerCursorEventId !== null &&
    row.reducerCursorEventId >= row.sessionLifecycleTailEventId &&
    (row.sessionLifecycleTailHook === "SessionEnd" ||
      row.sessionLifecycleTailHook === "Killed") &&
    (row.state === "ended" || row.state === "killed")
  );
}

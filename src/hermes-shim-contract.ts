/**
 * Dep-free hermes shim contract, shared between the keeper hermes-events-shim
 * hook (which MUST NOT import daemon code — hooks import FROM src, never the
 * reverse, see CLAUDE.md Hook rules) and the daemon-side launch config that
 * seeds hermes's `hooks:` block (`src/agent/launch-handle.ts`). `node:*`-only:
 * no `bun:sqlite`, no other keeper module.
 */

/**
 * The lifecycle events the hermes shim handles — the seeder registers exactly
 * this set in hermes's `hooks:` block so hermes only ever invokes the shim for
 * a mapped event. DRIFT GUARD: MUST equal the key set of `HERMES_EVENT_MAP` in
 * `plugins/keeper/plugin/hooks/hermes-events-shim.ts` — that map's translation
 * logic (event name → `{hookEvent, eventType}`) stays hook-side because it is
 * shim-internal, so the matching comment on both sides is the agreed guard.
 */
export const HERMES_SHIM_EVENTS: readonly string[] = [
  "on_session_start",
  "on_session_end",
  "pre_llm_call",
  "pre_tool_call",
  "post_tool_call",
  "subagent_start",
  "subagent_stop",
  "api_request_error",
  "pre_approval_request",
];

/**
 * Managed-block version for the seeder's sentinel. Bump when the registered
 * event set or the shim's config/line contract changes, so the seeder
 * re-seeds an older block on the next launch (hooks bind at hermes startup).
 * Stamped on self-seeded lines (`shim_version`) so the daemon can branch on
 * old-shim records; the ingest surface keeps accepting version-less lines from
 * stale shims (additive-only evolution).
 */
export const HERMES_SHIM_VERSION = 2;

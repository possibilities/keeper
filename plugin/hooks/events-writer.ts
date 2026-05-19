#!/usr/bin/env bun
/**
 * Keeper events writer hook. Invoked by Claude Code once per hook event with
 * the payload on stdin. Writes a single row to the `events` table and exits.
 *
 * Hard guarantees:
 * - **Always exit 0** — even on parse failure, DB failure, or any thrown
 *   exception. Per the epic's locked decision: a hook MUST NOT block Claude.
 *   Losing one event row is acceptable; wedging the agent is not. Errors log
 *   to stderr so they surface in `claude --debug` output.
 * - **Minimal import graph** — only `bun:sqlite` (via `src/db.ts`) and the
 *   local resolver. Bun cold start is ~30ms and the SessionEnd hook has a
 *   1.5s timeout cap; every extra import is borrowed from that budget.
 * - **`pid = process.ppid`** — matches `os.getppid()` semantics in the
 *   reference python hook. Informational only; the reducer keys by
 *   `session_id`.
 *
 * Schema parity with the python reference is intentional — the reducer reads
 * the same shape regardless of which writer landed the row.
 */

import { openDb, resolveDbPath } from "../../src/db";

/**
 * Hook event names that get renamed when stored as `event_type`. Matches
 * `_TYPE_MAP` in hooks-tracker.py:60-64. Everything else falls through to
 * snake_case (`PreToolUse` → `pre_tool_use`, etc).
 */
const TYPE_MAP: Record<string, string> = {
  SessionStart: "session_start",
  PostToolUse: "tool_use",
  Stop: "stop",
};

/**
 * Convert PascalCase / camelCase to snake_case. Mirrors the python regex at
 * `_snake_case` (hooks-tracker.py:293-294). Insert an underscore between any
 * lowercase/digit and following uppercase, then lowercase the whole thing.
 */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Read all of stdin as a UTF-8 string. Bun's `Bun.stdin` is a readable stream;
 * the hook payload is small (kilobytes), so we await the whole body before
 * parsing. A truncated/empty payload throws on `JSON.parse` and is caught by
 * the outer try-catch.
 */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Pull a string field from the payload, or null. Defensive against
 * non-string values (Claude Code occasionally puts objects in fields that
 * are documented as strings — never blow up).
 */
function strField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" ? v : null;
}

/**
 * fn-390 bridge column: PostToolUse:Agent rows carry the spawned subagent's
 * canonical id at `data.tool_response.agentId`. Persist it so the reducer can
 * join Pre/Post-Agent (tool_use_id-keyed) to SubagentStart/Stop
 * (agent_id-keyed) without heuristics. NULL on all other rows. camelCase on
 * the wire — `agentId`, not `agent_id`.
 */
function extractSubagentAgentId(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): string | null {
  if (hookEvent !== "PostToolUse" || toolName !== "Agent") {
    return null;
  }
  const toolResponse = data.tool_response;
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return null;
  }
  const candidate = (toolResponse as Record<string, unknown>).agentId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const data = JSON.parse(raw) as Record<string, unknown>;

  const hookEvent = strField(data, "hook_event_name") ?? "";
  if (!hookEvent) {
    // Empty hook_event_name matches the python reference's silent skip
    // behavior — Claude Code occasionally sends keepalive-shaped payloads
    // that aren't real events. Don't write a row for them.
    return;
  }

  // Notification events carry the notification subtype in `notification_type`;
  // surface it as the event_type so consumers can filter without parsing the
  // raw `data` JSON. Other named events use the TYPE_MAP rename; everything
  // else snake_cases the hook name.
  let eventType: string;
  if (hookEvent === "Notification") {
    eventType = strField(data, "notification_type") ?? "";
  } else if (TYPE_MAP[hookEvent]) {
    // biome-ignore lint/style/noNonNullAssertion: presence checked above
    eventType = TYPE_MAP[hookEvent]!;
  } else {
    eventType = snakeCase(hookEvent);
  }

  const ts = Date.now() / 1000;
  const pid = process.ppid;
  const sessionId = strField(data, "session_id") ?? "unknown";
  const toolName = strField(data, "tool_name");
  const matcher = strField(data, "matcher");
  const cwd = strField(data, "cwd");
  const permissionMode = strField(data, "permission_mode");
  const agentId = strField(data, "agent_id");
  const agentType = strField(data, "agent_type");

  // stop_hook_active is only meaningful on the Stop event; null elsewhere so
  // the column doesn't masquerade as a bool on unrelated rows.
  const stopHookActive =
    hookEvent === "Stop" ? (data.stop_hook_active ? 1 : 0) : null;

  const subagentAgentId = extractSubagentAgentId(hookEvent, toolName, data);

  const { db, stmts } = openDb(resolveDbPath());
  try {
    // BEGIN IMMEDIATE avoids the lock-upgrade SQLITE_BUSY path: a plain BEGIN
    // would start read-only and need to upgrade to write on INSERT, which
    // bypasses busy_timeout and errors immediately on contention. IMMEDIATE
    // grabs the reserved lock up front and waits per busy_timeout (5s) for
    // any in-flight writer.
    db.transaction(() => {
      stmts.insertEvent.run(
        ts,
        sessionId,
        pid,
        hookEvent,
        eventType,
        toolName,
        matcher,
        cwd,
        permissionMode,
        agentId,
        agentType,
        stopHookActive,
        raw,
        subagentAgentId,
      );
    })();
  } finally {
    db.close();
  }
}

// Outer guard: ANY failure here exits 0 with a stderr log. The hook contract
// is "never block Claude" — a stuck or wedged events-writer that propagates a
// non-zero exit can fail-closed the user's session, which is far worse than a
// missing event row.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`keeper events-writer: ${err}\n`);
    process.exit(0);
  });

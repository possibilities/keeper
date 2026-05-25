/**
 * Pure per-event helpers for the `subagent_invocations` projection — the
 * TypeScript port of jobctl's `apps/cli_common/cli_common/subagent_invocations.py`
 * reference parser (minus the billing-flavored `tokens` / `tool_use_count`
 * fields, which belong in usagectl, not keeper).
 *
 * The Python reference does ONE-PASS bulk parsing with three in-memory
 * buffers (`entry_map`, `turn_counter`, `pending_pre_by_tool_use_id`). The
 * TS port intentionally does NOT carry the buffers — the reducer (task .3)
 * folds events one at a time inside its own `BEGIN IMMEDIATE` transaction
 * and the buffered state is recoverable from persisted rows / events-table
 * lookups instead. This module exposes the four lookups the reducer needs:
 *
 * - {@link extractTurnSeq} — derive the next `turn_seq` for an `agent_id`
 *   from the persisted projection rows (`SELECT MAX(turn_seq) + 1`); replaces
 *   the Python `turn_counter` dict.
 * - {@link findOpenTurnForStop} — find the open turn for a SubagentStop fold
 *   (`duration_ms IS NULL`, latest `turn_seq`); replaces the reverse-scan over
 *   `entry_map`. Gates on `duration_ms IS NULL` ALONE per fn-480 — never also
 *   on `status='running'`; PostToolUse:Agent legitimately flips status to
 *   `'ok'` BEFORE SubagentStop lands for Task calls.
 * - {@link findBridgePreToolUse} — bridge lookup for the PostToolUse:Agent
 *   fold; replaces the `pending_pre_by_tool_use_id` buffer with an events-table
 *   query (`WHERE session_id=? AND tool_use_id=? AND hook_event='PreToolUse'
 *   AND tool_name='Agent'`). The `session_id` is mandatory — cross-job
 *   tool_use_id collisions are possible and the buffer-less design has no
 *   other way to scope.
 * - {@link resolveBridgeAgentId} — the column-then-JSON fallback for the
 *   `subagent_agent_id` bridge (post-fn-390 rows have the column populated;
 *   pre-migration rows fall back to `data.tool_response.agentId`).
 *
 * Plus two helpers for the parity test:
 *
 * - {@link truncateDescription} — port of Python's `_DESCRIPTION_MAX_CHARS=200`.
 * - {@link canonicalizeRow} — produces Python's
 *   `json.dumps(sort_keys=True, separators=(',',':'))` shape byte-for-byte
 *   for golden-fixture comparison.
 *
 * Every function here is PURE — no I/O outside the explicitly-passed `Database`
 * for the read-only lookups, no clock reads, no mutation of input arguments.
 * Re-fold determinism (CLAUDE.md "byte-identical re-fold" invariant) depends
 * on that purity: the lookups read persisted-state-at-fold-time, exactly what
 * a from-scratch re-fold would read.
 */

import type { Database } from "bun:sqlite";

/**
 * Description-field max chars — defense-in-depth against bloated metadata.
 * Mirrors Python's `_DESCRIPTION_MAX_CHARS` constant
 * (`apps/cli_common/cli_common/subagent_invocations.py:78`). Single source of
 * truth on the TS side; the reducer (task .3) imports this constant when
 * folding PreToolUse description payloads.
 */
export const DESCRIPTION_MAX_CHARS = 200;

/**
 * Per-event helper inputs — the minimal projection of an `events` row needed
 * by {@link resolveBridgeAgentId}. The reducer hands the full event row to
 * the per-event helper; we keep the shape narrow so callers can synthesize a
 * fixture row without needing the entire `Event` type.
 */
export interface BridgeEventInput {
  subagent_agent_id: string | null;
  data: string | { tool_response?: unknown };
}

/**
 * Result of {@link findBridgePreToolUse} — the three PreToolUse:Agent payload
 * fields the PostToolUse:Agent fold lifts onto the turn-0 row. `null` when no
 * matching PreToolUse row exists for the `(session_id, tool_use_id)` pair.
 */
export interface BridgePreToolUseRow {
  description: string | null;
  prompt_chars: number;
  subagent_type: string | null;
}

/**
 * Canonical row shape for golden-fixture parity. Mirrors the Python
 * `_make_turn_entry` output (`subagent_invocations.py:288-300`) MINUS the
 * `tokens` / `tool_use_count` fields. The fields are listed alphabetically
 * here for readability; {@link canonicalizeRow} sorts on serialization to
 * match Python's `sort_keys=True`.
 */
export interface CanonicalRow {
  agent_id: string;
  description: string | null;
  duration_ms: number | null;
  prompt_chars: number;
  status: "running" | "ok" | "failed" | "unknown";
  subagent_type: string | null;
  tool_use_id: string | null;
  ts: number;
  turn_seq: number;
}

/**
 * Read the next `turn_seq` for a `(job_id, agent_id)` pair from persisted
 * projection state. Replaces the Python `turn_counter[agent_id]` dict — the
 * reducer is buffer-less and re-derives from the projection at fold time.
 *
 * Returns 0 on a fresh `agent_id` (no rows yet), matching Python's
 * `turn_counter.get(agent_id, 0)` default at the first SubagentStart.
 *
 * The `MAX(turn_seq) + 1` formulation is pure — re-fold determinism holds
 * because the reducer writes a fresh row with the returned `turn_seq` inside
 * the same `BEGIN IMMEDIATE` transaction. A from-scratch re-fold replays the
 * SubagentStart events in id-order and lands the same `turn_seq` sequence.
 */
export function extractTurnSeq(
  db: Database,
  jobId: string,
  agentId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(turn_seq), -1) + 1 AS next_seq
         FROM subagent_invocations
        WHERE job_id = ? AND agent_id = ?`,
    )
    .get(jobId, agentId) as { next_seq: number } | null;
  return row?.next_seq ?? 0;
}

/**
 * Find the open turn for a SubagentStop fold — the latest `turn_seq` for the
 * given `(job_id, agent_id)` pair with `duration_ms IS NULL`. Replaces the
 * reverse-scan over Python's `entry_map`.
 *
 * Returns `null` when no open turn exists (genuine orphan SubagentStop — no
 * SubagentStart ever fired for this `agent_id`, or every prior turn already
 * closed). The reducer must treat `null` as a safe no-op: cursor advances,
 * no row mutation, no throw (CLAUDE.md "fold never throws" invariant).
 *
 * fn-480 invariant: gates on `duration_ms IS NULL` ALONE — never also on
 * `status='running'`. PostToolUse:Agent fires BEFORE SubagentStop for Task
 * calls (Anthropic-confirmed); it legitimately flips status to `'ok'` before
 * the row closes. Double-close protection rests on `duration_ms IS NULL`:
 * after a successful close, `duration_ms` is non-null and a second
 * SubagentStop's lookup walks past.
 */
export function findOpenTurnForStop(
  db: Database,
  jobId: string,
  agentId: string,
): number | null {
  const row = db
    .prepare(
      `SELECT turn_seq
         FROM subagent_invocations
        WHERE job_id = ? AND agent_id = ? AND duration_ms IS NULL
        ORDER BY turn_seq DESC
        LIMIT 1`,
    )
    .get(jobId, agentId) as { turn_seq: number } | null;
  return row?.turn_seq ?? null;
}

/**
 * Bridge lookup for the PostToolUse:Agent fold. Looks up the matching
 * PreToolUse:Agent event row in the events table by `(session_id,
 * tool_use_id)` and pulls out description / prompt_chars / subagent_type
 * from its `data.tool_input` payload.
 *
 * Replaces Python's `pending_pre_by_tool_use_id` buffer. The TS port has no
 * in-process buffer because the reducer folds one event per transaction;
 * the matching PreToolUse:Agent has already landed in the events table by
 * the time PostToolUse:Agent folds.
 *
 * `session_id` is mandatory in the WHERE — two sessions can carry the same
 * `tool_use_id` string (Anthropic-unique within a session but not
 * cross-session in our DB). The `cross-job-tool-use-id-collision` fixture
 * verifies this isolation.
 *
 * Returns `null` when no matching PreToolUse row exists; the reducer treats
 * `null` as "no spawn metadata to fold" and leaves the turn-0 entry's
 * description / prompt_chars / subagent_type at their SubagentStart-seeded
 * defaults. Defensive parsing: malformed JSON or missing fields fold to
 * `null` / `0` per Python's behavior.
 *
 * `prompt_chars` returns 0 (NOT null) on a missing `tool_input.prompt`,
 * matching Python's `_make_turn_entry`'s `"prompt_chars": 0` default and
 * the SQL `length(NULL) → NULL` → JS `0` coercion in the parser.
 */
export function findBridgePreToolUse(
  db: Database,
  sessionId: string,
  toolUseId: string,
): BridgePreToolUseRow | null {
  const row = db
    .prepare(
      `SELECT data
         FROM events
        WHERE session_id = ? AND tool_use_id = ?
              AND hook_event = 'PreToolUse' AND tool_name = 'Agent'
        ORDER BY id ASC
        LIMIT 1`,
    )
    .get(sessionId, toolUseId) as { data: string } | null;
  if (row === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return { description: null, prompt_chars: 0, subagent_type: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { description: null, prompt_chars: 0, subagent_type: null };
  }
  const toolInput = (parsed as { tool_input?: unknown }).tool_input;
  if (typeof toolInput !== "object" || toolInput === null) {
    return { description: null, prompt_chars: 0, subagent_type: null };
  }
  const ti = toolInput as {
    description?: unknown;
    prompt?: unknown;
    subagent_type?: unknown;
  };
  const description =
    typeof ti.description === "string" && ti.description.length > 0
      ? truncateDescription(ti.description)
      : null;
  const promptChars = typeof ti.prompt === "string" ? ti.prompt.length : 0;
  const subagentType =
    typeof ti.subagent_type === "string" && ti.subagent_type.length > 0
      ? ti.subagent_type
      : null;
  return {
    description,
    prompt_chars: promptChars,
    subagent_type: subagentType,
  };
}

/**
 * Result of {@link findPendingPreToolUseForStart} — the three PreToolUse:Agent
 * payload fields the SubagentStart fold lifts onto the freshly-inserted
 * turn-N row. `tool_use_id` is always populated (the lookup uses it as the
 * binding key); `description` is null when the PreToolUse payload had none.
 */
export interface PendingPreToolUseRow {
  description: string | null;
  prompt_chars: number;
  tool_use_id: string;
}

/**
 * Early FIFO bridge for the SubagentStart fold. Returns the earliest
 * `PreToolUse:Agent` event row in this session whose `tool_input.subagent_type`
 * matches the SubagentStart's `agent_type` AND whose `tool_use_id` has not yet
 * been bound to any `subagent_invocations` row in this session.
 *
 * Why FIFO: at `SubagentStart` time Anthropic hasn't yet emitted the
 * `(tool_use_id, agent_id)` correlator (that arrives on `PostToolUse:Agent`,
 * after the subagent closes). So the early bridge is a heuristic — match the
 * earliest unbound PreToolUse in this session whose `subagent_type` matches
 * the incoming `agent_type`. Within a session Task dispatch is ordered, so
 * FIFO assignment is correct in practice. Any mis-assignment self-corrects
 * when `PostToolUse:Agent` lands and the authoritative `subagent_agent_id`
 * bridge runs in {@link findBridgePreToolUse} — the canonical overwrite still
 * wins, so steady-state rows match the no-early-bridge behavior.
 *
 * Re-fold determinism: the lookup reads persisted-at-fold-time state only
 * (events rows ordered by id ASC, projection rows scoped to `job_id`). A
 * from-scratch re-fold replays events in id-order and reproduces the same
 * FIFO assignment byte-identically.
 *
 * Returns `null` when:
 * - `agentType` is null / empty (no type to match on; conservative no-lift)
 * - no PreToolUse:Agent row in this session matches the type and is unbound
 * - every matching row has malformed `data` JSON (skipped per row)
 *
 * NEVER throws — the fold's safe-default contract holds.
 */
export function findPendingPreToolUseForStart(
  db: Database,
  sessionId: string,
  agentType: string | null,
): PendingPreToolUseRow | null {
  if (agentType == null || agentType.length === 0) {
    return null;
  }
  // Earliest PreToolUse:Agent in this session whose tool_use_id is not yet
  // bound to any subagent_invocations row for this session (job_id). NOT
  // EXISTS is the anti-join; the partial idx_events_tool_use_id + the
  // (session_id, tool_name, hook_event) predicate keep this cheap (one
  // session's worth of agent-tool calls is tiny). ORDER BY id ASC gives a
  // total order that matches the fold's own event-replay order, so re-fold
  // assignment is deterministic.
  const rows = db
    .prepare(
      `SELECT tool_use_id, data
         FROM events e
        WHERE e.session_id = ?
              AND e.hook_event = 'PreToolUse'
              AND e.tool_name = 'Agent'
              AND e.tool_use_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM subagent_invocations si
                   WHERE si.job_id = ?
                         AND si.tool_use_id = e.tool_use_id
              )
        ORDER BY e.id ASC`,
    )
    .all(sessionId, sessionId) as { tool_use_id: string; data: string }[];

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const toolInput = (parsed as { tool_input?: unknown }).tool_input;
    if (typeof toolInput !== "object" || toolInput === null) {
      continue;
    }
    const ti = toolInput as {
      description?: unknown;
      prompt?: unknown;
      subagent_type?: unknown;
    };
    if (
      typeof ti.subagent_type !== "string" ||
      ti.subagent_type !== agentType
    ) {
      continue;
    }
    const description =
      typeof ti.description === "string" && ti.description.length > 0
        ? truncateDescription(ti.description)
        : null;
    const promptChars = typeof ti.prompt === "string" ? ti.prompt.length : 0;
    return {
      description,
      prompt_chars: promptChars,
      tool_use_id: row.tool_use_id,
    };
  }
  return null;
}

/**
 * Resolve the `subagent_agent_id` bridge with column-then-JSON fallback.
 * Mirrors Python's `_resolve_bridge_agent_id`
 * (`subagent_invocations.py:240-258`).
 *
 * Post-fn-390 rows have `events.subagent_agent_id` populated by the hook's
 * `extractSubagentAgentId` deriver. Pre-fn-390 historical rows have NULL
 * there but still carry `data.tool_response.agentId` in the JSON blob —
 * the fallback path handles those.
 *
 * Defensive: malformed JSON, non-object `tool_response`, missing `agentId`,
 * or a non-string `agentId` all return `null` instead of throwing.
 */
export function resolveBridgeAgentId(event: BridgeEventInput): string | null {
  if (
    typeof event.subagent_agent_id === "string" &&
    event.subagent_agent_id.length > 0
  ) {
    return event.subagent_agent_id;
  }

  let dataObj: { tool_response?: unknown } | null = null;
  if (typeof event.data === "string") {
    try {
      const parsed = JSON.parse(event.data);
      if (typeof parsed === "object" && parsed !== null) {
        dataObj = parsed as { tool_response?: unknown };
      }
    } catch {
      return null;
    }
  } else if (typeof event.data === "object" && event.data !== null) {
    dataObj = event.data;
  }
  if (dataObj === null) {
    return null;
  }
  const toolResponse = dataObj.tool_response;
  let respObj: { agentId?: unknown } | null = null;
  if (typeof toolResponse === "string") {
    try {
      const parsed = JSON.parse(toolResponse);
      if (typeof parsed === "object" && parsed !== null) {
        respObj = parsed as { agentId?: unknown };
      }
    } catch {
      return null;
    }
  } else if (typeof toolResponse === "object" && toolResponse !== null) {
    respObj = toolResponse as { agentId?: unknown };
  }
  if (respObj === null) {
    return null;
  }
  const candidate = respObj.agentId;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return null;
}

/**
 * Truncate a description string to {@link DESCRIPTION_MAX_CHARS}. Port of
 * Python's `str(description_raw)[:_DESCRIPTION_MAX_CHARS]`
 * (`subagent_invocations.py:339`). Pure: no mutation of `s`.
 *
 * UTF-16 code unit count matches Python's character count for the BMP; for
 * astral-plane characters the byte counts diverge — but description fields
 * in practice are ASCII / Latin / common-script text and the 200-cap is
 * defense-in-depth, not a precise budget. Acceptable per Python's loose
 * `str(...)[:N]` semantics.
 */
export function truncateDescription(
  s: string,
  maxChars: number = DESCRIPTION_MAX_CHARS,
): string {
  return s.slice(0, maxChars);
}

/**
 * Serialize a row in Python's canonical JSON form:
 * `json.dumps(row, sort_keys=True, separators=(',', ':'))`. Used by the
 * golden-fixture parity test.
 *
 * Python's behavior the canonicalizer must match byte-for-byte:
 * - Keys sorted alphabetically at every level.
 * - No whitespace between key/value separators (`","` and `":"`).
 * - `null` for explicit `null` values — NEVER drop the key (JS
 *   `JSON.stringify` would only drop `undefined` values, but we treat
 *   `null` and `undefined` symmetrically here).
 * - Integers serialize without a trailing `.0` (matches Python's
 *   `json.dumps(int_value)`).
 *
 * The implementation is a recursive descent that re-builds the value with
 * sorted keys before handing off to `JSON.stringify` with no spacing. Arrays
 * preserve insertion order (Python does the same — `sort_keys` only sorts
 * dict keys).
 *
 * Re-fold determinism note: the canonicalizer is pure and order-independent
 * on the input dict, so the same row dict produces the same string on every
 * call — exactly what the parity test needs.
 */
export function canonicalizeRow(row: unknown): string {
  return JSON.stringify(sortValue(row));
}

function sortValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = sortValue(obj[k]);
    }
    return out;
  }
  // Primitives — number/string/boolean pass through unchanged.
  return value;
}

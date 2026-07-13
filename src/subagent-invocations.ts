/**
 * Pure per-event helpers for the `subagent_invocations` projection — a
 * TypeScript port of the Python `subagent_invocations` reference parser
 * (formerly arthack `cli_common`; since retired upstream — keeper's TS is now
 * the sole implementation), minus the billing-flavored `tokens` /
 * `tool_use_count` fields, which belong in usagectl, not keeper.
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
 * Mirrors the retired Python parser's `_DESCRIPTION_MAX_CHARS` constant.
 * Single source of truth on the TS side; the reducer (task .3) imports this
 * constant when folding PreToolUse description payloads.
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
 * Canonical row shape for golden-fixture parity. Mirrors the retired Python
 * `_make_turn_entry` output MINUS the
 * `tokens` / `tool_use_count` fields. The fields are listed alphabetically
 * here for readability; {@link canonicalizeRow} sorts on serialization to
 * match Python's `sort_keys=True`.
 */
export interface CanonicalRow {
  agent_id: string;
  description: string | null;
  duration_ms: number | null;
  prompt_chars: number;
  status: "running" | "ok" | "failed" | "unknown" | "superseded";
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
 * The CANONICAL "open turn" status set — the single source of truth for subagent
 * liveness. A `subagent_invocations` row is IN FLIGHT (its turn has not closed)
 * iff `duration_ms IS NULL` AND its status is in this set. Every liveness site —
 * the reducer's Stop + ApiError guards (via {@link findFreshInFlightSubagentAnchor}),
 * the SessionEnd/Killed sweep, the readiness predicate-6 index, and the
 * readiness-client collapse — routes through this ONE definition (the SQL sites
 * via {@link OPEN_TURN_STATUS_SQL}, the TS sites via {@link isOpenTurnRow}) so
 * they can never drift; drift between consumers is the exact bug class this
 * fixes, and a parity test pins the agreement.
 *
 * `'ok'` is a member because PostToolUse:Agent flips a still-open turn to `'ok'`
 * BEFORE its SubagentStop lands (Anthropic-confirmed). An `'ok'` row with a NULL
 * `duration_ms` is a backgrounded sub still in flight, NOT a finished one — and
 * `duration_ms IS NULL` is precisely what separates the two, since SubagentStop
 * stamps a non-NULL `duration_ms` on close. The supersession scan
 * ({@link findOpenRunningInGroup}) is NOT a liveness site and deliberately stays
 * on a bare `status='running'`.
 *
 * Whitelist, not blacklist, by design: `'failed'` / `'unknown'` / `'superseded'`
 * are terminal and excluded, and an unknown future status fails CLOSED (it never
 * silently passes a liveness guard the way a blacklist would).
 */
export const OPEN_TURN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "ok",
]);

/**
 * The SQL `IN (...)` value list for {@link OPEN_TURN_STATUSES}, DERIVED from the
 * same set so the SQL-side liveness guards and the TS-side ones cannot diverge.
 * The values are compile-time string constants (no user input), safe to
 * interpolate into a query the same way the reducer interpolates `ENDED` /
 * `KILLED`. A parity test asserts this fragment matches the set membership.
 */
export const OPEN_TURN_STATUS_SQL: string = [...OPEN_TURN_STATUSES]
  .map((s) => `'${s}'`)
  .join(", ");

/**
 * The TS-side mirror of the open-turn SQL predicate. A row is in flight iff its
 * `duration_ms` is NULL and its status is an {@link OPEN_TURN_STATUSES} member.
 * Used by the two NON-SQL liveness sites (readiness predicate-6 index +
 * readiness-client collapse) so they agree byte-for-byte with the reducer's SQL
 * guards. Accepts the minimal `{ status, duration_ms }` shape so any row
 * projection satisfies it.
 */
export function isOpenTurnRow(row: {
  status: string;
  duration_ms: number | null;
}): boolean {
  return row.duration_ms == null && OPEN_TURN_STATUSES.has(row.status);
}

export function canonicalSubagentInvocations<
  T extends {
    job_id?: unknown;
    agent_id?: unknown;
    turn_seq?: unknown;
    subagent_type?: unknown;
  },
>(rows: readonly T[]): T[] {
  const groups = new Map<string, T>();
  const malformed: T[] = [];
  for (const row of rows) {
    if (
      typeof row.job_id !== "string" ||
      typeof row.agent_id !== "string" ||
      typeof row.turn_seq !== "number" ||
      !Number.isFinite(row.turn_seq) ||
      !(typeof row.subagent_type === "string" || row.subagent_type == null)
    ) {
      malformed.push(row);
      continue;
    }
    const key = `${row.job_id}\x00${row.subagent_type ?? ""}`;
    const prior = groups.get(key);
    if (
      prior === undefined ||
      (row.turn_seq as number) > (prior.turn_seq as number) ||
      ((row.turn_seq as number) === (prior.turn_seq as number) &&
        (row.agent_id as string) < (prior.agent_id as string))
    ) {
      groups.set(key, row);
    }
  }
  const canonical = [...groups.values()];
  canonical.sort((a, b) => {
    const aKey = `${a.job_id as string}\x00${a.subagent_type ?? ""}\x00${a.agent_id as string}`;
    const bKey = `${b.job_id as string}\x00${b.subagent_type ?? ""}\x00${b.agent_id as string}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return canonical.concat(malformed);
}

/**
 * Liveness decision for the reducer's Stop + ApiError/RateLimited guards: should
 * the parent job's state flip be SUPPRESSED because a fresh in-flight subagent is
 * still surviving? Returns `true` to BLOCK the flip (a fresh, or age-uncomputable,
 * open-turn survivor exists), `false` to RELEASE it (no in-flight survivor, or
 * even the freshest survivor's age strictly exceeds `maxGapSec`).
 *
 * "Survivor" applies the same same-name collapse the client's
 * `collapseSubagentsByName` does: an open-turn row is ignored when a LATER
 * same-`(job_id, subagent_type)` `turn_seq` row exists ("same name, higher
 * turn_seq" → the older row is an orphan whose SubagentStop never landed). The
 * `subagent_type IS …` join is null-safe equality.
 *
 * Anchor + freshness (mirrors {@link findOpenTurnForStop}'s re-fold-determinism
 * rationale — a pure read over persisted-state-at-fold-time, never a clock read):
 * - In-flight membership is the canonical open-turn predicate
 *   (`duration_ms IS NULL AND status IN (...)`), NOT a bare `status='running'`,
 *   so a backgrounded `ok` sub (NULL `duration_ms`) still blocks.
 * - The freshness anchor is last-activity `updated_at` (re-stamped by every
 *   SubagentTurn / PostToolUse:Agent / SubagentStop), NOT the frozen SubagentStart
 *   spawn `ts` — so a slow-but-alive sub re-arms its window on each activity. The
 *   pick is the FRESHEST survivor: `ORDER BY updated_at DESC` PLUS a deterministic
 *   secondary sort (`turn_seq DESC, agent_id ASC`) so `updated_at` ties (the
 *   sweep/bulk folds stamp identical `updated_at`, so ties are likelier than on
 *   `ts`) never make the anchor non-deterministic — re-fold determinism would
 *   break otherwise.
 * - `updated_at IS NULL` or `updated_at <= 0` is UNCOMPUTABLE → conservatively
 *   BLOCKS (never release on an age we cannot trust). Release only when the age
 *   `eventTs - updated_at` STRICTLY exceeds `maxGapSec`; at/under the bound, and
 *   a negative age from clock skew, both stay blocking.
 */
export function findFreshInFlightSubagentAnchor(
  db: Database,
  jobId: string,
  maxGapSec: number,
  eventTs: number,
): boolean {
  const anchor = db
    .prepare(
      `SELECT s1.updated_at AS updated_at
         FROM subagent_invocations s1
        WHERE s1.job_id = ?
          AND s1.duration_ms IS NULL
          AND s1.status IN (${OPEN_TURN_STATUS_SQL})
          AND NOT EXISTS (
            SELECT 1 FROM subagent_invocations s2
             WHERE s2.job_id = s1.job_id
               AND s2.subagent_type IS s1.subagent_type
               AND s2.turn_seq > s1.turn_seq
          )
        ORDER BY s1.updated_at DESC, s1.turn_seq DESC, s1.agent_id ASC
        LIMIT 1`,
    )
    .get(jobId) as { updated_at: number | null } | null;
  if (anchor == null) {
    return false; // no in-flight survivor — release.
  }
  const updatedAt = anchor.updated_at;
  if (updatedAt == null || updatedAt <= 0) {
    return true; // age uncomputable — conservatively keep blocking.
  }
  return eventTs - updatedAt <= maxGapSec;
}

/**
 * One element in the `findOpenRunningInGroup` result set. Returned by the
 * supersession scan fired from the PostToolUse:Agent arm of the reducer once
 * the bridged row's authoritative `subagent_type` is known — every earlier
 * still-running same-group row gets marked `status='superseded'`.
 */
export interface OpenRunningInGroupRow {
  agent_id: string;
  turn_seq: number;
}

/**
 * Find all OTHER rows in the same `(job_id, subagent_type)` group that are
 * still `status='running'` and whose SubagentStart-time `ts` is strictly less
 * than the given `currentTs`. Used by the PostToolUse:Agent arm to mark prior
 * concurrent same-type subagents as `superseded` once the current row's
 * authoritative `subagent_type` is known (PreToolUse-wins precedence).
 *
 * The `ts < ?` gate uses the row's SubagentStart spawn ts — NOT the current
 * event's ts. This means a concurrent same-type spawn whose SubagentStart
 * landed AFTER the bridged row's spawn is NOT swept (it spawned later, so it
 * cannot have been superseded by the bridged row). This is the deliberate
 * gate to keep the supersession arm narrow: only earlier-spawned still-open
 * peers are marked superseded. The known false-positive — two concurrent
 * `Task(subagent_type=X)` calls fired in one parent message where (a)'s
 * earlier-spawned sibling gets flipped to `superseded` the instant (a)'s
 * PostToolUse:Agent lands — is documented in the epic spec as out-of-scope
 * for v1.
 *
 * Returns the `(agent_id, turn_seq)` of every match; the caller bulk-updates
 * inside the same `BEGIN IMMEDIATE` transaction. Returns an empty array when
 * no other open same-type rows exist (the common case — most subagents are
 * sequential within a turn).
 */
export function findOpenRunningInGroup(
  db: Database,
  jobId: string,
  subagentType: string,
  excludeAgentId: string,
  currentTs: number,
): OpenRunningInGroupRow[] {
  return db
    .prepare(
      `SELECT agent_id, turn_seq
         FROM subagent_invocations
        WHERE job_id = ?
          AND subagent_type = ?
          AND status = 'running'
          AND ts < ?
          AND agent_id != ?`,
    )
    .all(jobId, subagentType, currentTs, excludeAgentId) as Array<{
    agent_id: string;
    turn_seq: number;
  }>;
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
  // fn-836.4: read the PreToolUse:Agent body straight from `events.data` — the
  // `event_blobs` side table + its COALESCE dual-read are gone (the shed kept
  // every Agent body inline). PreToolUse:Agent is keep-set, so its body was
  // never shed; the idx_events_tool_use_id seek over the scalar WHERE is
  // unchanged.
  const row = db
    .prepare(
      `SELECT data
         FROM events e
        WHERE e.session_id = ? AND e.tool_use_id = ?
              AND e.hook_event = 'PreToolUse' AND e.tool_name = 'Agent'
        ORDER BY e.id ASC
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
 * Parsed-out fields of a candidate `PreToolUse:Agent` body — everything the
 * FIFO bridge needs EXCEPT the `agentType` comparison (that is a per-call
 * argument, never a property of the immutable row). `null` marks a blob that
 * can NEVER match any `agentType`: malformed JSON, a non-object body, a
 * missing/non-object `tool_input`, or a non-string `subagent_type`.
 */
interface ParsedPreToolUseAgent {
  subagent_type: string;
  description: string | null;
  prompt_chars: number;
}

/**
 * Per-`Database` parse cache for {@link findPendingPreToolUseForStart} (fn-1052).
 *
 * The measured SubagentStart fold cost (avg 2.6s / max 27.6s on the live DB)
 * was the `JSON.parse` of EVERY still-unbound `PreToolUse:Agent` candidate in
 * the session, re-paid on every SubagentStart — so per-event cost grew with the
 * session's accumulated agent-call count. The anti-join SQL stays a LIVE query
 * (exact by construction — it models PostToolUse:Agent re-binding / FIFO
 * self-correction across three fold arms, which a materialized pending-set
 * could not), while the parse of each candidate's `events.data` blob — the
 * measured cost — is memoized here per EVENT ID. `PreToolUse:Agent` is
 * retention keep-set (its body is never NULLed), so a row's `data` is immutable
 * and its parse is stable forever — the cache keys on event id ALONE and needs
 * no invalidation story.
 *
 * Watermark discipline (mirrors the `gitAttribMemos` malformed-row rule): a
 * malformed / non-matching-shape blob is cached as `null`, so a
 * permanently-malformed low-id candidate that never binds is parsed exactly
 * ONCE — it never re-anchors the parse loop on later folds.
 *
 * PURE optimization: the match decision (`subagent_type === agentType`) stays
 * LIVE per call; only the immutable parse is cached. Caching a match DECISION
 * would smuggle the mutable per-call `agentType` into the fold. So a cold
 * rebuild on a fresh connection reproduces byte-identical bridge assignments.
 * Keyed by `Database` via a `WeakMap` so a dropped connection's cache is
 * collected and a fresh-DB-per-test starts cold by construction. No boot-seed
 * warmer: unlike `gitAttribMemos` (a whole-`events` scan hoisted out of the
 * boot lock), this probe is already `session_id`-scoped, so a cold first fold
 * touches only ONE session's tiny candidate set — there is no global-history
 * scan to pre-warm, and each session lazily warms on its first SubagentStart.
 */
const subagentPreParseMemos = new WeakMap<
  Database,
  Map<number, ParsedPreToolUseAgent | null>
>();

/**
 * Test-only: drop the per-`Database` PreToolUse:Agent parse cache so the NEXT
 * {@link findPendingPreToolUseForStart} on this connection re-parses cold.
 * Production never calls this — the WeakMap collects a dropped connection's
 * cache on its own, and a fresh-DB-per-test is cold by construction. Exposed so
 * a warm-vs-cold equivalence test can force a cold parse on a warmed connection.
 */
export function __resetSubagentPreParseMemoForTest(db: Database): void {
  subagentPreParseMemos.delete(db);
}

/**
 * Parse one `PreToolUse:Agent` `events.data` blob into the fields the FIFO
 * bridge needs, or `null` when the blob can never match any `agentType`. NEVER
 * throws — a malformed body folds to `null`, honoring the reducer's
 * safe-default contract. Side-effect-free so its result caches by immutable
 * event id.
 */
function parsePreToolUseAgentBlob(data: string): ParsedPreToolUseAgent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const toolInput = (parsed as { tool_input?: unknown }).tool_input;
  if (typeof toolInput !== "object" || toolInput === null) {
    return null;
  }
  const ti = toolInput as {
    description?: unknown;
    prompt?: unknown;
    subagent_type?: unknown;
  };
  if (typeof ti.subagent_type !== "string") {
    return null;
  }
  const description =
    typeof ti.description === "string" && ti.description.length > 0
      ? truncateDescription(ti.description)
      : null;
  const promptChars = typeof ti.prompt === "string" ? ti.prompt.length : 0;
  return {
    subagent_type: ti.subagent_type,
    description,
    prompt_chars: promptChars,
  };
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
 * `currentEventId` is the folding SubagentStart's own event id; the candidate
 * scan is clamped `id < currentEventId` so it sees only PreToolUse:Agent rows
 * that existed BEFORE this SubagentStart — exactly what the live fold saw.
 * Without the ceiling a from-scratch re-fold (every row already present) — or
 * even a live drain that ingested a batch ahead of the cursor — would bind a
 * FUTURE candidate the live fold at this id never saw, a latent divergence.
 *
 * Re-fold determinism: the lookup reads persisted-at-fold-time state only
 * (events rows below `currentEventId` ordered by id ASC, projection rows scoped
 * to `job_id`). A from-scratch re-fold replays events in id-order and
 * reproduces the same FIFO assignment byte-identically. The per-event-id parse
 * cache ({@link subagentPreParseMemos}) is a pure optimization over immutable
 * keep-set bodies, so a warm fold equals a cold rebuild.
 *
 * Returns `null` when:
 * - `agentType` is null / empty (no type to match on; conservative no-lift)
 * - no PreToolUse:Agent row below `currentEventId` in this session matches the
 *   type and is unbound
 * - every matching row has malformed `data` JSON (skipped per row)
 *
 * NEVER throws — the fold's safe-default contract holds.
 */
export function findPendingPreToolUseForStart(
  db: Database,
  sessionId: string,
  agentType: string | null,
  currentEventId: number,
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
  // fn-836.4: read the PreToolUse:Agent body straight from `events.data` — the
  // `event_blobs` side table + its COALESCE dual-read are gone (Agent is
  // keep-set, never shed). The WHERE (session_id, hook_event, tool_name,
  // tool_use_id) + the NOT EXISTS anti-join filter the same indexed scalar
  // columns, so idx_events_tool_use_id keeps covering the seek.
  // fn-1052: the `e.id < ?` ceiling (a rowid range, intrinsic to the PK — it
  // does not perturb the covering seek) clamps the candidate set to what the
  // live fold saw at this SubagentStart. `e.id AS id` feeds the per-event-id
  // parse cache below.
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.tool_use_id, e.data AS data
         FROM events e
        WHERE e.session_id = ?
              AND e.hook_event = 'PreToolUse'
              AND e.tool_name = 'Agent'
              AND e.tool_use_id IS NOT NULL
              AND e.id < ?
              AND NOT EXISTS (
                  SELECT 1 FROM subagent_invocations si
                   WHERE si.job_id = ?
                         AND si.tool_use_id = e.tool_use_id
              )
        ORDER BY e.id ASC`,
    )
    .all(sessionId, currentEventId, sessionId) as {
    id: number;
    tool_use_id: string;
    data: string;
  }[];

  // fn-1052: memoize the per-candidate `JSON.parse` (the measured fold cost) by
  // immutable event id so an unbound candidate is parsed exactly ONCE across a
  // session's SubagentStart folds, not re-parsed on every one.
  let memo = subagentPreParseMemos.get(db);
  if (memo == null) {
    memo = new Map();
    subagentPreParseMemos.set(db, memo);
  }

  for (const row of rows) {
    let parsed = memo.get(row.id);
    if (parsed === undefined) {
      parsed = parsePreToolUseAgentBlob(row.data);
      memo.set(row.id, parsed);
    }
    // A cached `null` is a permanent negative (malformed / non-matching shape).
    // The `subagent_type === agentType` decision stays LIVE per call — the
    // per-call `agentType` is never baked into the cache.
    if (parsed === null || parsed.subagent_type !== agentType) {
      continue;
    }
    return {
      description: parsed.description,
      prompt_chars: parsed.prompt_chars,
      tool_use_id: row.tool_use_id,
    };
  }
  return null;
}

/**
 * Resolve the `subagent_agent_id` bridge with column-then-JSON fallback.
 * Mirrors the retired Python `_resolve_bridge_agent_id`.
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
 * the retired Python's `str(description_raw)[:_DESCRIPTION_MAX_CHARS]`
 * truncation. Pure: no mutation of `s`.
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

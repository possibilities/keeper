/**
 * Agent Bus storage layer (epic fn-875). The bus's OWN SQLite store, PHYSICALLY
 * separate from keeper.db — its own file (`bus.db`), its own forward-only
 * `PRAGMA user_version` ladder, decoupled from keeper's `SCHEMA_VERSION`. This
 * keeps the bus OUT of keeper.db's blast radius: it adds NO keeper event type,
 * projection, RPC surface, or schema-version bump, so keeper's re-fold
 * determinism and tightly-scoped-write invariants hold by construction.
 *
 * NEVER call keeper's `openDb`/`migrate` on bus.db. We REUSE only the
 * connection-local `applyPragmas` (schema-free WAL/foreign-keys setup) and run
 * the bus's own migrate ladder below.
 *
 * Two tables (epic Architecture):
 *  - `channels`  — one row per live registration, keyed on `(pid, start_time)`
 *    to defeat OS pid reuse. Best-effort persistence cache: the in-memory
 *    registry in the worker is the runtime source of truth. Rehydrated at boot
 *    and pruned in steady state by `(pid, start_time)` IDENTITY liveness (not
 *    pid alone), so an OS-recycled pid can never keep a stale row alive.
 *  - `messages`  — durable forensic log under a RETENTION contract: rows aged past
 *    the horizon are pruned in paced micro-batches (never one bulk DELETE), so the
 *    table stays bounded under steady churn. The prune advances THROUGH an immune
 *    head — an UNDELIVERED `queued_for_wake` row (the sole durable consumer,
 *    {@link selectQueuedForWake}) survives regardless of age, but never parks the
 *    prune behind it: a partial index over the non-immune rows serves the scan in
 *    O(batch) no matter how long the immune prefix grows. The newest rows sit
 *    within the horizon, so `id` autoincrement stays the monotonic replay cursor.
 *
 * Sole-writer: the bus worker owns the single writable connection. These helpers
 * are pure over a passed `Database` handle so they unit-test in-process.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BusArtifactRef } from "./bus-artifact";
import { applyPragmas } from "./db";

/**
 * Current bus.db schema version — INDEPENDENT of keeper's `SCHEMA_VERSION`.
 * Forward-only: bump only when adding a step to {@link migrateBusDb}.
 */
export const BUS_SCHEMA_VERSION = 2;

/**
 * WAL truncation floor (bytes). `journal_size_limit` truncates (not just zeroes)
 * the `-wal` file back to this after a checkpoint, so the periodic PASSIVE
 * checkpoint the retention pass runs keeps the WAL bounded instead of letting it
 * ratchet up to the high-water mark of the biggest write burst.
 */
export const BUS_WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

const CREATE_CHANNELS = `
CREATE TABLE IF NOT EXISTS channels (
    channel_id     TEXT PRIMARY KEY,
    pid            INTEGER NOT NULL,
    start_time     TEXT NOT NULL,
    session_id     TEXT,
    current_name   TEXT,
    name_history   TEXT NOT NULL DEFAULT '[]',
    namespaces     TEXT NOT NULL DEFAULT '[]',
    registered_at  REAL NOT NULL,
    last_heartbeat REAL NOT NULL
)
`;

/**
 * `(pid, start_time)` is the stable identity key that defeats OS pid reuse — a
 * recycled pid with a different process start time is a DIFFERENT agent. UNIQUE
 * so an upsert keyed on it collapses re-registrations of the same process.
 */
const CREATE_CHANNELS_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_pid_start ON channels(pid, start_time)",
];

const CREATE_CHANNELS_MAINTENANCE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_channels_retention ON channels(last_heartbeat, channel_id)",
];

const CREATE_MESSAGES = `
CREATE TABLE IF NOT EXISTS messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  REAL NOT NULL,
    namespace           TEXT NOT NULL,
    event               TEXT NOT NULL,
    from_channel_id     TEXT,
    from_pid            INTEGER,
    from_name           TEXT,
    to_target           TEXT,
    resolved_channel_id TEXT,
    resolved_session_id TEXT,
    body                TEXT,
    body_size           INTEGER NOT NULL DEFAULT 0,
    status              TEXT,
    reply_to            INTEGER
)
`;

const CREATE_MESSAGES_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_messages_ns_id ON messages(namespace, id)",
  // Partial index over the NON-immune rows only — the retention prune walks it in
  // id order to reach aged eligible rows without scanning the immune head, so a
  // per-tick prune stays O(batch) regardless of how far the `queued_for_wake`
  // prefix grows. The predicate matches the prune query's `status IS NOT
  // 'queued_for_wake'` term verbatim so the planner honors it; `IS NOT` is
  // NULL-safe, so a plain NULL-status row is indexed (only `queued_for_wake` is
  // excluded). A row that flips off `queued_for_wake` enters the index on that
  // UPDATE — no watermark cursor strands it.
  "CREATE INDEX IF NOT EXISTS idx_messages_prune ON messages(id) WHERE status IS NOT 'queued_for_wake'",
];

/**
 * Create one index fail-open. An index is a pure query optimization — a
 * create-if-missing the installed SQLite rejects (e.g. a partial-index predicate
 * on a build older than 3.8.0) must degrade to an unindexed scan, NEVER wedge the
 * boot-critical migrate. A predicate rejection is a parse error (`SQLITE_ERROR`),
 * which does not abort the enclosing transaction, so the ladder proceeds and
 * `PRAGMA user_version` still commits. The retention prune's eligible-row query is
 * correct with or without its partial index; absent it, the scan degrades to a
 * documented immune-prefix walk rather than parking.
 */
function createIndexFailOpen(db: Database, ddl: string): void {
  try {
    db.run(ddl);
  } catch (err) {
    console.error(
      `[bus-db] skipping unsupported index (non-fatal): ${ddl}`,
      err,
    );
  }
}

/**
 * Run the bus's forward-only migrate ladder against an OPEN connection. Idempotent:
 * `CREATE TABLE IF NOT EXISTS` + a `PRAGMA user_version` gate make a re-open a
 * no-op. Wrapped in a transaction so a half-applied schema can never persist.
 *
 * `user_version` is the bus's own counter (NOT keeper's `meta(schema_version)`).
 * A bus.db whose stored version EXCEEDS this binary's {@link BUS_SCHEMA_VERSION}
 * throws — an old binary must not silently downgrade a newer bus.db. The throw
 * is the loud, ISOLATED failure the epic risk note calls for: it surfaces in the
 * bus worker only and must never wedge keeperd boot.
 */
export function migrateBusDb(db: Database): void {
  const stored = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number } | null)
      ?.user_version ?? 0,
  );
  if (stored > BUS_SCHEMA_VERSION) {
    throw new Error(
      `bus.db schema v${stored} is newer than this binary's v${BUS_SCHEMA_VERSION} — ` +
        "deploy the newer keeper (or remove bus.db); refusing to downgrade",
    );
  }
  db.transaction(() => {
    db.run(CREATE_CHANNELS);
    for (const ddl of CREATE_CHANNELS_INDEXES) db.run(ddl);
    for (const ddl of CREATE_CHANNELS_MAINTENANCE_INDEXES) {
      createIndexFailOpen(db, ddl);
    }
    db.run(CREATE_MESSAGES);
    for (const ddl of CREATE_MESSAGES_INDEXES) createIndexFailOpen(db, ddl);
    if (stored < 2) {
      db.run("ALTER TABLE messages ADD COLUMN payload_media_type TEXT");
      db.run("ALTER TABLE messages ADD COLUMN artifact_id TEXT");
      db.run("ALTER TABLE messages ADD COLUMN artifact_len INTEGER");
      db.run("ALTER TABLE messages ADD COLUMN artifact_sha256 TEXT");
      db.run("ALTER TABLE messages ADD COLUMN delivered_at REAL");
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_messages_artifact_id ON messages(artifact_id)",
      );
    }
    db.run(`PRAGMA user_version = ${BUS_SCHEMA_VERSION}`);
  })();
}

/**
 * Open (creating if absent) the bus's writable SQLite store, apply the REUSED
 * connection-local pragmas, and run the bus's own migrate ladder. NEVER routes
 * through keeper's `openDb`/`migrate`.
 *
 * @param path  bus.db path (usually {@link resolveBusDbPath}).
 */
export function openBusDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  // auto_vacuum must be chosen BEFORE the first table exists to take hold without
  // a full VACUUM, so set it on the pristine handle: a FRESH bus.db is born
  // INCREMENTAL and a later `PRAGMA incremental_vacuum` returns pruned pages to
  // the OS. On an existing non-INCREMENTAL bus.db this is a silent no-op (pruned
  // pages sit on the freelist for reuse — the file stops growing either way).
  db.run("PRAGMA auto_vacuum = INCREMENTAL");
  applyPragmas(db);
  migrateBusDb(db);
  // Bound the WAL so the retention pass's PASSIVE checkpoint truncates it back.
  db.run(`PRAGMA journal_size_limit = ${BUS_WAL_SIZE_LIMIT_BYTES}`);
  return db;
}

// ---------------------------------------------------------------------------
// Channels — best-effort persistence cache of the live registry
// ---------------------------------------------------------------------------

/** A persisted channel row (the registry's durable cache shape). */
export interface ChannelRow {
  channel_id: string;
  pid: number;
  start_time: string;
  session_id: string | null;
  current_name: string | null;
  /** Oldest→newest session names; an old name maps to the same agent forever. */
  name_history: string[];
  /** Tenant namespaces this channel is subscribed to (e.g. `["chat"]`). */
  namespaces: string[];
  registered_at: number;
  last_heartbeat: number;
}

/** Decode a JSON-TEXT array cell to `string[]`, fail-soft to `[]`. */
function decodeStringArray(cell: unknown): string[] {
  if (typeof cell !== "string" || cell.length === 0) return [];
  try {
    const parsed = JSON.parse(cell);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** Decode a raw DB row to a {@link ChannelRow} (JSON-TEXT columns decoded). */
function rowToChannel(row: Record<string, unknown>): ChannelRow {
  return {
    channel_id: String(row.channel_id),
    pid: Number(row.pid),
    start_time: String(row.start_time),
    session_id: row.session_id == null ? null : String(row.session_id),
    current_name: row.current_name == null ? null : String(row.current_name),
    name_history: decodeStringArray(row.name_history),
    namespaces: decodeStringArray(row.namespaces),
    registered_at: Number(row.registered_at),
    last_heartbeat: Number(row.last_heartbeat),
  };
}

/**
 * Upsert a channel keyed on its stable `(pid, start_time)` identity. A
 * re-registration of the same process (same pid AND start_time) updates the row
 * in place; a recycled pid with a different start_time is a distinct row.
 *
 * `channel_id` is the row's own primary key; we conflict-resolve on the UNIQUE
 * `(pid, start_time)` index so the identity — not the synthetic id — drives the
 * collapse.
 */
export function upsertChannel(db: Database, ch: ChannelRow): void {
  db.prepare(
    `INSERT INTO channels
       (channel_id, pid, start_time, session_id, current_name, name_history,
        namespaces, registered_at, last_heartbeat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pid, start_time) DO UPDATE SET
        channel_id     = excluded.channel_id,
        session_id     = excluded.session_id,
        current_name   = excluded.current_name,
        name_history   = excluded.name_history,
        namespaces     = excluded.namespaces,
        registered_at  = excluded.registered_at,
        last_heartbeat = excluded.last_heartbeat`,
  ).run(
    ch.channel_id,
    ch.pid,
    ch.start_time,
    ch.session_id,
    ch.current_name,
    JSON.stringify(ch.name_history),
    JSON.stringify(ch.namespaces),
    ch.registered_at,
    ch.last_heartbeat,
  );
}

/** Load all persisted channels (registry-cache rehydration source). */
export function loadChannels(db: Database): ChannelRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM channels ORDER BY registered_at ASC, channel_id ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToChannel);
}

/** Ordered keyset retained by the channel-retention worker between ticks. */
export interface ChannelRetentionCursor {
  last_heartbeat: number;
  channel_id: string;
}

/**
 * Load at most `limit` channel rows after `cursor`, ordered by the retention
 * index. Reaching the tail wraps into the head with the remaining budget, so
 * connected keeps cannot permanently hide later rows. The tuple tie-breaker
 * makes equal-heartbeat traversal total and stable.
 */
export function loadChannelRetentionCandidates(
  db: Database,
  cursor: ChannelRetentionCursor | null,
  limit: number,
): ChannelRow[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const boundedLimit = Math.floor(limit);
  if (cursor === null) {
    const rows = db
      .prepare(
        "SELECT * FROM channels ORDER BY last_heartbeat ASC, channel_id ASC LIMIT ?",
      )
      .all(boundedLimit) as Record<string, unknown>[];
    return rows.map(rowToChannel);
  }

  const tail = db
    .prepare(
      `SELECT * FROM channels
       WHERE (last_heartbeat, channel_id) > (?, ?)
       ORDER BY last_heartbeat ASC, channel_id ASC LIMIT ?`,
    )
    .all(cursor.last_heartbeat, cursor.channel_id, boundedLimit) as Record<
    string,
    unknown
  >[];
  if (tail.length === boundedLimit) return tail.map(rowToChannel);

  const head = db
    .prepare(
      `SELECT * FROM channels
       WHERE (last_heartbeat, channel_id) <= (?, ?)
       ORDER BY last_heartbeat ASC, channel_id ASC LIMIT ?`,
    )
    .all(
      cursor.last_heartbeat,
      cursor.channel_id,
      boundedLimit - tail.length,
    ) as Record<string, unknown>[];
  return [...tail, ...head].map(rowToChannel);
}

/** Delete a channel by its stable `(pid, start_time)` identity (deregister/reap). */
export function deleteChannel(
  db: Database,
  pid: number,
  startTime: string,
): void {
  db.prepare("DELETE FROM channels WHERE pid = ? AND start_time = ?").run(
    pid,
    startTime,
  );
}

/**
 * Reap only the candidate version that was observed before asynchronous
 * liveness work. A concurrent upsert advances `last_heartbeat`, making the
 * zero-row result a benign freshness win.
 */
export function deleteChannelIfUnchanged(
  db: Database,
  candidate: Pick<ChannelRow, "pid" | "start_time" | "last_heartbeat">,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM channels
       WHERE pid = ? AND start_time = ? AND last_heartbeat = ?`,
    )
    .run(candidate.pid, candidate.start_time, candidate.last_heartbeat);
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Messages — append-only forensic log + replay cursor
// ---------------------------------------------------------------------------

/** A message to append. `id`/`ts` are assigned by {@link appendMessage}. */
export interface MessageInput {
  ts?: number;
  namespace: string;
  event: string;
  from_channel_id?: string | null;
  from_pid?: number | null;
  from_name?: string | null;
  to_target?: string | null;
  resolved_channel_id?: string | null;
  resolved_session_id?: string | null;
  body?: string | null;
  payload_media_type?: string | null;
  artifact_ref?: BusArtifactRef | null;
  delivered_at?: number | null;
  status?: string | null;
  reply_to?: number | null;
}

/** A persisted message row (the full forensic shape). */
export interface MessageRow {
  id: number;
  ts: number;
  namespace: string;
  event: string;
  from_channel_id: string | null;
  from_pid: number | null;
  from_name: string | null;
  to_target: string | null;
  resolved_channel_id: string | null;
  resolved_session_id: string | null;
  body: string | null;
  body_size: number;
  payload_media_type: string | null;
  artifact_ref: BusArtifactRef | null;
  delivered_at: number | null;
  status: string | null;
  reply_to: number | null;
}

function rowToMessage(row: Record<string, unknown>): MessageRow {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    namespace: String(row.namespace),
    event: String(row.event),
    from_channel_id:
      row.from_channel_id == null ? null : String(row.from_channel_id),
    from_pid: row.from_pid == null ? null : Number(row.from_pid),
    from_name: row.from_name == null ? null : String(row.from_name),
    to_target: row.to_target == null ? null : String(row.to_target),
    resolved_channel_id:
      row.resolved_channel_id == null ? null : String(row.resolved_channel_id),
    resolved_session_id:
      row.resolved_session_id == null ? null : String(row.resolved_session_id),
    body: row.body == null ? null : String(row.body),
    body_size: Number(row.body_size),
    payload_media_type:
      row.payload_media_type == null ? null : String(row.payload_media_type),
    artifact_ref:
      row.artifact_id == null ||
      row.artifact_len == null ||
      row.artifact_sha256 == null
        ? null
        : {
            id: String(row.artifact_id),
            len: Number(row.artifact_len),
            sha256: String(row.artifact_sha256),
          },
    delivered_at: row.delivered_at == null ? null : Number(row.delivered_at),
    status: row.status == null ? null : String(row.status),
    reply_to: row.reply_to == null ? null : Number(row.reply_to),
  };
}

/**
 * Append one message; returns its assigned monotonic `id` (the replay cursor).
 * `body_size` is the inline UTF-8 byte length or the artifact's declared byte
 * length. `ts` defaults to wall-clock at append — this is a PRODUCER,
 * not a fold, so reading the clock here is correct.
 */
export function appendMessage(db: Database, msg: MessageInput): number {
  const ref = msg.artifact_ref ?? null;
  if (ref !== null && msg.body != null) {
    throw new TypeError(
      "a bus message cannot contain both a body and an artifact reference",
    );
  }
  const body = ref === null ? (msg.body ?? null) : null;
  const bodySize =
    ref === null
      ? body == null
        ? 0
        : Buffer.byteLength(body, "utf8")
      : ref.len;
  const ts = msg.ts ?? Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages
         (ts, namespace, event, from_channel_id, from_pid, from_name,
          to_target, resolved_channel_id, resolved_session_id, body, body_size,
          payload_media_type, artifact_id, artifact_len, artifact_sha256,
          delivered_at, status, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      msg.namespace,
      msg.event,
      msg.from_channel_id ?? null,
      msg.from_pid ?? null,
      msg.from_name ?? null,
      msg.to_target ?? null,
      msg.resolved_channel_id ?? null,
      msg.resolved_session_id ?? null,
      body,
      bodySize,
      msg.payload_media_type ?? null,
      ref?.id ?? null,
      ref?.len ?? null,
      ref?.sha256 ?? null,
      msg.delivered_at ?? null,
      msg.status ?? null,
      msg.reply_to ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** The current max message id (the live replay cursor), or 0 when empty. */
export function maxMessageId(db: Database): number {
  const row = db.prepare("SELECT MAX(id) AS m FROM messages").get() as {
    m: number | null;
  } | null;
  return Number(row?.m ?? 0);
}

/**
 * The status a `planner@<epic>` escalation carries while it waits for its offline
 * creator to return, and the status it flips to once redelivered on resubscribe.
 * Both are free-text values on the existing `messages.status` column — NO schema
 * bump (bus.db keeps its `user_version` ladder untouched).
 */
export const QUEUED_FOR_WAKE = "queued_for_wake";
export const DELIVERED_AFTER_WAKE = "delivered_after_wake";

/**
 * Recipient-keyed durable replay: the `queued_for_wake` `send` rows addressed to
 * ONE returning session, oldest-first. Keyed on the creator's `resolved_session_id`
 * (its stable `job_id`, not the ephemeral channel id), so a resubscribing session
 * receives ONLY its own queued escalations — never another recipient's, never an
 * unrelated chat row from a shared namespace. Distinct from {@link replayFromCursor}
 * (namespace-only, the live reconnect-gap recovery): this query is the wake-on-send
 * durable queue. A row already flipped to `delivered_after_wake` is excluded by the
 * status filter, so the flip IS the dedup and a second subscribe finds none. Pure
 * over `(db, sessionId)`.
 */
export function selectQueuedForWake(
  db: Database,
  sessionId: string,
): MessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
         WHERE resolved_session_id = ? AND status = ? AND event = 'send'
         ORDER BY id ASC`,
    )
    .all(sessionId, QUEUED_FOR_WAKE);
  return (rows as Record<string, unknown>[]).map(rowToMessage);
}

/**
 * Age-horizon message retention: delete up to `batchSize` ELIGIBLE messages —
 * those whose delivery time (falling back to `ts`) is strictly before `cutoffTs`
 * AND that are not an undelivered `queued_for_wake` row. Returns the artifact ids
 * that became unreferenced after the row-first transaction.
 *
 * The scan reaches eligible rows THROUGH the immune head. A partial index over the
 * non-immune rows ({@link CREATE_MESSAGES_INDEXES}) lets the id-ascending walk skip
 * the `queued_for_wake` prefix entirely, so per-tick cost is O(batch) no matter how
 * far that prefix grows — a head block of immune rows can never park the prune the
 * way the old front-window scan did. The batch bound counts ELIGIBLE rows (not the
 * front window), so drain throughput is predictable regardless of immune
 * interleaving. Absent the index (a SQLite too old for the predicate), the same
 * query stays correct via an unindexed scan. Call repeatedly (one batch per timer
 * tick) to drain a backlog gradually.
 *
 * The returned artifact-id set is exactly the deleted rows' newly-unreferenced
 * artifacts: an artifact still referenced by a surviving row — an immune row
 * included — is filtered out by {@link artifactRowExists}, so the row-first
 * artifact GC in {@link cleanupBusArtifacts} never collects a shared file.
 *
 * Only `queued_for_wake` is age-immune. A row that flips off it (redelivered,
 * {@link DELIVERED_AFTER_WAKE}) enters the partial index on that UPDATE and ages
 * out through the ordinary re-evaluated scan. The namespace reconnect-gap replay
 * ({@link replayFromCursor}) is NOT a live consumer — the `keeper bus watch` client
 * subscribes with NO `after_id` (`cli/bus.ts`) — so retention protects no replay
 * window beyond the wake queue.
 */
export function pruneMessagesOlderThan(
  db: Database,
  cutoffTs: number,
  batchSize: number,
): string[] {
  // The `status IS NOT '…'` term is inlined (not a bound `?`) so it matches the
  // partial index predicate verbatim — that literal match is what lets the planner
  // serve the scan from `idx_messages_prune` and skip the immune head.
  const eligible = db
    .prepare(
      `SELECT id, artifact_id
         FROM messages
         WHERE status IS NOT '${QUEUED_FOR_WAKE}'
           AND COALESCE(delivered_at, ts) < ?
         ORDER BY id ASC LIMIT ?`,
    )
    .all(cutoffTs, batchSize) as {
    id: number;
    artifact_id: string | null;
  }[];
  if (eligible.length === 0) return [];
  let artifactIds: string[] = [];
  db.transaction(() => {
    db.prepare(
      "DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))",
    ).run(JSON.stringify(eligible.map((r) => r.id)));
    artifactIds = [
      ...new Set(
        eligible.flatMap((r) =>
          r.artifact_id === null ? [] : [r.artifact_id],
        ),
      ),
    ].filter((id) => !artifactRowExists(db, id));
  }).immediate();
  return artifactIds;
}

export function artifactRowExists(db: Database, artifactId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM messages WHERE artifact_id = ? LIMIT 1")
      .get(artifactId) !== null
  );
}

export function markMessageDelivered(
  db: Database,
  id: number,
  status: string,
  deliveredAt: number,
): void {
  db.prepare(
    "UPDATE messages SET status = ?, delivered_at = ? WHERE id = ?",
  ).run(status, deliveredAt, id);
}

/**
 * Namespace-scoped age-horizon retention for control-style logs. Shares the
 * eligible-row shape of {@link pruneMessagesOlderThan} — the immune-status
 * exclusion moves into the SELECT and the batch bound counts ELIGIBLE rows — so a
 * `queued_for_wake` row is never counted against the batch or deleted, defense in
 * depth even though control rows are never immune today. The scan is scoped through
 * the existing `(namespace, id)` index, so a large backlog in one namespace can
 * never inflate another namespace's prune work; a control-namespace immune head
 * would likewise be skipped rather than parking the drain. Returns the count of
 * deleted rows.
 */
export function pruneControlMessagesOlderThan(
  db: Database,
  namespace: string,
  cutoffTs: number,
  batchSize: number,
): number {
  const ids = (
    db
      .prepare(
        `SELECT id FROM messages
           WHERE namespace = ?
             AND status IS NOT '${QUEUED_FOR_WAKE}'
             AND ts < ?
           ORDER BY id ASC LIMIT ?`,
      )
      .all(namespace, cutoffTs, batchSize) as Array<{ id: number }>
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  db.transaction(() => {
    db.prepare(
      "DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))",
    ).run(JSON.stringify(ids));
  }).immediate();
  return ids.length;
}

/**
 * Replay messages strictly AFTER `afterId`, oldest-first — the reconnect-recovery
 * path. A subscriber that drops at cursor C calls this with `afterId = C` to
 * recover everything it missed, optionally narrowed to one tenant `namespace`.
 */
export function replayFromCursor(
  db: Database,
  afterId: number,
  namespace?: string,
): MessageRow[] {
  const rows =
    namespace === undefined
      ? db
          .prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC")
          .all(afterId)
      : db
          .prepare(
            "SELECT * FROM messages WHERE id > ? AND namespace = ? ORDER BY id ASC",
          )
          .all(afterId, namespace);
  return (rows as Record<string, unknown>[]).map(rowToMessage);
}

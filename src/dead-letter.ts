/**
 * The shared NDJSON dead-letter record schema (fn-643). The hook (task .2)
 * writes one record per dropped INSERT to a per-pid NDJSON file under the
 * keeper state dir, and the daemon's import path (task .3) tails / boot-scans
 * those files, parses each line, and INSERTs (`INSERT OR IGNORE` by `dl_id`)
 * into the `dead_letters` operational table (schema v37; see
 * `CREATE_DEAD_LETTERS` in `src/db.ts`).
 *
 * INVARIANT: this module's import graph is `local-only` — NO third-party
 * deps, NO `bun:sqlite`. The hook
 * (`plugins/keeper/plugin/hooks/events-writer.ts`) imports
 * it on a hot path (Bun cold start is ~30ms and the SessionEnd hook has a
 * 1.5s timeout budget; see the "No third-party deps in the hook" rule in
 * CLAUDE.md). The daemon imports it from `src/db.ts` consumers but the
 * record shape must round-trip byte-identically between the two — having
 * both sides depend on the same pure module is how that invariant is
 * structurally enforced.
 *
 * Crash-safety contract: the hook writes one record per failed INSERT, but
 * a process killed mid-write may leave a partial / truncated line in the
 * NDJSON file. {@link parseDeadLetterLine} MUST return `null` on a partial
 * line, garbage JSON, or any record missing the required fields — the
 * import path skips the line silently and the next valid record on the next
 * line still imports cleanly. The two append-only sides (hook write, daemon
 * read) treat the NDJSON file as a forward-tailed log; no in-place
 * mutation, no truncation.
 */

/**
 * The serialized insert-binding set the hook would have run against
 * `events` — verbatim JSON of every column the hook normally binds, plus
 * the SessionStart-only scraped fields (`spawn_name`, `start_time`,
 * `config_dir`) the reducer's SessionStart fold reads. Stored opaque as a
 * `Record<string, ...>` because the column set evolves across schema
 * versions: a v37 hook writes whatever bindings v37 produces; a future v38
 * hook may add columns; the replay verb (task .4) deserializes against the
 * `events` table shape at replay time. A round-tripped binding for an
 * unknown column is dropped at replay (forward-compat); a missing
 * required column on replay surfaces as an error there, never here.
 *
 * Value types mirror SQLite's storage class union — `string | number |
 * null | boolean` is the surface the hook produces today (the `events`
 * table carries TEXT, INTEGER, REAL, and a small handful of NULL-tolerant
 * BOOLEAN-via-INTEGER columns like `stop_hook_active`). Keeping the
 * union narrow lets {@link parseDeadLetterLine} validate each binding's
 * top-level shape without per-column knowledge.
 */
export type DeadLetterBindings = Record<
  string,
  string | number | boolean | null
>;

export const DEAD_LETTER_WAITING_STATUS = "waiting";
export const DEAD_LETTER_RECOVERED_STATUS = "recovered";
export const DEAD_LETTER_POISON_STATUS = "poison";
export const DEAD_LETTER_RESOLVED_STATUS = "resolved";
export const BIRTH_STUCK_STATUS = "birth-stuck";

export const DEAD_LETTER_TERMINAL_STATUSES = [
  DEAD_LETTER_RECOVERED_STATUS,
  DEAD_LETTER_RESOLVED_STATUS,
  BIRTH_STUCK_STATUS,
] as const;

export function isDeadLetterTerminalStatus(
  status: unknown,
): status is (typeof DEAD_LETTER_TERMINAL_STATUSES)[number] {
  return (DEAD_LETTER_TERMINAL_STATUSES as readonly unknown[]).includes(status);
}

export type DeadLetterOperatorRequest =
  | { op: "reclassify"; dl_id: string }
  | {
      op: "resolve";
      dl_id: string;
      caller_session: string;
      reason: string;
      force: true;
    };

export type DeadLetterOperatorOutcome =
  | "reclassified"
  | "still_poison"
  | "resolved"
  | "refused_already_resolved"
  | "refused_not_poison"
  | "refused_not_found";

/**
 * One dead-letter record — one line of NDJSON. Field semantics mirror the
 * matching columns on the `dead_letters` table (schema v37), so the import
 * path's INSERT is a straight 1:1 map (no transform). See
 * `CREATE_DEAD_LETTERS` in `src/db.ts` for column docstrings.
 *
 * The hook stamps every field at write time:
 * - `dl_id` is a fresh UUID per dropped INSERT — the import-path idempotency
 *   key (`INSERT OR IGNORE` on this column).
 * - `session_id`, `hook_event`, `ts`, `pid` come straight from the hook's
 *   incoming Claude Code payload.
 * - `dl_written_at` is `Date.now() / 1000` (unix-seconds) at the moment the
 *   hook decides to dead-letter — distinct from `ts` (the event's own wall
 *   time).
 * - `bindings` is the full insert-binding map (see {@link DeadLetterBindings}).
 *
 * `recovered_at` / `replayed_event_id` / `status` are daemon-side state and
 * NOT part of the on-disk record — they live on the `dead_letters` row only.
 * `source_file` is also daemon-side (the import path knows which file each
 * line came from; the file itself doesn't carry its own path).
 */
export interface DeadLetterRecord {
  dl_id: string;
  session_id: string;
  hook_event: string;
  ts: number;
  dl_written_at: number;
  pid: number | null;
  bindings: DeadLetterBindings;
}

/**
 * Serialize one dead-letter record to a single NDJSON line, terminated by
 * `\n`. Pure: same input → same output. The hook calls this and appends the
 * returned string to the per-pid NDJSON file with one `write()`; the
 * trailing `\n` is the record delimiter the line-by-line {@link
 * parseDeadLetterLine} reader keys off.
 *
 * The hook is expected to write the returned string with a single
 * `appendFileSync` / `write(2)` — the FS-level atomicity of a single write
 * (≤ PIPE_BUF, the macOS limit is 512 B) keeps the NDJSON parser's
 * line-by-line read whole records or nothing. Records larger than 512 B
 * may interleave with a concurrent hook write; the per-pid file naming
 * (`<pid>.ndjson`) gives every concurrent hook its own file so the
 * interleave is a non-issue in practice — different pids never write the
 * same file.
 */
export function serializeDeadLetterRecord(record: DeadLetterRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse one NDJSON line into a {@link DeadLetterRecord}, or return `null` if
 * the line is unparseable / partial / missing required fields. The import
 * path treats `null` as "skip this line and move on" — a truncated final
 * line from a killed hook process must not stop the import path from
 * processing valid records above it.
 *
 * Validation is structural: the parse succeeds only when every required
 * field is present with the right top-level type. `bindings` must be a
 * plain object (not an array, not null, not a string) and every entry's
 * value must be one of `string | number | boolean | null`. A binding with
 * a nested object/array value returns `null` for the whole record —
 * SQLite columns can't carry nested values anyway, and a hook that
 * produced one would have failed its real INSERT, so this case never
 * arises in practice.
 *
 * The `\n` terminator is OPTIONAL on the input — the caller (an NDJSON
 * line-by-line reader) typically strips the newline before calling, but
 * a passed-through line with a trailing `\n` still parses (JSON.parse
 * tolerates trailing whitespace). An empty / whitespace-only line
 * returns `null`.
 */
export function parseDeadLetterLine(line: string): DeadLetterRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.dl_id !== "string" || obj.dl_id.length === 0) {
    return null;
  }
  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    return null;
  }
  if (typeof obj.hook_event !== "string" || obj.hook_event.length === 0) {
    return null;
  }
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
    return null;
  }
  if (
    typeof obj.dl_written_at !== "number" ||
    !Number.isFinite(obj.dl_written_at)
  ) {
    return null;
  }
  // `pid` is allowed null — the hook may not have learned its own pid (this
  // is exotic but the schema column is nullable, mirror the contract here).
  let pid: number | null;
  if (obj.pid === null) {
    pid = null;
  } else if (typeof obj.pid === "number" && Number.isFinite(obj.pid)) {
    pid = obj.pid;
  } else {
    return null;
  }
  if (
    obj.bindings === null ||
    typeof obj.bindings !== "object" ||
    Array.isArray(obj.bindings)
  ) {
    return null;
  }
  const bindingsObj = obj.bindings as Record<string, unknown>;
  const bindings: DeadLetterBindings = {};
  for (const [key, value] of Object.entries(bindingsObj)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      bindings[key] = value;
      continue;
    }
    // Nested object / array / non-finite number — the hook never produces
    // these for a real `events` INSERT binding. Treat as a malformed record
    // so the import path skips it cleanly.
    return null;
  }
  return {
    dl_id: obj.dl_id,
    session_id: obj.session_id,
    hook_event: obj.hook_event,
    ts: obj.ts,
    dl_written_at: obj.dl_written_at,
    pid,
    bindings,
  };
}

// ---------------------------------------------------------------------------
// Events-log NDJSON line shape (fn-736 task .1)
// ---------------------------------------------------------------------------
//
// The lock-free events path (epic fn-736) flips the hook from a direct SQLite
// `INSERT INTO events` to a per-pid NDJSON append (mirroring this module's
// dead-letter shape) — and the daemon-side ingester (`scanEventsLogDir` in
// `src/daemon.ts`) tails those files and lands each line as a real `events`
// row. The fold (`drain()`/`applyEvent()`) reads `events` UNCHANGED, so re-fold
// determinism is preserved by construction.
//
// This is the CONTRACT task .2's writer targets: task .2 flips the hook to emit
// exactly `serializeEventLogRecord(...)`. Until then the hook still INSERTs
// directly and the ingester reads an empty/absent dir (no-op).
//
// SAME INVARIANT as the dead-letter shape above: this module's import graph is
// local-only (NO third-party deps, NO `bun:sqlite`) because the hook imports it
// on its hot path. Both the hook write and the daemon read depend on these pure
// functions, structurally enforcing a byte-identical round-trip.

/**
 * One events-log record — one line of NDJSON. The hook writes one record per
 * hook invocation (it no longer INSERTs); the daemon's ingester
 * ({@link parseEventLogLine} → `INSERT INTO events`) lands it as an `events`
 * row.
 *
 * The record carries ONLY `bindings` — the full insert-binding map the hook
 * would have run against `events` (bare column names, the `$` prefix the
 * prepared statement uses stripped — see `DeadLetterBindings`). Unlike the
 * dead-letter record there is no `dl_id` / `dl_written_at` envelope: the
 * ingester's idempotency comes from a durable per-pid byte-offset (committed
 * atomically with the INSERT), NOT a stable record id, and the `events` table
 * keeps its `id INTEGER PRIMARY KEY AUTOINCREMENT` schema untouched (no new
 * UNIQUE column). `bindings` is the SOLE payload; every `events` column the
 * fold reads — including the SessionStart-scraped `spawn_name` / `start_time` /
 * `config_dir` that are unrecoverable later — rides inside it.
 *
 * Column set is opaque/forward-compat by design (same as `DeadLetterBindings`):
 * a v61 hook writes whatever bindings v61 produces; a newer hook may add
 * columns; the ingester binds only the intersection of the live `events`
 * columns and the record's keys (an unknown column is dropped — never folded as
 * a poison value that wedges the ingester).
 */
export interface EventLogRecord {
  bindings: DeadLetterBindings;
}

/**
 * Serialize one events-log record to a single NDJSON line, terminated by `\n`.
 * Pure: same input → same output. The hook (task .2) appends the returned
 * string to the per-pid `<pid>.ndjson` file with ONE `appendFileSync` /
 * `write(2)`; the trailing `\n` is the record delimiter the line-by-line
 * {@link parseEventLogLine} reader keys off.
 *
 * UNLIKE the dead-letter shape, the events-log line CAN exceed the ~256 B APFS
 * O_APPEND non-interleave window (a Stop event's `data` blob is large). The
 * per-pid file naming (`<pid>.ndjson`) is what makes that safe: exactly ONE
 * writer per file, so no concurrent hook ever interleaves into the same file
 * and the single-`write()`-per-line discipline keeps the parser reading whole
 * records or nothing. The size cap the dead-letter scan applies is deliberately
 * NOT carried over — a long session legitimately produces a multi-MiB file.
 */
export function serializeEventLogRecord(record: EventLogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse one NDJSON line into an {@link EventLogRecord}, or return `null` if the
 * line is unparseable / partial / missing `bindings`. The ingester treats
 * `null` as "skip this line and DO NOT advance past it" — a truncated final
 * line from a killed hook process must not be folded, and the durable offset
 * must NOT advance past the partial bytes so a later complete append re-reads
 * the now-whole line (the strict torn-tail contract).
 *
 * Validation mirrors {@link parseDeadLetterLine}'s `bindings` arm exactly:
 * `bindings` must be a plain object (not array, not null, not a string) and
 * every entry's value must be one of `string | number | boolean | null`
 * (finite numbers only). A binding with a nested object/array value returns
 * `null` for the whole record — SQLite columns can't carry nested values, and a
 * hook that produced one would never have had a real INSERT to mirror.
 *
 * The `\n` terminator is OPTIONAL on the input — the caller (the ingester's
 * line-by-line reader) strips the newline before calling. An empty /
 * whitespace-only line returns `null`.
 */
export function parseEventLogLine(line: string): EventLogRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj.bindings === null ||
    typeof obj.bindings !== "object" ||
    Array.isArray(obj.bindings)
  ) {
    return null;
  }
  const bindingsObj = obj.bindings as Record<string, unknown>;
  const bindings: DeadLetterBindings = {};
  for (const [key, value] of Object.entries(bindingsObj)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      bindings[key] = value;
      continue;
    }
    // Nested object / array / non-finite number — never a real `events`
    // INSERT binding. Treat as a malformed record so the ingester skips it.
    return null;
  }
  return { bindings };
}

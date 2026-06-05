/**
 * Shared NDJSON record schema + forward-tail watermark for the zellij
 * event bridge (fn-684 / task .3).
 *
 * The plugin half (task .1, `plugin/zellij-bridge/`) appends one line per
 * pane delta to its `/host/<session>.ndjson` (WASI sandbox; `/host` is
 * pinned to keeper's events dir by the dotfiles `load_plugins { cwd "..." }`
 * block). Each line is a `ZellijPaneEvent` JSON object — see field
 * docstrings below.
 *
 * The daemon half (this module + `src/zellij-events-worker.ts` + main's
 * `scanZellijEventsDir` glue) tails each `<session>.ndjson` from a
 * persisted byte offset and joins `(session, pane_id) -> job_id` against
 * the EXISTING `readLiveJobsWithCoords` projection, then mints one
 * EXISTING `BackendExecSnapshot` synthetic event per resolved pane. No
 * schema change — the reducer's fold path is unchanged.
 *
 * INVARIANT: this module's import graph is `local-only` — NO third-party
 * deps, NO `bun:sqlite`. The producer (the Rust plugin) is the sole
 * writer of the NDJSON files; the consumer (this module via the daemon)
 * is the sole reader. A divergence would silently lose tab resolution,
 * so the on-disk record shape lives in one place.
 *
 * Crash-safety contract: the plugin appends one line per delta, but a
 * zellij crash or kernel kill mid-write may leave a partial / truncated
 * trailing line. {@link parseZellijEventLine} MUST return `null` on a
 * partial line, garbage JSON, or any record missing required fields —
 * the import path skips the line silently and the next valid record on
 * the next line still imports cleanly. Forward-only append-only NDJSON
 * file; no in-place mutation, no truncation.
 *
 * Watermark contract: tailing `<session>.ndjson` from byte 0 on every
 * daemon restart would re-mint a `BackendExecSnapshot` for every line
 * the plugin has ever written. We persist a `(session, epoch) ->
 * byte_offset` map next to the events dir; on each scan we read from
 * the last offset, and on epoch change (plugin reload — task .1 stamps
 * a fresh `epoch` in its `plugin_start` sentinel) we reset to 0. The
 * watermark sidecar is written atomically (temp+rename) AFTER the scan
 * advances the tail, so a daemon crash mid-scan re-reads the same
 * lines on next boot — re-mint is idempotent on the projection side
 * (the reducer's UPDATE writes the same `(tab_id, tab_name)` values).
 *
 * Mint-seam dedup (fn-709): on top of that fold idempotency, the
 * consumer skips a line whose effective `(tab_id, tab_name)` already
 * equals the joined job's projection state, BEFORE the INSERT — so fewer
 * no-op mints reach the reducer. The fold stays idempotent; this is an
 * optimization that keeps consecutive-dupe mints off the wire, NOT a
 * replacement for that idempotency.
 */

/**
 * One zellij pane event — one line of NDJSON. Field shape mirrors the
 * plugin's `build_lines()` join exactly (task .1 / plugin/zellij-bridge):
 *
 * - `seq` — monotonically increasing per `(session, epoch)`, starting at
 *   0 for the `plugin_start` sentinel. The watermark is a byte offset,
 *   not a `seq` — `seq` is informational (debugging dropped writes).
 * - `epoch` — a fresh nonce stamped by the plugin's `load()`. A reload
 *   (zellij `start-or-reload-plugin`, or a session restart) mints a new
 *   epoch; the consumer resets the watermark to 0 when it sees a new
 *   epoch for a session, otherwise a reload's earlier `seq` values
 *   would appear "already seen" and the consumer would skip them.
 * - `session` — `ZELLIJ_SESSION_NAME` resolved by the plugin via
 *   `get_session_environment_variables()`. The consumer joins this
 *   against `jobs.backend_exec_session_id`.
 * - `pane_id` — `PaneInfo.id` (zellij pane id, unique within a session).
 *   The consumer joins this against `jobs.backend_exec_pane_id`.
 *   Cross-session pane-id collision: pane ids are unique only within a
 *   session, so the join MUST stay `(session, pane_id)`.
 * - `tab_id` — `TabInfo.tab_id`, lifted into the consumer's
 *   `BackendExecSnapshotMessage.tab_id`. Plugin emits a positive integer
 *   when resolvable; missing/unresolvable surfaces as a missing field
 *   here and we tolerate it (treat as `null` — the reducer's fold
 *   preserves the prior value via COALESCE for `tab_id`).
 * - `tab_name` — `TabInfo.name`, lifted into the snapshot. May be empty
 *   string (a tab the human hasn't renamed). The consumer NEVER mints
 *   a snapshot with `tab_name === ""` — the reducer's `tab_name = ?`
 *   is non-COALESCE and would clobber a previously-known name. The
 *   value-preserving fold for tab name is "skip the line", not "fold
 *   the empty string".
 * - `ts` — wall-clock seconds the plugin stamped at append time
 *   (`SystemTime::now`). Informational; the consumer uses its own
 *   `Date.now()/1000` for the synthetic event's `ts` (and the
 *   reducer's `updated_at`) so re-fold determinism keeps living off
 *   event-time only.
 */
export interface ZellijPaneEvent {
  seq: number;
  epoch: string;
  session: string;
  pane_id: string;
  tab_id: string | null;
  tab_name: string;
  ts: number;
}

/**
 * The `plugin_start` sentinel line carries `event: "plugin_start"` and
 * has no `pane_id` / `tab_id` / `tab_name` fields. We tolerate (and
 * skip) it during the line walk by returning `null` — the sentinel is
 * informational only (it marks an epoch boundary, but the epoch is also
 * carried on every subsequent pane line, so we don't need to read the
 * sentinel to detect the reset).
 */
export function parseZellijEventLine(line: string): ZellijPaneEvent | null {
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
  // The `plugin_start` sentinel carries `event: "plugin_start"` and lacks
  // pane fields. Skip silently — the watermark's epoch field is read off
  // every pane line, so we don't need the sentinel to detect a reset.
  if (typeof obj.event === "string" && obj.event === "plugin_start") {
    return null;
  }
  if (typeof obj.seq !== "number" || !Number.isFinite(obj.seq)) {
    return null;
  }
  // `epoch` and `pane_id` are required join keys the reducer reads as TEXT.
  // The plugin emits them as bare JSON numbers (lib.rs `to_json`) — accept a
  // non-empty string or a finite number and coerce to decimal-string form,
  // the same normalization `tab_id` gets below. Without the number branch,
  // every real plugin line fails the guard and is silently dropped.
  let epoch: string;
  if (typeof obj.epoch === "string" && obj.epoch.length > 0) {
    epoch = obj.epoch;
  } else if (typeof obj.epoch === "number" && Number.isFinite(obj.epoch)) {
    epoch = String(obj.epoch);
  } else {
    return null;
  }
  if (typeof obj.session !== "string" || obj.session.length === 0) {
    return null;
  }
  let paneId: string;
  if (typeof obj.pane_id === "string" && obj.pane_id.length > 0) {
    paneId = obj.pane_id;
  } else if (typeof obj.pane_id === "number" && Number.isFinite(obj.pane_id)) {
    paneId = String(obj.pane_id);
  } else {
    return null;
  }
  // `tab_id` is allowed to be a string (the plugin emits a stringified
  // integer or numeric — we accept either as a string), `null` (missing),
  // or a finite number (we coerce to its decimal string form so the wire
  // format the reducer reads is uniformly TEXT). Anything else → reject
  // the whole record.
  let tabId: string | null;
  if (obj.tab_id === null || obj.tab_id === undefined) {
    tabId = null;
  } else if (typeof obj.tab_id === "string") {
    tabId = obj.tab_id;
  } else if (typeof obj.tab_id === "number" && Number.isFinite(obj.tab_id)) {
    tabId = String(obj.tab_id);
  } else {
    return null;
  }
  if (typeof obj.tab_name !== "string") {
    return null;
  }
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
    return null;
  }
  return {
    seq: obj.seq,
    epoch,
    session: obj.session,
    pane_id: paneId,
    tab_id: tabId,
    tab_name: obj.tab_name,
    ts: obj.ts,
  };
}

/**
 * Cheaply peek the `epoch` of a feed's FIRST line for rotation detection
 * (fn-706.2). The bridge rotates its own feed at a ~4 MiB threshold by
 * truncating to byte 0 and writing a fresh-epoch `plugin_start` header +
 * full re-snapshot; the re-snapshot can grow the file PAST the consumer's
 * prior offset, so the `size < priorOffset` shrink guard misses it. Reading
 * the first line's epoch each scan catches the rotation regardless of size:
 * a first-line epoch differing from the persisted watermark epoch means the
 * file was rotated (or reloaded) and the consumer must reset to byte 0.
 *
 * Distinct from {@link parseZellijEventLine}, which returns `null` for the
 * `plugin_start` sentinel — that helper is for the per-line mint walk, and
 * the rotation header IS a sentinel, so we cannot route the peek through it.
 * This helper accepts the sentinel shape (and a normal pane line) and lifts
 * just `epoch`, normalized to its decimal-string form. Returns `null` on a
 * blank line, unparseable JSON, a non-object, or a missing/invalid `epoch`
 * — the caller treats `null` as "no rotation signal" and falls back to the
 * shrink guard + in-window epoch detection.
 */
export function peekZellijEpoch(line: string): string | null {
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
  if (typeof obj.epoch === "string" && obj.epoch.length > 0) {
    return obj.epoch;
  }
  if (typeof obj.epoch === "number" && Number.isFinite(obj.epoch)) {
    return String(obj.epoch);
  }
  return null;
}

/**
 * Per-session forward-tail watermark. Keyed by `session` (the
 * `<session>.ndjson` basename without extension). `epoch` is the
 * last-seen `ZellijPaneEvent.epoch` for that session; an incoming
 * line whose epoch differs from the watermark's resets `offset` to
 * 0 (plugin reload — earlier `seq` values are not "already seen"
 * after a reload). `offset` is the byte position of the END of the
 * last line we successfully tailed; the next scan reads from this
 * offset forward.
 */
export interface ZellijWatermark {
  epoch: string;
  offset: number;
}

/**
 * The watermark sidecar's on-disk shape — a flat JSON object keyed by
 * session name. Lives next to the events dir as
 * `<events-dir>/.keeperd-watermarks.json` (a hidden sibling so it
 * doesn't show up in the plugin's `<session>.ndjson` glob). The
 * sidecar is written atomically (temp+rename) after each scan; a
 * daemon crash mid-scan re-reads the same lines on next boot, which
 * is idempotent on the reducer's `BackendExecSnapshot` fold (same
 * `(tab_id, tab_name)` written twice converges).
 */
export type ZellijWatermarkFile = Record<string, ZellijWatermark>;

/**
 * Parse a watermark sidecar's contents. Returns an empty map on
 * missing file / unparseable JSON / wrong shape — the consumer
 * treats "no watermark" as "tail from byte 0" (which is correct on
 * a fresh machine and a tolerable cost on a corrupted sidecar:
 * re-mint converges via the reducer's idempotent UPDATE).
 */
export function parseZellijWatermarks(text: string): ZellijWatermarkFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const result: ZellijWatermarkFile = {};
  for (const [session, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.epoch !== "string" || v.epoch.length === 0) {
      continue;
    }
    if (typeof v.offset !== "number" || !Number.isFinite(v.offset)) {
      continue;
    }
    result[session] = { epoch: v.epoch, offset: v.offset };
  }
  return result;
}

/**
 * Serialize the watermark map back to a stable JSON string (sorted
 * session keys, 2-space indent for debuggability). Pure — same input
 * produces byte-identical output, so an atomic temp+rename never
 * leaves a non-canonical sidecar on disk.
 */
export function serializeZellijWatermarks(file: ZellijWatermarkFile): string {
  // Sort keys for byte-stable output (the atomic temp+rename writer
  // relies on same-input → same-output for re-fold determinism on a
  // hand-inspected sidecar). `Object.keys(file)` only returns keys
  // whose values are present, so the per-key lookup below is total —
  // but TS can't prove that, so we use `Object.entries` to keep both
  // sides typed without a non-null assertion.
  const entries = Object.entries(file).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const sorted: ZellijWatermarkFile = {};
  for (const [key, value] of entries) {
    sorted[key] = value;
  }
  return JSON.stringify(sorted, null, 2);
}

/**
 * Transcript worker. keeperd's THIRD Bun Worker thread (after wake + server).
 * It is the first thing in keeper that makes the DAEMON an event *producer*:
 * it watches the Claude Code transcript tree (`~/.claude/projects`) with
 * `@parcel/watcher` (keeper's first runtime dep — a native FSEvents-backed
 * addon), forward-tails each session's JSONL for the `custom-title` line, and
 * posts `{kind:"transcript-title", sessionId, title}` to the parent. The parent
 * (and only the parent) turns that message into a synthetic `TranscriptTitle`
 * `events` row, which the reducer folds at the priority-3 `'transcript'` title
 * source. The worker never writes — it opens a READ-ONLY connection (for the
 * restart-seed) and only posts messages, keeping main the sole `jobs`-writer.
 *
 * Why a native file watcher here when keeper's DO-NOT bans `fs.watch`/FSEvents
 * for its OWN SQLite DB: the ban is narrowed, NOT removed. `PRAGMA data_version`
 * polling stays mandatory for the keeper DB (WAL writes never touch the main
 * file; same-process writes are dropped). But the transcripts are EXTERNAL
 * append-only files written by another process — a kernel watcher is the right
 * primitive there. We still treat every event as "something changed, go look",
 * never as the data: each notification triggers an `fstat` + tail from the
 * stored offset, mirroring jobctl's `TranscriptLineStream`.
 *
 * Conventions mirror `src/wake-worker.ts` / `src/server-worker.ts`:
 * - `isMainThread`-guarded body — a plain `import` from a test is inert; the
 *   pure line-stream core is exported and drivable with no Worker or watcher.
 * - Own read-only `openDb(path, { readonly: true })` (handles are thread-affine
 *   and not structured-cloneable; the parent hands us only path strings via
 *   `workerData`).
 * - Typed message protocol: `{ kind: ... }` worker→main, `{ type: "shutdown" }`
 *   main→worker. Exit `0` clean / `1` crash. NO in-process self-heal — only a
 *   genuine unrecoverable failure exits non-zero (→ daemon `fatalExit` →
 *   launchd restart, keeper's single recovery path).
 * - Subsystem-style teardown (like server-worker's socket): the `@parcel/watcher`
 *   subscription is an external resource the worker owns and `unsubscribe()`s in
 *   its `{type:"shutdown"}` handler.
 *
 * Internal guards (skip-and-log, never escalate): a missing
 * `~/.claude/projects` root (tolerate late appearance), per-file read errors,
 * and torn/malformed JSONL lines all log to stderr and continue. Only an
 * unrecoverable failure (the subscribe call itself rejecting, the addon failing
 * to load) exits non-zero.
 */

import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { openDb } from "./db";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the subscription cannot.
 */
export interface TranscriptWorkerData {
  dbPath: string;
  /**
   * The transcript tree to watch. The daemon resolves it on main via
   * `resolveClaudeProjectsRoot()` (config `claude_projects_root`, default
   * `~/.claude/projects`) and always supplies it. Stays optional so the
   * direct-spawn hermetic test can pass it explicitly; `resolveWatchRoot` falls
   * back to `~/.claude/projects` if a caller omits it.
   */
  watchRoot?: string;
}

/** Message posted to the parent on a NEW (changed) title for a session. */
export interface TranscriptTitleMessage {
  kind: "transcript-title";
  sessionId: string;
  title: string;
}

/**
 * Message posted to the parent on each fresh rate-limit synthetic assistant
 * turn observed in a session's transcript. Claude Code writes this entry
 * when the API request fails at the HTTP 429 boundary — no real model turn
 * fires, no hook event lands, but the JSONL gains a marker line carrying
 * `error: "rate_limit"`, `isApiErrorMessage: true`. Main mints a synthetic
 * `RateLimited` event from this message; the reducer flips `jobs.state` to
 * `'stopped'` AND stamps `jobs.rate_limited_at` to the event ts (see
 * `src/reducer.ts` RateLimited arm).
 *
 * `text` carries Claude Code's own user-facing wording — typically
 * `"You've hit your session limit · resets 3:20am (America/New_York)"` —
 * for downstream display. The worker doesn't parse the reset clock; the
 * full string rides as-is so a future renderer can surface it verbatim.
 */
export interface RateLimitedMessage {
  kind: "rate-limited";
  sessionId: string;
  text: string;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/** Bounded read chunk — tail at most this many bytes per stat→read pass. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Resolve the transcript watch root. `workerData.watchRoot` wins (tests point
 * it at a tmp dir); otherwise `~/.claude/projects`. Pure — does no I/O.
 */
export function resolveWatchRoot(override?: string): string {
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".claude", "projects");
}

/** A parsed `custom-title` line: the session it targets and its new title. */
interface CustomTitleLine {
  sessionId: string;
  title: string;
}

/**
 * Match a parsed JSONL object against the `custom-title` shape:
 * `{type:"custom-title", customTitle:<string>, sessionId:<string>}`
 * (`customTitle` is camelCase, verified against real transcripts; the line
 * carries `sessionId` so the worker routes by it directly). Returns the
 * extracted `{sessionId, title}` or `null` for any other line.
 */
function matchCustomTitle(parsed: unknown): CustomTitleLine | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as {
    type?: unknown;
    customTitle?: unknown;
    sessionId?: unknown;
  };
  if (obj.type !== "custom-title") {
    return null;
  }
  if (typeof obj.customTitle !== "string" || obj.customTitle.length === 0) {
    return null;
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
    return null;
  }
  return { sessionId: obj.sessionId, title: obj.customTitle };
}

/** A parsed rate-limit synthetic assistant line: session + display text. */
interface RateLimitLine {
  sessionId: string;
  text: string;
}

/**
 * Match a parsed JSONL object against the rate-limit synthetic-assistant
 * shape that Claude Code emits when an API request fails at the HTTP 429
 * boundary. Required gate fields (verified against a real captured line):
 *
 *   { type: "assistant",
 *     error: "rate_limit",
 *     isApiErrorMessage: true,
 *     sessionId: <string>,
 *     message: { content: [{type:"text", text:<reset wording>}] } }
 *
 * Strict gate — only the canonical rate-limit envelope matches; any other
 * assistant turn (real or synthetic) returns `null`. `text` falls back to
 * the empty string when the content shape is missing (still emits — the
 * synthetic event is the load-bearing signal, the text is display-only).
 */
function matchRateLimit(parsed: unknown): RateLimitLine | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as {
    type?: unknown;
    error?: unknown;
    isApiErrorMessage?: unknown;
    sessionId?: unknown;
    message?: unknown;
  };
  if (obj.type !== "assistant") {
    return null;
  }
  if (obj.error !== "rate_limit") {
    return null;
  }
  if (obj.isApiErrorMessage !== true) {
    return null;
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
    return null;
  }
  let text = "";
  const msg = obj.message;
  if (msg && typeof msg === "object") {
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as { text?: unknown };
      if (typeof first.text === "string") {
        text = first.text;
      }
    }
  }
  return { sessionId: obj.sessionId, text };
}

/**
 * Per-path forward-tail state: the byte offset we've consumed up to, a
 * persistent UTF-8 decoder (so a multi-byte char split across a read-chunk
 * boundary never decodes to U+FFFD — undici #5035, a real corruption bug), and
 * the unterminated tail of the last read (prepended to the next read's first
 * line). Keyed by PATH, not inode: a session fork is a new file with a new
 * session-id filename, so a new path correctly starts at offset 0.
 */
interface PathState {
  offset: number;
  decoder: StringDecoder;
  partial: string;
}

/**
 * Pure, exported forward-tail line stream — the deterministic core, drivable in
 * tests with no Worker or watcher. Ports jobctl's `TranscriptLineStream`
 * (`run_run_server.py:6605`):
 *
 * - `register(path)` anchors the path's offset to current EOF (we only care
 *   about lines appended AFTER we start watching; the restart-seed below feeds
 *   `lastEmitted` so the first post-anchor title still emits iff it changed).
 * - `onChange(path)` reads bounded (~64 KiB) chunks from the stored offset to
 *   EOF, decodes through the per-file `StringDecoder`, splits on `\n`, prepends
 *   the buffered partial, and dispatches only `\n`-terminated lines. A truncation
 *   (`size < offset`) resets offset to 0 and clears the buffer + decoder. A
 *   malformed line is JSON-parse-skipped-and-logged. A matched `custom-title` is
 *   emitted via `onTitle(sessionId, title)` ONLY when the title differs from the
 *   last emitted title for that session (change-only emit).
 *
 * `lastEmitted` is the in-memory change-gate, keyed by sessionId. The
 * restart-seed (server-side: seed from `jobs.title` when `title_source ===
 * 'transcript'`) is applied by the caller via `seedLastEmitted` before the
 * first `onChange`, so a daemon restart doesn't re-emit a title already folded.
 */
export class TranscriptLineStream {
  private readonly pathState = new Map<string, PathState>();
  private readonly lastEmitted = new Map<string, string>();

  /**
   * Live forward-tail driver. `onTitle` is called for each NEW (changed)
   * `custom-title` line — change-gated by `lastEmitted`. `log` is the
   * stderr-logger seam tests override. `onRateLimited` is called for each
   * fresh rate-limit synthetic-assistant line — NOT change-gated (the
   * daemon-side reducer fold is idempotent, so a defensive same-line
   * re-emit is harmless; the worker stays simple). In practice the
   * forward-only tail anchors each path at EOF on first sight, so a line
   * is read at most once per worker lifetime regardless.
   *
   * Param order is `(onTitle, log, onRateLimited)` — `log` stays in the
   * historical second slot so existing 2-arg test calls keep working;
   * `onRateLimited` is the new optional third slot.
   */
  constructor(
    private readonly onTitle: (sessionId: string, title: string) => void,
    private readonly log: (msg: string) => void = (m) => console.error(m),
    private readonly onRateLimited: (
      sessionId: string,
      text: string,
    ) => void = () => {},
  ) {}

  /**
   * Seed the change-gate for a session from a prior-known title (the
   * restart-seed). A subsequent `custom-title` line with the SAME title is then
   * suppressed; a different one emits. Idempotent — last call wins.
   */
  seedLastEmitted(sessionId: string, title: string): void {
    this.lastEmitted.set(sessionId, title);
  }

  /**
   * Anchor a path's forward-tail offset to its current EOF. Called on first
   * sight of a transcript file. A stat failure anchors at 0 (we'll re-tail from
   * the start; harmless — the change-gate suppresses already-emitted titles).
   */
  register(path: string): void {
    if (this.pathState.has(path)) {
      return;
    }
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    this.pathState.set(path, {
      offset: size,
      decoder: new StringDecoder("utf8"),
      partial: "",
    });
  }

  /** Drop a path from tracking (e.g. on unsubscribe). */
  unregister(path: string): void {
    this.pathState.delete(path);
  }

  /**
   * One-shot boot scan of an EXISTING file from offset 0 to a once-snapshotted
   * size, emitting ONLY the current (last) `custom-title` per session found in
   * the file. This is the startup current-title fold: a `custom-title` set while
   * the daemon was down was never streamed by the live tail (which anchors each
   * file at EOF on first sight), so without this scan a rename-while-down is
   * permanently missed until the title changes again.
   *
   * Unlike `register`/`onChange`, the scan does NOT touch `pathState` — it uses a
   * transient decoder + partial buffer local to this call. So the live watcher's
   * EOF-anchoring on first sight of the same path is unaffected, and bytes
   * appended after the snapshot are picked up by the normal live tail. The shared
   * `lastEmitted` change-gate dedups across the scan and the live tail.
   *
   * Reuses the bounded-chunk read / `StringDecoder` / partial-line / malformed-skip
   * machinery (`consume` → `dispatchLine`), but ACCUMULATES matches per session
   * and emits only the final one — so intermediate historical renames don't churn
   * the event log. A title already folded (seeded into `lastEmitted` by
   * `seedFromDb`) is suppressed by the change-gate. Per-file errors skip-and-log;
   * the scan never throws.
   */
  scanFile(path: string): void {
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        return;
      }
      size = st.size;
    } catch (err) {
      this.log(
        `[transcript-worker] boot scan stat failed for ${path}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (size <= 0) {
      return;
    }

    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (err) {
      this.log(
        `[transcript-worker] boot scan open failed for ${path}: ${stringifyErr(err)}`,
      );
      return;
    }

    // Transient per-scan state — NOT stored in pathState, so the live tail still
    // anchors this path at EOF on its first watcher sighting.
    const decoder = new StringDecoder("utf8");
    let partial = "";
    // Accumulate the LAST title per session seen in this file; emit once at the
    // end so intermediate renames don't each fire an event.
    const lastPerSession = new Map<string, string>();

    const handleLine = (line: string): void => {
      if (line.trim().length === 0) {
        return;
      }
      if (!line.includes("custom-title")) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.log(
          `[transcript-worker] boot scan malformed line in ${path}: ${stringifyErr(err)}`,
        );
        return;
      }
      const match = matchCustomTitle(parsed);
      if (!match) {
        return;
      }
      lastPerSession.set(match.sessionId, match.title);
    };

    try {
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let offset = 0;
      while (offset < size) {
        const want = Math.min(READ_CHUNK_BYTES, size - offset);
        let got: number;
        try {
          got = readSync(fd, buf, 0, want, offset);
        } catch (err) {
          this.log(
            `[transcript-worker] boot scan read failed for ${path}: ${stringifyErr(err)}`,
          );
          return;
        }
        if (got <= 0) {
          break;
        }
        offset += got;
        partial += decoder.write(buf.subarray(0, got));
        let nl = partial.indexOf("\n");
        while (nl !== -1) {
          handleLine(partial.slice(0, nl));
          partial = partial.slice(nl + 1);
          nl = partial.indexOf("\n");
        }
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }

    // Emit the current title per session through the shared change-gate: a title
    // already folded (seeded by seedFromDb) is suppressed; a changed one emits
    // once and advances the gate so the live tail won't re-emit it.
    for (const [sessionId, title] of lastPerSession) {
      const prev = this.lastEmitted.get(sessionId);
      if (prev === title) {
        continue;
      }
      this.lastEmitted.set(sessionId, title);
      this.onTitle(sessionId, title);
    }
  }

  /**
   * Process bytes appended to `path` since the stored offset. Auto-registers a
   * not-yet-seen path (anchoring to EOF means a freshly-created file's existing
   * lines are skipped — we only stream appends), so a watcher "create" event is
   * handled. A per-file read error skips-and-logs and never throws.
   */
  onChange(path: string): void {
    let state = this.pathState.get(path);
    if (!state) {
      // First sight via a change event: anchor to EOF (skip pre-existing lines),
      // then fall through to read any bytes appended past that anchor.
      this.register(path);
      state = this.pathState.get(path);
      if (!state) {
        return;
      }
    }

    let size: number;
    try {
      const st = statSync(path);
      // Defensive: a directory path that somehow reaches here (e.g. bypassing
      // the callback's `.jsonl` check) must NOT fall through to openSync —
      // openSync succeeds on a dir and readSync then throws EISDIR. Bail before
      // any open/read so no read-failure stderr line is produced.
      if (!st.isFile()) {
        return;
      }
      size = st.size;
    } catch (err) {
      this.log(
        `[transcript-worker] stat failed for ${path}: ${stringifyErr(err)}`,
      );
      return;
    }

    // Truncation guard: a shrunk file (rotated/rewritten) resets the tail. Path
    // keying makes this rare (Claude Code doesn't rewrite in place), but stay
    // defensive — reset offset to 0, clear the partial buffer + decoder.
    if (size < state.offset) {
      this.log(
        `[transcript-worker] ${path} truncated (size ${size} < offset ${state.offset}); resetting`,
      );
      state.offset = 0;
      state.partial = "";
      state.decoder = new StringDecoder("utf8");
    }

    if (size <= state.offset) {
      return; // nothing appended
    }

    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (err) {
      this.log(
        `[transcript-worker] open failed for ${path}: ${stringifyErr(err)}`,
      );
      return;
    }

    try {
      // fd discipline: open→read-to-EOF→close per change event; don't hold an fd
      // across the deep live tree. Read in bounded chunks so a huge append never
      // balloons memory.
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (state.offset < size) {
        const want = Math.min(READ_CHUNK_BYTES, size - state.offset);
        let got: number;
        try {
          got = readSync(fd, buf, 0, want, state.offset);
        } catch (err) {
          this.log(
            `[transcript-worker] read failed for ${path}: ${stringifyErr(err)}`,
          );
          return;
        }
        if (got <= 0) {
          break;
        }
        state.offset += got;
        // Decode THROUGH the persistent decoder — a multi-byte char split across
        // this chunk boundary is held back and completed on the next read,
        // never producing a U+FFFD.
        const text = state.decoder.write(buf.subarray(0, got));
        this.consume(state, path, text);
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // best-effort; we're done with the fd either way
      }
    }
  }

  /**
   * Append decoded text to the partial buffer, then dispatch every
   * `\n`-terminated line and retain the unterminated tail for the next read.
   */
  private consume(state: PathState, path: string, text: string): void {
    state.partial += text;
    let nl = state.partial.indexOf("\n");
    while (nl !== -1) {
      const line = state.partial.slice(0, nl);
      state.partial = state.partial.slice(nl + 1);
      this.dispatchLine(path, line);
      nl = state.partial.indexOf("\n");
    }
  }

  /**
   * Parse + match one complete line. Malformed JSON skips-and-logs; a
   * `custom-title` whose title CHANGED for its session emits via `onTitle` and
   * advances the change-gate. A blank line or a non-`custom-title` line is a
   * silent no-op.
   */
  private dispatchLine(path: string, line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    // Cheap pre-filter: skip the JSON.parse for lines that can't be either
    // a title or a rate-limit synthetic. The two needle-substrings are
    // disjoint, so a single `includes` per shape stays branch-cheap. Most
    // transcript lines (assistant tool_use turns, tool_result attachments)
    // miss both and bail before JSON.parse.
    const isTitle = line.includes("custom-title");
    const isRateLimit = !isTitle && line.includes('"rate_limit"');
    if (!isTitle && !isRateLimit) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.log(
        `[transcript-worker] malformed line in ${path}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (isTitle) {
      const match = matchCustomTitle(parsed);
      if (!match) {
        return;
      }
      const prev = this.lastEmitted.get(match.sessionId);
      if (prev === match.title) {
        return; // change-only emit: same title already emitted
      }
      this.lastEmitted.set(match.sessionId, match.title);
      this.onTitle(match.sessionId, match.title);
      return;
    }
    // Rate-limit synthetic: no change-gate. The forward-only tail reads
    // each line at most once per worker lifetime, and the reducer fold is
    // idempotent (state + rate_limited_at stamped from the event payload),
    // so a duplicate emit (boot scan + live tail double-fire would be the
    // only way) folds to the same row state.
    const match = matchRateLimit(parsed);
    if (!match) {
      return;
    }
    this.onRateLimited(match.sessionId, match.text);
  }
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Seed the line stream's change-gate from the keeper DB: for each job whose
 * `title_source === 'transcript'`, the persisted `jobs.title` IS the last
 * transcript title that won, so re-emitting it on restart would be redundant.
 * Seed those (and only those) so the first post-restart `custom-title` line
 * emits iff the title actually changed while the daemon was down. Jobs at a
 * lower title source are left unset so their first transcript title emits.
 *
 * Read-only — uses the worker's own read-only connection. Exported for the
 * worker `main` (and unit reach).
 */
export function seedFromDb(db: Database, stream: TranscriptLineStream): void {
  const rows = db
    .query(
      "SELECT job_id, title FROM jobs WHERE title_source = 'transcript' AND title IS NOT NULL",
    )
    .all() as { job_id: string; title: string }[];
  for (const row of rows) {
    stream.seedLastEmitted(row.job_id, row.title);
  }
}

/**
 * Boot scan: fold the CURRENT `custom-title` for each live job, scoped via
 * `jobs.transcript_path` (schema v5 — the absolute path to that session's
 * transcript JSONL). A `custom-title` set while the daemon was down was never
 * streamed by the live tail (which anchors each file at EOF on first sight), so
 * this one-shot scan after `seedFromDb` + subscribe is what makes a
 * rename-while-down survive a daemon restart.
 *
 * Scoping to `jobs.transcript_path` (NOT a recursive enumeration of the watch
 * root) is deliberate: a transcript title only folds onto an EXISTING `jobs` row
 * (boot drain already created them before this worker spawns), and this scopes to
 * exactly the per-session files that matter — skipping the thousands of dead
 * historical transcripts under the deeply-nested watch tree, and reading the real
 * file even in multi-profile setups where it lives outside the single configured
 * watch root. Jobs with a NULL `transcript_path` (old pre-v5 rows) can't be
 * scanned — acceptable. Must run AFTER `seedFromDb` so an already-folded title is
 * suppressed by the change-gate (no duplicate event on restart). Per-file errors
 * skip-and-log inside `scanFile`; this is non-fatal.
 *
 * Read-only — uses the worker's own read-only connection. Exported for unit reach.
 */
export function scanJobsForTitles(
  db: Database,
  stream: TranscriptLineStream,
): void {
  const rows = db
    .query("SELECT transcript_path FROM jobs WHERE transcript_path IS NOT NULL")
    .all() as { transcript_path: string }[];
  for (const row of rows) {
    if (
      typeof row.transcript_path !== "string" ||
      row.transcript_path.length === 0
    ) {
      continue;
    }
    stream.scanFile(row.transcript_path);
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, seeds the change-gate,
 * subscribes to the watch root, routes each change event into the line stream,
 * and posts a `transcript-title` message per changed title. The subscription is
 * an owned external resource — `unsubscribe()`d in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[transcript-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as TranscriptWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[transcript-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const watchRoot = resolveWatchRoot(data.watchRoot);
  const { db } = openDb(data.dbPath, { readonly: true });

  const port = parentPort;
  const stream = new TranscriptLineStream(
    (sessionId, title) => {
      port.postMessage({
        kind: "transcript-title",
        sessionId,
        title,
      } satisfies TranscriptTitleMessage);
    },
    undefined, // `log` defaults to stderr — the worker has no override here.
    (sessionId, text) => {
      port.postMessage({
        kind: "rate-limited",
        sessionId,
        text,
      } satisfies RateLimitedMessage);
    },
  );

  // Restart-seed: don't re-emit a transcript title already folded into jobs.
  try {
    seedFromDb(db, stream);
  } catch (err) {
    // A seed failure is non-fatal: worst case a stale title re-emits once (the
    // reducer's same-priority-changed-value rule makes that a no-op anyway).
    console.error(
      `[transcript-worker] restart-seed failed: ${stringifyErr(err)}`,
    );
  }

  let subscription: AsyncSubscription | null = null;
  let shuttingDown = false;

  // Drop-recovery scheduler (single root): a recoverable FSEvents drop schedules
  // a debounced, single-flight re-scan via the change-gated boot-scan primitive
  // (scanJobsForTitles, which routes through scanFile's TRANSIENT decoder — NEVER
  // onChange, which would advance/re-anchor byte offsets and lose the very change
  // we're recovering). The warm in-memory change-gate (lastEmitted) suppresses
  // re-emits for unchanged titles, so recovery is idempotent. Cleared in shutdown
  // before unsubscribe; the scan re-checks shuttingDown.
  const rescan = new RescanScheduler(() => {
    if (shuttingDown) {
      return;
    }
    scanJobsForTitles(db, stream);
  });

  // Heartbeat / silent-watcher recovery. Observed (May 2026, daemon pid 83205):
  // after a sibling-worker segfault history, the @parcel/watcher subscribe
  // Promise resolved (boot scan ran) but the per-event callback never fired
  // again — no `update`, no `watcher error`, just 4+ hours of silence while
  // sessions actively renamed via `/title`. Three sessions stayed pinned to
  // their stale payload-source title because the priority-3 transcript signal
  // never reached the reducer. Root cause not isolated (suspect:
  // parcel-bundler/watcher #174-style negated-glob handling, or Bun
  // worker_threads N-API callback bridge dying after a sibling crash).
  //
  // Two-pronged backstop:
  //   1. `eventsReceived` counter logged every HEARTBEAT_MS so a future stall
  //      is visible from `tail -f server.stderr` instead of requiring DB
  //      forensics.
  //   2. Every HEARTBEAT_MS, unconditionally re-run scanJobsForTitles. The
  //      scan is change-gated by `lastEmitted`, so a healthy watcher's already
  //      emitted titles are suppressed; a silent watcher's missed renames are
  //      caught within one tick. This is the same primitive the FSEvents-drop
  //      path uses, so the contract (TRANSIENT decoder, never `onChange`) is
  //      preserved.
  const HEARTBEAT_MS = 60_000;
  let eventsReceived = 0;
  let lastEventAt = 0;
  const heartbeatTimer = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    const lastSeen = lastEventAt
      ? new Date(lastEventAt).toISOString()
      : "never";
    console.error(
      `[transcript-worker] heartbeat events_received=${eventsReceived} last_event_at=${lastSeen}`,
    );
    try {
      scanJobsForTitles(db, stream);
    } catch (err) {
      console.error(
        `[transcript-worker] heartbeat scan failed: ${stringifyErr(err)}`,
      );
    }
  }, HEARTBEAT_MS);

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear any armed re-scan timer FIRST (before unsubscribe / db close) so a
      // pending drop-recovery scan can't fire against a closing connection. The
      // heartbeat timer carries the same constraint (its body runs scanJobsForTitles).
      rescan.cancel();
      clearInterval(heartbeatTimer);
      // Release the subscription (external resource), then the db, then exit
      // clean. Mirrors server-worker's socket teardown.
      void (async () => {
        if (subscription) {
          try {
            await subscription.unsubscribe();
          } catch {
            // best-effort
          }
          subscription = null;
        }
        closeDb();
        process.exit(0);
      })();
    }
  });

  // The watch root may not exist yet on a fresh machine. @parcel/watcher's
  // `subscribe` REQUIRES an existing dir, so tolerate absence: skip-and-log and
  // exit clean only on explicit shutdown. (A future late-appearance retry could
  // poll for the dir; for now a missing root simply means no titles until the
  // daemon restarts after the dir exists — acceptable per the task's guards.)
  if (!existsSync(watchRoot)) {
    console.error(
      `[transcript-worker] watch root ${watchRoot} does not exist; not watching`,
    );
    // Stay alive (don't exit non-zero — a missing root is not a crash) so the
    // shutdown handshake still works. The parentPort listener keeps the event
    // loop alive.
    return;
  }

  // `subscribe` is the only unrecoverable surface — a rejection (addon load
  // failure, EPERM on the root) exits non-zero → daemon fatalExit → launchd
  // restart. Per-file read errors and torn lines are handled INSIDE the stream
  // (skip-and-log), never here.
  import("@parcel/watcher")
    .then((watcher) =>
      watcher.subscribe(watchRoot, (err, events) => {
        if (err) {
          // Always leave a breadcrumb so a future @parcel/watcher wording
          // change (the drop discriminator couples to its message text) is
          // observable in the logs.
          console.error(
            `[transcript-worker] watcher error: ${stringifyErr(err)}`,
          );
          // A recoverable FSEvents drop ("...must be re-scanned"): the lost
          // title change may never re-fire (the live tail is EOF-anchored), so
          // schedule a debounced re-scan. A non-drop err keeps today's
          // swallow-and-log (additive only — no fatal/escalation change).
          if (isDropError(err)) {
            rescan.schedule();
          }
          return;
        }
        // Bump the heartbeat counter so the periodic log distinguishes a
        // healthy-but-quiet watcher from a silent-dead one. Bumped on the
        // raw event batch (pre-filter) so we observe the FSEvents firehose,
        // not just our matched-file slice.
        eventsReceived += events.length;
        lastEventAt = Date.now();
        for (const ev of events) {
          // Treat every event as "go look" — create/update both tail from the
          // stored offset; a delete just drops tracking. The in-callback
          // `.jsonl` check is the sole correctness gate: a directory change
          // that reaches onChange is rejected by statSync's `isFile()` guard,
          // so a directory falling through is harmless beyond a stat() call.
          //
          // No `ignore` glob is passed to subscribe — historically we used
          // `{ ignore: ["**/*.!(jsonl)"] }` (a negated extglob), but plan-worker
          // explicitly avoids that pattern style (parcel-bundler/watcher #174:
          // parcel mishandles negated globs) and the May-2026 silent-watcher
          // stall (see heartbeat comment) was strongly correlated with this
          // option. Re-introduce only as positive `**/<noisy-dir>/**` globs.
          if (!ev.path.endsWith(".jsonl")) {
            continue;
          }
          if (ev.type === "delete") {
            stream.unregister(ev.path);
            continue;
          }
          stream.onChange(ev.path);
        }
      }),
    )
    .then((sub) => {
      if (shuttingDown) {
        // Shutdown raced the subscribe resolution — release immediately.
        void sub.unsubscribe();
        return;
      }
      subscription = sub;
      // Startup current-title fold: after seedFromDb (above) AND after the
      // subscription is live, scan each live job's transcript file for its
      // current `custom-title`. Runs synchronously to completion before any
      // async watcher callback fires, so there is no race with the live tail and
      // the change-gate dedups across both. Non-fatal — wrapped so a scan failure
      // never trips the subscribe `.catch` → fatalExit (mirrors plan-worker's
      // boot scan placement). The existsSync root guard above already gated us.
      try {
        scanJobsForTitles(db, stream);
      } catch (err) {
        console.error(
          `[transcript-worker] startup title fold failed: ${stringifyErr(err)}`,
        );
      }
    })
    .catch((err) => {
      console.error(
        `[transcript-worker] failed to subscribe to ${watchRoot}: ${stringifyErr(err)}`,
      );
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure TranscriptLineStream) is inert.
if (!isMainThread) {
  main();
}

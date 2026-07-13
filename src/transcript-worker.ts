/**
 * Transcript worker. Watches the Claude Code transcript tree
 * (`~/.claude/projects`) with `@parcel/watcher`, forward-tails each session's
 * JSONL for the `custom-title` line, and posts `transcript-title` to the parent;
 * the parent is the sole minter of the synthetic `TranscriptTitle` event. The
 * worker opens a READ-ONLY connection (for the restart-seed) and only posts
 * messages, keeping main the sole `jobs`-writer.
 *
 * The keeper-DB watcher ban is narrowed, not removed: transcripts are EXTERNAL
 * append-only files written by another process, the carve-out where a kernel
 * watcher is the right primitive. Every event is "something changed, go look",
 * never the data — each notification triggers an `fstat` + tail from the stored
 * offset.
 *
 * The subscription is an external resource the worker owns and MUST
 * `unsubscribe()` in its own `{type:"shutdown"}` handler. NO in-process
 * self-heal: only a genuine unrecoverable failure exits non-zero (→ daemon
 * `fatalExit` → launchd restart, keeper's single recovery path); internal guards
 * (missing root, per-file read errors, torn JSONL) skip-and-log and continue.
 */

import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription, Event as WatcherEvent } from "@parcel/watcher";
import {
  BackstopCounters,
  type BackstopMessage,
  buildMissedWakeRecord,
} from "./backstop-telemetry";
import { openDb } from "./db";
import { NotadbTolerance } from "./notadb-tolerance";
import { isDropError, RescanScheduler } from "./rescan";
import type {
  ApiErrorKind,
  InputRequestKind,
  SubagentDisposition,
} from "./types";
import { API_ERROR_KINDS } from "./types";

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
  /**
   * When `true`, the worker NEVER `import()`s `@parcel/watcher` — it skips the
   * live FSEvents subscribe + the startup current-title fold and stays alive
   * only for the shutdown handshake. The in-process daemon harness sets this so
   * the slow-test tier never dlopens the NAPI addon in a worker thread.
   */
  disableNativeWatcher?: boolean;
}

/** Message posted to the parent on a NEW (changed) title for a session. */
export interface TranscriptTitleMessage {
  kind: "transcript-title";
  sessionId: string;
  title: string;
}

/**
 * Message posted to the parent on each fresh `isApiErrorMessage:true`
 * synthetic-assistant turn observed in a session's transcript. Claude Code
 * writes this entry whenever the API request fails at a terminal HTTP boundary —
 * no real model turn fires, no hook event lands. Main mints a synthetic
 * `ApiError` event from this message. `text` carries Claude Code's own
 * user-facing wording, preserved verbatim for downstream display (the worker
 * parses neither the reset clock nor the status code).
 */
export interface ApiErrorMessage {
  kind: "api-error";
  sessionId: string;
  text: string;
  /** Canonical {@link ApiErrorKind} value matched by `matchApiError`. */
  errorKind: ApiErrorKind;
}

/**
 * Message posted to the parent on each fresh assistant turn whose
 * `message.content[]` includes a built-in interactive tool that fires no
 * Pre/PostToolUse hook of its own. Scoped to `AskUserQuestion`;
 * future-extensible to any other interactive built-in. Main mints a synthetic
 * `InputRequest` event from this message.
 */
export interface InputRequestMessage {
  kind: "input-request";
  sessionId: string;
  /** Canonical {@link InputRequestKind} value matched by the transcript matcher. */
  requestKind: InputRequestKind;
}

/**
 * Message posted only after a subagent invocation's transcript disposition has
 * settled. A clean terminal response settles directly; a cut candidate settles
 * only after the matching projected invocation closes and a bounded final tail
 * scan confirms that no later clean response superseded it. Main mints the
 * synthetic `SubagentTurn` event keyed by `(sessionId, agentId)`.
 */
export interface SubagentTurnMessage {
  kind: "subagent-turn";
  /** Parent session id (the subagent transcript's `sessionId`). */
  sessionId: string;
  /** The subagent's `agentId` — matches the SubagentStop event's `agent_id`. */
  agentId: string;
  disposition: SubagentDisposition;
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
 * `{type:"custom-title", customTitle:<string>, sessionId:<string>}`. Returns the
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

/**
 * A parsed `isApiErrorMessage:true` synthetic-assistant line: session +
 * display text + matched {@link ApiErrorKind}.
 */
interface ApiErrorLine {
  sessionId: string;
  text: string;
  kind: ApiErrorKind;
}

/**
 * Match a parsed JSONL object against the `isApiErrorMessage` synthetic-
 * assistant shape that Claude Code emits when an API request fails at a
 * terminal HTTP boundary. Required gate fields:
 *
 *   { type: "assistant",
 *     error: <bare-string-kind> | { type: <bare-string-kind> },
 *     isApiErrorMessage: true,
 *     sessionId: <string>,
 *     message: { content: [{type:"text", text:<status wording>}] } }
 *
 * Strict gate — only the canonical isApiErrorMessage envelope matches; any
 * other assistant turn (real or synthetic) returns `null`. Kind dispatch
 * reads `error.type ?? error` so both wire shapes (bare-string and structured)
 * are accepted; a kind outside {@link API_ERROR_KINDS} falls through to
 * `"unknown"`. `text` falls back to the empty string when the content shape is
 * missing — the synthetic event is the load-bearing signal, the text is
 * display-only.
 */
export function matchApiError(parsed: unknown): ApiErrorLine | null {
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
  if (obj.isApiErrorMessage !== true) {
    return null;
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
    return null;
  }
  // Accept both wire shapes: bare-string `error` and structured `error.type`.
  let rawKind: unknown = obj.error;
  if (rawKind && typeof rawKind === "object") {
    rawKind = (rawKind as { type?: unknown }).type;
  }
  const kind: ApiErrorKind =
    typeof rawKind === "string" && API_ERROR_KINDS.has(rawKind as ApiErrorKind)
      ? (rawKind as ApiErrorKind)
      : "unknown";
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
  return { sessionId: obj.sessionId, text, kind };
}

/**
 * A parsed assistant turn carrying a built-in interactive tool that fires no
 * Pre/PostToolUse hook of its own: session + matched {@link InputRequestKind}.
 * Scoped to `AskUserQuestion`; future-extensible via the discriminator without a
 * new message kind. No display text — the `[awaiting:<kind>]` pill is the
 * load-bearing signal.
 */
interface InputRequestLine {
  sessionId: string;
  requestKind: InputRequestKind;
}

/**
 * Match a parsed JSONL object against the "assistant turn including a built-in
 * interactive tool that surfaces a question with no hook" shape. Strict gates:
 *
 *   - `parsed.type === "assistant"`.
 *   - `parsed.sessionId` is a non-empty string.
 *   - `parsed.message.content` is an array AND at least one element satisfies
 *     `{type:"tool_use", name:"AskUserQuestion"}`.
 *
 * **Walk the array — never index `content[0]`.** Real assistant turns interleave
 * text + N tool_uses, and the `AskUserQuestion` tool_use is often NOT the first
 * element.
 *
 * Returns the matched `{sessionId, requestKind}` or `null` for any other line.
 */
export function matchAskUserQuestion(parsed: unknown): InputRequestLine | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as {
    type?: unknown;
    sessionId?: unknown;
    message?: unknown;
  };
  if (obj.type !== "assistant") {
    return null;
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
    return null;
  }
  const msg = obj.message;
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: unknown; name?: unknown };
    if (b.type === "tool_use" && b.name === "AskUserQuestion") {
      return { sessionId: obj.sessionId, requestKind: "ask_user_question" };
    }
  }
  return null;
}

/**
 * A parsed subagent assistant turn line: parent session + subagent agent id +
 * the turn's terminal {@link SubagentDisposition}.
 */
interface SubagentTurnLine {
  sessionId: string;
  agentId: string;
  invocationId: string;
  disposition: SubagentDisposition;
  settled: boolean;
}

/**
 * Match a parsed JSONL object against a SUBAGENT assistant turn — a line in a
 * subagent sidecar transcript (`<sid>/subagents/agent-<agentId>.jsonl`) that
 * carries the model's `stop_reason`. Strict gates:
 *
 *   - `parsed.type === "assistant"`.
 *   - `parsed.agentId` is a non-empty string (the subagent identity; parent
 *     transcript assistant lines carry NO `agentId`, so this is the sidechain
 *     discriminator that keeps the parent's own turns out).
 *   - `parsed.sessionId` is a non-empty string.
 *   - `parsed.message.stop_reason` is present (a real model response, not a
 *     synthetic/streaming-partial frame).
 *
 * A `stop_reason` of `"tool_use"` or `null` is a provisional cut candidate:
 * both occur before a later assistant response during an ordinary tool cycle.
 * Any other stop reason is a settled clean response. `requestId` (falling back
 * to `uuid`) correlates response chunks without inspecting transcript content.
 * The provider boundary is joined later with the projected SubagentStop before
 * a provisional candidate may be emitted as a true cut.
 *
 * Returns `null` for any non-subagent / non-assistant / stop_reason-absent line.
 */
export function matchSubagentTurn(parsed: unknown): SubagentTurnLine | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as {
    type?: unknown;
    agentId?: unknown;
    sessionId?: unknown;
    requestId?: unknown;
    uuid?: unknown;
    message?: unknown;
  };
  if (obj.type !== "assistant") {
    return null;
  }
  if (typeof obj.agentId !== "string" || obj.agentId.length === 0) {
    return null;
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
    return null;
  }
  const invocationId =
    typeof obj.requestId === "string" && obj.requestId.length > 0
      ? obj.requestId
      : typeof obj.uuid === "string" && obj.uuid.length > 0
        ? obj.uuid
        : null;
  if (invocationId == null) {
    return null;
  }
  const msg = obj.message;
  if (!msg || typeof msg !== "object") {
    return null;
  }
  // `stop_reason` must be PRESENT (the key exists). A real model turn always
  // carries it (string or explicit `null`); a frame missing the key entirely is
  // not a settled assistant response and is skipped.
  if (!("stop_reason" in (msg as object))) {
    return null;
  }
  const stopReason = (msg as { stop_reason?: unknown }).stop_reason;
  const isCut = stopReason === "tool_use" || stopReason === null;
  return {
    sessionId: obj.sessionId,
    agentId: obj.agentId,
    invocationId,
    disposition: isCut ? "cut" : "clean",
    settled: !isCut,
  };
}

/**
 * Per-path forward-tail state: the byte offset we've consumed up to, a
 * persistent UTF-8 decoder (so a multi-byte char split across a read-chunk
 * boundary never decodes to U+FFFD), and the unterminated tail of the last read
 * (prepended to the next read's first line). Keyed by PATH, not inode: a session
 * fork is a new file with a new session-id filename, so a new path correctly
 * starts at offset 0.
 */
interface PathState {
  offset: number;
  decoder: StringDecoder;
  partial: string;
}

function latestSubagentTurnAtBoundary(
  path: string,
  sessionId: string,
  agentId: string,
): SubagentTurnLine | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const readSize = Math.min(size, READ_CHUNK_BYTES * 4);
    const start = size - readSize;
    const bytes = Buffer.allocUnsafe(readSize);
    fd = openSync(path, "r");
    const count = readSync(fd, bytes, 0, readSize, start);
    const lines = bytes.subarray(0, count).toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    let latest: SubagentTurnLine | null = null;
    for (const line of lines) {
      if (!line.includes('"agentId":')) {
        continue;
      }
      try {
        const match = matchSubagentTurn(JSON.parse(line));
        if (
          match !== null &&
          match.sessionId === sessionId &&
          match.agentId === agentId
        ) {
          latest = match;
        }
      } catch {
        // Ignore malformed transcript records at the settlement boundary.
      }
    }
    return latest;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/**
 * Pure, exported forward-tail line stream — the deterministic core, drivable in
 * tests with no Worker or watcher.
 *
 * - `register(path)` anchors the path's offset to current EOF (only lines
 *   appended AFTER we start watching matter; the restart-seed feeds
 *   `lastEmitted` so the first post-anchor title still emits iff it changed).
 * - `onChange(path)` reads bounded chunks from the stored offset to EOF, decodes
 *   through the per-file `StringDecoder`, and dispatches only `\n`-terminated
 *   lines. A truncation (`size < offset`) resets offset to 0 and clears the
 *   buffer + decoder. A matched `custom-title` emits via `onTitle` ONLY when the
 *   title differs from the last emitted title for that session (change-only).
 *
 * `lastEmitted` is the in-memory change-gate, keyed by sessionId. The
 * restart-seed is applied via `seedLastEmitted` before the first `onChange`, so
 * a daemon restart doesn't re-emit a title already folded.
 */
export class TranscriptLineStream {
  private readonly pathState = new Map<string, PathState>();
  private readonly lastEmitted = new Map<string, string>();
  /**
   * Per-path {size, mtimeMs} stat memo gating `scanFile`'s full re-read: skips a
   * file whose size AND mtimeMs are byte-identical to the last successful scan,
   * returning the no-emit/rescued=false path.
   *
   * Written ONLY after a successful stat AND a successful full scan, so a
   * transient EACCES/EIO never poisons a path into permanent suppression. ENOENT
   * clears the entry (a re-appeared file always re-scans).
   *
   * mtimeMs is a sub-second float; gating on whole seconds would false-skip a
   * same-second append, so compare the float verbatim and gate on size first.
   * In-memory only — an empty memo on restart just costs one full re-scan.
   * Append-only assumption: a same-size in-place rewrite would defeat
   * size+mtimeMs, but no writer does that.
   */
  private readonly scanStatMemo = new Map<
    string,
    { size: number; mtimeMs: number }
  >();
  private readonly pendingSubagentTurns = new Map<
    string,
    { path: string; match: SubagentTurnLine }
  >();

  /**
   * Live forward-tail driver. `onTitle` is called for each NEW (changed)
   * `custom-title` line — change-gated by `lastEmitted`. `log` is the
   * stderr-logger seam tests override. `onApiError` and `onInputRequest` are
   * NOT change-gated (the daemon-side reducer fold is idempotent, so a
   * same-line re-emit is harmless). Defaulting every optional callback to a
   * no-op lets a unit test stub only the slot it cares about.
   */
  constructor(
    private readonly onTitle: (sessionId: string, title: string) => void,
    private readonly log: (msg: string) => void = (m) => console.error(m),
    private readonly onApiError: (
      sessionId: string,
      text: string,
      kind: ApiErrorKind,
    ) => void = () => {},
    private readonly onInputRequest: (
      sessionId: string,
      requestKind: InputRequestKind,
    ) => void = () => {},
    private readonly onSubagentTurn: (
      sessionId: string,
      agentId: string,
      disposition: SubagentDisposition,
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

  hasPendingSubagentTurns(): boolean {
    return this.pendingSubagentTurns.size > 0;
  }

  settleSubagentTurn(sessionId: string, agentId: string): boolean {
    const key = `${sessionId}\x00${agentId}`;
    const pending = this.pendingSubagentTurns.get(key);
    if (pending === undefined) {
      return false;
    }
    const boundary = latestSubagentTurnAtBoundary(
      pending.path,
      sessionId,
      agentId,
    );
    if (boundary == null) {
      return false;
    }
    this.pendingSubagentTurns.delete(key);
    this.onSubagentTurn(sessionId, agentId, boundary.disposition);
    return true;
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
   * the file. The startup current-title fold: a `custom-title` set while the
   * daemon was down was never streamed by the live tail (which anchors each file
   * at EOF on first sight), so without this scan a rename-while-down is missed
   * until the title changes again.
   *
   * Does NOT touch `pathState` — it uses a transient decoder + partial buffer
   * local to this call, so the live watcher's EOF-anchoring is unaffected and the
   * shared `lastEmitted` change-gate dedups across the scan and the live tail.
   * Accumulates matches per session and emits only the final one, so intermediate
   * historical renames don't churn the event log. Per-file errors skip-and-log.
   *
   * Returns `true` iff this scan emitted at least one (changed) title — the
   * `rescued` signal {@link scanJobsForTitles} ORs across every scanned file so
   * the backstop can report whether the slow scan rescued a missed title.
   */
  scanFile(path: string): boolean {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        return false;
      }
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (err) {
      // ENOENT is the EXPECTED case: `scanJobsForTitles` walks every
      // `jobs.transcript_path` row and most of those files are long gone, so a
      // vanished transcript skips silently (logging each one buried the real
      // signal). Other stat failures (EACCES, EIO, …) still surface.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.log(
          `[transcript-worker] boot scan stat failed for ${path}: ${stringifyErr(err)}`,
        );
      } else {
        // Drop a memo entry for a vanished path so an un-vanished file (same
        // path, fresh inode) is always re-scanned — never cache "gone".
        this.scanStatMemo.delete(path);
      }
      return false;
    }
    if (size <= 0) {
      return false;
    }

    // Change-gate the full re-read on size+mtimeMs: only a byte-identical
    // {size, mtimeMs} skips (no-emit/rescued=false); a grown or rotated file
    // re-scans from offset 0.
    const memo = this.scanStatMemo.get(path);
    if (memo && size === memo.size && mtimeMs === memo.mtimeMs) {
      return false;
    }

    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (err) {
      this.log(
        `[transcript-worker] boot scan open failed for ${path}: ${stringifyErr(err)}`,
      );
      return false;
    }

    // Transient per-scan state — NOT stored in pathState, so the live tail still
    // anchors this path at EOF on its first watcher sighting.
    const decoder = new StringDecoder("utf8");
    let partial = "";
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
          return false;
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

    // The full scan completed without a read error (any readSync failure above
    // `return false`s before here). Record the snapshot from the PRE-READ stat,
    // so a mid-read append lands a smaller-than-current memo and is
    // conservatively caught next tick.
    this.scanStatMemo.set(path, { size, mtimeMs });

    // Emit the current title per session through the shared change-gate.
    let emitted = false;
    for (const [sessionId, title] of lastPerSession) {
      const prev = this.lastEmitted.get(sessionId);
      if (prev === title) {
        continue;
      }
      this.lastEmitted.set(sessionId, title);
      this.onTitle(sessionId, title);
      emitted = true;
    }
    return emitted;
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

    // Truncation guard: a shrunk file (rotated/rewritten) resets the tail —
    // offset to 0, clear the partial buffer + decoder.
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
      // open→read-to-EOF→close per change event; read in bounded chunks so a
      // huge append never balloons memory.
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
    // Cheap pre-filter: skip the JSON.parse for lines that can't be a title, an
    // isApiErrorMessage synthetic, OR an AskUserQuestion tool_use. The three
    // needle-substrings are disjoint (see the "disjointness corpus" test).
    //
    // The api-error needle is `"isApiErrorMessage":true` — the one flag every
    // terminal-failure envelope guarantees, and it skips both negative-gate
    // frames (the `SDKAPIRetryMessage` system row lacks the field; the
    // `SDKRateLimitEvent` quota notification has a distinct envelope).
    //
    // The input-request needle is `"name":"AskUserQuestion"` (not the bare
    // token, which could appear inside a `custom-title` or an error message
    // rendering the prior tool_use): the `"name":` prefix pins the substring to
    // the `tool_use` schema's `name` field. Relies on the writers emitting no
    // whitespace in JSON; if that changes, widen to `"name"`.
    //
    // The subagent-turn needle is `"agentId":` — present ONLY in subagent
    // sidecar transcript lines (the parent's own turns carry no `agentId`), so
    // it is the cheap discriminator that pins this branch to subagent
    // transcripts. It is INDEPENDENT of the three parent-transcript needles
    // above (a subagent assistant turn lives in a different file and never
    // carries `custom-title` / `isApiErrorMessage`), so it is checked
    // separately rather than as part of the mutually-exclusive chain.
    const isTitle = line.includes("custom-title");
    const isApiError = !isTitle && line.includes('"isApiErrorMessage":true');
    const isInputRequest =
      !isTitle && !isApiError && line.includes('"name":"AskUserQuestion"');
    const isSubagentTurn = line.includes('"agentId":');
    if (!isTitle && !isApiError && !isInputRequest && !isSubagentTurn) {
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
    if (isApiError) {
      // No change-gate: the reducer fold is idempotent, so a duplicate emit
      // folds to the same row state.
      const match = matchApiError(parsed);
      if (!match) {
        return;
      }
      this.onApiError(match.sessionId, match.text, match.kind);
      return;
    }
    if (isInputRequest) {
      // No change-gate (idempotent fold). No boot-scan path for this signal: the
      // `[awaiting:*]` pill marks a LIVE state, so replaying it from a historical
      // scan would show stale blocks for already-answered sessions.
      const match = matchAskUserQuestion(parsed);
      if (!match) {
        return;
      }
      this.onInputRequest(match.sessionId, match.requestKind);
      return;
    }
    const match = matchSubagentTurn(parsed);
    if (!match) {
      return;
    }
    const key = `${match.sessionId}\x00${match.agentId}`;
    if (!match.settled) {
      this.pendingSubagentTurns.set(key, { path, match });
      return;
    }
    this.pendingSubagentTurns.delete(key);
    this.onSubagentTurn(match.sessionId, match.agentId, match.disposition);
  }
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Seed the line stream's change-gate from the keeper DB: for each job whose
 * `title_source === 'transcript'`, the persisted `jobs.title` is the last
 * transcript title that won, so re-emitting it on restart would be redundant.
 * Jobs at a lower title source are left unset so their first transcript title
 * emits. Read-only.
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

export function settleClosedSubagentTurns(
  db: Database,
  stream: TranscriptLineStream,
): number {
  const rows = db
    .query(
      `SELECT s.job_id, s.agent_id
         FROM subagent_invocations s
         JOIN jobs j ON j.job_id = s.job_id
        WHERE s.duration_ms IS NOT NULL
          AND s.last_disposition IS NULL
          AND j.state = 'working'
          AND NOT EXISTS (
            SELECT 1 FROM subagent_invocations newer
             WHERE newer.job_id = s.job_id
               AND newer.agent_id = s.agent_id
               AND newer.turn_seq > s.turn_seq
          )
        ORDER BY s.job_id, s.agent_id`,
    )
    .all() as { job_id: string; agent_id: string }[];
  let settled = 0;
  for (const row of rows) {
    if (stream.settleSubagentTurn(row.job_id, row.agent_id)) {
      settled += 1;
    }
  }
  return settled;
}

/**
 * Boot scan: fold the CURRENT `custom-title` for each live job, scoped via
 * `jobs.transcript_path`. Makes a rename-while-down survive a daemon restart,
 * which the EOF-anchored live tail would otherwise miss.
 *
 * Scoping to `jobs.transcript_path` (NOT a recursive walk of the watch root) is
 * deliberate: a title only folds onto an EXISTING `jobs` row, and this scopes to
 * exactly the per-session files that matter — skipping thousands of dead
 * historical transcripts, and reading the real file even when it lives outside
 * the configured watch root (multi-profile). Must run AFTER `seedFromDb` so an
 * already-folded title is suppressed by the change-gate. Read-only; per-file
 * errors skip-and-log inside `scanFile`.
 *
 * Returns `true` iff at least one scanned file emitted a (changed) title — the
 * `rescued` boolean the backstop folds into one `missed-wake` record.
 */
export function scanJobsForTitles(
  db: Database,
  stream: TranscriptLineStream,
): boolean {
  const rows = db
    .query("SELECT transcript_path FROM jobs WHERE transcript_path IS NOT NULL")
    .all() as { transcript_path: string }[];
  let emittedAny = false;
  for (const row of rows) {
    if (
      typeof row.transcript_path !== "string" ||
      row.transcript_path.length === 0
    ) {
      continue;
    }
    if (stream.scanFile(row.transcript_path)) {
      emittedAny = true;
    }
  }
  return emittedAny;
}

/** The re-arm window: the new subscription must survive one full heartbeat
 * interval before a fresh rescue is treated as a genuine re-mute. Mirrors
 * {@link HEARTBEAT_MS} (declared inside `main`) so a still-mute replacement
 * can't churn the stream every heartbeat. Exported for the decision-helper test. */
export const TRANSCRIPT_REARM_FLAP_GUARD_MS = 60_000;

/**
 * Inputs the heartbeat collects when deciding whether to re-arm the single
 * transcript subscription. Pure data — no handles, no I/O.
 */
export interface TranscriptResubscribeInputs {
  /** The heartbeat's `scanJobsForTitles` returned true (the watcher went mute
   * and the slow backstop just re-folded a missed title). */
  rescued: boolean;
  /** The worker is tearing down — never start a replace mid-shutdown. */
  shuttingDown: boolean;
  /** The native watcher is disabled (in-process tier) — there is no live
   * subscription to replace. */
  nativeWatcherDisabled: boolean;
  /** `existsSync(watchRoot)` — a deleted-and-recreated root is a new inode
   * FSEvents won't re-attach to, so a missing root DEFERS the re-arm. */
  rootExists: boolean;
  /** When the current subscription was last (re)armed, or `null` if it was
   * never re-armed this run (the boot subscribe leaves no stamp). */
  reArmedAtMs: number | null;
  /** The heartbeat's wall-clock (the caller's single `Date.now()`). */
  nowMs: number;
  /** The flap-guard window length (normally {@link TRANSCRIPT_REARM_FLAP_GUARD_MS}). */
  flapGuardMs: number;
}

/**
 * Mute-subscription re-arm decision for the transcript worker. The transcript
 * worker has ONE static subscription and NO reconcile loop, so the heartbeat
 * drives the replace directly — this helper is the pure verdict that gates it.
 *
 * Returns:
 *   - `"skip"`  — nothing to do: no rescue, shutting down, native watcher
 *     disabled, OR still inside the flap-guard window after a recent re-arm
 *     (a still-mute replacement must not churn the stream every heartbeat).
 *   - `"defer"` — a rescue warrants a re-arm but the watch root is missing;
 *     retry on the next heartbeat once the dir exists again (never error).
 *   - `"replace"` — rescue, healthy flap guard, root present: tear down the
 *     mute subscription and re-subscribe sequentially with identical options.
 *
 * PURE — boolean/clock arithmetic, no I/O and no mutation of its input; the
 * caller owns the `unsubscribe()`/`subscribe()` and the flap-guard stamp.
 * Exported for unit reach (the {@link decidePlanResubscribe} sibling model).
 */
export function decideTranscriptResubscribe(
  inputs: TranscriptResubscribeInputs,
): "replace" | "defer" | "skip" {
  const {
    rescued,
    shuttingDown,
    nativeWatcherDisabled,
    rootExists,
    reArmedAtMs,
    nowMs,
    flapGuardMs,
  } = inputs;
  // No rescue, or no live subscription to replace, or mid-shutdown → nothing.
  if (!rescued || shuttingDown || nativeWatcherDisabled) return "skip";
  // Flap guard: a re-arm within the last interval means the replacement has not
  // yet survived a full heartbeat — suppress so a still-mute stream can't churn.
  if (reArmedAtMs !== null && nowMs - reArmedAtMs < flapGuardMs) return "skip";
  // A vanished root is a new-inode hazard — defer until it exists again.
  if (!rootExists) return "defer";
  return "replace";
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
  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });

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
    (sessionId, text, errorKind) => {
      port.postMessage({
        kind: "api-error",
        sessionId,
        text,
        errorKind,
      } satisfies ApiErrorMessage);
    },
    (sessionId, requestKind) => {
      port.postMessage({
        kind: "input-request",
        sessionId,
        requestKind,
      } satisfies InputRequestMessage);
    },
    (sessionId, agentId, disposition) => {
      port.postMessage({
        kind: "subagent-turn",
        sessionId,
        agentId,
        disposition,
      } satisfies SubagentTurnMessage);
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

  let shuttingDown = false;
  const dataVersionTolerance = new NotadbTolerance();
  const dataVersionQuery = db.query("PRAGMA data_version");
  let lastDataVersion: number | null = null;
  const SUBAGENT_SETTLEMENT_POLL_MS = 250;
  const settlementTimer = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    const outcome = dataVersionTolerance.poll(
      () =>
        (
          dataVersionQuery.get() as {
            data_version: number;
          }
        ).data_version,
    );
    if (outcome.skipped) {
      return;
    }
    const changed = outcome.value !== lastDataVersion;
    lastDataVersion = outcome.value;
    if (changed || stream.hasPendingSubagentTurns()) {
      settleClosedSubagentTurns(db, stream);
    }
  }, SUBAGENT_SETTLEMENT_POLL_MS);

  let subscription: AsyncSubscription | null = null;
  // Monotonic subscribe generation. Bumped on every (re)subscribe; the watcher
  // callback captures its generation and no-ops if it has been superseded — a
  // batch can fire AFTER `unsubscribe()` resolves (the parcel/watcher #190
  // stale-callback window), so without this a stale callback could touch
  // torn-down state or double-fire a re-arm.
  let subGeneration = 0;
  // When the live subscription was last re-armed (null = boot subscribe, never
  // re-armed). The flap guard reads it so a still-mute replacement can't churn
  // the stream every heartbeat.
  let reArmedAtMs: number | null = null;
  // A re-arm is in flight (sequential unsubscribe→subscribe). The heartbeat
  // single-flights against it so two heartbeats can't overlap a replace.
  let rearming = false;
  // The heartbeat's re-arm trigger, installed once the subscribe machinery is
  // built below (the heartbeat closure is created first but only ever fires
  // after `main` returns). Null until then / when the native watcher is off.
  let reArmFromHeartbeat: (() => Promise<void>) | null = null;

  // `lastFastPathAt` is stamped at every confirmed fast-path fire (the live
  // `onChange` tail driven by a real FSEvents batch); the heartbeat reads it to
  // compute staleness. `null` until the first fast path fires — the cold-boot
  // sentinel that keeps a false staleness off the histogram. The counters
  // accumulate fires/rescues per (backstop,class) for the denominator.
  let lastFastPathAt: number | null = null;
  const backstopCounters = new BackstopCounters();
  let rollupTimer: ReturnType<typeof setInterval> | null = null;
  const flushBackstopRollups = (): void => {
    for (const rollup of backstopCounters.snapshot(Date.now())) {
      port.postMessage({
        kind: "backstop",
        record: rollup,
      } satisfies BackstopMessage);
    }
  };

  // Drop-recovery scheduler (single root): a recoverable FSEvents drop schedules
  // a debounced, single-flight re-scan via the change-gated boot-scan primitive
  // (scanJobsForTitles, which routes through scanFile's TRANSIENT decoder — NEVER
  // onChange, which would advance/re-anchor byte offsets and lose the change
  // we're recovering). The warm in-memory change-gate suppresses re-emits, so
  // recovery is idempotent. Cleared in shutdown before unsubscribe.
  const rescan = new RescanScheduler(() => {
    if (shuttingDown) {
      return;
    }
    // The FSEvents-drop backstop — fold the emitted-boolean into one
    // `rescan-drop` missed-wake record.
    const rescued = scanJobsForTitles(db, stream);
    backstopCounters.bump("rescan-drop", "missed-wake", rescued);
    if (rescued) {
      port.postMessage({
        kind: "backstop",
        record: buildMissedWakeRecord({
          backstop: "rescan-drop",
          worker: "transcript-worker",
          fastPath: "fsevents",
          rescued: true,
          now: Date.now(),
          lastFastPathAt,
        }),
      } satisfies BackstopMessage);
    }
  });

  // Heartbeat / silent-watcher recovery. The @parcel/watcher subscribe can
  // resolve but then go mute — the per-event callback never fires again — while
  // sessions actively rename, stranding the priority-3 transcript signal.
  // Two-pronged backstop:
  //   1. `eventsReceived` counter logged every HEARTBEAT_MS so a stall is
  //      visible from the logs instead of requiring DB forensics.
  //   2. Every HEARTBEAT_MS, unconditionally re-run scanJobsForTitles. The scan
  //      is change-gated by `lastEmitted`, so a healthy watcher's titles are
  //      suppressed; a silent watcher's missed renames are caught within one
  //      tick. Same primitive as the FSEvents-drop path (TRANSIENT decoder,
  //      never `onChange`).
  const HEARTBEAT_MS = 60_000;
  // Cadence at which the worker flushes its backstop counters as rollup records
  // — the denominator survives a crash without a line per no-op fire.
  const BACKSTOP_ROLLUP_FLUSH_MS = 5 * 60_000;
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
      // The slow backstop — fold the emitted-boolean into one
      // `transcript-heartbeat` missed-wake record (`true` = the watcher went
      // mute and the heartbeat re-folded a missed title).
      const rescued = scanJobsForTitles(db, stream);
      backstopCounters.bump("transcript-heartbeat", "missed-wake", rescued);
      if (rescued) {
        port.postMessage({
          kind: "backstop",
          record: buildMissedWakeRecord({
            backstop: "transcript-heartbeat",
            worker: "transcript-worker",
            fastPath: "fsevents",
            rescued: true,
            now: Date.now(),
            lastFastPathAt,
          }),
        } satisfies BackstopMessage);
      }
      // fn-788 mute-subscription re-arm. A heartbeat rescue means the live
      // FSEvents stream went mute (the slow backstop just re-folded a missed
      // title). Decide via the pure helper whether to replace it now, defer (a
      // missing root retries next heartbeat), or skip (no rescue / shutting down
      // / native watcher off / inside the flap-guard window). The replace itself
      // is async + sequential; the heartbeat fires it and moves on (the `reArm`
      // closure single-flights against an in-flight replace).
      const verdict = decideTranscriptResubscribe({
        rescued,
        shuttingDown,
        nativeWatcherDisabled: data.disableNativeWatcher === true,
        rootExists: existsSync(watchRoot),
        reArmedAtMs,
        nowMs: Date.now(),
        flapGuardMs: HEARTBEAT_MS,
      });
      if (verdict === "defer") {
        console.error(
          `[transcript-worker] re-arm deferred: watch root ${watchRoot} does not exist`,
        );
      } else if (verdict === "replace" && reArmFromHeartbeat !== null) {
        void reArmFromHeartbeat();
      }
    } catch (err) {
      console.error(
        `[transcript-worker] heartbeat scan failed: ${stringifyErr(err)}`,
      );
    }
  }, HEARTBEAT_MS);

  // Periodic backstop-rollup flush — checkpoint the denominator so it survives a
  // crash. Cleared + final-flushed in the shutdown handler.
  rollupTimer = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    try {
      flushBackstopRollups();
    } catch (err) {
      console.error(
        `[transcript-worker] backstop rollup flush failed: ${stringifyErr(err)}`,
      );
    }
  }, BACKSTOP_ROLLUP_FLUSH_MS);

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
      // Supersede any live subscription generation so a batch that fires during
      // teardown (the #190 stale-callback window) no-ops, and so an in-flight
      // re-arm's fresh subscribe self-releases instead of resurrecting the watch.
      subGeneration++;
      // Clear any armed re-scan timer FIRST (before unsubscribe / db close) so a
      // pending drop-recovery scan can't fire against a closing connection. The
      // heartbeat timer carries the same constraint (its body runs scanJobsForTitles).
      rescan.cancel();
      clearInterval(heartbeatTimer);
      clearInterval(settlementTimer);
      // Cancel the periodic rollup flush, then flush ONE final rollup so the
      // denominator survives a clean stop.
      if (rollupTimer != null) {
        clearInterval(rollupTimer);
        rollupTimer = null;
      }
      flushBackstopRollups();
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

  // @parcel/watcher's `subscribe` REQUIRES an existing dir, so a missing watch
  // root skips-and-logs and stays alive for the shutdown handshake (not a crash;
  // no titles until the daemon restarts after the dir exists).
  if (!existsSync(watchRoot)) {
    console.error(
      `[transcript-worker] watch root ${watchRoot} does not exist; not watching`,
    );
    return;
  }

  // The watcher batch callback, parameterized by the subscribe generation that
  // owns it. A batch can fire AFTER `unsubscribe()` resolves (parcel/watcher
  // #190), so a callback whose generation has been superseded by a re-arm
  // no-ops — it must never touch torn-down state or re-fire the recovery.
  const makeBatchHandler =
    (generation: number) => (err: Error | null, events: WatcherEvent[]) => {
      if (subGeneration !== generation) return;
      if (err) {
        // Always leave a breadcrumb: the drop discriminator couples to
        // @parcel/watcher's message text, so a wording change must stay
        // observable in the logs.
        console.error(
          `[transcript-worker] watcher error: ${stringifyErr(err)}`,
        );
        // A recoverable FSEvents drop may never re-fire (the live tail is
        // EOF-anchored), so schedule a debounced re-scan. A non-drop err just
        // swallow-and-logs.
        if (isDropError(err)) {
          rescan.schedule();
        }
        return;
      }
      // Bump on the raw event batch (pre-filter) so the heartbeat log
      // distinguishes a healthy-but-quiet watcher from a silent-dead one.
      eventsReceived += events.length;
      lastEventAt = Date.now();
      // A confirmed FSEvents batch IS the fast path for transcript titles —
      // stamp `last_fast_path_at` so a later heartbeat measures staleness
      // against it.
      lastFastPathAt = Date.now();
      for (const ev of events) {
        // Treat every event as "go look"; a delete just drops tracking. The
        // `.jsonl` check is the sole correctness gate (a directory is also
        // rejected later by statSync's `isFile()` guard).
        //
        // No `ignore` glob is passed to subscribe: negated extglobs trip
        // parcel-bundler/watcher #174 and correlated with the silent-watcher
        // stall. Re-introduce only as positive `**/<noisy-dir>/**` globs.
        if (!ev.path.endsWith(".jsonl")) {
          continue;
        }
        if (ev.type === "delete") {
          stream.unregister(ev.path);
          continue;
        }
        stream.onChange(ev.path);
      }
    };

  // Subscribe ONE generation. Bumps the generation FIRST (so any in-flight
  // callback from the prior subscription is already superseded), then resolves
  // the addon module + subscribes with the IDENTICAL options as boot
  // (deliberately NO ignore globs — #174). Returns the live subscription, or
  // `null` on a subscribe failure (the re-arm path tolerates that; the boot
  // path treats a null as fatal). Never calls process.exit — that decision
  // belongs to the caller.
  const subscribeWatcher = async (
    watcher: typeof import("@parcel/watcher"),
  ): Promise<AsyncSubscription | null> => {
    const generation = ++subGeneration;
    try {
      const sub = await watcher.subscribe(
        watchRoot,
        makeBatchHandler(generation),
      );
      if (shuttingDown || subGeneration !== generation) {
        // Shutdown or a newer subscribe raced this resolution — release it.
        void sub.unsubscribe();
        return null;
      }
      return sub;
    } catch (err) {
      console.error(
        `[transcript-worker] failed to subscribe to ${watchRoot}: ${stringifyErr(err)}`,
      );
      return null;
    }
  };

  // Re-arm the single mute subscription, driven directly from the heartbeat
  // (the transcript worker has no reconcile loop — the heartbeat IS the
  // subscription-replace seam). SEQUENTIAL teardown is the cardinal rule:
  // `await unsubscribe()` MUST complete before `subscribe()` on the same tree —
  // overlapping live FSEvents streams on one tree is the machine-wide
  // fseventsd-exhaustion vector (parcel/watcher #190). Re-subscribe failure is
  // NON-fatal: log and leave unwatched until the next heartbeat re-fires
  // (explicitly diverging from the boot subscribe's fatal exit — re-arm is
  // recovery, not boot). The `stream` and its byte offsets are UNTOUCHED; only
  // the `subscription` variable is swapped, so no re-anchoring / phantom re-fold.
  const reArm = async (): Promise<void> => {
    if (rearming) return;
    rearming = true;
    try {
      console.error(
        `[transcript-worker] re-arm: replacing mute watcher for ${watchRoot}`,
      );
      const watcher = await import("@parcel/watcher");
      if (shuttingDown) return;
      // Tear down the old stream FIRST (best-effort, like shutdown's), then
      // re-subscribe. `subscribeWatcher` bumps the generation, so a stale batch
      // from `old` is already inert.
      const old = subscription;
      subscription = null;
      if (old) {
        try {
          await old.unsubscribe();
        } catch {
          // best-effort — a failed unsubscribe on a mute stream is expected.
        }
      }
      if (shuttingDown) return;
      const fresh = await subscribeWatcher(watcher);
      if (fresh === null) {
        // Non-fatal: stay unwatched, leave no flap-guard stamp so the next
        // heartbeat rescue re-fires immediately.
        return;
      }
      subscription = fresh;
      // Flap guard: stamp only on a successful re-subscribe so a still-mute
      // replacement is suppressed for one heartbeat interval (don't churn).
      reArmedAtMs = Date.now();
      // Full rescan after the fresh subscribe (APFS coalescing collapses bursts,
      // so back-fill can't be reconstructed) — the change-gate suppresses
      // unchanged titles, so this re-emits only what actually changed.
      try {
        scanJobsForTitles(db, stream);
      } catch (err) {
        console.error(
          `[transcript-worker] re-arm rescan failed: ${stringifyErr(err)}`,
        );
      }
    } catch (err) {
      // Any unexpected failure on the recovery path is non-fatal — log and let
      // the next heartbeat re-fire. NEVER process.exit here.
      console.error(`[transcript-worker] re-arm failed: ${stringifyErr(err)}`);
    } finally {
      rearming = false;
    }
  };
  reArmFromHeartbeat = reArm;

  // Watcher seam: skip the native addon dlopen entirely in the in-process tier;
  // stay alive for the shutdown handshake.
  if (data.disableNativeWatcher) {
    return;
  }

  // `subscribe` is the only unrecoverable BOOT surface — a failure exits
  // non-zero → daemon fatalExit → launchd restart. The re-arm path above is the
  // sanctioned recovery seam and is explicitly non-fatal.
  import("@parcel/watcher")
    .then((watcher) => subscribeWatcher(watcher))
    .then((sub) => {
      if (sub === null) {
        if (shuttingDown) return;
        // A boot subscribe that yielded no live subscription (not a shutdown
        // race) is unrecoverable — exit for the LaunchAgent to restart.
        console.error(
          `[transcript-worker] boot subscribe to ${watchRoot} produced no subscription`,
        );
        closeDb();
        process.exit(1);
      }
      subscription = sub;
      // Startup current-title fold: after seedFromDb AND after the subscription
      // is live, scan each live job's transcript for its current `custom-title`.
      // Runs synchronously before any async watcher callback fires, so there's no
      // race with the live tail. Wrapped so a scan failure never trips fatalExit.
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

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  TranscriptDocument,
  TranscriptEntry,
  TranscriptListItem,
  TranscriptMetadata,
  TranscriptSession,
  TranscriptSource,
  TranscriptTool,
} from "./model";
import {
  backfillToolNames,
  contentText,
  finalizeTimestamps,
  markMalformedLine,
  type ParsedTimestamp,
  type ParseState,
  parseTimestamp,
  pushEntry,
  recordOf,
  stringOrNull,
  trackTimestamp,
  withinTranscriptLineByteCap,
} from "./parse-common";
import type {
  TranscriptFindOutcome,
  TranscriptFindQuery,
  TranscriptListOutcome,
  TranscriptListQuery,
  TranscriptReader,
  TranscriptRootInputs,
  TranscriptSessionHandle,
} from "./reader";
import { ellipsizeInline } from "./text";

/** HEAD-only sample (never head+tail, unlike claude/pi): session_meta, the
 *  first turn_context, and the human's first turn all sit near the top of a
 *  rollout, and list's per-file cost must stay O(1) regardless of how long
 *  the session has run. */
const METADATA_SLICE_BYTES = 128 * 1024;
const SUMMARY_PREVIEW_CHARS = 240;
const NO_ROOTS_MESSAGE = "no readable codex sessions directory found";

const CODEX_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLLOUT_FILENAME_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** codex's rollout filename is `rollout-<ts>-<uuid>.jsonl`; the timestamp
 *  segment uses dash separators with a literal T, so the uuid is parsed from
 *  the filename TAIL, never the timestamp shape. Re-expressed locally from
 *  `codexSessionIdFromRolloutPath` (src/agent/codex-session-index.ts). */
function codexSessionIdFromFilename(name: string): string | null {
  return ROLLOUT_FILENAME_RE.exec(name)?.[1] ?? null;
}

function isSafeCodexSessionId(sessionId: string): boolean {
  return basename(sessionId) === sessionId && CODEX_UUID_RE.test(sessionId);
}

/** codex has exactly one sessions root: the `CODEX_HOME` override, else
 *  `<home>/.codex`. `configDirs` is claude's `--config-dir` concept and is
 *  ignored — codex has no notion of it. */
function resolveCodexHome(root: TranscriptRootInputs): string {
  const override = (root.env.CODEX_HOME ?? "").trim();
  return override.length > 0 ? override : join(root.homeDir, ".codex");
}

function discoverCodexSessionsDir(root: TranscriptRootInputs): string | null {
  const dir = join(resolveCodexHome(root), "sessions");
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function safeSubdirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every `<sessionsDir>/YYYY/MM/DD` directory that exists, walked without a
 * time window — the unwindowed `list --global`/find path. codex's archived
 * sessions live in `archived_sessions`, a SIBLING of `sessions` (codex's
 * ARCHIVED_SESSIONS_SUBDIR), not nested inside it — rooting every walk at
 * `sessionsDir` therefore excludes archived sessions automatically, and that
 * exclusion is deliberate, never accidental.
 */
function allDayDirs(sessionsDir: string): string[] {
  const dirs: string[] = [];
  for (const year of safeSubdirNames(sessionsDir)) {
    const yearDir = join(sessionsDir, year);
    for (const month of safeSubdirNames(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of safeSubdirNames(monthDir)) {
        dirs.push(join(monthDir, day));
      }
    }
  }
  return dirs;
}

/** Local calendar day-dirs spanning `[sinceMs, untilMs ?? now]`, mirroring
 *  codex's own local-date sessions layout (matches `windowDayDirs` in
 *  src/agent/codex-session-index.ts). Existence-checked so a sparse history
 *  never touched on some days doesn't cost a failed readdir. */
function windowedDayDirs(
  sessionsDir: string,
  sinceMs: number,
  untilMs: number | null,
): string[] {
  const dirs: string[] = [];
  const cursor = new Date(sinceMs);
  cursor.setHours(0, 0, 0, 0);
  const endDay = new Date(untilMs ?? Date.now());
  endDay.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= endDay.getTime()) {
    const dir = join(
      sessionsDir,
      String(cursor.getFullYear()),
      String(cursor.getMonth() + 1).padStart(2, "0"),
      String(cursor.getDate()).padStart(2, "0"),
    );
    if (existsSync(dir)) {
      dirs.push(dir);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dirs;
}

function candidateDayDirs(
  sessionsDir: string,
  sinceMs: number | null,
  untilMs: number | null,
): string[] {
  return sinceMs === null
    ? allDayDirs(sessionsDir)
    : windowedDayDirs(sessionsDir, sinceMs, untilMs);
}

export interface CodexRolloutFile {
  path: string;
  /** The uuid parsed from the filename tail — always available for any
   *  candidate file, since a file only becomes a candidate by matching the
   *  rollout filename shape in the first place. */
  filenameId: string;
  bytes: number;
  modifiedMs: number;
}

function scanDayDirFiles(dir: string): CodexRolloutFile[] {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: CodexRolloutFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filenameId = codexSessionIdFromFilename(entry.name);
    if (filenameId === null) {
      continue;
    }
    const path = join(dir, entry.name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        continue;
      }
      files.push({
        path,
        filenameId,
        bytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    } catch {
      // Vanished between readdir and stat; skip.
    }
  }
  return files;
}

/**
 * `session_meta`-shaped fields from one parsed line — tolerant of both the
 * normal `{type:"session_meta", payload:{id, cwd, ...}}` envelope and a bare
 * pre-envelope meta line (`{id, cwd, timestamp, ...}` with no wrapper at
 * all, no `type` field). Returns null for any other line shape.
 */
function codexMetaFromObject(
  obj: Record<string, unknown>,
): { id: string | null; cwd: string | null } | null {
  if (obj.type === "session_meta") {
    const payload = recordOf(obj.payload);
    return payload === null
      ? null
      : { id: stringOrNull(payload.id), cwd: stringOrNull(payload.cwd) };
  }
  if (
    obj.type === undefined &&
    (typeof obj.id === "string" || typeof obj.cwd === "string")
  ) {
    return { id: stringOrNull(obj.id), cwd: stringOrNull(obj.cwd) };
  }
  return null;
}

function parseJsonArguments(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw ?? null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseCodexMessage(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: ParsedTimestamp | null,
): void {
  const role = stringOrNull(payload.role);
  const text = contentText(payload.content);
  if (text.trim().length === 0) {
    return;
  }
  if (role === "user" || role === "assistant") {
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role,
      kind: "text",
      text,
      meta: false,
      tool: null,
    });
    return;
  }
  if (role === "developer") {
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "system",
      kind: "system",
      text,
      meta: true,
      tool: null,
    });
  }
  // Every other/future message role folds to a silent skip.
}

function parseCodexFunctionCall(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: ParsedTimestamp | null,
): void {
  const useId = stringOrNull(payload.call_id);
  const name = stringOrNull(payload.name);
  if (useId !== null && name !== null) {
    state.toolNames.set(useId, name);
  }
  const tool: TranscriptTool = {
    name,
    useId,
    input: parseJsonArguments(payload.arguments),
    result: null,
    isError: false,
  };
  pushEntry(state, {
    timestamp: timestamp?.text ?? null,
    timestampMs: timestamp?.ms ?? null,
    role: "tool",
    kind: "tool_call",
    text: null,
    meta: false,
    tool,
  });
}

function parseCodexFunctionCallOutput(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: ParsedTimestamp | null,
): void {
  const useId = stringOrNull(payload.call_id);
  const tool: TranscriptTool = {
    name: null,
    useId,
    input: null,
    result: payload.output ?? null,
    isError: payload.success === false,
  };
  pushEntry(state, {
    timestamp: timestamp?.text ?? null,
    timestampMs: timestamp?.ms ?? null,
    role: "tool",
    kind: "tool_result",
    text: null,
    meta: false,
    tool,
  });
}

function parseCodexWebSearchCall(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: ParsedTimestamp | null,
): void {
  const useId = stringOrNull(payload.call_id) ?? stringOrNull(payload.id);
  const name = "web_search";
  if (useId !== null) {
    state.toolNames.set(useId, name);
  }
  const tool: TranscriptTool = {
    name,
    useId,
    input: payload.action ?? null,
    result: null,
    isError: false,
  };
  pushEntry(state, {
    timestamp: timestamp?.text ?? null,
    timestampMs: timestamp?.ms ?? null,
    role: "tool",
    kind: "tool_call",
    text: null,
    meta: false,
    tool,
  });
}

function parseCodexResponseItem(
  state: ParseState,
  payload: Record<string, unknown> | null,
  timestamp: ParsedTimestamp | null,
): void {
  if (payload === null) {
    return;
  }
  const type = stringOrNull(payload.type);
  if (type === "message") {
    parseCodexMessage(state, payload, timestamp);
    return;
  }
  if (type === "function_call") {
    parseCodexFunctionCall(state, payload, timestamp);
    return;
  }
  if (type === "function_call_output") {
    parseCodexFunctionCallOutput(state, payload, timestamp);
    return;
  }
  if (type === "web_search_call") {
    parseCodexWebSearchCall(state, payload, timestamp);
    return;
  }
  // "reasoning" is deliberately skipped — encrypted_content is never
  // rendered, and its readable text arrives via event_msg agent_reasoning.
  // Every other/future response_item variant (ghost_snapshot,
  // custom_tool_call[_output], tool_search_call[_output], the
  // inter-agent-communication "agent_message" shape, …) folds to a skip.
}

function parseCodexEventMsg(
  state: ParseState,
  payload: Record<string, unknown> | null,
  timestamp: ParsedTimestamp | null,
): void {
  if (payload === null) {
    return;
  }
  if (payload.type === "agent_reasoning") {
    const text = stringOrNull(payload.text) ?? "";
    if (text.length === 0) {
      return;
    }
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "assistant",
      kind: "thinking",
      text,
      meta: false,
      tool: null,
    });
  }
  // agent_message/user_message are response_item duplicates and never
  // render (list's firstPrompt reads user_message straight off the raw
  // line instead — see scanCodexHead); every other event_msg variant
  // (task_started/complete, token_count, exec_command_end, …) folds to a
  // skip.
}

function parseCodexLine(state: ParseState, line: string): void {
  if (!withinTranscriptLineByteCap(line)) {
    markMalformedLine(state);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    markMalformedLine(state);
    return;
  }
  const obj = recordOf(parsed);
  if (obj === null) {
    return;
  }
  // Order and time-filter by the TOP-LEVEL RolloutLine timestamp always —
  // session_meta carries a second inner timestamp, but the outer one is
  // canonical (matches every other line type, which has no inner one).
  const timestamp = parseTimestamp(obj.timestamp);
  trackTimestamp(state, timestamp);

  const meta = codexMetaFromObject(obj);
  if (meta !== null) {
    state.metadata.project = meta.cwd ?? state.metadata.project;
    return;
  }

  if (obj.type === "turn_context") {
    const payload = recordOf(obj.payload);
    state.metadata.model = stringOrNull(payload?.model) ?? state.metadata.model;
    return;
  }
  if (obj.type === "response_item") {
    parseCodexResponseItem(state, recordOf(obj.payload), timestamp);
    return;
  }
  if (obj.type === "event_msg") {
    parseCodexEventMsg(state, recordOf(obj.payload), timestamp);
    return;
  }
  // compacted, world_state, inter_agent_communication_metadata, and any
  // future top-level RolloutLine type fold to a silent skip, never throw.
}

/** Parse one codex rollout JSONL transcript into the harness-neutral model. */
export function parseCodexRolloutText(
  text: string,
  options: { path: string; sessionId: string; source?: TranscriptSource },
): TranscriptDocument {
  const metadata: TranscriptMetadata = {
    sessionId: options.sessionId,
    harness: "codex",
    path: options.path,
    project: null,
    title: null,
    titleHistory: [],
    agentName: null,
    model: null,
    version: null,
    gitBranch: null,
    startedAt: null,
    updatedAt: null,
    malformedLines: 0,
  };
  const state: ParseState = {
    source: options.source ?? "main",
    entries: [],
    unknownRecords: [],
    toolNames: new Map(),
    metadata,
    minTimestamp: null,
    maxTimestamp: null,
    nextSourceOrdinal: 0,
    nextRecordOrdinal: 0,
  };
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) {
      parseCodexLine(state, line);
    }
  }
  finalizeTimestamps(state);
  backfillToolNames(state);
  return {
    metadata,
    source: state.source,
    entries: state.entries,
    unknownRecords: state.unknownRecords,
  };
}

export function readCodexTranscript(
  path: string,
  sessionId: string,
  source: TranscriptSource = "main",
): TranscriptDocument {
  return parseCodexRolloutText(readFileSync(path, "utf8"), {
    path,
    sessionId,
    source,
  });
}

function readSlice(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function headSlice(path: string, bytes: number): string {
  if (bytes <= METADATA_SLICE_BYTES) {
    return readFileSync(path, "utf8");
  }
  return readSlice(path, 0, METADATA_SLICE_BYTES);
}

function firstUserPromptFromEntries(
  document: TranscriptDocument,
): string | null {
  for (const entry of document.entries) {
    if (entry.role !== "user" || entry.kind !== "text" || entry.text === null) {
      continue;
    }
    const trimmed = entry.text.trim();
    if (trimmed.length === 0) {
      continue;
    }
    return ellipsizeInline(trimmed, SUMMARY_PREVIEW_CHARS);
  }
  return null;
}

interface CodexHeadScan {
  /** `session_meta.payload.id` (or the bare pre-envelope `id` field) from
   *  the first meta-shaped line in the sample; null when absent/malformed —
   *  the caller backfills from the filename uuid. */
  contentId: string | null;
  /** The first `event_msg` `user_message` text — the CLEAN human turn,
   *  unpadded by the AGENTS.md/environment_context wrapper the matching
   *  response_item user turn carries. */
  firstEventUserMessage: string | null;
}

/** A single bounded pass over the head-sliced text for the two pieces of
 *  content-derived list metadata the shared spine parser doesn't expose:
 *  the session_meta id (for filename backfill) and the clean first human
 *  turn (event_msg user_message, suppressed from the rendered spine because
 *  it duplicates the response_item user turn). */
function scanCodexHead(headText: string): CodexHeadScan {
  let contentId: string | null = null;
  let sawMeta = false;
  let firstEventUserMessage: string | null = null;
  for (const raw of headText.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || !withinTranscriptLineByteCap(line)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = recordOf(parsed);
    if (obj === null) {
      continue;
    }
    if (!sawMeta) {
      const meta = codexMetaFromObject(obj);
      if (meta !== null) {
        contentId = meta.id;
        sawMeta = true;
        continue;
      }
    }
    if (firstEventUserMessage === null && obj.type === "event_msg") {
      const payload = recordOf(obj.payload);
      if (payload !== null && payload.type === "user_message") {
        const text = stringOrNull(payload.message);
        if (text !== null && text.trim().length > 0) {
          firstEventUserMessage = text;
        }
      }
    }
  }
  return { contentId, firstEventUserMessage };
}

function inspectCodexFile(file: CodexRolloutFile): {
  document: TranscriptDocument;
  firstPrompt: string | null;
} {
  const headText = headSlice(file.path, file.bytes);
  const scan = scanCodexHead(headText);
  const sessionId = scan.contentId ?? file.filenameId;
  const document = parseCodexRolloutText(headText, {
    path: file.path,
    sessionId,
  });
  const firstPrompt =
    scan.firstEventUserMessage !== null
      ? ellipsizeInline(
          scan.firstEventUserMessage.trim(),
          SUMMARY_PREVIEW_CHARS,
        )
      : firstUserPromptFromEntries(document);
  return { document, firstPrompt };
}

export interface CodexListOptions {
  sessionsDir: string;
  /** Null scans every project; a cwd path scans only sessions whose
   *  session_meta cwd matches exactly. */
  project: string | null;
  sinceMs: number | null;
  untilMs: number | null;
  offset: number;
  limit: number;
  /**
   * Extension seam invoked once per mtime-surviving candidate, before it is
   * inspected (head-read). Lets a caller (tests, in practice) provoke a
   * scan-to-parse race deterministically instead of relying on real
   * filesystem timing.
   */
  onBeforeInspect?: (file: CodexRolloutFile) => void;
}

export interface CodexListResult {
  items: TranscriptListItem[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

/**
 * Unlike claude/pi (path-bucketed project scope, paged BEFORE any content
 * read), codex has no per-project directory: project scope is the
 * session_meta cwd, which only content reveals. Every mtime-surviving
 * candidate is therefore head-read before paging can decide membership —
 * bounded to one head-slice per file, so an unwindowed --global list pays
 * this over the whole history, an accepted tradeoff.
 */
export function listCodexSessions(options: CodexListOptions): CodexListResult {
  const dayDirs = candidateDayDirs(
    options.sessionsDir,
    options.sinceMs,
    options.untilMs,
  );
  const candidates = dayDirs
    .flatMap(scanDayDirFiles)
    .filter(
      (file) =>
        (options.sinceMs === null || file.modifiedMs >= options.sinceMs) &&
        (options.untilMs === null || file.modifiedMs <= options.untilMs),
    );
  const wantedCwd = options.project === null ? null : resolve(options.project);
  const rows: Array<{ file: CodexRolloutFile; item: TranscriptListItem }> = [];
  for (const file of candidates) {
    options.onBeforeInspect?.(file);
    // Read-and-catch, never existsSync-then-read: the sessions tree mutates
    // live under the reader (TOCTOU). A file that vanished between scan and
    // inspect drops from this list — codex has no path-level fallback
    // project scope to keep it visible under (unlike claude/pi).
    let inspected: ReturnType<typeof inspectCodexFile> | null;
    try {
      inspected = inspectCodexFile(file);
    } catch {
      inspected = null;
    }
    if (inspected === null) {
      continue;
    }
    if (
      wantedCwd !== null &&
      inspected.document.metadata.project !== wantedCwd
    ) {
      continue;
    }
    rows.push({
      file,
      item: {
        sessionId: inspected.document.metadata.sessionId,
        path: file.path,
        project: inspected.document.metadata.project,
        title: null,
        titleHistory: [],
        startedAt: inspected.document.metadata.startedAt,
        updatedAt: new Date(file.modifiedMs).toISOString(),
        bytes: file.bytes,
        subagentCount: 0,
        firstPrompt: inspected.firstPrompt,
      },
    });
  }
  rows.sort(
    (a, b) =>
      b.file.modifiedMs - a.file.modifiedMs ||
      a.item.sessionId.localeCompare(b.item.sessionId),
  );
  const selected = rows.slice(options.offset, options.offset + options.limit);
  const end = options.offset + selected.length;
  return {
    items: selected.map((row) => row.item),
    total: rows.length,
    offset: options.offset,
    nextOffset: end < rows.length ? end : null,
  };
}

function codexList(query: TranscriptListQuery): TranscriptListOutcome {
  const sessionsDir = discoverCodexSessionsDir(query.root);
  if (sessionsDir === null) {
    return { kind: "no_roots", message: NO_ROOTS_MESSAGE };
  }
  try {
    const result = listCodexSessions({
      sessionsDir,
      project: query.project,
      sinceMs: query.sinceMs,
      untilMs: query.untilMs,
      offset: query.offset,
      limit: query.limit,
    });
    return {
      kind: "ok",
      items: result.items,
      total: result.total,
      offset: result.offset,
      nextOffset: result.nextOffset,
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      recovery: "check the codex sessions directory and retry",
    };
  }
}

function codexFind(query: TranscriptFindQuery): TranscriptFindOutcome {
  const sessionsDir = discoverCodexSessionsDir(query.root);
  if (sessionsDir === null) {
    return { kind: "no_roots", message: NO_ROOTS_MESSAGE };
  }
  if (!isSafeCodexSessionId(query.sessionId)) {
    return { kind: "not_found" };
  }
  // Filename-uuid scan across every day-dir — no content read.
  const found: CodexRolloutFile[] = [];
  for (const dir of allDayDirs(sessionsDir)) {
    for (const file of scanDayDirFiles(dir)) {
      if (file.filenameId === query.sessionId) {
        found.push(file);
      }
    }
  }
  if (found.length === 0) {
    return { kind: "not_found" };
  }
  if (found.length > 1) {
    return {
      kind: "ambiguous",
      owners: found.map((file) => dirname(file.path)),
      hint: "--since",
    };
  }
  const file = found[0] as CodexRolloutFile;
  return {
    kind: "found",
    handle: { sessionId: file.filenameId, path: file.path },
  };
}

function assembleCodexEntries(document: TranscriptDocument): TranscriptEntry[] {
  return document.entries.map((entry, ordinal) => ({ ...entry, ordinal }));
}

function codexLoad(
  handle: TranscriptSessionHandle,
  subagent: string,
): TranscriptSession | { error: string } {
  if (!existsSync(handle.path)) {
    return { error: `transcript disappeared: ${handle.path}` };
  }
  if (subagent !== "main") {
    return {
      error: `codex sessions have no subagents; requested '${subagent}'`,
    };
  }
  const main = readCodexTranscript(handle.path, handle.sessionId);
  return {
    main,
    entries: assembleCodexEntries(main),
    selectedSource: "main",
    subagents: [],
  };
}

export const codexTranscriptReader: TranscriptReader = {
  harness: "codex",
  supportsSubagents: false,
  list: codexList,
  find: codexFind,
  load: codexLoad,
};

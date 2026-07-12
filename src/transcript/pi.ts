import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
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

const METADATA_SLICE_BYTES = 128 * 1024;
const SUMMARY_PREVIEW_CHARS = 240;
const NO_ROOTS_MESSAGE = "no readable pi sessions directory found";

/** Pi's cwd -> sessions-subdir bucket encoding: `--` + slash-collapsed trimmed
 *  cwd + `--`. Re-expressed locally (never imported from src/agent) mirroring
 *  src/agent/transcript-watch.ts's encodePiCwd / src/resume-resolve.ts's copy. */
export function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

/** Pi has exactly one sessions root: the `PI_CODING_AGENT_DIR` override, else
 *  `<home>/.pi/agent`. `configDirs` is claude's `--config-dir` concept and is
 *  ignored — pi has no notion of it. */
function resolvePiRoot(root: TranscriptRootInputs): string {
  const override = (root.env.PI_CODING_AGENT_DIR ?? "").trim();
  return override.length > 0 ? override : join(root.homeDir, ".pi", "agent");
}

function discoverPiSessionsDir(root: TranscriptRootInputs): string | null {
  const dir = join(resolvePiRoot(root), "sessions");
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function isSafePiSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    basename(sessionId) === sessionId &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)
  );
}

function safeDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function bucketDirs(sessionsDir: string, project: string | null): string[] {
  return project !== null
    ? [join(sessionsDir, encodePiCwd(project))]
    : safeDirectories(sessionsDir);
}

/** A pi session file's name is `<iso-ts>_<uuid>.jsonl`; the ISO timestamp
 *  never contains an underscore, so the first `_` is always the delimiter. */
function extractPiSessionId(filename: string): string | null {
  if (!filename.endsWith(".jsonl")) {
    return null;
  }
  const separator = filename.indexOf("_");
  if (separator < 0) {
    return null;
  }
  const sessionId = filename.slice(separator + 1, -".jsonl".length);
  return sessionId.length > 0 ? sessionId : null;
}

export interface PiSessionFile {
  path: string;
  sessionId: string;
  bucket: string;
  bytes: number;
  modifiedMs: number;
}

function fileInfo(
  path: string,
  sessionId: string,
  bucket: string,
): PiSessionFile | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return null;
    }
    return {
      path,
      sessionId,
      bucket,
      bytes: stat.size,
      modifiedMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function scanBucketFiles(dir: string): PiSessionFile[] {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: PiSessionFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const sessionId = extractPiSessionId(entry.name);
    if (sessionId === null) {
      continue;
    }
    const info = fileInfo(join(dir, entry.name), sessionId, dir);
    if (info !== null) {
      files.push(info);
    }
  }
  return files;
}

function parsePiToolCall(
  state: ParseState,
  obj: Record<string, unknown>,
  timestamp: { text: string; ms: number } | null,
): void {
  const useId = stringOrNull(obj.id);
  const name = stringOrNull(obj.name);
  if (useId !== null && name !== null) {
    state.toolNames.set(useId, name);
  }
  const tool: TranscriptTool = {
    name,
    useId,
    input: obj.arguments ?? null,
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

function parsePiAssistantBlock(
  state: ParseState,
  block: unknown,
  timestamp: { text: string; ms: number } | null,
): void {
  const obj = recordOf(block);
  if (obj === null) {
    return;
  }
  const type = stringOrNull(obj.type);
  if (type === "text") {
    const text = stringOrNull(obj.text) ?? "";
    if (text.length === 0) {
      return;
    }
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "assistant",
      kind: "text",
      text,
      meta: false,
      tool: null,
    });
    return;
  }
  if (type === "thinking") {
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "assistant",
      kind: "thinking",
      text: stringOrNull(obj.thinking) ?? "",
      meta: false,
      tool: null,
    });
    return;
  }
  if (type === "toolCall") {
    parsePiToolCall(state, obj, timestamp);
  }
  // Every other block type (and every unrecognized future one) folds to a
  // silent skip rather than throwing.
}

function parsePiToolResult(
  state: ParseState,
  message: Record<string, unknown>,
  timestamp: { text: string; ms: number } | null,
): void {
  const useId = stringOrNull(message.toolCallId);
  const tool: TranscriptTool = {
    name: stringOrNull(message.toolName),
    useId,
    input: null,
    result: message.content ?? null,
    isError: message.isError === true,
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

function parsePiMessage(
  state: ParseState,
  message: Record<string, unknown> | null,
  timestamp: { text: string; ms: number } | null,
): void {
  if (message === null) {
    return;
  }
  const role = stringOrNull(message.role);
  if (role === "user") {
    const text = contentText(message.content);
    if (text.trim().length === 0) {
      return;
    }
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "user",
      kind: "text",
      text,
      meta: false,
      tool: null,
    });
    return;
  }
  if (role === "assistant") {
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      parsePiAssistantBlock(state, block, timestamp);
    }
    return;
  }
  if (role === "toolResult") {
    parsePiToolResult(state, message, timestamp);
    return;
  }
  // Any other message role (bashExecution and future roles) folds to skip.
}

function parsePiLine(state: ParseState, line: string): void {
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
  const timestamp = parseTimestamp(obj.timestamp);
  trackTimestamp(state, timestamp);
  const type = stringOrNull(obj.type);
  if (type === "session") {
    state.metadata.project = stringOrNull(obj.cwd) ?? state.metadata.project;
    return;
  }
  if (type === "session_info") {
    // Renames append a new session_info entry; the LAST one in file order
    // wins because this assignment simply overwrites on every occurrence.
    state.metadata.title = stringOrNull(obj.name) ?? state.metadata.title;
    return;
  }
  if (type === "model_change") {
    state.metadata.model = stringOrNull(obj.modelId) ?? state.metadata.model;
    return;
  }
  if (type === "compaction") {
    const text = stringOrNull(obj.summary) ?? "";
    if (text.length > 0) {
      pushEntry(state, {
        timestamp: timestamp?.text ?? null,
        timestampMs: timestamp?.ms ?? null,
        role: "summary",
        kind: "summary",
        text,
        meta: false,
        tool: null,
      });
    }
    return;
  }
  if (type === "message") {
    parsePiMessage(state, recordOf(obj.message), timestamp);
    return;
  }
  // thinking_level_change and every unrecognized/future entry type (custom,
  // custom_message, turn.completed, ...) fold to a silent skip, never throw.
}

/** Parse one pi session JSONL transcript into the harness-neutral model.
 *  Reads strictly in file/append order — the id/parentId tree links every
 *  entry carries are ignored entirely (irrelevant under file order, and
 *  absent on v1 headers anyway). A rewound session therefore renders every
 *  orphaned branch's entries too, as a superset of what a tree-aware reader
 *  would show. */
export function parsePiTranscriptText(
  text: string,
  options: { path: string; sessionId: string; source?: TranscriptSource },
): TranscriptDocument {
  const metadata: TranscriptMetadata = {
    sessionId: options.sessionId,
    harness: "pi",
    path: options.path,
    project: null,
    title: null,
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
    toolNames: new Map(),
    metadata,
    minTimestamp: null,
    maxTimestamp: null,
  };
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) {
      parsePiLine(state, line);
    }
  }
  finalizeTimestamps(state);
  backfillToolNames(state);
  return { metadata, source: state.source, entries: state.entries };
}

export function readPiTranscript(
  path: string,
  sessionId: string,
  source: TranscriptSource = "main",
): TranscriptDocument {
  return parsePiTranscriptText(readFileSync(path, "utf8"), {
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

function metadataSample(path: string, bytes: number): string {
  if (bytes <= METADATA_SLICE_BYTES * 2) {
    return readFileSync(path, "utf8");
  }
  const head = readSlice(path, 0, METADATA_SLICE_BYTES);
  const tail = readSlice(
    path,
    Math.max(0, bytes - METADATA_SLICE_BYTES),
    METADATA_SLICE_BYTES,
  );
  const tailStart = tail.indexOf("\n");
  return `${head}\n${tailStart >= 0 ? tail.slice(tailStart + 1) : tail}`;
}

function inspectPiFile(file: PiSessionFile): TranscriptDocument {
  return parsePiTranscriptText(metadataSample(file.path, file.bytes), {
    path: file.path,
    sessionId: file.sessionId,
  });
}

function firstUserPrompt(document: TranscriptDocument): string | null {
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

export interface PiListOptions {
  sessionsDir: string;
  project: string | null;
  sinceMs: number | null;
  untilMs: number | null;
  offset: number;
  limit: number;
  /**
   * Extension seam invoked once per selected file, before it is inspected
   * (parsed). Lets a caller (tests, in practice) provoke a scan-to-parse
   * race deterministically instead of relying on real filesystem timing.
   */
  onBeforeInspect?: (file: PiSessionFile) => void;
}

export interface PiListResult {
  items: TranscriptListItem[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

/** List sessions by update time while parsing only the requested result page. */
export function listPiSessions(options: PiListOptions): PiListResult {
  const candidates = bucketDirs(options.sessionsDir, options.project)
    .flatMap(scanBucketFiles)
    .filter(
      (file) =>
        (options.sinceMs === null || file.modifiedMs >= options.sinceMs) &&
        (options.untilMs === null || file.modifiedMs <= options.untilMs),
    )
    .sort(
      (a, b) =>
        b.modifiedMs - a.modifiedMs || a.sessionId.localeCompare(b.sessionId),
    );
  const selected = candidates.slice(
    options.offset,
    options.offset + options.limit,
  );
  const items = selected.map((file): TranscriptListItem => {
    options.onBeforeInspect?.(file);
    // Read-and-catch, never existsSync-then-read: the sessions tree mutates
    // live under the reader (TOCTOU). A file that vanished between scan and
    // parse degrades this one row instead of failing the page.
    let document: TranscriptDocument | null;
    try {
      document = inspectPiFile(file);
    } catch {
      document = null;
    }
    if (document === null) {
      return {
        sessionId: file.sessionId,
        path: file.path,
        project: null,
        title: null,
        startedAt: null,
        updatedAt: new Date(file.modifiedMs).toISOString(),
        bytes: file.bytes,
        subagentCount: 0,
        firstPrompt: null,
      };
    }
    return {
      sessionId: file.sessionId,
      path: file.path,
      project: document.metadata.project,
      title: document.metadata.title,
      startedAt: document.metadata.startedAt,
      updatedAt:
        document.metadata.updatedAt ?? new Date(file.modifiedMs).toISOString(),
      bytes: file.bytes,
      subagentCount: 0,
      firstPrompt: firstUserPrompt(document),
    };
  });
  const end = options.offset + items.length;
  return {
    items,
    total: candidates.length,
    offset: options.offset,
    nextOffset: end < candidates.length ? end : null,
  };
}

function piList(query: TranscriptListQuery): TranscriptListOutcome {
  const sessionsDir = discoverPiSessionsDir(query.root);
  if (sessionsDir === null) {
    return { kind: "no_roots", message: NO_ROOTS_MESSAGE };
  }
  try {
    const result = listPiSessions({
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
      recovery: "check the pi sessions directory and retry",
    };
  }
}

function piFind(query: TranscriptFindQuery): TranscriptFindOutcome {
  const sessionsDir = discoverPiSessionsDir(query.root);
  if (sessionsDir === null) {
    return { kind: "no_roots", message: NO_ROOTS_MESSAGE };
  }
  if (!isSafePiSessionId(query.sessionId)) {
    return { kind: "not_found" };
  }
  const found: PiSessionFile[] = [];
  for (const dir of bucketDirs(sessionsDir, query.project)) {
    for (const file of scanBucketFiles(dir)) {
      if (file.sessionId === query.sessionId) {
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
      owners: found.map((file) => file.bucket),
      hint: "--project",
    };
  }
  const file = found[0] as PiSessionFile;
  return {
    kind: "found",
    handle: { sessionId: file.sessionId, path: file.path },
  };
}

function assemblePiEntries(document: TranscriptDocument): TranscriptEntry[] {
  return document.entries.map((entry, ordinal) => ({ ...entry, ordinal }));
}

function piLoad(
  handle: TranscriptSessionHandle,
  subagent: string,
): TranscriptSession | { error: string } {
  if (!existsSync(handle.path)) {
    return { error: `transcript disappeared: ${handle.path}` };
  }
  if (subagent !== "main") {
    return { error: `pi sessions have no subagents; requested '${subagent}'` };
  }
  const main = readPiTranscript(handle.path, handle.sessionId);
  return {
    main,
    entries: assemblePiEntries(main),
    selectedSource: "main",
    subagents: [],
  };
}

export const piTranscriptReader: TranscriptReader = {
  harness: "pi",
  supportsSubagents: false,
  list: piList,
  find: piFind,
  load: piLoad,
};

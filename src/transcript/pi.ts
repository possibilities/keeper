import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  readJsonlMetadataSpineSync,
  scanTranscriptJsonlSync,
} from "./jsonl-scan";
import type {
  LatestTurn,
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
  boundedToolNameMap,
  contentText,
  finalizeTimestamps,
  markMalformedLine,
  type ParseState,
  parseTimestamp,
  preserveUnknownRecord,
  pushEntry,
  recordOf,
  stringOrNull,
  trackTimestamp,
  withinTranscriptLineByteCap,
} from "./parse-common";
import type {
  TranscriptFindOutcome,
  TranscriptFindQuery,
  TranscriptLineNormalizer,
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

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
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

function scanPiSessionFiles(
  sessionsDir: string,
  project: string | null,
): PiSessionFile[] {
  const files: PiSessionFile[] = [];
  const seen = new Set<string>();
  for (const dir of bucketDirs(sessionsDir, project)) {
    for (const file of scanBucketFiles(dir)) {
      const identity = safeRealpath(file.path) ?? file.path;
      if (seen.has(identity)) continue;
      seen.add(identity);
      files.push(file);
    }
  }
  return files;
}

interface PiEntryProvenance {
  nativeEntryId: string | null;
  parentNativeEntryId: string | null;
}

function parsePiToolCall(
  state: ParseState,
  obj: Record<string, unknown>,
  timestamp: { text: string; ms: number } | null,
  provenance: PiEntryProvenance,
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
    ...provenance,
  });
}

function parsePiAssistantBlock(
  state: ParseState,
  block: unknown,
  timestamp: { text: string; ms: number } | null,
  provenance: PiEntryProvenance,
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
      ...provenance,
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
      ...provenance,
    });
    return;
  }
  if (type === "toolCall") {
    parsePiToolCall(state, obj, timestamp, provenance);
  }
  // Every other block type (and every unrecognized future one) folds to a
  // silent skip rather than throwing.
}

function parsePiToolResult(
  state: ParseState,
  message: Record<string, unknown>,
  timestamp: { text: string; ms: number } | null,
  provenance: PiEntryProvenance,
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
    ...provenance,
  });
}

function parsePiMessage(
  state: ParseState,
  message: Record<string, unknown> | null,
  timestamp: { text: string; ms: number } | null,
  provenance: PiEntryProvenance,
): boolean {
  if (message === null) {
    return false;
  }
  const role = stringOrNull(message.role);
  if (role === "user") {
    const text = contentText(message.content);
    if (text.trim().length === 0) {
      return true;
    }
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "user",
      kind: "text",
      text,
      meta: false,
      tool: null,
      ...provenance,
    });
    return true;
  }
  if (role === "assistant") {
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      parsePiAssistantBlock(state, block, timestamp, provenance);
    }
    return true;
  }
  if (role === "toolResult") {
    parsePiToolResult(state, message, timestamp, provenance);
    return true;
  }
  // bashExecution is a known non-conversation record. A future role remains in
  // unknownRecords so a later normalization version can recover it.
  return role === "bashExecution";
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
  const provenance: PiEntryProvenance = {
    nativeEntryId: stringOrNull(obj.id),
    parentNativeEntryId: stringOrNull(obj.parentId),
  };
  const type = stringOrNull(obj.type);
  if (type === "session") {
    state.metadata.project = stringOrNull(obj.cwd) ?? state.metadata.project;
    return;
  }
  if (type === "session_info") {
    // Renames append a new session_info entry; the LAST one in file order wins.
    const title = stringOrNull(obj.name);
    if (title !== null) {
      state.metadata.title = title;
      state.metadata.titleHistory.push(title);
    }
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
        ...provenance,
      });
    }
    return;
  }
  if (type === "message") {
    if (!parsePiMessage(state, recordOf(obj.message), timestamp, provenance)) {
      preserveUnknownRecord(state, obj, timestamp);
    }
    return;
  }
  if (type === "thinking_level_change") {
    return;
  }
  preserveUnknownRecord(state, obj, timestamp);
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
      parsePiLine(state, line);
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

/** Create a bounded line-at-a-time Pi normalizer retaining native id/parentId. */
export function createPiLineNormalizer(options: {
  path: string;
  sessionId: string;
  source?: TranscriptSource;
}): TranscriptLineNormalizer {
  const empty = parsePiTranscriptText("", options);
  const state: ParseState = {
    source: empty.source,
    entries: [],
    unknownRecords: [],
    toolNames: boundedToolNameMap(),
    metadata: empty.metadata,
    minTimestamp: null,
    maxTimestamp: null,
    nextSourceOrdinal: 0,
    nextRecordOrdinal: 0,
  };
  let finished = false;
  return {
    source: state.source,
    feedLine(line) {
      if (finished) throw new Error("Pi transcript normalizer is finished");
      parsePiLine(state, line);
      const entries = state.entries.splice(0);
      const unknownRecords = state.unknownRecords.splice(0);
      state.metadata.titleHistory.length = 0;
      return { entries, unknownRecords };
    },
    finish() {
      if (!finished) {
        finalizeTimestamps(state);
        backfillToolNames(state);
        finished = true;
      }
      return state.metadata;
    },
  };
}

export function readPiTitleHistory(path: string): string[] {
  const titles: string[] = [];
  scanTranscriptJsonlSync(
    path,
    (record) => {
      if (record.type !== "session_info") return;
      const title = stringOrNull(record.name);
      if (title !== null) titles.push(title);
    },
    "session_info",
  );
  return titles;
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
  metadataOnly?: boolean;
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
  const candidates = scanPiSessionFiles(options.sessionsDir, options.project)
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
    if (options.metadataOnly === true) {
      let spine: ReturnType<typeof readJsonlMetadataSpineSync> | null;
      try {
        spine = readJsonlMetadataSpineSync(file.path, file.bytes, {
          marker: "session_info",
          read: (record) =>
            record.type === "session_info" ? stringOrNull(record.name) : null,
        });
      } catch {
        spine = null;
      }
      return {
        sessionId: file.sessionId,
        path: file.path,
        project: spine?.project ?? null,
        title: spine?.title ?? null,
        titleHistory: spine?.titleHistory ?? [],
        startedAt: spine?.startedAt ?? null,
        updatedAt:
          spine?.updatedAt ?? new Date(file.modifiedMs).toISOString(),
        bytes: file.bytes,
        subagentCount: 0,
        firstPrompt: null,
      };
    }
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
        titleHistory: [],
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
      titleHistory: [...document.metadata.titleHistory],
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
      metadataOnly: query.metadataOnly,
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
  const found = scanPiSessionFiles(sessionsDir, query.project).filter(
    (file) => file.sessionId === query.sessionId,
  );
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

// --- Latest turn (branch-aware, id/parentId walk) --------------------------

/** Independent prompt/response cap for the Latest turn contract. */
export const TURN_TEXT_CAP = 8192;
/** The only stopReason that marks an assistant response as complete; every
 *  other value (toolUse, error, aborted, length, or absent) means the
 *  response the caller sees must stay null. */
const TURN_TERMINAL_STOP_REASON = "stop";

interface PiTurnEntry {
  id: string;
  parentId: string | null;
  type: string;
  raw: Record<string, unknown>;
}

function boundTurnText(text: string): { text: string; truncated: boolean } {
  return text.length <= TURN_TEXT_CAP
    ? { text, truncated: false }
    : { text: text.slice(0, TURN_TEXT_CAP), truncated: true };
}

/** Remove Pi's complete expanded skill envelopes before a consumer-specific
 *  Latest-turn cap can cut away their closing tags. The ordinary transcript
 *  contract stays byte-faithful unless the caller explicitly opts in. */
export function stripPiSkillBlocks(text: string): string {
  return text.replace(/<skill(?:\s[^>]*)?>[\s\S]*?<\/skill>/g, "");
}

/** Extract only `type: "text"` blocks (string content is returned whole);
 *  thinking, toolCall, and image blocks contribute no text — an image-only
 *  user message or a thinking-only assistant message reduces to "". */
function turnText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    const obj = recordOf(block);
    if (obj === null || stringOrNull(obj.type) !== "text") {
      continue;
    }
    const text = stringOrNull(obj.text);
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Parse every id-bearing JSONL line into its raw tree node, keyed by id.
 *  The session header carries no id and can never be a leaf or a link
 *  target; a malformed or oversized line simply produces no node (nothing
 *  can walk to or through it). */
function parsePiEntriesForTurn(text: string): Map<string, PiTurnEntry> {
  const entries = new Map<string, PiTurnEntry>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
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
    const id = stringOrNull(obj.id);
    if (id === null) {
      continue;
    }
    entries.set(id, {
      id,
      parentId: typeof obj.parentId === "string" ? obj.parentId : null,
      type: stringOrNull(obj.type) ?? "",
      raw: obj,
    });
  }
  return entries;
}

type PiTurnWalkResult =
  | { kind: "ok"; path: PiTurnEntry[] }
  | { kind: "not_found" }
  | { kind: "malformed"; message: string };

/** Walk strictly from the requested leaf to the root via parentId, never via
 *  file position — an entry physically later in the JSONL but outside this
 *  chain (an abandoned branch) can never influence the result. Bounded by
 *  `seen` so a cyclical or self-referencing parent link fails loud instead
 *  of looping. */
function walkPiPath(
  entries: ReadonlyMap<string, PiTurnEntry>,
  leafId: string,
): PiTurnWalkResult {
  const start = entries.get(leafId);
  if (start === undefined) {
    return { kind: "not_found" };
  }
  const chain: PiTurnEntry[] = [];
  const seen = new Set<string>();
  let current: PiTurnEntry | undefined = start;
  while (current !== undefined) {
    if (seen.has(current.id)) {
      return {
        kind: "malformed",
        message: `cycle detected in parent chain at entry '${current.id}'`,
      };
    }
    seen.add(current.id);
    chain.push(current);
    if (current.parentId === null) {
      break;
    }
    const parent = entries.get(current.parentId);
    if (parent === undefined) {
      return {
        kind: "malformed",
        message: `dangling parent link: entry '${current.id}' -> '${current.parentId}'`,
      };
    }
    current = parent;
  }
  chain.reverse();
  return { kind: "ok", path: chain };
}

/** Reduce a root-to-leaf path to the Latest turn: the last non-empty user
 *  text on the path, then every assistant text block that follows it, kept
 *  only when the LAST assistant message in that window terminates with a
 *  successful stop. Thinking, tool calls/results, images, custom entries,
 *  and compaction summaries never reach either field — they are simply not
 *  `type: "message"` (or not a `"text"` content block) and fall through. */
function reducePiTurn(
  path: readonly PiTurnEntry[],
  stripSkills: boolean,
): LatestTurn | null {
  let latestUserIndex = -1;
  let latestUserText = "";
  for (let i = 0; i < path.length; i++) {
    const entry = path[i] as PiTurnEntry;
    if (entry.type !== "message") {
      continue;
    }
    const message = recordOf(entry.raw.message);
    if (message === null || stringOrNull(message.role) !== "user") {
      continue;
    }
    const text = turnText(message.content).trim();
    if (text.length === 0) {
      continue;
    }
    latestUserIndex = i;
    latestUserText = text;
  }
  if (latestUserIndex === -1) {
    return null;
  }

  const responseParts: string[] = [];
  let sawAssistant = false;
  let lastStopReason: string | null = null;
  for (let i = latestUserIndex + 1; i < path.length; i++) {
    const entry = path[i] as PiTurnEntry;
    if (entry.type !== "message") {
      continue;
    }
    const message = recordOf(entry.raw.message);
    if (message === null || stringOrNull(message.role) !== "assistant") {
      continue;
    }
    sawAssistant = true;
    const text = turnText(message.content);
    if (text.length > 0) {
      responseParts.push(text);
    }
    lastStopReason = stringOrNull(message.stopReason);
  }

  const promptText = stripSkills
    ? stripPiSkillBlocks(latestUserText).trim()
    : latestUserText;
  if (promptText.length === 0) {
    return null;
  }
  const prompt = boundTurnText(promptText);
  if (!sawAssistant || lastStopReason !== TURN_TERMINAL_STOP_REASON) {
    return {
      prompt: prompt.text,
      promptTruncated: prompt.truncated,
      response: null,
      responseTruncated: false,
    };
  }
  const response = boundTurnText(responseParts.join("\n"));
  return {
    prompt: prompt.text,
    promptTruncated: prompt.truncated,
    response: response.text,
    responseTruncated: response.truncated,
  };
}

export interface PiTurnQuery {
  root: TranscriptRootInputs;
  sessionId: string;
  project: string | null;
  /** An entry id, or the literal "root" — the empty branch before any entry. */
  leaf: string;
  /** Remove complete expanded skill envelopes before bounding prompt text. */
  stripSkills?: boolean;
}

export type PiTurnOutcome =
  | { kind: "no_roots"; message: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; owners: string[]; hint: string }
  | { kind: "leaf_not_found" }
  | { kind: "leaf_malformed"; message: string }
  | { kind: "read_failed"; message: string }
  | { kind: "ok"; selectedLeaf: string; turn: LatestTurn | null };

/** Resolve the Latest turn for one pi session's requested leaf. Session
 *  resolution (no_roots/not_found/ambiguous) reuses `piFind` verbatim; only
 *  the leaf-to-root walk and turn reduction are new. */
export function resolvePiTurn(query: PiTurnQuery): PiTurnOutcome {
  const found = piFind({
    root: query.root,
    sessionId: query.sessionId,
    project: query.project,
  });
  if (found.kind !== "found") {
    return found;
  }
  if (query.leaf === "root") {
    return { kind: "ok", selectedLeaf: "root", turn: null };
  }
  let text: string;
  try {
    text = readFileSync(found.handle.path, "utf8");
  } catch (error) {
    return {
      kind: "read_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const entries = parsePiEntriesForTurn(text);
  const walked = walkPiPath(entries, query.leaf);
  if (walked.kind === "not_found") {
    return { kind: "leaf_not_found" };
  }
  if (walked.kind === "malformed") {
    return { kind: "leaf_malformed", message: walked.message };
  }
  return {
    kind: "ok",
    selectedLeaf: query.leaf,
    turn: reducePiTurn(walked.path, query.stripSkills === true),
  };
}

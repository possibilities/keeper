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
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  readJsonlMetadataSpineSync,
  scanTranscriptJsonlSync,
} from "./jsonl-scan";
import type {
  SubagentSummary,
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
  TranscriptSessionHandle,
} from "./reader";
import { ellipsizeInline } from "./text";

const METADATA_SLICE_BYTES = 128 * 1024;
const SUMMARY_PREVIEW_CHARS = 240;

export interface ClaudeRootOptions {
  homeDir?: string;
  /** Claude config directories. When present, standard discovery is skipped. */
  configDirs?: readonly string[];
}

export interface ClaudeSessionFile {
  path: string;
  sessionId: string;
  bytes: number;
  modifiedMs: number;
}

export interface ClaudeListOptions {
  roots: readonly string[];
  /** Null scans every project; a path scans only its Claude project bucket. */
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
  onBeforeInspect?: (file: ClaudeSessionFile) => void;
}

export interface ClaudeListResult {
  items: TranscriptListItem[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

export type ClaudeSessionLookup =
  | { kind: "found"; file: ClaudeSessionFile }
  | { kind: "not_found" }
  | { kind: "ambiguous"; files: ClaudeSessionFile[] };

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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

/** Resolve every readable Claude projects tree, deduplicated through symlinks.
 *  claude-swap's `--share-history` means every account reads/writes the SAME
 *  canonical `~/.claude/projects/` tree, so default discovery is just the one
 *  canonical config dir — never a `.claude-profiles` scan. */
export function discoverClaudeProjectsRoots(
  options: ClaudeRootOptions = {},
): string[] {
  const home = options.homeDir ?? homedir();
  const configDirs = options.configDirs?.length
    ? [...options.configDirs]
    : [join(home, ".claude")];

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const configDir of configDirs) {
    const projects = join(resolve(configDir), "projects");
    const real = safeRealpath(projects);
    if (real === null || seen.has(real)) {
      continue;
    }
    seen.add(real);
    roots.push(real);
  }
  return roots;
}

export function encodeClaudeProject(project: string): string {
  return resolve(project).replace(/[^A-Za-z0-9]/g, "-");
}

function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    basename(sessionId) === sessionId &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)
  );
}

function fileInfo(path: string, sessionId: string): ClaudeSessionFile | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return null;
    }
    return {
      path,
      sessionId,
      bytes: stat.size,
      modifiedMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function projectDirs(
  roots: readonly string[],
  project: string | null,
): string[] {
  if (project !== null) {
    const bucket = encodeClaudeProject(project);
    return roots.map((root) => join(root, bucket));
  }
  return roots.flatMap(safeDirectories);
}

/** Locate an exact Claude session id without recursively scanning transcript data. */
export function findClaudeSession(
  roots: readonly string[],
  sessionId: string,
  project: string | null = null,
): ClaudeSessionLookup {
  if (!isSafeSessionId(sessionId)) {
    return { kind: "not_found" };
  }
  const found: ClaudeSessionFile[] = [];
  const seen = new Set<string>();
  for (const dir of projectDirs(roots, project)) {
    const path = join(dir, `${sessionId}.jsonl`);
    const info = fileInfo(path, sessionId);
    if (info === null) {
      continue;
    }
    const real = safeRealpath(path) ?? path;
    if (!seen.has(real)) {
      seen.add(real);
      found.push(info);
    }
  }
  if (found.length === 0) {
    return { kind: "not_found" };
  }
  if (found.length > 1) {
    return {
      kind: "ambiguous",
      files: found.sort((a, b) => b.modifiedMs - a.modifiedMs),
    };
  }
  return { kind: "found", file: found[0] as ClaudeSessionFile };
}

function updateMetadata(state: ParseState, obj: Record<string, unknown>): void {
  trackTimestamp(state, parseTimestamp(obj.timestamp));
  state.metadata.project = stringOrNull(obj.cwd) ?? state.metadata.project;
  state.metadata.version = stringOrNull(obj.version) ?? state.metadata.version;
  state.metadata.gitBranch =
    stringOrNull(obj.gitBranch) ?? state.metadata.gitBranch;
  if (obj.type === "custom-title") {
    const title = stringOrNull(obj.customTitle);
    if (title !== null) {
      state.metadata.title = title;
      state.metadata.titleHistory.push(title);
    }
  }
  if (obj.type === "agent-name") {
    state.metadata.agentName =
      stringOrNull(obj.agentName) ?? state.metadata.agentName;
  }
  const message = recordOf(obj.message);
  state.metadata.model = stringOrNull(message?.model) ?? state.metadata.model;
}

function parseToolCall(
  state: ParseState,
  obj: Record<string, unknown>,
  timestamp: { text: string; ms: number } | null,
  meta: boolean,
): void {
  const useId = stringOrNull(obj.id);
  const name = stringOrNull(obj.name);
  if (useId !== null && name !== null) {
    state.toolNames.set(useId, name);
  }
  const tool: TranscriptTool = {
    name,
    useId,
    input: obj.input ?? null,
    result: null,
    isError: false,
  };
  pushEntry(state, {
    timestamp: timestamp?.text ?? null,
    timestampMs: timestamp?.ms ?? null,
    role: "tool",
    kind: "tool_call",
    text: null,
    meta,
    tool,
  });
}

function parseToolResult(
  state: ParseState,
  obj: Record<string, unknown>,
  timestamp: { text: string; ms: number } | null,
  meta: boolean,
): void {
  const useId = stringOrNull(obj.tool_use_id);
  const tool: TranscriptTool = {
    name: useId === null ? null : (state.toolNames.get(useId) ?? null),
    useId,
    input: null,
    result: obj.content ?? null,
    isError: obj.is_error === true,
  };
  pushEntry(state, {
    timestamp: timestamp?.text ?? null,
    timestampMs: timestamp?.ms ?? null,
    role: "tool",
    kind: "tool_result",
    text: null,
    meta,
    tool,
  });
}

function parseContentBlock(
  state: ParseState,
  block: unknown,
  recordType: "user" | "assistant",
  timestamp: { text: string; ms: number } | null,
  meta: boolean,
  compactSummary: boolean,
): void {
  if (typeof block === "string") {
    if (block.length === 0) return;
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: compactSummary ? "summary" : recordType,
      kind: compactSummary ? "summary" : "text",
      text: block,
      meta,
      tool: null,
    });
    return;
  }
  const obj = recordOf(block);
  if (obj === null) {
    return;
  }
  const type = stringOrNull(obj.type);
  if (type === "text") {
    parseContentBlock(
      state,
      stringOrNull(obj.text) ?? "",
      recordType,
      timestamp,
      meta,
      compactSummary,
    );
    return;
  }
  if (type === "thinking" || type === "redacted_thinking") {
    const text =
      stringOrNull(obj.thinking) ??
      stringOrNull(obj.data) ??
      (type === "redacted_thinking" ? "[redacted thinking]" : "");
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "assistant",
      kind: "thinking",
      text,
      meta,
      tool: null,
    });
    return;
  }
  if (type === "tool_use" || type === "server_tool_use") {
    parseToolCall(state, obj, timestamp, meta);
    return;
  }
  if (type === "tool_result" || type === "web_search_tool_result") {
    parseToolResult(state, obj, timestamp, meta);
    return;
  }
  if (type === "image") {
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: recordType,
      kind: "image",
      text: "[image]",
      meta,
      tool: null,
    });
  }
}

function parseLine(state: ParseState, line: string): void {
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
  updateMetadata(state, obj);
  const type = stringOrNull(obj.type);
  const timestamp = parseTimestamp(obj.timestamp);
  if (type === "user" || type === "assistant") {
    const message = recordOf(obj.message);
    const content = message?.content;
    const blocks = Array.isArray(content) ? content : [content];
    const meta = obj.isMeta === true;
    const compactSummary = obj.isCompactSummary === true;
    for (const block of blocks) {
      parseContentBlock(state, block, type, timestamp, meta, compactSummary);
    }
    return;
  }
  if (type === "summary") {
    const text = contentText(obj.summary ?? obj.content);
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
  if (type === "system") {
    const subtype = stringOrNull(obj.subtype) ?? "system";
    const text =
      contentText(obj.content ?? obj.message) ||
      `[${subtype.replaceAll("_", " ")}]`;
    pushEntry(state, {
      timestamp: timestamp?.text ?? null,
      timestampMs: timestamp?.ms ?? null,
      role: "system",
      kind: "system",
      text,
      meta: true,
      tool: null,
    });
    return;
  }
  if (type === "custom-title" || type === "agent-name") {
    return;
  }
  preserveUnknownRecord(state, obj, timestamp);
}

/** Parse one Claude JSONL transcript into the harness-neutral model. */
export function parseClaudeTranscriptText(
  text: string,
  options: {
    path: string;
    sessionId: string;
    source?: TranscriptSource;
  },
): TranscriptDocument {
  const metadata: TranscriptMetadata = {
    sessionId: options.sessionId,
    harness: "claude",
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
      parseLine(state, line);
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

/** Create a bounded line-at-a-time Claude normalizer. Draining a batch never
 * resets source ordinals; metadata and tool-name state remain file-scoped. */
export function createClaudeLineNormalizer(options: {
  path: string;
  sessionId: string;
  source?: TranscriptSource;
}): TranscriptLineNormalizer {
  const empty = parseClaudeTranscriptText("", options);
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
      if (finished) throw new Error("Claude transcript normalizer is finished");
      parseLine(state, line);
      const entries = state.entries.splice(0);
      const unknownRecords = state.unknownRecords.splice(0);
      // The index stores catalog titles separately; retain only current title in
      // this streaming state so a rename-heavy file cannot grow rebuild memory.
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

export interface ClaudeNamingSection {
  role: "user" | "assistant" | "summary";
  text: string;
}

interface ClaudeNamingNode {
  id: string;
  parentId: string | null;
  section: ClaudeNamingSection | null;
}

function namingText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      text.push(block);
      continue;
    }
    const object = recordOf(block);
    if (object?.type === "text" && typeof object.text === "string") {
      text.push(object.text);
    }
  }
  return text.join("\n");
}

/**
 * Project the active Claude branch at an exact byte cutoff into only the
 * authored text useful for deriving a Session title. A cutoff in the middle
 * of a JSONL record excludes that record; an exact EOF may include a final
 * record without a newline.
 */
export function projectClaudeNamingSections(
  transcript: string | Uint8Array,
  cutoffBytes: number,
): ClaudeNamingSection[] {
  const source =
    typeof transcript === "string"
      ? Buffer.from(transcript, "utf8")
      : transcript;
  const cutoff = Math.max(
    0,
    Math.min(source.byteLength, Math.floor(cutoffBytes)),
  );
  let prefix = source.subarray(0, cutoff);
  if (cutoff < source.byteLength && prefix.at(-1) !== 0x0a) {
    const lastLf = prefix.lastIndexOf(0x0a);
    prefix =
      lastLf < 0 ? prefix.subarray(0, 0) : prefix.subarray(0, lastLf + 1);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  } catch {
    return [];
  }

  const nodes = new Map<string, ClaudeNamingNode>();
  const order: string[] = [];
  let explicitLeaf: string | null = null;
  let fallbackLeaf: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || !withinTranscriptLineByteCap(line)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const object = recordOf(raw);
    if (object === null) continue;
    const selectedLeaf = stringOrNull(object.leafUuid);
    if (selectedLeaf !== null) explicitLeaf = selectedLeaf;

    const id = stringOrNull(object.uuid);
    if (id === null || nodes.has(id)) continue;
    const parentId =
      object.parentUuid === null ? null : stringOrNull(object.parentUuid);
    const type = stringOrNull(object.type);
    if (type === "user" || type === "assistant") fallbackLeaf = id;
    let section: ClaudeNamingSection | null = null;
    if ((type === "user" || type === "assistant") && object.isMeta !== true) {
      const message = recordOf(object.message);
      const value = namingText(message?.content);
      if (value.length > 0) {
        section =
          object.isCompactSummary === true
            ? { role: "summary", text: value }
            : { role: type, text: value };
      }
    }
    nodes.set(id, { id, parentId, section });
    order.push(id);
  }

  const leaf =
    explicitLeaf !== null && nodes.has(explicitLeaf)
      ? explicitLeaf
      : fallbackLeaf;
  if (leaf === null) return [];

  const active = new Set<string>();
  let cursor: string | null = leaf;
  while (cursor !== null && !active.has(cursor)) {
    active.add(cursor);
    cursor = nodes.get(cursor)?.parentId ?? null;
  }
  return order.flatMap((id) => {
    const section = active.has(id) ? nodes.get(id)?.section : null;
    return section === null || section === undefined ? [] : [section];
  });
}

export function readClaudeTitleHistory(path: string): string[] {
  const titles: string[] = [];
  scanTranscriptJsonlSync(
    path,
    (record) => {
      if (record.type !== "custom-title") return;
      const title = stringOrNull(record.customTitle);
      if (title !== null) titles.push(title);
    },
    "custom-title",
  );
  return titles;
}

export function readClaudeTranscript(
  path: string,
  sessionId: string,
  source: TranscriptSource = "main",
): TranscriptDocument {
  return parseClaudeTranscriptText(readFileSync(path, "utf8"), {
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

function inspectClaudeFile(file: ClaudeSessionFile): TranscriptDocument {
  return parseClaudeTranscriptText(metadataSample(file.path, file.bytes), {
    path: file.path,
    sessionId: file.sessionId,
  });
}

const SLASH_COMMAND_WRAPPER_TAGS = [
  "command-name",
  "command-message",
  "local-command-stdout",
] as const;

/** Strip slash-command XML scaffolding, unwrapping command-args content. */
function stripSlashCommandWrappers(text: string): string {
  let result = text;
  for (const tag of SLASH_COMMAND_WRAPPER_TAGS) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  return result.replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1");
}

function firstHumanPrompt(document: TranscriptDocument): string | null {
  for (const candidate of document.entries) {
    if (
      candidate.role !== "user" ||
      candidate.kind !== "text" ||
      candidate.meta ||
      candidate.text === null
    ) {
      continue;
    }
    const stripped = stripSlashCommandWrappers(candidate.text).trim();
    if (stripped.length === 0) {
      continue;
    }
    return ellipsizeInline(stripped, SUMMARY_PREVIEW_CHARS);
  }
  return null;
}

function countSubagents(mainPath: string): number {
  try {
    return readdirSync(join(mainPath.slice(0, -".jsonl".length), "subagents"), {
      withFileTypes: true,
    }).filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("agent-") &&
        entry.name.endsWith(".jsonl"),
    ).length;
  } catch {
    return 0;
  }
}

function scanSessionFiles(
  roots: readonly string[],
  project: string | null,
): ClaudeSessionFile[] {
  const files: ClaudeSessionFile[] = [];
  const seen = new Set<string>();
  for (const dir of projectDirs(roots, project)) {
    let entries: Array<{
      name: string;
      isFile(): boolean;
    }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (!isSafeSessionId(sessionId)) {
        continue;
      }
      const path = join(dir, entry.name);
      const real = safeRealpath(path) ?? path;
      if (seen.has(real)) {
        continue;
      }
      const info = fileInfo(path, sessionId);
      if (info !== null) {
        seen.add(real);
        files.push(info);
      }
    }
  }
  return files;
}

/** List sessions by update time while parsing only the requested result page. */
export function listClaudeSessions(
  options: ClaudeListOptions,
): ClaudeListResult {
  const candidates = scanSessionFiles(options.roots, options.project)
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
          marker: "custom-title",
          read: (record) =>
            record.type === "custom-title"
              ? stringOrNull(record.customTitle)
              : null,
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
        updatedAt: spine?.updatedAt ?? new Date(file.modifiedMs).toISOString(),
        bytes: file.bytes,
        subagentCount: 0,
        firstPrompt: null,
      };
    }
    // Read-and-catch, never existsSync-then-read: the transcript tree
    // mutates live under the reader (TOCTOU). A file that vanished between
    // scan and parse degrades this one row instead of failing the page.
    let document: TranscriptDocument | null;
    try {
      document = inspectClaudeFile(file);
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
        subagentCount: countSubagents(file.path),
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
      subagentCount: countSubagents(file.path),
      firstPrompt: firstHumanPrompt(document),
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

function subagentDirectory(mainPath: string): string {
  return join(mainPath.slice(0, -".jsonl".length), "subagents");
}

function normalizeSubagentId(filename: string): string {
  return filename.slice("agent-".length, -".jsonl".length);
}

export function listClaudeSubagents(mainPath: string): SubagentSummary[] {
  const dir = subagentDirectory(mainPath);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name): SubagentSummary[] => {
    const path = join(dir, name);
    const id = normalizeSubagentId(name);
    const info = fileInfo(path, id);
    if (info === null) {
      return [];
    }
    const document = inspectClaudeFile(info);
    return [
      {
        id,
        path,
        bytes: info.bytes,
        startedAt: document.metadata.startedAt,
        updatedAt:
          document.metadata.updatedAt ??
          new Date(info.modifiedMs).toISOString(),
        task: firstHumanPrompt(document),
      },
    ];
  });
}

function resolveSubagent(
  subagents: readonly SubagentSummary[],
  requested: string,
): SubagentSummary | null {
  const normalized = requested.replace(/^agent-/, "").replace(/\.jsonl$/, "");
  const exact = subagents.find((subagent) => subagent.id === normalized);
  if (exact !== undefined) {
    return exact;
  }
  const prefixes = subagents.filter((subagent) =>
    subagent.id.startsWith(normalized),
  );
  return prefixes.length === 1 ? (prefixes[0] ?? null) : null;
}

function assembleEntries(
  documents: readonly TranscriptDocument[],
): TranscriptEntry[] {
  const entries = documents.flatMap((document) => document.entries);
  if (documents.length > 1) {
    entries.sort(
      (a, b) =>
        (a.timestampMs ?? Number.MAX_SAFE_INTEGER) -
          (b.timestampMs ?? Number.MAX_SAFE_INTEGER) ||
        a.source.localeCompare(b.source) ||
        a.sourceOrdinal - b.sourceOrdinal,
    );
  }
  return entries.map((entry, ordinal) => ({ ...entry, ordinal }));
}

/** Load the main transcript, one subagent, or an interleaved all-source view. */
export function loadClaudeSession(
  mainPath: string,
  sessionId: string,
  selected: "main" | "all" | string = "main",
): TranscriptSession | { error: string } {
  if (!existsSync(mainPath)) {
    return { error: `transcript disappeared: ${mainPath}` };
  }
  const main = readClaudeTranscript(mainPath, sessionId);
  const subagents = listClaudeSubagents(mainPath);
  if (selected === "main") {
    return {
      main,
      entries: assembleEntries([main]),
      selectedSource: "main",
      subagents,
    };
  }
  if (selected === "all") {
    const documents = [
      main,
      ...subagents.map((subagent) =>
        readClaudeTranscript(
          subagent.path,
          sessionId,
          `subagent:${subagent.id}`,
        ),
      ),
    ];
    return {
      main,
      entries: assembleEntries(documents),
      selectedSource: "all",
      subagents,
    };
  }
  const subagent = resolveSubagent(subagents, selected);
  if (subagent === null) {
    return {
      error: `subagent '${selected}' not found or ambiguous; available: ${
        subagents.map((item) => item.id).join(", ") || "none"
      }`,
    };
  }
  const document = readClaudeTranscript(
    subagent.path,
    sessionId,
    `subagent:${subagent.id}`,
  );
  return {
    main,
    entries: assembleEntries([document]),
    selectedSource: `subagent:${subagent.id}`,
    subagents,
  };
}

/** Useful when an ambiguity needs to tell the caller which project owns a file. */
export function transcriptHoldingDirectory(path: string): string {
  return dirname(path);
}

const NO_ROOTS_MESSAGE = "no readable Claude projects directories found";

function claudeList(query: TranscriptListQuery): TranscriptListOutcome {
  const roots = discoverClaudeProjectsRoots({
    homeDir: query.root.homeDir,
    configDirs: query.root.configDirs,
  });
  if (roots.length === 0) {
    return { kind: "no_roots", message: NO_ROOTS_MESSAGE };
  }
  try {
    const result = listClaudeSessions({
      roots,
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
      recovery: "check the Claude transcript directories and retry",
    };
  }
}

function claudeFind(query: TranscriptFindQuery): TranscriptFindOutcome {
  const roots = discoverClaudeProjectsRoots({
    homeDir: query.root.homeDir,
    configDirs: query.root.configDirs,
  });
  if (roots.length === 0) {
    return { kind: "no_roots", message: NO_ROOTS_MESSAGE };
  }
  const lookup = findClaudeSession(roots, query.sessionId, query.project);
  if (lookup.kind === "not_found") {
    return { kind: "not_found" };
  }
  if (lookup.kind === "ambiguous") {
    const owners = lookup.files.map((file) =>
      transcriptHoldingDirectory(file.path),
    );
    // Bucket dirs live directly under a config root's "projects" dir; the
    // config root disambiguates when duplicates span DIFFERENT roots
    // (--project alone can't tell those apart), otherwise --project (which
    // maps to a bucket within one root) is still the right hint.
    const configRoots = new Set(owners.map((owner) => dirname(owner)));
    const hint = configRoots.size > 1 ? "--config-dir" : "--project";
    return { kind: "ambiguous", owners, hint };
  }
  return {
    kind: "found",
    handle: { sessionId: lookup.file.sessionId, path: lookup.file.path },
  };
}

function claudeLoad(
  handle: TranscriptSessionHandle,
  subagent: string,
): TranscriptSession | { error: string } {
  return loadClaudeSession(handle.path, handle.sessionId, subagent);
}

export const claudeTranscriptReader: TranscriptReader = {
  harness: "claude",
  supportsSubagents: true,
  list: claudeList,
  find: claudeFind,
  load: claudeLoad,
};

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { encodePiCwd } from "../transcript/pi";

export const CLAUDE_TO_PI_MAPPING_VERSION = 1;
export const CLAUDE_TO_PI_MANIFEST_SCHEMA_VERSION = 1;
export const CLAUDE_TO_PI_READ_CHUNK_BYTES = 64 * 1024;
export const CLAUDE_TO_PI_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CLAUDE_TO_PI_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const CLAUDE_TO_PI_MAX_FAMILY_BYTES = 256 * 1024 * 1024;
export const CLAUDE_TO_PI_MAX_STREAMS = 4096;
export const CLAUDE_TO_PI_MAX_SUBAGENT_DEPTH = 64;
const RAW_SHADOW_CUSTOM_TYPE = "keeper.conversation.claude-record";
const METADATA_ROOT_CUSTOM_TYPE = "keeper.conversation.metadata";
const ACTIVE_LEAF_CUSTOM_TYPE = "keeper.conversation.active-leaf";
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

type JsonObject = Record<string, unknown>;

export type WarningCode =
  | "ambiguous_subagent_relation"
  | "assistant_api_error_raw_only"
  | "assistant_missing_model"
  | "assistant_response_id_inconsistent"
  | "compaction_untrusted"
  | "duplicate_uuid"
  | "malformed_line"
  | "malformed_parent_cycle"
  | "subagent_relation_cycle"
  | "tool_result_missing_call"
  | "tool_result_missing_name"
  | "tool_result_without_ancestral_call"
  | "unknown_assistant_block"
  | "unknown_record_type"
  | "unmatched_subagent"
  | "unresolved_parent";

export type ConversationConversionErrorCode =
  | "invalid_argument"
  | "publish_collision"
  | "publish_failed"
  | "source_changed_during_read"
  | "source_decode_failed"
  | "source_missing_final_lf"
  | "source_not_regular"
  | "source_read_failed"
  | "source_too_large"
  | "validation_failed";

export class ConversationConversionError extends Error {
  readonly code: ConversationConversionErrorCode;
  readonly path: string | null;

  constructor(
    code: ConversationConversionErrorCode,
    message: string,
    options: { path?: string | null } = {},
  ) {
    super(message);
    this.name = "ConversationConversionError";
    this.code = code;
    this.path = options.path ?? null;
  }
}

export interface ClaudeToPiSourceReadEvent {
  readonly path: string;
  readonly streamKey: string;
  readonly digest: string;
  readonly lineCount: number;
  readonly byteLength: number;
}

export interface ClaudeToPiPrepareOptions {
  readonly claudeMainPath: string;
  readonly piAgentDir: string;
  /** Native id supplied by shared Session resolution. When present it is
   * authoritative and every source record carrying a sessionId must agree. */
  readonly expectedSourceMainId?: string;
  readonly onAfterSourceRead?: (event: ClaudeToPiSourceReadEvent) => void;
}

export interface ClaudeToPiPublishFsyncEvent {
  readonly kind: "directory" | "file";
  readonly path: string;
}

export interface ClaudeToPiPublishedArtifactEvent {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: "manifest" | "session";
  readonly sequence: number;
}

export interface ClaudeToPiPublishDeps {
  readonly chmodSync?: (path: string, mode: number) => void;
  readonly fchmodSync?: (fd: number, mode: number) => void;
  readonly fsyncSync?: (fd: number, event: ClaudeToPiPublishFsyncEvent) => void;
  readonly onAfterArtifactCreated?: (
    event: ClaudeToPiPublishedArtifactEvent,
  ) => void;
}

export interface ClaudeToPiPublishOptions {
  readonly dryRun?: boolean;
  readonly publishDeps?: ClaudeToPiPublishDeps;
}

export interface ClaudeToPiSourceFileSnapshot {
  readonly path: string;
  readonly streamKey: string;
  readonly identity: FileIdentity;
  readonly byteLength: number;
}

export interface ClaudeToPiSourceFamilySnapshot {
  readonly mainPath: string;
  readonly files: readonly ClaudeToPiSourceFileSnapshot[];
}

export interface ClaudeToPiFamilyBounds {
  readonly streamCount: number;
  readonly maxSubagentDepth: number;
  readonly totalBytes: number;
}

export function validateClaudeToPiFamilyBounds(
  bounds: ClaudeToPiFamilyBounds,
  limits: {
    readonly maxStreams?: number;
    readonly maxSubagentDepth?: number;
    readonly maxFamilyBytes?: number;
  } = {},
): void {
  if (bounds.streamCount > (limits.maxStreams ?? CLAUDE_TO_PI_MAX_STREAMS)) {
    throw new ConversationConversionError(
      "source_too_large",
      "source family exceeds supported stream count",
    );
  }
  if (
    bounds.maxSubagentDepth >
    (limits.maxSubagentDepth ?? CLAUDE_TO_PI_MAX_SUBAGENT_DEPTH)
  ) {
    throw new ConversationConversionError(
      "source_too_large",
      "subagent tree exceeds supported depth",
    );
  }
  if (
    bounds.totalBytes > (limits.maxFamilyBytes ?? CLAUDE_TO_PI_MAX_FAMILY_BYTES)
  ) {
    throw new ConversationConversionError(
      "source_too_large",
      "source family exceeds supported aggregate size",
    );
  }
}

export interface ClaudeToPiConvertOptions
  extends ClaudeToPiPrepareOptions,
    ClaudeToPiPublishOptions {}

export interface ClaudeToPiSessionParentRelation {
  readonly parentSourceKey: string;
  readonly parentPiSessionId: string;
  readonly toolCallId: string;
}

export interface ClaudeToPiManifestStream {
  readonly sourceKey: string;
  readonly agentId: string | null;
  readonly parentRelation: ClaudeToPiSessionParentRelation | null;
  readonly digest: string;
  readonly lineCount: number;
  readonly entryCount: number;
  readonly warningCodes: readonly WarningCode[];
  readonly destinationPath: string;
}

export interface ClaudeToPiManifest {
  readonly schemaVersion: number;
  readonly mappingVersion: number;
  readonly sourceMainId: string;
  readonly sourceMainPath: string;
  readonly sourceMainDigest: string;
  readonly rootPiSessionId: string;
  readonly manifestPath: string;
  readonly streams: readonly ClaudeToPiManifestStream[];
  readonly warningCodes: readonly WarningCode[];
}

export interface PreparedClaudeToPiSession {
  readonly sourceKey: string;
  readonly agentId: string | null;
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly sourceLineCount: number;
  readonly piSessionId: string;
  readonly cwd: string;
  readonly sessionTimestamp: string;
  readonly destinationPath: string;
  readonly entryCount: number;
  readonly warningCodes: readonly WarningCode[];
  readonly parentRelation: ClaudeToPiSessionParentRelation | null;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface PreparedClaudeToPiConversion {
  readonly mappingVersion: number;
  readonly piAgentDir: string;
  readonly sourceMainPath: string;
  readonly sourceMainId: string;
  readonly sourceMainDigest: string;
  readonly rootPiSessionId: string;
  readonly manifest: ClaudeToPiManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestText: string;
  readonly sessions: readonly PreparedClaudeToPiSession[];
  readonly sourceSnapshot: ClaudeToPiSourceFamilySnapshot;
}

export interface PublishedClaudeToPiArtifact {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly status: "created" | "unchanged" | "dry_run";
}

export interface PublishedClaudeToPiConversion {
  readonly dryRun: boolean;
  readonly sessions: readonly PublishedClaudeToPiArtifact[];
  readonly manifest: PublishedClaudeToPiArtifact;
}

export interface ConvertedClaudeToPiConversation {
  readonly prepared: PreparedClaudeToPiConversion;
  readonly published: PublishedClaudeToPiConversion;
}

export interface FileIdentity {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: bigint | number;
  readonly mtimeMs: bigint | number;
  readonly ctimeMs: bigint | number;
}

interface SourceLine {
  readonly ordinal: number;
  readonly rawUtf8: string;
  readonly lineDigest: string;
  readonly parsed: JsonObject | null;
  readonly timestamp: string | null;
  readonly type: string | null;
  readonly uuid: string | null;
  readonly parentUuid: string | null;
}

interface SourceStream {
  readonly streamKey: string;
  readonly path: string;
  readonly identity: FileIdentity;
  readonly byteLength: number;
  readonly relativeSourcePath: string;
  readonly agentId: string | null;
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly digest: string;
  readonly lines: readonly SourceLine[];
}

interface ChildLaunchRelation {
  readonly childAgentId: string;
  readonly parentSourceKey: string;
  readonly toolCallId: string;
  readonly timestampMs: number | null;
  readonly ordinal: number;
}

interface StreamRelation {
  readonly parentSourceKey: string;
  readonly toolCallId: string;
}

interface AssistantGroup {
  readonly headOrdinal: number;
  readonly memberOrdinals: readonly number[];
  readonly requestId: string;
  readonly entryId: string | null;
}

interface DraftEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly body: JsonObject;
  readonly sourceOrdinal: number;
  readonly localOrdinal: number;
}

interface LinePlan {
  readonly anchorId: string;
  readonly terminalId: string;
  readonly entries: readonly DraftEntry[];
}

interface ValidateSessionResult {
  readonly warningCodes: readonly WarningCode[];
}

interface PiUsageCost extends JsonObject {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

interface PiUsage extends JsonObject {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: PiUsageCost;
}

type PiStopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

interface CompactBoundaryInfo {
  readonly logicalParentUuid: string | null;
  readonly preTokens: number | null;
  readonly headUuid: string | null;
}

interface SessionTextValidationExpectations {
  readonly id?: string;
  readonly timestamp?: string;
  readonly cwd?: string;
}

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function requiredTimestampMs(value: string | null, context: string): number {
  const ms = timestampMs(value);
  if (ms === null) {
    throw new ConversationConversionError(
      "validation_failed",
      `${context} is missing a valid timestamp`,
    );
  }
  return ms;
}

function lastNonEmptyString<T>(
  items: readonly T[],
  pick: (item: T) => string | null,
): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const value = pick(items[i] as T);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

function zeroUsageCost(): PiUsageCost {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: zeroUsageCost(),
  };
}

function compactBoundaryInfo(line: SourceLine): CompactBoundaryInfo | null {
  if (line.parsed === null || line.type !== "system") return null;
  if (asString(line.parsed.subtype) !== "compact_boundary") return null;
  const compactMetadata = asRecord(line.parsed.compactMetadata);
  const preservedSegment =
    asRecord(compactMetadata?.preservedSegment) ??
    asRecord(line.parsed.preservedSegment);
  return {
    logicalParentUuid: asString(line.parsed.logicalParentUuid),
    preTokens: asFiniteNumber(compactMetadata?.preTokens),
    headUuid: asString(preservedSegment?.headUuid),
  };
}

function effectiveParentUuid(line: SourceLine): string | null {
  return compactBoundaryInfo(line)?.logicalParentUuid ?? line.parentUuid;
}

function summaryTextFromContent(content: unknown): string | null {
  const blocks = Array.isArray(content)
    ? content
    : content === undefined
      ? []
      : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      if (block.length > 0) parts.push(block);
      continue;
    }
    const obj = asRecord(block);
    if (asString(obj?.type) !== "text") continue;
    const text = typeof obj?.text === "string" ? obj.text : "";
    if (text.length > 0) parts.push(text);
  }
  if (parts.length === 0) return null;
  const summary = parts.join("\n");
  return summary.trim().length > 0 ? summary : null;
}

function resolveEarlierUuidOrdinal(
  occ: ReadonlyMap<string, readonly number[]>,
  uuid: string | null,
  beforeOrdinal: number,
): number | null {
  if (uuid === null) return null;
  const candidates = occ.get(uuid);
  if (candidates === undefined) return null;
  let bestPrior: number | null = null;
  for (const candidate of candidates) {
    if (candidate < beforeOrdinal) bestPrior = candidate;
  }
  return bestPrior;
}

function isOrdinalAncestor(
  ancestorOrdinal: number,
  descendantOrdinal: number,
  parents: readonly (number | null)[],
): boolean {
  const seen = new Set<number>();
  let cursor: number | null = descendantOrdinal;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorOrdinal) return true;
    seen.add(cursor);
    cursor = parents[cursor] ?? null;
  }
  return false;
}

function shaHex(
  value: Uint8Array | string,
  algorithm: "sha1" | "sha256",
): string {
  return createHash(algorithm).update(value).digest("hex");
}

function sessionUuidFor(sourceSessionId: string, streamKey: string): string {
  const hex = shaHex(
    `keeper:claude-to-pi:${CLAUDE_TO_PI_MAPPING_VERSION}:${sourceSessionId}:${streamKey}`,
    "sha1",
  ).slice(0, 32);
  const chars = hex.split("");
  chars[12] = "5";
  const variant = parseInt(chars[16] ?? "0", 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const cooked = chars.join("");
  return `${cooked.slice(0, 8)}-${cooked.slice(8, 12)}-${cooked.slice(12, 16)}-${cooked.slice(16, 20)}-${cooked.slice(20, 32)}`;
}

function createEntryIdAllocator(
  sessionId: string,
): (parts: readonly string[]) => string {
  const seen = new Set<string>();
  return (parts) => {
    let retry = 0;
    for (;;) {
      const id = shaHex(
        `keeper:claude-to-pi:entry:${sessionId}:${parts.join("\u0000")}:${retry}`,
        "sha256",
      ).slice(0, 8);
      if (!seen.has(id)) {
        seen.add(id);
        return id;
      }
      retry += 1;
    }
  };
}

function stableSortedWarnings(set: ReadonlySet<WarningCode>): WarningCode[] {
  return [...set].sort();
}

function fileIdentityOf(stat: ReturnType<typeof fstatSync>): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function readStrictJsonlFile(
  path: string,
  streamKey: string,
  onAfterSourceRead?: (event: ClaudeToPiSourceReadEvent) => void,
  maxRetainedBytes = CLAUDE_TO_PI_MAX_FILE_BYTES,
  expectedSessionId?: string,
): SourceStream {
  let fd: number | null = null;
  try {
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") {
      const lexical = lstatSync(path);
      if (!lexical.isFile() || lexical.isSymbolicLink()) {
        throw new ConversationConversionError(
          "source_not_regular",
          "source path must be a regular file",
          { path },
        );
      }
    }
    const openFlags =
      FS_CONSTANTS.O_RDONLY |
      FS_CONSTANTS.O_NONBLOCK |
      (typeof FS_CONSTANTS.O_NOFOLLOW === "number"
        ? FS_CONSTANTS.O_NOFOLLOW
        : 0);
    fd = openSync(path, openFlags);
    const beforeStat = fstatSync(fd);
    if (!beforeStat.isFile()) {
      throw new ConversationConversionError(
        "source_not_regular",
        "source path must be a regular file",
        { path },
      );
    }
    if (
      beforeStat.size > CLAUDE_TO_PI_MAX_FILE_BYTES ||
      beforeStat.size > maxRetainedBytes
    ) {
      throw new ConversationConversionError(
        "source_too_large",
        "source file exceeds supported size",
        { path },
      );
    }
    const before = fileIdentityOf(beforeStat);
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    });
    const chunk = Buffer.allocUnsafe(CLAUDE_TO_PI_READ_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    const lines: SourceLine[] = [];
    let totalBytes = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const current = chunk.subarray(0, count);
      hash.update(current);
      totalBytes += current.length;
      if (
        totalBytes > Number.MAX_SAFE_INTEGER ||
        totalBytes > CLAUDE_TO_PI_MAX_FILE_BYTES ||
        totalBytes > maxRetainedBytes
      ) {
        throw new ConversationConversionError(
          "source_too_large",
          "source file exceeds supported size",
          { path },
        );
      }
      let cursor = 0;
      while (cursor < current.length) {
        const newline = current.indexOf(10, cursor);
        if (newline < 0) {
          const tail = current.subarray(cursor);
          pending =
            pending.length === 0
              ? Buffer.from(tail)
              : Buffer.concat([pending, tail]);
          if (pending.length > CLAUDE_TO_PI_MAX_LINE_BYTES) {
            throw new ConversationConversionError(
              "source_too_large",
              "source line exceeds supported size",
              { path },
            );
          }
          break;
        }
        const segment = current.subarray(cursor, newline);
        const lineBytes =
          pending.length === 0 ? segment : Buffer.concat([pending, segment]);
        pending = Buffer.alloc(0);
        if (lineBytes.length > CLAUDE_TO_PI_MAX_LINE_BYTES) {
          throw new ConversationConversionError(
            "source_too_large",
            "source line exceeds supported size",
            { path },
          );
        }
        let rawUtf8: string;
        try {
          rawUtf8 = decoder.decode(lineBytes);
        } catch {
          throw new ConversationConversionError(
            "source_decode_failed",
            "source transcript contains invalid utf-8",
            { path },
          );
        }
        let parsed: JsonObject | null = null;
        const parseUtf8 =
          lines.length === 0 && rawUtf8.startsWith("\uFEFF")
            ? rawUtf8.slice(1)
            : rawUtf8;
        try {
          parsed = asRecord(JSON.parse(parseUtf8));
        } catch {
          parsed = null;
        }
        const timestamp = toIsoTimestamp(parsed?.timestamp);
        lines.push({
          ordinal: lines.length,
          rawUtf8,
          lineDigest: shaHex(lineBytes, "sha256"),
          parsed,
          timestamp,
          type: asString(parsed?.type),
          uuid: asString(parsed?.uuid),
          parentUuid: asString(parsed?.parentUuid),
        });
        cursor = newline + 1;
      }
    }
    if (pending.length > 0) {
      throw new ConversationConversionError(
        "source_missing_final_lf",
        "source transcript must end with lf",
        { path },
      );
    }
    const digest = hash.digest("hex");
    const event: ClaudeToPiSourceReadEvent = {
      path,
      streamKey,
      digest,
      lineCount: lines.length,
      byteLength: totalBytes,
    };
    onAfterSourceRead?.(event);
    const after = fileIdentityOf(fstatSync(fd));
    if (!sameIdentity(before, after)) {
      throw new ConversationConversionError(
        "source_changed_during_read",
        "source transcript changed during read",
        { path },
      );
    }
    const cwd = lastNonEmptyString(lines, (line) => asString(line.parsed?.cwd));
    if (
      expectedSessionId !== undefined &&
      lines.some((line) => {
        const recordSessionId = asString(line.parsed?.sessionId);
        return (
          recordSessionId !== null && recordSessionId !== expectedSessionId
        );
      })
    ) {
      throw new ConversationConversionError(
        "validation_failed",
        "source transcript session id does not match the resolved Session",
        { path },
      );
    }
    const sessionId =
      expectedSessionId ??
      firstNonEmptyString(lines, (line) => asString(line.parsed?.sessionId)) ??
      basename(path, ".jsonl");
    return {
      streamKey,
      path,
      identity: before,
      byteLength: totalBytes,
      relativeSourcePath: streamKey,
      agentId:
        streamKey === "main"
          ? null
          : basename(streamKey, ".jsonl").slice("agent-".length) || null,
      sessionId,
      cwd,
      digest,
      lines,
    };
  } catch (error) {
    if (error instanceof ConversationConversionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ConversationConversionError(
        "source_not_regular",
        "source path must be a regular file",
        { path },
      );
    }
    throw new ConversationConversionError(
      "source_read_failed",
      error instanceof Error ? error.message : "source read failed",
      { path },
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function firstNonEmptyString<T>(
  items: readonly T[],
  pick: (item: T) => string | null,
): string | null {
  for (const item of items) {
    const value = pick(item);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

interface DiscoveredSubagentFile {
  readonly streamKey: string;
  readonly path: string;
  readonly byteLength: number;
  readonly depth: number;
}

function discoverSubagentFiles(mainPath: string): DiscoveredSubagentFile[] {
  const base = resolve(mainPath.slice(0, -".jsonl".length), "subagents");
  const discovered: DiscoveredSubagentFile[] = [];
  const walk = (dir: string, depth: number, isRoot: boolean): void => {
    if (depth > CLAUDE_TO_PI_MAX_SUBAGENT_DEPTH) {
      throw new ConversationConversionError(
        "source_too_large",
        "subagent tree exceeds supported depth",
        { path: dir },
      );
    }
    let entries: Array<import("node:fs").Dirent<string>>;
    try {
      const lexicalDir = lstatSync(dir);
      if (lexicalDir.isSymbolicLink()) {
        throw new ConversationConversionError(
          "source_read_failed",
          "subagent directory must not be a symbolic link",
          { path: dir },
        );
      }
      if (!lexicalDir.isDirectory()) {
        if (isRoot) return;
        throw new ConversationConversionError(
          "source_read_failed",
          "nested subagent path is not a directory",
          { path: dir },
        );
      }
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if (error instanceof ConversationConversionError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (isRoot && (code === "ENOENT" || code === "ENOTDIR")) return;
      throw new ConversationConversionError(
        "source_read_failed",
        error instanceof Error ? error.message : "subagent discovery failed",
        { path: dir },
      );
    }
    for (const entry of entries
      .slice()
      .sort((a, b) => compareCodeUnits(a.name, b.name))) {
      const full = join(dir, entry.name);
      let lexical: ReturnType<typeof lstatSync>;
      try {
        lexical = lstatSync(full);
      } catch (error) {
        throw new ConversationConversionError(
          "source_read_failed",
          error instanceof Error ? error.message : "subagent discovery failed",
          { path: full },
        );
      }
      if (lexical.isSymbolicLink()) continue;
      if (lexical.isDirectory()) {
        walk(full, depth + 1, false);
        continue;
      }
      if (
        !lexical.isFile() ||
        !entry.name.startsWith("agent-") ||
        !entry.name.endsWith(".jsonl")
      ) {
        continue;
      }
      const rel = relative(base, full).split("\\").join("/");
      discovered.push({
        streamKey: rel,
        path: full,
        byteLength: lexical.size,
        depth,
      });
      validateClaudeToPiFamilyBounds({
        streamCount: discovered.length + 1,
        maxSubagentDepth: depth,
        totalBytes: 0,
      });
    }
  };
  walk(base, 0, true);
  discovered.sort((a, b) => compareCodeUnits(a.streamKey, b.streamKey));
  return discovered;
}

function collectChildLaunches(stream: SourceStream): ChildLaunchRelation[] {
  const launches: ChildLaunchRelation[] = [];
  for (const line of stream.lines) {
    const parsed = line.parsed;
    if (parsed === null || asString(parsed.type) !== "user") continue;
    const toolUseResult = asRecord(parsed.toolUseResult);
    const childAgentId = asString(toolUseResult?.agentId);
    if (childAgentId === null) continue;
    const message = asRecord(parsed.message);
    const content = Array.isArray(message?.content)
      ? message.content
      : message?.content === undefined
        ? []
        : [message.content];
    let toolCallId: string | null = null;
    for (const block of content) {
      const obj = asRecord(block);
      if (asString(obj?.type) !== "tool_result") continue;
      toolCallId = asString(obj?.tool_use_id);
      if (toolCallId !== null) break;
    }
    if (toolCallId === null) continue;
    launches.push({
      childAgentId,
      parentSourceKey: stream.streamKey,
      toolCallId,
      timestampMs: timestampMs(line.timestamp),
      ordinal: line.ordinal,
    });
  }
  return launches;
}

function resolveStreamRelations(streams: readonly SourceStream[]): {
  readonly relations: Map<string, StreamRelation>;
  readonly ambiguousSourceKeys: ReadonlySet<string>;
} {
  const launches = streams.flatMap((stream) => collectChildLaunches(stream));
  const relations = new Map<string, StreamRelation>();
  const ambiguousSourceKeys = new Set<string>();
  const childStreamsByAgentId = new Map<string, SourceStream[]>();
  for (const stream of streams) {
    if (stream.streamKey === "main" || stream.agentId === null) continue;
    const siblings = childStreamsByAgentId.get(stream.agentId) ?? [];
    siblings.push(stream);
    childStreamsByAgentId.set(stream.agentId, siblings);
  }
  for (const [agentId, childStreams] of childStreamsByAgentId) {
    const distinctEvidence = new Map<string, ChildLaunchRelation>();
    for (const launch of launches) {
      if (launch.childAgentId !== agentId) continue;
      distinctEvidence.set(
        `${launch.parentSourceKey}\u0000${launch.toolCallId}`,
        launch,
      );
    }
    if (childStreams.length !== 1 || distinctEvidence.size > 1) {
      for (const stream of childStreams) {
        ambiguousSourceKeys.add(stream.streamKey);
      }
      continue;
    }
    const child = childStreams[0] as SourceStream;
    const chosen = distinctEvidence.values().next().value as
      | ChildLaunchRelation
      | undefined;
    if (chosen !== undefined) {
      relations.set(child.streamKey, {
        parentSourceKey: chosen.parentSourceKey,
        toolCallId: chosen.toolCallId,
      });
    }
  }
  return { relations, ambiguousSourceKeys };
}

function breakSubagentRelationCycles(
  relations: ReadonlyMap<string, StreamRelation>,
): {
  readonly relationMap: Map<string, StreamRelation>;
  readonly cycleSourceKeys: ReadonlySet<string>;
} {
  const relationMap = new Map(relations);
  const cycleSourceKeys = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (sourceKey: string): void => {
    const current = state.get(sourceKey) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const cycleStart = stack.indexOf(sourceKey);
      for (const key of stack.slice(cycleStart >= 0 ? cycleStart : 0)) {
        cycleSourceKeys.add(key);
      }
      cycleSourceKeys.add(sourceKey);
      return;
    }
    state.set(sourceKey, 1);
    stack.push(sourceKey);
    const parentSourceKey = relationMap.get(sourceKey)?.parentSourceKey;
    if (parentSourceKey !== undefined && relationMap.has(parentSourceKey)) {
      visit(parentSourceKey);
    }
    stack.pop();
    state.set(sourceKey, 2);
  };

  for (const sourceKey of relationMap.keys()) visit(sourceKey);
  for (const sourceKey of cycleSourceKeys) relationMap.delete(sourceKey);
  return { relationMap, cycleSourceKeys };
}

function occurrenceIndex(lines: readonly SourceLine[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of lines) {
    if (line.uuid === null) continue;
    const existing = out.get(line.uuid);
    if (existing === undefined) {
      out.set(line.uuid, [line.ordinal]);
    } else {
      existing.push(line.ordinal);
    }
  }
  return out;
}

function resolveParentOrdinals(
  lines: readonly SourceLine[],
  warnings: Set<WarningCode>,
): Array<number | null> {
  const occ = occurrenceIndex(lines);
  for (const indices of occ.values()) {
    if (indices.length > 1) warnings.add("duplicate_uuid");
  }
  const parents = lines.map((line) => {
    const parentUuid = effectiveParentUuid(line);
    if (parentUuid === null) return null;
    const candidates = occ.get(parentUuid);
    if (candidates === undefined) {
      warnings.add("unresolved_parent");
      return null;
    }
    let bestPrior: number | null = null;
    let bestLater: number | null = null;
    for (const candidate of candidates) {
      if (candidate < line.ordinal) {
        bestPrior = candidate;
      } else if (candidate > line.ordinal) {
        if (bestLater === null || candidate < bestLater) bestLater = candidate;
      }
    }
    if (bestPrior !== null) return bestPrior;
    if (bestLater !== null) return bestLater;
    warnings.add("unresolved_parent");
    return null;
  });

  const state = new Array<0 | 1 | 2>(lines.length).fill(0);
  const fix = (ordinal: number): void => {
    if (state[ordinal] === 2) return;
    if (state[ordinal] === 1) {
      warnings.add("malformed_parent_cycle");
      parents[ordinal] = null;
      return;
    }
    state[ordinal] = 1;
    const parent = parents[ordinal];
    if (parent !== null) {
      fix(parent);
      if (state[parent] === 1) {
        warnings.add("malformed_parent_cycle");
        parents[ordinal] = null;
      }
    }
    state[ordinal] = 2;
  };
  for (let i = 0; i < lines.length; i += 1) fix(i);
  return parents;
}

function requestIdOf(line: SourceLine): string | null {
  return asString(line.parsed?.requestId);
}

function isSyntheticAssistant(line: SourceLine): boolean {
  const message = asRecord(line.parsed?.message);
  return (
    line.type === "assistant" &&
    (line.parsed?.isApiErrorMessage === true ||
      message?.model === "<synthetic>")
  );
}

function assistantGroups(
  stream: SourceStream,
  parents: readonly (number | null)[],
  allocateId: (parts: readonly string[]) => string,
  warnings: Set<WarningCode>,
): Map<number, AssistantGroup> {
  const groups = new Map<number, AssistantGroup>();
  let index = 0;
  while (index < stream.lines.length) {
    const line = stream.lines[index] as SourceLine;
    if (line.type !== "assistant" || isSyntheticAssistant(line)) {
      index += 1;
      continue;
    }
    const requestId = requestIdOf(line);
    if (requestId === null) {
      index += 1;
      continue;
    }
    const members = [line.ordinal];
    let cursor = index + 1;
    while (cursor < stream.lines.length) {
      const next = stream.lines[cursor] as SourceLine;
      if (
        next.type !== "assistant" ||
        isSyntheticAssistant(next) ||
        requestIdOf(next) !== requestId ||
        parents[next.ordinal] !==
          (stream.lines[cursor - 1] as SourceLine).ordinal
      ) {
        break;
      }
      members.push(next.ordinal);
      cursor += 1;
    }
    const recognized = convertAssistantContent(
      stream,
      members,
      warnings,
      new Set<WarningCode>(),
    );
    if (recognized.content.length > 0 && recognized.model === null) {
      warnings.add("assistant_missing_model");
    }
    const entryId =
      recognized.content.length > 0 && recognized.model !== null
        ? allocateId(["assistant", String(line.ordinal), requestId])
        : null;
    const group: AssistantGroup = {
      headOrdinal: line.ordinal,
      memberOrdinals: members,
      requestId,
      entryId,
    };
    for (const member of members) groups.set(member, group);
    index = cursor;
  }
  return groups;
}

function normalizeStopReason(
  raw: string | null,
  hasToolCall: boolean,
  sawError: boolean,
): PiStopReason {
  if (raw === "tool_use") return "toolUse";
  if (raw === "end_turn" || raw === "stop_sequence") return "stop";
  if (raw === "max_tokens") return "length";
  if (raw === "error" || raw === "errors") return "error";
  if (sawError) return "error";
  if (raw === null && hasToolCall) return "toolUse";
  return "stop";
}

function usageShape(value: unknown): PiUsage {
  const obj = asRecord(value) ?? {};
  const input = asFiniteNumber(obj.input_tokens) ?? 0;
  const cacheWrite = asFiniteNumber(obj.cache_creation_input_tokens) ?? 0;
  const cacheRead = asFiniteNumber(obj.cache_read_input_tokens) ?? 0;
  const output = asFiniteNumber(obj.output_tokens) ?? 0;
  const totalTokens = input + cacheWrite + cacheRead + output;
  const costSource = asRecord(obj.cost);
  const cost =
    costSource !== null &&
    asFiniteNumber(costSource.input) !== null &&
    asFiniteNumber(costSource.output) !== null &&
    asFiniteNumber(costSource.cacheRead) !== null &&
    asFiniteNumber(costSource.cacheWrite) !== null
      ? {
          input: asFiniteNumber(costSource.input) ?? 0,
          output: asFiniteNumber(costSource.output) ?? 0,
          cacheRead: asFiniteNumber(costSource.cacheRead) ?? 0,
          cacheWrite: asFiniteNumber(costSource.cacheWrite) ?? 0,
          total:
            asFiniteNumber(costSource.total) ??
            (asFiniteNumber(costSource.input) ?? 0) +
              (asFiniteNumber(costSource.output) ?? 0) +
              (asFiniteNumber(costSource.cacheRead) ?? 0) +
              (asFiniteNumber(costSource.cacheWrite) ?? 0),
        }
      : zeroUsageCost();
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

function imageBlockFromSource(block: JsonObject): JsonObject | null {
  const source = asRecord(block.source);
  const mimeType = asString(source?.media_type);
  const data = asString(source?.data);
  if (mimeType === null || data === null) return null;
  return { type: "image", mimeType, data };
}

function textAndImageBlocks(content: unknown): JsonObject[] {
  const blocks = Array.isArray(content)
    ? content
    : content === undefined
      ? []
      : [content];
  const out: JsonObject[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      if (block.length > 0) out.push({ type: "text", text: block });
      continue;
    }
    const obj = asRecord(block);
    const type = asString(obj?.type);
    if (type === "text") {
      const text = typeof obj?.text === "string" ? obj.text : "";
      if (text.length > 0) out.push({ type: "text", text });
      continue;
    }
    if (type === "image") {
      const image = imageBlockFromSource(obj as JsonObject);
      if (image !== null) out.push(image);
    }
  }
  return out;
}

interface ToolCallRecord {
  readonly id: string;
  readonly name: string | null;
  readonly sourceOrdinal: number;
  readonly blockOrdinal: number;
}

function collectToolCalls(stream: SourceStream): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (const line of stream.lines) {
    if (
      line.parsed === null ||
      line.type !== "assistant" ||
      isSyntheticAssistant(line)
    ) {
      continue;
    }
    const message = asRecord(line.parsed.message);
    const content = Array.isArray(message?.content)
      ? message.content
      : message?.content === undefined
        ? []
        : [message.content];
    for (
      let blockOrdinal = 0;
      blockOrdinal < content.length;
      blockOrdinal += 1
    ) {
      const obj = asRecord(content[blockOrdinal]);
      const type = asString(obj?.type);
      if (type !== "tool_use" && type !== "server_tool_use") continue;
      const id = asString(obj?.id);
      if (id === null) continue;
      out.push({
        id,
        name: asString(obj?.name),
        sourceOrdinal: line.ordinal,
        blockOrdinal,
      });
    }
  }
  return out;
}

function nearestAncestralToolCall(
  calls: readonly ToolCallRecord[],
  toolCallId: string,
  resultOrdinal: number,
  parents: readonly (number | null)[],
): ToolCallRecord | null {
  const distance = new Map<number, number>();
  const seen = new Set<number>();
  let cursor = parents[resultOrdinal] ?? null;
  let steps = 0;
  while (cursor !== null && !seen.has(cursor)) {
    distance.set(cursor, steps);
    seen.add(cursor);
    cursor = parents[cursor] ?? null;
    steps += 1;
  }
  return (
    calls
      .filter(
        (call) => call.id === toolCallId && distance.has(call.sourceOrdinal),
      )
      .sort(
        (a, b) =>
          (distance.get(a.sourceOrdinal) as number) -
            (distance.get(b.sourceOrdinal) as number) ||
          b.sourceOrdinal - a.sourceOrdinal ||
          b.blockOrdinal - a.blockOrdinal,
      )[0] ?? null
  );
}

function convertAssistantContent(
  stream: SourceStream,
  ordinals: readonly number[],
  warnings: Set<WarningCode>,
  localWarnings: Set<WarningCode>,
): {
  content: JsonObject[];
  model: string | null;
  stopReason: PiStopReason;
  usage: PiUsage;
  requestId: string;
  responseId: string | null;
  timestamp: string;
  timestampMs: number;
  sawToolCall: boolean;
} {
  const content: JsonObject[] = [];
  let model: string | null = null;
  let usage: PiUsage = zeroUsage();
  let rawStopReason: string | null = null;
  let responseId: string | null = null;
  let responseIdInconsistent = false;
  let sawToolCall = false;
  let sawError = false;
  for (const ordinal of ordinals) {
    const line = stream.lines[ordinal] as SourceLine;
    const parsed = line.parsed;
    const message = asRecord(parsed?.message);
    model = asString(message?.model) ?? model;
    const candidateResponseId = asString(message?.id);
    if (candidateResponseId !== null) {
      if (responseId === null) responseId = candidateResponseId;
      else if (responseId !== candidateResponseId)
        responseIdInconsistent = true;
    }
    usage = message?.usage !== undefined ? usageShape(message.usage) : usage;
    const stopReason =
      asString(message?.stop_reason) ?? asString(message?.stopReason);
    rawStopReason = stopReason ?? rawStopReason;
    if (asString(parsed?.error) !== null) sawError = true;
    const blocks = Array.isArray(message?.content)
      ? message.content
      : message?.content === undefined
        ? []
        : [message.content];
    for (const rawBlock of blocks) {
      if (typeof rawBlock === "string") {
        if (rawBlock.length > 0) content.push({ type: "text", text: rawBlock });
        continue;
      }
      const block = asRecord(rawBlock);
      const type = asString(block?.type);
      if (type === "text") {
        const text = typeof block?.text === "string" ? block.text : "";
        if (text.length > 0) content.push({ type: "text", text });
        continue;
      }
      if (type === "thinking") {
        const thinking =
          typeof block?.thinking === "string" ? block.thinking : "";
        const signature = asString(block?.signature);
        const next: JsonObject = { type: "thinking", thinking };
        if (signature !== null) next.thinkingSignature = signature;
        content.push(next);
        continue;
      }
      if (type === "redacted_thinking") {
        const signature =
          asString(block?.data) ?? asString(block?.signature) ?? "";
        content.push({
          type: "thinking",
          thinking: "",
          thinkingSignature: signature,
          redacted: true,
        });
        continue;
      }
      if (type === "tool_use" || type === "server_tool_use") {
        const id = asString(block?.id);
        const name = asString(block?.name);
        if (id !== null && name !== null) {
          content.push({
            type: "toolCall",
            id,
            name,
            arguments: asRecord(block?.input) ?? {},
          });
          sawToolCall = true;
        }
        continue;
      }
      warnings.add("unknown_assistant_block");
      localWarnings.add("unknown_assistant_block");
    }
  }
  if (responseIdInconsistent) {
    warnings.add("assistant_response_id_inconsistent");
    localWarnings.add("assistant_response_id_inconsistent");
    responseId = null;
  }
  const requestId =
    requestIdOf(stream.lines[ordinals[0] as number] as SourceLine) ?? "";
  const timestamp =
    (stream.lines[ordinals[ordinals.length - 1] as number] as SourceLine)
      .timestamp ?? DEFAULT_TIMESTAMP;
  return {
    content,
    model,
    stopReason: normalizeStopReason(rawStopReason, sawToolCall, sawError),
    usage,
    requestId,
    responseId,
    timestamp,
    timestampMs: requiredTimestampMs(timestamp, "assistant message"),
    sawToolCall,
  };
}

function toolCallHasNativeAssistant(
  call: ToolCallRecord,
  stream: SourceStream,
  groupByOrdinal: ReadonlyMap<number, AssistantGroup>,
): boolean {
  const group = groupByOrdinal.get(call.sourceOrdinal);
  if (group !== undefined) return group.entryId !== null;
  const line = stream.lines[call.sourceOrdinal] as SourceLine;
  if (isSyntheticAssistant(line)) return false;
  return asString(asRecord(line.parsed?.message)?.model) !== null;
}

function buildSessionText(
  sessionId: string,
  cwd: string,
  timestamp: string,
  entries: readonly DraftEntry[],
): string {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd,
  });
  const body = entries.map((entry) =>
    JSON.stringify({
      ...entry.body,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
    }),
  );
  return `${[header, ...body].join("\n")}\n`;
}

function safeSessionTimestamp(stream: SourceStream): string {
  return (
    firstNonEmptyString(stream.lines, (line) => line.timestamp) ??
    DEFAULT_TIMESTAMP
  );
}

function sessionFileTimestamp(timestamp: string): string {
  return timestamp.replaceAll(":", "-").replaceAll(".", "-");
}

function assistantAliasEntryId(
  group: AssistantGroup | undefined,
  fallback: string,
): string {
  return group?.entryId ?? fallback;
}

function resolveUuidOrdinalAt(
  occurrences: ReadonlyMap<string, readonly number[]>,
  uuid: string,
  referenceOrdinal: number,
): number | null {
  const candidates = occurrences.get(uuid);
  if (candidates === undefined) return null;
  let bestPrior: number | null = null;
  let bestLater: number | null = null;
  for (const candidate of candidates) {
    if (candidate < referenceOrdinal) bestPrior = candidate;
    else if (candidate > referenceOrdinal && bestLater === null) {
      bestLater = candidate;
    }
  }
  return bestPrior ?? bestLater;
}

function activeSourceOrdinal(
  lines: readonly SourceLine[],
  linePlans: readonly LinePlan[],
  occurrences: ReadonlyMap<string, readonly number[]>,
): number | null {
  let lastPrompt: {
    readonly leafUuid: string;
    readonly ordinal: number;
  } | null = null;
  for (const line of lines) {
    if (line.type !== "last-prompt") continue;
    const leafUuid = asString(line.parsed?.leafUuid);
    if (leafUuid !== null) lastPrompt = { leafUuid, ordinal: line.ordinal };
  }
  const uuidOrdinals = lines
    .filter((line) => line.uuid !== null)
    .map((line) => line.ordinal);
  const latestUuidOrdinal = uuidOrdinals.at(-1) ?? null;
  if (lastPrompt !== null) {
    if (latestUuidOrdinal !== null && latestUuidOrdinal > lastPrompt.ordinal) {
      return latestUuidOrdinal;
    }
    const referenced = resolveUuidOrdinalAt(
      occurrences,
      lastPrompt.leafUuid,
      lastPrompt.ordinal,
    );
    if (referenced !== null) return referenced;
  }
  if (latestUuidOrdinal !== null) return latestUuidOrdinal;
  for (let ordinal = linePlans.length - 1; ordinal >= 0; ordinal -= 1) {
    const plan = linePlans[ordinal];
    if (
      plan?.entries.some(
        (entry) =>
          entry.body.type !== "custom" ||
          entry.body.customType !== RAW_SHADOW_CUSTOM_TYPE,
      )
    ) {
      return ordinal;
    }
  }
  return null;
}

function prepareStreamSession(
  stream: SourceStream,
  mainSourceSessionId: string,
  manifestPath: string,
  relation: StreamRelation | null,
  parentPiSessionId: string | null,
  defaultCwd: string,
  additionalWarnings: readonly WarningCode[] = [],
): PreparedClaudeToPiSession {
  const warningSet = new Set<WarningCode>(additionalWarnings);
  const allocateId = createEntryIdAllocator(
    sessionUuidFor(mainSourceSessionId, stream.streamKey),
  );
  const piSessionId = sessionUuidFor(mainSourceSessionId, stream.streamKey);
  const cwd = stream.cwd ?? defaultCwd;
  const sessionTimestamp = safeSessionTimestamp(stream);
  const parents = resolveParentOrdinals(stream.lines, warningSet);
  const occ = occurrenceIndex(stream.lines);
  const groupByOrdinal = assistantGroups(
    stream,
    parents,
    allocateId,
    warningSet,
  );
  const toolCalls = collectToolCalls(stream);
  const metadataRootId = allocateId(["metadata"]);
  const linePlans: LinePlan[] = new Array(stream.lines.length);

  for (const line of stream.lines) {
    const parsed = line.parsed;
    const baseTimestamp = line.timestamp ?? sessionTimestamp;
    const draftEntries: DraftEntry[] = [];
    let anchorId: string | null = null;
    let terminalId: string | null = null;
    const group = groupByOrdinal.get(line.ordinal);
    const localWarnings = new Set<WarningCode>();

    const pushRawShadow = (parentId: string | null): void => {
      const rawId = allocateId(["raw", String(line.ordinal)]);
      const aliasId = assistantAliasEntryId(group, anchorId ?? rawId);
      draftEntries.push({
        id: rawId,
        parentId,
        timestamp: baseTimestamp,
        sourceOrdinal: line.ordinal,
        localOrdinal: draftEntries.length,
        body: {
          type: "custom",
          customType: RAW_SHADOW_CUSTOM_TYPE,
          data: {
            mappingVersion: CLAUDE_TO_PI_MAPPING_VERSION,
            streamKey: stream.streamKey,
            sourceSessionId: stream.sessionId,
            lineOrdinal: line.ordinal + 1,
            lineDigest: line.lineDigest,
            sourceType: line.type ?? "malformed",
            uuid: line.uuid,
            parentUuid: line.parentUuid,
            rawUtf8: line.rawUtf8,
            nativeAliasEntryId: aliasId,
          },
        },
      });
      terminalId = rawId;
      if (anchorId === null) anchorId = rawId;
    };

    if (parsed === null) {
      warningSet.add("malformed_line");
      pushRawShadow(null);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (group !== undefined) {
      if (group.headOrdinal === line.ordinal && group.entryId !== null) {
        const converted = convertAssistantContent(
          stream,
          group.memberOrdinals,
          warningSet,
          localWarnings,
        );
        draftEntries.push({
          id: group.entryId,
          parentId: null,
          timestamp: converted.timestamp,
          sourceOrdinal: line.ordinal,
          localOrdinal: draftEntries.length,
          body: {
            type: "message",
            message: {
              role: "assistant",
              provider: "anthropic",
              api: "anthropic-messages",
              model: converted.model,
              responseId: converted.responseId ?? undefined,
              content: converted.content,
              stopReason: converted.stopReason,
              usage: converted.usage,
              timestamp: converted.timestampMs,
            },
          },
        });
        anchorId = group.entryId;
      } else if (group.headOrdinal !== line.ordinal && group.entryId !== null) {
        anchorId = group.entryId;
      }
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (line.type === "custom-title") {
      const customTitle = asString(parsed.customTitle);
      if (customTitle !== null) {
        const entryId = allocateId(["title", String(line.ordinal)]);
        draftEntries.push({
          id: entryId,
          parentId: null,
          timestamp: baseTimestamp,
          sourceOrdinal: line.ordinal,
          localOrdinal: draftEntries.length,
          body: {
            type: "session_info",
            name: customTitle,
          },
        });
        anchorId = entryId;
      }
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (compactBoundaryInfo(line) !== null) {
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (parsed.isCompactSummary === true || line.type === "summary") {
      let trustedCompaction = false;
      if (parsed.isCompactSummary === true && line.type === "user") {
        const boundaryOrdinal = parents[line.ordinal];
        const boundaryLine =
          boundaryOrdinal !== null
            ? (stream.lines[boundaryOrdinal] as SourceLine)
            : null;
        const boundary =
          boundaryLine !== null ? compactBoundaryInfo(boundaryLine) : null;
        const logicalParentOrdinal =
          boundaryOrdinal !== null ? parents[boundaryOrdinal] : null;
        const summaryText = summaryTextFromContent(
          asRecord(parsed.message)?.content,
        );
        const keptHeadOrdinal =
          boundary !== null
            ? resolveEarlierUuidOrdinal(occ, boundary.headUuid, line.ordinal)
            : null;
        if (
          boundaryOrdinal !== null &&
          boundaryLine !== null &&
          boundary !== null &&
          boundaryLine.ordinal === line.ordinal - 1 &&
          logicalParentOrdinal !== null &&
          boundary.preTokens !== null &&
          boundary.preTokens >= 0 &&
          summaryText !== null &&
          keptHeadOrdinal !== null &&
          linePlans[keptHeadOrdinal] !== undefined &&
          isOrdinalAncestor(keptHeadOrdinal, logicalParentOrdinal, parents)
        ) {
          const entryId = allocateId(["compaction", String(line.ordinal)]);
          draftEntries.push({
            id: entryId,
            parentId: null,
            timestamp: baseTimestamp,
            sourceOrdinal: line.ordinal,
            localOrdinal: draftEntries.length,
            body: {
              type: "compaction",
              summary: summaryText,
              firstKeptEntryId: (linePlans[keptHeadOrdinal] as LinePlan)
                .anchorId,
              tokensBefore: boundary.preTokens,
              fromHook: true,
              details: {
                source: "claude_compact_summary",
                mappingVersion: CLAUDE_TO_PI_MAPPING_VERSION,
                streamKey: stream.streamKey,
                logicalParentUuid: boundary.logicalParentUuid,
                boundaryUuid: boundaryLine.uuid,
                keptHeadUuid: boundary.headUuid,
                summaryUuid: line.uuid,
              },
            },
          });
          anchorId = entryId;
          trustedCompaction = true;
        }
      }
      if (!trustedCompaction) {
        warningSet.add("compaction_untrusted");
      }
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (isSyntheticAssistant(line)) {
      warningSet.add("assistant_api_error_raw_only");
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (line.type === "user") {
      const message = asRecord(parsed.message);
      const content = Array.isArray(message?.content)
        ? message.content
        : message?.content === undefined
          ? []
          : [message.content];
      const userBlocks: JsonObject[] = [];
      const toolResultDrafts: DraftEntry[] = [];
      for (const rawBlock of content) {
        if (typeof rawBlock === "string") {
          if (rawBlock.length > 0)
            userBlocks.push({ type: "text", text: rawBlock });
          continue;
        }
        const block = asRecord(rawBlock);
        const type = asString(block?.type);
        if (type === "text") {
          const text = typeof block?.text === "string" ? block.text : "";
          if (text.length > 0) userBlocks.push({ type: "text", text });
          continue;
        }
        if (type === "image") {
          const image = imageBlockFromSource(block as JsonObject);
          if (image !== null) userBlocks.push(image);
          continue;
        }
        if (type === "tool_result") {
          const toolCallId = asString(block?.tool_use_id);
          if (toolCallId === null) {
            warningSet.add("tool_result_missing_call");
            continue;
          }
          const matchingCalls = toolCalls.filter(
            (call) => call.id === toolCallId,
          );
          if (matchingCalls.length === 0) {
            warningSet.add("tool_result_missing_call");
            continue;
          }
          const ancestralCall = nearestAncestralToolCall(
            toolCalls,
            toolCallId,
            line.ordinal,
            parents,
          );
          if (
            ancestralCall === null ||
            !toolCallHasNativeAssistant(ancestralCall, stream, groupByOrdinal)
          ) {
            warningSet.add("tool_result_without_ancestral_call");
            continue;
          }
          const toolName = ancestralCall.name;
          if (toolName === null) {
            warningSet.add("tool_result_missing_name");
            continue;
          }
          const toolResultId = allocateId([
            "tool-result",
            String(line.ordinal),
            toolCallId,
            String(toolResultDrafts.length),
          ]);
          toolResultDrafts.push({
            id: toolResultId,
            parentId: null,
            timestamp: baseTimestamp,
            sourceOrdinal: line.ordinal,
            localOrdinal: toolResultDrafts.length,
            body: {
              type: "message",
              message: {
                role: "toolResult",
                toolCallId,
                toolName,
                isError: block?.is_error === true,
                content: textAndImageBlocks(block?.content),
                timestamp: requiredTimestampMs(
                  baseTimestamp,
                  "tool result message",
                ),
                details: {
                  toolUseResult: parsed.toolUseResult ?? null,
                  provenance: {
                    sourceSessionId: stream.sessionId,
                    streamKey: stream.streamKey,
                    sourceUuid: line.uuid,
                    lineOrdinal: line.ordinal + 1,
                  },
                },
              },
            },
          });
        }
      }
      for (const toolResult of toolResultDrafts) {
        draftEntries.push(toolResult);
        anchorId = toolResult.id;
      }
      if (userBlocks.length > 0) {
        const entryId = allocateId(["user", String(line.ordinal)]);
        draftEntries.push({
          id: entryId,
          parentId: null,
          timestamp: baseTimestamp,
          sourceOrdinal: line.ordinal,
          localOrdinal: draftEntries.length,
          body: {
            type: "message",
            message: {
              role: "user",
              content: userBlocks,
              timestamp: requiredTimestampMs(baseTimestamp, "user message"),
            },
          },
        });
        anchorId = entryId;
      }
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (line.type === "assistant") {
      const message = asRecord(parsed.message);
      const content = Array.isArray(message?.content)
        ? message.content
        : message?.content === undefined
          ? []
          : [message.content];
      const recognized = content.some((rawBlock) => {
        if (typeof rawBlock === "string") return rawBlock.length > 0;
        const block = asRecord(rawBlock);
        const type = asString(block?.type);
        return (
          type === "text" ||
          type === "thinking" ||
          type === "redacted_thinking" ||
          type === "tool_use" ||
          type === "server_tool_use"
        );
      });
      if (recognized) {
        const converted = convertAssistantContent(
          stream,
          [line.ordinal],
          warningSet,
          localWarnings,
        );
        if (converted.content.length > 0 && converted.model !== null) {
          const entryId = allocateId([
            "assistant-single",
            String(line.ordinal),
          ]);
          draftEntries.push({
            id: entryId,
            parentId: null,
            timestamp: baseTimestamp,
            sourceOrdinal: line.ordinal,
            localOrdinal: draftEntries.length,
            body: {
              type: "message",
              message: {
                role: "assistant",
                provider: "anthropic",
                api: "anthropic-messages",
                model: converted.model,
                responseId: converted.responseId ?? undefined,
                content: converted.content,
                stopReason: converted.stopReason,
                usage: converted.usage,
                timestamp: converted.timestampMs,
              },
            },
          });
          anchorId = entryId;
        } else if (converted.content.length > 0) {
          warningSet.add("assistant_missing_model");
        }
      }
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    if (
      line.type === "system" ||
      line.type === "attachment" ||
      line.type === "queue" ||
      line.type === "mode" ||
      line.type === "permission" ||
      line.type === "file_snapshot" ||
      line.type === "agent-name"
    ) {
      warningSet.add("unknown_record_type");
      pushRawShadow(anchorId);
      linePlans[line.ordinal] = {
        anchorId: anchorId ?? terminalId ?? metadataRootId,
        terminalId: terminalId ?? metadataRootId,
        entries: draftEntries,
      };
      continue;
    }

    warningSet.add("unknown_record_type");
    pushRawShadow(anchorId);
    linePlans[line.ordinal] = {
      anchorId: anchorId ?? terminalId ?? metadataRootId,
      terminalId: terminalId ?? metadataRootId,
      entries: draftEntries,
    };
  }

  const metadataRelation =
    relation !== null && parentPiSessionId !== null
      ? {
          parentSourceKey: relation.parentSourceKey,
          parentPiSessionId,
          toolCallId: relation.toolCallId,
        }
      : null;
  if (stream.streamKey !== "main" && metadataRelation === null) {
    warningSet.add("unmatched_subagent");
  }

  const metadataRoot: DraftEntry = {
    id: metadataRootId,
    parentId: null,
    timestamp: sessionTimestamp,
    sourceOrdinal: -1,
    localOrdinal: 0,
    body: {
      type: "custom",
      customType: METADATA_ROOT_CUSTOM_TYPE,
      data: {
        mappingVersion: CLAUDE_TO_PI_MAPPING_VERSION,
        sourceSessionId: stream.sessionId,
        streamKey: stream.streamKey,
        agentId: stream.agentId,
        sourceSha256: stream.digest,
        parentRelation: metadataRelation,
        manifestPath,
      },
    },
  };

  const emitted: DraftEntry[] = [metadataRoot];
  for (const line of stream.lines) {
    const linePlan = linePlans[line.ordinal] as LinePlan;
    const baseParentId =
      parents[line.ordinal] !== null
        ? (linePlans[parents[line.ordinal] as number] as LinePlan).anchorId
        : metadataRootId;
    for (let i = 0; i < linePlan.entries.length; i += 1) {
      const draft = linePlan.entries[i] as DraftEntry;
      const isFirst = i === 0;
      const parentId =
        draft.parentId ??
        (isFirst ? baseParentId : (linePlan.entries[i - 1] as DraftEntry).id);
      emitted.push({ ...draft, parentId });
    }
  }

  const activeOrdinal = activeSourceOrdinal(stream.lines, linePlans, occ);
  const activeLine =
    activeOrdinal !== null
      ? (stream.lines[activeOrdinal] as SourceLine)
      : undefined;
  const activeTerminalId =
    activeOrdinal !== null
      ? (linePlans[activeOrdinal] as LinePlan).terminalId
      : metadataRootId;
  emitted.push({
    id: allocateId(["active-leaf"]),
    parentId: activeTerminalId,
    timestamp: activeLine?.timestamp ?? sessionTimestamp,
    sourceOrdinal: Number.MAX_SAFE_INTEGER,
    localOrdinal: 0,
    body: {
      type: "custom",
      customType: ACTIVE_LEAF_CUSTOM_TYPE,
      data: {
        mappingVersion: CLAUDE_TO_PI_MAPPING_VERSION,
        streamKey: stream.streamKey,
      },
    },
  });

  const ordered = topologicallyOrderEntries(emitted);
  const validate = validateSessionEntries(ordered);
  for (const warning of validate.warningCodes) warningSet.add(warning);

  const destinationPath = join(
    "sessions",
    encodePiCwd(cwd),
    `${sessionFileTimestamp(sessionTimestamp)}_${piSessionId}.jsonl`,
  )
    .split("\\")
    .join("/");
  const text = buildSessionText(piSessionId, cwd, sessionTimestamp, ordered);
  validatePiV3SessionText(text, {
    id: piSessionId,
    timestamp: sessionTimestamp,
    cwd,
  });
  const bytes = Buffer.from(text, "utf8");
  return {
    sourceKey: stream.streamKey,
    agentId: stream.agentId,
    sourcePath: stream.path,
    sourceDigest: stream.digest,
    sourceLineCount: stream.lines.length,
    piSessionId,
    cwd,
    sessionTimestamp,
    destinationPath,
    entryCount: ordered.length,
    warningCodes: stableSortedWarnings(warningSet),
    parentRelation: metadataRelation,
    bytes,
    text,
  };
}

function topologicallyOrderEntries(
  entries: readonly DraftEntry[],
): DraftEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  const out: DraftEntry[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (entry: DraftEntry): void => {
    const current = state.get(entry.id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      throw new ConversationConversionError(
        "validation_failed",
        "entry cycle detected while ordering session",
      );
    }
    state.set(entry.id, 1);
    if (entry.parentId !== null) {
      const parent = byId.get(entry.parentId);
      if (parent === undefined) {
        throw new ConversationConversionError(
          "validation_failed",
          "entry parent missing while ordering session",
        );
      }
      visit(parent);
    }
    state.set(entry.id, 2);
    out.push(entry);
  };
  entries
    .slice()
    .sort(
      (a, b) =>
        a.sourceOrdinal - b.sourceOrdinal || a.localOrdinal - b.localOrdinal,
    )
    .forEach(visit);
  return out;
}

function failValidation(message: string): never {
  throw new ConversationConversionError("validation_failed", message);
}

function validateTextBlock(block: unknown, context: string): void {
  const obj = asRecord(block);
  if (
    asString(obj?.type) !== "text" ||
    typeof obj?.text !== "string" ||
    obj.text.length === 0
  ) {
    failValidation(`${context} must contain text blocks with nonempty text`);
  }
}

function validateImageBlock(block: unknown, context: string): void {
  const obj = asRecord(block);
  if (
    asString(obj?.type) !== "image" ||
    asString(obj?.mimeType) === null ||
    asString(obj?.data) === null
  ) {
    failValidation(
      `${context} must contain image blocks with mimeType and data`,
    );
  }
}

function validateTextOrImageArray(
  value: unknown,
  context: string,
  options: { allowEmpty?: boolean } = {},
): void {
  if (!Array.isArray(value)) {
    failValidation(`${context} must be an array`);
  }
  if (value.length === 0 && options.allowEmpty !== true) {
    failValidation(`${context} must not be empty`);
  }
  for (const block of value) {
    const obj = asRecord(block);
    const type = asString(obj?.type);
    if (type === "text") {
      validateTextBlock(block, context);
      continue;
    }
    if (type === "image") {
      validateImageBlock(block, context);
      continue;
    }
    failValidation(`${context} must contain only text or image blocks`);
  }
}

function validateUserContent(value: unknown): void {
  if (typeof value === "string") {
    if (value.length === 0)
      failValidation("user message content must be nonempty");
    return;
  }
  validateTextOrImageArray(value, "user message content");
}

function validateAssistantUsage(value: unknown): void {
  const usage = asRecord(value);
  if (usage === null) failValidation("assistant usage must be an object");
  const input = asFiniteNumber(usage.input);
  const output = asFiniteNumber(usage.output);
  const cacheRead = asFiniteNumber(usage.cacheRead);
  const cacheWrite = asFiniteNumber(usage.cacheWrite);
  const totalTokens = asFiniteNumber(usage.totalTokens);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    totalTokens === null
  ) {
    failValidation(
      "assistant usage must include numeric input/output/cacheRead/cacheWrite/totalTokens",
    );
  }
  if (totalTokens !== input + output + cacheRead + cacheWrite) {
    failValidation(
      "assistant usage totalTokens must equal input + output + cacheRead + cacheWrite",
    );
  }
  const cost = asRecord(usage.cost);
  if (cost === null) failValidation("assistant usage cost must be an object");
  const costInput = asFiniteNumber(cost.input);
  const costOutput = asFiniteNumber(cost.output);
  const costCacheRead = asFiniteNumber(cost.cacheRead);
  const costCacheWrite = asFiniteNumber(cost.cacheWrite);
  const costTotal = asFiniteNumber(cost.total);
  if (
    costInput === null ||
    costOutput === null ||
    costCacheRead === null ||
    costCacheWrite === null ||
    costTotal === null
  ) {
    failValidation(
      "assistant usage cost must include numeric input/output/cacheRead/cacheWrite/total",
    );
  }
  if (costTotal !== costInput + costOutput + costCacheRead + costCacheWrite) {
    failValidation("assistant usage cost.total must equal its components");
  }
}

function validateAssistantContent(
  value: unknown,
  inheritedToolCalls: Set<string>,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    failValidation("assistant content must be a nonempty array");
  }
  for (const block of value) {
    const obj = asRecord(block);
    const type = asString(obj?.type);
    if (type === "text") {
      validateTextBlock(block, "assistant content");
      continue;
    }
    if (type === "thinking") {
      if (typeof obj?.thinking !== "string") {
        failValidation(
          "assistant thinking blocks must have string thinking text",
        );
      }
      if (
        obj?.thinkingSignature !== undefined &&
        asString(obj.thinkingSignature) === null
      ) {
        failValidation(
          "assistant thinkingSignature must be a nonempty string when present",
        );
      }
      if (obj?.redacted !== undefined && typeof obj.redacted !== "boolean") {
        failValidation("assistant redacted must be boolean when present");
      }
      continue;
    }
    if (type === "toolCall") {
      const id = asString(obj?.id);
      const name = asString(obj?.name);
      if (id === null || name === null) {
        failValidation("assistant toolCall blocks must include id and name");
      }
      if (asRecord(obj?.arguments) === null) {
        failValidation("assistant toolCall arguments must be an object");
      }
      inheritedToolCalls.add(id);
      continue;
    }
    failValidation("assistant content contains an unsupported block type");
  }
}

function validateStructuredSessionEntries(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly body: JsonObject;
  }>,
): ValidateSessionResult {
  const warnings = new Set<WarningCode>();
  const ids = new Set<string>();
  const ancestryCalls = new Map<string, Set<string>>();
  const ancestorIds = new Map<string, Set<string>>();
  const indexById = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined)
      failValidation("entry missing while validating session");
    if (!/^[0-9a-f]{8}$/.test(entry.id)) {
      failValidation("entry id must be 8 lowercase hex chars");
    }
    if (ids.has(entry.id)) {
      failValidation("duplicate entry id");
    }
    ids.add(entry.id);
    indexById.set(entry.id, i);
    if (!Number.isFinite(Date.parse(entry.timestamp))) {
      failValidation("entry timestamp must be a valid ISO timestamp");
    }
    if (entry.parentId !== null) {
      const parentIndex = indexById.get(entry.parentId);
      if (parentIndex === undefined || parentIndex >= i) {
        failValidation("parent must resolve to an earlier entry");
      }
    }
    const inheritedToolCalls =
      entry.parentId !== null
        ? new Set(ancestryCalls.get(entry.parentId) ?? [])
        : new Set<string>();
    const inheritedAncestorIds =
      entry.parentId !== null
        ? new Set([entry.parentId, ...(ancestorIds.get(entry.parentId) ?? [])])
        : new Set<string>();
    const type = asString(entry.body.type);
    if (type === null) failValidation("entry type missing");
    if (type === "message") {
      const message = asRecord(entry.body.message);
      if (message === null)
        failValidation("message entry is missing message payload");
      if (asFiniteNumber(message.timestamp) === null) {
        failValidation("message payload must include numeric timestamp");
      }
      const role = asString(message.role);
      if (role === "user") {
        validateUserContent(message.content);
      } else if (role === "assistant") {
        if (asString(message.api) === null)
          failValidation("assistant api must be a nonempty string");
        if (asString(message.provider) === null) {
          failValidation("assistant provider must be a nonempty string");
        }
        if (asString(message.model) === null)
          failValidation("assistant model must be a nonempty string");
        if (!Array.isArray(message.content)) {
          failValidation("assistant content must be an array");
        }
        const stopReason = asString(message.stopReason);
        if (
          stopReason !== "stop" &&
          stopReason !== "length" &&
          stopReason !== "toolUse" &&
          stopReason !== "error" &&
          stopReason !== "aborted"
        ) {
          failValidation("assistant stopReason is invalid");
        }
        validateAssistantUsage(message.usage);
        validateAssistantContent(message.content, inheritedToolCalls);
      } else if (role === "toolResult") {
        const toolCallId = asString(message.toolCallId);
        const toolName = asString(message.toolName);
        if (toolCallId === null)
          failValidation("tool result is missing toolCallId");
        if (toolName === null)
          failValidation("tool result is missing toolName");
        if (typeof message.isError !== "boolean") {
          failValidation("tool result is missing boolean isError");
        }
        validateTextOrImageArray(message.content, "tool result content", {
          allowEmpty: true,
        });
        if (!inheritedToolCalls.has(toolCallId)) {
          failValidation("tool result must have an ancestral native tool call");
        }
      } else {
        failValidation("message role is invalid");
      }
    } else if (type === "compaction") {
      if (entry.parentId === null)
        failValidation("compaction entries must have a parent");
      const summary = asString(entry.body.summary);
      const firstKeptEntryId = asString(entry.body.firstKeptEntryId);
      const tokensBefore = asFiniteNumber(entry.body.tokensBefore);
      if (summary === null)
        failValidation("compaction summary must be a nonempty string");
      if (firstKeptEntryId === null) {
        failValidation("compaction firstKeptEntryId must be a nonempty string");
      }
      if (tokensBefore === null || tokensBefore < 0) {
        failValidation(
          "compaction tokensBefore must be a finite nonnegative number",
        );
      }
      if (
        entry.body.fromHook !== undefined &&
        typeof entry.body.fromHook !== "boolean"
      ) {
        failValidation("compaction fromHook must be boolean when present");
      }
      if (!inheritedAncestorIds.has(firstKeptEntryId)) {
        failValidation(
          "compaction firstKeptEntryId must resolve to an earlier ancestral entry",
        );
      }
    } else if (type === "session_info") {
      if (asString(entry.body.name) === null) {
        failValidation("session_info name must be a nonempty string");
      }
    } else if (type === "custom") {
      if (asString(entry.body.customType) === null) {
        failValidation("custom entry customType must be a nonempty string");
      }
    }
    ancestryCalls.set(entry.id, inheritedToolCalls);
    ancestorIds.set(entry.id, inheritedAncestorIds);
  }
  return { warningCodes: stableSortedWarnings(warnings) };
}

function validateSessionEntries(
  entries: readonly DraftEntry[],
): ValidateSessionResult {
  return validateStructuredSessionEntries(
    entries.map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      body: entry.body,
    })),
  );
}

export function validatePiV3SessionText(
  text: string,
  expectations: SessionTextValidationExpectations = {},
): void {
  const lines = text.split("\n");
  if (lines.length < 2 || lines.at(-1) !== "") {
    failValidation("session text must end with a single trailing lf");
  }
  const nonEmptyLines = lines.slice(0, -1);
  if (nonEmptyLines.length === 0)
    failValidation("session text is missing a header");
  const headerLine = nonEmptyLines[0];
  if (headerLine === undefined)
    failValidation("session text is missing a header");
  let headerParsed: unknown;
  try {
    headerParsed = JSON.parse(headerLine);
  } catch {
    failValidation("session header is not valid JSON");
  }
  const header = asRecord(headerParsed);
  if (header === null || header.type !== "session" || header.version !== 3) {
    failValidation("first line must be a v3 session header");
  }
  if (asString(header.id) === null)
    failValidation("session header id must be a nonempty string");
  if (
    asString(header.timestamp) === null ||
    !Number.isFinite(Date.parse(header.timestamp as string))
  ) {
    failValidation("session header timestamp must be a valid ISO timestamp");
  }
  if (asString(header.cwd) === null)
    failValidation("session header cwd must be a nonempty string");
  if (expectations.id !== undefined && header.id !== expectations.id) {
    failValidation(
      "session header id does not match the expected deterministic id",
    );
  }
  if (
    expectations.timestamp !== undefined &&
    header.timestamp !== expectations.timestamp
  ) {
    failValidation(
      "session header timestamp does not match the expected deterministic timestamp",
    );
  }
  if (expectations.cwd !== undefined && header.cwd !== expectations.cwd) {
    failValidation(
      "session header cwd does not match the expected deterministic cwd",
    );
  }
  const entries: Array<{
    id: string;
    parentId: string | null;
    timestamp: string;
    body: JsonObject;
  }> = [];
  for (let i = 1; i < nonEmptyLines.length; i += 1) {
    const line = nonEmptyLines[i];
    if (line === undefined)
      failValidation(`session entry line ${i + 1} is missing`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      failValidation(`session entry line ${i + 1} is not valid JSON`);
    }
    const entry = asRecord(parsed);
    if (entry === null)
      failValidation(`session entry line ${i + 1} is not an object`);
    if (entry.type === "session")
      failValidation("session header must appear only on the first line");
    const id = asString(entry.id);
    if (id === null)
      failValidation(`session entry line ${i + 1} is missing id`);
    const parentId = entry.parentId === null ? null : asString(entry.parentId);
    if (entry.parentId !== null && parentId === null) {
      failValidation(`session entry line ${i + 1} has invalid parentId`);
    }
    const timestamp = asString(entry.timestamp);
    if (timestamp === null)
      failValidation(`session entry line ${i + 1} is missing timestamp`);
    entries.push({ id, parentId, timestamp, body: entry });
  }
  validateStructuredSessionEntries(entries);
}

interface PublishDependencies {
  readonly chmod: (path: string, mode: number) => void;
  readonly fchmod: (fd: number, mode: number) => void;
  readonly fsync: (fd: number, event: ClaudeToPiPublishFsyncEvent) => void;
  readonly onAfterArtifactCreated?: (
    event: ClaudeToPiPublishedArtifactEvent,
  ) => void;
}

interface OwnedPathIdentity {
  readonly path: string;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
}

interface ArtifactLocation {
  readonly absolutePath: string;
  readonly directoryPath: string;
  readonly directoryChain: readonly OwnedPathIdentity[];
}

const POSIX_PERMISSION_SEMANTICS =
  process.platform !== "win32" && typeof process.getuid === "function";

function publishDependencies(
  overrides: ClaudeToPiPublishDeps | undefined,
): PublishDependencies {
  return {
    chmod:
      overrides?.chmodSync ??
      (POSIX_PERMISSION_SEMANTICS ? chmodSync : () => undefined),
    fchmod:
      overrides?.fchmodSync ??
      (POSIX_PERMISSION_SEMANTICS ? fchmodSync : () => undefined),
    fsync:
      overrides?.fsyncSync ??
      ((fd, _event) => {
        fsyncSync(fd);
      }),
    onAfterArtifactCreated: overrides?.onAfterArtifactCreated,
  };
}

function objectIdentity(
  path: string,
  stat: import("node:fs").Stats,
): OwnedPathIdentity {
  return { path, dev: stat.dev, ino: stat.ino };
}

function sameObject(
  identity: OwnedPathIdentity,
  stat: import("node:fs").Stats,
): boolean {
  return identity.dev === stat.dev && identity.ino === stat.ino;
}

function hasExpectedOwner(stat: import("node:fs").Stats): boolean {
  return !POSIX_PERMISSION_SEMANTICS || stat.uid === process.getuid?.();
}

function hasExactMode(stat: import("node:fs").Stats, mode: number): boolean {
  return !POSIX_PERMISSION_SEMANTICS || (stat.mode & 0o7777) === mode;
}

function isWritableByOtherUsers(stat: import("node:fs").Stats): boolean {
  return POSIX_PERMISSION_SEMANTICS && (stat.mode & 0o022) !== 0;
}

function requireOwnedPrivateDirectory(
  path: string,
  deps: PublishDependencies,
  expected?: OwnedPathIdentity,
): OwnedPathIdentity {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !hasExpectedOwner(before) ||
    (expected !== undefined && !sameObject(expected, before))
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "publication directory is not an owned real directory",
      { path },
    );
  }
  const identity = objectIdentity(path, before);
  if (!hasExactMode(before, 0o700)) deps.chmod(path, 0o700);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameObject(identity, after) ||
    !hasExpectedOwner(after) ||
    !hasExactMode(after, 0o700)
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "publication directory permissions or identity are unsafe",
      { path },
    );
  }
  return identity;
}

function fsyncDirectoryRequired(path: string, deps: PublishDependencies): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    const flags =
      FS_CONSTANTS.O_RDONLY |
      (typeof FS_CONSTANTS.O_DIRECTORY === "number"
        ? FS_CONSTANTS.O_DIRECTORY
        : 0);
    fd = openSync(path, flags);
    deps.fsync(fd, { kind: "directory", path });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncDirectoryBestEffort(
  path: string,
  deps: PublishDependencies,
): void {
  try {
    fsyncDirectoryRequired(path, deps);
  } catch {
    // Cleanup durability cannot replace the original publication failure.
  }
}

function resolvePublicationRoot(
  selectedRoot: string,
  deps: PublishDependencies,
): string {
  let createdIdentity: OwnedPathIdentity | undefined;
  try {
    lstatSync(selectedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(selectedRoot, { recursive: true, mode: 0o700 });
    deps.chmod(selectedRoot, 0o700);
    createdIdentity = requireOwnedPrivateDirectory(selectedRoot, deps);
    fsyncDirectoryRequired(dirname(selectedRoot), deps);
  }
  const canonicalRoot = realpathSync(selectedRoot);
  const canonical = lstatSync(canonicalRoot);
  if (
    canonical.isSymbolicLink() ||
    !canonical.isDirectory() ||
    !hasExpectedOwner(canonical) ||
    isWritableByOtherUsers(canonical) ||
    (createdIdentity !== undefined && !sameObject(createdIdentity, canonical))
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "selected Pi root is not an owned, non-shared directory",
      { path: selectedRoot },
    );
  }
  return canonicalRoot;
}

function safeArtifactParts(relativeArtifactPath: string): string[] {
  const parts = relativeArtifactPath.split(/[\\/]/);
  if (
    relativeArtifactPath.length === 0 ||
    isAbsolute(relativeArtifactPath) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "artifact path escapes the resolved Pi root",
      { path: relativeArtifactPath },
    );
  }
  return parts;
}

function ensureArtifactLocation(
  canonicalRoot: string,
  relativeArtifactPath: string,
  deps: PublishDependencies,
): ArtifactLocation {
  const parts = safeArtifactParts(relativeArtifactPath);
  const absolutePath = resolve(canonicalRoot, ...parts);
  const lexicalRelative = relative(canonicalRoot, absolutePath);
  if (
    lexicalRelative.length === 0 ||
    isAbsolute(lexicalRelative) ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "artifact path escapes the resolved Pi root",
      { path: relativeArtifactPath },
    );
  }

  const directoryChain: OwnedPathIdentity[] = [];
  let current = canonicalRoot;
  for (const component of parts.slice(0, -1)) {
    const parent = current;
    current = join(current, component);
    let exists = true;
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) {
      mkdirSync(current, { mode: 0o700 });
      deps.chmod(current, 0o700);
      const identity = requireOwnedPrivateDirectory(current, deps);
      directoryChain.push(identity);
      fsyncDirectoryRequired(parent, deps);
    } else {
      directoryChain.push(requireOwnedPrivateDirectory(current, deps));
    }
  }
  return {
    absolutePath,
    directoryPath: current,
    directoryChain,
  };
}

function revalidateArtifactDirectories(
  location: ArtifactLocation,
  deps: PublishDependencies,
): void {
  for (const identity of location.directoryChain) {
    requireOwnedPrivateDirectory(identity.path, deps, identity);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

function openUniqueTemp(
  dir: string,
  absolutePath: string,
): { readonly fd: number; readonly identity: OwnedPathIdentity } {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const nonce = randomBytes(8).toString("hex");
    const path = join(
      dir,
      `.${basename(absolutePath)}.tmp.${process.pid}.${nonce}`,
    );
    try {
      const flags =
        FS_CONSTANTS.O_WRONLY |
        FS_CONSTANTS.O_CREAT |
        FS_CONSTANTS.O_EXCL |
        (typeof FS_CONSTANTS.O_NOFOLLOW === "number"
          ? FS_CONSTANTS.O_NOFOLLOW
          : 0);
      const fd = openSync(path, flags, 0o600);
      const stat = fstatSync(fd);
      return { fd, identity: objectIdentity(path, stat) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new ConversationConversionError(
    "publish_failed",
    "failed to allocate a unique temporary artifact path",
    { path: absolutePath },
  );
}

function unlinkOwnedPath(identity: OwnedPathIdentity): boolean {
  let lexical: ReturnType<typeof lstatSync>;
  try {
    lexical = lstatSync(identity.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    lexical.isSymbolicLink() ||
    !lexical.isFile() ||
    !sameObject(identity, lexical)
  ) {
    return false;
  }
  unlinkSync(identity.path);
  return true;
}

function removeTrackedIdentity(
  identities: OwnedPathIdentity[],
  identity: OwnedPathIdentity,
): void {
  const index = identities.indexOf(identity);
  if (index >= 0) identities.splice(index, 1);
}

function validateExistingArtifact(
  absolutePath: string,
  bytes: Uint8Array,
): void {
  let fd: number | null = null;
  try {
    const lexical = lstatSync(absolutePath);
    if (
      lexical.isSymbolicLink() ||
      !lexical.isFile() ||
      !hasExpectedOwner(lexical) ||
      !hasExactMode(lexical, 0o600)
    ) {
      throw new Error("unsafe existing artifact");
    }
    const flags =
      FS_CONSTANTS.O_RDONLY |
      FS_CONSTANTS.O_NONBLOCK |
      (typeof FS_CONSTANTS.O_NOFOLLOW === "number"
        ? FS_CONSTANTS.O_NOFOLLOW
        : 0);
    fd = openSync(absolutePath, flags);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      !hasExpectedOwner(before) ||
      !hasExactMode(before, 0o600)
    ) {
      throw new Error("existing artifact changed identity");
    }
    const existing = readFileSync(fd);
    const after = fstatSync(fd);
    const finalLexical = lstatSync(absolutePath);
    if (
      !sameIdentity(fileIdentityOf(before), fileIdentityOf(after)) ||
      finalLexical.isSymbolicLink() ||
      !finalLexical.isFile() ||
      finalLexical.dev !== before.dev ||
      finalLexical.ino !== before.ino ||
      !hasExpectedOwner(finalLexical) ||
      !hasExactMode(finalLexical, 0o600) ||
      !Buffer.from(existing).equals(Buffer.from(bytes))
    ) {
      throw new Error("existing artifact is not an exact private match");
    }
  } catch {
    throw new ConversationConversionError(
      "publish_collision",
      "destination path is not an exact owned private artifact",
      { path: absolutePath },
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function publishOne(
  canonicalRoot: string,
  relativeArtifactPath: string,
  bytes: Uint8Array,
  created: OwnedPathIdentity[],
  tempPaths: OwnedPathIdentity[],
  deps: PublishDependencies,
): { readonly absolutePath: string; readonly status: "created" | "unchanged" } {
  const location = ensureArtifactLocation(
    canonicalRoot,
    relativeArtifactPath,
    deps,
  );
  const temp = openUniqueTemp(location.directoryPath, location.absolutePath);
  tempPaths.push(temp.identity);
  try {
    writeAll(temp.fd, bytes);
    deps.fchmod(temp.fd, 0o600);
    const preparedTemp = fstatSync(temp.fd);
    if (
      !preparedTemp.isFile() ||
      !sameObject(temp.identity, preparedTemp) ||
      !hasExpectedOwner(preparedTemp) ||
      !hasExactMode(preparedTemp, 0o600)
    ) {
      throw new ConversationConversionError(
        "publish_failed",
        "temporary artifact permissions or identity are unsafe",
        { path: temp.identity.path },
      );
    }
    deps.fsync(temp.fd, { kind: "file", path: temp.identity.path });
    revalidateArtifactDirectories(location, deps);
    try {
      linkSync(temp.identity.path, location.absolutePath);
      created.push({
        path: location.absolutePath,
        dev: preparedTemp.dev,
        ino: preparedTemp.ino,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ConversationConversionError(
          "publish_failed",
          "failed to publish output artifact",
          { path: location.absolutePath },
        );
      }
      revalidateArtifactDirectories(location, deps);
      validateExistingArtifact(location.absolutePath, bytes);
      if (!unlinkOwnedPath(temp.identity)) {
        throw new ConversationConversionError(
          "publish_failed",
          "temporary artifact changed before cleanup",
          { path: temp.identity.path },
        );
      }
      removeTrackedIdentity(tempPaths, temp.identity);
      fsyncDirectoryRequired(location.directoryPath, deps);
      return { absolutePath: location.absolutePath, status: "unchanged" };
    }

    const finalIdentity = created.at(-1) as OwnedPathIdentity;
    const finalStat = lstatSync(location.absolutePath);
    if (
      finalStat.isSymbolicLink() ||
      !finalStat.isFile() ||
      !sameObject(finalIdentity, finalStat)
    ) {
      throw new ConversationConversionError(
        "publish_failed",
        "published artifact changed identity",
        { path: location.absolutePath },
      );
    }
    if (!unlinkOwnedPath(temp.identity)) {
      throw new ConversationConversionError(
        "publish_failed",
        "temporary artifact changed before cleanup",
        { path: temp.identity.path },
      );
    }
    removeTrackedIdentity(tempPaths, temp.identity);
    fsyncDirectoryRequired(location.directoryPath, deps);
    const durableFinal = lstatSync(location.absolutePath);
    if (
      durableFinal.isSymbolicLink() ||
      !durableFinal.isFile() ||
      !sameObject(finalIdentity, durableFinal)
    ) {
      throw new ConversationConversionError(
        "publish_failed",
        "published artifact changed before durability confirmation",
        { path: location.absolutePath },
      );
    }
    return { absolutePath: location.absolutePath, status: "created" };
  } finally {
    closeSync(temp.fd);
  }
}

function changedSource(path: string): ConversationConversionError {
  return new ConversationConversionError(
    "source_changed_during_read",
    "source family changed after its stable discovery snapshot",
    { path },
  );
}

function preflightRegularFileSize(path: string): number {
  try {
    const lexical = lstatSync(path);
    if (!lexical.isFile() || lexical.isSymbolicLink()) {
      throw new ConversationConversionError(
        "source_not_regular",
        "source path must be a regular file",
        { path },
      );
    }
    return lexical.size;
  } catch (error) {
    if (error instanceof ConversationConversionError) throw error;
    throw new ConversationConversionError(
      "source_read_failed",
      error instanceof Error ? error.message : "source preflight failed",
      { path },
    );
  }
}

function revalidateSourceFamilySnapshot(
  snapshot: ClaudeToPiSourceFamilySnapshot,
): void {
  for (const file of snapshot.files) {
    let lexical: ReturnType<typeof lstatSync>;
    try {
      lexical = lstatSync(file.path);
    } catch {
      throw changedSource(file.path);
    }
    if (
      !lexical.isFile() ||
      lexical.isSymbolicLink() ||
      !sameIdentity(file.identity, fileIdentityOf(lexical))
    ) {
      throw changedSource(file.path);
    }
  }
  let discovered: DiscoveredSubagentFile[];
  try {
    discovered = discoverSubagentFiles(snapshot.mainPath);
  } catch (error) {
    if (
      error instanceof ConversationConversionError &&
      error.code === "source_too_large"
    ) {
      throw changedSource(error.path ?? snapshot.mainPath);
    }
    throw error;
  }
  const expected = snapshot.files
    .filter((file) => file.streamKey !== "main")
    .map((file) => `${file.streamKey}\u0000${file.path}`);
  const actual = discovered.map(
    (file) => `${file.streamKey}\u0000${file.path}`,
  );
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    throw changedSource(snapshot.mainPath);
  }
}

function publicationDepth(
  session: PreparedClaudeToPiSession,
  bySourceKey: ReadonlyMap<string, PreparedClaudeToPiSession>,
): number {
  let depth = 0;
  let currentSession: PreparedClaudeToPiSession | undefined = session;
  const seen = new Set<string>();
  while (
    currentSession !== undefined &&
    currentSession.parentRelation !== null
  ) {
    if (seen.has(currentSession.sourceKey)) break;
    seen.add(currentSession.sourceKey);
    depth += 1;
    currentSession = bySourceKey.get(
      currentSession.parentRelation.parentSourceKey,
    );
  }
  return depth;
}

export function prepareClaudeToPiConversion(
  options: ClaudeToPiPrepareOptions,
): PreparedClaudeToPiConversion {
  const mainPath = resolve(options.claudeMainPath);
  if (
    options.expectedSourceMainId !== undefined &&
    options.expectedSourceMainId.length === 0
  ) {
    throw new ConversationConversionError(
      "invalid_argument",
      "expected source Session id must not be empty",
      { path: mainPath },
    );
  }
  if (!mainPath.endsWith(".jsonl")) {
    throw new ConversationConversionError(
      "invalid_argument",
      "main transcript path must end with .jsonl",
      { path: mainPath },
    );
  }
  const discoveredChildren = discoverSubagentFiles(mainPath);
  const mainPreflightBytes = preflightRegularFileSize(mainPath);
  validateClaudeToPiFamilyBounds({
    streamCount: discoveredChildren.length + 1,
    maxSubagentDepth: discoveredChildren.reduce(
      (max, child) => Math.max(max, child.depth),
      0,
    ),
    totalBytes:
      mainPreflightBytes +
      discoveredChildren.reduce((sum, child) => sum + child.byteLength, 0),
  });
  const mainStream = readStrictJsonlFile(
    mainPath,
    "main",
    options.onAfterSourceRead,
    CLAUDE_TO_PI_MAX_FAMILY_BYTES,
    options.expectedSourceMainId,
  );
  let retainedFamilyBytes = mainStream.byteLength;
  const childStreams = discoveredChildren.map((child) => {
    const stream = readStrictJsonlFile(
      child.path,
      child.streamKey,
      options.onAfterSourceRead,
      CLAUDE_TO_PI_MAX_FAMILY_BYTES - retainedFamilyBytes,
    );
    retainedFamilyBytes += stream.byteLength;
    return stream;
  });
  const streams = [mainStream, ...childStreams];
  validateClaudeToPiFamilyBounds({
    streamCount: streams.length,
    maxSubagentDepth: discoveredChildren.reduce(
      (max, child) => Math.max(max, child.depth),
      0,
    ),
    totalBytes: streams.reduce((sum, stream) => sum + stream.byteLength, 0),
  });
  const inferredRelations = resolveStreamRelations(streams);
  const relationResolution = breakSubagentRelationCycles(
    inferredRelations.relations,
  );
  const relationMap = relationResolution.relationMap;
  const relationWarnings = new Map<string, WarningCode[]>();
  for (const sourceKey of inferredRelations.ambiguousSourceKeys) {
    relationWarnings.set(sourceKey, ["ambiguous_subagent_relation"]);
  }
  for (const sourceKey of relationResolution.cycleSourceKeys) {
    const warnings = relationWarnings.get(sourceKey) ?? [];
    relationWarnings.set(sourceKey, [...warnings, "subagent_relation_cycle"]);
  }
  const rootPiSessionId = sessionUuidFor(mainStream.sessionId, "main");
  const manifestPath = join(
    "conversation-imports",
    "claude-to-pi",
    `${rootPiSessionId}.json`,
  )
    .split("\\")
    .join("/");
  const sessionBySourceKey = new Map<string, PreparedClaudeToPiSession>();
  const preparedSessions = streams.map((stream) => {
    const relation = relationMap.get(stream.streamKey) ?? null;
    const parentPiSessionId =
      relation !== null
        ? (sessionBySourceKey.get(relation.parentSourceKey)?.piSessionId ??
          sessionUuidFor(mainStream.sessionId, relation.parentSourceKey))
        : null;
    const prepared = prepareStreamSession(
      stream,
      mainStream.sessionId,
      manifestPath,
      relation,
      parentPiSessionId,
      mainStream.cwd ?? "/",
      relationWarnings.get(stream.streamKey) ?? [],
    );
    sessionBySourceKey.set(stream.streamKey, prepared);
    return prepared;
  });
  const manifestStreams: ClaudeToPiManifestStream[] = preparedSessions.map(
    (session) => ({
      sourceKey: session.sourceKey,
      agentId: session.agentId,
      parentRelation: session.parentRelation,
      digest: session.sourceDigest,
      lineCount: session.sourceLineCount,
      entryCount: session.entryCount,
      warningCodes: session.warningCodes,
      destinationPath: session.destinationPath,
    }),
  );
  const warningCodes = stableSortedWarnings(
    new Set(manifestStreams.flatMap((stream) => [...stream.warningCodes])),
  );
  const manifest: ClaudeToPiManifest = {
    schemaVersion: CLAUDE_TO_PI_MANIFEST_SCHEMA_VERSION,
    mappingVersion: CLAUDE_TO_PI_MAPPING_VERSION,
    sourceMainId: mainStream.sessionId,
    sourceMainPath: mainPath,
    sourceMainDigest: mainStream.digest,
    rootPiSessionId,
    manifestPath,
    streams: manifestStreams,
    warningCodes,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const sourceSnapshot: ClaudeToPiSourceFamilySnapshot = {
    mainPath,
    files: streams.map((stream) => ({
      path: stream.path,
      streamKey: stream.streamKey,
      identity: stream.identity,
      byteLength: stream.byteLength,
    })),
  };
  const prepared: PreparedClaudeToPiConversion = {
    mappingVersion: CLAUDE_TO_PI_MAPPING_VERSION,
    piAgentDir: resolve(options.piAgentDir),
    sourceMainPath: mainPath,
    sourceMainId: mainStream.sessionId,
    sourceMainDigest: mainStream.digest,
    rootPiSessionId,
    manifest,
    manifestBytes: Buffer.from(manifestText, "utf8"),
    manifestText,
    sessions: preparedSessions,
    sourceSnapshot,
  };
  revalidateSourceFamilySnapshot(sourceSnapshot);
  return prepared;
}

export function publishClaudeToPiConversion(
  prepared: PreparedClaudeToPiConversion,
  options: ClaudeToPiPublishOptions = {},
): PublishedClaudeToPiConversion {
  const dryRun = options.dryRun === true;
  const sessionByKey = new Map(
    prepared.sessions.map((session) => [session.sourceKey, session] as const),
  );
  const orderedSessions = prepared.sessions
    .slice()
    .sort(
      (a, b) =>
        Number(a.sourceKey === "main") - Number(b.sourceKey === "main") ||
        publicationDepth(b, sessionByKey) - publicationDepth(a, sessionByKey) ||
        compareCodeUnits(a.sourceKey, b.sourceKey),
    );
  revalidateSourceFamilySnapshot(prepared.sourceSnapshot);
  if (dryRun) {
    const plannedPath = (relativePath: string): string =>
      join(prepared.piAgentDir, ...safeArtifactParts(relativePath));
    return {
      dryRun: true,
      sessions: orderedSessions.map((session) => ({
        relativePath: session.destinationPath,
        absolutePath: plannedPath(session.destinationPath),
        status: "dry_run",
      })),
      manifest: {
        relativePath: prepared.manifest.manifestPath,
        absolutePath: plannedPath(prepared.manifest.manifestPath),
        status: "dry_run",
      },
    };
  }

  const deps = publishDependencies(options.publishDeps);
  const created: OwnedPathIdentity[] = [];
  const tempPaths: OwnedPathIdentity[] = [];
  let createdSequence = 0;
  try {
    const canonicalRoot = resolvePublicationRoot(prepared.piAgentDir, deps);
    const sessionResults: PublishedClaudeToPiArtifact[] = [];
    for (const session of orderedSessions) {
      validatePiV3SessionText(Buffer.from(session.bytes).toString("utf8"), {
        id: session.piSessionId,
        timestamp: session.sessionTimestamp,
        cwd: session.cwd,
      });
      const result = publishOne(
        canonicalRoot,
        session.destinationPath,
        session.bytes,
        created,
        tempPaths,
        deps,
      );
      sessionResults.push({
        relativePath: session.destinationPath,
        absolutePath: result.absolutePath,
        status: result.status,
      });
      if (result.status === "created") {
        deps.onAfterArtifactCreated?.({
          absolutePath: result.absolutePath,
          relativePath: session.destinationPath,
          kind: "session",
          sequence: createdSequence,
        });
        createdSequence += 1;
      }
    }
    const manifestResult = publishOne(
      canonicalRoot,
      prepared.manifest.manifestPath,
      prepared.manifestBytes,
      created,
      tempPaths,
      deps,
    );
    if (manifestResult.status === "created") {
      deps.onAfterArtifactCreated?.({
        absolutePath: manifestResult.absolutePath,
        relativePath: prepared.manifest.manifestPath,
        kind: "manifest",
        sequence: createdSequence,
      });
    }
    return {
      dryRun: false,
      sessions: sessionResults,
      manifest: {
        relativePath: prepared.manifest.manifestPath,
        absolutePath: manifestResult.absolutePath,
        status: manifestResult.status,
      },
    };
  } catch (error) {
    for (const tempPath of tempPaths.slice().reverse()) {
      try {
        if (unlinkOwnedPath(tempPath)) {
          fsyncDirectoryBestEffort(dirname(tempPath.path), deps);
        }
      } catch {
        // Best-effort identity-safe cleanup only.
      }
    }
    for (const artifact of created.slice().reverse()) {
      try {
        if (unlinkOwnedPath(artifact)) {
          fsyncDirectoryBestEffort(dirname(artifact.path), deps);
        }
      } catch {
        // Best-effort identity-safe rollback only.
      }
    }
    if (error instanceof ConversationConversionError) throw error;
    throw new ConversationConversionError(
      "publish_failed",
      error instanceof Error ? error.message : "publish failed",
    );
  }
}

export function convertClaudeToPi(
  options: ClaudeToPiConvertOptions,
): ConvertedClaudeToPiConversation {
  const prepared = prepareClaudeToPiConversion(options);
  const published = publishClaudeToPiConversion(prepared, options);
  return { prepared, published };
}

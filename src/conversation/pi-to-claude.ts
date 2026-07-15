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
import { encodeClaudeProject } from "../transcript/claude";
import { ConversationConversionError } from "./claude-to-pi";

export const PI_TO_CLAUDE_MAPPING_VERSION = 1;
export const PI_TO_CLAUDE_MANIFEST_SCHEMA_VERSION = 1;
export const PI_TO_CLAUDE_READ_CHUNK_BYTES = 64 * 1024;
export const PI_TO_CLAUDE_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const PI_TO_CLAUDE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const RAW_SHADOW_TYPE = "keeper.conversation.pi-record";
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

type JsonObject = Record<string, unknown>;

export type PiToClaudeWarningCode =
  | "assistant_error_stop"
  | "assistant_missing_model"
  | "assistant_thinking_raw_only"
  | "malformed_line"
  | "pi_entry_raw_only"
  | "tool_result_missing_call"
  | "unknown_assistant_block"
  | "unknown_message_role"
  | "unknown_pi_entry_type";

export interface PiToClaudeSourceReadEvent {
  readonly path: string;
  readonly digest: string;
  readonly lineCount: number;
  readonly byteLength: number;
}

export interface PiToClaudePrepareOptions {
  readonly piSessionPath: string;
  readonly claudeConfigDir: string;
  readonly expectedSourceSessionId?: string;
  readonly onAfterSourceRead?: (event: PiToClaudeSourceReadEvent) => void;
}

export interface PiToClaudePublishFsyncEvent {
  readonly kind: "directory" | "file";
  readonly path: string;
}

export interface PiToClaudePublishedArtifactEvent {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: "manifest" | "session";
  readonly sequence: number;
}

export interface PiToClaudePublishDeps {
  readonly chmodSync?: (path: string, mode: number) => void;
  readonly fchmodSync?: (fd: number, mode: number) => void;
  readonly fsyncSync?: (fd: number, event: PiToClaudePublishFsyncEvent) => void;
  readonly onAfterArtifactCreated?: (
    event: PiToClaudePublishedArtifactEvent,
  ) => void;
}

export interface PiToClaudePublishOptions {
  readonly dryRun?: boolean;
  readonly publishDeps?: PiToClaudePublishDeps;
}

export interface PiToClaudeConvertOptions
  extends PiToClaudePrepareOptions,
    PiToClaudePublishOptions {}

export interface PiToClaudeSourceIdentity {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: bigint | number;
  readonly mtimeMs: bigint | number;
  readonly ctimeMs: bigint | number;
}

export interface PiToClaudeSourceSnapshot {
  readonly path: string;
  readonly identity: PiToClaudeSourceIdentity;
  readonly byteLength: number;
}

export interface PiToClaudeManifest {
  readonly schemaVersion: number;
  readonly mappingVersion: number;
  readonly sourceSessionId: string;
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly sourceLineCount: number;
  readonly sourceCwd: string;
  readonly targetSessionId: string;
  readonly destinationPath: string;
  readonly manifestPath: string;
  readonly linkedRecordCount: number;
  readonly rawRecordCount: number;
  readonly warningCodes: readonly PiToClaudeWarningCode[];
}

export interface PreparedPiToClaudeSession {
  readonly sourceKey: "main";
  readonly agentId: null;
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly sourceLineCount: number;
  readonly claudeSessionId: string;
  readonly cwd: string;
  readonly sessionTimestamp: string;
  readonly destinationPath: string;
  readonly entryCount: number;
  readonly linkedRecordCount: number;
  readonly rawRecordCount: number;
  readonly warningCodes: readonly PiToClaudeWarningCode[];
  readonly parentRelation: null;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface PreparedPiToClaudeConversion {
  readonly mappingVersion: number;
  readonly claudeConfigDir: string;
  readonly sourceMainPath: string;
  readonly sourceMainId: string;
  readonly sourceMainDigest: string;
  readonly rootClaudeSessionId: string;
  readonly manifest: PiToClaudeManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestText: string;
  readonly sessions: readonly PreparedPiToClaudeSession[];
  readonly sourceSnapshot: PiToClaudeSourceSnapshot;
}

export interface PublishedPiToClaudeArtifact {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly status: "created" | "unchanged" | "dry_run";
}

export interface PublishedPiToClaudeConversion {
  readonly dryRun: boolean;
  readonly sessions: readonly PublishedPiToClaudeArtifact[];
  readonly manifest: PublishedPiToClaudeArtifact;
}

export interface ConvertedPiToClaudeConversation {
  readonly prepared: PreparedPiToClaudeConversion;
  readonly published: PublishedPiToClaudeConversion;
}

interface SourceLine {
  readonly ordinal: number;
  readonly rawUtf8: string;
  readonly digest: string;
  readonly parsed: JsonObject | null;
}

interface PiSourceDocument {
  readonly path: string;
  readonly identity: PiToClaudeSourceIdentity;
  readonly byteLength: number;
  readonly digest: string;
  readonly lines: readonly SourceLine[];
  readonly sessionId: string;
  readonly cwd: string;
  readonly timestamp: string;
  readonly entries: readonly PiEntryNode[];
}

interface PiEntryNode {
  readonly line: SourceLine;
  readonly raw: JsonObject;
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

interface NodePlan {
  readonly ownFirstUuid: string | null;
  readonly terminalUuid: string | null;
  readonly kind:
    | "none"
    | "user"
    | "assistant"
    | "tool_result"
    | "bash"
    | "custom_message"
    | "branch_summary"
    | "compaction";
  readonly toolCallOwnerUuid: string | null;
}

interface PreparedRecords {
  readonly records: readonly JsonObject[];
  readonly warnings: readonly PiToClaudeWarningCode[];
  readonly linkedRecordCount: number;
  readonly rawRecordCount: number;
  readonly activeLeafUuid: string | null;
}

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shaHex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(shaHex(seed).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function targetSessionUuid(sourceSessionId: string): string {
  return deterministicUuid(`keeper:pi-to-claude:session:${sourceSessionId}`);
}

function recordUuid(
  targetSessionId: string,
  sourceEntryId: string,
  suffix: string,
): string {
  return deterministicUuid(
    `keeper:pi-to-claude:record:${targetSessionId}:${sourceEntryId}:${suffix}`,
  );
}

function fileIdentityOf(
  stat: import("node:fs").Stats,
): PiToClaudeSourceIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(
  a: PiToClaudeSourceIdentity,
  b: PiToClaudeSourceIdentity,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function failValidation(message: string, path?: string): never {
  throw new ConversationConversionError("validation_failed", message, {
    path: path ?? null,
  });
}

function readStrictPiSession(
  path: string,
  options: PiToClaudePrepareOptions,
): PiSourceDocument {
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
    const flags =
      FS_CONSTANTS.O_RDONLY |
      FS_CONSTANTS.O_NONBLOCK |
      (typeof FS_CONSTANTS.O_NOFOLLOW === "number"
        ? FS_CONSTANTS.O_NOFOLLOW
        : 0);
    fd = openSync(path, flags);
    const beforeStat = fstatSync(fd);
    if (!beforeStat.isFile()) {
      throw new ConversationConversionError(
        "source_not_regular",
        "source path must be a regular file",
        { path },
      );
    }
    if (beforeStat.size > PI_TO_CLAUDE_MAX_FILE_BYTES) {
      throw new ConversationConversionError(
        "source_too_large",
        "source file exceeds supported size",
        { path },
      );
    }
    const before = fileIdentityOf(beforeStat);
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunk = Buffer.allocUnsafe(PI_TO_CLAUDE_READ_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let totalBytes = 0;
    const lines: SourceLine[] = [];
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const current = chunk.subarray(0, count);
      totalBytes += current.length;
      hash.update(current);
      if (totalBytes > PI_TO_CLAUDE_MAX_FILE_BYTES) {
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
          if (pending.length > PI_TO_CLAUDE_MAX_LINE_BYTES) {
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
        if (lineBytes.length > PI_TO_CLAUDE_MAX_LINE_BYTES) {
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
        const parseText =
          lines.length === 0 && rawUtf8.startsWith("\uFEFF")
            ? rawUtf8.slice(1)
            : rawUtf8;
        let parsed: JsonObject | null;
        try {
          parsed = asRecord(JSON.parse(parseText));
        } catch {
          parsed = null;
        }
        lines.push({
          ordinal: lines.length,
          rawUtf8,
          digest: shaHex(lineBytes),
          parsed,
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
    options.onAfterSourceRead?.({
      path,
      digest,
      lineCount: lines.length,
      byteLength: totalBytes,
    });
    const after = fileIdentityOf(fstatSync(fd));
    if (!sameFileIdentity(before, after)) {
      throw new ConversationConversionError(
        "source_changed_during_read",
        "source transcript changed during read",
        { path },
      );
    }
    if (lines.length === 0) failValidation("Pi session is empty", path);
    const header = lines[0]?.parsed;
    if (header === null || asString(header.type) !== "session") {
      failValidation("Pi session must begin with a session header", path);
    }
    const version = asFiniteNumber(header.version);
    if (version !== 2 && version !== 3) {
      failValidation(
        "Pi session must use native tree format version 2 or 3",
        path,
      );
    }
    const headerSessionId = asString(header.id);
    if (headerSessionId === null) {
      failValidation("Pi session header is missing its native id", path);
    }
    if (
      options.expectedSourceSessionId !== undefined &&
      options.expectedSourceSessionId !== headerSessionId
    ) {
      failValidation(
        "Pi session header id does not match the resolved Session",
        path,
      );
    }
    const cwd = asString(header.cwd);
    if (cwd === null || !isAbsolute(cwd)) {
      failValidation("Pi session header cwd must be absolute", path);
    }
    const timestamp = isoTimestamp(header.timestamp);
    if (timestamp === null) {
      failValidation("Pi session header timestamp is invalid", path);
    }
    const entries: PiEntryNode[] = [];
    const ids = new Set<string>();
    for (const line of lines.slice(1)) {
      const raw = line.parsed;
      if (raw === null) continue;
      if (asString(raw.type) === "session") {
        failValidation("Pi session contains a second session header", path);
      }
      const type = asString(raw.type);
      const id = asString(raw.id);
      const entryTimestamp = isoTimestamp(raw.timestamp);
      const parentId = raw.parentId === null ? null : asString(raw.parentId);
      if (
        type === null ||
        id === null ||
        entryTimestamp === null ||
        (raw.parentId !== null && parentId === null)
      ) {
        continue;
      }
      if (ids.has(id)) failValidation(`duplicate Pi entry id '${id}'`, path);
      ids.add(id);
      entries.push({
        line,
        raw,
        type,
        id,
        parentId,
        timestamp: entryTimestamp,
      });
    }
    validatePiGraph(entries, path);
    return {
      path,
      identity: before,
      byteLength: totalBytes,
      digest,
      lines,
      sessionId: options.expectedSourceSessionId ?? headerSessionId,
      cwd: resolve(cwd),
      timestamp,
      entries,
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

function validatePiGraph(entries: readonly PiEntryNode[], path: string): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      failValidation(
        `dangling Pi parent link '${entry.id}' -> '${entry.parentId}'`,
        path,
      );
    }
  }
  const settled = new Set<string>();
  for (const entry of entries) {
    if (settled.has(entry.id)) continue;
    const walking = new Set<string>();
    let current: PiEntryNode | undefined = entry;
    while (current !== undefined && !settled.has(current.id)) {
      if (walking.has(current.id)) {
        failValidation(`cycle detected at Pi entry '${current.id}'`, path);
      }
      walking.add(current.id);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of walking) settled.add(id);
  }
  for (const entry of entries) {
    if (entry.type === "leaf") {
      const targetId =
        entry.raw.targetId === null ? null : asString(entry.raw.targetId);
      if (
        entry.raw.targetId !== null &&
        (targetId === null || !byId.has(targetId))
      ) {
        failValidation(`Pi leaf '${entry.id}' has an invalid target`, path);
      }
    }
    if (entry.type !== "compaction") continue;
    const keptId = asString(entry.raw.firstKeptEntryId);
    if (keptId === null || entry.parentId === null || !byId.has(keptId)) {
      failValidation(
        `Pi compaction '${entry.id}' has an invalid kept entry`,
        path,
      );
    }
    let cursor: PiEntryNode | undefined = byId.get(entry.parentId);
    let found = false;
    while (cursor !== undefined) {
      if (cursor.id === keptId) {
        found = true;
        break;
      }
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (!found) {
      failValidation(
        `Pi compaction '${entry.id}' kept entry is not ancestral`,
        path,
      );
    }
  }
}

function envelope(
  source: PiSourceDocument,
  targetSessionId: string,
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
): JsonObject {
  return {
    uuid,
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: source.cwd,
    sessionId: targetSessionId,
    gitBranch: "",
    entrypoint: "cli",
    timestamp,
  };
}

function convertContentBlocks(
  content: unknown,
  warnings: Set<PiToClaudeWarningCode>,
): JsonObject[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: JsonObject[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null) continue;
    const type = asString(block.type);
    if (type === "text") {
      blocks.push({
        type: "text",
        text: typeof block.text === "string" ? block.text : "",
      });
      continue;
    }
    if (type === "image") {
      const data = asString(block.data);
      const mimeType = asString(block.mimeType);
      if (data !== null && mimeType !== null) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mimeType, data },
        });
      }
      continue;
    }
    warnings.add("pi_entry_raw_only");
  }
  return blocks;
}

function assistantToolCalls(entry: PiEntryNode): Map<string, string> {
  const calls = new Map<string, string>();
  const message = asRecord(entry.raw.message);
  if (asString(message?.role) !== "assistant") return calls;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (asString(block?.type) !== "toolCall") continue;
    const id = asString(block?.id);
    const name = asString(block?.name);
    if (id !== null && name !== null) calls.set(id, name);
  }
  return calls;
}

function ancestralToolOwner(
  node: PiEntryNode,
  toolCallId: string,
  byId: ReadonlyMap<string, PiEntryNode>,
): PiEntryNode | null {
  let current = node.parentId === null ? undefined : byId.get(node.parentId);
  while (current !== undefined) {
    if (assistantToolCalls(current).has(toolCallId)) return current;
    current =
      current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return null;
}

function nodeKind(
  node: PiEntryNode,
  byId: ReadonlyMap<string, PiEntryNode>,
  warnings: Set<PiToClaudeWarningCode>,
): NodePlan["kind"] {
  if (node.type === "compaction") return "compaction";
  if (node.type === "branch_summary") return "branch_summary";
  if (node.type === "custom_message") return "custom_message";
  if (node.type !== "message") return "none";
  const message = asRecord(node.raw.message);
  const role = asString(message?.role);
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "bashExecution") {
    return message?.excludeFromContext === true ? "none" : "bash";
  }
  if (role === "toolResult") {
    const callId = asString(message?.toolCallId);
    if (callId === null || ancestralToolOwner(node, callId, byId) === null) {
      warnings.add("tool_result_missing_call");
      return "none";
    }
    return "tool_result";
  }
  warnings.add("unknown_message_role");
  return "none";
}

function buildPlans(
  source: PiSourceDocument,
  targetSessionId: string,
  warnings: Set<PiToClaudeWarningCode>,
): Map<string, NodePlan> {
  const byId = new Map(
    source.entries.map((entry) => [entry.id, entry] as const),
  );
  const plans = new Map<string, NodePlan>();
  const resolving = new Set<string>();
  const resolvePlan = (node: PiEntryNode): NodePlan => {
    const existing = plans.get(node.id);
    if (existing !== undefined) return existing;
    if (resolving.has(node.id))
      failValidation("Pi graph contains a cycle", source.path);
    resolving.add(node.id);
    const parentPlan =
      node.parentId === null
        ? null
        : resolvePlan(byId.get(node.parentId) as PiEntryNode);
    const kind = nodeKind(node, byId, warnings);
    const ownFirstUuid =
      kind === "none"
        ? null
        : recordUuid(
            targetSessionId,
            node.id,
            kind === "compaction" ? "compact-boundary" : "message",
          );
    const terminalUuid =
      kind === "none"
        ? (parentPlan?.terminalUuid ?? null)
        : kind === "compaction"
          ? recordUuid(targetSessionId, node.id, "compact-summary")
          : ownFirstUuid;
    let toolCallOwnerUuid: string | null = null;
    if (kind === "tool_result") {
      const message = asRecord(node.raw.message);
      const callId = asString(message?.toolCallId) as string;
      const owner = ancestralToolOwner(node, callId, byId) as PiEntryNode;
      toolCallOwnerUuid = resolvePlan(owner).ownFirstUuid;
    }
    const plan: NodePlan = {
      ownFirstUuid,
      terminalUuid,
      kind,
      toolCallOwnerUuid,
    };
    plans.set(node.id, plan);
    resolving.delete(node.id);
    return plan;
  };
  for (const entry of source.entries) resolvePlan(entry);
  return plans;
}

function assistantContent(
  message: JsonObject,
  warnings: Set<PiToClaudeWarningCode>,
): JsonObject[] {
  const blocks: JsonObject[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null) continue;
    const type = asString(block.type);
    if (type === "text") {
      blocks.push({
        type: "text",
        text: typeof block.text === "string" ? block.text : "",
      });
      continue;
    }
    if (type === "thinking") {
      warnings.add("assistant_thinking_raw_only");
      continue;
    }
    if (type === "toolCall") {
      const id = asString(block.id);
      const name = asString(block.name);
      const input = asRecord(block.arguments);
      if (id !== null && name !== null && input !== null) {
        blocks.push({
          type: "tool_use",
          id,
          name,
          input,
          caller: { type: "direct" },
        });
      } else {
        warnings.add("unknown_assistant_block");
      }
      continue;
    }
    warnings.add("unknown_assistant_block");
  }
  return blocks;
}

function assistantUsage(message: JsonObject): JsonObject {
  const usage = asRecord(message.usage);
  return {
    input_tokens: Math.max(0, asFiniteNumber(usage?.input) ?? 0),
    output_tokens: Math.max(0, asFiniteNumber(usage?.output) ?? 0),
    cache_creation_input_tokens: Math.max(
      0,
      asFiniteNumber(usage?.cacheWrite) ?? 0,
    ),
    cache_read_input_tokens: Math.max(0, asFiniteNumber(usage?.cacheRead) ?? 0),
  };
}

function claudeStopReason(
  value: unknown,
  warnings: Set<PiToClaudeWarningCode>,
): string | null {
  if (value === "stop") return "end_turn";
  if (value === "toolUse") return "tool_use";
  if (value === "length") return "max_tokens";
  if (value === "error" || value === "aborted") {
    warnings.add("assistant_error_stop");
    return null;
  }
  return null;
}

function bashExecutionText(message: JsonObject): string {
  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  let text = `Ran \`${command}\`\n`;
  text += output.length > 0 ? `\`\`\`\n${output}\n\`\`\`` : "(no output)";
  if (message.cancelled === true) {
    text += "\n\n(command cancelled)";
  } else {
    const exitCode = asFiniteNumber(message.exitCode);
    if (exitCode !== null && exitCode !== 0) {
      text += `\n\nCommand exited with code ${exitCode}`;
    }
  }
  if (message.truncated === true && asString(message.fullOutputPath) !== null) {
    text += `\n\n[Output truncated. Full output: ${asString(message.fullOutputPath)}]`;
  }
  return text;
}

function compactionHeadUuid(
  node: PiEntryNode,
  source: PiSourceDocument,
  plans: ReadonlyMap<string, NodePlan>,
): string {
  const byId = new Map(
    source.entries.map((entry) => [entry.id, entry] as const),
  );
  const keptId = asString(node.raw.firstKeptEntryId) as string;
  const reversed: PiEntryNode[] = [];
  let cursor = byId.get(node.parentId as string);
  while (cursor !== undefined) {
    reversed.push(cursor);
    if (cursor.id === keptId) break;
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  reversed.reverse();
  for (const entry of reversed) {
    const uuid = plans.get(entry.id)?.ownFirstUuid ?? null;
    if (uuid !== null) return uuid;
  }
  failValidation(
    `Pi compaction '${node.id}' retains no contextual entry`,
    source.path,
  );
}

function semanticRecordsForNode(
  node: PiEntryNode,
  source: PiSourceDocument,
  targetSessionId: string,
  plans: ReadonlyMap<string, NodePlan>,
  warnings: Set<PiToClaudeWarningCode>,
): JsonObject[] {
  const plan = plans.get(node.id) as NodePlan;
  if (plan.kind === "none" || plan.ownFirstUuid === null) return [];
  const parentUuid =
    node.parentId === null
      ? null
      : (plans.get(node.parentId)?.terminalUuid ?? null);
  const base = envelope(
    source,
    targetSessionId,
    plan.ownFirstUuid,
    parentUuid,
    node.timestamp,
  );
  if (plan.kind === "user") {
    const message = asRecord(node.raw.message) as JsonObject;
    return [
      {
        type: "user",
        ...base,
        message: {
          role: "user",
          content: convertContentBlocks(message.content, warnings),
        },
      },
    ];
  }
  if (plan.kind === "assistant") {
    const message = asRecord(node.raw.message) as JsonObject;
    const model = asString(message.model);
    if (model === null) warnings.add("assistant_missing_model");
    return [
      {
        type: "assistant",
        ...base,
        requestId: `req_${plan.ownFirstUuid.replaceAll("-", "")}`,
        message: {
          id: `msg_${plan.ownFirstUuid.replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model: model ?? "unknown",
          content: assistantContent(message, warnings),
          stop_reason: claudeStopReason(message.stopReason, warnings),
          stop_sequence: null,
          usage: assistantUsage(message),
        },
      },
    ];
  }
  if (plan.kind === "tool_result") {
    const message = asRecord(node.raw.message) as JsonObject;
    return [
      {
        type: "user",
        ...base,
        sourceToolAssistantUUID: plan.toolCallOwnerUuid,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: asString(message.toolCallId),
              is_error: message.isError === true,
              content: convertContentBlocks(message.content, warnings),
            },
          ],
        },
      },
    ];
  }
  if (plan.kind === "bash") {
    const message = asRecord(node.raw.message) as JsonObject;
    return [
      {
        type: "user",
        ...base,
        message: {
          role: "user",
          content: [{ type: "text", text: bashExecutionText(message) }],
        },
      },
    ];
  }
  if (plan.kind === "custom_message") {
    return [
      {
        type: "user",
        ...base,
        message: {
          role: "user",
          content: convertContentBlocks(node.raw.content, warnings),
        },
      },
    ];
  }
  if (plan.kind === "branch_summary") {
    const summary =
      typeof node.raw.summary === "string" ? node.raw.summary : "";
    return [
      {
        type: "user",
        ...base,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX,
            },
          ],
        },
      },
    ];
  }
  const summaryUuid = plan.terminalUuid as string;
  const headUuid = compactionHeadUuid(node, source, plans);
  const tokensBefore = Math.max(0, asFiniteNumber(node.raw.tokensBefore) ?? 0);
  return [
    {
      type: "system",
      ...base,
      parentUuid: null,
      logicalParentUuid: parentUuid,
      subtype: "compact_boundary",
      content: "Conversation compacted",
      isMeta: false,
      level: "info",
      compactMetadata: {
        trigger: "manual",
        preTokens: tokensBefore,
        preservedSegment: { headUuid },
      },
    },
    {
      type: "user",
      ...envelope(
        source,
        targetSessionId,
        summaryUuid,
        plan.ownFirstUuid,
        node.timestamp,
      ),
      isCompactSummary: true,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: typeof node.raw.summary === "string" ? node.raw.summary : "",
          },
        ],
      },
    },
  ];
}

function titleRecord(
  node: PiEntryNode,
  source: PiSourceDocument,
  targetSessionId: string,
): JsonObject | null {
  if (node.type !== "session_info") return null;
  const name = asString(node.raw.name);
  if (name === null) return null;
  return {
    type: "custom-title",
    ...envelope(
      source,
      targetSessionId,
      recordUuid(targetSessionId, node.id, "title"),
      null,
      node.timestamp,
    ),
    customTitle: name,
  };
}

function rawShadowRecord(
  line: SourceLine,
  source: PiSourceDocument,
  targetSessionId: string,
): JsonObject {
  const parsed = line.parsed;
  return {
    type: RAW_SHADOW_TYPE,
    schemaVersion: 1,
    mappingVersion: PI_TO_CLAUDE_MAPPING_VERSION,
    sessionId: targetSessionId,
    cwd: source.cwd,
    timestamp:
      isoTimestamp(parsed?.timestamp) ?? source.timestamp ?? DEFAULT_TIMESTAMP,
    sourceSessionId: source.sessionId,
    lineOrdinal: line.ordinal + 1,
    lineDigest: line.digest,
    sourceType: asString(parsed?.type) ?? "malformed",
    sourceEntryId: asString(parsed?.id),
    sourceParentId:
      parsed?.parentId === null ? null : (asString(parsed?.parentId) ?? null),
    rawUtf8: line.rawUtf8,
  };
}

function prepareClaudeRecords(
  source: PiSourceDocument,
  targetSessionId: string,
): PreparedRecords {
  const warnings = new Set<PiToClaudeWarningCode>();
  for (const line of source.lines) {
    if (line.parsed === null) warnings.add("malformed_line");
  }
  const plans = buildPlans(source, targetSessionId, warnings);
  const semantic: JsonObject[] = [];
  let linkedRecordCount = 0;
  const knownRawOnly = new Set([
    "custom",
    "label",
    "leaf",
    "model_change",
    "session_info",
    "thinking_level_change",
  ]);
  const knownContext = new Set([
    "branch_summary",
    "compaction",
    "custom_message",
    "message",
  ]);
  for (const node of source.entries) {
    const title = titleRecord(node, source, targetSessionId);
    if (title !== null) semantic.push(title);
    const records = semanticRecordsForNode(
      node,
      source,
      targetSessionId,
      plans,
      warnings,
    );
    semantic.push(...records);
    linkedRecordCount += records.length;
    if (knownRawOnly.has(node.type)) {
      warnings.add("pi_entry_raw_only");
    } else if (!knownContext.has(node.type)) {
      warnings.add("unknown_pi_entry_type");
    }
  }
  const raw = source.lines.map((line) =>
    rawShadowRecord(line, source, targetSessionId),
  );
  const lastEntry = source.entries.at(-1);
  const activeSourceId =
    lastEntry?.type === "leaf"
      ? lastEntry.raw.targetId === null
        ? null
        : asString(lastEntry.raw.targetId)
      : (lastEntry?.id ?? null);
  const activeLeafUuid =
    activeSourceId === null
      ? null
      : (plans.get(activeSourceId)?.terminalUuid ?? null);
  const records = [...semantic, ...raw];
  if (activeLeafUuid !== null) {
    records.push({
      type: "last-prompt",
      leafUuid: activeLeafUuid,
      explicit: true,
      sessionId: targetSessionId,
      cwd: source.cwd,
      timestamp: lastEntry?.timestamp ?? source.timestamp,
    });
  }
  return {
    records,
    warnings: [...warnings].sort(compareCodeUnits),
    linkedRecordCount,
    rawRecordCount: raw.length,
    activeLeafUuid,
  };
}

function stringifyRecords(records: readonly JsonObject[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function linkedClaudeType(type: string | null): boolean {
  return type === "user" || type === "assistant" || type === "system";
}

export function validateClaudeConversationText(
  text: string,
  expectations: {
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly activeLeafUuid?: string | null;
  } = {},
): void {
  if (!text.endsWith("\n"))
    failValidation("Claude transcript must end with lf");
  const rawLines = text.slice(0, -1).split("\n");
  if (rawLines.length === 0 || rawLines.some((line) => line.length === 0)) {
    failValidation("Claude transcript contains an empty record line");
  }
  const records: JsonObject[] = [];
  for (const [index, line] of rawLines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      failValidation(`Claude record line ${index + 1} is not valid JSON`);
    }
    const record = asRecord(parsed);
    if (record === null) {
      failValidation(`Claude record line ${index + 1} is not an object`);
    }
    records.push(record);
  }
  const linked = new Map<string, JsonObject>();
  const allUuids = new Set<string>();
  for (const record of records) {
    if (
      expectations.sessionId !== undefined &&
      asString(record.sessionId) !== expectations.sessionId
    ) {
      failValidation("Claude record carries the wrong session id");
    }
    const uuid = asString(record.uuid);
    if (uuid !== null) {
      if (allUuids.has(uuid)) failValidation(`duplicate Claude uuid '${uuid}'`);
      allUuids.add(uuid);
    }
    const type = asString(record.type);
    if (!linkedClaudeType(type)) continue;
    if (uuid === null) failValidation("linked Claude record is missing uuid");
    if (
      expectations.cwd !== undefined &&
      asString(record.cwd) !== expectations.cwd
    ) {
      failValidation("linked Claude record carries the wrong cwd");
    }
    if (record.parentUuid !== null && asString(record.parentUuid) === null) {
      failValidation("linked Claude record has an invalid parentUuid");
    }
    const timestamp = isoTimestamp(record.timestamp);
    if (timestamp === null)
      failValidation("linked Claude timestamp is invalid");
    const message = asRecord(record.message);
    if ((type === "user" || type === "assistant") && message === null) {
      failValidation("Claude conversational record is missing message");
    }
    linked.set(uuid, record);
  }
  for (const [uuid, record] of linked) {
    const parentUuid =
      record.parentUuid === null ? null : asString(record.parentUuid);
    if (parentUuid !== null && !linked.has(parentUuid)) {
      failValidation(
        `dangling Claude parent link '${uuid}' -> '${parentUuid}'`,
      );
    }
    const seen = new Set<string>();
    let cursor: string | null = uuid;
    while (cursor !== null) {
      if (seen.has(cursor))
        failValidation(`cycle detected at Claude uuid '${cursor}'`);
      seen.add(cursor);
      const current = linked.get(cursor);
      cursor =
        current === undefined || current.parentUuid === null
          ? null
          : asString(current.parentUuid);
    }
  }
  const lastPrompts = records.filter(
    (record) => asString(record.type) === "last-prompt",
  );
  if (expectations.activeLeafUuid === null) {
    if (lastPrompts.length > 0)
      failValidation("empty Claude graph has a last-prompt");
  } else if (expectations.activeLeafUuid !== undefined) {
    if (lastPrompts.length !== 1 || records.at(-1) !== lastPrompts[0]) {
      failValidation("Claude transcript must end with exactly one last-prompt");
    }
    const leafUuid = asString(lastPrompts[0]?.leafUuid);
    if (
      leafUuid !== expectations.activeLeafUuid ||
      !linked.has(expectations.activeLeafUuid)
    ) {
      failValidation("Claude last-prompt does not select the active leaf");
    }
    if (lastPrompts[0]?.explicit !== true) {
      failValidation("Claude last-prompt must be explicit");
    }
  }
  for (const [uuid, record] of linked) {
    if (asString(record.type) !== "user") continue;
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (asString(block?.type) !== "tool_result") continue;
      const callId = asString(block?.tool_use_id);
      if (callId === null)
        failValidation("Claude tool result is missing tool id");
      let cursor =
        record.parentUuid === null ? null : asString(record.parentUuid);
      let found = false;
      while (cursor !== null) {
        const ancestor = linked.get(cursor);
        const ancestorMessage = asRecord(ancestor?.message);
        const ancestorContent = Array.isArray(ancestorMessage?.content)
          ? ancestorMessage.content
          : [];
        if (
          ancestorContent.some((candidate) => {
            const obj = asRecord(candidate);
            return (
              asString(obj?.type) === "tool_use" && asString(obj?.id) === callId
            );
          })
        ) {
          found = true;
          break;
        }
        cursor =
          ancestor === undefined || ancestor.parentUuid === null
            ? null
            : asString(ancestor.parentUuid);
      }
      if (!found) {
        failValidation(`Claude tool result '${uuid}' has no ancestral call`);
      }
    }
  }
}

function revalidateSourceSnapshot(snapshot: PiToClaudeSourceSnapshot): void {
  let current: PiToClaudeSourceIdentity;
  try {
    const lexical = lstatSync(snapshot.path);
    if (lexical.isSymbolicLink() || !lexical.isFile()) {
      throw new Error("source is not a regular file");
    }
    current = fileIdentityOf(lexical);
  } catch {
    throw new ConversationConversionError(
      "source_changed_during_read",
      "source transcript changed after snapshot",
      { path: snapshot.path },
    );
  }
  if (!sameFileIdentity(snapshot.identity, current)) {
    throw new ConversationConversionError(
      "source_changed_during_read",
      "source transcript changed after snapshot",
      { path: snapshot.path },
    );
  }
}

export function preparePiToClaudeConversion(
  options: PiToClaudePrepareOptions,
): PreparedPiToClaudeConversion {
  const sourcePath = resolve(options.piSessionPath);
  if (!sourcePath.endsWith(".jsonl")) {
    throw new ConversationConversionError(
      "invalid_argument",
      "Pi session path must end with .jsonl",
      { path: sourcePath },
    );
  }
  if (
    options.expectedSourceSessionId !== undefined &&
    options.expectedSourceSessionId.length === 0
  ) {
    throw new ConversationConversionError(
      "invalid_argument",
      "expected source Session id must not be empty",
      { path: sourcePath },
    );
  }
  const source = readStrictPiSession(sourcePath, options);
  const rootClaudeSessionId = targetSessionUuid(source.sessionId);
  const destinationPath = join(
    "projects",
    encodeClaudeProject(source.cwd),
    `${rootClaudeSessionId}.jsonl`,
  )
    .split("\\")
    .join("/");
  const manifestPath = join(
    "conversation-imports",
    "pi-to-claude",
    `${rootClaudeSessionId}.json`,
  )
    .split("\\")
    .join("/");
  const preparedRecords = prepareClaudeRecords(source, rootClaudeSessionId);
  if (
    preparedRecords.linkedRecordCount === 0 ||
    preparedRecords.activeLeafUuid === null
  ) {
    failValidation(
      "Pi session has no contextual entries to resume in Claude",
      sourcePath,
    );
  }
  const text = stringifyRecords(preparedRecords.records);
  validateClaudeConversationText(text, {
    sessionId: rootClaudeSessionId,
    cwd: source.cwd,
    activeLeafUuid: preparedRecords.activeLeafUuid,
  });
  const session: PreparedPiToClaudeSession = {
    sourceKey: "main",
    agentId: null,
    sourcePath,
    sourceDigest: source.digest,
    sourceLineCount: source.lines.length,
    claudeSessionId: rootClaudeSessionId,
    cwd: source.cwd,
    sessionTimestamp: source.timestamp,
    destinationPath,
    entryCount: preparedRecords.records.length,
    linkedRecordCount: preparedRecords.linkedRecordCount,
    rawRecordCount: preparedRecords.rawRecordCount,
    warningCodes: preparedRecords.warnings,
    parentRelation: null,
    bytes: Buffer.from(text, "utf8"),
    text,
  };
  const manifest: PiToClaudeManifest = {
    schemaVersion: PI_TO_CLAUDE_MANIFEST_SCHEMA_VERSION,
    mappingVersion: PI_TO_CLAUDE_MAPPING_VERSION,
    sourceSessionId: source.sessionId,
    sourcePath,
    sourceDigest: source.digest,
    sourceLineCount: source.lines.length,
    sourceCwd: source.cwd,
    targetSessionId: rootClaudeSessionId,
    destinationPath,
    manifestPath,
    linkedRecordCount: preparedRecords.linkedRecordCount,
    rawRecordCount: preparedRecords.rawRecordCount,
    warningCodes: preparedRecords.warnings,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const sourceSnapshot: PiToClaudeSourceSnapshot = {
    path: sourcePath,
    identity: source.identity,
    byteLength: source.byteLength,
  };
  const prepared: PreparedPiToClaudeConversion = {
    mappingVersion: PI_TO_CLAUDE_MAPPING_VERSION,
    claudeConfigDir: resolve(options.claudeConfigDir),
    sourceMainPath: sourcePath,
    sourceMainId: source.sessionId,
    sourceMainDigest: source.digest,
    rootClaudeSessionId,
    manifest,
    manifestBytes: Buffer.from(manifestText, "utf8"),
    manifestText,
    sessions: [session],
    sourceSnapshot,
  };
  revalidateSourceSnapshot(sourceSnapshot);
  return prepared;
}

interface PublishDependencies {
  readonly chmod: (path: string, mode: number) => void;
  readonly fchmod: (fd: number, mode: number) => void;
  readonly fsync: (fd: number, event: PiToClaudePublishFsyncEvent) => void;
  readonly onAfterArtifactCreated?: (
    event: PiToClaudePublishedArtifactEvent,
  ) => void;
}

interface OwnedIdentity {
  readonly path: string;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
}

const POSIX_PERMISSIONS =
  process.platform !== "win32" && typeof process.getuid === "function";

function publishDependencies(
  overrides: PiToClaudePublishDeps | undefined,
): PublishDependencies {
  return {
    chmod:
      overrides?.chmodSync ?? (POSIX_PERMISSIONS ? chmodSync : () => undefined),
    fchmod:
      overrides?.fchmodSync ??
      (POSIX_PERMISSIONS ? fchmodSync : () => undefined),
    fsync:
      overrides?.fsyncSync ??
      ((fd, _event) => {
        fsyncSync(fd);
      }),
    onAfterArtifactCreated: overrides?.onAfterArtifactCreated,
  };
}

function ownedIdentity(
  path: string,
  stat: import("node:fs").Stats,
): OwnedIdentity {
  return { path, dev: stat.dev, ino: stat.ino };
}

function sameObject(
  identity: OwnedIdentity,
  stat: import("node:fs").Stats,
): boolean {
  return identity.dev === stat.dev && identity.ino === stat.ino;
}

function expectedOwner(stat: import("node:fs").Stats): boolean {
  return !POSIX_PERMISSIONS || stat.uid === process.getuid?.();
}

function exactMode(stat: import("node:fs").Stats, mode: number): boolean {
  return !POSIX_PERMISSIONS || (stat.mode & 0o7777) === mode;
}

function fsyncDirectory(path: string, deps: PublishDependencies): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      FS_CONSTANTS.O_RDONLY |
        (typeof FS_CONSTANTS.O_DIRECTORY === "number"
          ? FS_CONSTANTS.O_DIRECTORY
          : 0),
    );
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
    fsyncDirectory(path, deps);
  } catch {
    // Cleanup durability cannot replace the original publication failure.
  }
}

function privateDirectory(
  path: string,
  deps: PublishDependencies,
  expected?: OwnedIdentity,
): OwnedIdentity {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !expectedOwner(before) ||
    (expected !== undefined && !sameObject(expected, before))
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "publication directory is not an owned real directory",
      { path },
    );
  }
  const identity = ownedIdentity(path, before);
  if (!exactMode(before, 0o700)) deps.chmod(path, 0o700);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameObject(identity, after) ||
    !expectedOwner(after) ||
    !exactMode(after, 0o700)
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "publication directory permissions or identity are unsafe",
      { path },
    );
  }
  return identity;
}

function resolvePublicationRoot(
  selectedRoot: string,
  deps: PublishDependencies,
): string {
  let created: OwnedIdentity | undefined;
  try {
    lstatSync(selectedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(selectedRoot, { recursive: true, mode: 0o700 });
    deps.chmod(selectedRoot, 0o700);
    created = privateDirectory(selectedRoot, deps);
    fsyncDirectory(dirname(selectedRoot), deps);
  }
  const canonical = realpathSync(selectedRoot);
  const stat = lstatSync(canonical);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !expectedOwner(stat) ||
    (POSIX_PERMISSIONS && (stat.mode & 0o022) !== 0) ||
    (created !== undefined && !sameObject(created, stat))
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "selected Claude root is not an owned, non-shared directory",
      { path: selectedRoot },
    );
  }
  return canonical;
}

function safeParts(relativePath: string): string[] {
  const parts = relativePath.split(/[\\/]/);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "artifact path escapes the resolved Claude root",
      { path: relativePath },
    );
  }
  return parts;
}

function ensureArtifactDirectory(
  root: string,
  relativePath: string,
  deps: PublishDependencies,
): { absolutePath: string; directoryChain: OwnedIdentity[] } {
  const parts = safeParts(relativePath);
  const absolutePath = resolve(root, ...parts);
  const rel = relative(root, absolutePath);
  if (
    rel.length === 0 ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new ConversationConversionError(
      "publish_failed",
      "artifact path escapes the resolved Claude root",
      { path: relativePath },
    );
  }
  const directoryChain: OwnedIdentity[] = [];
  let current = root;
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
      const identity = privateDirectory(current, deps);
      directoryChain.push(identity);
      fsyncDirectory(parent, deps);
    } else {
      directoryChain.push(privateDirectory(current, deps));
    }
  }
  return { absolutePath, directoryChain };
}

function verifyDirectoryChain(chain: readonly OwnedIdentity[]): void {
  for (const identity of chain) {
    const stat = lstatSync(identity.path);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !sameObject(identity, stat) ||
      !expectedOwner(stat) ||
      !exactMode(stat, 0o700)
    ) {
      throw new ConversationConversionError(
        "publish_failed",
        "publication directory changed during write",
        { path: identity.path },
      );
    }
  }
}

function exactPrivateFile(
  path: string,
  bytes: Uint8Array,
): OwnedIdentity | null {
  let lexical: import("node:fs").Stats;
  try {
    lexical = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let fd: number | null = null;
  try {
    if (
      lexical.isSymbolicLink() ||
      !lexical.isFile() ||
      !expectedOwner(lexical) ||
      !exactMode(lexical, 0o600) ||
      lexical.size !== bytes.byteLength
    ) {
      throw new Error("unsafe existing artifact");
    }
    fd = openSync(
      path,
      FS_CONSTANTS.O_RDONLY |
        FS_CONSTANTS.O_NONBLOCK |
        (typeof FS_CONSTANTS.O_NOFOLLOW === "number"
          ? FS_CONSTANTS.O_NOFOLLOW
          : 0),
    );
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.size !== bytes.byteLength ||
      !expectedOwner(before) ||
      !exactMode(before, 0o600)
    ) {
      throw new Error("existing artifact changed identity");
    }
    const existing = readFileSync(fd);
    const after = fstatSync(fd);
    const finalLexical = lstatSync(path);
    if (
      !sameFileIdentity(fileIdentityOf(before), fileIdentityOf(after)) ||
      finalLexical.isSymbolicLink() ||
      !finalLexical.isFile() ||
      finalLexical.dev !== before.dev ||
      finalLexical.ino !== before.ino ||
      !expectedOwner(finalLexical) ||
      !exactMode(finalLexical, 0o600) ||
      !Buffer.from(existing).equals(Buffer.from(bytes))
    ) {
      throw new Error("existing artifact is not an exact private match");
    }
    return ownedIdentity(path, before);
  } catch {
    throw new ConversationConversionError(
      "publish_collision",
      "destination path is not an exact owned private artifact",
      { path },
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  }
}

function openUniqueTemp(
  directory: string,
  destination: string,
): { readonly fd: number; readonly identity: OwnedIdentity } {
  const name = basename(destination);
  for (let attempt = 0; attempt < 32; attempt++) {
    const path = join(
      directory,
      `.${name}.keeper-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      const fd = openSync(
        path,
        FS_CONSTANTS.O_WRONLY |
          FS_CONSTANTS.O_CREAT |
          FS_CONSTANTS.O_EXCL |
          (typeof FS_CONSTANTS.O_NOFOLLOW === "number"
            ? FS_CONSTANTS.O_NOFOLLOW
            : 0),
        0o600,
      );
      return { fd, identity: ownedIdentity(path, fstatSync(fd)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new ConversationConversionError(
    "publish_failed",
    "failed to allocate a unique temporary artifact path",
    { path: destination },
  );
}

function unlinkOwned(identity: OwnedIdentity): boolean {
  let stat: import("node:fs").Stats;
  try {
    stat = lstatSync(identity.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!sameObject(identity, stat)) return false;
  unlinkSync(identity.path);
  return true;
}

function publishArtifact(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  kind: "manifest" | "session",
  sequence: number,
  deps: PublishDependencies,
  created: OwnedIdentity[],
  temps: OwnedIdentity[],
): PublishedPiToClaudeArtifact {
  const location = ensureArtifactDirectory(root, relativePath, deps);
  verifyDirectoryChain(location.directoryChain);
  const existing = exactPrivateFile(location.absolutePath, bytes);
  if (existing !== null) {
    return {
      relativePath,
      absolutePath: location.absolutePath,
      status: "unchanged",
    };
  }
  const directory = dirname(location.absolutePath);
  const temp = openUniqueTemp(directory, location.absolutePath);
  let fd: number | null = temp.fd;
  temps.push(temp.identity);
  const untrackTemp = (): void => {
    const index = temps.indexOf(temp.identity);
    if (index >= 0) temps.splice(index, 1);
  };
  try {
    deps.fchmod(temp.fd, 0o600);
    writeAll(temp.fd, bytes);
    deps.fsync(temp.fd, { kind: "file", path: temp.identity.path });
    const stat = fstatSync(temp.fd);
    if (
      !stat.isFile() ||
      !sameObject(temp.identity, stat) ||
      !expectedOwner(stat) ||
      !exactMode(stat, 0o600)
    ) {
      throw new Error("temporary artifact permissions are unsafe");
    }
    closeSync(temp.fd);
    fd = null;
    verifyDirectoryChain(location.directoryChain);
    try {
      linkSync(temp.identity.path, location.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        verifyDirectoryChain(location.directoryChain);
        exactPrivateFile(location.absolutePath, bytes);
        if (!unlinkOwned(temp.identity)) {
          throw new Error("temporary artifact changed before cleanup");
        }
        untrackTemp();
        fsyncDirectory(directory, deps);
        return {
          relativePath,
          absolutePath: location.absolutePath,
          status: "unchanged",
        };
      }
      throw error;
    }
    verifyDirectoryChain(location.directoryChain);
    const destinationStat = lstatSync(location.absolutePath);
    const destinationIdentity = ownedIdentity(
      location.absolutePath,
      destinationStat,
    );
    if (!sameObject(temp.identity, destinationStat)) {
      throw new Error("published artifact changed identity");
    }
    created.push(destinationIdentity);
    deps.onAfterArtifactCreated?.({
      absolutePath: location.absolutePath,
      relativePath,
      kind,
      sequence,
    });
    verifyDirectoryChain(location.directoryChain);
    fsyncDirectory(directory, deps);
    if (!unlinkOwned(temp.identity)) {
      throw new Error("temporary artifact changed before cleanup");
    }
    untrackTemp();
    fsyncDirectory(directory, deps);
    verifyDirectoryChain(location.directoryChain);
    exactPrivateFile(location.absolutePath, bytes);
    return {
      relativePath,
      absolutePath: location.absolutePath,
      status: "created",
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function publishPiToClaudeConversion(
  prepared: PreparedPiToClaudeConversion,
  options: PiToClaudePublishOptions = {},
): PublishedPiToClaudeConversion {
  revalidateSourceSnapshot(prepared.sourceSnapshot);
  const dryRun = options.dryRun === true;
  if (dryRun) {
    const planned = (relativePath: string): string =>
      join(prepared.claudeConfigDir, ...safeParts(relativePath));
    return {
      dryRun: true,
      sessions: prepared.sessions.map((session) => ({
        relativePath: session.destinationPath,
        absolutePath: planned(session.destinationPath),
        status: "dry_run",
      })),
      manifest: {
        relativePath: prepared.manifest.manifestPath,
        absolutePath: planned(prepared.manifest.manifestPath),
        status: "dry_run",
      },
    };
  }
  const deps = publishDependencies(options.publishDeps);
  const created: OwnedIdentity[] = [];
  const temps: OwnedIdentity[] = [];
  let canonicalRoot: string | null = null;
  try {
    const root = resolvePublicationRoot(prepared.claudeConfigDir, deps);
    canonicalRoot = root;
    revalidateSourceSnapshot(prepared.sourceSnapshot);
    const sessionResults = prepared.sessions.map((session, index) =>
      publishArtifact(
        root,
        session.destinationPath,
        session.bytes,
        "session",
        index,
        deps,
        created,
        temps,
      ),
    );
    revalidateSourceSnapshot(prepared.sourceSnapshot);
    const manifestResult = publishArtifact(
      root,
      prepared.manifest.manifestPath,
      prepared.manifestBytes,
      "manifest",
      prepared.sessions.length,
      deps,
      created,
      temps,
    );
    return {
      dryRun: false,
      sessions: sessionResults,
      manifest: manifestResult,
    };
  } catch (error) {
    for (const temp of temps.slice().reverse()) {
      try {
        if (unlinkOwned(temp))
          fsyncDirectoryBestEffort(dirname(temp.path), deps);
      } catch {
        // Best-effort identity-safe cleanup only.
      }
    }
    let collectionCommitted = false;
    if (canonicalRoot !== null) {
      try {
        collectionCommitted =
          exactPrivateFile(
            join(canonicalRoot, ...safeParts(prepared.manifest.manifestPath)),
            prepared.manifestBytes,
          ) !== null &&
          prepared.sessions.every(
            (session) =>
              exactPrivateFile(
                join(
                  canonicalRoot as string,
                  ...safeParts(session.destinationPath),
                ),
                session.bytes,
              ) !== null,
          );
      } catch {
        collectionCommitted = false;
      }
    }
    if (!collectionCommitted) {
      for (const artifact of created.slice().reverse()) {
        try {
          if (unlinkOwned(artifact)) {
            fsyncDirectoryBestEffort(dirname(artifact.path), deps);
          }
        } catch {
          // Best-effort identity-safe rollback only.
        }
      }
    }
    if (error instanceof ConversationConversionError) throw error;
    throw new ConversationConversionError(
      "publish_failed",
      error instanceof Error ? error.message : "publish failed",
    );
  }
}

export function convertPiToClaude(
  options: PiToClaudeConvertOptions,
): ConvertedPiToClaudeConversation {
  const prepared = preparePiToClaudeConversion(options);
  const published = publishPiToClaudeConversion(prepared, options);
  return { prepared, published };
}

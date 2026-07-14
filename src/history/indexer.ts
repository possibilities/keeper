import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { createClaudeLineNormalizer } from "../transcript/claude";
import type { TranscriptEntry, TranscriptSource } from "../transcript/model";
import { TRANSCRIPT_LINE_BYTE_CAP } from "../transcript/parse-common";
import { createPiLineNormalizer } from "../transcript/pi";
import type { TranscriptLineNormalizer } from "../transcript/reader";
import { deriveFileEvidence } from "./file-evidence";
import {
  type HistoryIndexPaths,
  publishHistoryIndexRebuild,
  refreshHistoryIndexDatabase,
} from "./index-db";
import { aggregateHistoryDiagnostics } from "./model";
import type {
  CatalogSession,
  HistoryDiagnostic,
  HistoryHarness,
  SessionCatalog,
} from "./model";
import { historySourceStat } from "./source-stat";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_INDEX_BODY_CHARS = 1_048_576;

export interface HistoryPhysicalSource {
  sourceKey: string;
  sessionKey: string;
  harness: HistoryHarness;
  nativeId: string;
  path: string;
  source: TranscriptSource;
  project: string | null;
  title: string | null;
  titleHistory: string[];
  artifactTitle: string | null;
  artifactTitleHistory: string[];
  artifactTitleHistoryComplete: boolean;
}

export interface HistorySourceEnumeration {
  sources: HistoryPhysicalSource[];
  complete: boolean;
}

export interface HistoryIndexAdapter {
  readonly harness: HistoryHarness;
  enumerate(session: CatalogSession): HistorySourceEnumeration;
  createNormalizer(source: HistoryPhysicalSource): TranscriptLineNormalizer;
}

function sourceKey(
  session: CatalogSession,
  path: string,
  source: TranscriptSource,
): string {
  const digest = createHash("sha256")
    .update(session.sessionKey)
    .update("\0")
    .update(path)
    .update("\0")
    .update(source)
    .digest("hex");
  return `${session.harness}:${digest}`;
}

function physicalSource(
  session: CatalogSession,
  path: string,
  source: TranscriptSource,
): HistoryPhysicalSource {
  const artifactTitleRecords = session.titleRecords.filter(
    (record) => record.source === "native",
  );
  const artifactTitle =
    [...artifactTitleRecords].reverse().find((record) => record.current)?.title ??
    artifactTitleRecords.at(-1)?.title ??
    null;
  return {
    sourceKey: sourceKey(session, path, source),
    sessionKey: session.sessionKey,
    harness: session.harness,
    nativeId: session.nativeId,
    path,
    source,
    project: session.project,
    title: session.currentTitle,
    titleHistory: session.titleRecords.map((record) => record.title),
    artifactTitle,
    artifactTitleHistory: artifactTitleRecords.map((record) => record.title),
    artifactTitleHistoryComplete: session.titleHistoryComplete,
  };
}

function claudeSources(session: CatalogSession): HistorySourceEnumeration {
  if (session.artifact === null) return { sources: [], complete: true };
  const sources = [physicalSource(session, session.artifact.path, "main")];
  const subagentDir = join(
    session.artifact.path.slice(0, -".jsonl".length),
    "subagents",
  );
  let names: string[];
  try {
    names = readdirSync(subagentDir)
      .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { sources, complete: code === "ENOENT" };
  }
  for (const name of names) {
    const id = name.slice("agent-".length, -".jsonl".length);
    if (id.length === 0) continue;
    sources.push(
      physicalSource(session, join(subagentDir, name), `subagent:${id}`),
    );
  }
  return { sources, complete: true };
}

export const DEFAULT_HISTORY_INDEX_ADAPTERS: readonly HistoryIndexAdapter[] = [
  {
    harness: "claude",
    enumerate: claudeSources,
    createNormalizer: (source) =>
      createClaudeLineNormalizer({
        path: source.path,
        sessionId: source.nativeId,
        source: source.source,
      }),
  },
  {
    harness: "pi",
    enumerate(session) {
      return {
        sources:
          session.artifact === null
            ? []
            : [physicalSource(session, session.artifact.path, "main")],
        complete: true,
      };
    },
    createNormalizer: (source) =>
      createPiLineNormalizer({
        path: source.path,
        sessionId: source.nativeId,
        source: source.source,
      }),
  },
];

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function entryBody(entry: TranscriptEntry): string {
  const parts: string[] = [];
  if (entry.text !== null) parts.push(entry.text);
  if (entry.tool !== null) {
    if (entry.tool.name !== null) parts.push(entry.tool.name);
    const input = safeJson(entry.tool.input);
    const result = safeJson(entry.tool.result);
    if (input.length > 0) parts.push(input);
    if (result.length > 0) parts.push(result);
  }
  const body = parts.join("\n");
  return body.length <= MAX_INDEX_BODY_CHARS
    ? body
    : body.slice(0, MAX_INDEX_BODY_CHARS);
}

function insertFileEvidence(
  db: Database,
  source: HistoryPhysicalSource,
  entries: readonly TranscriptEntry[],
): number {
  const evidence = deriveFileEvidence({
    entries,
    project: source.project,
    contextForEntry: (entry) => ({
      sessionKey: source.sessionKey,
      sourceKey: source.sourceKey,
      source: entry.source,
      sourceOrdinal: entry.sourceOrdinal,
      nativeEntryId: entry.nativeEntryId,
      parentNativeEntryId: entry.parentNativeEntryId,
    }),
  });
  const insert = db.prepare(`INSERT INTO file_evidence(
      session_key, source_key, path, grade, provenance_source,
      transcript_source, source_ordinal, native_entry_id, parent_native_entry_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let rows = 0;
  for (const item of evidence) {
    for (const provenance of item.provenance) {
      const context = provenance.context;
      insert.run(
        source.sessionKey,
        source.sourceKey,
        item.path,
        item.grade,
        provenance.source,
        context?.source ?? source.source,
        context?.sourceOrdinal ?? null,
        context?.nativeEntryId ?? null,
        context?.parentNativeEntryId ?? null,
      );
      rows++;
    }
  }
  return rows;
}

interface StreamIndexResult {
  contentFingerprint: string;
  entries: number;
}

function streamSourceIntoIndex(
  db: Database,
  source: HistoryPhysicalSource,
  normalizer: TranscriptLineNormalizer,
): StreamIndexResult {
  const insert = db.prepare(`INSERT INTO entries(
      source_key, source_ordinal, role, kind, timestamp, timestamp_ms, body,
      tool_name, native_entry_id, parent_native_entry_id
    ) VALUES (
      $source_key, $source_ordinal, $role, $kind, $timestamp, $timestamp_ms,
      $body, $tool_name, $native_entry_id, $parent_native_entry_id
    )`);
  let entryCount = 0;
  const evidenceEntries: TranscriptEntry[] = [];
  const feed = (lineBuffer: Buffer): void => {
    const end =
      lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13
        ? lineBuffer.length - 1
        : lineBuffer.length;
    const line = lineBuffer.subarray(0, end).toString("utf8");
    if (line.trim().length === 0) return;
    const batch = normalizer.feedLine(line);
    for (const entry of batch.entries) {
      evidenceEntries.push(entry);
      insert.run({
        source_key: source.sourceKey,
        source_ordinal: entry.sourceOrdinal,
        role: entry.role,
        kind: entry.kind,
        timestamp: entry.timestamp,
        timestamp_ms: entry.timestampMs,
        body: entryBody(entry),
        tool_name: entry.tool?.name ?? null,
        native_entry_id: entry.nativeEntryId,
        parent_native_entry_id: entry.parentNativeEntryId,
      });
      entryCount++;
    }
    // Unknown records remain in the normalizer's public batch but are not copied
    // into the disposable derivative; the native artifact remains authoritative.
    void batch.unknownRecords;
  };

  const fd = openSync(source.path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let droppingOversizedLine = false;
  try {
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      const current = chunk.subarray(0, bytes);
      hash.update(current);
      let cursor = 0;
      while (cursor < current.length) {
        if (droppingOversizedLine) {
          const newline = current.indexOf(10, cursor);
          if (newline < 0) {
            cursor = current.length;
            continue;
          }
          droppingOversizedLine = false;
          cursor = newline + 1;
          continue;
        }
        const newline = current.indexOf(10, cursor);
        if (newline < 0) {
          const remainder = current.subarray(cursor);
          if (pending.length + remainder.length > TRANSCRIPT_LINE_BYTE_CAP) {
            pending = Buffer.alloc(0);
            droppingOversizedLine = true;
          } else if (pending.length === 0) {
            pending = Buffer.from(remainder);
          } else {
            pending = Buffer.concat([pending, remainder]);
          }
          cursor = current.length;
          continue;
        }
        const segment = current.subarray(cursor, newline);
        const line =
          pending.length === 0 ? segment : Buffer.concat([pending, segment]);
        pending = Buffer.alloc(0);
        if (line.length <= TRANSCRIPT_LINE_BYTE_CAP) feed(line);
        cursor = newline + 1;
      }
    }
    if (!droppingOversizedLine && pending.length > 0) feed(pending);
    normalizer.finish();
    insertFileEvidence(db, source, evidenceEntries);
    return { contentFingerprint: hash.digest("hex"), entries: entryCount };
  } finally {
    closeSync(fd);
  }
}

export interface HistoryIndexStats {
  discoveredSources: number;
  indexedSources: number;
  unchangedSources: number;
  removedSources: number;
  failedSources: number;
  indexedEntries: number;
  rebuilt: boolean;
  diagnostics: HistoryDiagnostic[];
}

interface EnumeratedSources {
  sources: HistoryPhysicalSource[];
  pruneHarnesses: Set<HistoryHarness>;
}

function enumerateSources(
  catalog: SessionCatalog,
  adapters: readonly HistoryIndexAdapter[],
): EnumeratedSources {
  const byHarness = new Map(
    adapters.map((adapter) => [adapter.harness, adapter]),
  );
  const sources = new Map<string, HistoryPhysicalSource>();
  const pruneHarnesses = new Set(catalog.authoritativeHarnesses);
  for (const session of catalog.sessions) {
    if (session.artifact === null) continue;
    const adapter = byHarness.get(session.harness);
    if (adapter === undefined) continue;
    let enumeration: HistorySourceEnumeration;
    try {
      enumeration = adapter.enumerate(session);
    } catch {
      pruneHarnesses.delete(session.harness);
      continue;
    }
    if (!enumeration.complete) pruneHarnesses.delete(session.harness);
    for (const source of enumeration.sources)
      sources.set(source.sourceKey, source);
  }
  return {
    sources: [...sources.values()].sort((a, b) =>
      a.sourceKey.localeCompare(b.sourceKey),
    ),
    pruneHarnesses,
  };
}

function emptyStats(
  rebuilt: boolean,
  discoveredSources: number,
): HistoryIndexStats {
  return {
    discoveredSources,
    indexedSources: 0,
    unchangedSources: 0,
    removedSources: 0,
    failedSources: 0,
    indexedEntries: 0,
    rebuilt,
    diagnostics: [],
  };
}

function updateSource(
  db: Database,
  source: HistoryPhysicalSource,
  adapter: HistoryIndexAdapter,
  nowMs: number,
  stats: HistoryIndexStats,
): void {
  const before = historySourceStat(source.path);
  if (before === null) {
    stats.failedSources++;
    stats.diagnostics.push({
      code: "source_read_failed",
      harness: source.harness,
      scope: "index",
    });
    return;
  }
  const stored = db
    .query("SELECT stat_fingerprint, project FROM sources WHERE source_key = ?")
    .get(source.sourceKey) as {
    stat_fingerprint: string;
    project: string | null;
  } | null;
  if (
    stored?.stat_fingerprint === before.statFingerprint &&
    stored.project === source.project
  ) {
    db.query(`UPDATE sources SET
        session_key = ?, project = ?, title = ?, title_history = ?,
        artifact_title = ?, artifact_title_history = ?,
        artifact_title_history_complete = ?
      WHERE source_key = ?`).run(
      source.sessionKey,
      source.project,
      source.title,
      JSON.stringify(source.titleHistory),
      source.artifactTitle,
      JSON.stringify(source.artifactTitleHistory),
      source.artifactTitleHistoryComplete ? 1 : 0,
      source.sourceKey,
    );
    stats.unchangedSources++;
    return;
  }

  try {
    const transaction = db.transaction(() => {
      db.query("DELETE FROM sources WHERE source_key = ?").run(
        source.sourceKey,
      );
      db.query(`INSERT INTO sources(
          source_key, session_key, harness, native_id, artifact_path,
          transcript_source, project, title, title_history, artifact_title,
          artifact_title_history, artifact_title_history_complete,
          stat_fingerprint, content_fingerprint, source_size, source_mtime_ms,
          indexed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`).run(
        source.sourceKey,
        source.sessionKey,
        source.harness,
        source.nativeId,
        source.path,
        source.source,
        source.project,
        source.title,
        JSON.stringify(source.titleHistory),
        source.artifactTitle,
        JSON.stringify(source.artifactTitleHistory),
        source.artifactTitleHistoryComplete ? 1 : 0,
        before.statFingerprint,
        before.size,
        before.mtimeMs,
        nowMs,
      );
      const indexed = streamSourceIntoIndex(
        db,
        source,
        adapter.createNormalizer(source),
      );
      const after = historySourceStat(source.path);
      if (
        after === null ||
        after.statFingerprint !== before.statFingerprint ||
        after.size !== before.size
      ) {
        throw new SourceChangedError();
      }
      db.query(`UPDATE sources
          SET content_fingerprint = ?
          WHERE source_key = ?`).run(
        indexed.contentFingerprint,
        source.sourceKey,
      );
      return indexed.entries;
    });
    const entries = transaction.immediate();
    stats.indexedSources++;
    stats.indexedEntries += entries;
  } catch (error) {
    stats.failedSources++;
    stats.diagnostics.push({
      code:
        error instanceof SourceChangedError
          ? "source_changed"
          : "source_read_failed",
      harness: source.harness,
      scope: "index",
    });
  }
}

class SourceChangedError extends Error {}

function pruneDeletedSources(
  db: Database,
  current: ReadonlySet<string>,
  pruneHarnesses: ReadonlySet<HistoryHarness>,
  stats: HistoryIndexStats,
): void {
  const rows = db
    .query("SELECT source_key, harness FROM sources ORDER BY source_key")
    .all() as Array<{ source_key: string; harness: string }>;
  const remove = db.prepare("DELETE FROM sources WHERE source_key = ?");
  const transaction = db.transaction(() => {
    for (const row of rows) {
      if (
        (row.harness === "claude" || row.harness === "pi") &&
        pruneHarnesses.has(row.harness) &&
        !current.has(row.source_key)
      ) {
        remove.run(row.source_key);
        stats.removedSources++;
      }
    }
  });
  transaction.immediate();
}

function populateIndex(
  db: Database,
  catalog: SessionCatalog,
  adapters: readonly HistoryIndexAdapter[],
  nowMs: number,
  rebuilt: boolean,
): HistoryIndexStats {
  const enumerated = enumerateSources(catalog, adapters);
  const stats = emptyStats(rebuilt, enumerated.sources.length);
  const byHarness = new Map(
    adapters.map((adapter) => [adapter.harness, adapter]),
  );
  for (const source of enumerated.sources) {
    const adapter = byHarness.get(source.harness);
    if (adapter !== undefined) updateSource(db, source, adapter, nowMs, stats);
  }
  pruneDeletedSources(
    db,
    new Set(enumerated.sources.map((source) => source.sourceKey)),
    enumerated.pruneHarnesses,
    stats,
  );
  stats.diagnostics = aggregateHistoryDiagnostics(stats.diagnostics);
  return stats;
}

export function rebuildHistoryIndex(options: {
  paths: HistoryIndexPaths;
  catalog: SessionCatalog;
  adapters?: readonly HistoryIndexAdapter[];
  nowMs?: number;
}): HistoryIndexStats {
  const adapters = options.adapters ?? DEFAULT_HISTORY_INDEX_ADAPTERS;
  const nowMs = options.nowMs ?? Date.now();
  return publishHistoryIndexRebuild(options.paths, (db) =>
    populateIndex(db, options.catalog, adapters, nowMs, true),
  );
}

/** Incrementally refresh changed source files; a missing/incompatible sidecar is
 * rebuilt as a closed image and atomically published. */
export function refreshHistoryIndex(options: {
  paths: HistoryIndexPaths;
  catalog: SessionCatalog;
  adapters?: readonly HistoryIndexAdapter[];
  nowMs?: number;
}): HistoryIndexStats {
  const adapters = options.adapters ?? DEFAULT_HISTORY_INDEX_ADAPTERS;
  const nowMs = options.nowMs ?? Date.now();
  return refreshHistoryIndexDatabase(options.paths, (db, rebuilt) =>
    populateIndex(db, options.catalog, adapters, nowMs, rebuilt),
  );
}

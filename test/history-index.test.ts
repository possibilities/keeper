import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionCatalog } from "../src/history/catalog";
import {
  inspectHistoryIndex,
  openHistoryIndexReadOnly,
  publishHistoryIndexRebuild,
  resolveHistoryIndexPaths,
} from "../src/history/index-db";
import {
  DEFAULT_HISTORY_INDEX_ADAPTERS,
  type HistoryIndexAdapter,
  rebuildHistoryIndex,
  refreshHistoryIndex,
} from "../src/history/indexer";
import type { NativeSessionArtifact } from "../src/history/model";

let root: string;
let transcript: string;

function line(value: unknown): string {
  return JSON.stringify(value);
}

function piSession(lines: readonly string[]): void {
  writeFileSync(transcript, `${lines.join("\n")}\n`);
}

function user(id: string, parentId: string | null, text: string): string {
  return line({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function artifact(): NativeSessionArtifact {
  const stat = statSync(transcript);
  return {
    harness: "pi",
    nativeId: "pi-session",
    path: transcript,
    project: "/project/pi",
    currentTitle: "Index fixture",
    titleHistory: ["Index fixture"],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    bytes: stat.size,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-history-index-"));
  mkdirSync(join(root, "native"), { recursive: true });
  transcript = join(root, "native", "pi.jsonl");
  piSession([user("u1", null, "alpha original")]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bodies(stateDir = join(root, "state")): string[] {
  const paths = resolveHistoryIndexPaths(stateDir);
  const db = openHistoryIndexReadOnly(paths);
  try {
    return (
      db
        .query("SELECT body FROM entries ORDER BY source_ordinal")
        .all() as Array<{ body: string }>
    ).map((row) => row.body);
  } finally {
    db.close();
  }
}

describe("private disposable History index", () => {
  test("builds outside keeper.db with owner-only modes and source fingerprints", () => {
    const paths = resolveHistoryIndexPaths(join(root, "state"));
    const stats = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 123,
    });
    expect(stats.rebuilt).toBe(true);
    expect(stats.indexedSources).toBe(1);
    expect(stats.indexedEntries).toBe(1);
    expect(paths.database.endsWith("keeper.db")).toBe(false);
    expect(inspectHistoryIndex(paths)).toEqual({
      kind: "ready",
      schemaVersion: 1,
    });
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.database).mode & 0o777).toBe(0o600);
    expect(statSync(paths.lock).mode & 0o777).toBe(0o600);

    const db = openHistoryIndexReadOnly(paths);
    try {
      const row = db
        .query(`SELECT stat_fingerprint, content_fingerprint, indexed_at_ms
          FROM sources`)
        .get() as {
        stat_fingerprint: string;
        content_fingerprint: string;
        indexed_at_ms: number;
      };
      expect(row.stat_fingerprint).toHaveLength(64);
      expect(row.content_fingerprint).toHaveLength(64);
      expect(row.indexed_at_ms).toBe(123);
    } finally {
      db.close();
    }
  });

  test("refuses keeper.db even on read-only sidecar paths", () => {
    const forbidden = {
      directory: root,
      database: join(root, "keeper.db"),
      lock: join(root, "index.lock"),
    };
    expect(() => inspectHistoryIndex(forbidden)).toThrow(
      "history index must not use keeper.db",
    );
    expect(() => openHistoryIndexReadOnly(forbidden)).toThrow(
      "history index must not use keeper.db",
    );
  });

  test("skips unchanged files, refreshes append plus torn tail, and replaces shrink", () => {
    const paths = resolveHistoryIndexPaths(join(root, "state"));
    const first = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 1,
    });
    expect(first.indexedSources).toBe(1);

    const unchanged = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 2,
    });
    expect(unchanged.unchangedSources).toBe(1);
    expect(unchanged.indexedSources).toBe(0);

    appendFileSync(
      transcript,
      `${user("u2", "u1", "beta appended")}\n{"type":"message"`,
    );
    const appended = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 3,
    });
    expect(appended.indexedSources).toBe(1);
    expect(bodies()).toEqual(["alpha original", "beta appended"]);

    // Atomic replacement/shrink removes old rows rather than retaining stale tail.
    piSession([user("u3", null, "gamma replacement")]);
    const replaced = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 4,
    });
    expect(replaced.indexedSources).toBe(1);
    expect(bodies()).toEqual(["gamma replacement"]);
  });

  test("rolls back a source that mutates during indexing", () => {
    const paths = resolveHistoryIndexPaths(join(root, "state"));
    refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 1,
    });
    appendFileSync(transcript, `${user("u2", "u1", "beta pending")}\n`);
    const base = DEFAULT_HISTORY_INDEX_ADAPTERS.find(
      (adapter) => adapter.harness === "pi",
    );
    expect(base).toBeDefined();
    let mutated = false;
    const racing: HistoryIndexAdapter = {
      harness: "pi",
      enumerate: (session) =>
        base?.enumerate(session) ?? { sources: [], complete: false },
      createNormalizer(source) {
        const normalizer = base?.createNormalizer(source);
        if (normalizer === undefined) throw new Error("missing Pi adapter");
        return {
          source: normalizer.source,
          feedLine(line) {
            if (!mutated) {
              mutated = true;
              appendFileSync(
                transcript,
                `${user("u3", "u2", "changed during read")}\n`,
              );
            }
            return normalizer.feedLine(line);
          },
          finish: () => normalizer.finish(),
        };
      },
    };
    const raced = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      adapters: [racing],
      nowMs: 2,
    });
    expect(raced.failedSources).toBe(1);
    expect(raced.diagnostics.map((item) => item.code)).toContain(
      "source_changed",
    );
    // The source transaction restores the prior complete image.
    expect(bodies()).toEqual(["alpha original"]);
  });

  test("reconciles deleted authoritative sources", () => {
    const paths = resolveHistoryIndexPaths(join(root, "state"));
    refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 1,
    });
    rmSync(transcript);
    const removed = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([]),
      nowMs: 2,
    });
    expect(removed.removedSources).toBe(1);
    expect(bodies()).toEqual([]);
  });

  test("rebuilds an incompatible independently-versioned image", () => {
    const paths = resolveHistoryIndexPaths(join(root, "state"));
    refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 1,
    });
    const incompatible = new Database(paths.database);
    incompatible.run("PRAGMA user_version = 999");
    incompatible.close();
    expect(inspectHistoryIndex(paths).kind).toBe("incompatible");

    const refreshed = refreshHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 2,
    });
    expect(refreshed.rebuilt).toBe(true);
    expect(inspectHistoryIndex(paths).kind).toBe("ready");
    expect(bodies()).toEqual(["alpha original"]);
  });

  test("publishes only a closed successful rebuild image", () => {
    const paths = resolveHistoryIndexPaths(join(root, "state"));
    rebuildHistoryIndex({
      paths,
      catalog: buildSessionCatalog([artifact()]),
      nowMs: 1,
    });
    const before = readFileSync(paths.database);

    expect(() =>
      publishHistoryIndexRebuild(paths, (db) => {
        db.run(
          "INSERT INTO history_meta(key, value) VALUES ('partial', 'yes')",
        );
        throw new Error("injected rebuild failure");
      }),
    ).toThrow("injected rebuild failure");

    expect(inspectHistoryIndex(paths).kind).toBe("ready");
    expect(readFileSync(paths.database)).toEqual(before);
    expect(bodies()).toEqual(["alpha original"]);
  });
});

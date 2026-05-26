/**
 * Usage-worker tests, mirroring the plan-worker.test.ts layout:
 *
 * (a) DETERMINISM unit tests against the PURE `UsageScanner` core — no
 *     Worker, no watcher, just files + `onChange` / `onDelete` / `markSeen` /
 *     `sweep`. Cover the filename predicate, snapshot derivation, change-gate
 *     dedupe, safe-parse skips (malformed JSON, oversize, missing id,
 *     missing-session/-week sub-blocks), tombstone retraction, boot sweep,
 *     and the load-bearing FRESHNESS-EXCLUSION case (two envelopes differing
 *     only in `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
 *     `last_skipped_fetch_at` produce zero emits — the tripwire that catches
 *     any future drift adding a freshness column to the change-gate hash).
 * (b) A roundtrip test that {@link seedFromDb} suppresses a re-emit of an
 *     already-folded projection row (slot-order discipline check — the seed
 *     reconstruction must produce byte-identical JSON to {@link buildUsageMessage}'s
 *     output, or every profile re-emits on every boot).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  buildUsageMessage,
  idFromUsagePath,
  isUsageFilename,
  scanRoot,
  seedFromDb,
  type UsageMessage,
  UsageScanner,
} from "../src/usage-worker";

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-usage-test-"));
  stateDir = join(tmpDir, "agentuse");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write one `<id>.json` envelope under stateDir; return absolute path. */
function writeEnvelope(id: string, body: Record<string, unknown>): string {
  const path = join(stateDir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

/**
 * A realistic agentuse envelope with the four freshness fields populated.
 * Tests that flip ONLY the freshness fields verify the change-gate
 * suppression.
 */
function envelopeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    target: "claude",
    multiplier: 5,
    last_successful_fetch_at: "2026-05-26T15:49:02.302958-04:00",
    last_skipped_fetch_at: null,
    next_fetch_at: "2026-05-26T15:51:30.316687-04:00",
    fetched_at: "2026-05-26T15:49:02.302958-04:00",
    usage: {
      session: { percent_used: 12.0, resets_at: "2026-05-26T18:30:00-04:00" },
      week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — filename predicate + id derivation
// ---------------------------------------------------------------------------

test("isUsageFilename accepts <id>.json (lowercase, digit, hyphen); rejects everything else", () => {
  expect(isUsageFilename("claude-default.json")).toBe(true);
  expect(isUsageFilename("claude-multi-1.json")).toBe(true);
  expect(isUsageFilename("codex.json")).toBe(true);
  expect(isUsageFilename("a.json")).toBe(true);
  // Reject extra dot segment (future agentuse error envelope).
  expect(isUsageFilename("claude-default.error.json")).toBe(false);
  // Reject non-.json files (agentuse log surfaces).
  expect(isUsageFilename("server.stdout")).toBe(false);
  expect(isUsageFilename("server.stderr")).toBe(false);
  expect(isUsageFilename("events.jsonl")).toBe(false);
  // Reject atomic-rename temp artifacts.
  expect(isUsageFilename("claude-default.json.tmp.12345")).toBe(false);
  // Reject uppercase / non-portable characters.
  expect(isUsageFilename("Claude.json")).toBe(false);
  expect(isUsageFilename(".hidden.json")).toBe(false);
  expect(isUsageFilename("a_b.json")).toBe(false);
});

test("idFromUsagePath strips the .json suffix; null on a non-matching basename", () => {
  expect(idFromUsagePath("/a/b/claude-default.json")).toBe("claude-default");
  expect(idFromUsagePath("/a/b/codex.json")).toBe("codex");
  expect(idFromUsagePath("/a/b/claude-default.error.json")).toBeNull();
  expect(idFromUsagePath("/a/b/server.stderr")).toBeNull();
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — buildUsageMessage shape
// ---------------------------------------------------------------------------

test("buildUsageMessage maps id/target/multiplier and the two-window usage sub-block", () => {
  const msg = buildUsageMessage({
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    usage: {
      session: { percent_used: 12.0, resets_at: "2026-05-26T18:30:00-04:00" },
      week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
    },
  });
  expect(msg).toEqual({
    kind: "usage-snapshot",
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    session_percent: 12.0,
    session_resets_at: "2026-05-26T18:30:00-04:00",
    week_percent: 8.0,
    week_resets_at: "2026-06-01T20:00:00-04:00",
  });
});

test("buildUsageMessage returns null when id is missing or non-string", () => {
  expect(buildUsageMessage({})).toBeNull();
  expect(buildUsageMessage({ id: 42 })).toBeNull();
  expect(buildUsageMessage({ id: "" })).toBeNull();
});

test("buildUsageMessage folds missing usage.session / usage.week to NULL fields", () => {
  // No usage block at all → both windows NULL.
  const bare = buildUsageMessage({ id: "x", target: "claude", multiplier: 1 });
  expect(bare?.session_percent).toBeNull();
  expect(bare?.session_resets_at).toBeNull();
  expect(bare?.week_percent).toBeNull();
  expect(bare?.week_resets_at).toBeNull();
  // Only session present → week NULL.
  const sessOnly = buildUsageMessage({
    id: "x",
    usage: { session: { percent_used: 10, resets_at: "T" } },
  });
  expect(sessOnly?.session_percent).toBe(10);
  expect(sessOnly?.week_percent).toBeNull();
  // Only week present → session NULL.
  const weekOnly = buildUsageMessage({
    id: "x",
    usage: { week: { percent_used: 20, resets_at: "T" } },
  });
  expect(weekOnly?.week_percent).toBe(20);
  expect(weekOnly?.session_percent).toBeNull();
});

test("buildUsageMessage drops every freshness field — they NEVER enter the message", () => {
  const msg = buildUsageMessage({
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    fetched_at: "T1",
    next_fetch_at: "T2",
    last_successful_fetch_at: "T3",
    last_skipped_fetch_at: "T4",
    usage: { session: { percent_used: 1, resets_at: "S" } },
  });
  // None of the four freshness fields appear in the message shape.
  const json = JSON.stringify(msg);
  expect(json).not.toContain("fetched_at");
  expect(json).not.toContain("next_fetch_at");
  expect(json).not.toContain("last_successful_fetch_at");
  expect(json).not.toContain("last_skipped_fetch_at");
});

// ---------------------------------------------------------------------------
// (a) FRESHNESS-EXCLUSION TRIPWIRE — load-bearing discipline test
// ---------------------------------------------------------------------------

test("FRESHNESS EXCLUSION: two envelopes differing ONLY in fetch timestamps produce ZERO emits past the first", () => {
  // The point of this test: a future contributor adding `fetched_at` (or any
  // of the four freshness fields) to the change-gate hash would force a
  // synthetic event on every ~90s agentuse fetch cycle, churning the
  // projection. The change-gate compares JSON.stringify byte-for-byte, so
  // omitting the field from `buildUsageMessage`'s output is the discipline
  // — and this test asserts that discipline holds.
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // First scan: emits.
  const path = writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Rewrite with ONLY the four freshness fields advanced. The session/week
  // numbers + resets_at + target + multiplier all stay byte-identical.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      ...envelopeBody({
        fetched_at: "2026-05-26T16:00:00.000000-04:00",
        next_fetch_at: "2026-05-26T16:01:30.000000-04:00",
        last_successful_fetch_at: "2026-05-26T16:00:00.000000-04:00",
        last_skipped_fetch_at: "2026-05-26T15:59:00.000000-04:00",
      }),
    }),
  );
  scanner.onChange(path);
  // ZERO additional emits — the freshness-only diff is suppressed by the
  // change-gate. If this assertion fails, a freshness field has leaked into
  // buildUsageMessage's output (or into the schema-derived seed). FIX BY
  // REMOVING THE LEAK — do NOT relax this test.
  expect(emitted.length).toBe(1);
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — onChange end-to-end with real files
// ---------------------------------------------------------------------------

test("onChange emits a usage-snapshot for a real envelope, then change-gates an identical re-scan", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(path);
  expect(emitted.length).toBe(1);
  expect(emitted[0]).toEqual({
    kind: "usage-snapshot",
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    session_percent: 12.0,
    session_resets_at: "2026-05-26T18:30:00-04:00",
    week_percent: 8.0,
    week_resets_at: "2026-06-01T20:00:00-04:00",
  });

  // Identical re-scan suppressed.
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // A real change to the session_percent re-emits.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      ...envelopeBody({
        usage: {
          session: {
            percent_used: 25.0,
            resets_at: "2026-05-26T18:30:00-04:00",
          },
          week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
        },
      }),
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
  expect((emitted[1] as { session_percent: number }).session_percent).toBe(25);
});

test("malformed JSON skips-and-logs without emitting", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );

  const path = join(stateDir, "claude-default.json");
  writeFileSync(path, "{ not json");
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("malformed JSON"))).toBe(true);
});

test("oversize file skips-and-logs without emitting", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  // Write a >1MiB file (cheap big string).
  const path = join(stateDir, "claude-default.json");
  writeFileSync(path, "x".repeat(2 * 1024 * 1024));
  // Sanity: the file really is over the cap.
  expect(statSync(path).size).toBeGreaterThan(1024 * 1024);
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("exceeds"))).toBe(true);
});

test("missing-id envelope skips-and-logs without emitting", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  const path = join(stateDir, "claude-default.json");
  writeFileSync(path, JSON.stringify({ target: "claude" })); // no id
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("no usable id"))).toBe(true);
});

test("a non-usage filename is a no-op (filename predicate rejects)", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Even with valid envelope content, the wrong filename is ignored.
  const path = join(stateDir, "server.stderr");
  writeFileSync(path, JSON.stringify({ id: "x" }));
  scanner.onChange(path);
  expect(emitted).toEqual([]);
});

test("a vanished file (read-vs-delete race) skips-and-logs, no emit", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  // Path passes the filename predicate but doesn't exist on disk.
  const path = join(stateDir, "claude-default.json");
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("stat failed"))).toBe(true);
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — onDelete + change-gate cleanup
// ---------------------------------------------------------------------------

test("onDelete emits a tombstone for a previously-folded path; re-created file re-emits", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  scanner.onDelete(path);
  expect(emitted.length).toBe(2);
  expect(emitted[1]).toEqual({ kind: "usage-deleted", id: "claude-default" });

  // The change-gate was cleared, so the same content re-arriving re-emits.
  scanner.onChange(path);
  expect(emitted.length).toBe(3);
  expect((emitted[2] as { kind: string }).kind).toBe("usage-snapshot");
});

test("onDelete on an un-seeded path emits nothing (nothing to retract)", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Never folded this path → no change-gate entry → no tombstone.
  const path = join(stateDir, "claude-default.json");
  scanner.onDelete(path);
  expect(emitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// (a) Boot-sweep reconciliation — ghost retraction
// ---------------------------------------------------------------------------

test("sweep retracts a projection id whose file was deleted while down", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  // Seed a usage row for a profile whose file is no longer on disk.
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ghost-profile", "claude", 5, 12.0, "T", 8.0, "T", 1, 100],
  );
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["live-profile", "claude", 5, 25.0, "T", 8.0, "T", 2, 100],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // Boot scan sees ONLY live-profile on disk.
  writeEnvelope("live-profile", envelopeBody());
  scanRoot(stateDir, scanner);
  // The boot scan calls onChange for live-profile (no snapshot in change-gate
  // → emits once). Now sweep — ghost-profile's id is in the projection but
  // not in seenOnDisk, so it retracts.
  const beforeSweep = emitted.length;
  scanner.sweep(db);
  const tombstones = emitted
    .slice(beforeSweep)
    .filter((m) => m.kind === "usage-deleted");
  expect(tombstones).toEqual([{ kind: "usage-deleted", id: "ghost-profile" }]);
  db.close();
});

test("sweep does NOT retract a profile present on disk (even if it failed to parse)", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO usage (id, last_event_id, updated_at)
       VALUES (?, ?, ?)`,
    ["claude-default", 1, 100],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // File exists but is malformed — boot scan's onChange skips-and-logs,
  // BUT markSeen runs first (filename-keyed) so the census includes the id.
  writeFileSync(join(stateDir, "claude-default.json"), "{ not json");
  scanRoot(stateDir, scanner);

  const beforeSweep = emitted.length;
  scanner.sweep(db);
  // No tombstone fires — the file is on disk, even though it didn't parse.
  const tombstones = emitted
    .slice(beforeSweep)
    .filter((m) => m.kind === "usage-deleted");
  expect(tombstones).toEqual([]);
  db.close();
});

test("scanRoot tolerates a missing root (no throw, no emit)", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Use a path that does not exist on disk.
  scanRoot(join(tmpDir, "does-not-exist"), scanner);
  expect(emitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) Restart-seed — slot-order discipline
// ---------------------------------------------------------------------------

test("seedFromDb suppresses a re-emit of an already-folded projection row (slot-order discipline)", () => {
  // This is the test that catches drift between `buildUsageMessage` and
  // `seedFromDb`'s reconstruction. If the two diverge on key order or field
  // set, the change-gate compares JSON.stringify byte-for-byte and re-emits
  // every profile on every daemon boot.
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "claude-default",
      "claude",
      5,
      12.0,
      "2026-05-26T18:30:00-04:00",
      8.0,
      "2026-06-01T20:00:00-04:00",
      1,
      100,
    ],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);

  // The on-disk file matches the projection row exactly. The change-gate
  // (seeded by seedFromDb) MUST suppress the boot scan's onChange emit.
  writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(join(stateDir, "claude-default.json"));
  expect(emitted).toEqual([]);
  db.close();
});

// ---------------------------------------------------------------------------
// (b) markSeen filename-keying — parse-independence
// ---------------------------------------------------------------------------

test("markSeen keys off filename, parse-independent", () => {
  const scanner = new UsageScanner(
    () => {},
    () => {},
  );
  // A path whose basename passes the filter is marked; one that doesn't is
  // silently ignored.
  scanner.markSeen("/a/b/claude-default.json");
  scanner.markSeen("/a/b/server.stderr"); // ignored
  // Now drive a sweep against an empty usage table — no rows to retract,
  // proving markSeen accepted the valid path silently and ignored the other.
  // (We can't directly inspect seenOnDisk; the sweep behavior is the
  // observable.)
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  const emitted: UsageMessage[] = [];
  const scanner2 = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  scanner2.markSeen("/a/b/claude-default.json");
  db.run(`INSERT INTO usage (id, last_event_id, updated_at) VALUES (?, ?, ?)`, [
    "claude-default",
    1,
    100,
  ]);
  scanner2.sweep(db);
  // No tombstone — the id was marked seen (filename-derived).
  expect(emitted.filter((m) => m.kind === "usage-deleted")).toEqual([]);
  db.close();
});

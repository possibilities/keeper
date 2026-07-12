/**
 * Statusline-worker tests:
 *
 * (a) DETERMINISM unit tests against the PURE `StatuslineScanner` core — no
 *     Worker, no watcher, just leaf files + `onChange` / `onDelete`. Cover the
 *     filename predicate, message derivation, the change-gate dedupe, the
 *     load-bearing `input_tokens` EXCLUSION (a leaf that only moves tokens
 *     produces zero emits — the churn tripwire), the safe-parse skips, and that
 *     `onDelete` NEVER retracts (an ended row keeps its last-known telemetry).
 * (b) A `seedFromDb` roundtrip: an already-folded jobs row suppresses the boot
 *     scan's re-emit (slot-order discipline — the seed reconstruction must
 *     produce byte-identical JSON to `buildTelemetryMessage`'s output).
 * (c) `gcSweep`: terminal / absent-stale leaves are reclaimed; a live or
 *     fresh-absent leaf is kept (GC never races the sink into deleting an active
 *     session's leaf).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTelemetryMessage,
  gcSweep,
  isStatuslineFilename,
  LEAF_TTL_MS,
  StatuslineScanner,
  scanRoot,
  seedFromDb,
  statuslineGateKey,
} from "../src/statusline-worker";
import type { SessionTelemetryMessage } from "../src/types";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-statusline-test-"));
  stateDir = join(tmpDir, "statusline");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A full leaf body as the sink writes it (session_id + the projected fields). */
function leafBody(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: sessionId,
    model_id: "claude-opus-4-8",
    model_display: "Opus",
    effort: "high",
    context_used_percentage: 42.5,
    context_input_tokens: 85000,
    context_window_size: 200000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

/** Write one `<token>.json` leaf under stateDir; return absolute path. */
function writeLeaf(token: string, body: Record<string, unknown>): string {
  const path = join(stateDir, `${token}.json`);
  writeFileSync(path, `${JSON.stringify(body)}\n`);
  return path;
}

/** Insert a minimal jobs row (optionally carrying telemetry columns). */
function insertJob(
  db: ReturnType<typeof freshMemDb>["db"],
  jobId: string,
  opts: {
    state?: string;
    current_model_id?: string | null;
    current_model_display?: string | null;
    current_effort?: string | null;
    context_used_percentage?: number | null;
    context_input_tokens?: number | null;
    context_window_size?: number | null;
  } = {},
): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state, last_event_id,
       current_model_id, current_model_display, current_effort,
       context_used_percentage, context_input_tokens, context_window_size
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      1,
      1,
      opts.state ?? "stopped",
      0,
      opts.current_model_id ?? null,
      opts.current_model_display ?? null,
      opts.current_effort ?? null,
      opts.context_used_percentage ?? null,
      opts.context_input_tokens ?? null,
      opts.context_window_size ?? null,
    ],
  );
}

// ── (a) pure StatuslineScanner ───────────────────────────────────────────────

test("isStatuslineFilename accepts leaves and rejects temp / non-json", () => {
  expect(isStatuslineFilename("sess-1.json")).toBe(true);
  expect(isStatuslineFilename("a.b.c.json")).toBe(true); // dotted sanitized token
  expect(isStatuslineFilename(".sess-1.tmp")).toBe(false); // sink temp artifact
  expect(isStatuslineFilename("server.log")).toBe(false);
  expect(isStatuslineFilename("events.jsonl")).toBe(false);
  expect(isStatuslineFilename("has space.json")).toBe(false);
});

test("onChange emits the flattened message keyed on the RAW session_id", () => {
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Filename token differs from the raw id (the id lives INSIDE the leaf).
  const path = writeLeaf("sanitized_token", leafBody("raw:session/id"));
  scanner.onChange(path);
  expect(emitted).toEqual([
    {
      kind: "session-telemetry",
      id: "raw:session/id",
      model_id: "claude-opus-4-8",
      model_display: "Opus",
      effort: "high",
      used_percentage: 42.5,
      input_tokens: 85000,
      window_size: 200000,
    },
  ]);
});

test("onChange coalesces an unchanged leaf (no re-emit)", () => {
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  const path = writeLeaf("s", leafBody("s"));
  scanner.onChange(path);
  scanner.onChange(path); // identical content
  expect(emitted).toHaveLength(1);
});

test("the change-gate EXCLUDES input_tokens (a token-only move never emits)", () => {
  // The load-bearing churn tripwire: `input_tokens` is monotonic, so a leaf
  // rewrite that only advanced tokens must NOT mint a synthetic event.
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  const path = writeLeaf("s", leafBody("s", { context_input_tokens: 1000 }));
  scanner.onChange(path);
  expect(emitted).toHaveLength(1);
  // Only the raw token count moved — same model / effort / used% / window.
  writeLeaf("s", leafBody("s", { context_input_tokens: 999999 }));
  scanner.onChange(path);
  expect(emitted).toHaveLength(1); // suppressed
  // A real used% move (crossing the sink's bucket) DOES emit.
  writeLeaf(
    "s",
    leafBody("s", {
      context_used_percentage: 80,
      context_input_tokens: 999999,
    }),
  );
  scanner.onChange(path);
  expect(emitted).toHaveLength(2);
});

test("statuslineGateKey drops input_tokens but keeps every other field", () => {
  const base: SessionTelemetryMessage = {
    kind: "session-telemetry",
    id: "s",
    model_id: "m",
    model_display: "M",
    effort: "high",
    used_percentage: 40,
    input_tokens: 100,
    window_size: 200000,
  };
  const other: SessionTelemetryMessage = { ...base, input_tokens: 999 };
  expect(statuslineGateKey(base)).toBe(statuslineGateKey(other));
  expect(statuslineGateKey({ ...base, effort: "low" })).not.toBe(
    statuslineGateKey(base),
  );
  expect(statuslineGateKey({ ...base, used_percentage: 41 })).not.toBe(
    statuslineGateKey(base),
  );
});

test("onChange safe-parse: malformed / non-object / missing session_id skip", () => {
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  writeFileSync(join(stateDir, "bad.json"), "{not json");
  scanner.onChange(join(stateDir, "bad.json"));
  writeFileSync(join(stateDir, "arr.json"), "[1,2,3]");
  scanner.onChange(join(stateDir, "arr.json"));
  writeLeaf("noid", { model_id: "m" }); // no session_id
  scanner.onChange(join(stateDir, "noid.json"));
  scanner.onChange(join(stateDir, "does-not-exist.json"));
  expect(emitted).toEqual([]);
});

test("buildTelemetryMessage returns null without a session_id, degrades fields", () => {
  expect(buildTelemetryMessage({ model_id: "m" })).toBeNull();
  expect(
    buildTelemetryMessage({ session_id: "s", context_input_tokens: 1.5 }),
  ).toEqual({
    kind: "session-telemetry",
    id: "s",
    model_id: null,
    model_display: null,
    effort: null,
    used_percentage: null,
    input_tokens: null, // 1.5 is not an integer → null
    window_size: null,
  });
});

test("onDelete never retracts — it only drops the gate so a re-created leaf re-emits", () => {
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  const path = writeLeaf("s", leafBody("s"));
  scanner.onChange(path);
  expect(emitted).toHaveLength(1);
  scanner.onDelete(path); // no tombstone message emitted
  expect(emitted).toHaveLength(1);
  // Gate dropped: the same content re-emits (a re-created leaf is a fresh emit).
  scanner.onChange(path);
  expect(emitted).toHaveLength(2);
});

test("scanRoot boot-scans pre-existing leaves and skips non-leaf files", () => {
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  writeLeaf("a", leafBody("a"));
  writeLeaf("b", leafBody("b"));
  writeFileSync(join(stateDir, "notes.log"), "ignore me");
  scanRoot(stateDir, scanner);
  expect(emitted.map((m) => m.id).sort()).toEqual(["a", "b"]);
});

// ── (b) seedFromDb roundtrip ─────────────────────────────────────────────────

test("seedFromDb suppresses a re-emit of an already-folded jobs row (slot-order discipline)", () => {
  const { db } = freshMemDb();
  insertJob(db, "s", {
    state: "stopped",
    current_model_id: "claude-opus-4-8",
    current_model_display: "Opus",
    current_effort: "high",
    context_used_percentage: 42.5,
    context_input_tokens: 85000,
    context_window_size: 200000,
  });
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  // The on-disk leaf matches the folded row exactly → the seeded gate suppresses.
  const path = writeLeaf("s", leafBody("s"));
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  db.close();
});

test("seedFromDb reconstructs the gate across the input_tokens exclusion", () => {
  // The DB carries a DIFFERENT input_tokens than the on-disk leaf; because the
  // gate excludes input_tokens, the seed must still suppress the re-emit.
  const { db } = freshMemDb();
  insertJob(db, "s", {
    current_model_id: "claude-opus-4-8",
    current_model_display: "Opus",
    current_effort: "high",
    context_used_percentage: 42.5,
    context_input_tokens: 1, // stale token count
    context_window_size: 200000,
  });
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  const path = writeLeaf("s", leafBody("s", { context_input_tokens: 999999 }));
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  db.close();
});

test("seedFromDb skips all-null telemetry rows so the first snapshot emits", () => {
  const { db } = freshMemDb();
  insertJob(db, "s", { state: "stopped" }); // no telemetry columns
  const emitted: SessionTelemetryMessage[] = [];
  const scanner = new StatuslineScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);
  const path = writeLeaf("s", leafBody("s"));
  scanner.onChange(path);
  expect(emitted).toHaveLength(1); // first fold emits
  db.close();
});

// ── (c) gcSweep ──────────────────────────────────────────────────────────────

test("gcSweep reclaims terminal and absent-stale leaves, keeps live and fresh", () => {
  const { db } = freshMemDb();
  const now = Date.now();
  insertJob(db, "live", { state: "stopped" });
  insertJob(db, "ended", { state: "ended" });
  insertJob(db, "killed", { state: "killed" });

  const liveLeaf = writeLeaf("live", leafBody("live"));
  const endedLeaf = writeLeaf("ended", leafBody("ended"));
  const killedLeaf = writeLeaf("killed", leafBody("killed"));
  const absentStale = writeLeaf("gone", leafBody("gone"));
  const absentFresh = writeLeaf("newbie", leafBody("newbie"));

  // Age the absent-stale leaf past the TTL; leave the others fresh.
  const old = new Date(now - LEAF_TTL_MS - 60_000);
  utimesSync(absentStale, old, old);

  const scanner = new StatuslineScanner(
    () => {},
    () => {},
  );
  gcSweep(db, stateDir, now, scanner);

  expect(existsSync(liveLeaf)).toBe(true); // live session — kept
  expect(existsSync(absentFresh)).toBe(true); // absent but fresh (not-yet-seeded) — kept
  expect(existsSync(endedLeaf)).toBe(false); // terminal — reclaimed
  expect(existsSync(killedLeaf)).toBe(false); // terminal — reclaimed
  expect(existsSync(absentStale)).toBe(false); // absent + stale — reclaimed
  db.close();
});

/**
 * Transcript-worker tests, in three layers (mirrors wake-worker.test.ts +
 * server-worker.test.ts):
 *
 * (a) DETERMINISM unit tests against the PURE `TranscriptLineStream` core — no
 *     Worker, no watcher, just files + `onChange`. Cover partial-line buffering
 *     across two reads, truncation reset, malformed-skip, change-only emit, and
 *     a multi-byte (emoji) title split across the 64 KiB read boundary (must NOT
 *     decode to U+FFFD).
 * (b) A SMOKE test that `@parcel/watcher`'s native addon loads + fires under
 *     `bun test` (the keystone CI risk — N-API load failure is a hard dyld
 *     crash, not catchable).
 * (c) A real spawned Worker that shuts down cleanly on `{ type: "shutdown" }`
 *     (the subsystem teardown — the watcher unsubscribe must let the thread
 *     exit), mirroring wake-worker.test.ts.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  matchApiError,
  scanJobsForTitles,
  seedFromDb,
  TranscriptLineStream,
} from "../src/transcript-worker";
import type { ApiErrorKind } from "../src/types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-transcript-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a `custom-title` JSONL line (no trailing newline). */
function titleLine(sessionId: string, title: string): string {
  return JSON.stringify({
    type: "custom-title",
    customTitle: title,
    sessionId,
  });
}

// ---------------------------------------------------------------------------
// (a) Pure line-stream determinism
// ---------------------------------------------------------------------------

test("partial-line buffering: a title split across two reads emits once whole", () => {
  const path = join(tmpDir, "sess-a.jsonl");
  // Start empty so register() anchors at offset 0.
  writeFileSync(path, "");
  const emitted: Array<{ sessionId: string; title: string }> = [];
  const stream = new TranscriptLineStream(
    (sessionId, title) => emitted.push({ sessionId, title }),
    () => {},
  );
  stream.register(path);

  const line = `${titleLine("sess-a", "Hello World")}\n`;
  const half = Math.floor(line.length / 2);

  // First append: only the first half of the line (NO newline yet) → buffered,
  // nothing dispatched.
  appendFileSync(path, line.slice(0, half));
  stream.onChange(path);
  expect(emitted).toEqual([]);

  // Second append: the rest, including the newline → the buffered partial is
  // prepended and the whole line dispatches exactly once.
  appendFileSync(path, line.slice(half));
  stream.onChange(path);
  expect(emitted).toEqual([{ sessionId: "sess-a", title: "Hello World" }]);
});

test("truncation reset: a shrunk file re-tails from 0 without crashing", () => {
  const path = join(tmpDir, "sess-trunc.jsonl");
  writeFileSync(path, "");
  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );
  stream.register(path);

  // A long first title so the post-truncation file is unambiguously SHORTER
  // than the consumed offset — that size < offset is exactly the truncation
  // signal the guard fires on.
  appendFileSync(path, `${titleLine("sess-trunc", "First-and-quite-long")}\n`);
  stream.onChange(path);
  expect(emitted).toEqual(["First-and-quite-long"]);

  // Truncate to empty then write a fresh, SHORTER line. size (the new short
  // line) < offset (the long consumed first line) → the guard resets offset to
  // 0 + clears the buffer, so the new line is tailed from the start.
  truncateSync(path, 0);
  writeFileSync(path, `${titleLine("sess-trunc", "B")}\n`);
  stream.onChange(path);
  expect(emitted).toEqual(["First-and-quite-long", "B"]);
});

test("malformed line skips-and-logs, the next valid line still emits", () => {
  const path = join(tmpDir, "sess-bad.jsonl");
  writeFileSync(path, "");
  const emitted: string[] = [];
  const logs: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    (m) => logs.push(m),
  );
  stream.register(path);

  // A torn/malformed JSON line that nonetheless contains "custom-title" (so it
  // passes the cheap pre-filter and reaches JSON.parse) → skip-and-log.
  appendFileSync(path, `{"type":"custom-title", BROKEN\n`);
  appendFileSync(path, `${titleLine("sess-bad", "Recovered")}\n`);
  stream.onChange(path);

  expect(emitted).toEqual(["Recovered"]);
  expect(logs.some((l) => l.includes("malformed line"))).toBe(true);
});

test("change-only emit: same title is suppressed, a new title emits", () => {
  const path = join(tmpDir, "sess-dedup.jsonl");
  writeFileSync(path, "");
  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );
  stream.register(path);

  appendFileSync(path, `${titleLine("sess-dedup", "Same")}\n`);
  stream.onChange(path);
  appendFileSync(path, `${titleLine("sess-dedup", "Same")}\n`);
  stream.onChange(path);
  appendFileSync(path, `${titleLine("sess-dedup", "Different")}\n`);
  stream.onChange(path);

  // "Same" emitted once (the repeat suppressed), then "Different".
  expect(emitted).toEqual(["Same", "Different"]);
});

test("seedLastEmitted suppresses a re-emit of an already-folded title", () => {
  const path = join(tmpDir, "sess-seed.jsonl");
  writeFileSync(path, "");
  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );
  // Restart-seed: this title already won and was folded into jobs.
  stream.seedLastEmitted("sess-seed", "Persisted");
  stream.register(path);

  // The same title appears again post-restart → suppressed (change-gate seeded).
  appendFileSync(path, `${titleLine("sess-seed", "Persisted")}\n`);
  stream.onChange(path);
  expect(emitted).toEqual([]);

  // A genuinely new title still emits.
  appendFileSync(path, `${titleLine("sess-seed", "New")}\n`);
  stream.onChange(path);
  expect(emitted).toEqual(["New"]);
});

test("scanFile: a pre-existing current title emits once; a re-scan after seeding suppresses it", () => {
  const path = join(tmpDir, "sess-scan.jsonl");
  // A title written BEFORE any watch/register — the rename-while-down case the
  // live tail (EOF-anchored) would miss. Only scanFile picks it up.
  writeFileSync(path, `${titleLine("sess-scan", "Set While Down")}\n`);

  const emitted: Array<{ sessionId: string; title: string }> = [];
  const stream = new TranscriptLineStream(
    (sessionId, title) => emitted.push({ sessionId, title }),
    () => {},
  );

  // First boot scan: the file's current title folds once.
  stream.scanFile(path);
  expect(emitted).toEqual([
    { sessionId: "sess-scan", title: "Set While Down" },
  ]);

  // A SECOND scan of the same unchanged file (e.g. another restart) after the
  // change-gate is seeded with that title → suppressed (no duplicate).
  const emitted2: Array<{ sessionId: string; title: string }> = [];
  const stream2 = new TranscriptLineStream(
    (sessionId, title) => emitted2.push({ sessionId, title }),
    () => {},
  );
  stream2.seedLastEmitted("sess-scan", "Set While Down");
  stream2.scanFile(path);
  expect(emitted2).toEqual([]);
});

test("scanFile: only the CURRENT (last) title per session emits, no churn from intermediate renames", () => {
  const path = join(tmpDir, "sess-multi.jsonl");
  // Three historical renames in one file — the scan must emit only the last.
  writeFileSync(
    path,
    `${titleLine("sess-multi", "First")}\n${titleLine("sess-multi", "Second")}\n${titleLine("sess-multi", "Third")}\n`,
  );

  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );
  stream.scanFile(path);
  expect(emitted).toEqual(["Third"]);
});

test("scanFile: a missing/empty file is a non-fatal no-op", () => {
  const emitted: string[] = [];
  const logs: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    (m) => logs.push(m),
  );

  // Missing file → stat fails → skip-and-log, never throws.
  stream.scanFile(join(tmpDir, "does-not-exist.jsonl"));
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("boot scan stat failed"))).toBe(true);

  // Empty file (size 0) → no emit, no log noise.
  const emptyPath = join(tmpDir, "empty.jsonl");
  writeFileSync(emptyPath, "");
  stream.scanFile(emptyPath);
  expect(emitted).toEqual([]);
});

test("scanFile then live onChange: the live tail does not re-emit the scanned title", () => {
  const path = join(tmpDir, "sess-both.jsonl");
  writeFileSync(path, `${titleLine("sess-both", "Current")}\n`);

  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );

  // Boot scan emits the current title once and advances the shared change-gate.
  stream.scanFile(path);
  expect(emitted).toEqual(["Current"]);

  // The live watcher then sees the path for the first time: onChange anchors at
  // EOF (scanFile didn't touch pathState), so the already-scanned line is not
  // re-read. A genuinely new appended title still emits.
  stream.onChange(path);
  expect(emitted).toEqual(["Current"]);
  appendFileSync(path, `${titleLine("sess-both", "Newer")}\n`);
  stream.onChange(path);
  expect(emitted).toEqual(["Current", "Newer"]);
});

test("scanJobsForTitles: scopes to jobs.transcript_path and folds the current title at boot", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  try {
    // A live job whose transcript file carries a title set while the daemon was
    // down (title_source still the lower-priority 'payload', not 'transcript').
    const transcriptPath = join(tmpDir, "boot-sess.jsonl");
    writeFileSync(
      transcriptPath,
      `${titleLine("boot-sess", "Renamed While Down")}\n`,
    );
    db.query(
      "INSERT INTO jobs (job_id, created_at, updated_at, title, title_source, transcript_path) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("boot-sess", 1, 1, "old payload title", "payload", transcriptPath);
    // A pre-v5 job with NULL transcript_path — must be skipped (can't be scanned).
    db.query(
      "INSERT INTO jobs (job_id, created_at, updated_at, transcript_path) VALUES (?, ?, ?, NULL)",
    ).run("no-path-sess", 1, 1);

    const emitted: Array<{ sessionId: string; title: string }> = [];
    const stream = new TranscriptLineStream(
      (sessionId, title) => emitted.push({ sessionId, title }),
      () => {},
    );
    // Boot order: seedFromDb (no transcript-source rows here, so seeds nothing)
    // then scanJobsForTitles.
    seedFromDb(db, stream);
    scanJobsForTitles(db, stream);

    expect(emitted).toEqual([
      { sessionId: "boot-sess", title: "Renamed While Down" },
    ]);
  } finally {
    db.close();
  }
});

test("scanJobsForTitles: an already-folded transcript title is NOT re-emitted on restart", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  try {
    // The session's title already WON at title_source='transcript' (folded by a
    // prior daemon). The transcript file still holds that same title.
    const transcriptPath = join(tmpDir, "folded-sess.jsonl");
    writeFileSync(
      transcriptPath,
      `${titleLine("folded-sess", "Already Folded")}\n`,
    );
    db.query(
      "INSERT INTO jobs (job_id, created_at, updated_at, title, title_source, transcript_path) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("folded-sess", 1, 1, "Already Folded", "transcript", transcriptPath);

    const emitted: string[] = [];
    const stream = new TranscriptLineStream(
      (_s, title) => emitted.push(title),
      () => {},
    );
    // seedFromDb seeds the change-gate with the persisted transcript title, so
    // the subsequent scan of the unchanged file is suppressed — no duplicate
    // TranscriptTitle event on restart.
    seedFromDb(db, stream);
    scanJobsForTitles(db, stream);

    expect(emitted).toEqual([]);
  } finally {
    db.close();
  }
});

test("scanJobsForTitles: boot then drop-recovery over an unchanged file emits nothing the second time", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  try {
    const transcriptPath = join(tmpDir, "recover-sess.jsonl");
    writeFileSync(
      transcriptPath,
      `${titleLine("recover-sess", "Live Rename")}\n`,
    );
    db.query(
      "INSERT INTO jobs (job_id, created_at, updated_at, title, title_source, transcript_path) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("recover-sess", 1, 1, "old payload title", "payload", transcriptPath);

    const emitted: Array<{ sessionId: string; title: string }> = [];
    const stream = new TranscriptLineStream(
      (sessionId, title) => emitted.push({ sessionId, title }),
      () => {},
    );

    // Boot scan: the live rename emits.
    seedFromDb(db, stream);
    scanJobsForTitles(db, stream);
    expect(emitted.length).toBe(1);

    // Simulated drop-recovery re-scan over the SAME warm stream: the in-memory
    // change-gate (lastEmitted, advanced by the boot scan) suppresses the
    // unchanged title — zero duplicate TranscriptTitle messages.
    scanJobsForTitles(db, stream);
    expect(emitted.length).toBe(1);
  } finally {
    db.close();
  }
});

test("scanJobsForTitles: a title changed between boot and recovery emits exactly its delta", () => {
  const dbPath = join(tmpDir, "keeper.db");
  const { db } = openDb(dbPath);
  try {
    const transcriptPath = join(tmpDir, "delta-sess.jsonl");
    writeFileSync(transcriptPath, `${titleLine("delta-sess", "First")}\n`);
    db.query(
      "INSERT INTO jobs (job_id, created_at, updated_at, transcript_path) VALUES (?, ?, ?, ?)",
    ).run("delta-sess", 1, 1, transcriptPath);

    const emitted: Array<{ sessionId: string; title: string }> = [];
    const stream = new TranscriptLineStream(
      (sessionId, title) => emitted.push({ sessionId, title }),
      () => {},
    );

    seedFromDb(db, stream);
    scanJobsForTitles(db, stream);
    expect(emitted).toEqual([{ sessionId: "delta-sess", title: "First" }]);

    // A drop window dropped the rename event; the file now holds a NEW current
    // title. The recovery scan picks up exactly that delta (scanFile emits only
    // the last title per session through the warm change-gate).
    appendFileSync(transcriptPath, `${titleLine("delta-sess", "Second")}\n`);
    scanJobsForTitles(db, stream);
    expect(emitted.length).toBe(2);
    expect(emitted[1]).toEqual({ sessionId: "delta-sess", title: "Second" });
  } finally {
    db.close();
  }
});

test("multi-byte title split across the read boundary does not corrupt (no U+FFFD)", () => {
  const path = join(tmpDir, "sess-emoji.jsonl");
  writeFileSync(path, "");
  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );
  stream.register(path);

  // A title padded so a 4-byte emoji straddles the 64 KiB read-chunk boundary.
  // The persistent StringDecoder must hold the partial code unit across reads.
  const READ_CHUNK = 64 * 1024;
  const emoji = "🚀"; // 4 UTF-8 bytes
  // Build a title whose emoji's first byte lands at offset READ_CHUNK-1, so the
  // remaining 3 bytes spill into the second read.
  const prefixLen =
    READ_CHUNK - 1 - `{"type":"custom-title","customTitle":"`.length;
  const padded = `${"x".repeat(prefixLen)}${emoji}tail`;
  const line = `${titleLine("sess-emoji", padded)}\n`;
  // Confirm the construction actually crosses the boundary.
  const firstByteOfEmoji = Buffer.byteLength(
    `{"type":"custom-title","customTitle":"${"x".repeat(prefixLen)}`,
    "utf8",
  );
  expect(firstByteOfEmoji).toBeLessThan(READ_CHUNK);
  expect(firstByteOfEmoji + 4).toBeGreaterThan(READ_CHUNK);

  appendFileSync(path, line);
  stream.onChange(path);

  expect(emitted.length).toBe(1);
  expect(emitted[0]).toBe(padded);
  // No replacement char crept in.
  expect(emitted[0]?.includes("�")).toBe(false);
  expect(emitted[0]?.includes(emoji)).toBe(true);
});

test("a directory path reaching onChange returns early: no emit, no read-failure log", () => {
  // Defensive guard (F1 fix): a directory path that bypasses the callback's
  // `.jsonl` check must NOT fall through to openSync/readSync — openSync
  // succeeds on a dir and readSync throws EISDIR, which would log a read
  // failure. The `statSync(...).isFile()` guard bails first.
  const dirPath = join(tmpDir, "a-directory");
  mkdirSync(dirPath);
  const emitted: string[] = [];
  const logs: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    (m) => logs.push(m),
  );

  // Drive the directory straight through register + onChange (the path the
  // callback would otherwise hand it). It must produce no read and no emit.
  stream.register(dirPath);
  stream.onChange(dirPath);

  expect(emitted).toEqual([]);
  // No open/read-failure stderr line (EISDIR or otherwise) was logged.
  expect(logs.some((l) => l.includes("open failed"))).toBe(false);
  expect(logs.some((l) => l.includes("read failed"))).toBe(false);
  expect(logs.some((l) => l.includes("EISDIR"))).toBe(false);
});

test("the callback's .jsonl filter ignores non-jsonl + directory paths (no read, no emit)", () => {
  // Mirrors the in-callback `ev.path.endsWith(".jsonl")` guard: a non-.jsonl
  // file and a directory must never reach onChange's read path. We drive the
  // same predicate the worker callback uses, then assert the pure core stays
  // untouched for the filtered paths.
  const emitted: string[] = [];
  const logs: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    (m) => logs.push(m),
  );

  const nonJsonl = join(tmpDir, "notes.txt");
  writeFileSync(nonJsonl, `${titleLine("sess-x", "ShouldNotEmit")}\n`);
  const dirPath = join(tmpDir, "subdir");
  mkdirSync(dirPath);
  const jsonl = join(tmpDir, "sess-ok.jsonl");
  writeFileSync(jsonl, "");

  // The worker callback skips any path not ending in `.jsonl` before calling
  // onChange — replicate that gate here.
  for (const path of [nonJsonl, dirPath, jsonl]) {
    if (!path.endsWith(".jsonl")) {
      continue;
    }
    stream.onChange(path);
  }

  // The non-.jsonl file's title was never read or emitted.
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("failed"))).toBe(false);

  // The .jsonl file still tails normally — append a title and confirm it emits.
  appendFileSync(jsonl, `${titleLine("sess-ok", "RealTitle")}\n`);
  stream.onChange(jsonl);
  expect(emitted).toEqual(["RealTitle"]);
});

// ---------------------------------------------------------------------------
// (a2) matchApiError — pure matcher coverage across the six-kind dispatch
// + the two explicit negative gates (api_retry / SDKRateLimitEvent).
// ---------------------------------------------------------------------------

/**
 * Build a canonical `isApiErrorMessage:true` synthetic-assistant envelope,
 * matching the wire shape of real captured transcript lines (the bare-string
 * `error` form — confirmed against
 * `~/.claude/projects/-Users-mike-code-agentuse/2164484b-*.jsonl` for
 * `authentication_failed` and the 2026-05 `rate_limit` corpus). The matcher
 * accepts both bare-string and structured `error.type` shapes; the bare
 * form is the one Claude Code actually writes in 2026-05.
 */
function apiErrorLine(
  sessionId: string,
  error: unknown,
  text: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    error,
    isApiErrorMessage: true,
    sessionId,
    message: { content: [{ type: "text", text }] },
    ...overrides,
  });
}

test("matchApiError: each canonical kind round-trips into ApiErrorLine.kind verbatim", () => {
  // Positive coverage gate: every kind in the canonical six-value union
  // must round-trip from a bare-string `error` field into the matched
  // `ApiErrorLine.kind`. The five dispatched kinds map to themselves;
  // the matcher's allow-list rejects anything else, so "unknown" can only
  // come from the explicit fallback test below.
  const cases: Array<{ wire: string; expected: ApiErrorKind }> = [
    { wire: "rate_limit", expected: "rate_limit" },
    { wire: "authentication_failed", expected: "authentication_failed" },
    { wire: "billing_error", expected: "billing_error" },
    { wire: "server_error", expected: "server_error" },
    { wire: "invalid_request", expected: "invalid_request" },
  ];
  for (const { wire, expected } of cases) {
    const line = apiErrorLine(`sess-${wire}`, wire, `text for ${wire}`);
    const parsed = JSON.parse(line);
    const match = matchApiError(parsed);
    expect(match).not.toBeNull();
    expect(match?.kind).toBe(expected);
    expect(match?.sessionId).toBe(`sess-${wire}`);
    expect(match?.text).toBe(`text for ${wire}`);
  }
});

test("matchApiError: structured `error.type` wire shape (openclaude SDK declaration) is accepted", () => {
  // Wire-shape variance gate: openclaude's `SDKAssistantMessageError`
  // declares `error.type`, while the real captured 401 envelope writes a
  // bare-string `error`. The matcher reads `error.type ?? error`, so
  // both shapes accept. Coverage for the structured branch.
  const line = apiErrorLine("sess-structured", { type: "server_error" }, "5xx");
  const match = matchApiError(JSON.parse(line));
  expect(match?.kind).toBe("server_error");
});

test("matchApiError: an unrecognized kind string falls through to 'unknown'", () => {
  // Six-kind allow-list rejects anything else. A wire kind not in the
  // canonical set (including the SDK's own `"unknown"` string AND garbage
  // literals) folds to the literal `"unknown"` — the reducer's
  // unknown-fallback bucket. Mirrors the reducer-side
  // `validateApiErrorKind` invariant from the task .1 coverage.
  const cases = [
    "overloaded_error", // a plausible but non-canonical Anthropic shape
    "completely-made-up",
    "", // empty string is still a string
  ];
  for (const wire of cases) {
    const line = apiErrorLine(`sess-fb-${wire || "empty"}`, wire, "msg");
    const match = matchApiError(JSON.parse(line));
    expect(match?.kind).toBe("unknown");
  }
});

test("matchApiError: max_output_tokens folds to 'unknown' (boundary — never stamped as itself)", () => {
  // openclaude's query loop treats `max_output_tokens` as recoverable via
  // compact+retry, so stamping it as a terminal kind would mis-classify
  // recovering sessions. The matcher's allow-list deliberately excludes
  // `max_output_tokens` — if Claude Code ever DOES write an isApiErrorMessage
  // envelope with this kind, it folds to `"unknown"` (the recoverable
  // session would already be back to working by the time the reducer
  // sees the event — `UserPromptSubmit` clears the paired columns). This
  // test PINS the boundary so a future widening of the allow-list is a
  // deliberate decision, not an accident.
  const line = apiErrorLine("sess-mot", "max_output_tokens", "hit ceiling");
  const match = matchApiError(JSON.parse(line));
  expect(match?.kind).toBe("unknown");
});

test("matchApiError: SDK 'unknown' wire string also folds to 'unknown'", () => {
  // openclaude's TS declares `"unknown"` as a valid `SDKAssistantMessageError`
  // discriminant. The matcher's allow-list excludes it (the dispatched set
  // is the five non-"unknown" kinds), so the wire string folds through the
  // same fallback path. End state is identical to the unrecognized-kind
  // case — useful as a sanity gate that we don't accidentally double-map.
  const line = apiErrorLine("sess-sdk-unknown", "unknown", "shrug");
  const match = matchApiError(JSON.parse(line));
  expect(match?.kind).toBe("unknown");
});

test("matchApiError: a missing/non-string error field also folds to 'unknown'", () => {
  // Defensive coverage: a malformed envelope (no `error` field, or one
  // whose value is a non-string non-object) MUST NOT throw and MUST fold
  // to "unknown" so the reducer's terminal-stamp behavior stays consistent.
  // The four guard fields (type/isApiErrorMessage/sessionId/content) still
  // gate match success — this test only widens to the `error` slot itself.
  const cases: unknown[] = [
    { error: undefined }, // missing
    { error: 42 }, // non-string
    { error: null }, // explicit null
  ];
  for (const [i, override] of cases.entries()) {
    const env = {
      type: "assistant",
      isApiErrorMessage: true,
      sessionId: `sess-err-${i}`,
      message: { content: [{ type: "text", text: "msg" }] },
      ...(override as object),
    };
    const match = matchApiError(env);
    expect(match?.kind).toBe("unknown");
    expect(match?.sessionId).toBe(`sess-err-${i}`);
  }
});

test("matchApiError: real captured 401 envelope (bare-string 'authentication_failed') matches", () => {
  // Wire-shape regression gate: a verbatim line from a real captured
  // transcript at
  // ~/.claude/projects/-Users-mike-code-agentuse/2164484b-*.jsonl
  // (the practice-scout's authentication_failed fixture). If Claude Code's
  // writer ever changes shape, this is the canary.
  const line = `{"parentUuid":"dcc9930c-8714-4b3b-98e6-420ce59697bd","isSidechain":false,"type":"assistant","uuid":"d5367c20-bdc1-4bee-b4d9-90a404208ab5","timestamp":"2026-05-26T18:45:22.855Z","message":{"id":"f87b7fc5-d392-4db8-a7eb-c55cb0adccbb","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","content":[{"type":"text","text":"Please run /login · API Error: 401 Invalid authentication credentials"}],"context_management":null},"requestId":"req_011CbRgADwFUygFMyevtB7zP","error":"authentication_failed","isApiErrorMessage":true,"apiErrorStatus":401,"userType":"external","entrypoint":"cli","cwd":"/Users/mike/code/agentuse","sessionId":"2164484b-e74a-4f26-b716-b80b44c4de61","version":"2.1.150","gitBranch":"main"}`;
  const match = matchApiError(JSON.parse(line));
  expect(match).not.toBeNull();
  expect(match?.kind).toBe("authentication_failed");
  expect(match?.sessionId).toBe("2164484b-e74a-4f26-b716-b80b44c4de61");
  expect(match?.text).toBe(
    "Please run /login · API Error: 401 Invalid authentication credentials",
  );
});

test("matchApiError negative gate: `{type:'system', subtype:'api_retry'}` (SDKAPIRetryMessage) MUST NOT match", () => {
  // SDKAPIRetryMessage is a transient retry — session still live. Two
  // gates reject it: `type !== "assistant"` AND the cheap pre-filter on
  // `"isApiErrorMessage":true` (this envelope has no such field). This
  // test exercises the in-matcher gate. A false-positive here would
  // mid-life-stamp a session that's actively recovering.
  const retry = {
    type: "system",
    subtype: "api_retry",
    sessionId: "sess-retry",
    retryInMs: 577.78,
    retryAttempt: 1,
    error: { type: null, cause: { code: "ConnectionRefused" } },
    isApiErrorMessage: undefined, // explicitly absent
  };
  expect(matchApiError(retry)).toBeNull();
});

test("matchApiError negative gate: SDKRateLimitEvent (quota notification, no isApiErrorMessage) MUST NOT match", () => {
  // SDKRateLimitEvent is the quota-notification envelope — a distinct
  // shape with NO `isApiErrorMessage` field at all. The matcher's
  // `isApiErrorMessage !== true` guard rejects it. A false-positive here
  // would stamp a session as failed every time Anthropic sends a quota
  // warning (a routine signal — the session keeps running).
  const quotaNotification = {
    type: "system",
    subtype: "rate_limit_event",
    sessionId: "sess-quota",
    rate_limits: [{ limit: 50_000_000, used: 49_900_000, window: "5h" }],
    // No isApiErrorMessage field whatsoever — distinct envelope.
  };
  expect(matchApiError(quotaNotification)).toBeNull();
});

test("matchApiError negative gate: a real assistant turn (no isApiErrorMessage) MUST NOT match", () => {
  // A normal assistant message reaches the matcher only if its line
  // happens to contain `"isApiErrorMessage":true` as a substring — which
  // a real assistant turn doesn't. But if the pre-filter is ever loosened
  // or someone calls the matcher directly, the four-guard gate must
  // still reject. Test the in-matcher gate.
  const realTurn = {
    type: "assistant",
    sessionId: "sess-real",
    message: { content: [{ type: "text", text: "Hello!" }] },
    // No isApiErrorMessage, no error — a vanilla assistant turn.
  };
  expect(matchApiError(realTurn)).toBeNull();
});

test("matchApiError: dispatchLine pre-filter widening — an authentication_failed line emits via onApiError", () => {
  // End-to-end coverage on the TranscriptLineStream layer: the pre-filter
  // widened from `'"rate_limit"'` to `'"isApiErrorMessage":true'`, so a
  // 401 envelope (which doesn't contain "rate_limit") must still flow
  // through. Without this gate, the matcher would never run on the very
  // failure mode the task .2 generalization adds.
  const path = join(tmpDir, "sess-auth.jsonl");
  writeFileSync(path, "");
  const errors: Array<{ sessionId: string; text: string; kind: ApiErrorKind }> =
    [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    (sessionId, text, kind) => errors.push({ sessionId, text, kind }),
  );
  stream.register(path);

  const line = apiErrorLine(
    "sess-auth",
    "authentication_failed",
    "Please run /login",
  );
  appendFileSync(path, `${line}\n`);
  stream.onChange(path);

  expect(errors).toEqual([
    {
      sessionId: "sess-auth",
      text: "Please run /login",
      kind: "authentication_failed",
    },
  ]);
});

test("matchApiError: dispatchLine pre-filter — a rate_limit line still emits (regression gate for task .1 behavior)", () => {
  // The widened pre-filter `"isApiErrorMessage":true` must catch the
  // pre-existing rate-limit envelope just as the old `'"rate_limit"'`
  // needle did. This pins the no-regression bar: tasks .2/.3 generalize
  // WITHOUT dropping the original signal.
  const path = join(tmpDir, "sess-rl.jsonl");
  writeFileSync(path, "");
  const errors: Array<{ kind: ApiErrorKind }> = [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    (_s, _t, kind) => errors.push({ kind }),
  );
  stream.register(path);

  const line = apiErrorLine("sess-rl", "rate_limit", "out of usage");
  appendFileSync(path, `${line}\n`);
  stream.onChange(path);

  expect(errors).toEqual([{ kind: "rate_limit" }]);
});

test("matchApiError: dispatchLine pre-filter rejects a non-isApiErrorMessage line (perf gate)", () => {
  // The pre-filter exists for perf: a busy transcript writes thousands of
  // assistant tool_use turns and tool_result attachments. None of them
  // should reach JSON.parse, let alone the matcher. This test pins the
  // contract by tracking emits across a populated session line — the
  // emit list MUST stay empty.
  const path = join(tmpDir, "sess-noise.jsonl");
  writeFileSync(path, "");
  const errors: ApiErrorKind[] = [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    (_s, _t, kind) => errors.push(kind),
  );
  stream.register(path);

  // A normal assistant tool_use turn — large, busy, but no isApiErrorMessage.
  const toolUse = JSON.stringify({
    type: "assistant",
    sessionId: "sess-noise",
    message: {
      content: [
        { type: "text", text: "Looking up..." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Bash",
          input: { command: "ls" },
        },
      ],
    },
  });
  appendFileSync(path, `${toolUse}\n`);
  stream.onChange(path);

  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) Native addon smoke test
// ---------------------------------------------------------------------------

test("smoke: @parcel/watcher loads + fires a create event under bun test", async () => {
  const watcher = await import("@parcel/watcher");
  expect(typeof watcher.subscribe).toBe("function");

  // tmpDir already exists (created in beforeEach) — watch it directly.
  const fired: string[] = [];
  const sub = await watcher.subscribe(tmpDir, (err, events) => {
    if (err) {
      return;
    }
    for (const ev of events) {
      fired.push(ev.path);
    }
  });

  try {
    // Create a file and wait for the FSEvents notification.
    const target = join(tmpDir, "fires.jsonl");
    writeFileSync(target, `${titleLine("smoke", "Title")}\n`);

    const deadline = Date.now() + 3000;
    while (fired.length === 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(fired.length).toBeGreaterThanOrEqual(1);
  } finally {
    await sub.unsubscribe();
  }
});

// ---------------------------------------------------------------------------
// (c) Real spawned Worker — clean shutdown
// ---------------------------------------------------------------------------

test("spawned Worker shuts down cleanly on shutdown message", async () => {
  const dbPath = join(tmpDir, "keeper.db");
  // Bootstrap the schema with a writer so the worker's read-only open succeeds.
  openDb(dbPath).db.close();
  // tmpDir already exists, so the worker's subscribe() can bind to it.
  const worker = new Worker(
    new URL("../src/transcript-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath, watchRoot: tmpDir },
    } as WorkerOptions & { workerData: unknown },
  );

  const exited = new Promise<void>((resolve) => {
    worker.addEventListener("close", () => resolve());
  });

  // Let it boot, open its connection, and subscribe.
  await Bun.sleep(200);
  worker.postMessage({ type: "shutdown" });

  const result = await Promise.race([
    exited.then(() => "exited" as const),
    Bun.sleep(3000).then(() => "timeout" as const),
  ]);

  expect(result).toBe("exited");
});

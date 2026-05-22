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
  scanJobsForTitles,
  seedFromDb,
  TranscriptLineStream,
} from "../src/transcript-worker";

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

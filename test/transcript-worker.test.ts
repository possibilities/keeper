/**
 * Transcript-worker tests — DETERMINISM unit tests against the PURE
 * `TranscriptLineStream` core + the `scanFile`/`scanJobsForTitles` title seam +
 * the `matchApiError` line parser — no Worker, no watcher, just files +
 * `onChange`. Cover partial-line buffering across two reads, truncation reset,
 * malformed-skip, change-only emit, a multi-byte (emoji) title split across the
 * 64 KiB read boundary (must NOT decode to U+FFFD), and the fn-720 backstop
 * missed-wake records.
 *
 * The OS-coupled layers — the `@parcel/watcher` native-addon load smoke and the
 * real spawned-Worker shutdown test — were deleted in fn-752: they assert
 * OS/runtime behavior (native dlopen, FSEvents delivery, thread teardown)
 * rather than keeper's own transcript logic. Dogfooding is the backstop.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackstopCounters,
  type BackstopMessage,
  type BackstopRecord,
  type BackstopRollup,
  buildMissedWakeRecord,
} from "../src/backstop-telemetry";
import {
  decideTranscriptResubscribe,
  matchApiError,
  matchAskUserQuestion,
  matchSubagentTurn,
  scanJobsForTitles,
  seedFromDb,
  settleClosedSubagentTurns,
  TRANSCRIPT_REARM_FLAP_GUARD_MS,
  TranscriptLineStream,
} from "../src/transcript-worker";
import type {
  ApiErrorKind,
  InputRequestKind,
  SubagentDisposition,
} from "../src/types";
import { freshMemDb } from "./helpers/template-db";

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

  // Missing file → stat fails with ENOENT → SILENT skip, never throws. A
  // vanished transcript is the expected case (scanJobsForTitles walks every
  // historical jobs.transcript_path, most long gone); logging each one buried
  // the real signal under ~200k lines / 75MB per boot, so ENOENT is swallowed.
  stream.scanFile(join(tmpDir, "does-not-exist.jsonl"));
  expect(emitted).toEqual([]);
  expect(logs).toEqual([]);

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
  // fn-769 mem variant: single in-process connection (`seedFromDb` /
  // `scanJobsForTitles` reuse the same `db`); no second opener or worker
  // touches the path.
  const { db } = freshMemDb();
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
  // fn-769 mem variant: single in-process connection (`seedFromDb` /
  // `scanJobsForTitles` reuse the same `db`); no second opener or worker
  // touches the path.
  const { db } = freshMemDb();
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
  // fn-769 mem variant: single in-process connection (`seedFromDb` /
  // `scanJobsForTitles` reuse the same `db`); no second opener or worker
  // touches the path.
  const { db } = freshMemDb();
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

// ---------------------------------------------------------------------------
// fn-759: the heartbeat/drop-rescan stat memo — an unchanged file is skipped
// without reading any bytes; changed/truncated files still scan; failure paths
// never poison the memo; ENOENT clears it.
// ---------------------------------------------------------------------------

// A fixed whole-second mtime the tests pin every file to. utimesSync carries
// only the precision a JS Date holds (whole ms), and APFS/Bun report mtimeMs as
// a sub-ms float — so pinning to a whole second guarantees a reproducible
// mtimeMs across writes (no sub-ms drift the memo would (correctly) treat as a
// change). The memo gates on the verbatim float; pinning makes that float stable.
const PINNED_MTIME = new Date(1_700_000_000_000); // 2023-11-14T22:13:20.000Z

// Pin a file's atime+mtime to PINNED_MTIME so its mtimeMs is reproducible.
function pinMtime(path: string): void {
  utimesSync(path, PINNED_MTIME, PINNED_MTIME);
}

// Helper: snapshot a file's size, mutate its content in place to a NEW title,
// then forcibly restore byte-identical {size, mtimeMs} (size via pad/truncate,
// mtimeMs via the PINNED_MTIME). A subsequent scan that reads the file would
// observe the poisoned content (and emit its title); a memo-skipped scan never
// reads it. So an emit here is a black-box "the file WAS read" signal.
function poisonContentKeepingStat(path: string, newContent: string): void {
  const beforeSize = statSync(path).size;
  writeFileSync(path, newContent);
  const after = statSync(path);
  if (after.size < beforeSize) {
    appendFileSync(path, " ".repeat(beforeSize - after.size));
  } else if (after.size > beforeSize) {
    truncateSync(path, beforeSize);
  }
  pinMtime(path);
  const restored = statSync(path);
  // Sanity: the memo gates on the float pair; both must match for the skip arm.
  expect(restored.size).toBe(beforeSize);
  expect(restored.mtimeMs).toBe(PINNED_MTIME.getTime());
}

test("scanFile memo: an unchanged file is skipped without reading bytes (poisoned content never surfaces)", () => {
  const path = join(tmpDir, "memo-unchanged.jsonl");
  writeFileSync(path, `${titleLine("memo-sess", "Original")}\n`);
  pinMtime(path);

  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );

  // First scan reads + emits, and records the {size, mtimeMs} memo.
  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["Original"]);

  // Poison the file with a DIFFERENT title at byte-identical {size, mtimeMs}.
  // If the second scan read the file it would emit "Poisoned" (the change-gate
  // would NOT suppress it — the title differs). A memo skip never reads it.
  poisonContentKeepingStat(path, `${titleLine("memo-sess", "Poisoned")}\n`);

  expect(stream.scanFile(path)).toBe(false);
  expect(emitted).toEqual(["Original"]);
});

test("scanFile memo: an appended file rescans and emits the new title", () => {
  const path = join(tmpDir, "memo-append.jsonl");
  writeFileSync(path, `${titleLine("append-sess", "First")}\n`);

  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );

  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["First"]);

  // A real append grows size (and bumps mtimeMs) — the memo no longer matches.
  appendFileSync(path, `${titleLine("append-sess", "Second")}\n`);
  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["First", "Second"]);
});

test("scanFile memo: a truncated/rotated file rescans from 0", () => {
  const path = join(tmpDir, "memo-truncate.jsonl");
  // Two titles so the file is comfortably larger than the rotated content.
  writeFileSync(
    path,
    `${titleLine("rot-sess", "Old A")}\n${titleLine("rot-sess", "Old B")}\n`,
  );

  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );

  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["Old B"]);

  // Rotation: file shrinks to a fresh, smaller body with a new title. size <
  // memo.size — the memo treats it as changed and rescans from offset 0.
  writeFileSync(path, `${titleLine("rot-sess", "Rotated")}\n`);
  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["Old B", "Rotated"]);
});

test("scanFile memo: a stat failure leaves no memo entry so the next healthy tick rescans", () => {
  const path = join(tmpDir, "memo-eacces.jsonl");
  writeFileSync(path, `${titleLine("eacces-sess", "Healthy")}\n`);

  const logs: string[] = [];
  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    (m) => logs.push(m),
  );

  // Make the file unreadable -> statSync still succeeds on macOS, but openSync
  // fails (EACCES). The open-failure path `return false`s BEFORE the memo write,
  // so no entry is recorded.
  chmodSync(path, 0o000);
  expect(stream.scanFile(path)).toBe(false);
  expect(emitted).toEqual([]);
  expect(logs.some((m) => m.includes("open failed"))).toBe(true);

  // Heal the file: the absent memo means the next tick performs a full rescan
  // (poisoning would have been read had a memo wrongly suppressed it).
  chmodSync(path, 0o600);
  poisonContentKeepingStat(path, `${titleLine("eacces-sess", "Rescued")}\n`);
  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["Rescued"]);
});

test("scanFile memo: ENOENT clears the entry so a re-appeared file rescans", () => {
  const path = join(tmpDir, "memo-enoent.jsonl");
  writeFileSync(path, `${titleLine("enoent-sess", "Before")}\n`);

  const emitted: string[] = [];
  const stream = new TranscriptLineStream(
    (_s, title) => emitted.push(title),
    () => {},
  );

  // Seed the memo.
  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["Before"]);

  // File vanishes -> ENOENT clears the memo entry (no cached "gone").
  unlinkSync(path);
  expect(stream.scanFile(path)).toBe(false);

  // A re-appeared file at the SAME path, byte-identical {size, mtimeMs} to the
  // pre-vanish snapshot, MUST still rescan because ENOENT cleared the memo.
  // Recreate "Before" first, restore its stat, then poison the content.
  writeFileSync(path, `${titleLine("enoent-sess", "Before")}\n`);
  poisonContentKeepingStat(path, `${titleLine("enoent-sess", "After")}\n`);
  expect(stream.scanFile(path)).toBe(true);
  expect(emitted).toEqual(["Before", "After"]);
});

test("scanJobsForTitles: a title changed between boot and recovery emits exactly its delta", () => {
  // fn-769 mem variant: single in-process connection (`seedFromDb` /
  // `scanJobsForTitles` reuse the same `db`); no second opener or worker
  // touches the path.
  const { db } = freshMemDb();
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
 * `~/.claude/projects/-Users-mike-code-agentusage/2164484b-*.jsonl` for
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
  // ~/.claude/projects/-Users-mike-code-agentusage/2164484b-*.jsonl
  // (the practice-scout's authentication_failed fixture). If Claude Code's
  // writer ever changes shape, this is the canary.
  const line = `{"parentUuid":"dcc9930c-8714-4b3b-98e6-420ce59697bd","isSidechain":false,"type":"assistant","uuid":"d5367c20-bdc1-4bee-b4d9-90a404208ab5","timestamp":"2026-05-26T18:45:22.855Z","message":{"id":"f87b7fc5-d392-4db8-a7eb-c55cb0adccbb","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","content":[{"type":"text","text":"Please run /login · API Error: 401 Invalid authentication credentials"}],"context_management":null},"requestId":"req_011CbRgADwFUygFMyevtB7zP","error":"authentication_failed","isApiErrorMessage":true,"apiErrorStatus":401,"userType":"external","entrypoint":"cli","cwd":"/Users/mike/code/agentusage","sessionId":"2164484b-e74a-4f26-b716-b80b44c4de61","version":"2.1.150","gitBranch":"main"}`;
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
// (a3) matchAskUserQuestion — pure matcher coverage for the InputRequest
// signal (schema v25). Today the only matched discriminator is
// `ask_user_question`; future built-in interactive tools (e.g. ExitPlanMode)
// would extend the same matcher and slot into the same `InputRequestLine`
// shape via the `requestKind` discriminator.
// ---------------------------------------------------------------------------

/**
 * Build an `assistant` turn whose `message.content[]` carries a
 * `tool_use:AskUserQuestion` block (plus optional sibling blocks). Real
 * captured shape: a leading text block often precedes the tool_use, and
 * additional tool_uses can interleave — the matcher must walk the array.
 */
function askUserQuestionLine(
  sessionId: string,
  options: {
    leadingText?: string;
    extraTools?: Array<{ name: string }>;
    askUserQuestionPosition?: "first" | "last" | "middle";
  } = {},
): string {
  const position = options.askUserQuestionPosition ?? "last";
  const auqBlock = {
    type: "tool_use",
    id: "toolu_auq01",
    name: "AskUserQuestion",
    input: { questions: [{ question: "Pick one", header: "h", options: [] }] },
  };
  const content: unknown[] = [];
  if (options.leadingText) {
    content.push({ type: "text", text: options.leadingText });
  }
  const extras = (options.extraTools ?? []).map((t, i) => ({
    type: "tool_use",
    id: `toolu_extra${i}`,
    name: t.name,
    input: {},
  }));
  if (position === "first") {
    content.push(auqBlock, ...extras);
  } else if (position === "middle") {
    if (extras.length === 0) {
      content.push(auqBlock);
    } else {
      const mid = Math.floor(extras.length / 2);
      content.push(...extras.slice(0, mid), auqBlock, ...extras.slice(mid));
    }
  } else {
    content.push(...extras, auqBlock);
  }
  return JSON.stringify({
    type: "assistant",
    sessionId,
    message: { content },
  });
}

test("matchAskUserQuestion: positive — captured AskUserQuestion shape matches", () => {
  // The canonical real-corpus shape: leading text + a single AskUserQuestion
  // tool_use, real assistant turn (not synthetic). Verified against
  // ~/.claude/projects/-Users-mike-code-jobsearch/22c690a6-*.jsonl line 54.
  const line = askUserQuestionLine("sess-auq", {
    leadingText: "Let me confirm.",
    askUserQuestionPosition: "last",
  });
  const match = matchAskUserQuestion(JSON.parse(line));
  expect(match).toEqual({
    sessionId: "sess-auq",
    requestKind: "ask_user_question",
  });
});

test("matchAskUserQuestion: positive — multi-content with text + AskUserQuestion + other tool_use emits exactly one", () => {
  // The matcher walks the array; a mixed-content turn (text + Bash tool_use
  // + AskUserQuestion + Read tool_use) must surface the AskUserQuestion
  // exactly once. This is the regression gate for the
  // "iterate content[]; never index content[0]" invariant — if the matcher
  // indexed `content[0]`, this would silently miss.
  const line = askUserQuestionLine("sess-multi", {
    leadingText: "Thinking...",
    extraTools: [{ name: "Bash" }, { name: "Read" }],
    askUserQuestionPosition: "middle",
  });
  const match = matchAskUserQuestion(JSON.parse(line));
  expect(match).toEqual({
    sessionId: "sess-multi",
    requestKind: "ask_user_question",
  });
});

test("matchAskUserQuestion: negative — assistant turn with other tool_use but no AskUserQuestion does not match", () => {
  const line = JSON.stringify({
    type: "assistant",
    sessionId: "sess-bash-only",
    message: {
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "t2", name: "Read", input: { path: "/x" } },
      ],
    },
  });
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: negative — assistant turn with only text content does not match", () => {
  const line = JSON.stringify({
    type: "assistant",
    sessionId: "sess-text",
    message: { content: [{ type: "text", text: "just talking" }] },
  });
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: negative — rate_limit synthetic (assistant, isApiErrorMessage) does not match", () => {
  // A canonical rate-limit envelope: `type:"assistant"` is satisfied, but no
  // tool_use block exists — the matcher walks content and finds only text.
  // Gate ensures the input-request matcher never co-fires with api-error.
  const line = apiErrorLine(
    "sess-rl-cross",
    "rate_limit",
    "You've hit your session limit",
  );
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: negative — custom-title line does not match", () => {
  const line = titleLine("sess-title", "AskUserQuestion as a quoted title");
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: negative — user turn carrying tool_result does not match", () => {
  // The tool_result for a previous AskUserQuestion lives in a `type:"user"`
  // turn. The matcher's first gate (`type === "assistant"`) bounces it.
  const line = JSON.stringify({
    type: "user",
    sessionId: "sess-user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "answer",
        },
      ],
    },
  });
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: negative — missing sessionId does not match", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "AskUserQuestion", input: {} },
      ],
    },
  });
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: negative — non-array content does not match", () => {
  const line = JSON.stringify({
    type: "assistant",
    sessionId: "sess-bad-content",
    message: { content: "not an array" },
  });
  expect(matchAskUserQuestion(JSON.parse(line))).toBeNull();
});

test("matchAskUserQuestion: dispatchLine — a captured AskUserQuestion line emits exactly one InputRequest", () => {
  // End-to-end on the TranscriptLineStream: the pre-filter must let
  // `"name":"AskUserQuestion"` through, the matcher must accept it, and
  // the fourth callback must receive a single `(sessionId, requestKind)`.
  const path = join(tmpDir, "sess-auq.jsonl");
  writeFileSync(path, "");
  const requests: Array<{
    sessionId: string;
    requestKind: InputRequestKind;
  }> = [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    () => {},
    (sessionId, requestKind) => requests.push({ sessionId, requestKind }),
  );
  stream.register(path);

  const line = askUserQuestionLine("sess-auq", {
    leadingText: "Let me confirm.",
  });
  appendFileSync(path, `${line}\n`);
  stream.onChange(path);

  expect(requests).toEqual([
    { sessionId: "sess-auq", requestKind: "ask_user_question" },
  ]);
});

test("matchAskUserQuestion: dispatchLine — malformed JSON whose substring matches the pre-filter skip-and-logs without throwing", () => {
  // The pre-filter is a substring check; a truncated/corrupt line that
  // happens to contain `"name":"AskUserQuestion"` must skip-and-log
  // (logged messages collected via the `log` callback) and NOT throw —
  // mirrors the api-error / custom-title malformed-skip contract.
  const path = join(tmpDir, "sess-malformed.jsonl");
  writeFileSync(path, "");
  const requests: InputRequestKind[] = [];
  const logs: string[] = [];
  const stream = new TranscriptLineStream(
    () => {},
    (m) => logs.push(m),
    () => {},
    (_s, kind) => requests.push(kind),
  );
  stream.register(path);

  // Truncated mid-object — pre-filter substring is present, but JSON.parse fails.
  appendFileSync(path, `{"type":"assistant","name":"AskUserQuestion"\n`);
  expect(() => stream.onChange(path)).not.toThrow();
  expect(requests).toEqual([]);
  expect(logs.some((l) => l.includes("malformed"))).toBe(true);
});

test("matchAskUserQuestion: dispatchLine pre-filter rejects an assistant tool_use turn whose name is NOT AskUserQuestion (perf gate)", () => {
  // Mirrors the matchApiError perf-gate test: a busy assistant turn full of
  // Bash/Read tool_uses must bail at the substring check, never reaching
  // JSON.parse. Tracked indirectly via "no emit": even if it parsed, the
  // matcher would return null; this test pins both ends of the contract.
  const path = join(tmpDir, "sess-noise-auq.jsonl");
  writeFileSync(path, "");
  const requests: InputRequestKind[] = [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    () => {},
    (_s, kind) => requests.push(kind),
  );
  stream.register(path);

  const toolUse = JSON.stringify({
    type: "assistant",
    sessionId: "sess-noise-auq",
    message: {
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  appendFileSync(path, `${toolUse}\n`);
  stream.onChange(path);
  expect(requests).toEqual([]);
});

test("disjointness corpus: the three pre-filter needles never co-fire on the same line", () => {
  // The pre-filter contract: a line matches AT MOST ONE of the three
  // needles (`custom-title` / `"isApiErrorMessage":true` /
  // `"name":"AskUserQuestion"`). This corpus walks a real captured
  // representative of each plus a few cross-contamination cases the
  // disjointness gate was designed to catch:
  //   - a custom-title naming "AskUserQuestion" in its text
  //   - a rate-limit envelope whose `text` happens to render the prior
  //     turn's `AskUserQuestion` literally
  // Asserts exactly one needle fires per line (or zero for ordinary
  // tool_use noise).
  const cases: Array<{ name: string; line: string; expect: 0 | 1 }> = [
    { name: "title", line: titleLine("s", "Plain title"), expect: 1 },
    {
      name: "title-naming-auq",
      line: titleLine("s", "Renamed: handling AskUserQuestion"),
      expect: 1, // matches "custom-title" only; isInputRequest gated off.
    },
    {
      name: "api-error-rate-limit",
      line: apiErrorLine("s", "rate_limit", "out of usage"),
      expect: 1,
    },
    {
      name: "api-error-with-auq-text",
      line: apiErrorLine(
        "s",
        "rate_limit",
        'prior turn was tool_use "AskUserQuestion"',
      ),
      expect: 1, // isApiErrorMessage wins; isInputRequest gated off by precedence.
    },
    {
      name: "ask-user-question",
      line: askUserQuestionLine("s"),
      expect: 1,
    },
    {
      name: "vanilla-tool-use",
      line: JSON.stringify({
        type: "assistant",
        sessionId: "s",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      }),
      expect: 0,
    },
  ];

  for (const c of cases) {
    const isTitle = c.line.includes("custom-title");
    const isApiError = !isTitle && c.line.includes('"isApiErrorMessage":true');
    const isInputRequest =
      !isTitle && !isApiError && c.line.includes('"name":"AskUserQuestion"');
    const hits = [isTitle, isApiError, isInputRequest].filter(Boolean).length;
    expect({ name: c.name, hits }).toEqual({
      name: c.name,
      hits: c.expect,
    });
  }
});

// ---------------------------------------------------------------------------
// fn-38.2 — matchSubagentTurn: the SILENT_STREAM_CUT signature parser. A
// subagent sidecar assistant turn carries `agentId` + `sessionId` + a
// `message.stop_reason`; the matcher classifies the cut ('tool_use'/null) vs
// clean (anything else) disposition.
// ---------------------------------------------------------------------------

/** Build a subagent assistant-turn JSONL line (the `<sid>/subagents/…` shape). */
function subagentTurnLine(
  sessionId: string,
  agentId: string,
  stopReason: string | null,
  // Omit the key entirely to model a non-settled frame.
  opts: { omitStopReason?: boolean } = {},
): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: "working" }],
  };
  if (!opts.omitStopReason) {
    message.stop_reason = stopReason;
  }
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    agentId,
    sessionId,
    requestId: `req-${agentId}`,
    message,
  });
}

test("matchSubagentTurn: stop_reason='tool_use' is a cut (SILENT_STREAM_CUT signature)", () => {
  const m = matchSubagentTurn(
    JSON.parse(subagentTurnLine("sess", "agent-abc", "tool_use")),
  );
  expect(m).toEqual({
    sessionId: "sess",
    agentId: "agent-abc",
    invocationId: "req-agent-abc",
    disposition: "cut",
    settled: false,
  });
});

test("matchSubagentTurn: stop_reason=null (interrupted stream) is a cut", () => {
  const m = matchSubagentTurn(
    JSON.parse(subagentTurnLine("sess", "agent-abc", null)),
  );
  expect(m?.disposition).toBe("cut");
});

test("matchSubagentTurn: stop_reason='end_turn' is clean (negative control)", () => {
  const m = matchSubagentTurn(
    JSON.parse(subagentTurnLine("sess", "agent-abc", "end_turn")),
  );
  expect(m).toEqual({
    sessionId: "sess",
    agentId: "agent-abc",
    invocationId: "req-agent-abc",
    disposition: "clean",
    settled: true,
  });
});

test("matchSubagentTurn: other terminal stop_reasons fold to clean (never a false cut)", () => {
  for (const sr of ["max_tokens", "stop_sequence", "pause_turn"]) {
    const m = matchSubagentTurn(
      JSON.parse(subagentTurnLine("sess", "agent-abc", sr)),
    );
    expect({ sr, disposition: m?.disposition }).toEqual({
      sr,
      disposition: "clean" as SubagentDisposition,
    });
  }
});

test("matchSubagentTurn: a parent assistant turn (no agentId) is not a subagent turn", () => {
  const parentLine = JSON.stringify({
    type: "assistant",
    sessionId: "sess",
    message: { role: "assistant", stop_reason: "tool_use", content: [] },
  });
  expect(matchSubagentTurn(JSON.parse(parentLine))).toBeNull();
});

test("matchSubagentTurn: a frame missing stop_reason entirely is skipped", () => {
  const m = matchSubagentTurn(
    JSON.parse(
      subagentTurnLine("sess", "agent-abc", null, { omitStopReason: true }),
    ),
  );
  expect(m).toBeNull();
});

test("matchSubagentTurn: a user/tool_result line (not an assistant turn) is skipped", () => {
  const userLine = JSON.stringify({
    type: "user",
    isSidechain: true,
    agentId: "agent-abc",
    sessionId: "sess",
    message: { role: "user", content: [{ type: "tool_result" }] },
  });
  expect(matchSubagentTurn(JSON.parse(userLine))).toBeNull();
});

test('subagent-turn needle: the `"agentId":` pre-filter pins to subagent lines only', () => {
  // A subagent assistant turn carries `"agentId":`; a parent assistant turn and
  // a vanilla parent tool_use do not — so the independent 4th needle never
  // co-fires on parent-transcript lines.
  const subLine = subagentTurnLine("sess", "agent-abc", "tool_use");
  const parentTitle = titleLine("sess", "hi");
  const parentToolUse = JSON.stringify({
    type: "assistant",
    sessionId: "sess",
    message: { content: [{ type: "tool_use", name: "Bash" }] },
  });
  expect(subLine.includes('"agentId":')).toBe(true);
  expect(parentTitle.includes('"agentId":')).toBe(false);
  expect(parentToolUse.includes('"agentId":')).toBe(false);
});

test("TranscriptLineStream keeps a cut provisional until invocation settlement", () => {
  const path = join(tmpDir, "agent-abc.jsonl");
  writeFileSync(path, "");
  const seen: Array<{
    sessionId: string;
    agentId: string;
    disposition: SubagentDisposition;
  }> = [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    () => {},
    () => {},
    (sessionId, agentId, disposition) =>
      seen.push({ sessionId, agentId, disposition }),
  );
  stream.register(path);
  appendFileSync(
    path,
    `${subagentTurnLine("sess", "agent-abc", "tool_use")}\n`,
  );
  stream.onChange(path);
  expect(seen).toEqual([]);
  expect(stream.settleSubagentTurn("sess", "agent-abc")).toBe(true);
  expect(seen).toEqual([
    { sessionId: "sess", agentId: "agent-abc", disposition: "cut" },
  ]);
  expect(stream.settleSubagentTurn("sess", "agent-abc")).toBe(false);
});

test("a closed invocation is the positive boundary that settles a true cut", () => {
  const { db } = freshMemDb();
  try {
    db.run(
      "INSERT INTO jobs (job_id, created_at, updated_at, state) VALUES ('sess', 1, 1, 'working')",
    );
    db.run(
      `INSERT INTO subagent_invocations
         (job_id, agent_id, turn_seq, ts, status, duration_ms, last_event_id, updated_at)
       VALUES ('sess', 'agent-cut', 0, 1, 'ok', 10, 1, 2)`,
    );
    const path = join(tmpDir, "agent-cut.jsonl");
    writeFileSync(path, "");
    const seen: SubagentDisposition[] = [];
    const stream = new TranscriptLineStream(
      () => {},
      () => {},
      () => {},
      () => {},
      (_sessionId, _agentId, disposition) => seen.push(disposition),
    );
    stream.register(path);
    appendFileSync(
      path,
      `${subagentTurnLine("sess", "agent-cut", "tool_use")}\n`,
    );
    stream.onChange(path);
    expect(settleClosedSubagentTurns(db, stream)).toBe(1);
    expect(seen).toEqual(["cut"]);
    expect(settleClosedSubagentTurns(db, stream)).toBe(0);
  } finally {
    db.close();
  }
});

test("boundary scan sees a clean response even when its watcher event is delayed", () => {
  const { db } = freshMemDb();
  try {
    db.run(
      "INSERT INTO jobs (job_id, created_at, updated_at, state) VALUES ('sess', 1, 1, 'working')",
    );
    db.run(
      `INSERT INTO subagent_invocations
         (job_id, agent_id, turn_seq, ts, status, duration_ms, last_event_id, updated_at)
       VALUES ('sess', 'agent-lag', 0, 1, 'ok', 10, 1, 2)`,
    );
    const path = join(tmpDir, "agent-lag.jsonl");
    writeFileSync(path, "");
    const seen: SubagentDisposition[] = [];
    const stream = new TranscriptLineStream(
      () => {},
      () => {},
      () => {},
      () => {},
      (_sessionId, _agentId, disposition) => seen.push(disposition),
    );
    stream.register(path);
    appendFileSync(
      path,
      `${subagentTurnLine("sess", "agent-lag", "tool_use")}\n`,
    );
    stream.onChange(path);
    appendFileSync(
      path,
      `${subagentTurnLine("sess", "agent-lag", "end_turn")}\n`,
    );
    expect(settleClosedSubagentTurns(db, stream)).toBe(1);
    expect(seen).toEqual(["clean"]);
  } finally {
    db.close();
  }
});

test("TranscriptLineStream clean settlement supersedes an intermediate cut", () => {
  const path = join(tmpDir, "agent-clean.jsonl");
  writeFileSync(path, "");
  const seen: SubagentDisposition[] = [];
  const stream = new TranscriptLineStream(
    () => {},
    () => {},
    () => {},
    () => {},
    (_sessionId, _agentId, disposition) => seen.push(disposition),
  );
  stream.register(path);
  appendFileSync(
    path,
    `${subagentTurnLine("sess", "agent-clean", "tool_use")}\n`,
  );
  stream.onChange(path);
  appendFileSync(
    path,
    `${subagentTurnLine("sess", "agent-clean", "end_turn")}\n`,
  );
  stream.onChange(path);
  expect(seen).toEqual(["clean"]);
  expect(stream.settleSubagentTurn("sess", "agent-clean")).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-720 backstop telemetry — the emitted-boolean denominator out of
// scanJobsForTitles + the transcript-heartbeat missed-wake record. The
// heartbeat body lives inside the worker `main` closure, so (per the
// emitSnapshot-delta test pattern in git-worker.test.ts) we faithfully
// re-create it: the SAME `BackstopCounters.bump` + `buildMissedWakeRecord`
// calls the worker makes, driven by the real `scanJobsForTitles` return value.
// ---------------------------------------------------------------------------

test("fn-720: scanJobsForTitles returns true when it emits, false on a change-gated no-op", () => {
  // fn-769 mem variant: single in-process connection (`seedFromDb` /
  // `scanJobsForTitles` reuse the same `db`); no second opener or worker
  // touches the path.
  const { db } = freshMemDb();
  try {
    const transcriptPath = join(tmpDir, "ret-sess.jsonl");
    writeFileSync(transcriptPath, `${titleLine("ret-sess", "A Title")}\n`);
    db.query(
      "INSERT INTO jobs (job_id, created_at, updated_at, transcript_path) VALUES (?, ?, ?, ?)",
    ).run("ret-sess", 1, 1, transcriptPath);

    const stream = new TranscriptLineStream(
      () => {},
      () => {},
    );
    seedFromDb(db, stream);
    // First scan emits the never-folded title → true (a real rescue).
    expect(scanJobsForTitles(db, stream)).toBe(true);
    // A re-scan over the unchanged file is change-gate-suppressed → false (a
    // no-op fire — the denominator the git/transcript heartbeats lacked).
    expect(scanJobsForTitles(db, stream)).toBe(false);
  } finally {
    db.close();
  }
});

/** Faithful re-creation of transcript-worker's heartbeat backstop body (fn-720). */
function stepTranscriptHeartbeat(
  counters: BackstopCounters,
  rescued: boolean,
  now: number,
  lastFastPathAt: number | null,
): BackstopMessage[] {
  const out: BackstopMessage[] = [];
  counters.bump("transcript-heartbeat", "missed-wake", rescued);
  if (rescued) {
    out.push({
      kind: "backstop",
      record: buildMissedWakeRecord({
        backstop: "transcript-heartbeat",
        worker: "transcript-worker",
        fastPath: "fsevents",
        rescued: true,
        now,
        lastFastPathAt,
      }),
    });
  }
  return out;
}

test("fn-720 transcript-heartbeat: a mute-watcher rescue posts a missed-wake record with correct staleness", () => {
  const counters = new BackstopCounters();
  // The live tail's FSEvents fast path last fired at t=1000; the heartbeat at
  // t=61000 re-folded a title the live tail missed (rescued=true).
  const msgs = stepTranscriptHeartbeat(counters, true, 61000, 1000);
  expect(msgs).toHaveLength(1);
  const rec = msgs[0]?.record as BackstopRecord;
  expect(rec).toEqual({
    ts: 61000,
    kind: "backstop-rescue",
    class: "missed-wake",
    backstop: "transcript-heartbeat",
    worker: "transcript-worker",
    fast_path: "fsevents",
    rescued: true,
    staleness_ms: 60000,
    last_fast_path_at: 1000,
  });
});

test("fn-720 transcript-heartbeat: a no-op heartbeat posts NO record but bumps the denominator", () => {
  const counters = new BackstopCounters();
  const msgs = stepTranscriptHeartbeat(counters, false, 70000, 1000);
  expect(msgs).toHaveLength(0);
  const rollups = counters.snapshot(70001) as BackstopRollup[];
  expect(rollups).toHaveLength(1);
  expect(rollups[0]?.fires_total).toBe(1);
  expect(rollups[0]?.rescues_total).toBe(0);
});

test("fn-720 transcript-heartbeat: cold-boot heartbeat (no fast path yet) reports NULL staleness", () => {
  const counters = new BackstopCounters();
  const msgs = stepTranscriptHeartbeat(counters, true, 999999, null);
  const rec = msgs[0]?.record as BackstopRecord;
  expect(rec.staleness_ms).toBeNull();
  expect(rec.last_fast_path_at).toBeNull();
});

// ---------------------------------------------------------------------------
// fn-788 mute-subscription re-arm — the PURE decision helper. The transcript
// worker has ONE static subscription and NO reconcile loop, so the heartbeat
// drives the replace directly; `decideTranscriptResubscribe` is the verdict
// that gates it. These cover the decision surface only — no live-watcher tests
// (the sequential teardown / generation guard / flap window are exercised by
// the worker command seam). The parity model is plan-worker's
// `decidePlanResubscribe`.
// ---------------------------------------------------------------------------

const REARM_BASE = {
  rescued: true,
  shuttingDown: false,
  nativeWatcherDisabled: false,
  rootExists: true,
  reArmedAtMs: null as number | null,
  nowMs: 1_000_000,
  flapGuardMs: TRANSCRIPT_REARM_FLAP_GUARD_MS,
};

test("decideTranscriptResubscribe: rescue + healthy guard + present root -> replace", () => {
  expect(decideTranscriptResubscribe({ ...REARM_BASE })).toBe("replace");
});

test("decideTranscriptResubscribe: no rescue -> skip (a healthy/quiet watcher is never re-armed)", () => {
  expect(decideTranscriptResubscribe({ ...REARM_BASE, rescued: false })).toBe(
    "skip",
  );
});

test("decideTranscriptResubscribe: shutting down -> skip (never start a replace mid-teardown)", () => {
  expect(
    decideTranscriptResubscribe({ ...REARM_BASE, shuttingDown: true }),
  ).toBe("skip");
});

test("decideTranscriptResubscribe: native watcher disabled -> skip (no live subscription to replace)", () => {
  expect(
    decideTranscriptResubscribe({ ...REARM_BASE, nativeWatcherDisabled: true }),
  ).toBe("skip");
});

test("decideTranscriptResubscribe: rescue during the unexpired flap-guard window -> skip", () => {
  // Re-armed half a window ago — the replacement has not yet survived a full
  // heartbeat interval, so a fresh rescue must NOT churn the stream again.
  const armedHalfWindowAgo =
    REARM_BASE.nowMs - TRANSCRIPT_REARM_FLAP_GUARD_MS / 2;
  expect(
    decideTranscriptResubscribe({
      ...REARM_BASE,
      reArmedAtMs: armedHalfWindowAgo,
    }),
  ).toBe("skip");
});

test("decideTranscriptResubscribe: rescue after the flap-guard window lapses -> replace (genuine re-mute)", () => {
  // Re-armed a full window ago — the replacement survived an interval, so a new
  // rescue is a real re-mute and re-arms again.
  const armedAFullWindowAgo =
    REARM_BASE.nowMs - TRANSCRIPT_REARM_FLAP_GUARD_MS - 1;
  expect(
    decideTranscriptResubscribe({
      ...REARM_BASE,
      reArmedAtMs: armedAFullWindowAgo,
    }),
  ).toBe("replace");
});

test("decideTranscriptResubscribe: missing watch root -> defer (retry next heartbeat, never error)", () => {
  expect(
    decideTranscriptResubscribe({ ...REARM_BASE, rootExists: false }),
  ).toBe("defer");
});

test("decideTranscriptResubscribe: skip gates outrank defer (no rescue + missing root -> skip)", () => {
  // The skip conditions are evaluated before the root-stat — a no-rescue tick
  // over a missing root is a plain no-op, not a deferral.
  expect(
    decideTranscriptResubscribe({
      ...REARM_BASE,
      rescued: false,
      rootExists: false,
    }),
  ).toBe("skip");
  // Flap-guard skip likewise outranks defer.
  expect(
    decideTranscriptResubscribe({
      ...REARM_BASE,
      rootExists: false,
      reArmedAtMs: REARM_BASE.nowMs,
    }),
  ).toBe("skip");
});

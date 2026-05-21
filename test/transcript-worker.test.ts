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
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { TranscriptLineStream } from "../src/transcript-worker";

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

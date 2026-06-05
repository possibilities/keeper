/**
 * Tests for the zellij-events import path (fn-684 task .3). Drives
 * `scanZellijEventsDir` directly against a tmp DB + tmp events tree —
 * no Worker spawned. The worker thread itself just posts contentless
 * notifications (covered by the full daemon integration test); these
 * tests focus on the main-side import contract: idempotent re-apply,
 * partial-line tolerance, epoch reset, cross-session isolation,
 * never-throw discipline, and no-clobber on empty `tab_name`.
 *
 * Parallel-shape with `test/dead-letter-worker.test.ts`.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanZellijEventsDir } from "../src/daemon";
import { openDb } from "../src/db";
import {
  parseZellijEventLine,
  peekZellijEpoch,
  type ZellijPaneEvent,
} from "../src/zellij-events";

let tmpDir: string;
let dbPath: string;
let eventsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-zellij-events-test-"));
  dbPath = join(tmpDir, "keeper.db");
  eventsDir = join(tmpDir, "zellij-events");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePaneEvent(over: Partial<ZellijPaneEvent> = {}): ZellijPaneEvent {
  return {
    seq: 1,
    epoch: "epoch-aaa",
    session: "sess-a",
    pane_id: "1",
    tab_id: "2",
    tab_name: "primary",
    ts: 1_700_000_000,
    ...over,
  };
}

function serializeLine(ev: ZellijPaneEvent): string {
  return `${JSON.stringify(ev)}\n`;
}

/**
 * Insert a live `jobs` row carrying the given backend_exec coordinates
 * so `readLiveJobsWithCoords` returns it. Uses the absolute-minimum
 * column set the join cares about (`state` must NOT be in
 * 'ended'/'killed'). We hand-write the INSERT with the columns the
 * test needs — far simpler than driving a full SessionStart through
 * the reducer just to populate a join row.
 */
function seedJob(
  db: ReturnType<typeof openDb>["db"],
  job_id: string,
  session: string,
  pane_id: string,
): void {
  // Minimum column set the `readLiveJobsWithCoords` join cares about
  // (job_id, state NOT IN 'ended'/'killed', backend_exec_*). Other
  // NOT-NULL columns get default zeros / empty strings — we never
  // re-read them in this test.
  db.run(
    `INSERT INTO jobs (job_id, created_at, state, updated_at,
                       backend_exec_session_id, backend_exec_pane_id)
     VALUES (?, 0, 'running', 0, ?, ?)`,
    [job_id, session, pane_id],
  );
}

/**
 * Count `BackendExecSnapshot` synthetic events on the events table —
 * the proxy for "how many snapshots have we minted from the plugin
 * feed". Returns the count + the latest `data` blob (so tests can
 * assert the fold-meaningful fields without re-parsing every row).
 */
function readBackendExecEvents(db: ReturnType<typeof openDb>["db"]): {
  count: number;
  rows: { session_id: string; data: string }[];
} {
  const rows = db
    .query(
      `SELECT session_id, data
         FROM events
        WHERE hook_event = 'BackendExecSnapshot'
        ORDER BY id ASC`,
    )
    .all() as { session_id: string; data: string }[];
  return { count: rows.length, rows };
}

test("scanZellijEventsDir tolerates a missing dir (fresh machine)", () => {
  const { db, stmts } = openDb(dbPath);

  // Do NOT create eventsDir — simulating a fresh machine where the
  // plugin (and task .4's mkdir) has never landed.
  expect(() => scanZellijEventsDir(db, stmts, eventsDir)).not.toThrow();
  expect(readBackendExecEvents(db).count).toBe(0);

  db.close();
});

test("scanZellijEventsDir mints one BackendExecSnapshot per joinable pane line", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");
  seedJob(db, "job-2", "sess-a", "2");

  const lines = [
    makePaneEvent({ seq: 1, pane_id: "1", tab_id: "5", tab_name: "alpha" }),
    makePaneEvent({ seq: 2, pane_id: "2", tab_id: "5", tab_name: "alpha" }),
  ]
    .map(serializeLine)
    .join("");
  writeFileSync(join(eventsDir, "sess-a.ndjson"), lines);

  scanZellijEventsDir(db, stmts, eventsDir);

  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(2);
  expect(rows.map((r) => r.session_id).sort()).toEqual(["job-1", "job-2"]);
  for (const row of rows) {
    const data = JSON.parse(row.data) as { tab_id: string; tab_name: string };
    expect(data.tab_id).toBe("5");
    expect(data.tab_name).toBe("alpha");
  }

  db.close();
});

test("scanZellijEventsDir emits NO [trace-zellij-mints] line when KEEPER_TRACE_ZELLIJ is off (fn-704.2)", () => {
  // `TRACE_ZELLIJ` in daemon.ts is read once into a module `const` at load;
  // the test process leaves the env var unset, so the call-site gate is false
  // and the mint counter is never `tick()`ed. Drive a real mint and assert no
  // trace line reaches stderr — the zero-cost-when-off acceptance bullet.
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");
  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(makePaneEvent({ pane_id: "1", tab_name: "alpha" })),
  );

  const errSpy = spyOn(console, "error");
  try {
    scanZellijEventsDir(db, stmts, eventsDir);
  } finally {
    errSpy.mockRestore();
  }
  expect(readBackendExecEvents(db).count).toBe(1); // the mint happened
  const traced = errSpy.mock.calls.some(
    (args) =>
      typeof args[0] === "string" && args[0].includes("[trace-zellij-mints]"),
  );
  expect(traced).toBe(false);

  db.close();
});

test("scanZellijEventsDir is idempotent — a re-scan with no new lines mints nothing", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(makePaneEvent({ pane_id: "1", tab_name: "alpha" })),
  );

  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  // Second pass: no new bytes appended → no new mints.
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  db.close();
});

test("scanZellijEventsDir picks up new lines appended to an existing file", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  const file = join(eventsDir, "sess-a.ndjson");
  writeFileSync(
    file,
    serializeLine(makePaneEvent({ seq: 1, pane_id: "1", tab_name: "alpha" })),
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  // Append a second line (the plugin's append-only growth pattern).
  writeFileSync(
    file,
    serializeLine(makePaneEvent({ seq: 1, pane_id: "1", tab_name: "alpha" })) +
      serializeLine(
        makePaneEvent({ seq: 2, pane_id: "1", tab_name: "renamed" }),
      ),
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  // Two mints total now (only the new line minted on this pass).
  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(2);
  expect(JSON.parse(rows[1]?.data ?? "{}").tab_name).toBe("renamed");

  db.close();
});

test("scanZellijEventsDir skips a truncated trailing line (kept for next scan)", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // One valid complete line + a truncated trailing line (no newline). The
  // valid line should mint; the trailing partial should be deferred — a
  // later append that completes the line will mint then.
  const file = join(eventsDir, "sess-a.ndjson");
  const valid = serializeLine(
    makePaneEvent({ seq: 1, pane_id: "1", tab_name: "alpha" }),
  );
  writeFileSync(file, `${valid}{"seq":2,"epoch":"epoch-aaa","sess`);

  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  // Now complete the trailing line by writing a full second line over
  // the truncated tail (the watermark sat at the END of line 1, so the
  // newly appended bytes start fresh).
  writeFileSync(
    file,
    `${valid}${serializeLine(
      makePaneEvent({ seq: 2, pane_id: "1", tab_name: "renamed" }),
    )}`,
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(2);

  db.close();
});

test("scanZellijEventsDir resets the watermark on an epoch change (plugin reload)", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  const file = join(eventsDir, "sess-a.ndjson");
  writeFileSync(
    file,
    serializeLine(
      makePaneEvent({
        seq: 1,
        pane_id: "1",
        tab_name: "alpha",
        epoch: "epoch-old",
      }),
    ),
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  // Append a line with a NEW epoch (plugin reload). The scanner must
  // detect the epoch change and still consume the new line (NOT skip
  // it as "seq <= last seen"). The watermark also rotates to the new
  // epoch so subsequent scans tail forward from the new tail.
  writeFileSync(
    file,
    serializeLine(
      makePaneEvent({
        seq: 1,
        pane_id: "1",
        tab_name: "alpha",
        epoch: "epoch-old",
      }),
    ) +
      serializeLine(
        makePaneEvent({
          seq: 1,
          pane_id: "1",
          tab_name: "post-reload",
          epoch: "epoch-new",
        }),
      ),
  );
  scanZellijEventsDir(db, stmts, eventsDir);

  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(2);
  expect(JSON.parse(rows[1]?.data ?? "{}").tab_name).toBe("post-reload");

  // Watermark sidecar now carries the NEW epoch.
  const watermarkPath = join(eventsDir, ".keeperd-watermarks.json");
  const sidecar = JSON.parse(readFileSync(watermarkPath, "utf8")) as Record<
    string,
    { epoch: string; offset: number }
  >;
  expect(sidecar["sess-a"]?.epoch).toBe("epoch-new");

  db.close();
});

test("peekZellijEpoch lifts the epoch from a pane line AND the plugin_start sentinel (fn-706.2)", () => {
  // A normal pane line — numeric epoch normalized to decimal string.
  expect(
    peekZellijEpoch(
      JSON.stringify(makePaneEvent({ epoch: "epoch-A", pane_id: "1" })),
    ),
  ).toBe("epoch-A");
  expect(
    peekZellijEpoch('{"seq":1,"epoch":42,"session":"s","pane_id":1}'),
  ).toBe("42");

  // The rotation header IS a `plugin_start` sentinel — `parseZellijEventLine`
  // nulls it, but the peek MUST still read its epoch (it's the rotation
  // signal). This is the load-bearing difference between the two helpers.
  const header = JSON.stringify({
    seq: 0,
    event: "plugin_start",
    epoch: "epoch-B",
    session: "s",
  });
  expect(parseZellijEventLine(header)).toBeNull();
  expect(peekZellijEpoch(header)).toBe("epoch-B");

  // Garbage / blank / missing-epoch → null (caller falls back to the shrink
  // guard + in-window detection).
  expect(peekZellijEpoch("")).toBeNull();
  expect(peekZellijEpoch("   ")).toBeNull();
  expect(peekZellijEpoch("not json")).toBeNull();
  expect(peekZellijEpoch("[1,2,3]")).toBeNull();
  expect(peekZellijEpoch('{"session":"s"}')).toBeNull();
  expect(peekZellijEpoch('{"epoch":""}')).toBeNull();
});

test("scanZellijEventsDir detects a plugin-side rotation via the first-line epoch peek (fn-706.2)", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // Epoch-A run: a header sentinel + a pane line. Note the consumer skips
  // the sentinel (no pane fields) and mints from the pane line.
  const file = join(eventsDir, "sess-a.ndjson");
  const headerA = `${JSON.stringify({
    seq: 0,
    event: "plugin_start",
    epoch: "epoch-A",
    session: "sess-a",
  })}\n`;
  const paneA = serializeLine(
    makePaneEvent({
      seq: 1,
      pane_id: "1",
      tab_id: "5",
      tab_name: "tab-before-aaa",
      epoch: "epoch-A",
    }),
  );
  writeFileSync(file, headerA + paneA);
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  const watermarkPath = join(eventsDir, ".keeperd-watermarks.json");
  const afterA = JSON.parse(readFileSync(watermarkPath, "utf8")) as Record<
    string,
    { epoch: string; offset: number }
  >;
  expect(afterA["sess-a"]?.epoch).toBe("epoch-A");
  const priorOffset = afterA["sess-a"]?.offset ?? 0;

  // Plugin rotates: truncate to byte 0, write a FRESH-epoch header + full
  // re-snapshot. The re-snapshot grows the file PAST the prior offset, so the
  // `size < priorOffset` shrink guard would MISS this — only the first-line
  // epoch peek catches it. We pad the re-snapshot so its total size exceeds
  // the prior offset, defeating the shrink guard deliberately.
  const headerB = `${JSON.stringify({
    seq: 0,
    event: "plugin_start",
    epoch: "epoch-B",
    session: "sess-a",
  })}\n`;
  const paneB = serializeLine(
    makePaneEvent({
      seq: 1,
      pane_id: "1",
      tab_id: "9",
      tab_name: "tab-after-bbbb",
      epoch: "epoch-B",
    }),
  );
  writeFileSync(file, headerB + paneB);
  // Sanity: the rotated file is at least as large as the prior offset, so the
  // shrink guard alone cannot detect the rotation — the epoch peek is
  // load-bearing.
  const rotatedSize = headerB.length + paneB.length;
  expect(rotatedSize).toBeGreaterThanOrEqual(priorOffset);

  scanZellijEventsDir(db, stmts, eventsDir);

  // The consumer reset to byte 0, consumed the new header + snapshot, and
  // re-minted the pane against the NEW epoch.
  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(2);
  expect(JSON.parse(rows[rows.length - 1]?.data ?? "{}").tab_name).toBe(
    "tab-after-bbbb",
  );

  // Watermark now carries the NEW epoch + the post-rotation offset.
  const afterB = JSON.parse(readFileSync(watermarkPath, "utf8")) as Record<
    string,
    { epoch: string; offset: number }
  >;
  expect(afterB["sess-a"]?.epoch).toBe("epoch-B");
  expect(afterB["sess-a"]?.offset).toBe(rotatedSize);

  // Re-scan is idempotent — no new bytes, no new mints, no spurious reset.
  const before = readBackendExecEvents(db).count;
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(before);

  db.close();
});

test("scanZellijEventsDir tail-reads an oversize feed instead of skipping it (fn-706.1)", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // The real cap is 16 MiB — too large to materialize per-test — so we
  // inject a TINY `maxBytes` cap (a pure function arg, not an env read)
  // to exercise the same tail-read path. Each line is a complete pane
  // delta for the same (session, pane_id); the LAST line carries the
  // current tab name we expect to resolve. Pre-fn-706 the whole file
  // was `continue`-skipped forever (no mint, frozen watermark).
  const file = join(eventsDir, "sess-a.ndjson");
  const padLine = serializeLine(
    makePaneEvent({
      seq: 1,
      pane_id: "1",
      tab_id: "5",
      tab_name: "pad",
      epoch: "epoch-big",
    }),
  );
  const tailLine = serializeLine(
    makePaneEvent({
      seq: 2,
      pane_id: "1",
      tab_id: "9",
      tab_name: "current-title",
      epoch: "epoch-big",
    }),
  );
  // ~10 pad lines + the tail line. The injected cap is set BELOW this
  // total so the window base lands mid-pad-line (forcing the leading
  // partial discard) yet still contains the tail line.
  const padBlock = padLine.repeat(10);
  writeFileSync(file, padBlock + tailLine);
  const totalSize = padBlock.length + tailLine.length;

  // Cap = just enough to hold the tail line plus a fractional pad line,
  // so `tailBase = size - cap` slices INTO a pad line (mid-record).
  const injectedCap = tailLine.length + Math.floor(padLine.length / 2);
  expect(injectedCap).toBeLessThan(totalSize);

  const errSpy = spyOn(console, "error");
  try {
    scanZellijEventsDir(db, stmts, eventsDir, injectedCap);
  } finally {
    errSpy.mockRestore();
  }

  // The oversize path no longer emits the skip warning.
  const skipped = errSpy.mock.calls.some(
    (args) =>
      typeof args[0] === "string" &&
      args[0].includes("exceeds") &&
      args[0].includes("skipping"),
  );
  expect(skipped).toBe(false);

  // The latest pane snapshot minted from the tail window.
  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBeGreaterThanOrEqual(1);
  const latest = JSON.parse(rows[rows.length - 1]?.data ?? "{}") as {
    tab_id: string;
    tab_name: string;
  };
  expect(latest.tab_id).toBe("9");
  expect(latest.tab_name).toBe("current-title");

  // The watermark advanced to the tail-base-relative offset. The feed
  // ends in a clean `\n` and every complete line in the window was
  // consumed, so the offset lands at exactly the file size — proving
  // the `tailBase + discardedPartialBytes + consumedBytesInTail`
  // arithmetic accounts for the mid-line resync, not `priorOffset + …`.
  const watermarkPath = join(eventsDir, ".keeperd-watermarks.json");
  const sidecar = JSON.parse(readFileSync(watermarkPath, "utf8")) as Record<
    string,
    { epoch: string; offset: number }
  >;
  expect(sidecar["sess-a"]?.epoch).toBe("epoch-big");
  expect(sidecar["sess-a"]?.offset).toBe(totalSize);

  // Re-scan is idempotent — no new bytes, no new mints.
  const before = readBackendExecEvents(db).count;
  scanZellijEventsDir(db, stmts, eventsDir, injectedCap);
  expect(readBackendExecEvents(db).count).toBe(before);

  db.close();
});

test("scanZellijEventsDir isolates per-session pane-id collision (same pane_id, different sessions)", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });

  // Two different sessions, each with a pane_id="1" bound to a
  // DIFFERENT job. A pane line from session A must not mint against
  // the job that lives in session B.
  seedJob(db, "job-a", "sess-a", "1");
  seedJob(db, "job-b", "sess-b", "1");

  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(
      makePaneEvent({
        session: "sess-a",
        pane_id: "1",
        tab_name: "from-a",
        epoch: "epoch-a",
      }),
    ),
  );
  writeFileSync(
    join(eventsDir, "sess-b.ndjson"),
    serializeLine(
      makePaneEvent({
        session: "sess-b",
        pane_id: "1",
        tab_name: "from-b",
        epoch: "epoch-b",
      }),
    ),
  );

  scanZellijEventsDir(db, stmts, eventsDir);

  const { rows } = readBackendExecEvents(db);
  const byJob = new Map(rows.map((r) => [r.session_id, JSON.parse(r.data)]));
  expect(byJob.get("job-a")?.tab_name).toBe("from-a");
  expect(byJob.get("job-b")?.tab_name).toBe("from-b");
  expect(rows.length).toBe(2);

  db.close();
});

test("scanZellijEventsDir does NOT mint a clobbering snapshot for an empty tab_name", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // The plugin emits empty tab_name for unrenamed tabs. The reducer's
  // fold writes `tab_name = ?` (non-COALESCE), so minting with empty
  // would clobber a previously-resolved name. The scan must skip
  // empty-name lines entirely.
  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(makePaneEvent({ pane_id: "1", tab_name: "", tab_id: "5" })),
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(0);

  // But a non-empty name on the same pane DOES mint.
  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(makePaneEvent({ pane_id: "1", tab_name: "", tab_id: "5" })) +
      serializeLine(
        makePaneEvent({
          seq: 2,
          pane_id: "1",
          tab_name: "renamed",
          tab_id: "5",
        }),
      ),
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(1);
  expect(JSON.parse(rows[0]?.data ?? "{}").tab_name).toBe("renamed");

  db.close();
});

test("scanZellijEventsDir skips lines whose (session, pane_id) joins to no live job", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });

  // No seedJob — no live row carries this (session, pane_id).
  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(makePaneEvent({ pane_id: "1", tab_name: "alpha" })),
  );

  scanZellijEventsDir(db, stmts, eventsDir);
  // Acceptable — the pane belongs to an unrelated session or the
  // SessionStart hasn't landed yet. NO mint, NO throw.
  expect(readBackendExecEvents(db).count).toBe(0);

  db.close();
});

test("scanZellijEventsDir tolerates a malformed JSON line and imports the rest", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // Mix valid records around a malformed line. The scan should mint
  // the valid records on either side and skip the bad line silently.
  const content =
    serializeLine(makePaneEvent({ seq: 1, pane_id: "1", tab_name: "alpha" })) +
    "this is not json\n" +
    serializeLine(makePaneEvent({ seq: 3, pane_id: "1", tab_name: "gamma" }));
  writeFileSync(join(eventsDir, "sess-a.ndjson"), content);

  scanZellijEventsDir(db, stmts, eventsDir);

  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(2);
  expect(JSON.parse(rows[0]?.data ?? "{}").tab_name).toBe("alpha");
  expect(JSON.parse(rows[1]?.data ?? "{}").tab_name).toBe("gamma");

  db.close();
});

test("scanZellijEventsDir skips the plugin_start sentinel without throwing", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // Plugin's `load()` sentinel — no pane fields. Followed by a real
  // pane line.
  const content =
    `${JSON.stringify({ seq: 0, event: "plugin_start", epoch: "epoch-aaa" })}\n` +
    serializeLine(makePaneEvent({ seq: 1, pane_id: "1", tab_name: "alpha" }));
  writeFileSync(join(eventsDir, "sess-a.ndjson"), content);

  scanZellijEventsDir(db, stmts, eventsDir);

  // Sentinel skipped; pane line minted.
  expect(readBackendExecEvents(db).count).toBe(1);

  db.close();
});

test("scanZellijEventsDir ignores non-ndjson files in the dir", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  // A stray non-ndjson file (e.g. an editor backup) must be ignored,
  // and the watermark sidecar (`.keeperd-watermarks.json`) doesn't
  // end in `.ndjson` either so it must not be misread as a data file.
  writeFileSync(join(eventsDir, "notes.txt"), "this is not ndjson");
  writeFileSync(
    join(eventsDir, "sess-a.ndjson"),
    serializeLine(makePaneEvent({ pane_id: "1", tab_name: "alpha" })),
  );

  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  // Re-scan should not re-mint anything — confirms the sidecar that
  // got written on pass 1 is itself ignored by the dir walk.
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);

  db.close();
});

test("scanZellijEventsDir watermark survives daemon restart (re-tail from offset, not byte 0)", () => {
  // First "run" — open, scan, close. The watermark sidecar persists
  // across the close.
  {
    const { db, stmts } = openDb(dbPath);
    mkdirSync(eventsDir, { recursive: true });
    seedJob(db, "job-1", "sess-a", "1");
    writeFileSync(
      join(eventsDir, "sess-a.ndjson"),
      serializeLine(makePaneEvent({ pane_id: "1", tab_name: "alpha" })),
    );
    scanZellijEventsDir(db, stmts, eventsDir);
    expect(readBackendExecEvents(db).count).toBe(1);
    db.close();
  }

  // Second "run" — fresh DB connection (simulates a daemon restart).
  // The pre-existing pane line in `<session>.ndjson` MUST NOT re-mint
  // because the watermark sidecar on disk still records the byte
  // offset past it.
  {
    const { db, stmts } = openDb(dbPath);
    // The first-run mint left one event on disk; confirm.
    expect(readBackendExecEvents(db).count).toBe(1);
    scanZellijEventsDir(db, stmts, eventsDir);
    // No new mint — the boot scan tailed from the persisted offset.
    expect(readBackendExecEvents(db).count).toBe(1);
    db.close();
  }
});

test("scanZellijEventsDir handles multi-byte UTF-8 in a pre-watermark line without truncating the next (fn-687)", () => {
  // Regression for fn-687. Previously the scan computed
  // `text.slice(priorOffset)` where `text` is a JS string (UTF-16
  // code-unit indexed) but `priorOffset` is advanced by
  // `Buffer.byteLength(line, "utf8") + 1` (byte-indexed) and compared
  // against `st.size` (also bytes). The moment a consumed line carried
  // any multi-byte character (emoji in a tab name is the common case),
  // the slice over-shot, truncated the START of the next line, and
  // `JSON.parse` silently dropped it — persisting the bad offset so the
  // corruption compounded on every subsequent scan.
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  seedJob(db, "job-1", "sess-a", "1");

  const file = join(eventsDir, "sess-a.ndjson");

  // Pass 1: write a single line with an emoji in `tab_name`. "😀" is a
  // 4-byte UTF-8 sequence but a 2-code-unit (surrogate pair) JS string,
  // so the byte/code-unit divergence is 2 per emoji — enough to chop a
  // few characters off the start of the next line.
  writeFileSync(
    file,
    serializeLine(makePaneEvent({ seq: 1, pane_id: "1", tab_name: "😀main" })),
  );
  scanZellijEventsDir(db, stmts, eventsDir);
  expect(readBackendExecEvents(db).count).toBe(1);
  expect(
    JSON.parse(readBackendExecEvents(db).rows[0]?.data ?? "{}").tab_name,
  ).toBe("😀main");

  // Pass 2: append a second normal ASCII line. The watermark advanced
  // by the byte length of the emoji line on pass 1; pass 2 must slice
  // the buffer by that byte offset and recover the second line in full.
  // With the bug, the slice over-shoots by (emoji_count * 2) bytes and
  // the second line's leading bytes are eaten — `JSON.parse` fails and
  // the line is silently dropped.
  writeFileSync(
    file,
    serializeLine(makePaneEvent({ seq: 1, pane_id: "1", tab_name: "😀main" })) +
      serializeLine(
        makePaneEvent({ seq: 2, pane_id: "1", tab_name: "second" }),
      ),
  );
  scanZellijEventsDir(db, stmts, eventsDir);

  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(2);
  expect(JSON.parse(rows[0]?.data ?? "{}").tab_name).toBe("😀main");
  expect(JSON.parse(rows[1]?.data ?? "{}").tab_name).toBe("second");

  db.close();
});

/**
 * Golden wire bytes — the EXACT line `PaneLine::to_json`
 * (plugin/zellij-bridge/src/lib.rs) emits. `epoch`, `pane_id`, and
 * `tab_id` are bare JSON NUMBERS, not strings. The other tests build
 * fixtures through `makePaneEvent` (string-typed) + `JSON.stringify`,
 * which never reproduces this shape — so this is the one test that pins
 * the producer↔consumer wire contract. Regenerate by copying a real
 * `to_json` output if the producer's format string ever changes.
 */
const GOLDEN_PLUGIN_LINE =
  '{"seq":7,"epoch":1717430400,"session":"sess-a","pane_id":1,"tab_id":5,"tab_name":"primary","ts":1717430400123}';

test("parseZellijEventLine accepts the numeric epoch/pane_id the plugin actually emits", () => {
  const ev = parseZellijEventLine(GOLDEN_PLUGIN_LINE);
  expect(ev).not.toBeNull();
  // Numeric wire values are coerced to the decimal-string form the
  // reducer reads as TEXT — same normalization tab_id already gets.
  expect(ev?.epoch).toBe("1717430400");
  expect(ev?.pane_id).toBe("1");
  expect(ev?.tab_id).toBe("5");
  expect(ev?.session).toBe("sess-a");
  expect(ev?.tab_name).toBe("primary");
  expect(ev?.seq).toBe(7);
  expect(ev?.ts).toBe(1_717_430_400_123);
});

test("scanZellijEventsDir mints a backend_exec event from the plugin's numeric wire line", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsDir, { recursive: true });
  // Live job carries pane_id "1" (TEXT); the wire's numeric pane_id 1
  // coerces to "1" and joins. Before the coercion fix this line was
  // dropped and nothing minted — starving tab-namer / reap-by-tab-id.
  seedJob(db, "job-1", "sess-a", "1");
  writeFileSync(join(eventsDir, "sess-a.ndjson"), `${GOLDEN_PLUGIN_LINE}\n`);

  scanZellijEventsDir(db, stmts, eventsDir);

  const { count, rows } = readBackendExecEvents(db);
  expect(count).toBe(1);
  expect(JSON.parse(rows[0]?.data ?? "{}").tab_name).toBe("primary");

  db.close();
});

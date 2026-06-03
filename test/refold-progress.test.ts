/**
 * `createRefoldProgressPoller` unit coverage. Boots a tmp keeper DB via
 * the writer `openDb` (which runs `migrate()` and seeds `reducer_state`),
 * inserts a handful of events, and asserts the read-only poller surfaces
 * the cursor + MAX(id) honestly. Also exercises the error-handling
 * surface: a missing DB file collapses to null without throwing, and
 * `close()` is idempotent so the view-shell's first-frame self-stop and
 * SIGINT teardown can both fire.
 *
 * `KEEPER_DB` test isolation — every poller is constructed with an
 * explicit dbPath (the `dbPath` param wins over the env override), so
 * the user's real `~/.local/state/keeper/keeper.db` is never touched.
 * The forced-throw case additionally points at a tmp DB that we close
 * and remove out from under the poller's connection to provoke a
 * SELECT-time error path.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { createRefoldProgressPoller } from "../src/refold-progress";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-refold-progress-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert `n` rows into `events` and return the rowid of the last one. */
function seedEvents(path: string, n: number): number {
  const { db } = openDb(path);
  try {
    const insert = db.prepare(
      "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (?, 's', 'Stop', 'lifecycle', '{}')",
    );
    let lastId = 0;
    for (let i = 1; i <= n; i++) {
      const info = insert.run(i);
      lastId = Number(info.lastInsertRowid);
    }
    return lastId;
  } finally {
    db.close();
  }
}

/** Advance `reducer_state.last_event_id` to a known value. */
function setCursor(path: string, cursor: number): void {
  const { db } = openDb(path);
  try {
    db.query("UPDATE reducer_state SET last_event_id = ?").run(cursor);
  } finally {
    db.close();
  }
}

test("poll returns null when the DB file is missing", () => {
  // No bootstrap — the path doesn't exist. The readonly `openDb` call
  // throws inside `ensureOpen`; the wrapper swallows it and `poll()`
  // returns null. A missing DB is the cold-start case (TUI launched
  // before keeperd has ever booted) — the spinner falls back cleanly.
  const poller = createRefoldProgressPoller(dbPath);
  expect(poller.poll()).toBeNull();
  // Idempotent close — calling it twice on a never-opened poller is
  // safe (the second call is a no-op).
  poller.close();
  poller.close();
});

test("poll surfaces cursor + MAX(id) after writes", () => {
  // Bootstrap with 5 events, advance the reducer cursor to 3.
  const maxId = seedEvents(dbPath, 5);
  setCursor(dbPath, 3);

  const poller = createRefoldProgressPoller(dbPath);
  try {
    const sample = poller.poll();
    expect(sample).not.toBeNull();
    expect(sample?.cursor).toBe(3);
    expect(sample?.max).toBe(maxId);
  } finally {
    poller.close();
  }
});

test("poll returns null on a freshly-migrated DB with zero events", () => {
  // `migrate()` runs on openDb; `reducer_state` is seeded with
  // `last_event_id = 0`, and `events` is empty so `MAX(id)` is SQL
  // NULL. The poller surfaces null so the consumer falls back to the
  // plain "connecting" line instead of dividing by zero.
  openDb(dbPath).db.close();
  const poller = createRefoldProgressPoller(dbPath);
  try {
    expect(poller.poll()).toBeNull();
  } finally {
    poller.close();
  }
});

test("poll returns null on a SELECT-time throw and remains usable", () => {
  // Seed the DB so the lazy `ensureOpen` succeeds — then close the
  // file under the poller by overwriting it with a zero-byte file
  // before the FIRST `poll()`. Bun's sqlite holds the file descriptor
  // open; the SELECT can fail in various ways but the wrapper
  // collapses any throw to null. We don't assert WHICH error path
  // fires — just that `poll()` never throws.
  seedEvents(dbPath, 2);
  setCursor(dbPath, 1);

  const poller = createRefoldProgressPoller(dbPath);
  // Force the first poll to open + succeed so the connection is live.
  expect(poller.poll()).not.toBeNull();

  // Now corrupt the events table by dropping it through a separate
  // writer connection. The poller's prepared SELECT against
  // `events.id` will throw "no such table" on the next poll; the
  // wrapper swallows it.
  const writer = openDb(dbPath).db;
  try {
    writer.run("DROP TABLE events");
  } finally {
    writer.close();
  }

  expect(poller.poll()).toBeNull();
  // The poller is still usable after a throw — subsequent polls keep
  // returning null without crashing.
  expect(poller.poll()).toBeNull();
  poller.close();
});

test("close is idempotent", () => {
  seedEvents(dbPath, 1);
  const poller = createRefoldProgressPoller(dbPath);
  // Open the connection.
  poller.poll();
  poller.close();
  // Second close is a no-op — neither throws nor re-touches the closed handle.
  poller.close();
  // Polling after close re-runs `ensureOpen`, which short-circuits
  // because `closed === true`; surfaces as null. The contract is
  // "close means stop using me"; tests assert non-throwing behavior.
  expect(poller.poll()).toBeNull();
});

test("KEEPER_DB env override routes the default poller to a tmp DB", () => {
  // Production callers omit `dbPath` and pick up `resolveDbPath()` — which
  // honors `KEEPER_DB`. Verify the env path is correctly threaded so a
  // CI/dev run that scopes KEEPER_DB to a sandbox never touches the
  // user's real `~/.local/state/keeper/keeper.db`.
  seedEvents(dbPath, 3);
  setCursor(dbPath, 2);
  const prev = process.env.KEEPER_DB;
  process.env.KEEPER_DB = dbPath;
  try {
    const poller = createRefoldProgressPoller();
    try {
      const sample = poller.poll();
      expect(sample?.cursor).toBe(2);
      expect(sample?.max).toBe(3);
    } finally {
      poller.close();
    }
  } finally {
    if (prev === undefined) {
      delete process.env.KEEPER_DB;
    } else {
      process.env.KEEPER_DB = prev;
    }
  }
});

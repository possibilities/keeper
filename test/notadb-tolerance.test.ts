/**
 * Unit tests for `src/notadb-tolerance.ts` (fn-1096.3 — the filed NOTADB
 * reader-tolerance rider from the fn-1082.2 serve-wedge finding doc).
 *
 * Exercises `NotadbTolerance.poll` against an injected reader with scripted
 * throw patterns (single transient, alternating, N-consecutive rethrow,
 * unrelated-error passthrough), plus a `freshMemDb()` real-connection smoke
 * confirming a genuinely healthy `PRAGMA data_version` read round-trips
 * through the helper untouched.
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTolerableNotadbError,
  NOTADB_TOLERANCE_LIMIT,
  NotadbTolerance,
} from "../src/notadb-tolerance";

/** A `bun:sqlite`-shaped error: `.code` is what the helper classifies on. */
class FakeSqliteError extends Error {
  constructor(
    public readonly code: string,
    message = "file is not a database",
  ) {
    super(message);
    this.name = "SQLiteError";
  }
}

test("isTolerableNotadbError: true only for SQLITE_NOTADB", () => {
  expect(isTolerableNotadbError(new FakeSqliteError("SQLITE_NOTADB"))).toBe(
    true,
  );
  expect(isTolerableNotadbError(new FakeSqliteError("SQLITE_BUSY"))).toBe(
    false,
  );
  expect(isTolerableNotadbError(new FakeSqliteError("SQLITE_CORRUPT"))).toBe(
    false,
  );
  expect(isTolerableNotadbError(new Error("plain error, no code"))).toBe(false);
  expect(isTolerableNotadbError(null)).toBe(false);
  expect(isTolerableNotadbError("a string")).toBe(false);
});

test("poll: a successful read returns the value and never skips", () => {
  const tolerance = new NotadbTolerance();
  const outcome = tolerance.poll(() => 42);
  expect(outcome).toEqual({ skipped: false, value: 42 });
});

test("poll: a single transient NOTADB skips that tick", () => {
  const tolerance = new NotadbTolerance();
  let calls = 0;
  const read = () => {
    calls += 1;
    if (calls === 1) throw new FakeSqliteError("SQLITE_NOTADB");
    return 7;
  };
  const first = tolerance.poll(read);
  expect(first).toEqual({
    skipped: true,
    code: "SQLITE_NOTADB",
    consecutiveMisses: 1,
  });
  const second = tolerance.poll(read);
  expect(second).toEqual({ skipped: false, value: 7 });
});

test("poll: a success resets the consecutive-miss count to 0", () => {
  const tolerance = new NotadbTolerance();
  // Two misses, then a success, then a fresh single miss — the fresh miss
  // must read as consecutiveMisses:1, not 3 (proving the reset).
  tolerance.poll(() => {
    throw new FakeSqliteError("SQLITE_NOTADB");
  });
  tolerance.poll(() => {
    throw new FakeSqliteError("SQLITE_NOTADB");
  });
  const success = tolerance.poll(() => 1);
  expect(success).toEqual({ skipped: false, value: 1 });
  const freshMiss = tolerance.poll(() => {
    throw new FakeSqliteError("SQLITE_NOTADB");
  });
  expect(freshMiss).toEqual({
    skipped: true,
    code: "SQLITE_NOTADB",
    consecutiveMisses: 1,
  });
});

test("poll: alternating transient/success never accumulates past 1", () => {
  const tolerance = new NotadbTolerance();
  for (let i = 0; i < 10; i++) {
    const missOutcome = tolerance.poll(() => {
      throw new FakeSqliteError("SQLITE_NOTADB");
    });
    expect(missOutcome).toEqual({
      skipped: true,
      code: "SQLITE_NOTADB",
      consecutiveMisses: 1,
    });
    const hitOutcome = tolerance.poll(() => i);
    expect(hitOutcome).toEqual({ skipped: false, value: i });
  }
});

test("poll: a bounded run of consecutive misses (default limit) rethrows — no infinite silent skip", () => {
  const tolerance = new NotadbTolerance();
  const err = new FakeSqliteError("SQLITE_NOTADB");
  const read = () => {
    throw err;
  };
  // Exactly NOTADB_TOLERANCE_LIMIT tolerated skips.
  for (let i = 1; i <= NOTADB_TOLERANCE_LIMIT; i++) {
    const outcome = tolerance.poll(read);
    expect(outcome).toEqual({
      skipped: true,
      code: "SQLITE_NOTADB",
      consecutiveMisses: i,
    });
  }
  // The NEXT one (limit + 1) rethrows.
  expect(() => tolerance.poll(read)).toThrow(err);
});

test("poll: a custom (smaller) limit rethrows at its own bound", () => {
  const tolerance = new NotadbTolerance(2);
  const read = () => {
    throw new FakeSqliteError("SQLITE_NOTADB");
  };
  expect(tolerance.poll(read)).toEqual({
    skipped: true,
    code: "SQLITE_NOTADB",
    consecutiveMisses: 1,
  });
  expect(tolerance.poll(read)).toEqual({
    skipped: true,
    code: "SQLITE_NOTADB",
    consecutiveMisses: 2,
  });
  expect(() => tolerance.poll(read)).toThrow();
});

test("poll: an unrelated SqliteError code passes through immediately, untouched", () => {
  const tolerance = new NotadbTolerance();
  const corrupt = new FakeSqliteError(
    "SQLITE_CORRUPT",
    "database disk image is malformed",
  );
  expect(() =>
    tolerance.poll(() => {
      throw corrupt;
    }),
  ).toThrow(corrupt);
  // The miss count must NOT have been bumped by the unrelated error — the
  // very next NOTADB gets the fresh consecutiveMisses:1, not 2.
  const outcome = tolerance.poll(() => {
    throw new FakeSqliteError("SQLITE_NOTADB");
  });
  expect(outcome).toEqual({
    skipped: true,
    code: "SQLITE_NOTADB",
    consecutiveMisses: 1,
  });
});

test("poll: a non-Error / codeless throw passes through immediately", () => {
  const tolerance = new NotadbTolerance();
  expect(() =>
    tolerance.poll(() => {
      throw new Error("boom, no .code");
    }),
  ).toThrow("boom, no .code");
  expect(() =>
    tolerance.poll(() => {
      // eslint-disable-next-line no-throw-literal
      throw "a bare string throw";
    }),
  ).toThrow();
});

test("poll: real bun:sqlite smoke — a healthy PRAGMA data_version read round-trips untouched", () => {
  const db = new Database(":memory:");
  try {
    const tolerance = new NotadbTolerance();
    const query = db.query("PRAGMA data_version");
    const outcome = tolerance.poll(
      () => (query.get() as { data_version: number }).data_version,
    );
    expect(outcome.skipped).toBe(false);
    if (!outcome.skipped) {
      expect(typeof outcome.value).toBe("number");
    }
  } finally {
    db.close();
  }
});

test("poll: real bun:sqlite smoke — a genuine SQLITE_NOTADB (bogus file) is tolerated and skips", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-notadb-"));
  const path = join(dir, "bogus.db");
  writeFileSync(path, "not a sqlite database — garbage bytes\n");
  try {
    const db = new Database(path, { readonly: true });
    try {
      const tolerance = new NotadbTolerance();
      const query = db.query("PRAGMA data_version");
      const outcome = tolerance.poll(
        () => (query.get() as { data_version: number }).data_version,
      );
      expect(outcome).toEqual({
        skipped: true,
        code: "SQLITE_NOTADB",
        consecutiveMisses: 1,
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

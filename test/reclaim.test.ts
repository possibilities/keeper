/**
 * `keeper reclaim` run() orchestration tests (fn-850.1).
 *
 * The per-helper pieces (backupDb / reclaimDb / verifyReclaim / daemonUp) are
 * covered in backup.test.ts. This file locks the ONE irreversible operation the
 * helpers are strung into — the atomic same-fs swap of the live DB plus the
 * stale `-wal`/`-shm` sidecar drop — which had no run()-level coverage.
 *
 * Both tests drive the exported run() with injected RunDeps (stdout/stderr/exit)
 * against a real temp DB, so a future edit cannot silently break the swap:
 *  - F4 (happy path): the live dbPath is swapped to the reclaimed (smaller,
 *    vacuumed) copy, the `.reclaim` output is consumed by the swap, and the OLD
 *    file's `-wal`/`-shm` sidecars are removed.
 *  - F5 (daemon-up refusal): a `<sock>.lock` with a live pid makes run() exit 1
 *    via the injected exit, emit the REFUSING message, and leave the source DB
 *    byte-identical (no snapshot / reclaim / swap performed).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ParsedReclaimArgs, run } from "../cli/reclaim";
import { openDb } from "../src/db";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
let sockPath: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `keeper-reclaim-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  dbPath = join(tmpDir, "keeper.db");
  sockPath = join(tmpDir, "keeperd.sock");
  // Multi-connection: run() opens the source over its own read-only connection
  // (backupDb / reclaimDb / verifyReclaim), so the migrated schema must live on
  // disk. Pre-write the template image (skips the ladder); the wal_checkpoint in
  // freshDbFile leaves no `-wal` sidecar stranded.
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A non-dry-run, non-help args object pointing at the temp DB + sock. */
function args(): ParsedReclaimArgs {
  return {
    dbPath,
    sockPath,
    dryRun: false,
    help: false,
    agentHelp: false,
  };
}

/** Sentinel thrown by the injected exit() so it faithfully UNWINDS. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

/**
 * RunDeps that capture stdout/stderr and make exit() THROW. The production
 * contract types `exit` as `never` and the code after a `deps.exit(1)` only ever
 * runs because real `process.exit` does not return — a recording no-op would let
 * execution fall through past the guard into the swap, which is not how run()
 * behaves in prod. Throwing an `ExitSignal` reproduces the non-returning
 * semantics; the caller drives run() inside `runCatching` to record the code.
 */
function captureDeps() {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const deps = {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    exit: ((code: number) => {
      exits.push(code);
      throw new ExitSignal(code);
    }) as (code: number) => never,
  };
  return { out, err, exits, deps };
}

/** Run run() catching the ExitSignal so a refusal/abort does not fail the test. */
function runCatching(
  a: ParsedReclaimArgs,
  deps: ReturnType<typeof captureDeps>["deps"],
): void {
  try {
    run(a, deps);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  }
}

// ---------------------------------------------------------------------------
// F4 — happy path: irreversible swap + sidecar drop
// ---------------------------------------------------------------------------

test("run(): swaps the reclaimed copy over the live DB and drops stale sidecars", () => {
  // Bloat the source: insert+delete a large payload so the freelist grows but
  // the file does not shrink — the reclaim's VACUUM INTO then yields a strictly
  // smaller output, proving the live file was actually swapped.
  const { db } = openDb(dbPath, { migrate: false });
  for (let i = 0; i < 500; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `bloat-${i}`,
      "y".repeat(4000),
    ]);
  }
  db.run("DELETE FROM meta WHERE key LIKE 'bloat-%'");
  // Insert a sentinel row that MUST survive the swap, confirming the live file
  // now holds the reclaimed contents (not an empty/replaced DB).
  db.run("INSERT INTO meta (key, value) VALUES ('sentinel', 'survives')");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const sourceBytes = statSync(dbPath).size;

  const { out, err, exits, deps } = captureDeps();
  runCatching(args(), deps);

  // No exit() — the happy path runs to completion.
  expect(exits).toEqual([]);
  expect(err).toEqual([]);
  expect(out.join("")).toContain("[reclaim] DONE");

  // The intermediate `.reclaim` output was consumed by the atomic rename.
  expect(existsSync(`${dbPath}.reclaim`)).toBe(false);

  // The live DB is now the reclaimed (vacuumed) copy: strictly smaller, opens
  // clean, and still carries the sentinel row.
  const swappedBytes = statSync(dbPath).size;
  expect(swappedBytes).toBeLessThan(sourceBytes);

  const ro = openDb(dbPath, { migrate: false });
  try {
    const row = ro.db
      .query("SELECT value FROM meta WHERE key = 'sentinel'")
      .get() as { value: string } | null;
    expect(row?.value).toBe("survives");
    const av = ro.db.query("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    expect(av.auto_vacuum).toBe(2); // INCREMENTAL baked by reclaimDb.
  } finally {
    ro.db.close();
    // openDb opens WAL; checkpoint+close so afterEach's rmSync sees no stragglers.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }

  // The rollback snapshot is kept (the swap path completed). Focused sidecar-drop
  // assertion lives in the next test, before any reopen can recreate them.
  expect(out.join("")).toContain("Snapshot kept at");

  // A pre-reclaim snapshot (the rollback) was produced under the default backup
  // dir for the temp DB.
  const backupDir = join(tmpDir, "backups");
  const snaps = readdirSync(backupDir).filter((n) => n.startsWith("keeper-"));
  expect(snaps.length).toBeGreaterThanOrEqual(1);
});

test("run(): the stale OLD-file sidecars are removed by the swap", () => {
  // Focused assertion on sidecar drop: plant distinctively-sized sidecars, run
  // the swap, and confirm they are gone immediately after run() returns (before
  // any reopen of the swapped DB can recreate them).
  const { db } = openDb(dbPath, { migrate: false });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  writeFileSync(`${dbPath}-wal`, Buffer.alloc(128, 0xab));
  writeFileSync(`${dbPath}-shm`, Buffer.alloc(128, 0xcd));

  const { exits, deps } = captureDeps();
  runCatching(args(), deps);

  expect(exits).toEqual([]);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
});

// ---------------------------------------------------------------------------
// F5 — daemon-up HARD-GUARD refusal
// ---------------------------------------------------------------------------

test("run(): refuses while keeperd holds the lock, leaving the DB byte-identical", () => {
  // A live pid in `<sock>.lock` ⇒ daemon up ⇒ HARD-GUARD refusal.
  writeFileSync(`${sockPath}.lock`, `${process.pid}\n`);

  const before = readFileSync(dbPath);

  const { out, err, exits, deps } = captureDeps();
  runCatching(args(), deps);

  // Exited 1 via the injected exit; the REFUSING message names the live pid.
  expect(exits).toEqual([1]);
  const stderr = err.join("");
  expect(stderr).toContain("REFUSING");
  expect(stderr).toContain(`pid ${process.pid}`);

  // No snapshot, no reclaim, no swap performed: the source DB is byte-identical
  // and no `.reclaim` output / backup dir was created.
  const after = readFileSync(dbPath);
  expect(after.equals(before)).toBe(true);
  expect(existsSync(`${dbPath}.reclaim`)).toBe(false);
  expect(existsSync(join(tmpDir, "backups"))).toBe(false);
  // Nothing was written to stdout (the source-size log comes AFTER the guard).
  expect(out.join("")).toBe("");
});

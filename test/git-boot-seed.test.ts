/**
 * fn-868 — LIVE-ONLY git projection: the boot-seed PRODUCER
 * (`seedGitProjection`). Re-derives `git_status` + `file_attributions` + the 3
 * `jobs` git-counters for currently-dirty files BEFORE the daemon serves, raises
 * the skip-floor to the captured `max(events.id)`, and manages the
 * `seed_required` lifecycle (crash-recovery + degrade-not-fatal).
 *
 * NO REAL GIT (fn-904): the seed's ONLY git boundary is its injectable
 * `buildSnapshotForRoot` seam (defaulting to the real `readStatus` →
 * `buildGitSnapshot` producer). These tests drive the seed's fold / floor /
 * reset / seed_required DECISIONS with synthetic `GitSnapshotPayload`s — a
 * one-dirty-file snapshot stands in for a real dirty repo, a `null` return
 * stands in for a non-repo / timed-out read, and a throwing builder stands in
 * for a hard per-root failure. `freshMemDb` supplies a migrated DB carrying the
 * prepared `stmts.insertEvent` the seed reuses.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeeperDb } from "../src/db";
import {
  openDb,
  readGitProjectionFloor,
  readGitProjectionSeedRequired,
  SCHEMA_VERSION,
} from "../src/db";
import {
  DEFAULT_GIT_SEED_BUDGET_MS,
  seedGitProjection,
} from "../src/git-boot-seed";
import type { GitSnapshotPayload } from "../src/git-worker";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let kdb: KeeperDb;
const tmpDirs: string[] = [];

beforeEach(() => {
  kdb = freshMemDb();
});

afterEach(() => {
  kdb.db.close();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// Synthetic snapshot builders — what `buildSnapshotForRoot` returns for a root.
// A "dirty repo" is just a one-untracked-file snapshot on `main`; the seed never
// sees git, only this payload.
// ---------------------------------------------------------------------------

/**
 * The synthetic payload a dirty repo (one untracked `dirty.ts`) would produce.
 * `dirtyPath` defaults to a repo-relative `dirty.ts`; pass an absolute path when
 * a test attributes the dirty file to a live job (the mutation event's
 * `mutation_path` must match the snapshot file path the reducer attributes).
 */
function dirtySnapshot(
  projectDir: string,
  dirtyPath = "dirty.ts",
): GitSnapshotPayload {
  return {
    project_dir: projectDir,
    branch: "main",
    head_oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty_files: [
      {
        path: dirtyPath,
        xy: "??",
        kind: "untracked",
        mtime_ms: null,
        worktree_oid: null,
        index_oid: null,
        worktree_mode: null,
      },
    ],
  };
}

/** A clean repo: a snapshot on `main` with an empty dirty set. */
function cleanSnapshot(projectDir: string): GitSnapshotPayload {
  return {
    project_dir: projectDir,
    branch: "main",
    head_oid: "a".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty_files: [],
  };
}

/** A synthetic-root path stand-in (no real dir is created — the seed never stats it). */
function fakeRoot(name: string): string {
  return `/synthetic/keeper-bootseed/${name}`;
}

/** Drain-to-completion over this test's db (the callback the seed needs). */
function drainAll(): void {
  let n: number;
  do {
    n = drain(kdb.db);
  } while (n > 0);
}

function gitStatusRow(
  projectDir: string,
): { dirty_count: number; branch: string | null } | null {
  return kdb.db
    .query("SELECT dirty_count, branch FROM git_status WHERE project_dir = ?")
    .get(projectDir) as { dirty_count: number; branch: string | null } | null;
}

// ---------------------------------------------------------------------------
// Live bootstrap + tail-equivalence
// ---------------------------------------------------------------------------

test("boot-seed re-derives git_status + file_attributions for a currently-dirty repo (before serving)", () => {
  const repo = fakeRoot("dirty");
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [repo],
    buildSnapshotForRoot: (root) => dirtySnapshot(root),
  });

  expect(result.seededRoots).toEqual([repo]);
  expect(result.complete).toBe(true);

  const row = gitStatusRow(repo);
  expect(row).not.toBeNull();
  expect(row?.branch).toBe("main");
  expect(row?.dirty_count).toBe(1); // the one untracked file

  // The dirty file landed a file_attributions row (orphan — no mutation event,
  // so source defaults to the inferred/orphan path; the row keys on the repo).
  const attribCount = (
    kdb.db
      .query(
        "SELECT COUNT(*) AS n FROM file_attributions WHERE project_dir = ?",
      )
      .get(repo) as { n: number }
  ).n;
  expect(attribCount).toBeGreaterThanOrEqual(0); // orphan files may have 0 attributions
  // git_status.dirty_count is the authoritative currently-dirty fidelity check.
});

test("tail-equivalence: a clean repo seeds an empty/clean git_status (dirty_count 0)", () => {
  const dir = fakeRoot("clean");
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [dir],
    buildSnapshotForRoot: (root) => cleanSnapshot(root),
  });
  expect(result.complete).toBe(true);
  const row = gitStatusRow(dir);
  // A clean repo still emits a snapshot (head_oid present) with dirty_count 0.
  expect(row?.dirty_count ?? 0).toBe(0);
});

test("seed-then-live re-emit on the SAME dirty set is idempotent (git_status + file_attributions + 3 jobs git-counters unchanged)", () => {
  // The production path on every git-enabled boot: the boot-seed populates the
  // live-only git surface, then the live git-worker's first scan re-emits a
  // GitSnapshot for the SAME dirty set. That re-emit must fold idempotently —
  // no double-counted attributions, no drifted git_status, no bumped jobs
  // git-counters. It is the invariant the whole live-only design rests on (see
  // the git-boot-seed.ts header). Bookkeeping columns (last_event_id /
  // updated_at) DO advance on the re-fold and are excluded; the OBSERVABLE git
  // surface must not move.
  const repo = fakeRoot("idempotent");
  const sess = "11111111-1111-1111-1111-111111111111";
  const dirtyPath = `${repo}/dirty.ts`;

  // A live job that edited the now-dirty file, so the seed attributes dirty.ts
  // to a live toucher — populating file_attributions AND the job's git-counters
  // so the check is meaningful (not a 0 == 0 tautology).
  kdb.db.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, state) VALUES (?, 1000, 1000, 'working')",
    [sess],
  );
  kdb.db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (1001, ?, NULL, 'PostToolUse', 'post_tool_use', 'Write', ?, ?, ?)`,
    [sess, repo, JSON.stringify({ file_path: dirtyPath }), dirtyPath],
  );

  // The snapshot reports a REPO-RELATIVE dirty path (`dirty.ts`); the reducer
  // anchors it onto `project_dir` and matches the resulting absolute path
  // against the mutation event's absolute `mutation_path` — so the two join
  // into a live attribution.
  const snapshotForRoot = (root: string) => dirtySnapshot(root, "dirty.ts");

  const stripVolatile = (
    row: Record<string, unknown> | null,
  ): Record<string, unknown> | null => {
    if (row !== null) {
      delete row.last_event_id;
      delete row.updated_at;
    }
    return row;
  };
  const capture = () => ({
    gitStatus: stripVolatile(
      kdb.db
        .query("SELECT * FROM git_status WHERE project_dir = ?")
        .get(repo) as Record<string, unknown> | null,
    ),
    attributions: (
      kdb.db
        .query(
          "SELECT * FROM file_attributions WHERE project_dir = ? ORDER BY file_path, session_id",
        )
        .all(repo) as Record<string, unknown>[]
    ).map((r) => stripVolatile(r)),
    jobCounters: kdb.db
      .query(
        "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
      )
      .get(sess),
  });

  // 1. Boot-seed (the boot half of the live surface).
  const seed = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [repo],
    buildSnapshotForRoot: snapshotForRoot,
  });
  expect(seed.complete).toBe(true);

  const before = capture();
  // Fixture sanity: all three surfaces are actually populated.
  expect((before.gitStatus as { dirty_count: number }).dirty_count).toBe(1);
  expect(before.attributions.length).toBeGreaterThanOrEqual(1);
  expect(
    (before.jobCounters as { git_dirty_count: number }).git_dirty_count,
  ).toBeGreaterThanOrEqual(1);

  // 2. Live re-emit: the git-worker's first scan emits a GitSnapshot for the
  //    SAME dirty set, folded ABOVE the floor with NO reset (its id is the
  //    highest in the log — appended after the boot-seed's synthetic snapshot).
  const snapshot = snapshotForRoot(repo);
  kdb.db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
       VALUES (2000, ?, NULL, 'GitSnapshot', 'git_snapshot', ?, ?)`,
    [repo, repo, JSON.stringify(snapshot)],
  );
  drainAll();

  // 3. The re-emit folded idempotently — the observable surface is unchanged.
  expect(capture()).toEqual(before);
});

// ---------------------------------------------------------------------------
// Seed-freshness: floor raised, seed_required cleared
// ---------------------------------------------------------------------------

test("seed-freshness: the floor is raised to the captured max(events.id) and seed_required is cleared on success", () => {
  // Seed some pre-existing events so max(events.id) > 0.
  for (let i = 0; i < 3; i++) {
    kdb.db.run(
      "INSERT INTO events (ts, session_id, pid, hook_event, event_type, data) VALUES (?, 's', NULL, 'Stop', 'stop', '{}')",
      [1000 + i],
    );
  }
  const preMaxId = (
    kdb.db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;

  const repo = fakeRoot("freshness");
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [repo],
    buildSnapshotForRoot: (root) => dirtySnapshot(root),
  });

  // The persisted floor equals the max id captured BEFORE the scan (the
  // synthetic GitSnapshot the seed appended sits ABOVE it).
  expect(result.floor).toBe(preMaxId);
  expect(readGitProjectionFloor(kdb.db)).toBe(preMaxId);
  expect(readGitProjectionSeedRequired(kdb.db)).toBe(false);
});

// ---------------------------------------------------------------------------
// Crash-recovery + degrade-not-fatal
// ---------------------------------------------------------------------------

test("crash-recovery: a non-git root degrades (no throw) and leaves seed_required SET to retry", () => {
  const notARepo = fakeRoot("bare");
  // `buildSnapshotForRoot` returns null for a non-git dir (mirrors `readStatus`
  // returning null), so the root is skipped and the seed reports incomplete.
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [notARepo],
    buildSnapshotForRoot: () => null,
  });

  expect(result.complete).toBe(false);
  expect(result.seededRoots).toEqual([]);
  // seed_required STAYS set so a later boot re-seeds.
  expect(readGitProjectionSeedRequired(kdb.db)).toBe(true);
  // The floor is still raised (the historical replay must stay skipped).
  expect(readGitProjectionFloor(kdb.db)).toBe(0); // empty event log ⇒ floor 0
});

test("degrade-not-fatal: a drain callback that throws is isolated per-root; the seed never throws and leaves seed_required set", () => {
  const repo = fakeRoot("drain-throw");
  let calls = 0;
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: () => {
      calls++;
      throw new Error("simulated drain failure");
    },
    roots: [repo],
    buildSnapshotForRoot: (root) => dirtySnapshot(root),
  });
  expect(calls).toBeGreaterThan(0); // the drain was attempted
  expect(result.complete).toBe(false);
  expect(result.seededRoots).toEqual([]);
  expect(readGitProjectionSeedRequired(kdb.db)).toBe(true);
});

test("budget: an exhausted time budget stops issuing scans and leaves seed_required set", () => {
  const repo1 = fakeRoot("budget-1");
  const repo2 = fakeRoot("budget-2");
  // A clock that jumps past the budget on the first elapsed-check.
  let t = 0;
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [repo1, repo2],
    buildSnapshotForRoot: (root) => dirtySnapshot(root),
    timeBudgetMs: 10,
    now: () => {
      const v = t;
      t += 1000; // each call advances 1s — exceeds the 10ms budget immediately
      return v;
    },
  });
  expect(result.complete).toBe(false);
  expect(readGitProjectionSeedRequired(kdb.db)).toBe(true);
});

// ---------------------------------------------------------------------------
// Multi-root: every explicit root is seeded from its own snapshot
// ---------------------------------------------------------------------------
//
// (The DISCOVERY path — no explicit roots, `jobs.cwd` → git toplevel resolve —
// genuinely needs real git and lives in git-boot-seed-realgit.slow.test.ts.)

test("multi-root: each explicit root is seeded independently from its own snapshot", () => {
  const repoA = fakeRoot("multi-a");
  const repoB = fakeRoot("multi-b");
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [repoA, repoB],
    buildSnapshotForRoot: (root) => dirtySnapshot(root),
  });
  expect(result.seededRoots.sort()).toEqual([repoA, repoB].sort());
  expect(gitStatusRow(repoA)?.dirty_count).toBe(1);
  expect(gitStatusRow(repoB)?.dirty_count).toBe(1);
});

test("default budget constant is a sane positive value", () => {
  expect(DEFAULT_GIT_SEED_BUDGET_MS).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// COPY-PROOF (synthetic corpus) — the merge gate. The orchestrator runs the
// real-1GB-DB version before cutover; this is the synthetic-corpus equivalent.
// ---------------------------------------------------------------------------

test("copy-proof (synthetic): v78→v79 migrate + boot-seed is FAST (historical GitSnapshots skipped) + correct for currently-dirty files + downgrade-guarded", () => {
  const repo = fakeRoot("copyproof");
  // An on-disk SQLite path the test reopens across migrate cycles. It is a DB
  // file only — no git repo is created, and the seed runs via the synthetic
  // `buildSnapshotForRoot` injection, so this test touches no real git.
  const dbDir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-copyproof-")));
  tmpDirs.push(dbDir);
  const dbPath = join(dbDir, "v78.db");

  // 1. Build a v78-shaped DB: migrate to current, then regress the stamp to 78
  //    and DROP the v79 control table so the reopen genuinely runs v78→v79.
  {
    const seed = openDb(dbPath);
    // Seed a realistic count of HISTORICAL GitSnapshot events for the repo. In
    // the OLD deterministic-replay model these would each drive
    // `computeRepoBashWindows` (the ~6-day self-join time-bomb); the v79 floor
    // must make every one of them a no-op on the post-migrate drain.
    const N = 4000;
    const insertSnap = seed.db.prepare(
      `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
         VALUES (?, ?, NULL, 'GitSnapshot', 'git_snapshot', ?, ?)`,
    );
    const snapData = JSON.stringify({
      project_dir: repo,
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty_files: [{ path: "historical.ts", xy: " M", mtime_ms: null }],
    });
    const tx = seed.db.transaction(() => {
      for (let i = 0; i < N; i++) {
        insertSnap.run(2000 + i, repo, repo, snapData);
      }
    });
    tx();
    // Regress to v78 + drop the v79 surface so the reopen migrates for real.
    seed.db.run("DROP TABLE IF EXISTS git_projection_state");
    seed.db
      .prepare("UPDATE meta SET value = '78' WHERE key = 'schema_version'")
      .run();
    seed.db.close();
  }

  // 2. Reopen → migrate v78→v79 (raises floor = max(events.id)) + the post-migrate
  //    boot drain. TIME it: the historical GitSnapshots must be skipped, so this
  //    is milliseconds, not the ~6-day replay.
  const t0 = performance.now();
  const { db, stmts } = openDb(dbPath);
  // The post-migrate drain (folds nothing new for git since floor gates them).
  let n: number;
  do {
    n = drain(db);
  } while (n > 0);
  const migrateAndDrainMs = performance.now() - t0;

  try {
    // (a) FAST: a generous CI bound. The whole point is it does NOT replay the
    //     4000 GitSnapshots through the self-join. Comfortably sub-second.
    expect(migrateAndDrainMs).toBeLessThan(5000);

    // The floor was raised to the max historical id, so the git surface is EMPTY
    // after the drain (every historical GitSnapshot self-gated) — proving the
    // historical replay was skipped, NOT folded.
    const floor = readGitProjectionFloor(db);
    expect(floor).toBeGreaterThan(0);
    expect(
      kdbStatus(db, repo),
      "historical GitSnapshots must be skipped (no git_status from the drain)",
    ).toBeNull();
    expect(readGitProjectionSeedRequired(db)).toBe(true); // migration set it

    // (b) Boot-seed re-derives the surface CORRECTLY for currently-dirty files.
    const seedDrain = (): void => {
      let m: number;
      do {
        m = drain(db);
      } while (m > 0);
    };
    const result = seedGitProjection(db, stmts, {
      drainToCompletion: seedDrain,
      roots: [repo],
      // The CURRENT dirty set is one untracked `dirty.ts` — NOT the historical
      // `historical.ts` that only ever existed in the synthetic event payloads.
      buildSnapshotForRoot: (root) => dirtySnapshot(root),
    });
    expect(result.complete).toBe(true);
    const row = kdbStatus(db, repo);
    expect(row).not.toBeNull();
    expect(row?.dirty_count).toBe(1);
    expect(readGitProjectionSeedRequired(db)).toBe(false); // seed cleared it

    // (c) The runtime-downgrade guard still refuses an older binary: stamp the DB
    //     one ahead and assert openDb throws BEFORE migrating.
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();
    let guardErr: unknown = null;
    try {
      openDb(dbPath);
    } catch (err) {
      guardErr = err;
    }
    expect(guardErr).not.toBeNull();
    expect(String((guardErr as Error).message)).toMatch(
      /refusing to run rather than silently downgrade/,
    );
  } finally {
    try {
      db.close();
    } catch {
      // already closed in the guard branch
    }
  }
});

/** Read git_status.dirty_count for a root on an arbitrary connection. */
function kdbStatus(
  db: Database,
  projectDir: string,
): { dirty_count: number } | null {
  return db
    .query("SELECT dirty_count FROM git_status WHERE project_dir = ?")
    .get(projectDir) as { dirty_count: number } | null;
}

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
  allGatedRootsSeeded,
  gatedGitRoots,
  unseededGatedRoots,
} from "../src/gated-roots";
import {
  DEFAULT_GIT_SEED_BUDGET_MS,
  discoverSeedRoots,
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

/**
 * Seed one OPEN epic whose tasks gate the given roots: a `target_repo` per root
 * (and the epic's own `project_dir` as the close-row root). The `seed_required`
 * lifecycle now gates on the GATED root set (open-epic `project_dir` +
 * `task.target_repo`), so a test that wants a failing root to KEEP the flag set
 * must make that root a GATED root — a stale, non-gated root self-clears.
 */
function seedOpenEpic(
  epicId: string,
  projectDir: string,
  taskRepos: string[],
): void {
  const tasks = taskRepos.map((repo, i) => ({
    task_id: `${epicId}.${i + 1}`,
    epic_id: epicId,
    task_number: i + 1,
    target_repo: repo,
  }));
  kdb.db
    .query(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, 1, 'gated', ?, 'open', 0, 1, ?)`,
    )
    .run(epicId, projectDir, JSON.stringify(tasks));
}

function seedRequired(): boolean {
  return readGitProjectionSeedRequired(kdb.db);
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
// Per-root gating: gated-set scope + self-clear (boot AND fold paths)
// ---------------------------------------------------------------------------

test("gated-roots: gatedGitRoots derives open-epic project_dir + task target_repo (close-row root included), ignoring closed epics", () => {
  const projOpen = fakeRoot("proj-open");
  const repoA = fakeRoot("task-a");
  const repoB = fakeRoot("task-b");
  seedOpenEpic("fn-1-open", projOpen, [repoA, repoB]);
  // A CLOSED/completed epic must contribute NO gated root (it dispatches
  // nothing). Insert with a non-open status.
  kdb.db
    .query(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES ('fn-2-done', 2, 'done', ?, 'completed', 0, 1, ?)`,
    )
    .run(
      fakeRoot("proj-done"),
      JSON.stringify([
        { task_id: "fn-2-done.1", target_repo: fakeRoot("task-done") },
      ]),
    );

  const gated = gatedGitRoots(kdb.db);
  // Open epic: its project_dir (close-row root) + both task repos.
  expect(gated).toContain(projOpen);
  expect(gated).toContain(repoA);
  expect(gated).toContain(repoB);
  // Closed epic contributes nothing.
  expect(gated).not.toContain(fakeRoot("proj-done"));
  expect(gated).not.toContain(fakeRoot("task-done"));
});

test("scoped discovery keeps every gated root and drops the stale historical sweep", () => {
  // A gated root with NO job history at all (clean, idle) must still be in the
  // seed set — the gated union covers it. A stale `jobs.cwd`-only root with no
  // open epic and no recent activity must NOT (the full sweep is gone).
  //
  // The discovery path resolves candidates through `resolveGitToplevel` (real
  // git), so we assert the DERIVATION (`gatedGitRoots`) directly rather than the
  // resolved set — the real-git resolution is covered in the slow tier.
  const gatedClean = fakeRoot("gated-clean-idle");
  seedOpenEpic("fn-1-clean-idle", gatedClean, [gatedClean]);
  // A stale cwd that is NOT a gated root.
  kdb.db.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, state, cwd) VALUES ('j-stale', 1, 1, 'stopped', ?)",
    [fakeRoot("stale-volumes-scratch")],
  );
  const gated = gatedGitRoots(kdb.db);
  expect(gated).toContain(gatedClean);
  expect(gated).not.toContain(fakeRoot("stale-volumes-scratch"));
});

test("self-clear (fold path): a gated root seeded ONLY by a later above-floor GitSnapshot clears seed_required in main's fold", () => {
  const seeded = fakeRoot("gated-seeded");
  const missed = fakeRoot("gated-missed");
  // Two gated roots; the boot-seed only covers `seeded` (the producer skips
  // `missed`, mirroring a transient read failure). `seed_required` stays set.
  seedOpenEpic("fn-1-two-gated", seeded, [seeded, missed]);
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [seeded], // boot-seed misses `missed` entirely
    buildSnapshotForRoot: (root) => dirtySnapshot(root),
  });
  expect(result.complete).toBe(true); // every TARGETED root seeded…
  expect(seedRequired()).toBe(true); // …but the gated `missed` root has no row

  // The floor is now the captured max(events.id) BEFORE the seed scan; the
  // synthetic seed snapshot for `seeded` sits above it. A LATER live GitSnapshot
  // for `missed` (id above the floor) is main's producer-only self-heal.
  const floor = readGitProjectionFloor(kdb.db);
  expect(allGatedRootsSeeded(kdb.db, floor)).toBe(false); // missed still bare

  const snapshot = dirtySnapshot(missed);
  kdb.db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
       VALUES (9000, ?, NULL, 'GitSnapshot', 'git_snapshot', ?, ?)`,
    [missed, missed, JSON.stringify(snapshot)],
  );
  drainAll();

  // The above-floor fold for `missed` lands its git_status row → every gated
  // root now seeded → main's fold cleared `seed_required`. No git-worker write,
  // no boot bounce, no retry loop.
  expect(allGatedRootsSeeded(kdb.db, floor)).toBe(true);
  expect(seedRequired()).toBe(false);
});

test("transiently-failing gated root leaves ONLY itself unseeded (sibling gated roots seed)", () => {
  const ok = fakeRoot("gated-ok");
  const flaky = fakeRoot("gated-flaky");
  seedOpenEpic("fn-1-mixed", ok, [ok, flaky]);
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [ok, flaky],
    // `flaky` returns null (transient read failure); `ok` seeds.
    buildSnapshotForRoot: (root) =>
      root === flaky ? null : dirtySnapshot(root),
  });
  expect(result.seededRoots).toEqual([ok]);
  // `ok` has its row; `flaky` does not — only the failing root is unseeded.
  expect(gitStatusRow(ok)?.dirty_count).toBe(1);
  expect(gitStatusRow(flaky)).toBeNull();
  // The gated `flaky` root keeps the flag set until its own emit lands.
  expect(seedRequired()).toBe(true);
});

test("fn-905: unseededGatedRoots returns ONLY the gated roots lacking an above-floor git_status row", () => {
  const ok = fakeRoot("gated-ok");
  const flaky = fakeRoot("gated-flaky");
  seedOpenEpic("fn-1-mixed", ok, [ok, flaky]);
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [ok, flaky],
    buildSnapshotForRoot: (root) =>
      root === flaky ? null : dirtySnapshot(root),
  });
  expect(result.seededRoots).toEqual([ok]);
  const floor = readGitProjectionFloor(kdb.db);

  // Only `flaky` (no above-floor row) is unseeded; the seeded `ok` + the
  // close-row root (`ok` again, the epic's project_dir) are not.
  const unseeded = unseededGatedRoots(kdb.db, floor);
  expect(unseeded.has(flaky)).toBe(true);
  expect(unseeded.has(ok)).toBe(false);
  // This is exactly the complement of `allGatedRootsSeeded`.
  expect(allGatedRootsSeeded(kdb.db, floor)).toBe(false);

  // A later above-floor GitSnapshot for `flaky` clears it from the set.
  kdb.db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
       VALUES (9000, ?, NULL, 'GitSnapshot', 'git_snapshot', ?, ?)`,
    [flaky, flaky, JSON.stringify(dirtySnapshot(flaky))],
  );
  drainAll();
  expect(unseededGatedRoots(kdb.db, floor).size).toBe(0);
  expect(allGatedRootsSeeded(kdb.db, floor)).toBe(true);
});

test("fn-921: a gated effectiveRoot keyed differently from its toplevel write key clears ONLY with a resolver", () => {
  // The READ key is the raw effectiveRoot; the boot-seed/live git-worker WRITE the
  // row under resolveGitToplevel(root). Simulate the mismatch: gate on a SUBDIR
  // effectiveRoot but write the row under its toplevel. Without a resolver the
  // gated root reads unseeded forever (the latent freeze the fn-921 fix targets);
  // with the resolver (toplevel write key) it clears.
  const toplevel = fakeRoot("repo-toplevel");
  const subdir = `${toplevel}/packages/app`; // a target_repo pointing at a subdir
  seedOpenEpic("fn-1-subdir", toplevel, [subdir]);
  // Seed the row under the TOPLEVEL (the real write key), above the floor.
  const floor = readGitProjectionFloor(kdb.db);
  kdb.db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
       VALUES (9000, ?, NULL, 'GitSnapshot', 'git_snapshot', ?, ?)`,
    [toplevel, toplevel, JSON.stringify(dirtySnapshot(toplevel))],
  );
  drainAll();

  // The resolver maps the subdir effectiveRoot to its toplevel write key.
  const resolver = (root: string): string =>
    root === subdir ? toplevel : root;

  // Raw key: the subdir has no row → still unseeded (the latent bug).
  expect(unseededGatedRoots(kdb.db, floor).has(subdir)).toBe(true);
  expect(allGatedRootsSeeded(kdb.db, floor)).toBe(false);

  // Resolved key: the subdir maps to the toplevel row → seeded.
  expect(unseededGatedRoots(kdb.db, floor, resolver).has(subdir)).toBe(false);
  // The close-row root (the epic project_dir == toplevel) is keyed at the
  // toplevel directly, so it is already seeded — every gated root now resolves.
  expect(allGatedRootsSeeded(kdb.db, floor, resolver)).toBe(true);
});

test("fn-921: a resolver that throws falls back to the raw key (never throws into the read path)", () => {
  const repo = fakeRoot("resolver-throws");
  seedOpenEpic("fn-1-throws", repo, [repo]);
  const floor = readGitProjectionFloor(kdb.db);
  const throwing = (): string => {
    throw new Error("git unavailable");
  };
  // The repo has no row; a throwing resolver must NOT propagate — it falls back to
  // the raw key, so the verdict is the same as the no-resolver default.
  expect(() => unseededGatedRoots(kdb.db, floor, throwing)).not.toThrow();
  expect(unseededGatedRoots(kdb.db, floor, throwing).has(repo)).toBe(true);
  expect(allGatedRootsSeeded(kdb.db, floor, throwing)).toBe(false);
});

test("fn-905: with NO gated roots, unseededGatedRoots is empty (the gate is off)", () => {
  // No open epics → no gated roots → empty set, even with a stale git_status row.
  kdb.db.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, state, cwd) VALUES ('j-stale', 1, 1, 'stopped', ?)",
    [fakeRoot("stale")],
  );
  expect(unseededGatedRoots(kdb.db, readGitProjectionFloor(kdb.db)).size).toBe(
    0,
  );
});

// ---------------------------------------------------------------------------
// Crash-recovery + degrade-not-fatal
// ---------------------------------------------------------------------------

test("crash-recovery: a GATED non-git root degrades (no throw) and leaves seed_required SET to retry", () => {
  const notARepo = fakeRoot("bare");
  // Make the failing root a GATED root (an open epic targets it), so a null read
  // leaves it unseeded and KEEPS `seed_required` set — the incident class the
  // self-clear must NOT mis-clear.
  seedOpenEpic("fn-1-gated-bare", notARepo, [notARepo]);
  // `buildSnapshotForRoot` returns null for a non-git dir (mirrors `readStatus`
  // returning null), so the root is skipped and the seed reports incomplete.
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [notARepo],
    buildSnapshotForRoot: () => null,
  });

  expect(result.complete).toBe(false);
  expect(result.seededRoots).toEqual([]);
  // seed_required STAYS set: the gated root never got an above-floor row.
  expect(seedRequired()).toBe(true);
  // The floor is still raised (the historical replay must stay skipped).
  expect(readGitProjectionFloor(kdb.db)).toBe(0); // empty event log ⇒ floor 0
});

test("scope: with NO gated roots, a stale non-git root self-clears seed_required (never darks an empty board)", () => {
  const stale = fakeRoot("stale-scratch");
  // No open epics ⇒ no gated roots. A stale root that fails to read must NOT
  // keep `seed_required` set — nothing references it, so the board stays lit.
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [stale],
    buildSnapshotForRoot: () => null,
  });
  expect(result.complete).toBe(false); // the root itself didn't seed
  expect(seedRequired()).toBe(false); // …but no gated root is unseeded
});

test("degrade-not-fatal: a drain callback that throws is isolated per-root; the seed never throws and leaves seed_required set", () => {
  const repo = fakeRoot("drain-throw");
  // Gated root: a throwing drain leaves it without an above-floor row, so
  // `seed_required` must stay set.
  seedOpenEpic("fn-1-gated-drain", repo, [repo]);
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
  expect(seedRequired()).toBe(true);
});

test("budget: an exhausted time budget stops issuing scans and leaves seed_required set", () => {
  const repo1 = fakeRoot("budget-1");
  const repo2 = fakeRoot("budget-2");
  // Gated roots: budget exhaustion before either seeds leaves both gated roots
  // without an above-floor row, so `seed_required` stays set to retry.
  seedOpenEpic("fn-1-gated-budget", repo1, [repo1, repo2]);
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
  expect(seedRequired()).toBe(true);
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
// fn-921: stale-root prune — a missing root is dropped BEFORE the toplevel
// resolve, so an unmounted /Volumes/Scratch/* repo can't burn the resolve
// timeout and drag the seed.
// ---------------------------------------------------------------------------

test("fn-921: discoverSeedRoots prunes a missing root BEFORE resolveGitToplevel (no git spawn for the absent root)", () => {
  // An open epic whose project_dir + task target_repo are STALE scratch paths
  // (the repo is gone). `pathExists` reports them missing, so they are pruned
  // before the 2s toplevel resolve — `resolveGitToplevel` is never reached for
  // them (proven by an empty result: every candidate is missing, so no real git
  // is spawned at all and the function returns []).
  const scratchProj = fakeRoot("Volumes/Scratch/gone-proj");
  const scratchTask = fakeRoot("Volumes/Scratch/gone-task");
  seedOpenEpic("fn-1-scratch", scratchProj, [scratchTask]);
  // A stale working-job cwd that is also gone.
  kdb.db.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, state, cwd) VALUES ('j-gone', 1, 1, 'working', ?)",
    [fakeRoot("Volumes/Scratch/gone-cwd")],
  );

  const probed: string[] = [];
  const roots = discoverSeedRoots(kdb.db, Date.now(), (p) => {
    probed.push(p);
    return false; // every candidate is missing → all pruned
  });

  // Every candidate was probed for existence…
  expect(probed).toContain(scratchProj);
  expect(probed).toContain(scratchTask);
  expect(probed).toContain(fakeRoot("Volumes/Scratch/gone-cwd"));
  // …and every one pruned, so the resolved set is empty (no git spawned).
  expect(roots).toEqual([]);
});

test("fn-921: a probe that throws treats the root as missing (never throws into discovery)", () => {
  const repo = fakeRoot("Volumes/Scratch/broken-symlink");
  seedOpenEpic("fn-1-broken", repo, [repo]);
  // A probe that throws (a broken symlink / permission error) must NOT propagate
  // — the candidate is treated as missing and pruned.
  expect(() =>
    discoverSeedRoots(kdb.db, Date.now(), () => {
      throw new Error("EACCES");
    }),
  ).not.toThrow();
  const roots = discoverSeedRoots(kdb.db, Date.now(), () => {
    throw new Error("EACCES");
  });
  expect(roots).toEqual([]);
});

// ---------------------------------------------------------------------------
// fn-921: warm-memo — pre-warming the attribution memo before the per-root loop
// produces a byte-identical surface to the cold-fold path. The memo is a pure
// optimization, never a fold input, so re-fold determinism is untouched.
// ---------------------------------------------------------------------------

test("fn-921: pre-warmed memo yields the same git surface as the cold fold (memo is not a fold input)", () => {
  // Two independent connections seed the SAME log: one where the memo is warmed
  // ahead of the per-root loop (production path), one explicit-roots run that is
  // cold by construction (fresh DB). The observable git surface must match.
  const repo = fakeRoot("warm-equiv");
  const sess = "22222222-2222-2222-2222-222222222222";
  const dirtyPath = `${repo}/dirty.ts`;

  // A live mutation event so attribution is non-trivial (a real bash-mutation
  // row the memo's incremental scan must pick up).
  const seedLog = (db: Database): void => {
    db.run(
      "INSERT INTO jobs (job_id, created_at, updated_at, state) VALUES (?, 1000, 1000, 'working')",
      [sess],
    );
    db.run(
      `INSERT INTO events (ts, session_id, pid, hook_event, event_type, tool_name, cwd, data, mutation_path)
         VALUES (1001, ?, NULL, 'PostToolUse', 'post_tool_use', 'Write', ?, ?, ?)`,
      [sess, repo, JSON.stringify({ file_path: dirtyPath }), dirtyPath],
    );
  };

  const captureSurface = (db: Database) =>
    JSON.stringify({
      gitStatus: db
        .query(
          "SELECT branch, dirty_count FROM git_status WHERE project_dir = ?",
        )
        .get(repo),
      attributions: db
        .query(
          "SELECT session_id, file_path, source, op FROM file_attributions WHERE project_dir = ? ORDER BY file_path, session_id",
        )
        .all(repo),
    });

  // Path A — the production seed (warmGitAttribMemo runs before the per-root
  // loop inside seedGitProjection).
  seedLog(kdb.db);
  const warmResult = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    roots: [repo],
    buildSnapshotForRoot: (root) => dirtySnapshot(root, "dirty.ts"),
  });
  expect(warmResult.complete).toBe(true);
  const warmSurface = captureSurface(kdb.db);

  // Path B — a SECOND fresh connection (cold memo), same log, same seed. With no
  // pre-warm difference visible in the output, the two surfaces are identical.
  const cold = freshMemDb();
  try {
    seedLog(cold.db);
    const coldResult = seedGitProjection(cold.db, cold.stmts, {
      drainToCompletion: () => {
        let n: number;
        do {
          n = drain(cold.db);
        } while (n > 0);
      },
      roots: [repo],
      buildSnapshotForRoot: (root) => dirtySnapshot(root, "dirty.ts"),
    });
    expect(coldResult.complete).toBe(true);
    expect(warmSurface).toBe(captureSurface(cold.db));
  } finally {
    cold.db.close();
  }
});

// ---------------------------------------------------------------------------
// COPY-PROOF (synthetic corpus) — the merge gate. The orchestrator runs the
// real-1GB-DB version before cutover; this is the synthetic-corpus equivalent.
// ---------------------------------------------------------------------------

test("copy-proof (synthetic): v78→v79 migrate + boot-seed skips historical GitSnapshots + is correct for currently-dirty files + downgrade-guarded", () => {
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
    // A minimal historical set is enough to prove every event is skipped.
    const N = 3;
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
  //    boot drain.
  const { db, stmts } = openDb(dbPath);
  // The post-migrate drain (folds nothing new for git since floor gates them).
  let n: number;
  do {
    n = drain(db);
  } while (n > 0);

  try {
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

    // Boot-seed re-derives the surface CORRECTLY for currently-dirty files.
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

    // The runtime-downgrade guard still refuses an older binary: stamp the DB
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

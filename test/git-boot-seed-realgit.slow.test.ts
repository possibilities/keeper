/**
 * SLOW real-git quarantine for `src/git-boot-seed.ts` (fn-904.4).
 *
 * The boot-seed's DISCOVERY path — no explicit roots, so `discoverSeedRoots`
 * resolves each `jobs.cwd` candidate to a git TOPLEVEL via real `git
 * rev-parse` — has no synthetic substitute: its contract IS "find a git repo
 * from a cwd on disk". The rest of the boot-seed suite
 * (`test/git-boot-seed.test.ts`) is git-free, driving the injectable
 * `buildSnapshotForRoot` seam with synthetic payloads. This file is the
 * deliberate, narrowly-scoped exception — slow-quarantined out of the fast tier.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeeperDb } from "../src/db";
import { seedGitProjection } from "../src/git-boot-seed";
import { drain } from "../src/reducer";
import { initRepo } from "./helpers/git-repo";
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

/** Make a real git repo with one dirty (untracked) file; return its realpath. */
function dirtyRepo(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "keeper-bootseed-disc-")),
  );
  tmpDirs.push(dir);
  initRepo(dir);
  writeFileSync(join(dir, "dirty.ts"), "export const x = 1;\n");
  return dir;
}

function drainAll(): void {
  let n: number;
  do {
    n = drain(kdb.db);
  } while (n > 0);
}

test("discovery: with no explicit roots, the seed discovers a repo from jobs.cwd (real git toplevel resolve)", () => {
  const repo = dirtyRepo();
  // A jobs row whose cwd is inside the repo makes it a discovery candidate;
  // `discoverSeedRoots` resolves it to the git toplevel via real git.
  kdb.db.run(
    "INSERT INTO jobs (job_id, created_at, cwd, state, updated_at) VALUES ('j1', 1000, ?, 'working', 1000)",
    [repo],
  );
  // No `roots` and no `buildSnapshotForRoot` override — the real producer path
  // (`readStatus` → `buildGitSnapshot`) reads the real dirty tree.
  const result = seedGitProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
  });
  expect(result.seededRoots).toContain(repo);
  const row = kdb.db
    .query("SELECT dirty_count FROM git_status WHERE project_dir = ?")
    .get(repo) as { dirty_count: number } | null;
  expect(row?.dirty_count).toBe(1);
});

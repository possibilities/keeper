/**
 * SLOW real-git quarantine for `src/git-worker.ts` (fn-904.2).
 *
 * These tests exercise functions whose contract IS "read git's own state"
 * (`resolveHeadOidViaFs` reads the ref files on disk and must match
 * `git rev-parse HEAD`; `probeWatchMembership` spawns `git status --porcelain=v2`;
 * the real-probe `discoverProjectRoots` cases drive that spawn) — there is no
 * synthetic input that validates them without a real git tree. The rest of the
 * git-worker suite (`test/git-worker.test.ts`) is git-free: pure seams driven by
 * captured-from-real-git goldens + synthetic payloads. This file is the
 * deliberate, narrowly-scoped exception — slow-quarantined out of the fast tier.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiscoveryContext,
  discoverProjectRoots,
  probeWatchMembership,
  resolveHeadOidViaFs,
} from "../src/git-worker";
import { initRepo as initGitRepo } from "./helpers/git-repo";

const tmpDirs: string[] = [];
function trackDir(d: string): string {
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (!r.success) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

function mkTmpWorktree(): string {
  return trackDir(mkdtempSync(join(tmpdir(), "keeper-git-snapshot-")));
}

// ---------------------------------------------------------------------------
// resolveHeadOidViaFs — the divergence watchdog's fs-only HEAD ground truth.
// Must match `git rev-parse HEAD` across regular repos, packed-refs, detached
// HEAD, and linked worktrees, WITHOUT shelling git — that independence is the
// whole point (it stays correct when the worker's git subprocess view wedges).
// ---------------------------------------------------------------------------

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-headfs-"));
  initGitRepo(dir);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("resolveHeadOidViaFs matches git rev-parse on a regular repo (loose ref)", () => {
  const dir = initRepo();
  try {
    expect(resolveHeadOidViaFs(dir)).toBe(git(dir, "rev-parse", "HEAD"));
    // A second commit advances HEAD; the fs read must track it.
    writeFileSync(join(dir, "b.txt"), "world\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");
    expect(resolveHeadOidViaFs(dir)).toBe(git(dir, "rev-parse", "HEAD"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs resolves a packed ref (no loose ref file)", () => {
  const dir = initRepo();
  try {
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "pack-refs", "--all");
    // refs/heads/main is now only in packed-refs; the loose file is gone.
    expect(resolveHeadOidViaFs(dir)).toBe(head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs returns the oid for a detached HEAD", () => {
  const dir = initRepo();
  try {
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "--detach", head);
    expect(resolveHeadOidViaFs(dir)).toBe(head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs resolves a linked worktree's own HEAD", () => {
  const dir = initRepo();
  const wt = mkdtempSync(join(tmpdir(), "keeper-headfs-wt-"));
  rmSync(wt, { recursive: true, force: true }); // git worktree add wants a fresh path
  try {
    git(dir, "branch", "feature");
    git(dir, "worktree", "add", "-q", wt, "feature");
    // The linked worktree's `.git` is a `gitdir:` pointer file, refs live in
    // the main repo's common-dir — the resolver must follow both hops.
    expect(resolveHeadOidViaFs(wt)).toBe(git(wt, "rev-parse", "HEAD"));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs returns null on a non-repo path (fail-safe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-headfs-bare-"));
  try {
    expect(resolveHeadOidViaFs(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// probeWatchMembership — combined `git status --porcelain=v2 --branch` parse
// for dirty + ahead. Critically uses default `-unormal`, not `-uall`.
// ---------------------------------------------------------------------------

function gitInit(root: string): void {
  initGitRepo(root);
}

function gitCommitSimple(root: string, message: string): void {
  const add = Bun.spawnSync(["git", "-C", root, "add", "-A"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!add.success) throw new Error("git add failed");
  const commit = Bun.spawnSync(
    ["git", "-C", root, "commit", "-q", "-m", message],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (!commit.success) throw new Error("git commit failed");
}

/**
 * Set up a real-git tmp repo with an upstream tracking branch, so the
 * watch-membership probe's `# branch.ab +N -M` parse has something to read.
 * Uses a local bare repo as the remote so no network is required. Returns the
 * resolved worktree path (realpathSync, matching `git rev-parse --show-toplevel`
 * — necessary on macOS where /tmp → /private/tmp).
 */
function mkTmpRepoWithUpstream(): string {
  const bare = trackDir(mkdtempSync(join(tmpdir(), "keeper-git-bare-")));
  const initBare = Bun.spawnSync(["git", "init", "--bare", "-q", bare], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!initBare.success) throw new Error("git init --bare failed");

  const root = realpathSync(mkTmpWorktree());
  gitInit(root);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  gitCommitSimple(root, "seed");
  for (const args of [
    ["remote", "add", "origin", bare],
    ["push", "-q", "-u", "origin", "main"],
  ] as const) {
    const res = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!res.success) throw new Error(`git ${args.join(" ")} failed`);
  }
  return root;
}

test("probeWatchMembership: clean + pushed → {dirty:false, ahead:0}", () => {
  const root = mkTmpRepoWithUpstream();
  expect(probeWatchMembership(root)).toEqual({ dirty: false, ahead: 0 });
});

test("probeWatchMembership: dirty (untracked file) → dirty:true", () => {
  const root = mkTmpRepoWithUpstream();
  writeFileSync(join(root, "untracked.ts"), "x\n");
  const probe = probeWatchMembership(root);
  expect(probe?.dirty).toBe(true);
});

test("probeWatchMembership: dirty (tracked + modified) → dirty:true", () => {
  const root = mkTmpRepoWithUpstream();
  writeFileSync(join(root, "seed.txt"), "modified\n");
  const probe = probeWatchMembership(root);
  expect(probe?.dirty).toBe(true);
});

test("probeWatchMembership: ahead of upstream by 2 → ahead:2", () => {
  const root = mkTmpRepoWithUpstream();
  writeFileSync(join(root, "a.ts"), "a\n");
  gitCommitSimple(root, "a");
  writeFileSync(join(root, "b.ts"), "b\n");
  gitCommitSimple(root, "b");
  expect(probeWatchMembership(root)).toEqual({ dirty: false, ahead: 2 });
});

test("probeWatchMembership: no upstream → ahead:0 (no `# branch.ab` line)", () => {
  const root = mkTmpWorktree();
  gitInit(root);
  writeFileSync(join(root, "x.ts"), "seed\n");
  gitCommitSimple(root, "seed");
  expect(probeWatchMembership(root)).toEqual({ dirty: false, ahead: 0 });
});

test("probeWatchMembership: returns null on a non-git path (timeout / error)", () => {
  const dir = trackDir(mkdtempSync(join(tmpdir(), "keeper-probe-noegit-")));
  expect(probeWatchMembership(dir)).toBeNull();
});

// ---------------------------------------------------------------------------
// discoverProjectRoots — the real-probe integration cases. The `.keeper`
// short-circuit + memo + fail-open cases run git-free in the main suite; these
// four drive the REAL `probeWatchMembership` git spawn against a real upstream.
// ---------------------------------------------------------------------------

function makeDiscoveryDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    cwd TEXT,
    state TEXT NOT NULL DEFAULT 'stopped',
    updated_at REAL NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE epics (
    epic_id TEXT PRIMARY KEY,
    project_dir TEXT,
    tasks TEXT
  )`);
  return db;
}

test("discoverProjectRoots: dirty non-.keeper repo joins desired set", () => {
  const root = mkTmpRepoWithUpstream();
  writeFileSync(join(root, "untracked.ts"), "x\n");
  const db = makeDiscoveryDb();
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'working', 0)",
    ["sess-a", root],
  );
  const ctx: DiscoveryContext = {
    cwdRootCache: new Map(),
    watchProbeCache: new Map(),
    currentlyWatched: new Set(),
    nowMs: 1000,
    runFullSweep: true,
    probe: probeWatchMembership, // real probe via spawnSync
  };
  expect(discoverProjectRoots(db, ctx)).toContain(root);
  db.close();
});

test("discoverProjectRoots: clean+pushed non-.keeper repo drops out of desired set", () => {
  const root = mkTmpRepoWithUpstream();
  const db = makeDiscoveryDb();
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'working', 0)",
    ["sess-a", root],
  );
  const ctx: DiscoveryContext = {
    cwdRootCache: new Map(),
    watchProbeCache: new Map(),
    currentlyWatched: new Set(),
    nowMs: 1000,
    runFullSweep: true,
    probe: probeWatchMembership,
  };
  expect(discoverProjectRoots(db, ctx)).not.toContain(root);
  db.close();
});

test("discoverProjectRoots: monotonicity — already-watched root retained even when slow sweep is throttled", () => {
  const root = mkTmpRepoWithUpstream();
  writeFileSync(join(root, "untracked.ts"), "x\n");
  const db = makeDiscoveryDb();
  // Job's `updated_at` is way in the past AND state isn't 'working' — fast path
  // would normally exclude it.
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'stopped', 0)",
    ["sess-a", root],
  );
  const ctx: DiscoveryContext = {
    cwdRootCache: new Map(),
    watchProbeCache: new Map(),
    currentlyWatched: new Set([root]),
    nowMs: Date.now(),
    runFullSweep: false,
    probe: probeWatchMembership,
  };
  // Monotonicity floor: still desired despite fast-path skip.
  expect(discoverProjectRoots(db, ctx)).toContain(root);
  db.close();
});

test("discoverProjectRoots: clean+pushed watched root drops from desired (caller layers dwell)", () => {
  const root = mkTmpRepoWithUpstream();
  const db = makeDiscoveryDb();
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'working', 0)",
    ["sess-a", root],
  );
  const ctx: DiscoveryContext = {
    cwdRootCache: new Map(),
    watchProbeCache: new Map(),
    currentlyWatched: new Set([root]),
    nowMs: 1000,
    runFullSweep: true,
    probe: probeWatchMembership,
  };
  // Verdict: clean + pushed + no .keeper → not desired.
  expect(discoverProjectRoots(db, ctx)).not.toContain(root);
  db.close();
});

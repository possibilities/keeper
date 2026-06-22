/**
 * Unit tests for the dep-free `~/docs` Stop-hook pusher (fn-885 `.2`). Real git
 * is never mocked — `pushDocs` spawns `git` directly, so every assertion runs
 * against a real `initRepo` tmp repo wired to a real bare-`origin` fixture. The
 * `initRepo` helper disables gpgsign so seed commits never wedge on a host with
 * global `commit.gpgsign true`.
 *
 * Covered (per the task's test notes):
 *  - pushes when local is ahead of `@{u}` (bare origin's main advances);
 *  - no-op when not ahead and when there is no upstream;
 *  - non-fast-forward → logged to the skip-log + skipped (no rebase, no commit
 *    rewrite; local HEAD unchanged);
 *  - a push failure returns cleanly (no throw — the hook would exit 0);
 *  - a held lockfile prevents a second concurrent push (and logs the skip);
 *  - an orphaned lock (holder pid gone, or older than the staleness threshold) is
 *    reclaimed so a hook-timeout kill never blocks every later push forever.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aheadOfUpstream,
  pushDocs,
} from "../plugins/keeper/plugin/hooks/docs-pusher";
import { initRepo } from "./helpers/git-repo";

let repo: string;
let bare: string;
let logFile: string;

/** Run a git command in `repo` synchronously; throw on a non-zero exit. */
function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

/** Run a git command in an arbitrary dir; throw on a non-zero exit. */
function gitIn(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

function headSha(): string {
  return git("rev-parse", "HEAD").trim();
}

/** A pid that is certainly gone: spawn `true`, wait for it to exit, reuse its
 * pid. `process.kill(pid, 0)` then throws ESRCH, marking the lock reclaimable. */
function findDeadPid(): number {
  const proc = Bun.spawnSync(["true"]);
  return proc.pid ?? 999_999;
}

/** Remote-tracked SHA for the bare origin's main (after the local fetched it). */
function originMainSha(): string {
  return gitIn(bare, "rev-parse", "main").trim();
}

/** Create + commit a new doc in `repo`. */
function addDoc(name: string, body: string): void {
  writeFileSync(join(repo, name), body);
  git("add", "--", name);
  git("commit", "-q", "-m", `add ${name}`);
}

/** Wire a bare repo as `origin`; optionally set upstream by pushing main. */
function addBareOrigin(setUpstream: boolean): string {
  const b = realpathSync(mkdtempSync(join(tmpdir(), "keeper-docpush-bare-")));
  Bun.spawnSync(["git", "init", "-q", "--bare", b]);
  git("remote", "add", "origin", b);
  if (setUpstream) {
    git("push", "-q", "-u", "origin", "main");
  }
  return b;
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-docs-pusher-")));
  initRepo(repo);
  writeFileSync(join(repo, "seed.md"), "# seed\n");
  git("add", "--", "seed.md");
  git("commit", "-q", "-m", "init");
  logFile = join(repo, "skip.log");
  process.env.KEEPER_DOCS_PUSH_LOG = logFile;
});

afterEach(() => {
  delete process.env.KEEPER_DOCS_PUSH_LOG;
  rmSync(repo, { recursive: true, force: true });
  if (bare) {
    rmSync(bare, { recursive: true, force: true });
    bare = "";
  }
});

describe("pushDocs", () => {
  test("pushes when local is ahead of @{u}", () => {
    bare = addBareOrigin(true);
    addDoc("note.md", "# note\n");
    const localHead = headSha();
    expect(aheadOfUpstream(repo)).toBe(1);

    expect(pushDocs(repo)).toBe("pushed");
    // The bare origin's main now points at the local HEAD.
    expect(originMainSha()).toBe(localHead);
    expect(aheadOfUpstream(repo)).toBe(0);
  });

  test("no-op when not ahead", () => {
    bare = addBareOrigin(true);
    // Upstream set with main pushed; no new local commits → 0 ahead.
    expect(aheadOfUpstream(repo)).toBe(0);
    expect(pushDocs(repo)).toBe("not-ahead");
  });

  test("no-op when there is no upstream", () => {
    bare = addBareOrigin(false);
    addDoc("note.md", "# note\n");
    // Remote exists but the branch has no upstream tracking ref.
    expect(aheadOfUpstream(repo)).toBeNull();
    expect(pushDocs(repo)).toBe("no-upstream");
  });

  test("non-fast-forward is logged and skipped (no rebase, HEAD unchanged)", () => {
    bare = addBareOrigin(true);
    // Advance the bare origin's main from a SECOND clone so our local is now
    // behind+diverged: a local commit then makes the push a non-fast-forward.
    const other = realpathSync(
      mkdtempSync(join(tmpdir(), "keeper-docpush-other-")),
    );
    gitIn(other, "clone", "-q", bare, ".");
    gitIn(other, "config", "user.email", "test@example.com");
    gitIn(other, "config", "user.name", "Test");
    gitIn(other, "config", "commit.gpgsign", "false");
    writeFileSync(join(other, "remote.md"), "# from other\n");
    gitIn(other, "add", "--", "remote.md");
    gitIn(other, "commit", "-q", "-m", "remote advance");
    gitIn(other, "push", "-q", "origin", "main");
    rmSync(other, { recursive: true, force: true });

    // Local makes its own divergent commit — ahead of its (now-stale) @{u}.
    addDoc("local.md", "# local\n");
    const localHead = headSha();

    expect(pushDocs(repo)).toBe("push-failed");
    // Local HEAD is untouched (no rebase, no force) and the skip-log captured it.
    expect(headSha()).toBe(localHead);
    expect(existsSync(logFile)).toBe(true);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("push-skipped");
    expect(log).toContain("non_fast_forward");
  });

  test("push failure (unreachable remote) returns push-failed, never throws", () => {
    // Wire origin to a bare repo (so @{u} resolves and we are ahead), then DELETE
    // the bare so the actual push fails hard — exercising the log+skip arm.
    bare = addBareOrigin(true);
    addDoc("note.md", "# note\n");
    expect(aheadOfUpstream(repo)).toBe(1);
    rmSync(bare, { recursive: true, force: true });
    bare = "";

    let outcome = "";
    expect(() => {
      outcome = pushDocs(repo);
    }).not.toThrow();
    expect(outcome).toBe("push-failed");
    expect(existsSync(logFile)).toBe(true);
  });

  test("a live, fresh lockfile prevents a second push and logs the skip", () => {
    bare = addBareOrigin(true);
    addDoc("note.md", "# note\n");
    // Pre-create the lockfile stamped with THIS (live) pid to simulate a
    // concurrent session holding it — a live holder must still block.
    const gitDir = git("rev-parse", "--git-dir").trim();
    const lockPath = join(repo, gitDir, "keeper-push.lock");
    writeFileSync(lockPath, `${process.pid}\n`);

    expect(pushDocs(repo)).toBe("locked");
    // Nothing was pushed — origin still at its initial main.
    expect(aheadOfUpstream(repo)).toBe(1);
    // The skip is visible in the skip-log so a stuck lock is diagnosable.
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("class=locked");
  });

  test("an orphaned lock (holder pid gone) is reclaimed and the push proceeds", () => {
    bare = addBareOrigin(true);
    addDoc("note.md", "# note\n");
    const localHead = headSha();
    const gitDir = git("rev-parse", "--git-dir").trim();
    const lockPath = join(repo, gitDir, "keeper-push.lock");
    // Stamp the lock with a pid that is certainly gone. process.kill(pid, 0)
    // throws ESRCH for a non-existent pid → reclaimable even within the window.
    writeFileSync(lockPath, `${findDeadPid()}\n`);

    expect(pushDocs(repo)).toBe("pushed");
    expect(originMainSha()).toBe(localHead);
    // The reclaimed-then-acquired lock is released after the push completes.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("an orphaned lock older than the staleness threshold is reclaimed", () => {
    bare = addBareOrigin(true);
    addDoc("note.md", "# note\n");
    const localHead = headSha();
    const gitDir = git("rev-parse", "--git-dir").trim();
    const lockPath = join(repo, gitDir, "keeper-push.lock");
    // Stamp with THIS live pid (liveness check alone would NOT reclaim) but
    // backdate the mtime well past the >60s staleness threshold.
    writeFileSync(lockPath, `${process.pid}\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    expect(pushDocs(repo)).toBe("pushed");
    expect(originMainSha()).toBe(localHead);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("released lockfile allows the next push", () => {
    bare = addBareOrigin(true);
    addDoc("note.md", "# note\n");
    // First push acquires + releases the lock cleanly.
    expect(pushDocs(repo)).toBe("pushed");
    const gitDir = git("rev-parse", "--git-dir").trim();
    const lockPath = join(repo, gitDir, "keeper-push.lock");
    expect(existsSync(lockPath)).toBe(false);
    // A second turn with new work pushes again (lock was released).
    addDoc("note2.md", "# note2\n");
    expect(pushDocs(repo)).toBe("pushed");
  });
});

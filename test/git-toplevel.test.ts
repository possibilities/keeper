/**
 * fn-978 — `memoizedNullableGitToplevel`, the nullable per-cycle toplevel resolver
 * that drives the worktree lane geometry's repo classification.
 *
 * Real-git-FREE: the resolver's one `git rev-parse --show-toplevel` spawn is
 * intercepted by a STRICTLY-SCOPED spy over the Bun spawn-sync global (installed +
 * restored inside one synchronous test body via {@link withSpawnSpy}, so it never
 * leaks across an await boundary into a concurrent file). The lint-no-real-git
 * guard only flags a literal git-array spawn call, which this file never writes —
 * the real `git` binary is never invoked.
 */

import { expect, test } from "bun:test";

import { memoizedNullableGitToplevel } from "../src/git-toplevel";

interface SpawnRecord {
  argvs: string[][];
  envs: (Record<string, string | undefined> | undefined)[];
}

/**
 * Run `fn` with `Bun.spawnSync` replaced by a fake that maps a `git -C <path>`
 * invocation to a synthetic toplevel (`toplevelFor(path)` → the resolved root, or
 * `null` for a non-repo / failure) and records every argv + env. Restored in a
 * `finally`, so the spy lives ONLY for the synchronous body — no global leak.
 */
function withSpawnSpy<T>(
  toplevelFor: (path: string) => string | null,
  fn: (rec: SpawnRecord) => T,
): T {
  const rec: SpawnRecord = { argvs: [], envs: [] };
  const real = Bun.spawnSync;
  // @ts-expect-error — spy over the Bun global for a real-git-free unit test.
  Bun.spawnSync = (
    argv: string[],
    opts?: { env?: Record<string, string | undefined> },
  ) => {
    rec.argvs.push(argv);
    rec.envs.push(opts?.env);
    const dashC = argv.indexOf("-C");
    const path = dashC >= 0 ? (argv[dashC + 1] ?? "") : "";
    const top = toplevelFor(path);
    return top === null
      ? {
          success: false,
          exitCode: 128,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
        }
      : {
          success: true,
          exitCode: 0,
          stdout: Buffer.from(`${top}\n`),
          stderr: Buffer.from(""),
        };
  };
  try {
    return fn(rec);
  } finally {
    Bun.spawnSync = real;
  }
}

test("memoizedNullableGitToplevel: empty input → null WITHOUT spawning", () => {
  withSpawnSpy(
    () => "/should-not-be-reached",
    (rec) => {
      const resolve = memoizedNullableGitToplevel();
      expect(resolve("")).toBeNull();
      // Short-circuited before any git spawn (a `git -C "" rev-parse` would
      // resolve against the daemon's own cwd).
      expect(rec.argvs.length).toBe(0);
    },
  );
});

test("memoizedNullableGitToplevel: a non-repo resolves to null — NO raw fallback", () => {
  withSpawnSpy(
    () => null,
    () => {
      const resolve = memoizedNullableGitToplevel();
      // null, NOT the raw "/not/a/repo" (the distinguishing behavior vs the
      // `?? root` fallback in `memoizedGitToplevel`).
      expect(resolve("/not/a/repo")).toBeNull();
    },
  );
});

test("memoizedNullableGitToplevel: caches null per build (no double-spawn)", () => {
  withSpawnSpy(
    () => null,
    (rec) => {
      const resolve = memoizedNullableGitToplevel();
      expect(resolve("/sub")).toBeNull();
      expect(resolve("/sub")).toBeNull();
      // The null resolve is cached WITHIN the build — spawned exactly once.
      expect(rec.argvs.length).toBe(1);
    },
  );
});

test("memoizedNullableGitToplevel: resolves a subdir to its toplevel, caches the hit, mirrors --show-toplevel", () => {
  withSpawnSpy(
    (p) => (p.startsWith("/repo") ? "/repo" : null),
    (rec) => {
      const resolve = memoizedNullableGitToplevel();
      expect(resolve("/repo/packages/app")).toBe("/repo");
      // Second call is served from the cache (no re-spawn).
      expect(resolve("/repo/packages/app")).toBe("/repo");
      expect(rec.argvs.length).toBe(1);
      // Mirrors `git rev-parse --show-toplevel` — NOT `--git-common-dir`.
      expect(rec.argvs[0]).toContain("rev-parse");
      expect(rec.argvs[0]).toContain("--show-toplevel");
      expect(rec.argvs[0]).not.toContain("--git-common-dir");
    },
  );
});

test("memoizedNullableGitToplevel: distinct roots cache independently", () => {
  withSpawnSpy(
    (p) => (p === "/a" ? "/a-top" : p === "/b" ? "/b-top" : null),
    (rec) => {
      const resolve = memoizedNullableGitToplevel();
      expect(resolve("/a")).toBe("/a-top");
      expect(resolve("/b")).toBe("/b-top");
      expect(resolve("/a")).toBe("/a-top"); // cached
      expect(rec.argvs.length).toBe(2); // /a + /b spawned once each
    },
  );
});

test("resolveGitToplevel strips GIT_DIR/GIT_WORK_TREE from the spawn env (poison guard), keeps PATH", () => {
  const prevDir = process.env.GIT_DIR;
  const prevWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = "/elsewhere/.git";
  process.env.GIT_WORK_TREE = "/elsewhere";
  try {
    withSpawnSpy(
      () => "/repo",
      (rec) => {
        const resolve = memoizedNullableGitToplevel();
        resolve("/repo");
        const env = rec.envs[0];
        // An inherited GIT_DIR/GIT_WORK_TREE would make `-C <path>` resolve
        // against the pointed-at worktree — stripped so `--show-toplevel` honors
        // the `-C` path only.
        expect(env?.GIT_DIR).toBeUndefined();
        expect(env?.GIT_WORK_TREE).toBeUndefined();
        expect(env?.GIT_INDEX_FILE).toBeUndefined();
        expect(env?.GIT_COMMON_DIR).toBeUndefined();
        // The rest of the env (PATH et al.) is preserved.
        expect(env?.PATH).toBe(process.env.PATH);
      },
    );
  } finally {
    if (prevDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prevDir;
    if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = prevWorkTree;
  }
});

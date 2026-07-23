// Pure, in-process tests for the dep-free structural-locking leaf: the git runner, the flock
// acquirer, and the path canonicalizer are ALL injected, so these exercise the lock ORDER, the
// reverse release, the release-failure surfacing, token unforgeability, and canonical identity
// with no real fs, flock, or subprocess — the git-boundary pure-seam discipline.

import { describe, expect, test } from "bun:test";
import {
  isLockDeferred,
  type PathCanonicalizer,
  type RegistryLockAcquirer,
  type RegistryLockGitRunner,
  resolveCommonDir,
  structuralLockPathFor,
  withCheckoutLock,
  withStructuralLock,
} from "../src/registry-lock";

const COMMON = "/repo/.git";
const COMMON_LOCK = `${COMMON}/keeper-commit-work.lock`;
const WT_LOCK = "/repo/.git/worktrees/lane/keeper-commit-work.lock";

/** The injected canonicalizer for the fake paths (which do not exist on disk): identity, plus
 *  an optional alias map so a symlink/alias test can prove two aliases collapse to one lock. */
function fakeCanon(aliases: Record<string, string> = {}): PathCanonicalizer {
  return async (p) => aliases[p] ?? p;
}
const idCanon = fakeCanon();

/** A run that resolves the common dir to `stdout` (default COMMON), with optional overrides. */
function fakeRun(
  over: { code?: number; stdout?: string } = {},
): RegistryLockGitRunner {
  return async (args) => {
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return {
        code: over.code ?? 0,
        stdout: over.stdout ?? `${COMMON}\n`,
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

interface AcquireLog {
  acquired: string[];
  released: string[];
}

/** An acquirer recording acquire + release ORDER. `timeout` paths return null; `throwAcquire`
 *  paths throw on acquire; `throwRelease` paths push then throw on release. */
function fakeAcquire(
  log: AcquireLog,
  opts: {
    timeout?: Set<string>;
    throwAcquire?: Set<string>;
    throwRelease?: Set<string>;
  } = {},
): RegistryLockAcquirer {
  return (lockPath) => {
    if (opts.throwAcquire?.has(lockPath)) {
      throw new Error(`acquire threw: ${lockPath}`);
    }
    if (opts.timeout?.has(lockPath)) {
      return null;
    }
    log.acquired.push(lockPath);
    return {
      release() {
        log.released.push(lockPath);
        if (opts.throwRelease?.has(lockPath)) {
          throw new Error(`release threw: ${lockPath}`);
        }
      },
    };
  };
}

const deriveWt = async () => WT_LOCK;
const freshLog = (): AcquireLog => ({ acquired: [], released: [] });

describe("registry-lock leaf", () => {
  test("resolveCommonDir: strict + canonical — non-zero / empty / non-absolute / multi-line / uncanonicalizable → null, else canonical", async () => {
    expect(await resolveCommonDir("/repo", fakeRun(), idCanon)).toBe(COMMON);
    expect(
      await resolveCommonDir("/repo", fakeRun({ code: 128 }), idCanon),
    ).toBeNull();
    expect(
      await resolveCommonDir("/repo", fakeRun({ stdout: "\n" }), idCanon),
    ).toBeNull();
    expect(
      await resolveCommonDir(
        "/repo",
        fakeRun({ stdout: "rel/.git\n" }),
        idCanon,
      ),
    ).toBeNull();
    // ambiguous multi-line resolver output → rejected.
    expect(
      await resolveCommonDir(
        "/repo",
        fakeRun({ stdout: "/a/.git\n/b/.git\n" }),
        idCanon,
      ),
    ).toBeNull();
    // canonicalizer returns null (uncanonicalizable / ambiguous) → defer.
    expect(
      await resolveCommonDir("/repo", fakeRun(), async () => null),
    ).toBeNull();
    // a throwing runner → null (never throws).
    const boom: RegistryLockGitRunner = async () => {
      throw new Error("boom");
    };
    expect(await resolveCommonDir("/repo", boom, idCanon)).toBeNull();
  });

  test("resolveCommonDir: CANONICAL identity — two symlink/path aliases collapse to ONE common dir", async () => {
    // Two callers reach the common dir via distinct aliases; the canonicalizer collapses both
    // to the same canonical path, so they serialize on ONE lock.
    const canon = fakeCanon({
      "/alias-a/.git": COMMON,
      "/alias-b/.git": COMMON,
    });
    expect(
      await resolveCommonDir(
        "/x",
        fakeRun({ stdout: "/alias-a/.git\n" }),
        canon,
      ),
    ).toBe(COMMON);
    expect(
      await resolveCommonDir(
        "/y",
        fakeRun({ stdout: "/alias-b/.git\n" }),
        canon,
      ),
    ).toBe(COMMON);
  });

  test("structuralLockPathFor: joins the common dir with the commit-work leaf", () => {
    expect(structuralLockPathFor(COMMON)).toBe(COMMON_LOCK);
  });

  test("withStructuralLock: acquires ONLY the common lock, hands a token carrying the common path, releases it", async () => {
    const log = freshLog();
    let seenPath: string | undefined;
    const r = await withStructuralLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      async (t) => {
        // The token is UNFORGEABLE — tests read only its observable fields, never a brand.
        seenPath = t.commonLockPath;
        return "ok" as const;
      },
      idCanon,
    );
    expect(r).toBe("ok");
    expect(seenPath).toBe(COMMON_LOCK);
    expect(log.acquired).toEqual([COMMON_LOCK]); // NO per-worktree acquire
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withStructuralLock: unresolved common dir or a common-lock timeout → defer, no fn call", async () => {
    let called = false;
    const r1 = await withStructuralLock(
      "/repo",
      fakeRun({ code: 128 }),
      fakeAcquire(freshLog()),
      async () => {
        called = true;
        return 1;
      },
      idCanon,
    );
    expect(isLockDeferred(r1)).toBe(true);
    const log = freshLog();
    const r2 = await withStructuralLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log, { timeout: new Set([COMMON_LOCK]) }),
      async () => {
        called = true;
        return 1;
      },
      idCanon,
    );
    expect(isLockDeferred(r2)).toBe(true);
    expect(called).toBe(false);
    expect(log.acquired).toEqual([]);
  });

  test("withStructuralLock: a throwing fn still releases the common lock and propagates the fn error", async () => {
    const log = freshLog();
    await expect(
      withStructuralLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log),
        async () => {
          throw new Error("fn boom");
        },
        idCanon,
      ),
    ).rejects.toThrow("fn boom");
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withStructuralLock: a THROWING common release SURFACES an operational failure (never a green result)", async () => {
    const log = freshLog();
    // The fn succeeds, but the common release throws — the possibly-held flock must be
    // surfaced as a thrown failure, not swallowed under the green fn result.
    await expect(
      withStructuralLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log, { throwRelease: new Set([COMMON_LOCK]) }),
        async () => "ok" as const,
        idCanon,
      ),
    ).rejects.toThrow(/release/i);
    expect(log.released).toEqual([COMMON_LOCK]); // release WAS attempted
  });

  test("withStructuralLock: a throwing fn AND a throwing release AGGREGATE — the surfaced failure carries BOTH errors", async () => {
    const log = freshLog();
    let err: unknown;
    try {
      await withStructuralLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log, { throwRelease: new Set([COMMON_LOCK]) }),
        async () => {
          throw new Error("fn boom");
        },
        idCanon,
      );
    } catch (e) {
      err = e;
    }
    // The caller observes an AggregateError through the PUBLIC wrapper after reverse-release
    // completes, carrying BOTH the body error and the release error — a possibly-held flock is
    // never masked by the fn failure, nor the fn failure by the release failure.
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(2);
    expect(log.released).toEqual([COMMON_LOCK]); // release attempted despite the fn throw
  });

  test("withCheckoutLock: acquires common THEN per-worktree, releases per THEN common (reverse; no path before common)", async () => {
    const log = freshLog();
    let seenCommon: string | undefined;
    let seenWt: string | undefined;
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      deriveWt,
      async (t) => {
        seenCommon = t.commonLockPath;
        seenWt = t.worktreeLockPath;
        return "ok" as const;
      },
      idCanon,
    );
    expect(r).toBe("ok");
    expect(seenCommon).toBe(COMMON_LOCK);
    expect(seenWt).toBe(WT_LOCK);
    expect(log.acquired).toEqual([COMMON_LOCK, WT_LOCK]); // common FIRST
    expect(log.released).toEqual([WT_LOCK, COMMON_LOCK]); // reverse
  });

  test("withCheckoutLock: per-worktree CANONICAL path == common path (main worktree) → no second acquire", async () => {
    const log = freshLog();
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      async () => COMMON_LOCK, // the canonical worktree identity equals common
      async () => "ok" as const,
      idCanon,
    );
    expect(r).toBe("ok");
    expect(log.acquired).toEqual([COMMON_LOCK]);
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withCheckoutLock: unresolved worktree identity → defer, common released, no per-worktree acquire", async () => {
    const log = freshLog();
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      async () => null,
      async () => "ok",
      idCanon,
    );
    expect(isLockDeferred(r)).toBe(true);
    expect(log.acquired).toEqual([COMMON_LOCK]);
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withCheckoutLock: a per-worktree lock timeout → defer, common still released", async () => {
    const log = freshLog();
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log, { timeout: new Set([WT_LOCK]) }),
      deriveWt,
      async () => "ok",
      idCanon,
    );
    expect(isLockDeferred(r)).toBe(true);
    expect(log.acquired).toEqual([COMMON_LOCK]);
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withCheckoutLock: a THROWING per-worktree acquire still releases the common lock and propagates (no leak)", async () => {
    const log = freshLog();
    await expect(
      withCheckoutLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log, { throwAcquire: new Set([WT_LOCK]) }),
        deriveWt,
        async () => "ok",
        idCanon,
      ),
    ).rejects.toThrow("acquire threw");
    expect(log.acquired).toEqual([COMMON_LOCK]);
    expect(log.released).toEqual([COMMON_LOCK]); // common freed despite the throw
  });

  test("withCheckoutLock: a THROWING per-worktree release SURFACES the failure, having attempted BOTH releases", async () => {
    const log = freshLog();
    // The fn succeeds, per-worktree release throws — surfaced (never a green result), and the
    // common release is STILL attempted afterward.
    await expect(
      withCheckoutLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log, { throwRelease: new Set([WT_LOCK]) }),
        deriveWt,
        async () => "ok" as const,
        idCanon,
      ),
    ).rejects.toThrow(/release/i);
    expect(log.released).toContain(WT_LOCK);
    expect(log.released).toContain(COMMON_LOCK); // common release attempted after per-worktree threw
  });

  test("withCheckoutLock: a THROWING common release SURFACES the failure after per-worktree released cleanly", async () => {
    const log = freshLog();
    await expect(
      withCheckoutLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log, { throwRelease: new Set([COMMON_LOCK]) }),
        deriveWt,
        async () => "ok" as const,
        idCanon,
      ),
    ).rejects.toThrow(/release/i);
    expect(log.released).toEqual([WT_LOCK, COMMON_LOCK]); // both attempted, reverse order
  });

  test("withCheckoutLock: a throwing fn still releases per-worktree AND common, propagating the fn error", async () => {
    const log = freshLog();
    await expect(
      withCheckoutLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log),
        deriveWt,
        async () => {
          throw new Error("fn boom");
        },
        idCanon,
      ),
    ).rejects.toThrow("fn boom");
    expect(log.released).toEqual([WT_LOCK, COMMON_LOCK]);
  });

  test("isLockDeferred: a { defer } is deferred; a { kind } effect result is NOT", () => {
    expect(isLockDeferred({ defer: "x" })).toBe(true);
    expect(isLockDeferred({ kind: "defer", reason: "x" })).toBe(false);
    expect(isLockDeferred({ kind: "integrated" })).toBe(false);
    expect(isLockDeferred("ok")).toBe(false);
    expect(isLockDeferred(null)).toBe(false);
  });
});

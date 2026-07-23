// Pure, in-process tests for the dep-free structural-locking leaf: the git runner and the
// flock acquirer are BOTH injected, so these exercise the lock ORDER, the reverse release,
// and the exception-safety (a throwing second acquire / release still frees common) with no
// real fs, flock, or subprocess — the git-boundary pure-seam discipline.

import { describe, expect, test } from "bun:test";
import {
  type CheckoutToken,
  isLockDeferred,
  type RegistryLockAcquirer,
  type RegistryLockGitRunner,
  resolveCommonDir,
  type StructuralToken,
  structuralLockPathFor,
  withCheckoutLock,
  withStructuralLock,
} from "../src/registry-lock";

const COMMON = "/repo/.git";
const COMMON_LOCK = `${COMMON}/keeper-commit-work.lock`;
const WT_LOCK = "/repo/.git/worktrees/lane/keeper-commit-work.lock";

/** A run that resolves the common dir to COMMON, with an optional non-zero / empty /
 *  non-absolute override for the strict-null cases. */
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
  test("resolveCommonDir: strict — non-zero / empty / non-absolute / thrown → null, else resolved absolute", async () => {
    expect(await resolveCommonDir("/repo", fakeRun())).toBe(COMMON);
    expect(await resolveCommonDir("/repo", fakeRun({ code: 128 }))).toBeNull();
    expect(
      await resolveCommonDir("/repo", fakeRun({ stdout: "\n" })),
    ).toBeNull();
    expect(
      await resolveCommonDir("/repo", fakeRun({ stdout: "relative/.git\n" })),
    ).toBeNull();
    const boom: RegistryLockGitRunner = async () => {
      throw new Error("boom");
    };
    expect(await resolveCommonDir("/repo", boom)).toBeNull();
  });

  test("structuralLockPathFor: joins the common dir with the commit-work leaf", () => {
    expect(structuralLockPathFor(COMMON)).toBe(COMMON_LOCK);
  });

  test("withStructuralLock: acquires ONLY the common lock, hands a structural token, releases it", async () => {
    const log = freshLog();
    const captured: StructuralToken[] = [];
    const r = await withStructuralLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      async (t) => {
        captured.push(t);
        return "ok" as const;
      },
    );
    expect(r).toBe("ok");
    expect(captured[0]?.__t).toBe("structural");
    expect(captured[0]?.commonLockPath).toBe(COMMON_LOCK);
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
    );
    expect(isLockDeferred(r2)).toBe(true);
    expect(called).toBe(false);
    expect(log.acquired).toEqual([]);
  });

  test("withStructuralLock: a throwing fn still releases the common lock", async () => {
    const log = freshLog();
    await expect(
      withStructuralLock("/repo", fakeRun(), fakeAcquire(log), async () => {
        throw new Error("fn boom");
      }),
    ).rejects.toThrow("fn boom");
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withCheckoutLock: acquires common THEN per-worktree, releases per THEN common (reverse; no path before common)", async () => {
    const log = freshLog();
    const captured: CheckoutToken[] = [];
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      deriveWt,
      async (t) => {
        captured.push(t);
        return "ok" as const;
      },
    );
    expect(r).toBe("ok");
    expect(captured[0]?.__t).toBe("checkout");
    expect(captured[0]?.commonLockPath).toBe(COMMON_LOCK);
    expect(captured[0]?.worktreeLockPath).toBe(WT_LOCK);
    expect(log.acquired).toEqual([COMMON_LOCK, WT_LOCK]); // common FIRST
    expect(log.released).toEqual([WT_LOCK, COMMON_LOCK]); // reverse
  });

  test("withCheckoutLock: per-worktree path == common path (main worktree) → no second acquire", async () => {
    const log = freshLog();
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log),
      async () => COMMON_LOCK,
      async () => "ok" as const,
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
    );
    expect(isLockDeferred(r)).toBe(true);
    expect(log.acquired).toEqual([COMMON_LOCK]);
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withCheckoutLock: a THROWING per-worktree acquire still releases the common lock (no leak)", async () => {
    const log = freshLog();
    await expect(
      withCheckoutLock(
        "/repo",
        fakeRun(),
        fakeAcquire(log, { throwAcquire: new Set([WT_LOCK]) }),
        deriveWt,
        async () => "ok",
      ),
    ).rejects.toThrow("acquire threw");
    expect(log.acquired).toEqual([COMMON_LOCK]);
    expect(log.released).toEqual([COMMON_LOCK]);
  });

  test("withCheckoutLock: a THROWING per-worktree release still releases the common lock", async () => {
    const log = freshLog();
    const r = await withCheckoutLock(
      "/repo",
      fakeRun(),
      fakeAcquire(log, { throwRelease: new Set([WT_LOCK]) }),
      deriveWt,
      async () => "ok" as const,
    );
    expect(r).toBe("ok");
    expect(log.released).toContain(WT_LOCK);
    expect(log.released).toContain(COMMON_LOCK);
  });

  test("withCheckoutLock: a throwing fn still releases per-worktree AND common", async () => {
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

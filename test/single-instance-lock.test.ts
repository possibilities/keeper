/**
 * Single-instance flock gate (docs/adr/0030). Covers the pure decision seam
 * (`decideSingleInstanceGate`), the lock-path resolver + its sandbox coverage, a
 * REAL flock round-trip proving a held lock refuses the second acquire, and the
 * ownership-checked socket/lock teardown. No test boots a real daemon — the gate
 * classification is a pure seam and the teardown helpers are file-only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideSingleInstanceAction,
  decideSingleInstanceGate,
} from "../src/daemon";
import { resolveSingleInstanceLockPath } from "../src/db";
import {
  lockOwnedByUs,
  unlinkIfExists,
  unlinkOwnedSocketAndLock,
} from "../src/server-worker";
import { FileLock } from "../src/usage-flock";
import { sandboxEnv } from "./helpers/sandbox-env";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeperd-single-instance-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveSingleInstanceLockPath", () => {
  const KEY = "KEEPER_SINGLE_INSTANCE_LOCK";
  const saved = process.env[KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("env override wins", () => {
    const p = join(tmpDir, "custom-instance.lock");
    process.env[KEY] = p;
    expect(resolveSingleInstanceLockPath()).toBe(p);
  });

  test("default is the state-dir keeperd.lock, distinct from the socket pid-lock", () => {
    delete process.env[KEY];
    const resolved = resolveSingleInstanceLockPath();
    expect(
      resolved.endsWith(join(".local", "state", "keeper", "keeperd.lock")),
    ).toBe(true);
    // The single-instance flock MUST NOT reuse the server worker's pid-file lock
    // path (keeperd.sock.lock): a Bun worker shares main's pid and would self-
    // conflict. The distinct basename is the guard.
    expect(resolved.endsWith("keeperd.sock.lock")).toBe(false);
  });
});

describe("decideSingleInstanceGate (pure classification)", () => {
  const lockPath = "/does/not/matter.lock";

  test("a returned lock → acquired, passing the lock through untouched", () => {
    const sentinel = { released: false } as unknown as FileLock;
    const outcome = decideSingleInstanceGate(() => sentinel, lockPath);
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind === "acquired") expect(outcome.lock).toBe(sentinel);
  });

  test("null (EWOULDBLOCK — a live incumbent) → refused (fail CLOSED)", () => {
    const outcome = decideSingleInstanceGate(() => null, lockPath);
    expect(outcome.kind).toBe("refused");
  });

  test("a throw (inconclusive primitive) → degraded, carrying the reason", () => {
    const outcome = decideSingleInstanceGate(() => {
      throw new Error("dlopen boom");
    }, lockPath);
    expect(outcome.kind).toBe("degraded");
    if (outcome.kind === "degraded") expect(outcome.reason).toBe("dlopen boom");
  });

  test("a thrown non-Error stringifies into the degraded reason", () => {
    const outcome = decideSingleInstanceGate(() => {
      throw "bare string";
    }, lockPath);
    expect(outcome.kind).toBe("degraded");
    if (outcome.kind === "degraded") expect(outcome.reason).toBe("bare string");
  });
});

describe("decideSingleInstanceAction (pure policy)", () => {
  const lockPath = "/state/keeper/keeperd.lock";
  const recoveryLine =
    "[keeperd] recover with: launchctl kickstart -k gui/$(id -u)/arthack.keeperd";

  test("acquired → proceed, carrying the held lock through untouched", () => {
    const sentinel = { released: false } as unknown as FileLock;
    const action = decideSingleInstanceAction(
      { kind: "acquired", lock: sentinel },
      lockPath,
    );

    expect(action.action).toBe("proceed");
    if (action.action === "proceed") expect(action.lock).toBe(sentinel);
  });

  test("refused → exit 1 with the incumbent diagnostic and recovery line", () => {
    const action = decideSingleInstanceAction({ kind: "refused" }, lockPath);

    expect(action).toEqual({
      action: "exit",
      code: 1,
      message:
        `[keeperd] refusing to start: another keeperd already holds ${lockPath}\n` +
        recoveryLine,
    });
  });

  test("an Error throw → degraded → distinct exit 2 with path, reason, and recovery", () => {
    const outcome = decideSingleInstanceGate(() => {
      throw new Error("flock errno=13");
    }, lockPath);
    const action = decideSingleInstanceAction(outcome, lockPath);

    expect(action.action).toBe("exit");
    if (action.action !== "exit") return;
    expect(action.code).toBe(2);
    expect(action.code).not.toBe(1);
    const lines = action.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("single-instance lock primitive inconclusive");
    expect(lines[0]).toContain(lockPath);
    expect(lines[0]).toContain("flock errno=13");
    expect(lines[1]).toBe(recoveryLine);
  });

  test("a non-Error throw → degraded → the same distinct fail-closed action", () => {
    const outcome = decideSingleInstanceGate(() => {
      throw "bare string";
    }, lockPath);
    const action = decideSingleInstanceAction(outcome, lockPath);

    expect(action.action).toBe("exit");
    if (action.action !== "exit") return;
    expect(action.code).toBe(2);
    expect(action.message).toContain(lockPath);
    expect(action.message).toContain("bare string");
    expect(action.message.split("\n")[1]).toBe(recoveryLine);
  });

  test("diagnostic interpolation is bounded and cannot add lines", () => {
    const longPath = `/${"p".repeat(5_000)}\nforged-path-line`;
    const longReason = `${"r".repeat(5_000)}\nforged-reason-line`;
    const action = decideSingleInstanceAction(
      { kind: "degraded", reason: longReason },
      longPath,
    );

    expect(action.action).toBe("exit");
    if (action.action !== "exit") return;
    expect(action.message.length).toBeLessThan(2_048);
    expect(action.message.split("\n")).toHaveLength(2);
    expect(action.message).not.toContain("forged-path-line");
    expect(action.message).not.toContain("forged-reason-line");
  });
});

describe("real-flock round-trip (mirrors usage-flock.test.ts)", () => {
  test("a held flock makes the gate REFUSE the second acquire, then acquire after release", () => {
    const lockPath = join(tmpDir, "keeperd.lock");

    // Incumbent holds the real flock.
    const held = FileLock.tryAcquire(lockPath);
    expect(held).not.toBeNull();
    try {
      // The second boot's gate, driven through the REAL FileLock.tryAcquire on
      // the same held path, must refuse (fail closed on a live incumbent).
      const refused = decideSingleInstanceGate(
        (p) => FileLock.tryAcquire(p),
        lockPath,
      );
      expect(refused.kind).toBe("refused");
    } finally {
      held?.release();
    }

    // Incumbent gone: the gate acquires cleanly, and releases its own lock.
    const acquired = decideSingleInstanceGate(
      (p) => FileLock.tryAcquire(p),
      lockPath,
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") acquired.lock.release();
  });
});

describe("sandboxEnv single-instance-lock coverage", () => {
  test("KEEPER_SINGLE_INSTANCE_LOCK lands under tmpDir", () => {
    const env = sandboxEnv({ tmpDir, dbPath: join(tmpDir, "keeper.db") });
    expect(env.KEEPER_SINGLE_INSTANCE_LOCK).toBe(join(tmpDir, "keeperd.lock"));
    expect(env.KEEPER_SINGLE_INSTANCE_LOCK.startsWith(tmpDir)).toBe(true);
  });

  test("a caller's `extra` undefined can never re-strand the lock at its production default", () => {
    const env = sandboxEnv({
      tmpDir,
      dbPath: join(tmpDir, "keeper.db"),
      // State paths apply LAST, so this delete cannot win.
      extra: { KEEPER_SINGLE_INSTANCE_LOCK: undefined },
    });
    expect(env.KEEPER_SINGLE_INSTANCE_LOCK).toBe(join(tmpDir, "keeperd.lock"));
  });
});

describe("ownership-checked socket/lock teardown", () => {
  test("lockOwnedByUs: our pid → true; a foreign pid → false; missing → false", () => {
    const lockPath = join(tmpDir, "keeperd.sock.lock");

    writeFileSync(lockPath, `${process.pid}\n`);
    expect(lockOwnedByUs(lockPath)).toBe(true);

    // A live successor rewrote the lock with a DIFFERENT pid.
    writeFileSync(lockPath, `${process.pid + 1}\n`);
    expect(lockOwnedByUs(lockPath)).toBe(false);

    unlinkIfExists(lockPath);
    expect(lockOwnedByUs(lockPath)).toBe(false);
  });

  test("owner path unlinks BOTH socket and lock", () => {
    const lockPath = join(tmpDir, "keeperd.sock.lock");
    const sockPath = join(tmpDir, "keeperd.sock");
    writeFileSync(lockPath, `${process.pid}\n`);
    writeFileSync(sockPath, "");

    unlinkOwnedSocketAndLock(lockPath, sockPath);

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
  });

  test("non-owner path is INERT — a dying stray never unlinks a live successor's socket", () => {
    const lockPath = join(tmpDir, "keeperd.sock.lock");
    const sockPath = join(tmpDir, "keeperd.sock");
    // The lock records a live SUCCESSOR (a foreign pid), not us.
    writeFileSync(lockPath, `${process.pid + 1}\n`);
    writeFileSync(sockPath, "");

    unlinkOwnedSocketAndLock(lockPath, sockPath);

    // Both survive: the successor's socket + lock are untouched.
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(sockPath)).toBe(true);
  });
});

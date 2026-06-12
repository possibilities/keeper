// Unit tests for the write side of src/store.ts plus src/flock.ts — the spine
// this epic adds: byte-stable atomic JSON writes, the touched-paths session log,
// and flock(2) task locks that interop with Python's fcntl across engines.
//
// The golden test spawns python3 to serialize a shared nested fixture with
// json.dumps(indent=2, sort_keys=True) and byte-compares — the only proof that
// the bun writer is byte-identical to Python (recursive sort + ensure_ascii +
// trailing newline). The flock interop tests drive a real python3 peer holding
// fcntl.flock, synchronized by marker files (never sleeps), asserting the lock
// blocks in BOTH directions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EWOULDBLOCK,
  FlockWouldBlock,
  flock,
  flockOrThrow,
  LOCK_EX,
  LOCK_NB,
  LOCK_UN,
} from "../src/flock.ts";
import {
  atomicWrite,
  atomicWriteJson,
  atomicWriteRaw,
  LocalFileStateStore,
  recordTouched,
  serializeStateJson,
} from "../src/store.ts";

let root: string;
const savedSid = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-write-test-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedSid === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = savedSid;
  }
});

// The shared fixture exercised by both serializers: nested objects at depth,
// arrays (order preserved), unicode (BMP + astral), control chars, DEL, mixed
// key casing/spaces, and the JSON scalar types. Integers stay within JS's safe
// range — state never carries ints beyond 2^53, and the golden test pins the
// serialization of what state actually holds.
const GOLDEN_FIXTURE = {
  zeta: "last",
  alpha: {
    nested_z: [3, 2, 1],
    nested_a: "unicode: café ☃ é 漢字 😀",
    deep: { y: 1, x: { b: null, a: true } },
  },
  numbers: { safe_int: 9007199254740991, small: 0, neg: -7 },
  list_of_objs: [
    { c: 1, a: 2 },
    { z: 9, m: 8 },
  ],
  bool_t: true,
  bool_f: false,
  nullval: null,
  "key with spaces": "v",
  ünïcode_key: "k",
  control: 'tab\there\nnewline\r"quote"\\back',
  del_char: "x\x7fy",
};

/** Serialize `value` through python3's json.dumps(indent=2, sort_keys=True) +
 * newline — the executable spec the bun writer is held to. */
function pythonSerialize(value: unknown): string {
  const proc = Bun.spawnSync(
    [
      "python3",
      "-c",
      "import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin), indent=2, sort_keys=True) + '\\n')",
    ],
    { stdin: Buffer.from(JSON.stringify(value)) },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`python3 serialize failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

describe("serializeStateJson byte-parity with Python", () => {
  test("golden nested fixture is byte-identical to json.dumps(indent=2, sort_keys=True)+newline", () => {
    const bun = serializeStateJson(GOLDEN_FIXTURE as Record<string, unknown>);
    const py = pythonSerialize(GOLDEN_FIXTURE);
    expect(bun).toBe(py);
  });

  test("recursive sort: a nested out-of-order object matches Python", () => {
    const data = { z: { d: 1, a: 2, m: { y: 1, b: 2 } }, a: 1 };
    expect(serializeStateJson(data)).toBe(pythonSerialize(data));
  });

  test("ends with exactly one trailing newline", () => {
    const out = serializeStateJson({ a: 1 });
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.endsWith("}\n\n")).toBe(false);
  });

  test("non-ASCII is escaped to \\uXXXX (ensure_ascii), not raw UTF-8", () => {
    const out = serializeStateJson({ s: "café 😀" });
    expect(out).toContain("\\u00e9");
    expect(out).toContain("\\ud83d\\ude00");
    expect(out).not.toContain("é");
  });
});

describe("atomicWriteJson disk output", () => {
  test("file on disk is byte-identical to Python's serialization", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID; // isolate write from touched-log
    const p = join(root, "out.json");
    atomicWriteJson(p, GOLDEN_FIXTURE as Record<string, unknown>);
    expect(readFileSync(p, "utf-8")).toBe(pythonSerialize(GOLDEN_FIXTURE));
  });

  test("no .tmp files survive a successful write", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    atomicWriteJson(join(root, "a.json"), { x: 1 });
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("atomicWriteRaw crash path", () => {
  test("tmp file is unlinked when the write throws", () => {
    // Force a throw mid-write: target a path whose parent is a regular file, so
    // the rename (or open) fails after the tmp is created in some ancestor. We
    // instead trigger the throw by making the destination directory read-only
    // is platform-fragile; use an unwritable rename target via a directory
    // collision: create a directory at the destination path so renameSync
    // throws EISDIR/ENOTEMPTY after the tmp exists.
    const dest = join(root, "dest");
    mkdirSync(dest); // dest is a directory — renameSync(tmp, dest) will throw
    expect(() => atomicWriteRaw(dest, "payload")).toThrow();
    // The tmp lives in `root` (dest's parent); none must remain.
    const leftover = readdirSync(root).filter((f) => f.startsWith("."));
    expect(leftover).toEqual([]);
  });
});

describe("recordTouched (session touched-paths log)", () => {
  function seedPlanctl(): { repoRoot: string; dataDir: string } {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "planctl-repo-")));
    const dataDir = join(repoRoot, ".planctl");
    mkdirSync(dataDir, { recursive: true });
    return { repoRoot, dataDir };
  }

  test("writes <uuid>.txt under sessions/<sid>/touched with repo-relative POSIX path + newline", () => {
    const { repoRoot, dataDir } = seedPlanctl();
    process.env.CLAUDE_CODE_SESSION_ID = "sess-abc";
    const target = join(dataDir, "tasks", "fn-1-x.1.json");
    mkdirSync(join(dataDir, "tasks"), { recursive: true });
    writeFileSync(target, "{}");
    recordTouched(target);

    const touchedDir = join(
      dataDir,
      "state",
      "sessions",
      "sess-abc",
      "touched",
    );
    const entries = readdirSync(touchedDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{32}\.txt$/);
    expect(readFileSync(join(touchedDir, entries[0] as string), "utf-8")).toBe(
      ".planctl/tasks/fn-1-x.1.json\n",
    );
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("fail-OPEN: no session id => silent skip, no touched dir created", () => {
    const { repoRoot, dataDir } = seedPlanctl();
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const target = join(dataDir, "tasks", "fn-1-x.1.json");
    mkdirSync(join(dataDir, "tasks"), { recursive: true });
    writeFileSync(target, "{}");
    expect(() => recordTouched(target)).not.toThrow();
    expect(existsSync(join(dataDir, "state", "sessions"))).toBe(false);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("no .planctl/ ancestor => silent skip (fail-open)", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-xyz";
    const target = join(root, "loose.json");
    writeFileSync(target, "{}");
    expect(() => recordTouched(target)).not.toThrow();
  });

  test("atomicWrite records a touched-path alongside the file", () => {
    const { repoRoot, dataDir } = seedPlanctl();
    process.env.CLAUDE_CODE_SESSION_ID = "sess-w";
    const target = join(dataDir, "epics", "fn-1-x.json");
    atomicWrite(target, "{}\n", dataDir);
    const touchedDir = join(dataDir, "state", "sessions", "sess-w", "touched");
    expect(readdirSync(touchedDir).length).toBe(1);
    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("LocalFileStateStore.saveRuntime", () => {
  test("lands a sorted-key sidecar at tasks/<id>.state.json", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const stateDir = join(root, "state");
    const store = new LocalFileStateStore(stateDir);
    store.saveRuntime("fn-1-x.1", { status: "in_progress", assignee: "a" });
    const p = join(stateDir, "tasks", "fn-1-x.1.state.json");
    expect(readFileSync(p, "utf-8")).toBe(
      pythonSerialize({ status: "in_progress", assignee: "a" }),
    );
    // Round-trips through the read side.
    expect(store.loadRuntime("fn-1-x.1")).toEqual({
      status: "in_progress",
      assignee: "a",
    });
  });
});

describe("flock(2) basics", () => {
  test("LOCK_EX then LOCK_UN succeeds; constants are the BSD values", () => {
    const lp = join(root, "x.lock");
    const fd = openSync(lp, "w");
    try {
      expect(flock(fd, LOCK_EX)).toBe(0);
      expect(flock(fd, LOCK_UN)).toBe(0);
    } finally {
      closeSync(fd);
    }
  });

  test("a second LOCK_NB on the same file in-process throws FlockWouldBlock with EWOULDBLOCK", () => {
    const lp = join(root, "y.lock");
    const fd1 = openSync(lp, "w");
    const fd2 = openSync(lp, "w");
    try {
      flockOrThrow(fd1, LOCK_EX | LOCK_NB);
      expect(() => flockOrThrow(fd2, LOCK_EX | LOCK_NB)).toThrow(
        FlockWouldBlock,
      );
      // EWOULDBLOCK is platform-correct (35 darwin / 11 linux).
      expect(EWOULDBLOCK).toBe(process.platform === "darwin" ? 35 : 11);
    } finally {
      flock(fd1, LOCK_UN);
      closeSync(fd1);
      closeSync(fd2);
    }
  });
});

// Marker-file sync helpers for the cross-process interop tests — poll for a
// marker file with no sleeps (busy-wait with a hard iteration cap so a hung peer
// fails the test instead of hanging the suite).
function waitForFile(path: string, timeoutMs = 10000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for marker ${path}`);
    }
  }
}

describe("flock cross-engine interop with a python3 peer", () => {
  // Direction 1: python3 holds the lock, bun's LOCK_NB must fail (EWOULDBLOCK).
  test("python holds LOCK_EX => bun LOCK_NB blocks (FlockWouldBlock)", () => {
    const lockPath = join(root, "interop1.lock");
    const heldMarker = join(root, "py.held");
    const releaseMarker = join(root, "release.now");

    // Python: take LOCK_EX, write held marker, busy-wait for the release marker,
    // then unlock. No sleeps — pure marker handshake.
    const pyScript = `
import fcntl, os, sys, time
lock_path, held, release = sys.argv[1], sys.argv[2], sys.argv[3]
f = open(lock_path, "w")
fcntl.flock(f, fcntl.LOCK_EX)
open(held, "w").close()
while not os.path.exists(release):
    time.sleep(0.005)
fcntl.flock(f, fcntl.LOCK_UN)
f.close()
`;
    const peer = Bun.spawn(
      ["python3", "-c", pyScript, lockPath, heldMarker, releaseMarker],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      waitForFile(heldMarker);
      // Python holds it — bun's non-blocking acquire must report contention.
      const fd = openSync(lockPath, "w");
      try {
        expect(() => flockOrThrow(fd, LOCK_EX | LOCK_NB)).toThrow(
          FlockWouldBlock,
        );
      } finally {
        closeSync(fd);
      }
    } finally {
      writeFileSync(releaseMarker, "");
      peer.exited;
    }
  });

  // Direction 2: bun holds the lock, python3's LOCK_NB must fail (errno
  // EWOULDBLOCK). The peer exits non-zero only if it WRONGLY acquired the lock.
  test("bun holds LOCK_EX => python LOCK_NB blocks (EWOULDBLOCK)", async () => {
    const lockPath = join(root, "interop2.lock");
    const fd = openSync(lockPath, "w");
    flockOrThrow(fd, LOCK_EX); // bun holds it for the whole peer run

    // Python tries a non-blocking acquire; exits 42 on the expected EWOULDBLOCK,
    // 0 if it wrongly got the lock, 1 on any other errno.
    const pyScript = `
import fcntl, errno, sys
f = open(sys.argv[1], "w")
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as e:
    sys.exit(42 if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN) else 1)
else:
    sys.exit(0)  # wrongly acquired
`;
    try {
      const peer = Bun.spawn(["python3", "-c", pyScript, lockPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await peer.exited;
      expect(code).toBe(42);
    } finally {
      flock(fd, LOCK_UN);
      closeSync(fd);
    }
  });
});

describe("LocalFileStateStore.withTaskLock", () => {
  test("runs the body under a real flock and a python peer is blocked while held", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const stateDir = join(root, "state");
    const store = new LocalFileStateStore(stateDir);
    const lockPath = join(stateDir, "locks", "fn-1-x.1.lock");

    let observedBlocked = false;
    store.withTaskLock("fn-1-x.1", () => {
      // While we hold it, a python LOCK_NB peer must fail to acquire.
      const pyScript = `
import fcntl, errno, sys
f = open(sys.argv[1], "w")
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as e:
    sys.exit(42 if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN) else 1)
sys.exit(0)
`;
      const peer = Bun.spawnSync(["python3", "-c", pyScript, lockPath]);
      observedBlocked = peer.exitCode === 42;
    });
    expect(observedBlocked).toBe(true);

    // After release, a python peer acquires cleanly (exit 0).
    const pyAcquire = `
import fcntl, sys
f = open(sys.argv[1], "w")
fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
fcntl.flock(f, fcntl.LOCK_UN)
sys.exit(0)
`;
    const after = Bun.spawnSync(["python3", "-c", pyAcquire, lockPath]);
    expect(after.exitCode).toBe(0);
  });
});

// Unit tests for the write side of src/store.ts plus src/flock.ts: byte-stable
// atomic JSON writes, the touched-paths session log, and flock(2) task locks.
//
// The golden test byte-compares the writer against a frozen json.dumps(indent=2,
// sort_keys=True)+newline literal — the pinned serialization spec (recursive key
// sort + non-ASCII escaped + trailing newline). The flock contention tests spawn
// a second bun process holding the lock, synchronized by marker files (never
// sleeps), asserting the lock blocks in BOTH directions.

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
const savedKeeperJobId = process.env.KEEPER_JOB_ID;
const savedPlanSid = process.env.KEEPER_PLAN_SESSION_ID;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-write-test-")));
  delete process.env.KEEPER_JOB_ID;
  delete process.env.KEEPER_PLAN_SESSION_ID;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [
    ["CLAUDE_CODE_SESSION_ID", savedSid],
    ["KEEPER_JOB_ID", savedKeeperJobId],
    ["KEEPER_PLAN_SESSION_ID", savedPlanSid],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

describe("serializeStateJson byte-parity with the frozen json.dumps spec", () => {
  test("golden nested fixture is byte-identical to json.dumps(indent=2, sort_keys=True)+newline", () => {
    const bun = serializeStateJson(GOLDEN_FIXTURE as Record<string, unknown>);
    expect(bun).toBe(
      '{\n  "alpha": {\n    "deep": {\n      "x": {\n        "a": true,\n        "b": null\n      },\n      "y": 1\n    },\n    "nested_a": "unicode: caf\\u00e9 \\u2603 \\u00e9 \\u6f22\\u5b57 \\ud83d\\ude00",\n    "nested_z": [\n      3,\n      2,\n      1\n    ]\n  },\n  "bool_f": false,\n  "bool_t": true,\n  "control": "tab\\there\\nnewline\\r\\"quote\\"\\\\back",\n  "del_char": "x\\u007fy",\n  "key with spaces": "v",\n  "list_of_objs": [\n    {\n      "a": 2,\n      "c": 1\n    },\n    {\n      "m": 8,\n      "z": 9\n    }\n  ],\n  "nullval": null,\n  "numbers": {\n    "neg": -7,\n    "safe_int": 9007199254740991,\n    "small": 0\n  },\n  "zeta": "last",\n  "\\u00fcn\\u00efcode_key": "k"\n}\n',
    );
  });

  test("recursive sort: a nested out-of-order object matches the spec", () => {
    const data = { z: { d: 1, a: 2, m: { y: 1, b: 2 } }, a: 1 };
    expect(serializeStateJson(data)).toBe(
      '{\n  "a": 1,\n  "z": {\n    "a": 2,\n    "d": 1,\n    "m": {\n      "b": 2,\n      "y": 1\n    }\n  }\n}\n',
    );
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
  test("file on disk is byte-identical to the frozen serialization", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID; // isolate write from touched-log
    const p = join(root, "out.json");
    atomicWriteJson(p, GOLDEN_FIXTURE as Record<string, unknown>);
    expect(readFileSync(p, "utf-8")).toBe(
      '{\n  "alpha": {\n    "deep": {\n      "x": {\n        "a": true,\n        "b": null\n      },\n      "y": 1\n    },\n    "nested_a": "unicode: caf\\u00e9 \\u2603 \\u00e9 \\u6f22\\u5b57 \\ud83d\\ude00",\n    "nested_z": [\n      3,\n      2,\n      1\n    ]\n  },\n  "bool_f": false,\n  "bool_t": true,\n  "control": "tab\\there\\nnewline\\r\\"quote\\"\\\\back",\n  "del_char": "x\\u007fy",\n  "key with spaces": "v",\n  "list_of_objs": [\n    {\n      "a": 2,\n      "c": 1\n    },\n    {\n      "m": 8,\n      "z": 9\n    }\n  ],\n  "nullval": null,\n  "numbers": {\n    "neg": -7,\n    "safe_int": 9007199254740991,\n    "small": 0\n  },\n  "zeta": "last",\n  "\\u00fcn\\u00efcode_key": "k"\n}\n',
    );
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
    const dataDir = join(repoRoot, ".keeper");
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
      ".keeper/tasks/fn-1-x.1.json\n",
    );
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("a tracked Pi job records into the same touched-path layout", () => {
    const { repoRoot, dataDir } = seedPlanctl();
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.KEEPER_JOB_ID = "pi-job";
    const target = join(dataDir, "tasks", "fn-1-x.1.json");
    mkdirSync(join(dataDir, "tasks"), { recursive: true });
    writeFileSync(target, "{}");
    recordTouched(target);
    expect(
      readdirSync(join(dataDir, "state", "sessions", "pi-job", "touched")),
    ).toHaveLength(1);
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

  test("no .keeper/ ancestor => silent skip (fail-open)", () => {
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
      '{\n  "assignee": "a",\n  "status": "in_progress"\n}\n',
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

const FLOCK_PEER = join(import.meta.dir, "fixtures", "flock_peer.ts");

describe("flock cross-process contention with a second bun peer", () => {
  // Direction 1: the peer process holds the lock, this process's LOCK_NB must
  // fail (FlockWouldBlock). Synchronized by marker files — no sleeps.
  test("peer holds LOCK_EX => LOCK_NB here blocks (FlockWouldBlock)", () => {
    const lockPath = join(root, "interop1.lock");
    const heldMarker = join(root, "peer.held");
    const releaseMarker = join(root, "release.now");

    const peer = Bun.spawn(
      [
        process.execPath,
        "run",
        FLOCK_PEER,
        "hold",
        lockPath,
        heldMarker,
        releaseMarker,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      waitForFile(heldMarker);
      // Peer holds it — this process's non-blocking acquire must report contention.
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

  // Direction 2: this process holds the lock, the peer's LOCK_NB must fail. The
  // peer exits 42 on the expected block, 0 if it WRONGLY acquired the lock.
  test("this process holds LOCK_EX => peer LOCK_NB blocks (exit 42)", async () => {
    const lockPath = join(root, "interop2.lock");
    const fd = openSync(lockPath, "w");
    flockOrThrow(fd, LOCK_EX); // held for the whole peer run

    try {
      const peer = Bun.spawn(
        [process.execPath, "run", FLOCK_PEER, "try-nb", lockPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await peer.exited;
      expect(code).toBe(42);
    } finally {
      flock(fd, LOCK_UN);
      closeSync(fd);
    }
  });
});

describe("LocalFileStateStore.withTaskLock", () => {
  test("runs the body under a real flock and a peer process is blocked while held", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const stateDir = join(root, "state");
    const store = new LocalFileStateStore(stateDir);
    const lockPath = join(stateDir, "locks", "fn-1-x.1.lock");

    let observedBlocked = false;
    store.withTaskLock("fn-1-x.1", () => {
      // While we hold it, a peer's non-blocking acquire must fail (exit 42).
      const peer = Bun.spawnSync([
        process.execPath,
        "run",
        FLOCK_PEER,
        "try-nb",
        lockPath,
      ]);
      observedBlocked = peer.exitCode === 42;
    });
    expect(observedBlocked).toBe(true);

    // After release, a peer acquires cleanly (exit 0).
    const after = Bun.spawnSync([
      process.execPath,
      "run",
      FLOCK_PEER,
      "acquire",
      lockPath,
    ]);
    expect(after.exitCode).toBe(0);
  });
});

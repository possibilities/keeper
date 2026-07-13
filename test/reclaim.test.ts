import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupReclaimSidecars,
  daemonUp,
  executeReclaimSwap,
  type ParsedReclaimArgs,
  planReclaimCommand,
  type ReclaimRunOperations,
  type RunDeps,
  run,
} from "../cli/reclaim";

let root: string;
let dbPath: string;
let sockPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-reclaim-test-"));
  dbPath = join(root, "keeper.db");
  sockPath = join(root, "keeperd.sock");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function args(): ParsedReclaimArgs {
  return {
    dbPath,
    sockPath,
    dryRun: false,
    help: false,
    agentHelp: false,
  };
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function harness(overrides: Partial<ReclaimRunOperations> = {}): {
  calls: string[];
  out: string[];
  err: string[];
  exits: number[];
  deps: RunDeps;
} {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const operations: ReclaimRunOperations = {
    daemonStatus: (path) => {
      calls.push(`daemon:${path}`);
      return { up: false, pid: null };
    },
    sourceExists: (path) => {
      calls.push(`exists:${path}`);
      return true;
    },
    sourceSize: (path) => {
      calls.push(`size:${path}`);
      return 100;
    },
    backup: (path) => {
      calls.push(`backup:${path}`);
      return {
        snapshotPath: "/backups/rollback.db",
        verified: true,
        bytes: 90,
        pruned: [],
        cleanupFailures: [],
        error: null,
      };
    },
    reclaim: (source, output) => {
      calls.push(`reclaim:${source}:${output}`);
      return {
        outputPath: output,
        ok: true,
        sourceBytes: 100,
        outputBytes: 60,
        cleanupFailures: [],
        error: null,
      };
    },
    verify: (source, output) => {
      calls.push(`verify:${source}:${output}`);
      return {
        ok: true,
        sourceSchemaVersion: 9,
        outputSchemaVersion: 9,
        outputAutoVacuum: 2,
        error: null,
      };
    },
    removeOutput: (path) => calls.push(`remove:${path}`),
    swap: (plan) => {
      calls.push(`swap:${plan.outputPath}:${plan.dbPath}`);
      return {
        ok: true,
        error: null,
        sidecars: { removed: [...plan.sidecarPaths], failed: [] },
      };
    },
    ...overrides,
  };
  return {
    calls,
    out,
    err,
    exits,
    deps: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      exit: ((code: number) => {
        exits.push(code);
        throw new ExitSignal(code);
      }) as (code: number) => never,
      operations,
    },
  };
}

function invoke(deps: RunDeps): void {
  try {
    run(args(), deps);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

test("reclaim command plan confines output and sidecars to the DB basename", () => {
  expect(planReclaimCommand(args())).toEqual({
    dbPath,
    sockPath,
    outputPath: `${dbPath}.reclaim`,
    sidecarPaths: [`${dbPath}-wal`, `${dbPath}-shm`],
  });
});

test("run orchestrates guard, rollback, reclaim, verify, and swap in order", () => {
  const h = harness();
  invoke(h.deps);
  expect(h.exits).toEqual([]);
  expect(h.err).toEqual([]);
  expect(h.out.join("")).toContain("[reclaim] DONE");
  expect(h.calls).toEqual([
    `daemon:${sockPath}`,
    `exists:${dbPath}`,
    `size:${dbPath}`,
    `backup:${dbPath}`,
    `reclaim:${dbPath}:${dbPath}.reclaim`,
    `verify:${dbPath}:${dbPath}.reclaim`,
    `swap:${dbPath}.reclaim:${dbPath}`,
  ]);
});

test("run refuses a live daemon before any storage operation", () => {
  const h = harness({
    daemonStatus: () => ({ up: true, pid: 321 }),
    sourceExists: () => {
      throw new Error("must not inspect source");
    },
  });
  invoke(h.deps);
  expect(h.exits).toEqual([1]);
  expect(h.err.join("")).toContain("REFUSING");
  expect(h.err.join("")).toContain("pid 321");
  expect(h.calls).toEqual([]);
});

test("run keeps rollback and removes rejected output after verify refusal", () => {
  const h = harness({
    verify: () => ({
      ok: false,
      sourceSchemaVersion: 9,
      outputSchemaVersion: 8,
      outputAutoVacuum: 2,
      error: "schema mismatch",
    }),
  });
  invoke(h.deps);
  expect(h.exits).toEqual([1]);
  expect(h.calls).toContain(`remove:${dbPath}.reclaim`);
  expect(h.calls.some((call) => call.startsWith("swap:"))).toBe(false);
  expect(h.err.join("")).toContain("snapshot kept at /backups/rollback.db");
});

test("run reports partial sidecar cleanup without undoing a successful swap", () => {
  const failed = `${dbPath}-shm`;
  const h = harness({
    swap: () => ({
      ok: true,
      error: null,
      sidecars: { removed: [`${dbPath}-wal`], failed: [failed] },
    }),
  });
  invoke(h.deps);
  expect(h.exits).toEqual([]);
  expect(h.out.join("")).toContain("[reclaim] DONE");
  expect(h.err.join("")).toContain(failed);
  expect(h.err.join("")).toContain("safe to retry");
});

test("sidecar cleanup exposes partial failure, retries, and idempotence", () => {
  const plan = planReclaimCommand(args());
  const existing = new Set(plan.sidecarPaths);
  let failShm = true;
  const remove = (path: string): void => {
    expect(plan.sidecarPaths).toContain(path);
    if (path.endsWith("-shm") && failShm) throw new Error("busy");
    existing.delete(path);
  };
  const first = cleanupReclaimSidecars(plan.sidecarPaths, remove);
  expect(first).toEqual({
    removed: [`${dbPath}-wal`],
    failed: [`${dbPath}-shm`],
  });
  failShm = false;
  expect(cleanupReclaimSidecars(first.failed, remove)).toEqual({
    removed: [`${dbPath}-shm`],
    failed: [],
  });
  expect(cleanupReclaimSidecars(plan.sidecarPaths, remove).failed).toEqual([]);
  expect(existing.size).toBe(0);
});

test("one tiny atomic swap replaces the file and removes old sidecars", () => {
  const output = `${dbPath}.reclaim`;
  writeFileSync(dbPath, "old");
  writeFileSync(output, "new");
  writeFileSync(`${dbPath}-wal`, "wal");
  writeFileSync(`${dbPath}-shm`, "shm");

  const result = executeReclaimSwap(planReclaimCommand(args()));
  expect(result).toEqual({
    ok: true,
    error: null,
    sidecars: {
      removed: [`${dbPath}-wal`, `${dbPath}-shm`],
      failed: [],
    },
  });
  expect(readFileSync(dbPath, "utf8")).toBe("new");
  expect(existsSync(output)).toBe(false);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
});

test("daemon guard recognizes missing and live ownership locks", () => {
  expect(daemonUp(sockPath)).toEqual({ up: false, pid: null });
  writeFileSync(`${sockPath}.lock`, `${process.pid}\n`);
  expect(daemonUp(sockPath)).toEqual({ up: true, pid: process.pid });
});

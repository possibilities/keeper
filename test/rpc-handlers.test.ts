/**
 * Unit tests for `src/rpc-handlers.ts`. Direct-call layer only — no real
 * worker, no real socket, no daemon spawn. Each test sets up a hermetic
 * plan root (a tmp dir with a `.planctl/{epics,tasks}` tree) via
 * `KEEPER_CONFIG`, opens a writer DB against a separate tmpdir, calls the
 * handler directly, and asserts on the on-disk file + return value.
 *
 * The end-to-end "CLI → daemon → RPC → file" smoke lives in
 * `test/integration.test.ts`. These tests prove the handler's contract
 * against the canonical planctl serializer (`serializePlanctlJson` in
 * `src/db.ts`) — task `.1` of the fn-592-approval-as-planctl-field epic
 * locked the byte-for-byte form.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, serializePlanctlJson } from "../src/db";
import {
  resolvePlanFile,
  setEpicApprovalHandler,
  setTaskApprovalHandler,
} from "../src/rpc-handlers";
import { BadParamsError } from "../src/server-worker";

let tmpDir: string;
let dbPath: string;
let configPath: string;
let planRoot: string;
let epicsDir: string;
let tasksDir: string;
let originalKeeperConfig: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-rpc-handlers-test-"));
  dbPath = join(tmpDir, "keeper.db");
  planRoot = join(tmpDir, "plan-root");
  epicsDir = join(planRoot, ".planctl", "epics");
  tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Hermetic config pointing at our tmp plan root so `resolvePlanRoots()`
  // inside the handler returns this dir (not the real ~/code tree).
  configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, `roots:\n  - ${JSON.stringify(planRoot)}\n`);
  originalKeeperConfig = process.env.KEEPER_CONFIG;
  process.env.KEEPER_CONFIG = configPath;
  openDb(dbPath).db.close();
});

afterEach(() => {
  if (originalKeeperConfig === undefined) {
    delete process.env.KEEPER_CONFIG;
  } else {
    process.env.KEEPER_CONFIG = originalKeeperConfig;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Seed an epic plan file. The data is written via the canonical serializer so
 * the test's "preserved on rewrite" assertion compares byte-for-byte against
 * the planctl-locked form (task `.1` evidence).
 */
function seedEpic(id: string, extra: Record<string, unknown> = {}): string {
  const data: Record<string, unknown> = {
    id,
    title: `Epic ${id}`,
    status: "open",
    primary_repo: "/repo",
    branch_name: id,
    bundles: [],
    depends_on_epics: [],
    snippets: [],
    touched_repos: ["/repo"],
    plan_review_status: "unknown",
    plan_reviewed_at: null,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    last_validated_at: "2026-05-24T00:00:00Z",
    ...extra,
  };
  const path = join(epicsDir, `${id}.json`);
  writeFileSync(path, serializePlanctlJson(data));
  return path;
}

function seedTask(id: string, extra: Record<string, unknown> = {}): string {
  const epic = id.split(".")[0];
  const data: Record<string, unknown> = {
    id,
    epic,
    title: `Task ${id}`,
    target_repo: "/repo",
    bundles: [],
    depends_on: [],
    snippets: [],
    priority: null,
    preferred_backend: null,
    tier: "high",
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    worker_done_at: null,
    work_review_status: "unknown",
    work_reviewed_at: null,
    ...extra,
  };
  const path = join(tasksDir, `${id}.json`);
  writeFileSync(path, serializePlanctlJson(data));
  return path;
}

// ---------------------------------------------------------------------------
// Happy paths: set_task_approval / set_epic_approval
// ---------------------------------------------------------------------------

test("set_task_approval writes the field, preserves every other field, byte-identical to planctl serializer", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const path = seedTask("fn-1.2", { extra_field: "preserved" });
    const before = readFileSync(path, "utf8");
    const beforeObj = JSON.parse(before) as Record<string, unknown>;

    const result = setTaskApprovalHandler(db, {
      epic_id: "fn-1",
      task_id: "fn-1.2",
      status: "approved",
    });

    expect(result).toEqual({
      ok: true,
      epic_id: "fn-1",
      task_id: "fn-1.2",
      approval: "approved",
    });

    const after = readFileSync(path, "utf8");
    const afterObj = JSON.parse(after) as Record<string, unknown>;
    expect(afterObj.approval).toBe("approved");

    // Every prior field preserved.
    for (const [k, v] of Object.entries(beforeObj)) {
      expect(afterObj[k]).toEqual(v);
    }
    // Plus extra_field survived (forward-compat).
    expect(afterObj.extra_field).toBe("preserved");

    // Byte-identical to a fresh serializer pass on the post-mutation object.
    const expected = serializePlanctlJson({
      ...beforeObj,
      approval: "approved",
    });
    expect(after).toBe(expected);
  } finally {
    db.close();
  }
});

test("set_epic_approval writes the field, preserves every other field", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const path = seedEpic("fn-1", { unknown_key: 42 });
    const before = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;

    const result = setEpicApprovalHandler(db, {
      epic_id: "fn-1",
      status: "rejected",
    });

    expect(result).toEqual({ ok: true, epic_id: "fn-1", approval: "rejected" });

    const after = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(after.approval).toBe("rejected");
    expect(after.unknown_key).toBe(42);
    for (const [k, v] of Object.entries(before)) {
      expect(after[k]).toEqual(v);
    }
  } finally {
    db.close();
  }
});

test("set_task_approval overwrites an existing approval value", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const path = seedTask("fn-1.3", { approval: "pending" });
    setTaskApprovalHandler(db, {
      epic_id: "fn-1",
      task_id: "fn-1.3",
      status: "rejected",
    });
    const obj = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(obj.approval).toBe("rejected");

    // Now flip back to approved.
    setTaskApprovalHandler(db, {
      epic_id: "fn-1",
      task_id: "fn-1.3",
      status: "approved",
    });
    const obj2 = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(obj2.approval).toBe("approved");
  } finally {
    db.close();
  }
});

test("set_epic_approval accepts pending status", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    seedEpic("fn-9", { approval: "approved" });
    const result = setEpicApprovalHandler(db, {
      epic_id: "fn-9",
      status: "pending",
    });
    expect(result.approval).toBe("pending");
  } finally {
    db.close();
  }
});

test("back-to-back same-file writes both succeed; last write wins", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const path = seedTask("fn-1.5");
    // Two writes in quick succession (synchronous handler — JS single-thread
    // serializes them naturally; spec calls out per-file single-flight).
    setTaskApprovalHandler(db, {
      epic_id: "fn-1",
      task_id: "fn-1.5",
      status: "approved",
    });
    setTaskApprovalHandler(db, {
      epic_id: "fn-1",
      task_id: "fn-1.5",
      status: "rejected",
    });
    const obj = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(obj.approval).toBe("rejected");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Atomic write: temp file goes through rename, no `.tmp` lingers
// ---------------------------------------------------------------------------

test("set_task_approval leaves no `.tmp` files behind after a successful write", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    seedTask("fn-1.7");
    setTaskApprovalHandler(db, {
      epic_id: "fn-1",
      task_id: "fn-1.7",
      status: "approved",
    });
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const names = readdirSync(tasksDir);
    expect(names.some((n) => n.includes(".tmp."))).toBe(false);
    // The canonical file is there.
    expect(names).toContain("fn-1.7.json");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Validation: BadParamsError on bad shape, bad enum, path traversal
// ---------------------------------------------------------------------------

test("set_task_approval throws BadParamsError on null/non-object params", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() => setTaskApprovalHandler(db, null)).toThrow(BadParamsError);
    expect(() => setTaskApprovalHandler(db, "nope")).toThrow(BadParamsError);
    expect(() => setTaskApprovalHandler(db, 42)).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

test("set_task_approval throws BadParamsError on missing/bad epic_id and task_id", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setTaskApprovalHandler(db, { task_id: "fn-1.2", status: "approved" }),
    ).toThrow(/epic_id/);
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "",
        task_id: "fn-1.2",
        status: "approved",
      }),
    ).toThrow(BadParamsError);
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "fn-1",
        status: "approved",
      }),
    ).toThrow(/task_id/);
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "fn-1",
        task_id: 42,
        status: "approved",
      }),
    ).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

test("set_task_approval rejects bad status enum (including legacy 'clear')", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "fn-1",
        task_id: "fn-1.2",
        status: "clear",
      }),
    ).toThrow(/approved\|rejected\|pending/);
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "fn-1",
        task_id: "fn-1.2",
        status: "garbage",
      }),
    ).toThrow(BadParamsError);
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "fn-1",
        task_id: "fn-1.2",
      }),
    ).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

test("set_task_approval rejects path-traversal in epic_id and task_id", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const evil = [
      "..",
      "../etc",
      "../../escape",
      "/abs/path",
      "x/y",
      "x\\y",
      "x\0y",
      ".hidden",
    ];
    for (const bad of evil) {
      expect(() =>
        setTaskApprovalHandler(db, {
          epic_id: bad,
          task_id: "fn-1.2",
          status: "approved",
        }),
      ).toThrow(BadParamsError);
      expect(() =>
        setTaskApprovalHandler(db, {
          epic_id: "fn-1",
          task_id: bad,
          status: "approved",
        }),
      ).toThrow(BadParamsError);
    }
  } finally {
    db.close();
  }
});

test("set_epic_approval rejects path-traversal in epic_id", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    for (const bad of ["..", "../foo", "x/y", "x\\y", "x\0y", ".hidden"]) {
      expect(() =>
        setEpicApprovalHandler(db, { epic_id: bad, status: "approved" }),
      ).toThrow(BadParamsError);
    }
  } finally {
    db.close();
  }
});

test("set_epic_approval throws BadParamsError on bad enum / missing epic_id", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() => setEpicApprovalHandler(db, { status: "approved" })).toThrow(
      /epic_id/,
    );
    expect(() =>
      setEpicApprovalHandler(db, { epic_id: "fn-1", status: "clear" }),
    ).toThrow(BadParamsError);
    expect(() => setEpicApprovalHandler(db, null)).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Not-found surfaces as a typed throw (the dispatcher frames it as rpc_failed)
// ---------------------------------------------------------------------------

test("set_task_approval throws when no matching planctl task file exists", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setTaskApprovalHandler(db, {
        epic_id: "fn-nope",
        task_id: "fn-nope.1",
        status: "approved",
      }),
    ).toThrow(/no planctl task file found/);
  } finally {
    db.close();
  }
});

test("set_epic_approval throws when no matching planctl epic file exists", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setEpicApprovalHandler(db, { epic_id: "fn-nope", status: "approved" }),
    ).toThrow(/no planctl epic file found/);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// resolvePlanFile: walks `<root>/<project>/.planctl/...` one level deep
// ---------------------------------------------------------------------------

test("resolvePlanFile finds files at <root>/.planctl/... directly", () => {
  const path = seedTask("fn-2.1");
  expect(resolvePlanFile([planRoot], "tasks", "fn-2.1")).toBe(path);
});

test("resolvePlanFile walks one level deep to find <root>/<project>/.planctl/...", () => {
  // Build a NEW plan-root layout: root contains a project subdir with the
  // .planctl tree (mirroring real-world `~/code/<project>/.planctl/...`).
  const outerRoot = join(tmpDir, "outer-root");
  const projectDir = join(outerRoot, "myproject");
  const nestedTasksDir = join(projectDir, ".planctl", "tasks");
  mkdirSync(nestedTasksDir, { recursive: true });
  const path = join(nestedTasksDir, "fn-3.1.json");
  writeFileSync(path, serializePlanctlJson({ id: "fn-3.1", epic: "fn-3" }));
  expect(resolvePlanFile([outerRoot], "tasks", "fn-3.1")).toBe(path);
});

test("resolvePlanFile returns null when no root carries the file", () => {
  expect(resolvePlanFile([planRoot], "tasks", "fn-nx.1")).toBeNull();
  expect(resolvePlanFile([], "epics", "fn-nx")).toBeNull();
});

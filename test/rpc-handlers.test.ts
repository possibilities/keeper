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
  parseDispatchKey,
  replayDeadLetterHandler,
  resolvePlanFile,
  retryDispatchHandler,
  setAutopilotPausedHandler,
  setEpicApprovalHandler,
  setTaskApprovalHandler,
} from "../src/rpc-handlers";
import { BadParamsError, type ReplayBridge } from "../src/server-worker";

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

// ---------------------------------------------------------------------------
// replay_dead_letter (async — routes through the worker→main bridge)
// ---------------------------------------------------------------------------

/**
 * Build a stub bridge whose `replay()` resolves with a fixed result. Lets
 * the unit layer drive `replayDeadLetterHandler` directly without a real
 * worker / parent port — the handler's job is "validate params, call
 * bridge.replay, normalize the response", and a stub captures every call
 * for shape assertions.
 */
function stubBridge(
  result:
    | { ok: true; recovered_dl_id?: string | null }
    | { ok: false; error?: string },
): { bridge: ReplayBridge; state: { calls: number } } {
  const state = { calls: 0 };
  const bridge: ReplayBridge = {
    async replay() {
      state.calls += 1;
      return result;
    },
    // Not exercised by the replay-dead-letter handler tests; satisfies
    // the fn-661-extended interface without affecting these test cases.
    async setAutopilotPaused() {
      return { ok: true };
    },
    async retryDispatch() {
      return { ok: true };
    },
  };
  return { bridge, state };
}

test("replay_dead_letter calls bridge.replay and normalizes recovered_dl_id", async () => {
  const { bridge } = stubBridge({ ok: true, recovered_dl_id: "dl-1" });
  const result = await replayDeadLetterHandler(undefined, bridge);
  expect(result).toEqual({ ok: true, recovered_dl_id: "dl-1" });
});

test("replay_dead_letter normalizes a missing recovered_dl_id to null (empty backlog ack)", async () => {
  const { bridge } = stubBridge({ ok: true });
  const result = await replayDeadLetterHandler(undefined, bridge);
  expect(result).toEqual({ ok: true, recovered_dl_id: null });
});

test("replay_dead_letter normalizes explicit null recovered_dl_id", async () => {
  const { bridge } = stubBridge({ ok: true, recovered_dl_id: null });
  const result = await replayDeadLetterHandler(null, bridge);
  expect(result).toEqual({ ok: true, recovered_dl_id: null });
});

test("replay_dead_letter accepts an empty object as params", async () => {
  const { bridge } = stubBridge({ ok: true, recovered_dl_id: "dl-2" });
  const result = await replayDeadLetterHandler({}, bridge);
  expect(result).toEqual({ ok: true, recovered_dl_id: "dl-2" });
});

test("replay_dead_letter throws BadParamsError on non-object params", async () => {
  const { bridge } = stubBridge({ ok: true });
  for (const bad of ["nope", 42, true, [1, 2]]) {
    expect(replayDeadLetterHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("replay_dead_letter throws BadParamsError on params with extra keys", async () => {
  const { bridge } = stubBridge({ ok: true });
  expect(
    replayDeadLetterHandler({ dl_id: "dl-1" }, bridge),
  ).rejects.toBeInstanceOf(BadParamsError);
});

test("replay_dead_letter throws (rpc_failed framing) when bridge reports ok:false", async () => {
  const { bridge } = stubBridge({ ok: false, error: "main crashed" });
  expect(replayDeadLetterHandler(undefined, bridge)).rejects.toThrow(
    /main crashed/,
  );
});

test("replay_dead_letter throws a generic message when ok:false carries no error string", async () => {
  const { bridge } = stubBridge({ ok: false });
  expect(replayDeadLetterHandler(undefined, bridge)).rejects.toThrow(
    /main reported failure/,
  );
});

// ---------------------------------------------------------------------------
// fn-661 task .4 — `set_autopilot_paused`
// ---------------------------------------------------------------------------

/**
 * Stub bridge for the fn-661 autopilot pause/retry handlers. Records every
 * call so a test can assert the exact (paused) / (verb, id) the handler
 * forwarded. The `replay` arm is untouched (the autopilot handlers never
 * call it) but must be present to satisfy the {@link ReplayBridge}
 * interface.
 */
function autopilotStubBridge(opts: {
  setPaused?: { ok: boolean; error?: string };
  retry?: { ok: boolean; error?: string };
}): {
  bridge: ReplayBridge;
  state: {
    setPausedCalls: boolean[];
    retryCalls: Array<{ verb: string; id: string }>;
  };
} {
  const state = {
    setPausedCalls: [] as boolean[],
    retryCalls: [] as Array<{ verb: string; id: string }>,
  };
  const bridge: ReplayBridge = {
    async replay() {
      return { ok: true, recovered_dl_id: null };
    },
    async setAutopilotPaused(paused) {
      state.setPausedCalls.push(paused);
      return opts.setPaused ?? { ok: true };
    },
    async retryDispatch(verb, id) {
      state.retryCalls.push({ verb, id });
      return opts.retry ?? { ok: true };
    },
  };
  return { bridge, state };
}

test("set_autopilot_paused forwards the boolean to the bridge and returns ok+paused", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotPausedHandler({ paused: true }, bridge);
  expect(result).toEqual({ ok: true, paused: true });
  expect(state.setPausedCalls).toEqual([true]);

  const result2 = await setAutopilotPausedHandler({ paused: false }, bridge);
  expect(result2).toEqual({ ok: true, paused: false });
  expect(state.setPausedCalls).toEqual([true, false]);
});

test("set_autopilot_paused throws BadParamsError on non-object params", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [null, "nope", 1, true, [], undefined]) {
    expect(setAutopilotPausedHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("set_autopilot_paused throws BadParamsError when `paused` is missing or non-boolean", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [{}, { paused: "true" }, { paused: 1 }, { paused: null }]) {
    expect(setAutopilotPausedHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("set_autopilot_paused throws rpc_failed when the bridge reports ok:false", async () => {
  const { bridge } = autopilotStubBridge({
    setPaused: { ok: false, error: "no autopilot worker" },
  });
  expect(setAutopilotPausedHandler({ paused: true }, bridge)).rejects.toThrow(
    /no autopilot worker/,
  );
});

// ---------------------------------------------------------------------------
// fn-661 task .4 — `retry_dispatch`
// ---------------------------------------------------------------------------

test("parseDispatchKey: splits the composite key into a typed {verb, id} pair", () => {
  expect(parseDispatchKey("work::fn-1-foo.3")).toEqual({
    verb: "work",
    id: "fn-1-foo.3",
  });
  expect(parseDispatchKey("approve::fn-1-foo.3")).toEqual({
    verb: "approve",
    id: "fn-1-foo.3",
  });
  expect(parseDispatchKey("close::fn-1-foo")).toEqual({
    verb: "close",
    id: "fn-1-foo",
  });
});

test("parseDispatchKey: rejects empty / non-string / missing-separator inputs", () => {
  for (const bad of ["", undefined, null, 42, true, "no-sep", "work::"]) {
    expect(() => parseDispatchKey(bad)).toThrow(BadParamsError);
  }
});

test("parseDispatchKey: rejects unknown verbs", () => {
  expect(() => parseDispatchKey("rm::fn-1-foo")).toThrow(BadParamsError);
  expect(() => parseDispatchKey("plan::fn-1-foo")).toThrow(BadParamsError);
});

test("parseDispatchKey: rejects nested `::` separators (no command injection)", () => {
  expect(() => parseDispatchKey("work::fn-1::pwned")).toThrow(BadParamsError);
});

test("parseDispatchKey: rejects path-traversal tokens in the id half", () => {
  for (const bad of [
    "work::../etc/passwd",
    "work::/abs/path",
    "work::a/b",
    "work::a\\b",
    "work::.hidden",
    "work::a\0b",
  ]) {
    expect(() => parseDispatchKey(bad)).toThrow(BadParamsError);
  }
});

test("retry_dispatch forwards the split (verb, id) to the bridge and returns ok+verb+id", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await retryDispatchHandler({ id: "work::fn-1-foo.3" }, bridge);
  expect(result).toEqual({ ok: true, verb: "work", id: "fn-1-foo.3" });
  expect(state.retryCalls).toEqual([{ verb: "work", id: "fn-1-foo.3" }]);
});

test("retry_dispatch rejects params with extra keys (no command/param injection)", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [
    { id: "work::fn-1-foo", command: "rm -rf /" },
    { id: "work::fn-1-foo", verb: "approve" }, // redundant + injected
    { id: "work::fn-1-foo", cwd: "/etc" },
    { id: "work::fn-1-foo", tier: "explore" },
  ]) {
    expect(retryDispatchHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("retry_dispatch rejects non-object / missing-id params", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [null, undefined, "work::fn-1", {}, { other: 1 }]) {
    expect(retryDispatchHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("retry_dispatch surfaces bridge ok:false as a thrown error (rpc_failed framing)", async () => {
  const { bridge } = autopilotStubBridge({
    retry: { ok: false, error: "insertEvent failed" },
  });
  expect(
    retryDispatchHandler({ id: "work::fn-1-foo.3" }, bridge),
  ).rejects.toThrow(/insertEvent failed/);
});

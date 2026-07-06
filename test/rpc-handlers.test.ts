/**
 * Unit tests for `src/rpc-handlers.ts`. Direct-call layer only — no real
 * worker, no real socket, no daemon spawn. Each test sets up a hermetic
 * plan root (a tmp dir with a `.keeper/{epics,tasks}` tree) via
 * `KEEPER_CONFIG`, opens a writer DB against a separate tmpdir, calls the
 * handler directly, and asserts on the on-disk file + return value.
 *
 * fn-732: the approval handlers now write the GITIGNORED runtime sidecar
 * (`.keeper/state/{epics,tasks}/<id>.state.json`), create-if-absent + RMW
 * preserving the sidecar's existing fields, and LEAVE THE COMMITTED DEF
 * UNTOUCHED. The handler still resolves the committed def first (to prove the
 * entity exists + locate the owning `.keeper`); the sidecar is derived from
 * that resolved path. The keeper read-side folds approval from the sidecar
 * gate-free with a permanent fallback to the def — see `src/plan-worker.ts`.
 *
 * The end-to-end "CLI → daemon → RPC → file" smoke lives in
 * `test/integration.test.ts`. These tests prove the handler's contract
 * against the canonical plan serializer (`serializePlanJson` in
 * `src/db.ts`).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDispatchKey,
  perRootStoredWhileOffNote,
  replayDeadLetterHandler,
  requestHandoffHandler,
  retryDispatchHandler,
  setAutopilotConfigHandler,
  setAutopilotModeHandler,
  setAutopilotPausedHandler,
  setEpicArmedHandler,
} from "../src/rpc-handlers";
import {
  BadParamsError,
  type ReplayBridge,
  SlugConflictError,
} from "../src/server-worker";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let configPath: string;
let planRoot: string;
let epicsDir: string;
let tasksDir: string;
let originalKeeperConfig: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-rpc-handlers-test-"));
  planRoot = join(tmpDir, "plan-root");
  epicsDir = join(planRoot, ".keeper", "epics");
  tasksDir = join(planRoot, ".keeper", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Hermetic config pointing at our tmp plan root so `resolvePlanRoots()`
  // inside the handler returns this dir (not the real ~/code tree).
  configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, `roots:\n  - ${JSON.stringify(planRoot)}\n`);
  originalKeeperConfig = process.env.KEEPER_CONFIG;
  process.env.KEEPER_CONFIG = configPath;
  // fn-769 mem variant: no test body opens a DB connection — the handlers run
  // against stub bridges + the plan-root filesystem — so this bootstrap only
  // ever needed a migrated schema in process. The in-memory template clone
  // gives that without the per-test migration ladder.
  freshMemDb().db.close();
});

afterEach(() => {
  if (originalKeeperConfig === undefined) {
    delete process.env.KEEPER_CONFIG;
  } else {
    process.env.KEEPER_CONFIG = originalKeeperConfig;
  }
  rmSync(tmpDir, { recursive: true, force: true });
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
    // the fn-661/fn-751-extended interface without affecting these test cases.
    async setAutopilotPaused() {
      return { ok: true };
    },
    async retryDispatch() {
      return { ok: true };
    },
    async setAutopilotMode() {
      return { ok: true };
    },
    async setAutopilotConfig() {
      return { ok: true };
    },
    async setEpicArmed() {
      return { ok: true };
    },
    async requestHandoff() {
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
  setMode?: { ok: boolean; error?: string };
  setConfig?: { ok: boolean; error?: string; note?: string };
  setArmed?: { ok: boolean; error?: string };
  requestHandoff?: { ok: boolean; error?: string; conflict?: boolean };
}): {
  bridge: ReplayBridge;
  state: {
    setPausedCalls: boolean[];
    retryCalls: Array<{ verb: string; id: string }>;
    setModeCalls: string[];
    setConfigCalls: Array<{
      max_concurrent_jobs?: number | null;
      max_concurrent_per_root?: number | null;
      worktree_mode?: boolean;
      worktree_multi_repo?: boolean;
    }>;
    setArmedCalls: Array<{ epic_id: string; armed: boolean }>;
    requestHandoffCalls: Array<{
      desired_slug: string;
      doc_path: string;
      title: string | null;
      target_session: string;
      target_dir: string | null;
      initiator_session: string | null;
      initiator_pane: string | null;
    }>;
  };
} {
  const state = {
    setPausedCalls: [] as boolean[],
    retryCalls: [] as Array<{ verb: string; id: string }>,
    setModeCalls: [] as string[],
    setConfigCalls: [] as Array<{
      max_concurrent_jobs?: number | null;
      max_concurrent_per_root?: number | null;
      worktree_mode?: boolean;
      worktree_multi_repo?: boolean;
    }>,
    setArmedCalls: [] as Array<{ epic_id: string; armed: boolean }>,
    requestHandoffCalls: [] as Array<{
      desired_slug: string;
      doc_path: string;
      title: string | null;
      target_session: string;
      target_dir: string | null;
      initiator_session: string | null;
      initiator_pane: string | null;
    }>,
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
    async setAutopilotMode(mode) {
      state.setModeCalls.push(mode);
      return opts.setMode ?? { ok: true };
    },
    async setAutopilotConfig(patch) {
      state.setConfigCalls.push(patch);
      return opts.setConfig ?? { ok: true };
    },
    async setEpicArmed(epic_id, armed) {
      state.setArmedCalls.push({ epic_id, armed });
      return opts.setArmed ?? { ok: true };
    },
    async requestHandoff(req) {
      state.requestHandoffCalls.push(req);
      return opts.requestHandoff ?? { ok: true };
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
// fn-751 task .3 — `set_autopilot_mode`
// ---------------------------------------------------------------------------

test("set_autopilot_mode forwards the validated enum to the bridge and returns ok+mode", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotModeHandler({ mode: "armed" }, bridge);
  expect(result).toEqual({ ok: true, mode: "armed" });
  expect(state.setModeCalls).toEqual(["armed"]);

  const result2 = await setAutopilotModeHandler({ mode: "yolo" }, bridge);
  expect(result2).toEqual({ ok: true, mode: "yolo" });
  expect(state.setModeCalls).toEqual(["armed", "yolo"]);
});

test("set_autopilot_mode throws BadParamsError on non-object params", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [null, "armed", 1, true, [], undefined]) {
    expect(setAutopilotModeHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("set_autopilot_mode rejects an unknown enum value (no coercion)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [{}, { mode: "YOLO" }, { mode: "off" }, { mode: 1 }]) {
    expect(setAutopilotModeHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  // A rejected enum never reaches the bridge.
  expect(state.setModeCalls).toEqual([]);
});

test("set_autopilot_mode throws rpc_failed when the bridge reports ok:false", async () => {
  const { bridge } = autopilotStubBridge({
    setMode: { ok: false, error: "insert lock contention" },
  });
  expect(setAutopilotModeHandler({ mode: "armed" }, bridge)).rejects.toThrow(
    /insert lock contention/,
  );
});

// ---------------------------------------------------------------------------
// fn-953 — `set_autopilot_config` (the generic runtime config-patch RPC)
// ---------------------------------------------------------------------------

test("set_autopilot_config forwards the validated patch to the bridge and returns ok+patch", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotConfigHandler(
    { max_concurrent_jobs: 8 },
    bridge,
  );
  expect(result).toEqual({ ok: true, patch: { max_concurrent_jobs: 8 } });
  expect(state.setConfigCalls).toEqual([{ max_concurrent_jobs: 8 }]);
});

test("set_autopilot_config accepts an explicit null cap (= unlimited)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotConfigHandler(
    { max_concurrent_jobs: null },
    bridge,
  );
  expect(result).toEqual({ ok: true, patch: { max_concurrent_jobs: null } });
  expect(state.setConfigCalls).toEqual([{ max_concurrent_jobs: null }]);
});

test("set_autopilot_config throws BadParamsError on non-object params", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [null, "8", 8, true, [], undefined]) {
    expect(setAutopilotConfigHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("set_autopilot_config rejects an unknown config key", async () => {
  const { bridge, state } = autopilotStubBridge({});
  expect(
    setAutopilotConfigHandler({ bogus_key: 1 }, bridge),
  ).rejects.toBeInstanceOf(BadParamsError);
  // The unknown key never reaches the bridge.
  expect(state.setConfigCalls).toEqual([]);
});

test("set_autopilot_config rejects an empty patch (no config key set)", async () => {
  const { bridge } = autopilotStubBridge({});
  expect(setAutopilotConfigHandler({}, bridge)).rejects.toBeInstanceOf(
    BadParamsError,
  );
});

test("set_autopilot_config rejects a non-positive / non-integer max_concurrent_jobs", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [
    { max_concurrent_jobs: 0 },
    { max_concurrent_jobs: -2 },
    { max_concurrent_jobs: 2.5 },
    { max_concurrent_jobs: "3" },
  ]) {
    expect(setAutopilotConfigHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  expect(state.setConfigCalls).toEqual([]);
});

test("set_autopilot_config forwards a max_concurrent_per_root patch (fn-954)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotConfigHandler(
    { max_concurrent_per_root: 3 },
    bridge,
  );
  expect(result).toEqual({
    ok: true,
    patch: { max_concurrent_per_root: 3 },
  });
  expect(state.setConfigCalls).toEqual([{ max_concurrent_per_root: 3 }]);
});

test("set_autopilot_config accepts an explicit null max_concurrent_per_root (= reset to default) (fn-954)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotConfigHandler(
    { max_concurrent_per_root: null },
    bridge,
  );
  expect(result).toEqual({
    ok: true,
    patch: { max_concurrent_per_root: null },
  });
  expect(state.setConfigCalls).toEqual([{ max_concurrent_per_root: null }]);
});

test("set_autopilot_config forwards a combined cap + per-root patch (fn-954)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setAutopilotConfigHandler(
    { max_concurrent_jobs: 8, max_concurrent_per_root: 2 },
    bridge,
  );
  expect(result).toEqual({
    ok: true,
    patch: { max_concurrent_jobs: 8, max_concurrent_per_root: 2 },
  });
  expect(state.setConfigCalls).toEqual([
    { max_concurrent_jobs: 8, max_concurrent_per_root: 2 },
  ]);
});

test("set_autopilot_config rejects a non-positive / non-integer max_concurrent_per_root (fn-954)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [
    { max_concurrent_per_root: 0 },
    { max_concurrent_per_root: -2 },
    { max_concurrent_per_root: 2.5 },
    { max_concurrent_per_root: "3" },
  ]) {
    expect(setAutopilotConfigHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  expect(state.setConfigCalls).toEqual([]);
});

test("set_autopilot_config forwards a worktree_mode boolean patch (fn-959)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const on = await setAutopilotConfigHandler({ worktree_mode: true }, bridge);
  expect(on).toEqual({ ok: true, patch: { worktree_mode: true } });
  const off = await setAutopilotConfigHandler({ worktree_mode: false }, bridge);
  expect(off).toEqual({ ok: true, patch: { worktree_mode: false } });
  expect(state.setConfigCalls).toEqual([
    { worktree_mode: true },
    { worktree_mode: false },
  ]);
});

test("set_autopilot_config rejects a non-boolean worktree_mode (fn-959)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [
    { worktree_mode: 1 },
    { worktree_mode: 0 },
    { worktree_mode: "true" },
    { worktree_mode: null },
  ]) {
    expect(setAutopilotConfigHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  expect(state.setConfigCalls).toEqual([]);
});

test("set_autopilot_config forwards a worktree_multi_repo boolean patch (fn-1034)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const on = await setAutopilotConfigHandler(
    { worktree_multi_repo: true },
    bridge,
  );
  expect(on).toEqual({ ok: true, patch: { worktree_multi_repo: true } });
  const off = await setAutopilotConfigHandler(
    { worktree_multi_repo: false },
    bridge,
  );
  expect(off).toEqual({ ok: true, patch: { worktree_multi_repo: false } });
  expect(state.setConfigCalls).toEqual([
    { worktree_multi_repo: true },
    { worktree_multi_repo: false },
  ]);
});

test("set_autopilot_config rejects a non-boolean worktree_multi_repo (fn-1034)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [
    { worktree_multi_repo: 1 },
    { worktree_multi_repo: 0 },
    { worktree_multi_repo: "true" },
    { worktree_multi_repo: null },
  ]) {
    expect(setAutopilotConfigHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  expect(state.setConfigCalls).toEqual([]);
});

test("set_autopilot_config throws rpc_failed when the bridge reports ok:false", async () => {
  const { bridge } = autopilotStubBridge({
    setConfig: { ok: false, error: "insert lock contention" },
  });
  expect(
    setAutopilotConfigHandler({ max_concurrent_jobs: 4 }, bridge),
  ).rejects.toThrow(/insert lock contention/);
});

// ---------------------------------------------------------------------------
// `perRootStoredWhileOffNote` — the stored-vs-effective advisory. Storing a
// per-root cap is ALWAYS legal (no reject, no coerce); this pure helper only
// surfaces the gap when the folded worktree mode leaves the stored value dormant
// (effective 1). `worktreeOn` is the folded mode AFTER the patch, read by main at
// reply time. Inverts the old reject: the conditions that once threw now note.
// ---------------------------------------------------------------------------

test("note — worktree ON: a per-root > 1 patch is honored, so no note (fn-1134)", () => {
  expect(
    perRootStoredWhileOffNote({ max_concurrent_per_root: 3 }, true),
  ).toBeNull();
  expect(
    perRootStoredWhileOffNote(
      { worktree_mode: true, max_concurrent_per_root: 5 },
      true,
    ),
  ).toBeNull();
});

test("note — worktree OFF: a stored per-root > 1 is dormant, so a note rides the reply (fn-1134)", () => {
  const note = perRootStoredWhileOffNote({ max_concurrent_per_root: 3 }, false);
  expect(note).not.toBeNull();
  expect(note).toContain("stored as 3");
  expect(note).toContain("worktree mode is off");
  // A single patch flipping worktree off AND setting per-root > 1 also notes.
  expect(
    perRootStoredWhileOffNote(
      { worktree_mode: false, max_concurrent_per_root: 2 },
      false,
    ),
  ).toContain("stored as 2");
});

test("note — worktree OFF but no surprising per-root intent (1 / null / absent) → null (fn-1134)", () => {
  // Effective already equals the requested value → nothing to clarify.
  expect(
    perRootStoredWhileOffNote({ max_concurrent_per_root: 1 }, false),
  ).toBeNull();
  expect(
    perRootStoredWhileOffNote({ max_concurrent_per_root: null }, false),
  ).toBeNull();
  // A lone unrelated config change never carries the per-root note.
  expect(
    perRootStoredWhileOffNote({ max_concurrent_jobs: 8 }, false),
  ).toBeNull();
});

test("set_autopilot_config forwards main's stored-vs-effective note onto the result (fn-1134)", async () => {
  const { bridge } = autopilotStubBridge({
    setConfig: {
      ok: true,
      note: "max_concurrent_per_root stored as 3; the effective per-root cap stays 1",
    },
  });
  const result = await setAutopilotConfigHandler(
    { max_concurrent_per_root: 3 },
    bridge,
  );
  expect(result).toEqual({
    ok: true,
    patch: { max_concurrent_per_root: 3 },
    note: "max_concurrent_per_root stored as 3; the effective per-root cap stays 1",
  });
});

test("set_autopilot_config omits the note field when main reports none (fn-1134)", async () => {
  const { bridge } = autopilotStubBridge({});
  const result = await setAutopilotConfigHandler(
    { max_concurrent_per_root: 3 },
    bridge,
  );
  expect(result).toEqual({ ok: true, patch: { max_concurrent_per_root: 3 } });
  expect("note" in result).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-751 task .3 — `set_epic_armed`
// ---------------------------------------------------------------------------

test("set_epic_armed forwards (epic_id, armed) to the bridge and returns ok+epic_id+armed", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await setEpicArmedHandler(
    { epic_id: "fn-1-foo", armed: true },
    bridge,
  );
  expect(result).toEqual({ ok: true, epic_id: "fn-1-foo", armed: true });
  expect(state.setArmedCalls).toEqual([{ epic_id: "fn-1-foo", armed: true }]);

  const result2 = await setEpicArmedHandler(
    { epic_id: "fn-1-foo", armed: false },
    bridge,
  );
  expect(result2).toEqual({ ok: true, epic_id: "fn-1-foo", armed: false });
  expect(state.setArmedCalls).toEqual([
    { epic_id: "fn-1-foo", armed: true },
    { epic_id: "fn-1-foo", armed: false },
  ]);
});

test("set_epic_armed throws BadParamsError on non-object params", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [null, "fn-1-foo", 1, true, [], undefined]) {
    expect(setEpicArmedHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("set_epic_armed throws BadParamsError on a missing/empty epic_id or non-boolean armed", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [
    { armed: true },
    { epic_id: "", armed: true },
    { epic_id: 1, armed: true },
    { epic_id: "fn-1-foo" },
    { epic_id: "fn-1-foo", armed: "true" },
    { epic_id: "fn-1-foo", armed: 1 },
  ]) {
    expect(setEpicArmedHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  expect(state.setArmedCalls).toEqual([]);
});

test("set_epic_armed throws rpc_failed when the bridge reports ok:false", async () => {
  const { bridge } = autopilotStubBridge({
    setArmed: { ok: false, error: "writer lock contention" },
  });
  expect(
    setEpicArmedHandler({ epic_id: "fn-1-foo", armed: true }, bridge),
  ).rejects.toThrow(/writer lock contention/);
});

// ---------------------------------------------------------------------------
// fn-946 task .2 — `request_handoff`
// ---------------------------------------------------------------------------

test("request_handoff forwards the validated request to the bridge and returns ok+handoff_id (the resolved slug)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await requestHandoffHandler(
    {
      desired_slug: "investigate-foo",
      doc_path: "/state/handoff/rpc-1.txt",
      title: "explore X",
      target_session: "work",
      target_dir: "/Users/dev/code/other",
      initiator_session: "dash",
      initiator_pane: "%3",
    },
    bridge,
  );
  expect(result).toEqual({ ok: true, handoff_id: "investigate-foo" });
  expect(state.requestHandoffCalls).toEqual([
    {
      desired_slug: "investigate-foo",
      doc_path: "/state/handoff/rpc-1.txt",
      title: "explore X",
      target_session: "work",
      target_dir: "/Users/dev/code/other",
      initiator_session: "dash",
      initiator_pane: "%3",
    },
  ]);
});

test("request_handoff coerces absent optional coords to null", async () => {
  const { bridge, state } = autopilotStubBridge({});
  const result = await requestHandoffHandler(
    {
      desired_slug: "clean-x",
      doc_path: "/state/handoff/rpc-2.txt",
      target_session: "work",
    },
    bridge,
  );
  expect(result).toEqual({ ok: true, handoff_id: "clean-x" });
  expect(state.requestHandoffCalls).toEqual([
    {
      desired_slug: "clean-x",
      doc_path: "/state/handoff/rpc-2.txt",
      title: null,
      target_session: "work",
      target_dir: null,
      initiator_session: null,
      initiator_pane: null,
    },
  ]);
});

test("request_handoff rejects a non-absolute target_dir at the trust boundary (daemon-side guard)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  expect(
    requestHandoffHandler(
      {
        desired_slug: "rel-dir",
        doc_path: "/p",
        target_session: "work",
        target_dir: "relative/path",
      },
      bridge,
    ),
  ).rejects.toBeInstanceOf(BadParamsError);
  expect(state.requestHandoffCalls).toEqual([]);
});

test("request_handoff forwards an absolute target_dir verbatim", async () => {
  const { bridge, state } = autopilotStubBridge({});
  await requestHandoffHandler(
    {
      desired_slug: "abs-dir",
      doc_path: "/p",
      target_session: "work",
      target_dir: "/Users/dev/code/other",
    },
    bridge,
  );
  expect(state.requestHandoffCalls[0]?.target_dir).toBe(
    "/Users/dev/code/other",
  );
});

test("request_handoff throws BadParamsError on non-object params", async () => {
  const { bridge } = autopilotStubBridge({});
  for (const bad of [null, "h", 1, true, [], undefined]) {
    expect(requestHandoffHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
});

test("request_handoff throws BadParamsError on a bad-shape payload", async () => {
  const { bridge, state } = autopilotStubBridge({});
  for (const bad of [
    {}, // no desired_slug/doc_path/target_session
    { doc_path: "/p", target_session: "work" }, // missing desired_slug
    { desired_slug: "", doc_path: "/p", target_session: "work" }, // empty slug
    { desired_slug: "h", target_session: "work" }, // missing doc_path
    { desired_slug: "h", doc_path: "", target_session: "work" }, // empty doc_path
    { desired_slug: "h", doc_path: "/p" }, // missing target_session
    { desired_slug: "h", doc_path: "/p", target_session: "" }, // empty target_session
    { desired_slug: "h", doc_path: "/p", target_session: "work", title: 1 }, // non-string title
    {
      desired_slug: "h",
      doc_path: "/p",
      target_session: "work",
      initiator_pane: 1,
    },
  ]) {
    expect(requestHandoffHandler(bad, bridge)).rejects.toBeInstanceOf(
      BadParamsError,
    );
  }
  expect(state.requestHandoffCalls).toEqual([]);
});

test("request_handoff re-validates slug FORMAT at the trust boundary (hand-crafted RPC bypass)", async () => {
  const { bridge, state } = autopilotStubBridge({});
  // A hand-crafted RPC skips CLI slugify — the daemon rejects a malformed slug.
  for (const badSlug of [
    "Has-Caps",
    "has_underscore",
    "has space",
    "has.dot",
    ".",
    "..",
    "---",
    "a".repeat(65),
  ]) {
    expect(
      requestHandoffHandler(
        { desired_slug: badSlug, doc_path: "/p", target_session: "work" },
        bridge,
      ),
    ).rejects.toBeInstanceOf(BadParamsError);
  }
  expect(state.requestHandoffCalls).toEqual([]);
});

test("request_handoff throws rpc_failed when the bridge reports ok:false", async () => {
  const { bridge } = autopilotStubBridge({
    requestHandoff: { ok: false, error: "writer lock contention" },
  });
  expect(
    requestHandoffHandler(
      {
        desired_slug: "investigate-foo",
        doc_path: "/p",
        target_session: "work",
      },
      bridge,
    ),
  ).rejects.toThrow(/writer lock contention/);
});

test("request_handoff throws SlugConflictError when the bridge reports a collision", async () => {
  const { bridge } = autopilotStubBridge({
    requestHandoff: {
      ok: false,
      conflict: true,
      error: "handoff slug `investigate-foo` is already in use on this host",
    },
  });
  // A collision is DISTINCT from a generic failure — the typed error routes the
  // dispatcher to the `slug_conflict` wire code (→ CLI exit 3).
  const p = requestHandoffHandler(
    { desired_slug: "investigate-foo", doc_path: "/p", target_session: "work" },
    bridge,
  );
  expect(p).rejects.toBeInstanceOf(SlugConflictError);
  expect(p).rejects.toThrow(/already in use/);
});

// ---------------------------------------------------------------------------
// fn-661 task .4 — `retry_dispatch`
// ---------------------------------------------------------------------------

// The exhaustive validator-rule coverage lives in `test/dispatch-command.test.ts`
// (the dep-free leaf module). These two tests prove the rpc-handlers wrapper's
// CONTRACT: success returns the parsed pair, and a `{ ok: false }` from the
// leaf re-wraps into `BadParamsError` so the `bad_params` wire code is unchanged.
test("parseDispatchKey: splits the composite key into a typed {verb, id} pair", () => {
  expect(parseDispatchKey("work::fn-1-foo.3")).toEqual({
    verb: "work",
    id: "fn-1-foo.3",
  });
  expect(parseDispatchKey("close::fn-1-foo")).toEqual({
    verb: "close",
    id: "fn-1-foo",
  });
});

test("parseDispatchKey: re-wraps a leaf `{ok:false}` into BadParamsError", () => {
  for (const bad of [
    "",
    undefined,
    "no-sep",
    "rm::fn-1-foo",
    "work::fn-1::pwned",
    "work::../etc/passwd",
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

test("retry_dispatch accepts an `approve::id` clear and forwards it to the bridge (fn-870)", async () => {
  // The operator-clear path for a resurrected/phantom `approve` pending —
  // `bridge.retryDispatch` mints the `DispatchCleared` event the reducer folds
  // to DELETE the failure + counter + pending row.
  const { bridge, state } = autopilotStubBridge({});
  const result = await retryDispatchHandler(
    { id: "approve::fn-870-clear.1" },
    bridge,
  );
  expect(result).toEqual({ ok: true, verb: "approve", id: "fn-870-clear.1" });
  expect(state.retryCalls).toEqual([{ verb: "approve", id: "fn-870-clear.1" }]);
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

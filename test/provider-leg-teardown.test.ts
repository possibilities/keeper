import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  classifyProviderLegWindowTeardown,
  type ProviderLegCascadeDeps,
  runProviderLegCascadeSweep,
} from "../src/daemon";
import type { PaneInfo } from "../src/exec-backend";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;
let ts = 1_000;

beforeEach(() => {
  db = freshMemDb().db;
  ts = 1_000;
});

afterEach(() => db.close());

function event(
  hook: string,
  session: string,
  data: Record<string, unknown> = {},
  fields: { pid?: number; startTime?: string; harness?: "claude" | "pi" } = {},
): void {
  db.run(
    `INSERT INTO events
       (ts, session_id, pid, hook_event, event_type, data, start_time,
        spawn_name, harness, backend_exec_type, backend_exec_session_id,
        backend_exec_pane_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tmux', 'wrapped', '%5')`,
    [
      ts++,
      session,
      fields.pid ?? null,
      hook,
      hook,
      JSON.stringify(data),
      fields.startTime ?? null,
      session === "wrapper" ? "work::fn-1300-cascade.4" : "fn-1300-cascade.4",
      fields.harness ?? null,
    ],
  );
}

function drainAll(): void {
  while (drain(db) > 0) {
    // fold to head
  }
}

function seedOwnedLeg(legState: "working" | "stopped" | "ended"): void {
  event("Dispatched", "producer", {
    verb: "work",
    id: "fn-1300-cascade.4",
    dir: "/repo",
    ts,
    attempt_id: 7,
  });
  event(
    "SessionStart",
    "wrapper",
    { dispatch_attempt_id: 7 },
    { pid: 107, startTime: "linux:107", harness: "claude" },
  );
  event("DispatchClaimBound", "wrapper", {
    verb: "work",
    id: "fn-1300-cascade.4",
    expected_attempt_id: 7,
    session_id: "wrapper",
  });
  event(
    "SessionStart",
    "leg-session",
    {},
    { pid: 500, startTime: "linux:500", harness: "pi" },
  );
  event("ProviderLegBorn", "leg-session", {
    leg_launch_id: "leg-launch-1",
    wrapper_job_id: "wrapper",
    wrapper_dispatch_attempt_id: 7,
    leg_session_id: "leg-session",
    leg_pid: 500,
    leg_start_time: "linux:500",
    pane_id: "%5",
    pane_generation: "105:1005",
    backend_exec_type: "tmux",
    backend_exec_session_id: "wrapped",
  });
  if (legState === "stopped") {
    event("Stop", "leg-session", {}, { pid: 500, startTime: "linux:500" });
  } else if (legState === "ended") {
    event(
      "Killed",
      "leg-session",
      {
        pid: 500,
        start_time: "linux:500",
        close_kind: "pid_died",
        reason: "exit_watched",
      },
      { pid: 500, startTime: "linux:500" },
    );
  }
  drainAll();
}

const exactPane = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  tmuxGenerationId: "105:1005",
  paneId: "%5",
  windowId: "@5",
  currentCommand: "pi",
  paneDead: "0",
  sessionName: "wrapped",
  windowName: "display-name-is-not-authority",
  ...over,
});

function deps(killed: string[], panes: PaneInfo[]): ProviderLegCascadeDeps {
  return {
    nowSec: () => 2_000,
    probe: () => ({
      identity: "matching",
      identityReason: "matching",
      observedStartTime: "linux:500",
      command: "/opt/bin/pi\0--resume\0leg",
    }),
    probeRecordedIdentity: () => "gone",
    signal: () => {},
    listPanes: async () => panes,
    killWindow: async (paneId) => {
      killed.push(paneId);
      return { ok: true };
    },
    afterMint: drainAll,
  };
}

test("exit-confirmed owned leg tears down the birth-captured pane before claim release", async () => {
  seedOwnedLeg("ended");
  event("SessionEnd", "wrapper", {}, { pid: 107, startTime: "linux:107" });
  drainAll();
  expect(
    db
      .query(
        "SELECT backend_exec_pane_id FROM jobs WHERE job_id = 'leg-session'",
      )
      .get(),
  ).toEqual({ backend_exec_pane_id: null });

  const killed: string[] = [];
  const d = deps(killed, [exactPane()]);
  await runProviderLegCascadeSweep(db, d); // arm the exact owner incident
  await runProviderLegCascadeSweep(db, d); // confirm exit, close, confirm cascade

  expect(killed).toEqual(["%5"]);
  expect(
    db
      .query(
        "SELECT state FROM provider_leg_cascades WHERE leg_launch_id = 'leg-launch-1'",
      )
      .get(),
  ).toEqual({ state: "confirmed" });
  expect(
    db.query("SELECT state FROM dispatch_claims WHERE attempt_id = 7").get(),
  ).toEqual({ state: "released" });
});

test("owned idle-stopped cleanup uses the same leg-keyed birth coordinate without arming a terminal cascade", async () => {
  seedOwnedLeg("stopped");
  const killed: string[] = [];
  await runProviderLegCascadeSweep(db, deps(killed, [exactPane()]));
  expect(killed).toEqual(["%5"]);
  expect(
    db.query("SELECT COUNT(*) AS n FROM provider_leg_cascades").get(),
  ).toEqual({ n: 0 });
  expect(
    db.query("SELECT state FROM dispatch_claims WHERE attempt_id = 7").get(),
  ).toEqual({ state: "bound" });
});

test("a just-born owned leg is left running, not torn down mid-boot before it works", async () => {
  // The birth SessionStart seeds the leg at the jobs `state` default 'stopped',
  // but the leg is still booting its harness — lifting it to 'working' at birth
  // keeps the owner-alive window-teardown (which keys off leg_state 'stopped')
  // from killing a leg that has not yet had a chance to run.
  seedOwnedLeg("working");
  expect(
    db.query("SELECT state FROM jobs WHERE job_id = 'leg-session'").get(),
  ).toEqual({ state: "working" });

  const killed: string[] = [];
  await runProviderLegCascadeSweep(db, deps(killed, [exactPane()]));
  expect(killed).toEqual([]);
  expect(
    db.query("SELECT state FROM dispatch_claims WHERE attempt_id = 7").get(),
  ).toEqual({ state: "bound" });
});

test("window teardown gates birth coordinates on canonical generation, wrapped session, and one pane", () => {
  const row = {
    pane_id: "%5",
    pane_generation: "105:1005",
    backend_exec_type: "tmux",
    backend_exec_session_id: "wrapped",
  };
  expect(classifyProviderLegWindowTeardown(row, [exactPane()])).toBe("kill");
  expect(
    classifyProviderLegWindowTeardown(row, [
      exactPane(),
      exactPane({ paneId: "%6", windowId: "@5" }),
    ]),
  ).toBe("defer");
  expect(
    classifyProviderLegWindowTeardown(row, [
      exactPane({ tmuxGenerationId: "106:1006" }),
    ]),
  ).toBe("converged");
  expect(classifyProviderLegWindowTeardown(row, null)).toBe("defer");
});

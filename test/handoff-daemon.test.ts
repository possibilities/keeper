import { expect, test } from "bun:test";
import {
  admitHandoffDispatchingLaunch,
  drainToCompletion,
} from "../src/daemon";
import { freshMemDb } from "./helpers/template-db";

interface HandoffRow {
  status: string;
  last_event_id: number | null;
  never_bound_count: number;
  callee_job_id: string | null;
}

function createHarness(): {
  close: () => void;
  requestHandoff: (handoffId: string) => number;
  admitDispatching: (handoffId: string) => { ok: boolean; markerId: number };
  bindHandoff: (handoffId: string, calleeJobId: string) => number;
  readHandoff: (handoffId: string) => HandoffRow | undefined;
  eventHook: (eventId: number) => string | undefined;
} {
  const kdb = freshMemDb();
  let ts = 1_700_000_000;
  const insertEvent = (args: {
    hookEvent: string;
    eventType?: string;
    sessionId: string;
    data?: string;
    spawnName?: string | null;
  }): number => {
    const inserted = kdb.stmts.insertEvent.run({
      $ts: ts++,
      $session_id: args.sessionId,
      $pid: null,
      $hook_event: args.hookEvent,
      $event_type: args.eventType ?? args.hookEvent,
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: args.data ?? "{}",
      $subagent_agent_id: null,
      $spawn_name: args.spawnName ?? null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $plan_op: null,
      $plan_target: null,
      $plan_epic_id: null,
      $plan_task_id: null,
      $plan_subject_present: null,
      $tool_use_id: null,
      $config_dir: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $plan_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
      $background_task_id: null,
      $mutation_path: null,
      $worktree: null,
      $harness: null,
      $resume_target: null,
      $adopted: null,
      $account_route: null,
    });
    return Number(inserted.lastInsertRowid);
  };
  const readHandoff = (handoffId: string): HandoffRow | undefined =>
    kdb.db
      .query(
        `SELECT status, last_event_id, never_bound_count, callee_job_id
           FROM handoffs WHERE handoff_id = ?`,
      )
      .get(handoffId) as HandoffRow | undefined;
  return {
    close: () => kdb.db.close(),
    requestHandoff: (handoffId) => {
      const eventId = insertEvent({
        hookEvent: "HandoffRequested",
        eventType: "handoffs",
        sessionId: handoffId,
        data: JSON.stringify({ handoff_id: handoffId, doc: "brief" }),
      });
      drainToCompletion(kdb.db);
      return eventId;
    },
    admitDispatching: (handoffId) => {
      let markerId = 0;
      const ok = admitHandoffDispatchingLaunch(handoffId, {
        insertMarker: () => {
          markerId = insertEvent({
            hookEvent: "HandoffDispatching",
            eventType: "handoffs",
            sessionId: handoffId,
            data: JSON.stringify({ handoff_id: handoffId }),
          });
          return markerId;
        },
        pump: () => drainToCompletion(kdb.db),
        readProjection: readHandoff,
      });
      return { ok, markerId };
    },
    bindHandoff: (handoffId, calleeJobId) => {
      const eventId = insertEvent({
        hookEvent: "SessionStart",
        sessionId: calleeJobId,
        spawnName: `handoff::${handoffId}`,
      });
      drainToCompletion(kdb.db);
      return eventId;
    },
    readHandoff,
    eventHook: (eventId) =>
      (
        kdb.db
          .query("SELECT hook_event FROM events WHERE id = ?")
          .get(eventId) as { hook_event: string } | undefined
      )?.hook_event,
  };
}

test("handoff dispatch admission accepts the current folded dispatching marker", () => {
  const h = createHarness();
  try {
    h.requestHandoff("admit-ok");

    const admission = h.admitDispatching("admit-ok");

    expect(admission.ok).toBe(true);
    expect(h.eventHook(admission.markerId)).toBe("HandoffDispatching");
    expect(h.readHandoff("admit-ok")).toMatchObject({
      status: "dispatching",
      last_event_id: admission.markerId,
      never_bound_count: 1,
    });
  } finally {
    h.close();
  }
});

test("handoff dispatch admission denies the third marker when the breaker trips", () => {
  const h = createHarness();
  try {
    h.requestHandoff("admit-breaker");
    expect(h.admitDispatching("admit-breaker").ok).toBe(true);
    expect(h.admitDispatching("admit-breaker").ok).toBe(true);

    const third = h.admitDispatching("admit-breaker");

    expect(third.ok).toBe(false);
    expect(h.eventHook(third.markerId)).toBe("HandoffDispatching");
    expect(h.readHandoff("admit-breaker")).toMatchObject({
      status: "failed",
      last_event_id: third.markerId,
      never_bound_count: 3,
    });
  } finally {
    h.close();
  }
});

test("handoff dispatch admission denies a late marker after bind", () => {
  const h = createHarness();
  try {
    h.requestHandoff("admit-bound");
    expect(h.admitDispatching("admit-bound").ok).toBe(true);
    const bindEventId = h.bindHandoff("admit-bound", "callee-bound");

    const late = h.admitDispatching("admit-bound");

    expect(late.ok).toBe(false);
    expect(h.eventHook(late.markerId)).toBe("HandoffDispatching");
    expect(h.readHandoff("admit-bound")).toMatchObject({
      status: "bound",
      callee_job_id: "callee-bound",
      last_event_id: bindEventId,
      never_bound_count: 0,
    });
  } finally {
    h.close();
  }
});

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HarnessProcessObservation } from "../src/commit-work/process-identity";
import {
  classifyProviderLegProbe,
  PROVIDER_LEG_KILL_ATTEMPT_CAP,
  PROVIDER_LEG_TERM_GRACE_SEC,
  type ProviderLegCascadeDeps,
  runProviderLegCascadeSweep,
} from "../src/daemon";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;
let ts = 1_000;

beforeEach(() => {
  db = freshMemDb().db;
  ts = 1_000;
});

afterEach(() => db.close());

function event(input: {
  hook: string;
  session?: string;
  pid?: number | null;
  startTime?: string | null;
  spawnName?: string | null;
  harness?: "claude" | "pi" | null;
  data?: Record<string, unknown>;
}): number {
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, data, start_time,
       spawn_name, harness
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts++,
      input.session ?? "producer",
      input.pid ?? null,
      input.hook,
      input.hook,
      JSON.stringify(input.data ?? {}),
      input.startTime ?? null,
      input.spawnName ?? null,
      input.harness ?? null,
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

function drainAll(): void {
  while (drain(db) > 0) {
    // fold to head
  }
}

function seedAttempt(input: {
  task: string;
  attempt: number;
  wrapper: string;
  wrapperState?: "working" | "ended" | "killed";
  legs: Array<{ id: string; session: string; pid: number }>;
}): number[] {
  event({
    hook: "Dispatched",
    data: {
      verb: "work",
      id: input.task,
      dir: "/repo",
      ts,
      attempt_id: input.attempt,
    },
  });
  event({
    hook: "SessionStart",
    session: input.wrapper,
    pid: input.attempt + 100,
    startTime: `linux:${input.attempt + 1000}`,
    spawnName: `work::${input.task}`,
    harness: "claude",
    data: { dispatch_attempt_id: input.attempt },
  });
  event({
    hook: "DispatchClaimBound",
    session: input.wrapper,
    data: {
      verb: "work",
      id: input.task,
      expected_attempt_id: input.attempt,
      session_id: input.wrapper,
    },
  });
  const epochs: number[] = [];
  for (const leg of input.legs) {
    event({
      hook: "SessionStart",
      session: leg.session,
      pid: leg.pid,
      startTime: `linux:${leg.pid * 10}`,
      spawnName: input.task,
      harness: "pi",
    });
    epochs.push(
      event({
        hook: "ProviderLegBorn",
        session: leg.session,
        data: {
          leg_launch_id: leg.id,
          wrapper_job_id: input.wrapper,
          wrapper_dispatch_attempt_id: input.attempt,
          leg_session_id: leg.session,
          leg_pid: leg.pid,
          leg_start_time: `linux:${leg.pid * 10}`,
          pane_id: `%${leg.pid}`,
          pane_generation: "tmux-old",
        },
      }),
    );
  }
  drainAll();
  if (input.wrapperState === "ended") {
    event({
      hook: "SessionEnd",
      session: input.wrapper,
      pid: input.attempt + 100,
      startTime: `linux:${input.attempt + 1000}`,
    });
    drainAll();
  } else if (input.wrapperState === "killed") {
    event({
      hook: "Killed",
      session: input.wrapper,
      data: {
        pid: input.attempt + 100,
        start_time: `linux:${input.attempt + 1000}`,
        close_kind: "pid_died",
        reason: "exit_watched",
      },
    });
    drainAll();
  }
  return epochs;
}

const matching: HarnessProcessObservation = {
  identity: "matching",
  identityReason: "matching",
  observedStartTime: "linux:5000",
  command: "/opt/bin/pi\0--resume\0leg",
};

function deps(overrides: Partial<ProviderLegCascadeDeps> = {}) {
  let now = 2_000;
  const signals: Array<{ pid: number; signal: string }> = [];
  const pages: string[] = [];
  const value: ProviderLegCascadeDeps & {
    signals: typeof signals;
    pages: typeof pages;
    advance(seconds: number): void;
  } = {
    nowSec: () => now,
    probe: () => matching,
    signal: (pid, signal) => signals.push({ pid, signal }),
    notify: (message) => {
      pages.push(message);
      return true;
    },
    afterMint: drainAll,
    signals,
    pages,
    advance: (seconds) => {
      now += seconds;
    },
    ...overrides,
  };
  return value;
}

function cascade(id: string) {
  return db
    .query("SELECT * FROM provider_leg_cascades WHERE leg_launch_id = ?")
    .get(id) as Record<string, unknown> | null;
}

function ownership(id: string) {
  return db
    .query("SELECT * FROM provider_leg_ownership WHERE leg_launch_id = ?")
    .get(id) as Record<string, unknown>;
}

test("terminal owner cascades TERM then KILL, confirms exit, and releases after restart boundaries", async () => {
  seedAttempt({
    task: "fn-1300-cascade.1",
    attempt: 10,
    wrapper: "wrapper-10",
    wrapperState: "killed",
    legs: [{ id: "leg-10", session: "leg-session-10", pid: 500 }],
  });
  const d = deps();

  await runProviderLegCascadeSweep(db, d); // durable arm
  expect(cascade("leg-10")).toMatchObject({
    state: "armed",
    kill_not_before: 2_000 + PROVIDER_LEG_TERM_GRACE_SEC,
  });

  // A fresh call has no process-local memo: this is the daemon-restart seam.
  await runProviderLegCascadeSweep(db, d);
  expect(d.signals).toEqual([{ pid: 500, signal: "SIGTERM" }]);
  await runProviderLegCascadeSweep(db, d); // restart before the deadline
  expect(d.signals).toEqual([{ pid: 500, signal: "SIGTERM" }]);
  d.advance(PROVIDER_LEG_TERM_GRACE_SEC);
  await runProviderLegCascadeSweep(db, d); // durable KILL arm
  await runProviderLegCascadeSweep(db, d); // first KILL
  expect(d.signals).toEqual([
    { pid: 500, signal: "SIGTERM" },
    { pid: 500, signal: "SIGKILL" },
  ]);

  d.probe = () => ({
    identity: "gone",
    identityReason: "esrch",
    observedStartTime: null,
    command: null,
  });
  let crashBeforeRelease = true;
  d.afterMint = () => {
    drainAll();
    if (crashBeforeRelease && cascade("leg-10")?.state === "confirmed") {
      crashBeforeRelease = false;
      throw new Error("crash after confirmation before release");
    }
  };
  await expect(runProviderLegCascadeSweep(db, d)).rejects.toThrow(
    "crash after confirmation before release",
  );
  expect(ownership("leg-10").state).toBe("terminal");
  expect(cascade("leg-10")?.state).toBe("confirmed");
  expect(
    db.query("SELECT state FROM dispatch_claims WHERE attempt_id = 10").get(),
  ).toEqual({ state: "bound" });

  d.afterMint = drainAll;
  await runProviderLegCascadeSweep(db, d);
  expect(
    db.query("SELECT state FROM dispatch_claims WHERE attempt_id = 10").get(),
  ).toEqual({ state: "released" });
});

test("write-ahead interruption never loses teardown and duplicate ticks preserve ordinals", async () => {
  seedAttempt({
    task: "fn-1300-interrupt.1",
    attempt: 20,
    wrapper: "wrapper-20",
    wrapperState: "ended",
    legs: [{ id: "leg-20", session: "leg-session-20", pid: 600 }],
  });
  const d = deps();
  await runProviderLegCascadeSweep(db, d);

  let crash = true;
  d.afterMint = () => {
    drainAll();
    if (crash && cascade("leg-20")?.term_attempts === 1) {
      crash = false;
      throw new Error("crash after TERM write-ahead");
    }
  };
  await expect(runProviderLegCascadeSweep(db, d)).rejects.toThrow(
    "crash after TERM write-ahead",
  );
  expect(d.signals).toEqual([]);
  expect(cascade("leg-20")?.term_attempts).toBe(1);

  d.afterMint = drainAll;
  d.advance(PROVIDER_LEG_TERM_GRACE_SEC);
  await runProviderLegCascadeSweep(db, d); // KILL arm
  let crashAfterKillWriteAhead = true;
  d.afterMint = () => {
    drainAll();
    if (crashAfterKillWriteAhead && cascade("leg-20")?.kill_attempts === 1) {
      crashAfterKillWriteAhead = false;
      throw new Error("crash after KILL write-ahead");
    }
  };
  await expect(runProviderLegCascadeSweep(db, d)).rejects.toThrow(
    "crash after KILL write-ahead",
  );
  expect(d.signals).toEqual([]);
  d.afterMint = drainAll;
  await runProviderLegCascadeSweep(db, d); // next ordinal after restart
  expect(d.signals).toEqual([{ pid: 600, signal: "SIGKILL" }]);
  expect(cascade("leg-20")?.kill_attempts).toBe(2);
});

test("superseded authority cascades only the old attempt and refuses release of the moved claim", async () => {
  seedAttempt({
    task: "fn-1300-super.1",
    attempt: 30,
    wrapper: "wrapper-old",
    legs: [{ id: "leg-old", session: "leg-session-old", pid: 700 }],
  });
  event({
    hook: "DispatchClaimSuperseded",
    data: {
      verb: "work",
      id: "fn-1300-super.1",
      expected_attempt_id: 30,
      next_attempt_id: 31,
      dir: "/repo",
    },
  });
  drainAll();
  seedAttempt({
    task: "fn-1300-super.1",
    attempt: 31,
    wrapper: "wrapper-new",
    legs: [{ id: "leg-new", session: "leg-session-new", pid: 701 }],
  });
  const d = deps();
  await runProviderLegCascadeSweep(db, d);
  await runProviderLegCascadeSweep(db, d);

  expect(cascade("leg-old")).not.toBeNull();
  expect(cascade("leg-new")).toBeNull();
  expect(d.signals).toEqual([{ pid: 700, signal: "SIGTERM" }]);
  expect(
    db
      .query(
        "SELECT attempt_id, state, session_id FROM dispatch_claims WHERE verb = 'work' AND id = 'fn-1300-super.1'",
      )
      .get(),
  ).toEqual({ attempt_id: 31, state: "bound", session_id: "wrapper-new" });
});

test("multi-leg partial settlement holds release and blocked paging is level-rearmed", async () => {
  seedAttempt({
    task: "fn-1300-multi.1",
    attempt: 40,
    wrapper: "wrapper-40",
    wrapperState: "ended",
    legs: [
      { id: "leg-gone", session: "leg-session-gone", pid: 800 },
      { id: "leg-unknown", session: "leg-session-unknown", pid: 801 },
    ],
  });
  const d = deps({
    probe: (pid) =>
      pid === 800
        ? {
            identity: "gone",
            identityReason: "esrch",
            observedStartTime: null,
            command: null,
          }
        : {
            identity: "inconclusive",
            identityReason: "unreadable",
            observedStartTime: null,
            command: null,
          },
  });
  await runProviderLegCascadeSweep(db, d); // arm both
  await runProviderLegCascadeSweep(db, d); // settle one, block/page one
  await runProviderLegCascadeSweep(db, d); // duplicate blocked tick
  expect(ownership("leg-gone").state).toBe("terminal");
  expect(ownership("leg-unknown").state).toBe("live");
  expect(d.pages).toHaveLength(1);
  expect(
    db.query("SELECT state FROM dispatch_claims WHERE attempt_id = 40").get(),
  ).toEqual({ state: "bound" });

  d.probe = () => matching;
  await runProviderLegCascadeSweep(db, d); // positive level-clear
  expect(cascade("leg-unknown")).toMatchObject({
    state: "armed",
    human_notified_at: null,
  });
  d.probe = () => ({
    identity: "inconclusive",
    identityReason: "unreadable",
    observedStartTime: null,
    command: null,
  });
  await runProviderLegCascadeSweep(db, d);
  expect(d.pages).toHaveLength(2);
});

test("signals require the adjacent exact probe and close recycle needs corroboration", async () => {
  expect(
    classifyProviderLegProbe(
      {
        identity: "gone",
        identityReason: "start_mismatch",
        observedStartTime: "darwin:Wed Jul  3 12:00:01 2026",
        command: "/opt/bin/pi --resume other",
      },
      {
        harness: "pi",
        recordedStartTime: "darwin:Wed Jul  3 12:00:00 2026",
        recordedPaneGeneration: "g1",
        currentPaneGeneration: "g1",
      },
    ),
  ).toBe("identity-unknown");
  expect(
    classifyProviderLegProbe(
      {
        identity: "gone",
        identityReason: "start_mismatch",
        observedStartTime: "darwin:Wed Jul  3 12:00:01 2026",
        command: "/usr/bin/python worker.py",
      },
      {
        harness: "pi",
        recordedStartTime: "darwin:Wed Jul  3 12:00:00 2026",
        recordedPaneGeneration: "g1",
        currentPaneGeneration: "g1",
      },
    ),
  ).toBe("gone");

  seedAttempt({
    task: "fn-1300-reprobe.1",
    attempt: 50,
    wrapper: "wrapper-50",
    wrapperState: "ended",
    legs: [{ id: "leg-50", session: "leg-session-50", pid: 900 }],
  });
  let probes = 0;
  const d = deps({
    probe: () => {
      probes += 1;
      return probes === 1
        ? matching
        : {
            identity: "gone",
            identityReason: "start_mismatch",
            observedStartTime: "linux:9001",
            command: "/opt/bin/pi --resume recycled",
          };
    },
  });
  await runProviderLegCascadeSweep(db, d); // arm
  await runProviderLegCascadeSweep(db, d); // selection passes; adjacent fails
  expect(d.signals).toEqual([]);
  expect(cascade("leg-50")).toMatchObject({
    state: "blocked",
    blocked_reason: "identity-unknown",
  });
});

test("signal syscall failure is persisted and paged instead of skipped", async () => {
  seedAttempt({
    task: "fn-1300-signal-failure.1",
    attempt: 55,
    wrapper: "wrapper-55",
    wrapperState: "ended",
    legs: [{ id: "leg-55", session: "leg-session-55", pid: 950 }],
  });
  const d = deps({
    signal: () => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    },
  });
  await runProviderLegCascadeSweep(db, d); // arm
  await runProviderLegCascadeSweep(db, d); // TERM attempt fails
  expect(cascade("leg-55")).toMatchObject({
    state: "blocked",
    blocked_reason: "signal-failed",
    term_attempts: 1,
  });
  expect(d.pages).toHaveLength(1);
});

test("the leg's own folded terminal event confirms exit without a signal", async () => {
  seedAttempt({
    task: "fn-1300-own-terminal.1",
    attempt: 56,
    wrapper: "wrapper-56",
    wrapperState: "ended",
    legs: [{ id: "leg-56", session: "leg-session-56", pid: 960 }],
  });
  const d = deps({
    probe: () => {
      throw new Error("terminal fold must win before probing");
    },
    signal: () => {
      throw new Error("terminal fold must never be signalled");
    },
  });
  await runProviderLegCascadeSweep(db, d); // arm
  event({ hook: "SessionEnd", session: "leg-session-56", pid: 960 });
  drainAll();
  await runProviderLegCascadeSweep(db, d);
  expect(ownership("leg-56").state).toBe("terminal");
  expect(cascade("leg-56")?.state).toBe("confirmed");
});

test("unconfirmed KILL obeys the durable attempt cap and pages once", async () => {
  seedAttempt({
    task: "fn-1300-cap.1",
    attempt: 60,
    wrapper: "wrapper-60",
    wrapperState: "ended",
    legs: [{ id: "leg-60", session: "leg-session-60", pid: 1_000 }],
  });
  const d = deps();
  await runProviderLegCascadeSweep(db, d); // arm
  await runProviderLegCascadeSweep(db, d); // TERM
  d.advance(PROVIDER_LEG_TERM_GRACE_SEC);
  await runProviderLegCascadeSweep(db, d); // KILL arm
  for (let i = 0; i < PROVIDER_LEG_KILL_ATTEMPT_CAP; i += 1) {
    await runProviderLegCascadeSweep(db, d);
  }
  await runProviderLegCascadeSweep(db, d); // cap -> blocked
  await runProviderLegCascadeSweep(db, d); // duplicate tick
  expect(cascade("leg-60")).toMatchObject({
    state: "blocked",
    blocked_reason: "kill-unconfirmed",
    kill_attempts: PROVIDER_LEG_KILL_ATTEMPT_CAP,
  });
  expect(d.pages).toHaveLength(1);
});

test("closing posture orders terminal proof before cascade and release", async () => {
  seedAttempt({
    task: "fn-1300-order.1",
    attempt: 70,
    wrapper: "wrapper-70",
    wrapperState: "ended",
    legs: [{ id: "leg-70", session: "leg-session-70", pid: 1_100 }],
  });
  const d = deps({
    probe: () => ({
      identity: "gone",
      identityReason: "esrch",
      observedStartTime: null,
      command: null,
    }),
  });
  await runProviderLegCascadeSweep(db, d); // arm
  await runProviderLegCascadeSweep(db, d); // settle + release
  const rows = db
    .query(
      `SELECT id, hook_event FROM events
        WHERE session_id IN ('wrapper-70', 'leg-70', 'leg-session-70')
          AND hook_event IN (
            'SessionEnd', 'ProviderLegCascadeArmed',
            'ProviderLegExitConfirmed', 'ProviderLegCascadeProgressed',
            'DispatchClaimReleased'
          ) ORDER BY id`,
    )
    .all() as Array<{ id: number; hook_event: string }>;
  const id = (hook: string) =>
    rows.find((row) => row.hook_event === hook)?.id ?? Number.POSITIVE_INFINITY;
  expect(id("SessionEnd")).toBeLessThan(id("ProviderLegCascadeArmed"));
  expect(id("ProviderLegCascadeArmed")).toBeLessThan(
    id("ProviderLegExitConfirmed"),
  );
  expect(id("ProviderLegExitConfirmed")).toBeLessThan(
    id("DispatchClaimReleased"),
  );
});

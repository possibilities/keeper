import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  AWAIT_LEASE_TTL_MS,
  type AwaitDispatchDeps,
  type AwaitDispatchRow,
  decideAwaitAction,
  dispatchOneAwait,
  evaluateDurableAwaitConditions,
  NEVER_BOUND_AWAIT_THRESHOLD,
} from "../src/await-worker";
import {
  INSTANT_DEATH_BREAKER_REASON,
  MERGE_ESCALATION_REASON_TOKEN,
  WORKTREE_FINALIZE_NON_FF_REASON,
} from "../src/dispatch-failure-key";
import type { LaunchResult } from "../src/exec-backend";
import {
  DURABLE_AWAIT_CONDITION_KINDS,
  type DurableAwaitCondition,
} from "../src/protocol";
import { freshMemDb } from "./helpers/template-db";

const NOW = 1_700_000_000_000;

function row(over: Partial<AwaitDispatchRow> = {}): AwaitDispatchRow {
  return {
    await_id: "await-1",
    condition_spec: JSON.stringify([{ condition: "landed", target: "fn-1" }]),
    follow_up: "continue after landing",
    target_session: "work",
    target_dir: null,
    timeout_at: null,
    status: "waiting",
    claimed_at: null,
    attempt_count: 0,
    never_bound_count: 0,
    ...over,
  };
}

type AwaitVerdict = "met" | "waiting" | "unknown";

function evalOne(db: Database, condition: DurableAwaitCondition): AwaitVerdict {
  return evaluateDurableAwaitConditions(db, JSON.stringify([condition]));
}

function freshAwaitDb(): Database {
  const { db } = freshMemDb();
  db.run("UPDATE git_projection_state SET seed_required = 0 WHERE id = 1");
  return db;
}

function seedEpic(
  db: Database,
  opts: {
    epicId?: string;
    status?: string | null;
    question?: string | null;
    lastValidatedAt?: string | null;
    task?: Record<string, unknown>;
  } = {},
): void {
  const epicId = opts.epicId ?? "fn-1-demo";
  const task = opts.task ?? {
    task_id: `${epicId}.1`,
    title: "Task",
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    jobs: [],
    target_repo: "/repo",
  };
  db.run(
    `INSERT INTO epics (
       epic_id, epic_number, title, project_dir, status, last_event_id,
       updated_at, last_validated_at, tasks, question
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      epicId,
      1,
      "Demo",
      "/repo",
      opts.status ?? "open",
      1,
      1,
      opts.lastValidatedAt === undefined ? "validated" : opts.lastValidatedAt,
      JSON.stringify([task]),
      opts.question ?? null,
    ],
  );
}

function seedWorkingJob(db: Database, id: string, cwd: string): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id, updated_at, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 1, cwd, 123, "working", 1, 1, id],
  );
}

const durableAwaitCases: Array<{
  kind: string;
  seedMet: (db: Database) => void;
  met: DurableAwaitCondition;
  seedWaiting?: (db: Database) => void;
  waiting: DurableAwaitCondition;
  unknown: DurableAwaitCondition;
}> = [
  {
    kind: "complete",
    seedMet: (db) =>
      seedEpic(db, {
        status: "done",
        task: {
          task_id: "fn-1-demo.1",
          title: "Task",
          worker_phase: "done",
          runtime_status: "done",
          depends_on: [],
          jobs: [],
          target_repo: "/repo",
        },
      }),
    met: { condition: "complete", target: "fn-1-demo.1" },
    seedWaiting: (db) => seedEpic(db),
    waiting: { condition: "complete", target: "fn-1-demo.1" },
    unknown: { condition: "complete" },
  },
  {
    kind: "unblocked",
    seedMet: (db) => seedEpic(db),
    met: { condition: "unblocked", target: "fn-1-demo.1" },
    seedWaiting: (db) => seedEpic(db, { lastValidatedAt: null }),
    waiting: { condition: "unblocked", target: "fn-1-demo.1" },
    unknown: { condition: "unblocked" },
  },
  {
    kind: "started",
    seedMet: (db) =>
      seedEpic(db, {
        task: {
          task_id: "fn-1-demo.1",
          title: "Task",
          worker_phase: "open",
          runtime_status: "in_progress",
          depends_on: [],
          jobs: [],
          target_repo: "/repo",
        },
      }),
    met: { condition: "started", target: "fn-1-demo.1" },
    seedWaiting: (db) => seedEpic(db),
    waiting: { condition: "started", target: "fn-1-demo.1" },
    unknown: { condition: "started" },
  },
  {
    kind: "git-clean",
    seedMet: () => {},
    met: { condition: "git-clean", git_root: "/repo" },
    seedWaiting: (db) =>
      db.run(
        `INSERT INTO git_status (project_dir, dirty_count, orphaned_count, last_event_id, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ["/repo", 1, 0, 1, 1],
      ),
    waiting: { condition: "git-clean", git_root: "/repo" },
    unknown: { condition: "git-clean", target: "fn-1-demo", git_root: "/repo" },
  },
  {
    kind: "agents-idle",
    seedMet: () => {},
    met: { condition: "agents-idle", git_root: "/repo" },
    seedWaiting: (db) => seedWorkingJob(db, "job-busy", "/repo/subdir"),
    waiting: { condition: "agents-idle", git_root: "/repo" },
    unknown: { condition: "agents-idle" },
  },
  {
    kind: "drained",
    seedMet: (db) => seedWorkingJob(db, "external", "/repo"),
    met: { condition: "drained" },
    seedWaiting: (db) => seedWorkingJob(db, "external", "/repo"),
    waiting: { condition: "drained", scope: "board" },
    unknown: { condition: "drained", scope: "everything" },
  },
  {
    kind: "landed",
    seedMet: (db) => {
      db.run(
        `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at, worktree_mode)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [1, 1, 1, 1, 1, 1],
      );
      db.run(
        `INSERT INTO lane_merged (epic_id, repo_dir, last_event_id, updated_at)
           VALUES (?, ?, ?, ?)`,
        ["fn-1-demo", "/repo", 1, 1],
      );
    },
    met: { condition: "landed", target: "fn-1-demo" },
    seedWaiting: (db) => seedEpic(db),
    waiting: { condition: "landed", target: "fn-1-demo" },
    unknown: { condition: "landed" },
  },
  {
    kind: "dead-letter",
    seedMet: (db) =>
      db.run(
        `INSERT INTO dead_letters (dl_id, session_id, hook_event, ts, dl_written_at, bindings)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ["dl-1", "s", "Hook", 1, 1, "{}"],
      ),
    met: { condition: "dead-letter" },
    waiting: { condition: "dead-letter" },
    unknown: { condition: "dead-letter", since: 1 },
  },
  {
    kind: "block-escalation",
    seedMet: (db) =>
      db.run(
        `INSERT INTO block_escalations (epic_id, task_id, blocked_since, status, outcome, last_event_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ["fn-1-demo", "fn-1-demo.1", 1, "open", null, 1],
      ),
    met: { condition: "block-escalation" },
    waiting: { condition: "block-escalation" },
    unknown: { condition: "block-escalation", since: 1 },
  },
  {
    kind: "parked-question",
    seedMet: (db) => seedEpic(db, { question: "Which way, human?" }),
    met: { condition: "parked-question" },
    waiting: { condition: "parked-question" },
    unknown: { condition: "parked-question", since: 1 },
  },
  {
    kind: "stuck-dispatch",
    seedMet: (db) =>
      db.run(
        `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "close",
          "fn-1-demo",
          MERGE_ESCALATION_REASON_TOKEN,
          "/repo",
          1,
          1,
          1,
          1,
        ],
      ),
    met: { condition: "stuck-dispatch" },
    waiting: { condition: "stuck-dispatch" },
    unknown: { condition: "stuck-dispatch", since: 1 },
  },
  {
    kind: "finalize-non-ff",
    seedMet: (db) =>
      db.run(
        `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "close",
          "worktree-finalize:fn-1-demo-repo",
          WORKTREE_FINALIZE_NON_FF_REASON,
          "/repo",
          1,
          1,
          1,
          1,
        ],
      ),
    met: { condition: "finalize-non-ff" },
    waiting: { condition: "finalize-non-ff" },
    unknown: { condition: "finalize-non-ff", since: 1 },
  },
  {
    kind: "instant-death-wall",
    seedMet: (db) => {
      for (const id of ["work::fn-1-demo.1", "work::fn-1-demo.2"]) {
        db.run(
          `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["work", id, INSTANT_DEATH_BREAKER_REASON, "/repo", 1, 1, 1, 1],
        );
      }
    },
    met: { condition: "instant-death-wall" },
    seedWaiting: (db) =>
      db.run(
        `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "work",
          "work::fn-1-demo.1",
          INSTANT_DEATH_BREAKER_REASON,
          "/repo",
          1,
          1,
          1,
          1,
        ],
      ),
    waiting: { condition: "instant-death-wall" },
    unknown: { condition: "instant-death-wall", since: 1 },
  },
  {
    kind: "needs-human",
    seedMet: (db) =>
      db.run(
        `INSERT INTO dead_letters (dl_id, session_id, hook_event, ts, dl_written_at, bindings)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ["dl-1", "s", "Hook", 1, 1, "{}"],
      ),
    met: { condition: "needs-human" },
    waiting: { condition: "needs-human" },
    unknown: { condition: "needs-human", since: 1 },
  },
];

test("evaluateDurableAwaitConditions covers every server-side condition kind", () => {
  expect(durableAwaitCases.map(({ kind }) => kind).sort()).toEqual(
    [...DURABLE_AWAIT_CONDITION_KINDS].sort(),
  );

  for (const c of durableAwaitCases) {
    const metDb = freshAwaitDb();
    c.seedMet(metDb);
    expect(evalOne(metDb, c.met), `${c.kind} met`).toBe("met");

    const waitingDb = freshAwaitDb();
    (c.seedWaiting ?? (() => {}))(waitingDb);
    expect(evalOne(waitingDb, c.waiting), `${c.kind} waiting`).toBe("waiting");

    const unknownDb = freshAwaitDb();
    expect(evalOne(unknownDb, c.unknown), `${c.kind} unknown`).toBe("unknown");
  }
});

test("evaluateDurableAwaitConditions routes dotted targets as tasks and bare targets as epics", () => {
  const db = freshAwaitDb();
  seedEpic(db, {
    status: "open",
    task: {
      task_id: "fn-1-demo.1",
      title: "Task",
      worker_phase: "done",
      runtime_status: "done",
      depends_on: [],
      jobs: [],
      target_repo: "/repo",
    },
  });

  expect(evalOne(db, { condition: "complete", target: "fn-1-demo.1" })).toBe(
    "met",
  );
  expect(evalOne(db, { condition: "complete", target: "fn-1-demo" })).toBe(
    "waiting",
  );
});

test("waiting rows are never leased; a met condition claims firing", () => {
  expect(decideAwaitAction(row(), "waiting", NOW)).toMatchObject({
    kind: "skip",
    reason: "condition-waiting",
  });
  expect(decideAwaitAction(row(), "met", NOW)).toMatchObject({ kind: "fire" });
});

test("only firing leases reclaim after expiry", () => {
  const fresh = decideAwaitAction(
    row({ status: "firing", claimed_at: NOW / 1000 }),
    "waiting",
    NOW,
  );
  expect(fresh).toMatchObject({ kind: "skip", reason: "firing-fresh" });
  const reclaimed = decideAwaitAction(
    row({
      status: "firing",
      claimed_at: (NOW - AWAIT_LEASE_TTL_MS) / 1000,
    }),
    "waiting",
    NOW,
  );
  expect(reclaimed).toMatchObject({ kind: "refire" });
});

test("a bound firing intent completes instead of re-firing its stable effect", () => {
  expect(
    decideAwaitAction(
      row({ status: "firing", claimed_at: 1 }),
      "waiting",
      NOW,
      true,
    ),
  ).toMatchObject({ kind: "done" });
});

test("the never-bound breaker terminalizes instead of retrying forever", () => {
  const action = decideAwaitAction(
    row({
      status: "firing",
      never_bound_count: NEVER_BOUND_AWAIT_THRESHOLD,
      claimed_at: 1,
    }),
    "waiting",
    NOW,
  );
  expect(action).toMatchObject({
    kind: "failed",
    reason: "durable await never-bound breaker tripped",
  });
});

test("timeout before a met condition is terminal", () => {
  expect(
    decideAwaitAction(row({ timeout_at: (NOW - 1) / 1000 }), "waiting", NOW),
  ).toMatchObject({ kind: "timed_out" });
});

test("an unknown condition terminal-fails without a retry loop", () => {
  expect(decideAwaitAction(row(), "unknown", NOW)).toMatchObject({
    kind: "failed",
    reason: "unknown durable await condition",
  });
});

test("redelivery has one idempotent effect identity", async () => {
  const effects = new Set<string>();
  const launchNames: string[] = [];
  const terminals: string[] = [];
  const deps: AwaitDispatchDeps = {
    emitFiring: async () => ({ ok: true }),
    emitTerminal: (kind) => terminals.push(kind),
    launch: async (_session, _cwd, spec): Promise<LaunchResult> => {
      const name = spec.claudeName ?? "";
      launchNames.push(name);
      effects.add(name); // launcher-side idempotency is keyed by the stable intent id.
      return { ok: true };
    },
  };
  const signal = new AbortController().signal;
  await dispatchOneAwait(row({ await_id: "a-stable" }), "/repo", signal, deps);
  await dispatchOneAwait(
    row({ status: "firing", await_id: "a-stable", claimed_at: 1 }),
    "/repo",
    signal,
    deps,
  );

  expect(launchNames).toEqual(["await::a-stable", "await::a-stable"]);
  expect([...effects]).toEqual(["await::a-stable"]);
  expect(terminals).toEqual(["done", "done"]);
});

test("firing is durably acknowledged before the fresh launch", async () => {
  const order: string[] = [];
  const deps: AwaitDispatchDeps = {
    emitFiring: async () => {
      order.push("firing");
      return { ok: true };
    },
    emitTerminal: () => {},
    launch: async (_session, _cwd, spec): Promise<LaunchResult> => {
      order.push(`launch:${spec.claudeName}`);
      return { ok: true };
    },
  };
  await dispatchOneAwait(
    row({ await_id: "a-ack" }),
    "/repo",
    new AbortController().signal,
    deps,
  );
  expect(order).toEqual(["firing", "launch:await::a-ack"]);
});

test("a firing ack of ok:false (cancel folded first) aborts pre-launch — the follow-up never fires", () => {
  // Main's AwaitFiring mint acks the fold's compare-and-set outcome: a cancel
  // that folded first leaves the row cancelled, so main acks ok:false. The
  // worker must abort BEFORE launching — that is what makes cancel binding
  // rather than advisory (ADR 0072).
  let launched = false;
  const terminals: string[] = [];
  const deps: AwaitDispatchDeps = {
    emitFiring: async () => ({ ok: false }),
    emitTerminal: (kind) => terminals.push(kind),
    launch: async (): Promise<LaunchResult> => {
      launched = true;
      return { ok: true };
    },
  };
  return dispatchOneAwait(
    row({ await_id: "a-cancelled" }),
    "/repo",
    new AbortController().signal,
    deps,
  ).then((outcome) => {
    expect(outcome).toBe("aborted-prelaunch");
    expect(launched).toBe(false);
    // No terminal is minted either — the row is already terminal (cancelled).
    expect(terminals).toEqual([]);
  });
});

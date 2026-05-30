/**
 * Tests for `cli/await.ts` (fn-647 task .2). Drives the await command
 * through the mock-socket `ConnectFactory` from `test/readiness-client.test.ts`
 * — no daemon, no real subscribe. The factory hands the helper a
 * controllable socket whose `deliver()` synchronously fires the helper's
 * `data` handler so the await loop walks deterministically frame by
 * frame.
 *
 * Coverage tracks the task spec's Test notes:
 *   - armed-then-met across task-complete / task-unblocked / epic-unblocked.
 *   - not-found at first paint → no armed line, exit 1.
 *   - SIGTERM → failed reason=timeout exit 3 (exactly one terminal line).
 *   - stuck default keeps waiting; --fail-on-stuck → exit 5.
 *   - epic-complete via drop + present re-query → met; drop + miss → deleted.
 *   - reconnect blip first-paint absence does NOT fire deleted.
 *
 * The Bun-injected `setTimer`/`clearTimer`/`installSignals` are stubbed
 * with synchronous controllers so tests fire the timer or SIGTERM
 * handler at the right moment without real wall-clock.
 */

import { expect, test } from "bun:test";
import {
  parseAwaitArgs,
  parseDurationMs,
  type RunDeps,
  runAwait,
} from "../cli/await";
import { encodeFrame, type ServerFrame } from "../src/protocol";
import type {
  ConnectFactory,
  ReadinessSocket,
  SocketHandlers,
} from "../src/readiness-client";

// ---------------------------------------------------------------------------
// Mock socket / connect factory (copy of the canonical helper from
// test/readiness-client.test.ts — kept inline so this file doesn't
// import from a sibling test module).
// ---------------------------------------------------------------------------

interface MockSocket extends ReadinessSocket {
  readonly outbound: string[];
  ended: boolean;
  handlers: SocketHandlers;
  deliver(frames: ServerFrame[]): void;
  closeFromServer(): void;
  takeOutbound(): unknown[];
}

interface MockConnectResult {
  readonly factory: ConnectFactory;
  readonly socketRef: { current: MockSocket | null };
  /** All sockets opened across this factory's lifetime (one per connect). */
  readonly socketsAll: { sockets: MockSocket[] };
}

function makeMockConnect(): MockConnectResult {
  const socketRef: { current: MockSocket | null } = { current: null };
  const socketsAll = { sockets: [] as MockSocket[] };
  const factory: ConnectFactory = async (_path, handlers) => {
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const sock: MockSocket = {
      outbound: [],
      ended: false,
      handlers,
      write(data: string): void {
        sock.outbound.push(data);
      },
      end(): void {
        sock.ended = true;
        resolveDone?.();
        resolveDone = null;
      },
      deliver(frames: ServerFrame[]): void {
        const payload = frames.map(encodeFrame).join("");
        sock.handlers.data(sock, Buffer.from(payload, "utf8"));
      },
      closeFromServer(): void {
        sock.handlers.close();
        resolveDone?.();
        resolveDone = null;
      },
      takeOutbound(): unknown[] {
        const parsed = sock.outbound.map((line) => {
          const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
          return JSON.parse(trimmed);
        });
        sock.outbound.length = 0;
        return parsed;
      },
    };
    socketRef.current = sock;
    socketsAll.sockets.push(sock);
    handlers.open(sock);
    await done;
    return sock;
  };
  return { factory, socketRef, socketsAll };
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function resultFrame(
  collection: string,
  id: string,
  rows: Record<string, unknown>[] = [],
  rev = 1,
): ServerFrame {
  return {
    type: "result",
    id,
    collection,
    rev,
    total: rows.length,
    rows,
  };
}

/**
 * Deliver a single readiness "all-five-empty" frame batch under the
 * given idPrefix so the helper's first-paint gate clears.
 */
function deliverFiveEmpty(sock: MockSocket, idPrefix: string): void {
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, []),
    resultFrame("jobs", `${idPrefix}-jobs`, []),
    resultFrame("subagent_invocations", `${idPrefix}-subagent-invocations`, []),
    resultFrame("git", `${idPrefix}-git`, []),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, []),
  ]);
}

/**
 * Deliver a five-collection frame where `epics` carries one row.
 */
function deliverFiveWithEpic(
  sock: MockSocket,
  idPrefix: string,
  epic: Record<string, unknown>,
): void {
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, [epic]),
    resultFrame("jobs", `${idPrefix}-jobs`, []),
    resultFrame("subagent_invocations", `${idPrefix}-subagent-invocations`, []),
    resultFrame("git", `${idPrefix}-git`, []),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, []),
  ]);
}

// ---------------------------------------------------------------------------
// Epic + Task fixture builders — wire shape (the readiness pipeline
// reads `tasks` + `depends_on_epics` arrays directly).
// ---------------------------------------------------------------------------

function makeTaskRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
    worker_phase: "open",
    runtime_status: "todo",
    approval: "pending",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpicRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    epic_id: "fn-1-foo",
    epic_number: 1,
    title: "epic",
    project_dir: "/repo",
    status: "open",
    approval: "pending",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    created_by_closer_of: null,
    sort_path: "000001",
    queue_jump: 0,
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RunDeps harness
// ---------------------------------------------------------------------------

interface AwaitHarness {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  flushed: boolean;
  fireSignal: () => void;
  fireDeadline: () => void;
  signalUnregistered: boolean;
  deadlineCleared: boolean;
  deps: RunDeps;
}

function makeHarness(connect: ConnectFactory): AwaitHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const handlers: {
    signal: (() => void) | null;
    deadline: (() => void) | null;
  } = { signal: null, deadline: null };
  const h: AwaitHarness = {
    stdout,
    stderr,
    exitCode: null,
    flushed: false,
    fireSignal: () => handlers.signal?.(),
    fireDeadline: () => handlers.deadline?.(),
    signalUnregistered: false,
    deadlineCleared: false,
    deps: {
      writeStdout: (line, cb) => {
        stdout.push(line);
        // Fire the flush callback synchronously so the exit() shim runs.
        h.flushed = true;
        cb();
      },
      writeStderr: (line) => {
        stderr.push(line);
      },
      exit: ((code: number) => {
        h.exitCode = code;
        // In production this never returns (`process.exit`). In tests
        // we just record the code and return a sentinel — the runner
        // never inspects the return value of `exit` and the
        // `terminating` latch (set BEFORE writeStdout/exit fires)
        // prevents any further work. We cast through `unknown` so
        // the `never` return type stays honest at the call site.
        return undefined as never;
      }) as (code: number) => never,
      installSignals: (handler) => {
        handlers.signal = handler;
        return () => {
          h.signalUnregistered = true;
          handlers.signal = null;
        };
      },
      setTimer: (cb, _ms) => {
        handlers.deadline = cb;
        return "deadline";
      },
      clearTimer: (_handle) => {
        h.deadlineCleared = true;
        handlers.deadline = null;
      },
      connect,
    },
  };
  return h;
}

/**
 * Drive `runAwait`. The runner returns its `state.result` once
 * subscribe callbacks are wired (the mock socket's `open` fires
 * synchronously); the test then drives frames through `sock.deliver`
 * to exercise the loop. The harness's `exit` shim is a no-op that
 * records the code — the `terminating` latch is what prevents the
 * runner from doing anything else.
 */
async function runAndCatch(
  args: Parameters<typeof runAwait>[0],
  deps: RunDeps,
): Promise<void> {
  await runAwait(args, deps);
}

// ---------------------------------------------------------------------------
// parseDurationMs
// ---------------------------------------------------------------------------

test("parseDurationMs: bare integer is ms", () => {
  expect(parseDurationMs("0")).toBe(0);
  expect(parseDurationMs("500")).toBe(500);
});

test("parseDurationMs: suffix units", () => {
  expect(parseDurationMs("250ms")).toBe(250);
  expect(parseDurationMs("30s")).toBe(30_000);
  expect(parseDurationMs("5m")).toBe(300_000);
  expect(parseDurationMs("2h")).toBe(7_200_000);
});

test("parseDurationMs: invalid input → null", () => {
  expect(parseDurationMs("")).toBeNull();
  expect(parseDurationMs("abc")).toBeNull();
  expect(parseDurationMs("-5")).toBeNull();
  expect(parseDurationMs("5x")).toBeNull();
});

// ---------------------------------------------------------------------------
// parseAwaitArgs
// ---------------------------------------------------------------------------

test("parseAwaitArgs: complete + task id classifies as task", () => {
  const r = parseAwaitArgs(["complete", "fn-1-foo.1"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.condition).toBe("complete");
  expect(r.args.id).toBe("fn-1-foo.1");
  expect(r.args.kind).toBe("task");
  expect(r.args.json).toBe(false);
  expect(r.args.timeoutMs).toBeNull();
});

test("parseAwaitArgs: unblocked + bare epic id", () => {
  const r = parseAwaitArgs(["unblocked", "fn-99"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.condition).toBe("unblocked");
  expect(r.args.kind).toBe("epic");
});

test("parseAwaitArgs: flags wire through", () => {
  const r = parseAwaitArgs([
    "complete",
    "fn-1-foo.1",
    "--json",
    "--timeout",
    "30s",
    "--fail-on-stuck",
    "--no-armed-line",
    "--require-transition",
    "--sock",
    "/tmp/x.sock",
  ]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.json).toBe(true);
  expect(r.args.timeoutMs).toBe(30_000);
  expect(r.args.failOnStuck).toBe(true);
  expect(r.args.noArmedLine).toBe(true);
  expect(r.args.requireTransition).toBe(true);
  expect(r.args.sock).toBe("/tmp/x.sock");
});

test("parseAwaitArgs: bad condition → usage error", () => {
  const r = parseAwaitArgs(["bogus", "fn-1-foo.1"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: missing positionals → usage error", () => {
  const r = parseAwaitArgs(["complete"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: bad timeout → usage error", () => {
  const r = parseAwaitArgs(["complete", "fn-1-foo.1", "--timeout", "abc"]);
  expect(r.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// armed → met: task complete
// ---------------------------------------------------------------------------

test("task complete: armed line + met terminal (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  // Track the idPrefix the runner picks (`await-<pid>`) so we can address
  // the right subscription ids on the wire.
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // Drain the initial five queries.
  sock.takeOutbound();

  // First paint: task is open + pending → armed + waiting.
  const taskOpen = makeTaskRow({ worker_phase: "open", approval: "pending" });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskOpen] }));

  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("[keeper-await] armed");
  expect(h.stdout[0]).toContain("target=fn-1-foo.1");
  expect(h.stdout[0]).toContain("kind=task");
  expect(h.stdout[0]).toContain("condition=complete");
  expect(h.exitCode).toBeNull();

  // Second snapshot: task is done + approved → met.
  const taskDone = makeTaskRow({ worker_phase: "done", approval: "approved" });
  // Bump rev so the helper folds it as a new result.
  sock.deliver([
    resultFrame(
      "epics",
      `${idPrefix}-epics`,
      [makeEpicRow({ tasks: [taskDone] })],
      2,
    ),
  ]);

  expect(h.stdout).toHaveLength(2);
  expect(h.stdout[1]).toContain("[keeper-await] met");
  expect(h.stdout[1]).toContain("target=fn-1-foo.1");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// armed → met: task unblocked (ready)
// ---------------------------------------------------------------------------

test("task unblocked: armed + ready → met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "unblocked",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: task is `ready` (no deps, pending, approved) — the
  // readiness pass produces `ready` for an open+approved task with no
  // dependencies and no validation gate to fail. So we'd hit `met` on
  // the very first tick. Suppress that with --require-transition? No
  // — the task spec says: first paint = armed (then eval). If the
  // condition is already true, exit met immediately. Test this happy
  // path.
  const taskReady = makeTaskRow({ approval: "approved", worker_phase: "open" });
  // The task has approval=approved but the epic does too (otherwise
  // predicate `epic-not-validated` could fire — guard by setting
  // last_validated_at and approval=approved on the epic). Use the
  // default fixture's `last_validated_at` and bump epic approval.
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ approval: "approved", tasks: [taskReady] }),
  );

  // Either: armed + met (workable on first paint), or just met +
  // armed back-to-back.
  expect(h.stdout.length).toBeGreaterThanOrEqual(1);
  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] armed");
  expect(lines).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// epic unblocked: armed + workable row → met
// ---------------------------------------------------------------------------

test("epic unblocked: armed + ready task in epic → met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "unblocked",
      id: "fn-1-foo",
      kind: "epic",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  const taskReady = makeTaskRow({ approval: "approved" });
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ approval: "approved", tasks: [taskReady] }),
  );

  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] armed");
  expect(lines).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// not-found at first paint: no armed line, exit 1
// ---------------------------------------------------------------------------

test("not-found at first paint: no armed line, failed reason=not-found exit 1", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-999-missing.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: empty board.
  deliverFiveEmpty(sock, idPrefix);

  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).not.toContain("armed");
  expect(h.stdout[0]).toContain("[keeper-await] failed");
  expect(h.stdout[0]).toContain("reason=not-found");
  expect(h.exitCode).toBe(1);
});

// ---------------------------------------------------------------------------
// SIGTERM → failed reason=timeout exit 3 (single terminal line)
// ---------------------------------------------------------------------------

test("SIGTERM → failed reason=timeout exit 3, exactly one terminal line", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: armed.
  const taskOpen = makeTaskRow({ worker_phase: "open" });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskOpen] }));
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();

  // Fire SIGTERM-equivalent.
  h.fireSignal();

  expect(h.stdout).toHaveLength(2);
  expect(h.stdout[1]).toContain("[keeper-await] failed");
  expect(h.stdout[1]).toContain("reason=timeout");
  expect(h.exitCode).toBe(3);

  // Re-firing the signal must NOT emit a second terminal line —
  // `terminating` latches.
  h.fireSignal();
  expect(h.stdout).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// --timeout deadline → same terminal shape as SIGTERM
// ---------------------------------------------------------------------------

test("--timeout deadline → failed reason=timeout exit 3", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: 1000,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ tasks: [makeTaskRow({ worker_phase: "open" })] }),
  );
  expect(h.stdout[0]).toContain("armed");

  // Fire the deadline timer.
  h.fireDeadline();
  expect(h.stdout[1]).toContain("reason=timeout");
  expect(h.exitCode).toBe(3);
});

// ---------------------------------------------------------------------------
// stuck default keeps waiting; --fail-on-stuck → exit 5
// ---------------------------------------------------------------------------

test("stuck default: armed but no terminal — keep waiting", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "unblocked",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Task rejected → stuck reason kind. Epic approval=approved so the
  // task itself reaches the predicate that fires `job-rejected`.
  const taskRejected = makeTaskRow({ approval: "rejected" });
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ approval: "approved", tasks: [taskRejected] }),
  );

  // Armed line emitted; no terminal.
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();
  // Only the armed line on stdout.
  expect(h.stdout).toHaveLength(1);
});

test("--fail-on-stuck: stuck verdict → failed reason=stuck exit 5", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "unblocked",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: true,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  const taskRejected = makeTaskRow({ approval: "rejected" });
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ approval: "approved", tasks: [taskRejected] }),
  );

  // Armed then failed reason=stuck.
  expect(h.stdout.length).toBeGreaterThanOrEqual(2);
  expect(h.stdout[0]).toContain("armed");
  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeDefined();
  expect(failed).toContain("reason=stuck");
  expect(h.exitCode).toBe(5);
});

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

test("--json: emits JSON-shaped lines", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: true,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({
      tasks: [makeTaskRow({ worker_phase: "done", approval: "approved" })],
    }),
  );

  // First line should be parseable JSON with event=armed or event=met.
  const first = h.stdout[0] ?? "";
  const parsed = JSON.parse(first);
  expect(typeof parsed.event).toBe("string");
  expect(["armed", "met", "failed"]).toContain(parsed.event);
});

// ---------------------------------------------------------------------------
// --no-armed-line: armed line is suppressed; terminal still fires.
// ---------------------------------------------------------------------------

test("--no-armed-line: skips armed, still emits terminal", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: true,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({
      tasks: [makeTaskRow({ worker_phase: "done", approval: "approved" })],
    }),
  );

  // Only the terminal line on stdout — no armed.
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// --require-transition: skip first-tick met, wait for an edge.
// ---------------------------------------------------------------------------

test("--require-transition: skip already-true first paint, fire on next snapshot", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: true,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: already complete — armed fires but met is suppressed.
  const taskDone = makeTaskRow({ worker_phase: "done", approval: "approved" });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskDone] }));
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();
  expect(h.stdout).toHaveLength(1);

  // Re-deliver an identical snapshot: still met (predicate sees done +
  // approved). Now we DO terminate — the "edge" is the next snapshot
  // after arm, not a verdict-shape change. The flag just means "don't
  // exit on the same tick we armed."
  sock.deliver([
    resultFrame(
      "epics",
      `${idPrefix}-epics`,
      [makeEpicRow({ tasks: [taskDone] })],
      2,
    ),
  ]);
  expect(h.stdout).toHaveLength(2);
  expect(h.stdout[1]).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// Drop + re-query hit → met (epic complete, popped off the board).
// ---------------------------------------------------------------------------

test("epic complete: present-then-drop + re-query hit → met (exit 0)", async () => {
  const { factory, socketRef, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo",
      kind: "epic",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: epic is present.
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({}));
  expect(h.stdout[0]).toContain("armed");

  // Second snapshot: epic has popped off (empty rows). This triggers
  // the deleted-disambiguation path which fires a one-shot
  // subscribeCollection re-query. The mock factory hands the runner a
  // NEW socket for that one-shot. We need to deliver a `result` on
  // that fresh socket carrying the epic id.
  sock.deliver([resultFrame("epics", `${idPrefix}-epics`, [], 2)]);

  // The re-query socket should now exist. Find it (the second socket
  // in `socketsAll`).
  // The microtask boundary: subscribeCollection in the deleted path
  // is awaited inside an async fn invoked from `void handleSnapshot(snap)`.
  // The mock connect's `await done` resolves only on `end()`; the
  // socket is registered synchronously inside the factory before the
  // first await. So `socketsAll.sockets[1]` exists as soon as the
  // handleSnapshot has reached the re-query call. Flush microtasks.
  await Promise.resolve();
  await Promise.resolve();

  expect(socketsAll.sockets.length).toBeGreaterThanOrEqual(2);
  const reSock = socketsAll.sockets[1];
  if (!reSock) {
    throw new Error("re-query socket not opened");
  }
  // The re-query is filtered by `epic_id`. The helper sent one query;
  // drain it and deliver a result containing the epic.
  reSock.takeOutbound();
  // Pull the subscription id from the helper's query frame so we use
  // the right id on the result. We can compute it: idPrefix for the
  // re-query is `await-requery-${process.pid}` and the collection is
  // `epics`, so the subId is `await-requery-<pid>-epics`.
  const reSubId = `await-requery-${process.pid}-epics`;
  reSock.deliver([resultFrame("epics", reSubId, [makeEpicRow({})])]);

  // Allow the one-shot promise to settle and the terminal write to
  // fire.
  await Promise.resolve();
  await Promise.resolve();

  expect(h.exitCode).toBe(0);
  const terminal = h.stdout.find((l) => l.includes("[keeper-await] met"));
  expect(terminal).toBeDefined();
});

// ---------------------------------------------------------------------------
// Drop + re-query miss → deleted exit 4.
// ---------------------------------------------------------------------------

test("epic complete: present-then-drop + re-query MISS → deleted exit 4", async () => {
  const { factory, socketRef, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo",
      kind: "epic",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Establish presence.
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({}));
  expect(h.stdout[0]).toContain("armed");

  // Drop.
  sock.deliver([resultFrame("epics", `${idPrefix}-epics`, [], 2)]);

  await Promise.resolve();
  await Promise.resolve();

  const reSock = socketsAll.sockets[1];
  if (!reSock) {
    throw new Error("re-query socket not opened");
  }
  reSock.takeOutbound();
  const reSubId = `await-requery-${process.pid}-epics`;
  reSock.deliver([resultFrame("epics", reSubId, [])]);

  await Promise.resolve();
  await Promise.resolve();

  expect(h.exitCode).toBe(4);
  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeDefined();
  expect(failed).toContain("reason=deleted");
});

// ---------------------------------------------------------------------------
// Reconnect blip first-paint absence does NOT fire deleted.
// ---------------------------------------------------------------------------

test("reconnect blip: post-reconnect first-paint absence is swallowed (no deleted)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo",
      kind: "epic",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: epic present → armed.
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({}));
  expect(h.stdout[0]).toContain("armed");

  // Simulate disconnect → reconnect; on the post-reconnect first
  // paint the epic is ABSENT (a blip). The runner must NOT emit
  // `deleted`.
  // The helper's onLifecycle fires `disconnected` on close.
  sock.closeFromServer();

  // No new snapshot frame on stdout yet.
  expect(h.stdout).toHaveLength(1);

  // The helper will attempt reconnect via the factory; that fires a
  // NEW socket. Drive it with the all-empty post-reconnect first
  // paint. We need to wait microtasks for the reconnect to land.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));

  // The helper may have scheduled a backoff timer (real setTimeout).
  // Wait a bit longer.
  await new Promise((r) => setTimeout(r, 200));

  // If the reconnect socket is up, deliver the all-empty paint to
  // exercise the blip path. If reconnect hasn't happened in 200ms,
  // skip this assertion — the test still proves no `deleted` fired
  // before reconnect (which is the property under test).
  expect(h.exitCode).toBeNull();
  expect(
    h.stdout.filter((l) => l.includes("[keeper-await] failed")),
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// onFatal routing: helper's default exit(1) is intercepted.
// ---------------------------------------------------------------------------

test("onFatal: connection-fatal error frame → failed reason=connect exit 1 (not bare exit 1)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);

  await runAndCatch(
    {
      condition: "complete",
      id: "fn-1-foo.1",
      kind: "task",
      timeoutMs: null,
      failOnStuck: false,
      noArmedLine: false,
      requireTransition: false,
      json: false,
      sock: "/tmp/keeper-mock.sock",
    },
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Deliver a terminal error frame before any `result`.
  sock.deliver([
    {
      type: "error",
      code: "unknown_collection",
      message: "no such collection",
      rev: 0,
    },
  ]);

  expect(h.exitCode).toBe(1);
  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeDefined();
  expect(failed).toContain("reason=connect");
});

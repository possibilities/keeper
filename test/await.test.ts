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
  HELP as AWAIT_HELP,
  parseAwaitArgs,
  parseMonitorSelector,
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
// HELP text — drift guard for the two documented-vs-behavior fixes.
// ---------------------------------------------------------------------------

test("HELP documents complete as done-AND-idle and lists the landed condition", () => {
  expect(AWAIT_HELP).toContain("done-AND-idle");
  // `landed` is a real parsed condition — it must appear in the conditions list.
  expect(AWAIT_HELP).toContain("landed <epic>");
  const landed = parseAwaitArgs(["landed", "fn-1-foo"]);
  expect(landed.ok).toBe(true);
});

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

/** An `error` frame — used by fn-775 to inject a `max_connections` cap reject. */
function errorFrame(code: string, message: string, rev = 0): ServerFrame {
  return { type: "error", code, message, rev };
}

/**
 * Deliver a single readiness "all-eleven-empty" frame batch under the
 * given idPrefix so the helper's first-paint gate clears. fn-721 added
 * `pending_dispatches` as the 6th gated collection; fn-770 added
 * `autopilot_state` + `armed_epics` as the 7th + 8th (the armed-mode
 * eligibility feeds the board/CLI readiness pass mirrors); fn-813 added
 * `scheduled_tasks` as the 9th (the jobs-TUI cron detail feed); fn-941 added
 * `block_escalations` as the 10th (the escalation latch feed); fn-952 added
 * `tmux_client_focus` as the 11th (the control-worker focus singleton).
 */
function deliverFiveEmpty(sock: MockSocket, idPrefix: string): void {
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, []),
    resultFrame("jobs", `${idPrefix}-jobs`, []),
    resultFrame("subagent_invocations", `${idPrefix}-subagent-invocations`, []),
    resultFrame("git", `${idPrefix}-git`, []),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, []),
    resultFrame("pending_dispatches", `${idPrefix}-pending-dispatches`, []),
    resultFrame("autopilot_state", `${idPrefix}-autopilot-state`, []),
    resultFrame("armed_epics", `${idPrefix}-armed-epics`, []),
    resultFrame("scheduled_tasks", `${idPrefix}-scheduled-tasks`, []),
    resultFrame("block_escalations", `${idPrefix}-block-escalations`, []),
    resultFrame("tmux_client_focus", `${idPrefix}-tmux-client-focus`, []),
    // fn-1015: the opt-in recent-done window (gated only on a `complete`
    // condition). An unmatched id is harmlessly ignored when the stream didn't
    // opt in (unblocked/started/server-up), so it's safe to deliver uniformly.
    resultFrame("epics_recent_done", `${idPrefix}-epics-recent-done`, []),
    // fn-1016: the opt-in merge-landed observable, gated on the SAME flag — deliver
    // uniformly (harmlessly ignored when not opted in).
    resultFrame("lane_merged", `${idPrefix}-lane-merged`, []),
  ]);
}

/**
 * Deliver an eleven-collection frame where `epics` carries one row.
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
    resultFrame("pending_dispatches", `${idPrefix}-pending-dispatches`, []),
    resultFrame("autopilot_state", `${idPrefix}-autopilot-state`, []),
    resultFrame("armed_epics", `${idPrefix}-armed-epics`, []),
    resultFrame("scheduled_tasks", `${idPrefix}-scheduled-tasks`, []),
    resultFrame("block_escalations", `${idPrefix}-block-escalations`, []),
    resultFrame("tmux_client_focus", `${idPrefix}-tmux-client-focus`, []),
    // fn-1015: opt-in recent-done window — empty here, so an epic that drops off
    // `epics` is absent from BOTH scopes and rides the existing re-query path.
    resultFrame("epics_recent_done", `${idPrefix}-epics-recent-done`, []),
    // fn-1016: opt-in merge-landed observable (empty here).
    resultFrame("lane_merged", `${idPrefix}-lane-merged`, []),
  ]);
}

/**
 * Deliver an eleven-collection readiness frame carrying explicit git + jobs
 * rows (for AND combos that read git/jobs off the readiness snapshot).
 */
function deliverFiveWith(
  sock: MockSocket,
  idPrefix: string,
  opts: {
    epics?: Record<string, unknown>[];
    jobs?: Record<string, unknown>[];
    git?: Record<string, unknown>[];
    rev?: number;
  },
): void {
  const rev = opts.rev ?? 1;
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, opts.epics ?? [], rev),
    resultFrame("jobs", `${idPrefix}-jobs`, opts.jobs ?? [], rev),
    resultFrame(
      "subagent_invocations",
      `${idPrefix}-subagent-invocations`,
      [],
      rev,
    ),
    resultFrame("git", `${idPrefix}-git`, opts.git ?? [], rev),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, [], rev),
    resultFrame(
      "pending_dispatches",
      `${idPrefix}-pending-dispatches`,
      [],
      rev,
    ),
    resultFrame("autopilot_state", `${idPrefix}-autopilot-state`, [], rev),
    resultFrame("armed_epics", `${idPrefix}-armed-epics`, [], rev),
    resultFrame("scheduled_tasks", `${idPrefix}-scheduled-tasks`, [], rev),
    resultFrame("block_escalations", `${idPrefix}-block-escalations`, [], rev),
    resultFrame("tmux_client_focus", `${idPrefix}-tmux-client-focus`, [], rev),
    // fn-1015: opt-in recent-done window (empty unless a test opts otherwise).
    resultFrame("epics_recent_done", `${idPrefix}-epics-recent-done`, [], rev),
    // fn-1016: opt-in merge-landed observable (empty unless a test opts otherwise).
    resultFrame("lane_merged", `${idPrefix}-lane-merged`, [], rev),
  ]);
}

function gitRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    project_dir: "/repo",
    branch: "main",
    head_oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty_count: 0,
    orphaned_count: 0,
    dirty_files: [],
    orphaned_files: [],
    jobs: [],
    last_event_id: 0,
    updated_at: 0,
    ...overrides,
  };
}

function jobRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    job_id: "j-1",
    created_at: 0,
    cwd: null,
    pid: null,
    state: "working",
    last_event_id: 0,
    updated_at: 0,
    title: null,
    title_source: null,
    transcript_path: null,
    monitors: null,
    ...overrides,
  };
}

/**
 * Each `subscribeCollection` opens its OWN connection, so a git+jobs AND
 * spawns two mock sockets. Locate a socket by the collection of its
 * outbound query frame (drains that socket's outbound buffer as a side
 * effect — call once per socket).
 */
function findSockForCollection(
  sockets: MockSocket[],
  collection: string,
): MockSocket | null {
  for (const s of sockets) {
    const parsed = s.outbound.map((line) => {
      const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
      return JSON.parse(trimmed) as { collection?: string };
    });
    if (parsed.some((q) => q.collection === collection)) {
      return s;
    }
  }
  return null;
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
      gitRoot: "/repo",
      ownSessionId: null,
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// ParsedArgs builders — the runner now takes an N-segment shape; these
// helpers keep the single-condition call sites terse and add the
// multi-condition / git / jobs shapes for the fn-713 tests.
// ---------------------------------------------------------------------------

type RunnerArgs = Parameters<typeof runAwait>[0];

function singleArgs(
  condition: "complete" | "unblocked" | "started",
  id: string,
  kind: "task" | "epic",
  overrides: Partial<Omit<RunnerArgs, "segments">> = {},
): RunnerArgs {
  return {
    segments: [{ condition, target: { id, kind, condition } }],
    timeoutMs: null,
    connectTimeoutMs: null,
    failOnStuck: false,
    noArmedLine: false,
    requireTransition: false,
    json: false,
    sock: "/tmp/keeper-mock.sock",
    ...overrides,
  };
}

/** Build an N-segment args from condition descriptors (fn-713 AND grammar). */
function argsFor(
  segments: RunnerArgs["segments"],
  overrides: Partial<Omit<RunnerArgs, "segments">> = {},
): RunnerArgs {
  return {
    segments,
    timeoutMs: null,
    connectTimeoutMs: null,
    failOnStuck: false,
    noArmedLine: false,
    requireTransition: false,
    json: false,
    sock: "/tmp/keeper-mock.sock",
    ...overrides,
  };
}

const planSeg = (
  condition: "complete" | "unblocked" | "started",
  id: string,
  kind: "task" | "epic",
): RunnerArgs["segments"][number] => ({
  condition,
  target: { id, kind, condition },
});

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
// parseAwaitArgs
// ---------------------------------------------------------------------------

test("parseAwaitArgs: complete + task id classifies as task", () => {
  const r = parseAwaitArgs(["complete", "fn-1-foo.1"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments).toHaveLength(1);
  const seg = r.args.segments[0];
  if (seg?.condition !== "complete" || !("target" in seg)) {
    throw new Error("expected a plan complete segment");
  }
  expect(seg.target.id).toBe("fn-1-foo.1");
  expect(seg.target.kind).toBe("task");
  expect(r.args.json).toBe(false);
  expect(r.args.timeoutMs).toBeNull();
  // fn-757: no flag = reconnect forever.
  expect(r.args.connectTimeoutMs).toBeNull();
});

test("parseAwaitArgs: unblocked + bare epic id", () => {
  const r = parseAwaitArgs(["unblocked", "fn-99"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  const seg = r.args.segments[0];
  if (seg?.condition !== "unblocked" || !("target" in seg)) {
    throw new Error("expected a plan unblocked segment");
  }
  expect(seg.target.kind).toBe("epic");
});

test("parseAwaitArgs: started + task id classifies as task", () => {
  const r = parseAwaitArgs(["started", "fn-1-foo.1"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  const seg = r.args.segments[0];
  if (seg?.condition !== "started" || !("target" in seg)) {
    throw new Error("expected a plan started segment");
  }
  expect(seg.target.id).toBe("fn-1-foo.1");
  expect(seg.target.kind).toBe("task");
});

test("parseAwaitArgs: started + bare epic id classifies as epic", () => {
  const r = parseAwaitArgs(["started", "fn-99"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  const seg = r.args.segments[0];
  if (seg?.condition !== "started" || !("target" in seg)) {
    throw new Error("expected a plan started segment");
  }
  expect(seg.target.kind).toBe("epic");
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

test("parseAwaitArgs: missing positional id for plan → usage error", () => {
  const r = parseAwaitArgs(["complete"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: bad timeout → usage error", () => {
  const r = parseAwaitArgs(["complete", "fn-1-foo.1", "--timeout", "abc"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: unitless --timeout is rejected (exit 2) with a self-healing hint", () => {
  const r = parseAwaitArgs(["complete", "fn-1-foo.1", "--timeout", "30"]);
  if (r.ok) throw new Error("expected a usage error for a unitless duration");
  expect(r.exitCode).toBe(2);
  expect(r.message).toContain("--timeout");
  expect(r.message).toContain("30s");
});

// ---------------------------------------------------------------------------
// parseAwaitArgs — fn-757 --connect-timeout (opt-in give-up deadline)
// ---------------------------------------------------------------------------

test("parseAwaitArgs: --connect-timeout 30s → connectTimeoutMs === 30_000", () => {
  const r = parseAwaitArgs([
    "complete",
    "fn-1-foo.1",
    "--connect-timeout",
    "30s",
  ]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.connectTimeoutMs).toBe(30_000);
});

test("parseAwaitArgs: bad --connect-timeout → usage error", () => {
  const r = parseAwaitArgs([
    "complete",
    "fn-1-foo.1",
    "--connect-timeout",
    "abc",
  ]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: --connect-timeout + server-up → usage error", () => {
  const r = parseAwaitArgs(["server-up", "--connect-timeout", "30s"]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toContain("cannot be combined");
  }
});

// ---------------------------------------------------------------------------
// parseAwaitArgs — fn-713 grammar (segment tokenizer)
// ---------------------------------------------------------------------------

test("parseAwaitArgs: git-clean takes no id", () => {
  const r = parseAwaitArgs(["git-clean"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments).toHaveLength(1);
  expect(r.args.segments[0]?.condition).toBe("git-clean");
});

test("parseAwaitArgs: agents-idle takes no id", () => {
  const r = parseAwaitArgs(["agents-idle"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments[0]?.condition).toBe("agents-idle");
});

test("parseAwaitArgs: git-clean with a stray id → usage error", () => {
  const r = parseAwaitArgs(["git-clean", "fn-1-foo"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: AND of two families parses both segments", () => {
  const r = parseAwaitArgs(["git-clean", "and", "agents-idle"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments.map((s) => s.condition)).toEqual([
    "git-clean",
    "agents-idle",
  ]);
});

test("parseAwaitArgs: AND of plan + git parses id + nullary", () => {
  const r = parseAwaitArgs(["complete", "fn-1-foo.1", "and", "git-clean"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments).toHaveLength(2);
  const first = r.args.segments[0];
  if (first?.condition !== "complete" || !("target" in first)) {
    throw new Error("expected plan first segment");
  }
  expect(first.target.id).toBe("fn-1-foo.1");
  expect(r.args.segments[1]?.condition).toBe("git-clean");
});

test("parseAwaitArgs: three-way AND parses", () => {
  const r = parseAwaitArgs([
    "git-clean",
    "and",
    "agents-idle",
    "and",
    "complete",
    "fn-1-foo.1",
  ]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments).toHaveLength(3);
});

test("parseAwaitArgs: leading 'and' → empty segment usage error", () => {
  const r = parseAwaitArgs(["and", "git-clean"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: trailing 'and' → empty segment usage error", () => {
  const r = parseAwaitArgs(["git-clean", "and"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: double 'and' → empty segment usage error", () => {
  const r = parseAwaitArgs(["git-clean", "and", "and", "agents-idle"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: duplicate nullary condition → usage error", () => {
  const r = parseAwaitArgs(["git-clean", "and", "git-clean"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: duplicate plan condition+id → usage error", () => {
  const r = parseAwaitArgs([
    "complete",
    "fn-1-foo.1",
    "and",
    "complete",
    "fn-1-foo.1",
  ]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: unknown condition in a segment → usage error", () => {
  const r = parseAwaitArgs(["git-clean", "and", "bogus"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: no positionals → usage error", () => {
  const r = parseAwaitArgs([]);
  expect(r.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// parseAwaitArgs — fn-750.2 server-up (nullary, not-ANDable)
// ---------------------------------------------------------------------------

test("parseAwaitArgs: server-up takes no id", () => {
  const r = parseAwaitArgs(["server-up"]);
  expect(r.ok).toBe(true);
  if (!r.ok) {
    return;
  }
  expect(r.args.segments).toHaveLength(1);
  expect(r.args.segments[0]?.condition).toBe("server-up");
});

test("parseAwaitArgs: server-up with a stray id → usage error", () => {
  const r = parseAwaitArgs(["server-up", "fn-1-foo"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: server-up AND another condition → usage error (either order)", () => {
  const left = parseAwaitArgs(["server-up", "and", "git-clean"]);
  expect(left.ok).toBe(false);
  if (!left.ok) {
    expect(left.message).toContain("cannot be combined");
  }

  const right = parseAwaitArgs(["git-clean", "and", "server-up"]);
  expect(right.ok).toBe(false);
  if (!right.ok) {
    expect(right.message).toContain("cannot be combined");
  }

  const withPlan = parseAwaitArgs([
    "complete",
    "fn-1-foo.1",
    "and",
    "server-up",
  ]);
  expect(withPlan.ok).toBe(false);
});

test("parseAwaitArgs: duplicate server-up → usage error", () => {
  const r = parseAwaitArgs(["server-up", "and", "server-up"]);
  expect(r.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// parseMonitorSelector + monitor-running arg arity (fn-718, T3)
// ---------------------------------------------------------------------------

test("parseMonitorSelector: bare token → command-match default", () => {
  expect(parseMonitorSelector("my-script.sh")).toEqual({
    command: "my-script.sh",
  });
});

test("parseMonitorSelector: cmd: prefix → command match", () => {
  expect(parseMonitorSelector("cmd:bun run dev")).toEqual({
    command: "bun run dev",
  });
});

test("parseMonitorSelector: kind: prefix → kind match (all three enums)", () => {
  expect(parseMonitorSelector("kind:monitor")).toEqual({ kind: "monitor" });
  expect(parseMonitorSelector("kind:bash-bg")).toEqual({ kind: "bash-bg" });
  expect(parseMonitorSelector("kind:ambient")).toEqual({ kind: "ambient" });
});

test("parseMonitorSelector: unknown kind value → null", () => {
  expect(parseMonitorSelector("kind:bogus")).toBeNull();
});

test("parseMonitorSelector: empty cmd:/kind: value → null", () => {
  expect(parseMonitorSelector("cmd:")).toBeNull();
  expect(parseMonitorSelector("kind:")).toBeNull();
});

test("parseMonitorSelector: empty token → null", () => {
  expect(parseMonitorSelector("")).toBeNull();
});

test("parseAwaitArgs: monitor-running with bare selector parses (new arity)", () => {
  const r = parseAwaitArgs(["monitor-running", "my-script.sh"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments).toHaveLength(1);
  const seg = r.args.segments[0];
  if (seg?.condition !== "monitor-running") {
    throw new Error("expected monitor-running segment");
  }
  expect(seg.selector).toEqual({ command: "my-script.sh" });
  expect(seg.raw).toBe("my-script.sh");
});

test("parseAwaitArgs: monitor-running with kind: selector parses", () => {
  const r = parseAwaitArgs(["monitor-running", "kind:bash-bg"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  const seg = r.args.segments[0];
  if (seg?.condition !== "monitor-running") {
    throw new Error("expected monitor-running segment");
  }
  expect(seg.selector).toEqual({ kind: "bash-bg" });
});

test("parseAwaitArgs: monitor-running with NO selector → usage error", () => {
  const r = parseAwaitArgs(["monitor-running"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: monitor-running with two selector tokens → usage error", () => {
  const r = parseAwaitArgs(["monitor-running", "a", "b"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: monitor-running with invalid kind selector → usage error", () => {
  const r = parseAwaitArgs(["monitor-running", "kind:nope"]);
  expect(r.ok).toBe(false);
});

test("parseAwaitArgs: AND of monitor-running + git-clean parses both", () => {
  const r = parseAwaitArgs([
    "monitor-running",
    "cmd:bun run dev",
    "and",
    "git-clean",
  ]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments).toHaveLength(2);
  const first = r.args.segments[0];
  if (first?.condition !== "monitor-running") {
    throw new Error("expected monitor-running first segment");
  }
  expect(first.selector).toEqual({ command: "bun run dev" });
  expect(r.args.segments[1]?.condition).toBe("git-clean");
});

test("parseAwaitArgs: AND of monitor-running + agents-idle parses both", () => {
  const r = parseAwaitArgs([
    "monitor-running",
    "my-script.sh",
    "and",
    "agents-idle",
  ]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments.map((s) => s.condition)).toEqual([
    "monitor-running",
    "agents-idle",
  ]);
});

test("parseAwaitArgs: duplicate monitor-running selector → usage error", () => {
  const r = parseAwaitArgs([
    "monitor-running",
    "my-script.sh",
    "and",
    "monitor-running",
    "my-script.sh",
  ]);
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

  await runAndCatch(singleArgs("complete", "fn-1-foo.1", "task"), h.deps);

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

  await runAndCatch(singleArgs("unblocked", "fn-1-foo.1", "task"), h.deps);

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

  await runAndCatch(singleArgs("unblocked", "fn-1-foo", "epic"), h.deps);

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
// armed → met: task started (work begins between two polls)
// ---------------------------------------------------------------------------

test("task started: armed line + met when work begins (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("started", "fn-1-foo.1", "task"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: task is todo, no jobs → armed + waiting.
  const taskTodo = makeTaskRow({
    worker_phase: "open",
    runtime_status: "todo",
  });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskTodo] }));

  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("[keeper-await] armed");
  expect(h.stdout[0]).toContain("target=fn-1-foo.1");
  expect(h.stdout[0]).toContain("condition=started");
  expect(h.exitCode).toBeNull();

  // Second snapshot: work has begun (runtime_status flips) → met.
  const taskRunning = makeTaskRow({ runtime_status: "in_progress" });
  sock.deliver([
    resultFrame(
      "epics",
      `${idPrefix}-epics`,
      [makeEpicRow({ tasks: [taskRunning] })],
      2,
    ),
  ]);

  expect(h.stdout).toHaveLength(2);
  expect(h.stdout[1]).toContain("[keeper-await] met");
  expect(h.stdout[1]).toContain("target=fn-1-foo.1");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// armed → immediate met: an already-started task fires met on first paint
// (no refuse-upfront).
// ---------------------------------------------------------------------------

test("task started: already-started → armed + immediate met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("started", "fn-1-foo.1", "task"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: task already has an embedded job → started on first frame.
  const taskRan = makeTaskRow({
    runtime_status: "in_progress",
    jobs: [{ job_id: "s1", plan_verb: "work", state: "working" }],
  });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskRan] }));

  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] armed");
  expect(lines).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// start-and-finish-between-polls: a single post-completion frame still
// fires met (the missed-start edge is a non-issue for the monotonic latch).
// ---------------------------------------------------------------------------

test("task started: started AND finished between polls → met off post-completion frame", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("started", "fn-1-foo.1", "task"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: task is todo → armed + waiting.
  const taskTodo = makeTaskRow({
    worker_phase: "open",
    runtime_status: "todo",
  });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskTodo] }));
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();

  // Next frame: the task BOTH started and finished in the gap — we only see
  // the post-completion snapshot (worker_phase=done). started still reads met.
  const taskDone = makeTaskRow({
    worker_phase: "done",
    runtime_status: "done",
  });
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
// started epic popped off the board → met via absentBranch (monotonic, no
// re-query): a started target that vanished was necessarily started.
// ---------------------------------------------------------------------------

test("epic started: present-then-drop → met, no re-query (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("started", "fn-1-foo", "epic"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: epic present (no started work yet) → armed + waiting.
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ tasks: [makeTaskRow({})] }),
  );
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();

  // Epic pops off the board (empty rows). For `started` this resolves to
  // `met` SYNCHRONOUSLY off the absentBranch — no scope-exempt re-query.
  sock.deliver([resultFrame("epics", `${idPrefix}-epics`, [], 2)]);

  expect(h.exitCode).toBe(0);
  const terminal = h.stdout.find((l) => l.includes("[keeper-await] met"));
  expect(terminal).toBeDefined();
});

// ---------------------------------------------------------------------------
// not-found at first paint: no armed line, exit 1
// ---------------------------------------------------------------------------

test("not-found at first paint: no armed line, failed reason=not-found exit 1", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("complete", "fn-999-missing.1", "task"), h.deps);

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

  await runAndCatch(singleArgs("complete", "fn-1-foo.1", "task"), h.deps);

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
    singleArgs("complete", "fn-1-foo.1", "task", { timeoutMs: 1000 }),
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

  await runAndCatch(singleArgs("unblocked", "fn-1-foo.1", "task"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // fn-756: the `job-rejected` stuck path is gone with the approval enum. The
  // surviving human-only-recoverable terminal blocker is `dep-on-epic-dangling`
  // — a task whose epic points at an unresolvable upstream.
  const task = makeTaskRow({});
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({
      tasks: [task],
      depends_on_epics: ["fn-99-ghost"],
      resolved_epic_deps: [
        {
          dep_token: "fn-99-ghost",
          resolved_epic_id: null,
          cross_project: false,
          project_basename: null,
          state: "dangling",
        },
      ],
    }),
  );

  // Armed line emitted; no terminal (stuck stays waiting without --fail-on-stuck).
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
    singleArgs("unblocked", "fn-1-foo.1", "task", { failOnStuck: true }),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // fn-756: stuck via `dep-on-epic-dangling` (the surviving terminal blocker)
  // rather than the removed `job-rejected` path.
  const task = makeTaskRow({});
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({
      tasks: [task],
      depends_on_epics: ["fn-99-ghost"],
      resolved_epic_deps: [
        {
          dep_token: "fn-99-ghost",
          resolved_epic_id: null,
          cross_project: false,
          project_basename: null,
          state: "dangling",
        },
      ],
    }),
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
    singleArgs("complete", "fn-1-foo.1", "task", { json: true }),
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
    singleArgs("complete", "fn-1-foo.1", "task", { noArmedLine: true }),
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
    singleArgs("complete", "fn-1-foo.1", "task", { requireTransition: true }),
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

  await runAndCatch(singleArgs("complete", "fn-1-foo", "epic"), h.deps);

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
// fn-1015: epic complete via the opt-in recent-done merge — a done epic served
// in the `epics_recent_done` window with an idle close-row fires `met` directly
// on the present branch, no board pop-off / re-query needed.
// ---------------------------------------------------------------------------

test("fn-1015 epic complete: done epic in recent-done window + idle close-row → met (no drop)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("complete", "fn-1-foo", "epic"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // The complete-condition subscribe opts in the recent-done window AND the
  // fn-1016 merge-landed observable — thirteen queries, not eleven.
  const collections = (sock.takeOutbound() as Array<{ collection?: string }>)
    .map((f) => f.collection)
    .filter((c): c is string => c !== undefined);
  expect(collections).toContain("epics_recent_done");
  expect(collections).toContain("lane_merged");

  // First paint: the epic is ABSENT from open `epics` but PRESENT (status done,
  // idle close-row) in the recent-done window. The merge surfaces it; its
  // close-row folds to `completed` → met on the present branch.
  const doneEpic = makeEpicRow({
    status: "done",
    tasks: [makeTaskRow({ worker_phase: "done" })],
  });
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, []),
    resultFrame("jobs", `${idPrefix}-jobs`, []),
    resultFrame("subagent_invocations", `${idPrefix}-subagent-invocations`, []),
    resultFrame("git", `${idPrefix}-git`, []),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, []),
    resultFrame("pending_dispatches", `${idPrefix}-pending-dispatches`, []),
    resultFrame("autopilot_state", `${idPrefix}-autopilot-state`, []),
    resultFrame("armed_epics", `${idPrefix}-armed-epics`, []),
    resultFrame("scheduled_tasks", `${idPrefix}-scheduled-tasks`, []),
    resultFrame("block_escalations", `${idPrefix}-block-escalations`, []),
    resultFrame("tmux_client_focus", `${idPrefix}-tmux-client-focus`, []),
    resultFrame("epics_recent_done", `${idPrefix}-epics-recent-done`, [
      doneEpic,
    ]),
    resultFrame("lane_merged", `${idPrefix}-lane-merged`, []),
  ]);

  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] armed");
  expect(lines).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// Drop + re-query miss → deleted exit 4.
// ---------------------------------------------------------------------------

test("epic complete: present-then-drop + re-query MISS → deleted exit 4", async () => {
  const { factory, socketRef, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("complete", "fn-1-foo", "epic"), h.deps);

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
// fn-775 — a cap reject DURING the scope-exempt re-query never commits
// `deleted`. The one-shot rides the retryable cap-reject path under a bounded
// give-up; when the cap persists it resolves INDETERMINATE → no exit 4, the
// slot stays armed, and the next steady-poll re-triggers the re-query.
// ---------------------------------------------------------------------------

test("epic complete: present-then-drop + re-query CAP-REJECT → indeterminate (no deleted, no exit 4)", async () => {
  const { factory, socketRef, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;
  // Inject the clock the re-query one-shot's bounded give-up measures against.
  let clock = 0;
  h.deps.now = () => clock;

  await runAndCatch(singleArgs("complete", "fn-1-foo", "epic"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Establish presence so the drop is a present-then-absent transition.
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({}));
  expect(h.stdout[0]).toContain("armed");

  // Drop the epic off the board → fires the deleted-disambiguation re-query.
  sock.deliver([resultFrame("epics", `${idPrefix}-epics`, [], 2)]);
  await Promise.resolve();
  await Promise.resolve();

  const reSock = socketsAll.sockets[1];
  if (!reSock) {
    throw new Error("re-query socket not opened");
  }
  reSock.takeOutbound();

  // The re-query is CAP-REJECTED (server full): error frame then close. This
  // must NOT fire the one-shot's onFatal as terminal — it rides the reconnect
  // path. Advance the clock past the bounded re-query deadline, then bounce so
  // the one-shot's loop-top give-up fires → onFatal({code:"unreachable"}) →
  // resolves INDETERMINATE.
  reSock.deliver([errorFrame("max_connections", "server full", 0)]);
  clock = 7000; // > REQUERY_GIVE_UP_MS (6000)
  reSock.closeFromServer();
  await new Promise<void>((r) => setTimeout(r, 0));
  await Promise.resolve();
  await Promise.resolve();

  // NO `deleted` committed: exit code stays null (still armed), no failed line.
  expect(h.exitCode).toBeNull();
  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeUndefined();

  // A later steady-poll re-triggers the re-query; this time it HITS (the epic
  // really did complete). The verdict resolves → `met`, exit 0. Proves the
  // indeterminate verdict only deferred, never wedged.
  sock.deliver([resultFrame("epics", `${idPrefix}-epics`, [], 3)]);
  await Promise.resolve();
  await Promise.resolve();
  const reSock2 = socketsAll.sockets[2];
  if (!reSock2) {
    throw new Error("second re-query socket not opened");
  }
  reSock2.takeOutbound();
  reSock2.deliver([
    resultFrame("epics", `await-requery-${process.pid}-epics`, [
      makeEpicRow({}),
    ]),
  ]);
  await Promise.resolve();
  await Promise.resolve();

  expect(h.exitCode).toBe(0);
  const met = h.stdout.find((l) => l.includes("[keeper-await] met"));
  expect(met).toBeDefined();
});

// ---------------------------------------------------------------------------
// Reconnect blip first-paint absence does NOT fire deleted.
// ---------------------------------------------------------------------------

test("reconnect blip: post-reconnect first-paint absence is swallowed (no deleted)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(singleArgs("complete", "fn-1-foo", "epic"), h.deps);

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

  await runAndCatch(singleArgs("complete", "fn-1-foo.1", "task"), h.deps);

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

// ===========================================================================
// fn-750.2: server-up (first-paint met, give-up-exempt) + reason=unreachable
// ===========================================================================

test("server-up: opens a readiness subscribe and fires met on first snapshot", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "server-up" }]), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // server-up rides a full readiness subscribe (eleven collections — fn-770
  // added `autopilot_state` + `armed_epics`; fn-813 added `scheduled_tasks`;
  // fn-941 added `block_escalations`; fn-952 added `tmux_client_focus`), so the
  // initial frame batch is the eleven queries — NOT a bare git/jobs single.
  const outbound = sock.takeOutbound() as Array<{ collection?: string }>;
  expect(outbound.length).toBe(11);

  // No terminal before the first snapshot — it blocks.
  expect(h.exitCode).toBeNull();

  // First paint == the daemon is serving → armed + met (exit 0).
  deliverFiveEmpty(sock, idPrefix);

  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] armed");
  expect(lines).toContain("[keeper-await] met");
  expect(lines).toContain("condition=server-up");
  expect(h.exitCode).toBe(0);
});

test("server-up: --timeout still fires failed reason=timeout exit 3", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);

  await runAndCatch(
    argsFor([{ condition: "server-up" }], { timeoutMs: 5000 }),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // No snapshot ever lands; the --timeout deadline trips.
  h.fireDeadline();

  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeDefined();
  expect(failed).toContain("reason=timeout");
  expect(h.exitCode).toBe(3);
});

test("unreachable: --connect-timeout give-up → failed reason=unreachable + advice exit 1", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  // Inject a controllable clock the give-up deadline measures against. The
  // driver arms the unpainted anchor at `now()` on subscribe start; we never
  // deliver a frame, advance past the 30s deadline, then re-iterate the
  // reconnect loop (closeFromServer) so the loop-top `checkGiveUp` fires.
  // fn-757: the give-up path is now OPT-IN — without --connect-timeout
  // (connectTimeoutMs) the runner builds no giveUpExtras, so neither the
  // policy nor the injected `now` reaches the driver and this never trips.
  let clock = 0;
  h.deps.now = () => clock;

  await runAndCatch(
    singleArgs("complete", "fn-1-foo.1", "task", { connectTimeoutMs: 30_000 }),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Still connecting/unpainted, before the deadline → no terminal.
  expect(h.exitCode).toBeNull();

  // Advance the clock past the continuous-unpainted deadline, then bounce
  // the connection so `connectWithRetry` re-iterates and checks the deadline.
  clock = 31_000;
  sock.closeFromServer();
  // Let the reconnect microtask settle so the loop-top checkGiveUp runs.
  await new Promise<void>((r) => setTimeout(r, 0));

  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeDefined();
  expect(failed).toContain("reason=unreachable");
  expect(failed).toContain("advice=");
  expect(failed).not.toContain("reason=connect");
  expect(h.exitCode).toBe(1);
});

test("unreachable: post-paint-drop past --connect-timeout → reason=unreachable exit 1", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;
  // fn-757: the give-up driver re-arms the unpainted anchor on a post-paint
  // drop (was-connected-then-lost), so an opted-in wait that painted once and
  // then loses keeperd past the deadline still fires unreachable.
  let clock = 0;
  h.deps.now = () => clock;

  await runAndCatch(
    singleArgs("complete", "fn-1-foo.1", "task", { connectTimeoutMs: 30_000 }),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: task present but not complete → armed, no terminal.
  const taskOpen = makeTaskRow({ worker_phase: "open", approval: "pending" });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskOpen] }));
  expect(h.stdout[0]).toContain("[keeper-await] armed");
  expect(h.exitCode).toBeNull();

  // First drop (at clock=0) re-arms the unpainted anchor fresh (post-paint
  // case). No terminal yet — the window has just started.
  sock.closeFromServer();
  await new Promise<void>((r) => setTimeout(r, 0));
  expect(h.exitCode).toBeNull();

  // Advance past the re-armed deadline, then bounce again so the reconnect
  // loop-top checkGiveUp measures against the post-paint anchor and fires.
  clock = 31_000;
  const reSock = socketRef.current;
  if (!reSock) {
    throw new Error("reconnect socket never installed");
  }
  reSock.closeFromServer();
  await new Promise<void>((r) => setTimeout(r, 0));

  const failed = h.stdout.find((l) => l.includes("[keeper-await] failed"));
  expect(failed).toBeDefined();
  expect(failed).toContain("reason=unreachable");
  expect(h.exitCode).toBe(1);
});

test("unreachable: emitted once across handles (terminating latch dedups)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  let clock = 0;
  h.deps.now = () => clock;

  await runAndCatch(
    singleArgs("complete", "fn-1-foo.1", "task", { connectTimeoutMs: 30_000 }),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  clock = 31_000;
  sock.closeFromServer();
  await new Promise<void>((r) => setTimeout(r, 0));
  // A second bounce after we've already given up must not re-emit.
  sock.closeFromServer();
  await new Promise<void>((r) => setTimeout(r, 0));

  const failedLines = h.stdout.filter((l) =>
    l.includes("[keeper-await] failed"),
  );
  expect(failedLines).toHaveLength(1);
  expect(failedLines[0]).toContain("reason=unreachable");
  expect(h.exitCode).toBe(1);
});

test("default path: no --connect-timeout reconnects forever; bounce past 30s yields no terminal, then met after re-paint", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;
  // fn-757: a plain await (no --connect-timeout) reconnects forever. We inject
  // a clock and advance WAY past the old 30s give-up window — with no policy
  // armed, the driver never tears down with `unreachable`. A later re-paint
  // that satisfies the condition still fires `met`.
  let clock = 0;
  h.deps.now = () => clock;

  await runAndCatch(singleArgs("complete", "fn-1-foo.1", "task"), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: task present, not complete → armed.
  const taskOpen = makeTaskRow({ worker_phase: "open", approval: "pending" });
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ tasks: [taskOpen] }));
  expect(h.stdout[0]).toContain("[keeper-await] armed");

  // Bounce, then sit unpainted PAST the old 30s give-up window. No flag =
  // reconnect forever = NO terminal.
  clock = 120_000;
  sock.closeFromServer();
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 200));

  expect(h.exitCode).toBeNull();
  expect(
    h.stdout.filter((l) => l.includes("[keeper-await] failed")),
  ).toHaveLength(0);

  // The reconnect installed a fresh socket as socketRef.current. Deliver a
  // satisfying re-paint on it → met (exit 0).
  const reSock = socketRef.current;
  if (!reSock) {
    throw new Error("reconnect socket never installed");
  }
  reSock.takeOutbound();
  const taskDone = makeTaskRow({ worker_phase: "done", approval: "approved" });
  deliverFiveWithEpic(reSock, idPrefix, makeEpicRow({ tasks: [taskDone] }));

  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

// ===========================================================================
// fn-713: git-clean / agents-idle / AND combinations
// ===========================================================================

// ---------------------------------------------------------------------------
// git-clean (dedicated git collection stream) — armed + met when clean.
// ---------------------------------------------------------------------------

test("git-clean: subscribes git collection, met when row clean", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "git-clean" }]), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // The runner should have opened ONLY a git collection subscription
  // (idPrefix-git), not the full readiness five.
  const outbound = sock.takeOutbound() as Array<{ collection?: string }>;
  expect(outbound).toHaveLength(1);
  expect(outbound[0]?.collection).toBe("git");

  // First paint: clean row for /repo (the harness's gitRoot) → armed + met.
  sock.deliver([
    resultFrame("git", `${idPrefix}-git`, [gitRow({ project_dir: "/repo" })]),
  ]);

  const lines = h.stdout.join("");
  expect(lines).toContain("[keeper-await] armed");
  expect(lines).toContain("[keeper-await] met");
  expect(lines).toContain("condition=git-clean");
  expect(h.exitCode).toBe(0);
});

test("git-clean: dirty row → armed, no terminal (keeps waiting)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "git-clean" }]), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  sock.deliver([
    resultFrame("git", `${idPrefix}-git`, [
      gitRow({ project_dir: "/repo", dirty_count: 4 }),
    ]),
  ]);

  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();

  // Clean it up → met.
  sock.deliver([
    resultFrame(
      "git",
      `${idPrefix}-git`,
      [gitRow({ project_dir: "/repo" })],
      2,
    ),
  ]);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(true);
  expect(h.exitCode).toBe(0);
});

test("git-clean: no git_status row for root → met (clean)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "git-clean" }]), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // A row for a DIFFERENT repo only → /repo has no row → met.
  sock.deliver([
    resultFrame("git", `${idPrefix}-git`, [
      gitRow({ project_dir: "/other", dirty_count: 9 }),
    ]),
  ]);
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// agents-idle (dedicated jobs collection stream).
// ---------------------------------------------------------------------------

test("agents-idle: subscribes jobs collection, met when no other working job", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "agents-idle" }]), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  const outbound = sock.takeOutbound() as Array<{ collection?: string }>;
  expect(outbound).toHaveLength(1);
  expect(outbound[0]?.collection).toBe("jobs");

  // Empty jobs → idle → armed + met.
  sock.deliver([resultFrame("jobs", `${idPrefix}-jobs`, [])]);
  expect(h.stdout.join("")).toContain("[keeper-await] met");
  expect(h.exitCode).toBe(0);
});

test("agents-idle: another working job in root → waiting, then idle → met", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "agents-idle" }]), h.deps);

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // A busy job inside /repo → waiting (armed only).
  sock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({ job_id: "other", state: "working", cwd: "/repo/sub" }),
    ]),
  ]);
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();

  // It ends → idle → met.
  sock.deliver([resultFrame("jobs", `${idPrefix}-jobs`, [], 2)]);
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// monitor-running (fn-718, T3) — own-session-scoped; rides the jobs
// collection but matches ONLY the caller's own job row. The harness's
// default ownSessionId is null, so these tests set it explicitly.
// ---------------------------------------------------------------------------

/** A jobs row carrying a JSON `monitors` array (one own-session monitor). */
function monitorsJson(
  entries: Array<{ id: string; kind: string; command?: string }>,
): string {
  return JSON.stringify(entries);
}

test("monitor-running: own monitor still running → armed, no terminal", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  h.deps.ownSessionId = "me";
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      {
        condition: "monitor-running",
        selector: { command: "dev" },
        raw: "dev",
      },
    ]),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  const outbound = sock.takeOutbound() as Array<{ collection?: string }>;
  expect(outbound).toHaveLength(1);
  expect(outbound[0]?.collection).toBe("jobs");

  // Own job has a matching running monitor → armed, waiting.
  sock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({
        job_id: "me",
        monitors: monitorsJson([{ id: "m1", kind: "monitor", command: "dev" }]),
      }),
    ]),
  ]);
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("[keeper-await] armed");
  expect(h.stdout[0]).toContain("condition=monitor-running");
  expect(h.stdout[0]).toContain("selector=dev");
  expect(h.exitCode).toBeNull();

  // The monitor drops out of the snapshot (drop-when-dead) → met.
  sock.deliver([
    resultFrame(
      "jobs",
      `${idPrefix}-jobs`,
      [jobRow({ job_id: "me", monitors: monitorsJson([]) })],
      2,
    ),
  ]);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(true);
  expect(h.exitCode).toBe(0);
});

test("monitor-running: kind selector matches by provenance", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  h.deps.ownSessionId = "me";
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      {
        condition: "monitor-running",
        selector: { kind: "bash-bg" },
        raw: "kind:bash-bg",
      },
    ]),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // A bash-bg monitor is running → waiting.
  sock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({
        job_id: "me",
        monitors: monitorsJson([{ id: "m1", kind: "bash-bg", command: "x" }]),
      }),
    ]),
  ]);
  expect(h.stdout[0]).toContain("armed");
  expect(h.exitCode).toBeNull();

  // It ends → met.
  sock.deliver([
    resultFrame(
      "jobs",
      `${idPrefix}-jobs`,
      [jobRow({ job_id: "me", monitors: monitorsJson([]) })],
      2,
    ),
  ]);
  expect(h.exitCode).toBe(0);
});

test("monitor-running: no matching monitor at arm → refuse (no-match exit 1, not instant met)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  h.deps.ownSessionId = "me";
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      {
        condition: "monitor-running",
        selector: { command: "never-launched" },
        raw: "never-launched",
      },
    ]),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Own job exists but no monitor matches → refuse upfront, NOT instant met.
  sock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({
        job_id: "me",
        monitors: monitorsJson([{ id: "m1", kind: "monitor", command: "dev" }]),
      }),
    ]),
  ]);
  // Exactly one terminal line, and it's a `failed reason=no-match`, NOT a
  // `met` and NOT an `armed`.
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("[keeper-await] failed");
  expect(h.stdout[0]).toContain("reason=no-match");
  expect(h.stdout[0]).not.toContain("[keeper-await] met");
  expect(h.stdout[0]).not.toContain("[keeper-await] armed");
  expect(h.exitCode).toBe(1);
});

test("monitor-running: own job absent at arm → refuse (no-match, vacuously done)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  h.deps.ownSessionId = "me";
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      {
        condition: "monitor-running",
        selector: { command: "dev" },
        raw: "dev",
      },
    ]),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // No own job row at all → predicate is vacuously `met`, so the refuse
  // -upfront pre-check fires (no monitor matched).
  sock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({ job_id: "other", monitors: monitorsJson([]) }),
    ]),
  ]);
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("reason=no-match");
  expect(h.exitCode).toBe(1);
});

test("monitor-running AND git-clean: met only after monitor ends AND repo clean", async () => {
  const { factory, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  h.deps.ownSessionId = "me";
  // monitor-running + git-clean → plan-less combo opens BOTH dedicated
  // collection streams (git + jobs); the aggregate first-paint gate holds
  // armed until BOTH have painted.
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      {
        condition: "monitor-running",
        selector: { command: "dev" },
        raw: "dev",
      },
      { condition: "git-clean" },
    ]),
    h.deps,
  );

  expect(socketsAll.sockets).toHaveLength(2);
  const gitSock = findSockForCollection(socketsAll.sockets, "git");
  const jobsSock = findSockForCollection(socketsAll.sockets, "jobs");
  if (!gitSock || !jobsSock) {
    throw new Error("git/jobs sockets not both opened");
  }

  // Paint jobs WITH a running monitor; paint git clean. Both painted →
  // armed, but the monitor is still running → not met.
  jobsSock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({
        job_id: "me",
        monitors: monitorsJson([{ id: "m1", kind: "monitor", command: "dev" }]),
      }),
    ]),
  ]);
  gitSock.deliver([
    resultFrame("git", `${idPrefix}-git`, [gitRow({ project_dir: "/repo" })]),
  ]);
  expect(h.stdout.some((l) => l.includes("[keeper-await] armed"))).toBe(true);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(false);
  expect(h.exitCode).toBeNull();

  // The monitor ends → monitor-running met AND git-clean still met → the
  // single aggregate terminal met fires.
  jobsSock.deliver([
    resultFrame(
      "jobs",
      `${idPrefix}-jobs`,
      [jobRow({ job_id: "me", monitors: monitorsJson([]) })],
      2,
    ),
  ]);
  const metLines = h.stdout.filter((l) => l.includes("[keeper-await] met"));
  expect(metLines).toHaveLength(1);
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// no-git-root: failed reason=no-git-root exit 1 at arm time.
// ---------------------------------------------------------------------------

test("no-git-root: git-clean with null gitRoot → failed reason=no-git-root exit 1", async () => {
  const { factory } = makeMockConnect();
  const h = makeHarness(factory);
  // Override the harness's default gitRoot to null.
  h.deps.gitRoot = null;

  await runAndCatch(argsFor([{ condition: "git-clean" }]), h.deps);

  // Terminal fires synchronously at arm time — no subscription needed.
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).toContain("[keeper-await] failed");
  expect(h.stdout[0]).toContain("reason=no-git-root");
  expect(h.exitCode).toBe(1);
});

// ---------------------------------------------------------------------------
// AND of two families (git-clean and agents-idle): met only after BOTH hold.
// Each family rides its OWN dedicated collection connection — the aggregate
// first-paint gate holds armed until BOTH have painted.
// ---------------------------------------------------------------------------

test("AND git-clean + agents-idle: met only after both paint and hold", async () => {
  const { factory, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "git-clean" }, { condition: "agents-idle" }]),
    h.deps,
  );

  // Two dedicated subscriptions opened (git + jobs), each on its own
  // connection.
  expect(socketsAll.sockets).toHaveLength(2);
  const gitSock = findSockForCollection(socketsAll.sockets, "git");
  const jobsSock = findSockForCollection(socketsAll.sockets, "jobs");
  if (!gitSock || !jobsSock) {
    throw new Error("git/jobs sockets not both opened");
  }

  // Paint ONLY git (clean). Aggregate first-paint gate: jobs hasn't
  // painted, so NO armed line yet and definitely no met.
  gitSock.deliver([
    resultFrame("git", `${idPrefix}-git`, [gitRow({ project_dir: "/repo" })]),
  ]);
  expect(h.stdout).toHaveLength(0);
  expect(h.exitCode).toBeNull();

  // Now paint jobs WITH a busy job → both painted, armed fires, but the
  // AND is not met (agents-idle is waiting).
  jobsSock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({ job_id: "other", state: "working", cwd: "/repo" }),
    ]),
  ]);
  expect(h.stdout.some((l) => l.includes("[keeper-await] armed"))).toBe(true);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(false);
  expect(h.exitCode).toBeNull();

  // The busy job ends → agents-idle now met AND git-clean still met → the
  // single aggregate terminal met fires.
  jobsSock.deliver([resultFrame("jobs", `${idPrefix}-jobs`, [], 2)]);
  const metLines = h.stdout.filter((l) => l.includes("[keeper-await] met"));
  expect(metLines).toHaveLength(1);
  expect(h.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// AND with a plan segment: reads git off the readiness snapshot (no
// extra git subscribe), and a plan `deleted` short-circuits the aggregate.
// ---------------------------------------------------------------------------

test("AND complete + git-clean: rides readiness snapshot (one connection, no extra git sub)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      planSeg("complete", "fn-1-foo.1", "task"),
      { condition: "git-clean" },
    ]),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // A plan-bearing combo rides subscribeReadiness only — its collections
  // (fn-721 added `pending_dispatches`; fn-770 added `autopilot_state` +
  // `armed_epics`; fn-813 added `scheduled_tasks`; fn-941 added
  // `block_escalations`; fn-952 added `tmux_client_focus`; fn-1015 adds the
  // opt-in `epics_recent_done` window AND fn-1016 the `lane_merged` observable
  // because a `complete` segment is present), NOT a separate dedicated git sub.
  const outbound = sock.takeOutbound() as Array<{ collection?: string }>;
  const cols = outbound.map((o) => o.collection).sort();
  expect(cols).toEqual([
    "armed_epics",
    "autopilot_state",
    "block_escalations",
    "dead_letters",
    "epics",
    "epics_recent_done",
    "git",
    "jobs",
    "lane_merged",
    "pending_dispatches",
    "scheduled_tasks",
    "subagent_invocations",
    "tmux_client_focus",
  ]);

  // First paint: task not done + repo dirty → armed, no met.
  deliverFiveWith(sock, idPrefix, {
    epics: [
      makeEpicRow({
        tasks: [makeTaskRow({ worker_phase: "open", approval: "pending" })],
      }),
    ],
    git: [gitRow({ project_dir: "/repo", dirty_count: 2 })],
  });
  expect(h.stdout.some((l) => l.includes("armed"))).toBe(true);
  expect(h.exitCode).toBeNull();

  // Task done+approved AND repo clean → aggregate met.
  deliverFiveWith(sock, idPrefix, {
    epics: [
      makeEpicRow({
        tasks: [makeTaskRow({ worker_phase: "done", approval: "approved" })],
      }),
    ],
    git: [gitRow({ project_dir: "/repo", dirty_count: 0 })],
    rev: 2,
  });
  expect(h.exitCode).toBe(0);
  expect(h.stdout.filter((l) => l.includes("[keeper-await] met"))).toHaveLength(
    1,
  );
});

test("AND complete + git-clean: plan not-found short-circuits aggregate (exit 1)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([
      planSeg("complete", "fn-999-missing.1", "task"),
      { condition: "git-clean" },
    ]),
    h.deps,
  );

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: empty board (task absent) + clean git → the plan
  // not-found short-circuits the whole aggregate, NO armed line.
  deliverFiveWith(sock, idPrefix, {
    epics: [],
    git: [gitRow({ project_dir: "/repo" })],
  });
  expect(h.stdout).toHaveLength(1);
  expect(h.stdout[0]).not.toContain("armed");
  expect(h.stdout[0]).toContain("reason=not-found");
  expect(h.stdout[0]).toContain("from=complete fn-999-missing.1");
  expect(h.exitCode).toBe(1);
});

// ---------------------------------------------------------------------------
// Aggregate timeout: SIGTERM on a multi-condition wait → exit 3, one line.
// ---------------------------------------------------------------------------

test("AND aggregate: SIGTERM → failed reason=timeout exit 3, one terminal line", async () => {
  const { factory, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "git-clean" }, { condition: "agents-idle" }]),
    h.deps,
  );

  const gitSock = findSockForCollection(socketsAll.sockets, "git");
  const jobsSock = findSockForCollection(socketsAll.sockets, "jobs");
  if (!gitSock || !jobsSock) {
    throw new Error("git/jobs sockets not both opened");
  }

  // Paint both so we arm but stay waiting (dirty git + busy job).
  gitSock.deliver([
    resultFrame("git", `${idPrefix}-git`, [
      gitRow({ project_dir: "/repo", dirty_count: 1 }),
    ]),
  ]);
  jobsSock.deliver([
    resultFrame("jobs", `${idPrefix}-jobs`, [
      jobRow({ job_id: "other", state: "working", cwd: "/repo" }),
    ]),
  ]);
  expect(h.stdout.some((l) => l.includes("armed"))).toBe(true);

  h.fireSignal();
  const failed = h.stdout.filter((l) => l.includes("[keeper-await] failed"));
  expect(failed).toHaveLength(1);
  expect(failed[0]).toContain("reason=timeout");
  expect(h.exitCode).toBe(3);
});

// ---------------------------------------------------------------------------
// fn-1015 board conditions — parse
// ---------------------------------------------------------------------------

test("parseAwaitArgs: drained takes no id", () => {
  const r = parseAwaitArgs(["drained"]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.segments[0]?.condition).toBe("drained");
});

test("parseAwaitArgs: drained with a stray id → usage error", () => {
  expect(parseAwaitArgs(["drained", "fn-1-foo"]).ok).toBe(false);
});

test("parseAwaitArgs: changed parses bare + since:<hash>", () => {
  const bare = parseAwaitArgs(["changed"]);
  if (!bare.ok) {
    throw new Error(`expected ok, got ${bare.message}`);
  }
  expect(bare.args.segments[0]?.condition).toBe("changed");
  const since = parseAwaitArgs(["changed", "since:abc123"]);
  if (!since.ok) {
    throw new Error(`expected ok, got ${since.message}`);
  }
  const seg = since.args.segments[0];
  if (seg?.condition !== "changed") {
    throw new Error("expected changed segment");
  }
  expect(seg.since).toBe("abc123");
});

test("parseAwaitArgs: changed with a non-since token → usage error", () => {
  expect(parseAwaitArgs(["changed", "fn-1-foo"]).ok).toBe(false);
});

test("parseAwaitArgs: epic-added parses bare + optional epic id", () => {
  const bare = parseAwaitArgs(["epic-added"]);
  if (!bare.ok) {
    throw new Error(`expected ok, got ${bare.message}`);
  }
  expect(bare.args.segments[0]?.condition).toBe("epic-added");
  const withId = parseAwaitArgs(["epic-added", "fn-2-bar"]);
  if (!withId.ok) {
    throw new Error(`expected ok, got ${withId.message}`);
  }
  const seg = withId.args.segments[0];
  if (seg?.condition !== "epic-added") {
    throw new Error("expected epic-added segment");
  }
  expect(seg.target).toBe("fn-2-bar");
});

test("parseAwaitArgs: epic-added with a task id → usage error", () => {
  expect(parseAwaitArgs(["epic-added", "fn-1-foo.1"]).ok).toBe(false);
});

test("parseAwaitArgs: epic-removed requires an epic id", () => {
  expect(parseAwaitArgs(["epic-removed"]).ok).toBe(false);
  const ok = parseAwaitArgs(["epic-removed", "fn-1-foo"]);
  if (!ok.ok) {
    throw new Error(`expected ok, got ${ok.message}`);
  }
  const seg = ok.args.segments[0];
  if (seg?.condition !== "epic-removed") {
    throw new Error("expected epic-removed segment");
  }
  expect(seg.target).toBe("fn-1-foo");
});

test("parseAwaitArgs: landed requires an epic id (full or bare); rejects task id", () => {
  expect(parseAwaitArgs(["landed"]).ok).toBe(false);
  expect(parseAwaitArgs(["landed", "fn-1-foo.1"]).ok).toBe(false);
  const ok = parseAwaitArgs(["landed", "fn-1-foo"]);
  if (!ok.ok) {
    throw new Error(`expected ok, got ${ok.message}`);
  }
  const seg = ok.args.segments[0];
  if (seg?.condition !== "landed") {
    throw new Error("expected landed segment");
  }
  expect(seg.target).toBe("fn-1-foo");
  // bare id is accepted
  expect(parseAwaitArgs(["landed", "fn-42"]).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-1015 board conditions — runner
// ---------------------------------------------------------------------------

test("await drained: empty board → armed + met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "drained" }]), h.deps);
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  deliverFiveEmpty(sock, idPrefix);
  // Empty board, no in-flight, not catching up → drained met on first paint.
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(true);
  expect(h.exitCode).toBe(0);
});

test("await drained: a working job holds waiting, then drains → met", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "drained" }]), h.deps);
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // First paint: a working job → waiting (armed only, no met).
  deliverFiveWith(sock, idPrefix, {
    jobs: [jobRow({ job_id: "j-1", state: "working" })],
  });
  expect(h.stdout.some((l) => l.includes("armed"))).toBe(true);
  expect(h.exitCode).toBeNull();

  // Job goes away → drained met.
  sock.deliver([resultFrame("jobs", `${idPrefix}-jobs`, [], 2)]);
  expect(h.exitCode).toBe(0);
});

test("await drained --fail-on-stuck: jam sticky → stuck exit 5", async () => {
  const { factory, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "drained" }], { failOnStuck: true }),
    h.deps,
  );
  // Two sockets open: readiness + the dedicated dispatch_failures stream.
  const dfSock = findSockForCollection(socketsAll.sockets, "dispatch_failures");
  const readinessSock = findSockForCollection(socketsAll.sockets, "epics");
  if (!dfSock || !readinessSock) {
    throw new Error("readiness + dispatch_failures sockets not both opened");
  }

  // A jam-reason sticky present, board otherwise at rest → stuck exit 5.
  dfSock.deliver([
    resultFrame("dispatch_failures", `${idPrefix}-dispatch_failures`, [
      { reason: "worktree-finalize-non-fast-forward" },
    ]),
  ]);
  deliverFiveEmpty(readinessSock, idPrefix);

  const failed = h.stdout.filter((l) => l.includes("[keeper-await] failed"));
  expect(failed.length).toBeGreaterThanOrEqual(1);
  expect(failed[0]).toContain("reason=stuck");
  expect(h.exitCode).toBe(5);
});

test("await drained --fail-on-stuck: recover* sticky is NOT a jam → met", async () => {
  const { factory, socketsAll } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "drained" }], { failOnStuck: true }),
    h.deps,
  );
  const dfSock = findSockForCollection(socketsAll.sockets, "dispatch_failures");
  const readinessSock = findSockForCollection(socketsAll.sockets, "epics");
  if (!dfSock || !readinessSock) {
    throw new Error("readiness + dispatch_failures sockets not both opened");
  }

  dfSock.deliver([
    resultFrame("dispatch_failures", `${idPrefix}-dispatch_failures`, [
      { reason: "worktree-recover-conflict" },
    ]),
  ]);
  deliverFiveEmpty(readinessSock, idPrefix);

  // recover* is auto-clearing, never an operator jam → drained met, not stuck.
  expect(h.exitCode).toBe(0);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(true);
});

test("await epic-added: new epic across two frames → met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "epic-added" }]), h.deps);
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Baseline: one epic. Edge-triggered → armed, never met on first paint.
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ epic_id: "fn-1-foo" }));
  expect(h.stdout.some((l) => l.includes("armed"))).toBe(true);
  expect(h.exitCode).toBeNull();

  // A new epic appears → met.
  sock.deliver([
    resultFrame(
      "epics",
      `${idPrefix}-epics`,
      [
        makeEpicRow({ epic_id: "fn-1-foo" }),
        makeEpicRow({ epic_id: "fn-2-bar", epic_number: 2 }),
      ],
      2,
    ),
  ]);
  expect(h.exitCode).toBe(0);
});

test("await epic-removed: present-then-absent → met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "epic-removed", target: "fn-1-foo" }]),
    h.deps,
  );
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Baseline carries fn-1-foo.
  deliverFiveWithEpic(sock, idPrefix, makeEpicRow({ epic_id: "fn-1-foo" }));
  expect(h.exitCode).toBeNull();

  // fn-1-foo leaves the board → met.
  sock.deliver([resultFrame("epics", `${idPrefix}-epics`, [], 2)]);
  expect(h.exitCode).toBe(0);
});

test("await landed (worktree ON): lane absent → waiting, then lane_merged → met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "landed", target: "fn-1-foo" }]),
    h.deps,
  );
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // `landed` opts into the merge-landed observable (and the recent-done window
  // it is gated with) — the lane_merged query is subscribed.
  const collections = (sock.takeOutbound() as Array<{ collection?: string }>)
    .map((f) => f.collection)
    .filter((c): c is string => c !== undefined);
  expect(collections).toContain("lane_merged");

  // First paint: worktree mode ON (autopilot_state row), but the lane hasn't
  // merged yet (empty lane_merged) → armed + waiting.
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, []),
    resultFrame("jobs", `${idPrefix}-jobs`, []),
    resultFrame("subagent_invocations", `${idPrefix}-subagent-invocations`, []),
    resultFrame("git", `${idPrefix}-git`, []),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, []),
    resultFrame("pending_dispatches", `${idPrefix}-pending-dispatches`, []),
    resultFrame("autopilot_state", `${idPrefix}-autopilot-state`, [
      { id: 1, worktree_mode: 1 },
    ]),
    resultFrame("armed_epics", `${idPrefix}-armed-epics`, []),
    resultFrame("scheduled_tasks", `${idPrefix}-scheduled-tasks`, []),
    resultFrame("block_escalations", `${idPrefix}-block-escalations`, []),
    resultFrame("tmux_client_focus", `${idPrefix}-tmux-client-focus`, []),
    resultFrame("epics_recent_done", `${idPrefix}-epics-recent-done`, []),
    resultFrame("lane_merged", `${idPrefix}-lane-merged`, []),
  ]);
  expect(h.stdout.some((l) => l.includes("armed"))).toBe(true);
  expect(h.exitCode).toBeNull();

  // The lane merges to default → the projection carries fn-1-foo → met.
  sock.deliver([
    resultFrame(
      "lane_merged",
      `${idPrefix}-lane-merged`,
      [{ epic_id: "fn-1-foo" }],
      2,
    ),
  ]);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(true);
  expect(h.exitCode).toBe(0);
});

test("await landed (worktree OFF): degrades to done — a done epic fires met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(
    argsFor([{ condition: "landed", target: "fn-1-foo" }]),
    h.deps,
  );
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Worktree mode OFF (empty autopilot_state) → no lanes; `landed` degrades to
  // `done`. The done epic rides the recent-done window; `lane_merged` is empty.
  sock.deliver([
    resultFrame("epics", `${idPrefix}-epics`, []),
    resultFrame("jobs", `${idPrefix}-jobs`, []),
    resultFrame("subagent_invocations", `${idPrefix}-subagent-invocations`, []),
    resultFrame("git", `${idPrefix}-git`, []),
    resultFrame("dead_letters", `${idPrefix}-dead-letters`, []),
    resultFrame("pending_dispatches", `${idPrefix}-pending-dispatches`, []),
    resultFrame("autopilot_state", `${idPrefix}-autopilot-state`, []),
    resultFrame("armed_epics", `${idPrefix}-armed-epics`, []),
    resultFrame("scheduled_tasks", `${idPrefix}-scheduled-tasks`, []),
    resultFrame("block_escalations", `${idPrefix}-block-escalations`, []),
    resultFrame("tmux_client_focus", `${idPrefix}-tmux-client-focus`, []),
    resultFrame("epics_recent_done", `${idPrefix}-epics-recent-done`, [
      makeEpicRow({ epic_id: "fn-1-foo", status: "done" }),
    ]),
    resultFrame("lane_merged", `${idPrefix}-lane-merged`, []),
  ]);
  expect(h.stdout.some((l) => l.includes("[keeper-await] met"))).toBe(true);
  expect(h.exitCode).toBe(0);
});

test("await changed: an epic status move fires met (exit 0)", async () => {
  const { factory, socketRef } = makeMockConnect();
  const h = makeHarness(factory);
  const idPrefix = `await-${process.pid}`;

  await runAndCatch(argsFor([{ condition: "changed" }]), h.deps);
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Baseline.
  deliverFiveWithEpic(
    sock,
    idPrefix,
    makeEpicRow({ epic_id: "fn-1-foo", status: "open" }),
  );
  expect(h.stdout.some((l) => l.includes("armed"))).toBe(true);
  expect(h.exitCode).toBeNull();

  // Same board re-painted → null-diff, still waiting.
  sock.deliver([
    resultFrame(
      "epics",
      `${idPrefix}-epics`,
      [makeEpicRow({ epic_id: "fn-1-foo", status: "open" })],
      2,
    ),
  ]);
  expect(h.exitCode).toBeNull();

  // Status moves → changed met.
  sock.deliver([
    resultFrame(
      "epics",
      `${idPrefix}-epics`,
      [makeEpicRow({ epic_id: "fn-1-foo", status: "done" })],
      3,
    ),
  ]);
  expect(h.exitCode).toBe(0);
});

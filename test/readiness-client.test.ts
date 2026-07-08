/**
 * Lifecycle tests for `src/readiness-client.ts`'s `subscribeReadiness`
 * helper. Driven by an in-memory mock socket injected via the
 * `connect` option — no UDS, no daemon, no `Bun.connect` wire calls.
 * The mock records outbound frames (so we can assert the helper's
 * query/refetch behavior) and exposes the `data` handler so the test
 * can deliver inbound `ServerFrame`s synchronously, byte-identical
 * to the wire format the real server worker emits.
 *
 * Why a mock socket (not a real socket)
 * -------------------------------------
 * The helper's load-bearing invariants are sequencing — the
 * all-three-strict first-paint gate, the per-collection coalesce
 * (`queryInFlight` / `refetchDirty`), the idempotent `dispose()`,
 * and the terminal-error → `onFatal` propagation. These are pure
 * orchestration around frame I/O; a real socket forces the test to
 * boot the daemon for facts unrelated to the helper itself
 * (`test/integration.test.ts` already covers that path end-to-end).
 *
 * Mock contract: `connectMock` returns a `MockSocket` whose `write`
 * pushes onto an `outbound` array, whose `end` flips a flag, and which
 * exposes the helper's `data` / `close` / `error` handlers so the test
 * can synthesise frames mid-test. `open` fires synchronously inside
 * `connect` so the helper sends its three initial queries before
 * `subscribeReadiness` returns the handle — assertions on `outbound`
 * can run immediately.
 *
 * Coverage (per `fn-609.1` acceptance):
 *   (a) first-paint gate — `onSnapshot` does not fire until all three
 *       collections produce a `result`.
 *   (b) per-collection coalesce — a refetch nudge fired while
 *       `queryInFlight` sets `refetchDirty` and a single follow-up
 *       query goes out after the next `result` resolves it.
 *   (c) idempotent `dispose()` — second call is a no-op; no callback
 *       fires.
 *   (d) terminal `error` frame with no `gotResult` invokes `onFatal`
 *       with the error payload (and `onLifecycle` sees the same).
 *
 * The default `onFatal` (which calls `process.exit(1)`) is asserted
 * separately by NOT passing one in (d) and confirming the helper does
 * call the override we wire instead — the contract is "default is
 * `process.exit(1)` iff `opts.onFatal` is omitted", which the
 * source-side branch (`opts.onFatal ?? (() => process.exit(1))`)
 * encodes directly; testing the default would terminate the test
 * runner.
 */

import { expect, test } from "bun:test";
import { effectivePerRootCap } from "../src/db";
import {
  type BootStatus,
  encodeFrame,
  type ServerFrame,
} from "../src/protocol";
import {
  CATCHUP_BACKSTOP_MS,
  type ConnectFactory,
  computeLandedEpicIds,
  type FatalError,
  type GiveUpPolicy,
  type ReadinessClientSnapshot,
  type ReadinessSocket,
  type SocketHandlers,
  subscribeCollection,
  subscribeReadiness,
  TRANSIENT_SERVER_CODES,
} from "../src/readiness-client";
import type { Epic } from "../src/types";

// ---------------------------------------------------------------------------
// Mock socket / connect factory
// ---------------------------------------------------------------------------

interface MockSocket extends ReadinessSocket {
  readonly outbound: string[];
  ended: boolean;
  /**
   * fn-750.3: count of `terminate()` calls (the leak-fix hard-destroy).
   * Optional so the many inline mock-socket factories that don't care about
   * teardown-destroy needn't all wire it; the leak-fix test uses the shared
   * `makeMockConnect`, which does.
   */
  terminated?: number;
  handlers: SocketHandlers;
  /** Deliver one or more newline-terminated frames to the helper's `data`. */
  deliver(frames: ServerFrame[]): void;
  /** Trigger the helper's `close` handler (e.g. simulated disconnect). */
  closeFromServer(): void;
  /** Pop and clear `outbound`; returns the parsed frames in send order. */
  takeOutbound(): unknown[];
}

interface MockConnectResult {
  readonly factory: ConnectFactory;
  readonly socketRef: { current: MockSocket | null };
}

/**
 * Build a `connect` factory that hands the helper a controllable mock
 * socket. `socketRef.current` is populated synchronously inside the
 * factory (and `handlers.open` runs synchronously) so tests can drive
 * the helper without awaiting microtasks for boot.
 *
 * The factory returns a Promise that resolves on `close` (mirroring
 * `Bun.connect`'s "promise resolves when the socket is no longer in
 * use" semantics). This matters for the reconnect loop: a clean close
 * without `shuttingDown` would cause the helper to reconnect; tests
 * that don't want a reconnect either set `shuttingDown` (via
 * `dispose()`) before closing, or just don't trigger `close` at all.
 */
function makeMockConnect(): MockConnectResult {
  const socketRef: { current: MockSocket | null } = { current: null };
  const factory: ConnectFactory = async (_path, handlers) => {
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const sock: MockSocket = {
      outbound: [],
      ended: false,
      terminated: 0,
      handlers,
      write(data: string): void {
        sock.outbound.push(data);
      },
      end(): void {
        sock.ended = true;
        // Mimic `Bun.connect`: `end` half-closes; the loop also gets a
        // `close`. We resolve here so the helper's `await connect(...)`
        // in `connectOnce` unblocks, but only fire `close` if the test
        // explicitly asks via `closeFromServer()` — otherwise tests
        // that just call `dispose()` would race the reconnect path.
        resolveDone?.();
        resolveDone = null;
      },
      terminate(): void {
        // fn-750.3: the leak-fix hard-destroy. Count it and resolve the
        // `connect` promise (same as `end`), since a real `terminate()` also
        // ends the socket's life so the driver's `await connect(...)` unblocks.
        sock.terminated = (sock.terminated ?? 0) + 1;
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
    // Fire `open` synchronously so the helper sends its three initial
    // queries before `subscribeReadiness` returns. `Bun.connect`'s real
    // semantics resolve after `open` fires; doing it in this order is
    // shape-equivalent for the helper.
    handlers.open(sock);
    await done;
    return sock;
  };
  return { factory, socketRef };
}

// ---------------------------------------------------------------------------
// Frame builders — minimal `result` / `error` shapes for the three
// readiness collections. Row contents don't matter for the lifecycle
// tests; the helper only inspects the descriptor pk (`epic_id` /
// `job_id`) and the `gotResult` boolean.
// ---------------------------------------------------------------------------

function emptyResult(collection: string, id: string, rev = 1): ServerFrame {
  return {
    type: "result",
    id,
    collection,
    rev,
    total: 0,
    rows: [],
  };
}

/** A `result` for any collection carrying explicit rows. */
function rowsResult(
  collection: string,
  id: string,
  rows: Record<string, unknown>[],
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

function errorFrame(
  code: string,
  message: string,
  rev = 0,
  id?: string,
): ServerFrame {
  return {
    type: "error",
    code,
    message,
    rev,
    ...(id === undefined ? {} : { id }),
  };
}

// ---------------------------------------------------------------------------
// (a) first-paint gate — onSnapshot does not fire until all three
//     collections produce a result.
// ---------------------------------------------------------------------------

test("subscribeReadiness: first-paint gate withholds onSnapshot until all collections have a result", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-paintgate",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Eight initial queries fired on open — fn-626 widened the readiness
  // composition with `git_status`; fn-643.5 added `dead_letters`; fn-721
  // added `pending_dispatches` (the launch-window occupancy feed); fn-770
  // added `autopilot_state` + `armed_epics` (the armed-mode eligibility
  // feeds). fn-637's resolver-only completed-epics subscription was deleted
  // by fn-637.4 (predicate 9 and the board pill now read
  // `epic.resolved_epic_deps` off the projection).
  const initial = sock.takeOutbound();
  expect(initial).toHaveLength(11);
  expect(
    initial.map((f) => (f as { collection: string }).collection).sort(),
  ).toEqual([
    "armed_epics",
    "autopilot_state",
    "block_escalations",
    "dead_letters",
    "epics",
    "git",
    "jobs",
    "pending_dispatches",
    "scheduled_tasks",
    "subagent_invocations",
    "tmux_client_focus",
  ]);

  // Deliver only `epics` first: gate must hold.
  sock.deliver([emptyResult("epics", "test-paintgate-epics")]);
  expect(snapshots).toHaveLength(0);

  // Add `jobs`: gate still holds (need all six).
  sock.deliver([emptyResult("jobs", "test-paintgate-jobs")]);
  expect(snapshots).toHaveLength(0);

  // Add `subagent_invocations`: still missing `git`, `dead_letters`,
  // `pending_dispatches`.
  sock.deliver([
    emptyResult("subagent_invocations", "test-paintgate-subagent-invocations"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Add `git`: still missing `dead_letters` and `pending_dispatches` — the
  // empty-steady-state collections are still load-bearing on the gate.
  sock.deliver([emptyResult("git", "test-paintgate-git")]);
  expect(snapshots).toHaveLength(0);

  // Add `dead_letters` (empty result — the happy steady state): still
  // missing `pending_dispatches`, `autopilot_state`, `armed_epics`.
  sock.deliver([emptyResult("dead_letters", "test-paintgate-dead-letters")]);
  expect(snapshots).toHaveLength(0);

  // Add `pending_dispatches` (empty result): still missing the two fn-770
  // armed-mode collections.
  sock.deliver([
    emptyResult("pending_dispatches", "test-paintgate-pending-dispatches"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Add `autopilot_state` (empty result): still missing `armed_epics` and
  // `scheduled_tasks`.
  sock.deliver([
    emptyResult("autopilot_state", "test-paintgate-autopilot-state"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Add `scheduled_tasks` (empty result — the common no-cron steady state):
  // still missing `armed_epics`, so the gate holds.
  sock.deliver([
    emptyResult("scheduled_tasks", "test-paintgate-scheduled-tasks"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Add `armed_epics` (empty result — the common nothing-armed steady state):
  // still missing `block_escalations` (fn-941), so the gate holds.
  sock.deliver([emptyResult("armed_epics", "test-paintgate-armed-epics")]);
  expect(snapshots).toHaveLength(0);

  // Add `block_escalations` (empty result): still missing `tmux_client_focus`
  // (fn-952), so the gate holds.
  sock.deliver([
    emptyResult("block_escalations", "test-paintgate-block-escalations"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Add `tmux_client_focus` (empty result — the common no-tmux / never-connected
  // steady state): gate clears, snapshot fires exactly once. The empty result is
  // what clears the gate (the dead_letters / pending_dispatches precedent — an
  // empty steady-state collection still produces a `result` frame).
  sock.deliver([
    emptyResult("tmux_client_focus", "test-paintgate-tmux-client-focus"),
  ]);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.epics).toEqual([]);
  expect(snapshots[0]?.jobs.size).toBe(0);
  expect(snapshots[0]?.subagentInvocations).toEqual([]);
  expect(snapshots[0]?.gitStatus).toEqual([]);
  expect(snapshots[0]?.deadLetters).toEqual([]);
  expect(snapshots[0]?.pendingDispatches).toEqual([]);
  expect(snapshots[0]?.scheduledTasks).toEqual([]);
  expect(snapshots[0]?.blockEscalations).toEqual([]);
  expect(snapshots[0]?.autopilotPaused).toBe(true);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (a.1a) fn-1015 — the opt-in `epics_recent_done` merge. The window is
//        subscribed, gated, and merged ONLY when `includeRecentDoneEpics` is
//        set; default-off keeps the 11-collection subscribe + open-only `epics`
//        byte-identical (the first-paint-gate test above is the off-path proof).
// ---------------------------------------------------------------------------

/** A minimal well-formed epic row the readiness pass can fold without throwing. */
function epicRow(
  epicId: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    epic_id: epicId,
    epic_number: Number.parseInt(epicId.replace(/\D+/g, ""), 10) || 0,
    title: epicId,
    project_dir: "/repo",
    status,
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

test("subscribeReadiness: includeRecentDoneEpics OFF does not subscribe epics_recent_done", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-no-recent-done",
    onSnapshot: () => {},
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  const collections = (
    sock.takeOutbound() as Array<{ collection: string }>
  ).map((f) => f.collection);
  expect(collections).not.toContain("epics_recent_done");
  expect(collections).toHaveLength(11);
  handle.dispose();
});

test("subscribeReadiness: includeRecentDoneEpics ON subscribes the window, gates on it, and merges open-wins", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const idPrefix = "test-recent-done";
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    onSnapshot: (snap) => snapshots.push(snap),
    includeRecentDoneEpics: true,
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Thirteen queries now — the opt-in adds BOTH the recent-done window (12th) and
  // the fn-1016 merge-landed observable (13th), gated on the same flag.
  const initial = sock.takeOutbound() as Array<{ collection: string }>;
  expect(initial).toHaveLength(13);
  expect(initial.map((f) => f.collection)).toContain("epics_recent_done");
  expect(initial.map((f) => f.collection)).toContain("lane_merged");

  // Deliver the eleven base collections (open `epics` carries an open epic and a
  // dup that ALSO appears done). The gate must HOLD until BOTH opt-in collections
  // paint — proving they're load-bearing when opted in.
  sock.deliver([
    rowsResult("epics", `${idPrefix}-epics`, [
      epicRow("fn-1-open", "open"),
      epicRow("fn-3-dup", "open"),
    ]),
    emptyResult("jobs", `${idPrefix}-jobs`),
    emptyResult("subagent_invocations", `${idPrefix}-subagent-invocations`),
    emptyResult("git", `${idPrefix}-git`),
    emptyResult("dead_letters", `${idPrefix}-dead-letters`),
    emptyResult("pending_dispatches", `${idPrefix}-pending-dispatches`),
    emptyResult("autopilot_state", `${idPrefix}-autopilot-state`),
    emptyResult("armed_epics", `${idPrefix}-armed-epics`),
    emptyResult("scheduled_tasks", `${idPrefix}-scheduled-tasks`),
    emptyResult("block_escalations", `${idPrefix}-block-escalations`),
    emptyResult("tmux_client_focus", `${idPrefix}-tmux-client-focus`),
  ]);
  expect(snapshots).toHaveLength(0);

  // The recent-done window paints: one fresh done epic + a dup of an open one.
  // The gate STILL holds — `lane_merged` has not painted yet.
  sock.deliver([
    rowsResult("epics_recent_done", `${idPrefix}-epics-recent-done`, [
      epicRow("fn-2-done", "done"),
      epicRow("fn-3-dup", "done"),
    ]),
  ]);
  expect(snapshots).toHaveLength(0);

  // The merge-landed observable paints (carrying a bogus row to prove it is
  // IGNORED in worktree mode OFF — autopilot_state is empty here, so `worktreeMode`
  // defaults false and `landed` degrades to DONE). Gate clears; the epics merge is
  // open-wins (the dup keeps its OPEN row, appears once).
  sock.deliver([
    rowsResult("lane_merged", `${idPrefix}-lane-merged`, [
      { epic_id: "fn-9-bogus", repo_dir: "/r" },
    ]),
  ]);
  expect(snapshots).toHaveLength(1);
  const epics = snapshots[0]?.epics ?? [];
  expect(epics.map((e) => e.epic_id)).toEqual([
    "fn-1-open",
    "fn-3-dup",
    "fn-2-done",
  ]);
  // Open-wins: the dup kept its `open` status, not the done row's.
  expect(epics.find((e) => e.epic_id === "fn-3-dup")?.status).toBe("open");
  // fn-1016: worktree mode OFF → `landed` degrades to DONE epics (merged ⇔ done),
  // IGNORING the `lane_merged` projection row (which only applies in worktree mode).
  expect(snapshots[0]?.landedEpicIds).toEqual(["fn-2-done"]);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (a.1b) ADR 0011 — the opt-in `dispatch_failures` gated fold. The collection
//        is subscribed, gated, and carried ONLY when `includeDispatchFailures`
//        is set; default-off keeps the 11-collection subscribe byte-identical
//        AND the snapshot member ABSENT (the off-path proof obligation).
// ---------------------------------------------------------------------------

test("subscribeReadiness: includeDispatchFailures OFF omits the subscribe and the snapshot member", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const idPrefix = "test-no-df";
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  const collections = (
    sock.takeOutbound() as Array<{ collection: string }>
  ).map((f) => f.collection);
  expect(collections).not.toContain("dispatch_failures");
  expect(collections).toHaveLength(11);

  // The eleven base collections paint → snapshot fires with the member ABSENT
  // (not null, not empty) — byte-identical to the pre-ADR-0011 shape.
  sock.deliver([
    emptyResult("epics", `${idPrefix}-epics`),
    emptyResult("jobs", `${idPrefix}-jobs`),
    emptyResult("subagent_invocations", `${idPrefix}-subagent-invocations`),
    emptyResult("git", `${idPrefix}-git`),
    emptyResult("dead_letters", `${idPrefix}-dead-letters`),
    emptyResult("pending_dispatches", `${idPrefix}-pending-dispatches`),
    emptyResult("autopilot_state", `${idPrefix}-autopilot-state`),
    emptyResult("armed_epics", `${idPrefix}-armed-epics`),
    emptyResult("scheduled_tasks", `${idPrefix}-scheduled-tasks`),
    emptyResult("block_escalations", `${idPrefix}-block-escalations`),
    emptyResult("tmux_client_focus", `${idPrefix}-tmux-client-focus`),
  ]);
  expect(snapshots).toHaveLength(1);
  expect("dispatchFailures" in (snapshots[0] ?? {})).toBe(false);
  expect(snapshots[0]?.dispatchFailures).toBeUndefined();

  handle.dispose();
});

test("subscribeReadiness: includeDispatchFailures ON subscribes the collection, gates on it, and carries the rows", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const idPrefix = "test-df-on";
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    onSnapshot: (snap) => snapshots.push(snap),
    includeDispatchFailures: true,
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Twelve queries now — the opt-in adds EXACTLY the one `dispatch_failures`
  // collection (no recent-done opt-in here, so the base set is eleven).
  const initial = sock.takeOutbound() as Array<{ collection: string }>;
  expect(initial).toHaveLength(12);
  expect(initial.map((f) => f.collection)).toContain("dispatch_failures");

  // The eleven base collections paint but NOT `dispatch_failures` → the gate
  // HOLDS, proving the opt-in collection is load-bearing when set.
  sock.deliver([
    emptyResult("epics", `${idPrefix}-epics`),
    emptyResult("jobs", `${idPrefix}-jobs`),
    emptyResult("subagent_invocations", `${idPrefix}-subagent-invocations`),
    emptyResult("git", `${idPrefix}-git`),
    emptyResult("dead_letters", `${idPrefix}-dead-letters`),
    emptyResult("pending_dispatches", `${idPrefix}-pending-dispatches`),
    emptyResult("autopilot_state", `${idPrefix}-autopilot-state`),
    emptyResult("armed_epics", `${idPrefix}-armed-epics`),
    emptyResult("scheduled_tasks", `${idPrefix}-scheduled-tasks`),
    emptyResult("block_escalations", `${idPrefix}-block-escalations`),
    emptyResult("tmux_client_focus", `${idPrefix}-tmux-client-focus`),
  ]);
  expect(snapshots).toHaveLength(0);

  // `dispatch_failures` paints with two SAME-VERB stickies — proving the `verb`
  // wire pk does NOT collapse them (the fold projects off `state.rows`). The
  // gate clears; the member carries both rows with field names intact.
  sock.deliver([
    rowsResult("dispatch_failures", `${idPrefix}-dispatch-failures`, [
      {
        verb: "close",
        id: "fn-1-foo",
        reason: "worktree-finalize-non-fast-forward",
        dir: "/r",
      },
      {
        verb: "close",
        id: "fn-2-bar",
        reason: "worktree-recover-conflict",
        dir: "/r",
      },
    ]),
  ]);
  expect(snapshots).toHaveLength(1);
  const df = snapshots[0]?.dispatchFailures ?? [];
  expect(df).toHaveLength(2);
  expect(df.map((r) => r.reason)).toEqual([
    "worktree-finalize-non-fast-forward",
    "worktree-recover-conflict",
  ]);
  // verb/id/dir ride through the fold intact (source-agnostic projector math).
  expect(df[0]).toMatchObject({ verb: "close", id: "fn-1-foo", dir: "/r" });

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (a.1c) ADR 0018 — the opt-in `epics_pinned` collection. The window is
//        subscribed, gated, carried as the distinct `pinnedEpics` member, AND
//        merged open-wins into `epics` ONLY when `includePinnedEpics` is set;
//        default-off keeps the 11-collection subscribe byte-identical AND the
//        member ABSENT (the off-path proof obligation).
// ---------------------------------------------------------------------------

test("subscribeReadiness: includePinnedEpics OFF omits the subscribe and the snapshot member", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const idPrefix = "test-no-pinned";
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  const collections = (
    sock.takeOutbound() as Array<{ collection: string }>
  ).map((f) => f.collection);
  expect(collections).not.toContain("epics_pinned");
  expect(collections).toHaveLength(11);

  // The eleven base collections paint → snapshot fires with the member ABSENT
  // (not null, not empty) — byte-identical to the pre-ADR-0018 shape.
  sock.deliver([
    emptyResult("epics", `${idPrefix}-epics`),
    emptyResult("jobs", `${idPrefix}-jobs`),
    emptyResult("subagent_invocations", `${idPrefix}-subagent-invocations`),
    emptyResult("git", `${idPrefix}-git`),
    emptyResult("dead_letters", `${idPrefix}-dead-letters`),
    emptyResult("pending_dispatches", `${idPrefix}-pending-dispatches`),
    emptyResult("autopilot_state", `${idPrefix}-autopilot-state`),
    emptyResult("armed_epics", `${idPrefix}-armed-epics`),
    emptyResult("scheduled_tasks", `${idPrefix}-scheduled-tasks`),
    emptyResult("block_escalations", `${idPrefix}-block-escalations`),
    emptyResult("tmux_client_focus", `${idPrefix}-tmux-client-focus`),
  ]);
  expect(snapshots).toHaveLength(1);
  expect("pinnedEpics" in (snapshots[0] ?? {})).toBe(false);
  expect(snapshots[0]?.pinnedEpics).toBeUndefined();

  handle.dispose();
});

test("subscribeReadiness: includePinnedEpics ON subscribes the window, gates on it, carries the member, and merges open-wins", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const idPrefix = "test-pinned-on";
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    onSnapshot: (snap) => snapshots.push(snap),
    includePinnedEpics: true,
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Twelve queries — the opt-in adds EXACTLY the one `epics_pinned` collection.
  const initial = sock.takeOutbound() as Array<{ collection: string }>;
  expect(initial).toHaveLength(12);
  expect(initial.map((f) => f.collection)).toContain("epics_pinned");

  // The eleven base collections paint (open `epics` carries an open epic and a
  // dup that ALSO appears pinned) but NOT `epics_pinned` → the gate HOLDS,
  // proving the opt-in collection is load-bearing when set.
  sock.deliver([
    rowsResult("epics", `${idPrefix}-epics`, [
      epicRow("fn-1-open", "open"),
      epicRow("fn-3-dup", "open"),
    ]),
    emptyResult("jobs", `${idPrefix}-jobs`),
    emptyResult("subagent_invocations", `${idPrefix}-subagent-invocations`),
    emptyResult("git", `${idPrefix}-git`),
    emptyResult("dead_letters", `${idPrefix}-dead-letters`),
    emptyResult("pending_dispatches", `${idPrefix}-pending-dispatches`),
    emptyResult("autopilot_state", `${idPrefix}-autopilot-state`),
    emptyResult("armed_epics", `${idPrefix}-armed-epics`),
    emptyResult("scheduled_tasks", `${idPrefix}-scheduled-tasks`),
    emptyResult("block_escalations", `${idPrefix}-block-escalations`),
    emptyResult("tmux_client_focus", `${idPrefix}-tmux-client-focus`),
  ]);
  expect(snapshots).toHaveLength(0);

  // The pinned window paints: one CLOSED pinned epic + a dup of an open one. Gate
  // clears; the member carries BOTH pinned rows (the pinned-identity signal is
  // status-agnostic), and the `epics` merge is open-wins.
  sock.deliver([
    rowsResult("epics_pinned", `${idPrefix}-epics-pinned`, [
      epicRow("fn-2-pinned", "done"),
      epicRow("fn-3-dup", "done"),
    ]),
  ]);
  expect(snapshots).toHaveLength(1);
  // Distinct member: every pinned epic, dup included (it IS pinned even while open).
  expect((snapshots[0]?.pinnedEpics ?? []).map((e) => e.epic_id)).toEqual([
    "fn-2-pinned",
    "fn-3-dup",
  ]);
  // Merged into `epics` open-wins: the dup keeps its OPEN row and appears once.
  const epics = snapshots[0]?.epics ?? [];
  expect(epics.map((e) => e.epic_id)).toEqual([
    "fn-1-open",
    "fn-3-dup",
    "fn-2-pinned",
  ]);
  expect(epics.find((e) => e.epic_id === "fn-3-dup")?.status).toBe("open");
  // A closed pinned epic flows through `computeReadiness` (it is in the typed
  // set) — a real per-epic verdict exists for it rather than being dropped.
  expect(snapshots[0]?.readiness.perEpic.has("fn-2-pinned")).toBe(true);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// fn-1016 — `computeLandedEpicIds` pure degradation (worktree ON → the
// `lane_merged` projection; OFF → done epics, merged ⇔ done). Sorted + stable.
// ---------------------------------------------------------------------------

/** Minimal `Epic` shaped object — `computeLandedEpicIds` reads only id + status. */
function landedEpic(epicId: string, status: string): Epic {
  return { epic_id: epicId, status } as unknown as Epic;
}

test("fn-1016 computeLandedEpicIds: worktree mode ON returns the lane_merged projection ids (sorted)", () => {
  const epics = [
    landedEpic("fn-2-done", "done"),
    landedEpic("fn-1-open", "open"),
  ];
  // ON: the projection set is authoritative — done-ness is irrelevant.
  expect(computeLandedEpicIds(true, ["fn-2-b", "fn-1-a"], epics)).toEqual([
    "fn-1-a",
    "fn-2-b",
  ]);
});

test("fn-1016 computeLandedEpicIds: worktree mode OFF degrades to DONE epics, ignoring the projection (merged ⇔ done)", () => {
  const epics = [
    landedEpic("fn-1-open", "open"),
    landedEpic("fn-3-done", "done"),
    landedEpic("fn-2-done", "done"),
  ];
  // OFF: the `lane_merged` rows (worktree-mode-only) are IGNORED; only done epics
  // count, sorted.
  expect(computeLandedEpicIds(false, ["fn-9-bogus"], epics)).toEqual([
    "fn-2-done",
    "fn-3-done",
  ]);
});

test("fn-1016 computeLandedEpicIds: an unmerged-but-done epic is NOT landed in worktree mode ON", () => {
  // The done epic's lane is NOT in the projection (still outstanding) → NOT landed,
  // even though it is done. This is the worktree-mode distinction `complete` lacks.
  const epics = [landedEpic("fn-1-a", "done")];
  expect(computeLandedEpicIds(true, [], epics)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (a.1b) fn-905 — the boot-status header on a `result` frame fires
//        `onBootStatus` AND latches `git_unseeded_roots`, forcing the next
//        snapshot's readiness to UNKNOWN ONLY for rows whose `effectiveRoot` is
//        unseeded (the board renders the SAME per-root gate the autopilot
//        dispatches against).
// ---------------------------------------------------------------------------

test("subscribeReadiness: boot-status header fires onBootStatus and forces readiness UNKNOWN per-root when git unseeded", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const boots: {
    git_seed_required: boolean;
    git_unseeded_roots?: string[];
  }[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-boot",
    onSnapshot: (snap) => snapshots.push(snap),
    onBootStatus: (b) => boots.push(b),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");
  sock.takeOutbound();

  // An epic with one open task so the readiness pass has a row to force UNKNOWN.
  const epicRow = {
    epic_id: "fn-1-foo",
    epic_number: 1,
    title: "epic",
    project_dir: "/repo",
    status: "open",
    last_event_id: 1,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [
      {
        task_id: "fn-1-foo.1",
        epic_id: "fn-1-foo",
        task_number: 1,
        title: "t",
        target_repo: null,
        tier: null,
        worker_phase: "open",
        runtime_status: "todo",
        depends_on: [],
        jobs: [],
      },
    ],
    jobs: [],
    job_links: [],
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
  };
  // Stamp the boot-status header (git unseeded) on the epics result.
  const epicsFrame: ServerFrame = {
    type: "result",
    id: "test-boot-epics",
    collection: "epics",
    rev: 1,
    total: 1,
    rows: [epicRow],
    boot: {
      rev: 1,
      head_event_id: 9,
      catching_up: true,
      git_seed_required: true,
      // The epic's /repo root is unseeded → its rows gate UNKNOWN.
      git_unseeded_roots: ["/repo"],
    },
  };
  sock.deliver([epicsFrame]);
  // onBootStatus fired with the unseeded flag + the per-root set, even before
  // the gate clears.
  expect(boots.length).toBeGreaterThanOrEqual(1);
  expect(boots.at(-1)?.git_seed_required).toBe(true);
  expect(boots.at(-1)?.git_unseeded_roots).toEqual(["/repo"]);

  // Deliver the rest so the first-paint gate clears.
  for (const c of [
    "jobs",
    "subagent_invocations",
    "git",
    "dead_letters",
    "pending_dispatches",
    "autopilot_state",
    "armed_epics",
    "scheduled_tasks",
    "block_escalations",
    "tmux_client_focus",
  ]) {
    sock.deliver([emptyResult(c, `test-boot-${c.replace(/_/g, "-")}`)]);
  }
  expect(snapshots).toHaveLength(1);
  // The unseeded git surface forces the task + close-row to blocked:unknown.
  const r = snapshots[0]?.readiness;
  expect(r?.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });

  handle.dispose();
});

// ---------------------------------------------------------------------------
// fn-954 / fn-1197 — the boot-status header still carries `max_concurrent_per_root`
//          (the server's effective cap) and `onBootStatus` forwards it verbatim to
//          callers. The readiness snapshot NO LONGER latches it for the effective
//          cap — that now derives off the folded autopilot_state through the seam
//          (see the fn-1197 regression below) — so this test pins only forwarding.
// ---------------------------------------------------------------------------

test("subscribeReadiness: boot-status header forwards max_concurrent_per_root via onBootStatus", () => {
  const { factory, socketRef } = makeMockConnect();
  const boots: { max_concurrent_per_root?: number }[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-n",
    onSnapshot: () => {},
    onBootStatus: (b) => boots.push(b),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");
  sock.takeOutbound();

  // A frame stamping N=3.
  sock.deliver([
    {
      type: "result",
      id: "test-n-epics",
      collection: "epics",
      rev: 1,
      total: 0,
      rows: [],
      boot: {
        rev: 1,
        head_event_id: 1,
        catching_up: true,
        git_seed_required: false,
        max_concurrent_per_root: 3,
      },
    },
  ]);
  expect(boots.at(-1)?.max_concurrent_per_root).toBe(3);

  // A later frame omitting the field — `onBootStatus` sees no N (the client
  // latch defaults to 1 internally; the wire field is simply absent).
  sock.deliver([
    {
      type: "result",
      id: "test-n-jobs",
      collection: "jobs",
      rev: 1,
      total: 0,
      rows: [],
      boot: {
        rev: 1,
        head_event_id: 1,
        catching_up: true,
        git_seed_required: false,
      },
    },
  ]);
  expect(boots.at(-1)?.max_concurrent_per_root).toBeUndefined();

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (a.2) fn-813 — the `scheduled_tasks` collection rides the snapshot, and a
//       multi-cron session is NOT collapsed (the composite `(job_id, cron_id)`
//       identity reads off `state.rows`, not the `job_id` wire pk's `byId`).
// ---------------------------------------------------------------------------

test("subscribeReadiness: snapshot carries every scheduled_tasks row (multi-cron not collapsed)", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-cron",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Clear the gate for every collection except scheduled_tasks with empties.
  sock.deliver([
    emptyResult("epics", "test-cron-epics"),
    emptyResult("jobs", "test-cron-jobs"),
    emptyResult("subagent_invocations", "test-cron-subagent-invocations"),
    emptyResult("git", "test-cron-git"),
    emptyResult("dead_letters", "test-cron-dead-letters"),
    emptyResult("pending_dispatches", "test-cron-pending-dispatches"),
    emptyResult("autopilot_state", "test-cron-autopilot-state"),
    emptyResult("armed_epics", "test-cron-armed-epics"),
    emptyResult("block_escalations", "test-cron-block-escalations"),
    emptyResult("tmux_client_focus", "test-cron-tmux-client-focus"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Two crons for the SAME job_id — the wire pk is `job_id`, so `byId` would
  // collapse them to one. The snapshot must carry both (read via state.rows).
  sock.deliver([
    rowsResult("scheduled_tasks", "test-cron-scheduled-tasks", [
      { job_id: "sess-a", cron_id: "c1", status: "active" },
      { job_id: "sess-a", cron_id: "c2", status: "active" },
      { job_id: "sess-b", cron_id: "c3", status: "deleted" },
    ]),
  ]);
  expect(snapshots).toHaveLength(1);
  const tasks = snapshots[0]?.scheduledTasks ?? [];
  expect(tasks).toHaveLength(3);
  expect(tasks.map((t) => t.cron_id)).toEqual(["c1", "c2", "c3"]);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (b) per-collection coalesce — a refetch while queryInFlight sets
//     refetchDirty, and exactly one follow-up query goes out on the
//     next result.
// ---------------------------------------------------------------------------

test("subscribeReadiness: refetch fired while queryInFlight is coalesced into one follow-up", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-coalesce",
    onSnapshot: () => {
      /* ignore — coalesce assertions are wire-level */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Discard the eight initial queries (fn-626 added `git`; fn-637.4 deleted
  // the completed-epics resolver-only sub; fn-643.5 added `dead_letters`;
  // fn-721 added `pending_dispatches`; fn-770 added `autopilot_state` +
  // `armed_epics`).
  expect(sock.takeOutbound()).toHaveLength(11);

  // BEFORE the `epics` result resolves the in-flight query, deliver TWO
  // `meta` nudges for `epics` — both should fold into one pending
  // refetch via `refetchDirty`, not two writes. The nudges carry the epics
  // subId so they route to the primary epics sub by id; the collection-
  // only fallback path is also unambiguous now that there's a single
  // `epics` subscription.
  sock.deliver([metaFrameWithId("epics", "test-coalesce-epics", 2)]);
  sock.deliver([metaFrameWithId("epics", "test-coalesce-epics", 3)]);
  // No writes yet — `queryInFlight` is true from the initial query.
  expect(sock.takeOutbound()).toHaveLength(0);

  // The `epics` `result` lands, clears `queryInFlight`, and triggers
  // exactly ONE follow-up query because `refetchDirty` was set.
  sock.deliver([emptyResult("epics", "test-coalesce-epics")]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("epics");
  expect((follow[0] as { type: string }).type).toBe("query");

  // A second `meta` while THIS refetch is in flight should again
  // coalesce — proving the dirty-flag cycle isn't single-shot.
  sock.deliver([metaFrameWithId("epics", "test-coalesce-epics", 4)]);
  expect(sock.takeOutbound()).toHaveLength(0);
  sock.deliver([emptyResult("epics", "test-coalesce-epics", 5)]);
  expect(sock.takeOutbound()).toHaveLength(1);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (c) idempotent dispose() — second call is a no-op, no callbacks fire.
// ---------------------------------------------------------------------------

test("subscribeReadiness: dispose() is idempotent — second call is a no-op", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
  let fatalCalls = 0;
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-dispose",
    onSnapshot: (snap) => snapshots.push(snap),
    onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
    onFatal: () => {
      fatalCalls += 1;
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Reach first-paint so the helper is in steady state.
  sock.takeOutbound();
  sock.deliver([
    emptyResult("epics", "test-dispose-epics"),
    emptyResult("jobs", "test-dispose-jobs"),
    emptyResult("subagent_invocations", "test-dispose-subagent-invocations"),
    emptyResult("git", "test-dispose-git"),
    emptyResult("dead_letters", "test-dispose-dead-letters"),
    emptyResult("pending_dispatches", "test-dispose-pending-dispatches"),
    emptyResult("autopilot_state", "test-dispose-autopilot-state"),
    emptyResult("scheduled_tasks", "test-dispose-scheduled-tasks"),
    emptyResult("armed_epics", "test-dispose-armed-epics"),
    emptyResult("block_escalations", "test-dispose-block-escalations"),
    emptyResult("tmux_client_focus", "test-dispose-tmux-client-focus"),
  ]);
  expect(snapshots).toHaveLength(1);

  // First dispose: sends an `unsubscribe` frame and calls `end()`.
  handle.dispose();
  const out1 = sock.takeOutbound();
  expect(out1).toHaveLength(1);
  expect((out1[0] as { type: string }).type).toBe("unsubscribe");
  expect(sock.ended).toBe(true);

  // Snapshot baseline; second dispose must be inert.
  const snapsBefore = snapshots.length;
  const lifecycleBefore = lifecycle.length;
  const fatalBefore = fatalCalls;

  handle.dispose();

  // No additional outbound frames, no extra callbacks.
  expect(sock.outbound).toHaveLength(0);
  expect(snapshots.length).toBe(snapsBefore);
  expect(lifecycle.length).toBe(lifecycleBefore);
  expect(fatalCalls).toBe(fatalBefore);
});

// ---------------------------------------------------------------------------
// fn-750.3: client-initiated teardown HARD-destroys the socket
// (`terminate()`), not just `end()`/null. The ~2GB `keeper await` leak was
// `end()` against a wedged daemon leaving native socket buffers pinned across
// reconnects; the fix routes every teardown through `terminate()`. Runtime
// repro + flat-RSS evidence: `scripts/subscribe-bounce-soak.ts`.
// ---------------------------------------------------------------------------

test("subscribeReadiness: dispose() terminate()s the socket (fn-750.3 leak fix)", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-term",
    onSnapshot: () => {},
    onFatal: () => {},
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Reach first-paint so a live socket exists to tear down.
  sock.takeOutbound();
  sock.deliver([
    emptyResult("epics", "test-term-epics"),
    emptyResult("jobs", "test-term-jobs"),
    emptyResult("subagent_invocations", "test-term-subagent-invocations"),
    emptyResult("git", "test-term-git"),
    emptyResult("dead_letters", "test-term-dead-letters"),
    emptyResult("pending_dispatches", "test-term-pending-dispatches"),
    emptyResult("autopilot_state", "test-term-autopilot-state"),
    emptyResult("scheduled_tasks", "test-term-scheduled-tasks"),
    emptyResult("armed_epics", "test-term-armed-epics"),
    emptyResult("block_escalations", "test-term-block-escalations"),
    emptyResult("tmux_client_focus", "test-term-tmux-client-focus"),
  ]);

  expect(sock.terminated ?? 0).toBe(0);
  handle.dispose();
  // The unsubscribe still goes out (best-effort etiquette), THEN terminate().
  expect(sock.terminated ?? 0).toBe(1);
});

test("subscribeReadiness: a post-paint disconnect terminate()s the dropped socket (fn-750.3)", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-term2",
    onSnapshot: () => {},
    onFatal: () => {},
    connect: factory,
  });
  const sock1 = socketRef.current;
  if (!sock1) {
    throw new Error("mock socket never installed");
  }

  // Paint, then simulate the daemon dropping the connection. The `close`
  // handler tears down (terminate the held socket) and spawns a reconnect —
  // socketRef now points at the FRESH socket, so we capture sock1 first.
  sock1.deliver([
    emptyResult("epics", "test-term2-epics"),
    emptyResult("jobs", "test-term2-jobs"),
    emptyResult("subagent_invocations", "test-term2-subagent-invocations"),
    emptyResult("git", "test-term2-git"),
    emptyResult("dead_letters", "test-term2-dead-letters"),
    emptyResult("pending_dispatches", "test-term2-pending-dispatches"),
    emptyResult("autopilot_state", "test-term2-autopilot-state"),
    emptyResult("scheduled_tasks", "test-term2-scheduled-tasks"),
    emptyResult("armed_epics", "test-term2-armed-epics"),
    emptyResult("block_escalations", "test-term2-block-escalations"),
    emptyResult("tmux_client_focus", "test-term2-tmux-client-focus"),
  ]);
  expect(sock1.terminated ?? 0).toBe(0);

  sock1.closeFromServer();

  // The dropped socket was hard-destroyed on teardown (no `end()`/null leak).
  expect(sock1.terminated ?? 0).toBe(1);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (d) terminal `error` frame with no gotResult invokes onFatal with the
//     error payload (and onLifecycle sees the same error event).
// ---------------------------------------------------------------------------

test("subscribeReadiness: terminal error frame (no prior result) invokes onFatal with the error payload and leaves no pending setInterval", () => {
  // Spy `setInterval` / `clearInterval` on the global so we can track
  // every timer the helper schedules and assert NONE remain pending
  // after `onFatal` fires. This pins the F1 leak: the terminal-error
  // branch used to set `shuttingDown` and call `end()` but never
  // clear `pollTimer`, leaving a live `setInterval` to hold the event
  // loop open whenever a custom `onFatal` returned instead of exiting.
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const pending = new Set<ReturnType<typeof realSetInterval>>();
  globalThis.setInterval = ((
    handler: Parameters<typeof realSetInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = realSetInterval(handler, timeout, ...args);
    pending.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) {
      pending.delete(id);
    }
    realClearInterval(id);
  }) as typeof clearInterval;

  try {
    const { factory, socketRef } = makeMockConnect();
    const fatals: FatalError[] = [];
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-fatal",
      onSnapshot: () => {
        throw new Error("onSnapshot must not fire on a pre-handshake error");
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: (err) => fatals.push(err),
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }

    // Burn the eight initial queries (fn-626 added `git`; fn-637.4 deleted
    // the completed-epics resolver-only sub; fn-643.5 added `dead_letters`;
    // fn-721 added `pending_dispatches`; fn-770 added `autopilot_state` +
    // `armed_epics`).
    expect(sock.takeOutbound()).toHaveLength(11);
    // The helper installed its steady-poll `setInterval` in `open`; the
    // spy must have observed it.
    expect(pending.size).toBe(1);

    // Deliver a terminal `error` frame BEFORE any collection has a result.
    sock.deliver([errorFrame("unknown_collection", "no such collection", 0)]);

    // `onFatal` fired exactly once with the error payload.
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toEqual({
      code: "unknown_collection",
      rev: 0,
      message: "no such collection",
    });

    // `onLifecycle` also saw an `error` event with the same fields (the
    // contract is "lifecycle observes; fatal acts").
    const errorEvents = lifecycle.filter((e) => e.event === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.detail).toEqual({
      code: "unknown_collection",
      rev: 0,
      message: "no such collection",
    });

    // Socket was torn down via `end()` so the reconnect loop won't fire.
    expect(sock.ended).toBe(true);

    // The F1 invariant: the terminal-error branch cleared `pollTimer`
    // before invoking `onFatal`, so no live `setInterval` survives.
    expect(pending.size).toBe(0);

    handle.dispose();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const id of pending) {
      realClearInterval(id);
    }
  }
});

test("subscribeReadiness: capped-backoff reconnect sequence — 250, 500, 1000, 2000, 4000, 5000 ms", async () => {
  // F2 coverage: the reconnect loop computes
  //   delay = min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
  // (`src/readiness-client.ts:524-525`). Drive the mock factory to reject
  // back-to-back and intercept `setTimeout` to capture each `delay` the
  // helper would sleep for. Firing the callback synchronously fast-forwards
  // the backoff so the test stays deterministic and millisecond-fast.
  const expected = [250, 500, 1000, 2000, 4000, 5000, 5000];
  const observed: number[] = [];

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof realSetTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    // Capture only the reconnect-sleep timeouts: those are the ones the
    // helper schedules from `connectWithRetry`. Other library timers
    // (Bun internals, microtask shims) generally use `0` or `undefined`;
    // the helper's sleeps are positive, finite millisecond delays
    // matching the expected sequence. Recording every positive `timeout`
    // is safe — the helper schedules no other positive-delay timeouts.
    if (typeof timeout === "number" && timeout > 0) {
      observed.push(timeout);
      // Fire the callback on the next microtask so the awaiting
      // `connectWithRetry` loop advances without a real delay.
      queueMicrotask(() => {
        (handler as () => void)();
      });
      // Return a fake id; helper only uses it for `clearTimeout` on
      // dispose, which we won't reach for these timers.
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as () => void, timeout, ...args);
  }) as typeof setTimeout;

  try {
    let calls = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const factory: ConnectFactory = (_path, _handlers) => {
      calls += 1;
      if (calls <= expected.length) {
        // Reject without calling `open` — no socket installed, no
        // `setInterval` scheduled. Each rejection bumps `attempt` and
        // schedules one backoff sleep.
        return Promise.reject(new Error(`refused #${calls}`));
      }
      // Final attempt: signal the test we've observed the full capped
      // sequence and hand back a never-resolving promise so the loop
      // sits idle until `dispose()`.
      resolveDone?.();
      resolveDone = null;
      return new Promise<ReadinessSocket>(() => {
        /* never resolves — held until dispose() */
      });
    };

    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-backoff",
      onSnapshot: () => {
        throw new Error("onSnapshot must not fire — no result ever delivered");
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error(
          "onFatal must not fire — connect rejections are not terminal",
        );
      },
      connect: factory,
    });

    // Wait for the full backoff sequence to play out.
    await done;

    // The helper observed expected.length rejections + scheduled
    // expected.length backoff sleeps, capped at MAX_BACKOFF_MS for the
    // tail entries.
    expect(observed).toEqual(expected);

    // Lifecycle should have emitted one `waiting` per backoff with a
    // matching `retry_in_ms`.
    const waits = lifecycle.filter((e) => e.event === "waiting");
    expect(waits).toHaveLength(expected.length);
    expect(waits.map((w) => w.detail?.retry_in_ms)).toEqual(expected);

    handle.dispose();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ---------------------------------------------------------------------------
// Bounded give-up coverage (fn-750.1)
//
// `giveUpPolicy` bounds the CONTINUOUS-UNPAINTED window. The deadline is
// measured against the injected `now()` clock — NOT `Date.now()` — because
// the fake-timer harness fast-forwards `setTimeout` synchronously WITHOUT
// advancing real wall-clock, so a `Date.now()`-keyed deadline would never
// trip in test. The deterministic give-up path is the top-of-loop
// `checkGiveUp()` in `connectWithRetry`; we drive it by advancing the
// injected clock inside the intercepted `setTimeout` (simulating wall-clock
// passing during each backoff sleep) so the next loop iteration's check sees
// the deadline elapsed.
// ---------------------------------------------------------------------------

/**
 * Intercept `setTimeout`: for each positive backoff sleep the helper
 * schedules, advance the supplied `clock` by that delay (wall-clock passes
 * during the sleep) and fire the callback on the next microtask so the
 * `connectWithRetry` loop advances without real delay. Returns a `restore()`.
 * Mirrors the capped-backoff test's interceptor, plus the clock advance.
 */
function installBackoffClockAdvancer(clock: { ms: number }): {
  restore: () => void;
} {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof realSetTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof timeout === "number" && timeout > 0) {
      // Wall-clock advances by the sleep duration before the loop resumes.
      clock.ms += timeout;
      queueMicrotask(() => {
        (handler as () => void)();
      });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as () => void, timeout, ...args);
  }) as typeof setTimeout;
  return {
    restore() {
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

test("give-up: continuously-unpainted >= deadline fires onFatal({code:'unreachable'}) exactly once", async () => {
  // INVERTS the capped-backoff test's "onFatal must not fire" assertion: a
  // connect that NEVER succeeds, under an opt-in `giveUpPolicy`, must give
  // up — `onFatal({code:"unreachable"})` fires once after the
  // continuous-unpainted deadline elapses.
  const clock = { ms: 1_000_000 };
  const advancer = installBackoffClockAdvancer(clock);
  try {
    let calls = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    // Reject forever — an unreachable socket (never calls `open`, never
    // paints). Each rejection schedules one backoff sleep; the advancer
    // bumps the clock so a few iterations cross the 2 s deadline.
    const factory: ConnectFactory = (_path, _handlers) => {
      calls += 1;
      return Promise.reject(new Error(`refused #${calls}`));
    };

    const fatals: FatalError[] = [];
    const giveUpPolicy: GiveUpPolicy = { deadlineMs: 2_000 };
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-giveup",
      onSnapshot: () => {
        throw new Error("onSnapshot must not fire — no result ever delivered");
      },
      onFatal: (err) => {
        fatals.push(err);
        resolveDone?.();
        resolveDone = null;
      },
      connect: factory,
      giveUpPolicy,
      now: () => clock.ms,
    });

    await done;
    // Let any straggler microtasks flush so a second give-up (if the code
    // were buggy) would be observable.
    await Promise.resolve();
    await Promise.resolve();

    // Fired exactly once, with the `unreachable` code.
    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.code).toBe("unreachable");
    // The deadline was 2 s; the backoff sequence (250+500+1000+2000=3750)
    // crosses it on the 4th iteration's top-of-loop check — well before any
    // attempt cap would matter. The loop stopped: no further connect calls
    // after the give-up.
    const callsAtGiveUp = calls;
    await Promise.resolve();
    expect(calls).toBe(callsAtGiveUp);

    handle.dispose();
  } finally {
    advancer.restore();
  }
});

test("give-up: first paint resets the clock; a later post-paint drop re-arms a fresh window", () => {
  // Two-part: (1) a successful first-paint CLEARS the anchor, so advancing
  // the clock past the deadline WHILE PAINTED never fires give-up; (2) a
  // post-paint drop RE-ARMS the anchor — the post-bounce window is fresh,
  // so a subsequent continuous-unpainted span >= deadline DOES fire.
  const clock = { ms: 1_000_000 };
  const realSetTimeout = globalThis.setTimeout;
  // Swallow the helper's backoff sleeps so the reconnect loop sits idle
  // between our manual clock pushes (we drive give-up via the loop-top
  // check on the NEXT connect attempt, fired by `closeFromServer`).
  const scheduled: (() => void)[] = [];
  globalThis.setTimeout = ((
    handler: Parameters<typeof realSetTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof timeout === "number" && timeout > 0) {
      scheduled.push(handler as () => void);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as () => void, timeout, ...args);
  }) as typeof setTimeout;
  try {
    const fatals: FatalError[] = [];
    let openCount = 0;
    // A factory that opens (paints-capable) on the first connect, then on
    // the post-drop reconnect rejects forever (unreachable after the
    // bounce) so the loop-top check is the only give-up driver.
    const socketRef: { current: MockSocket | null } = { current: null };
    const factory: ConnectFactory = async (_path, handlers) => {
      openCount += 1;
      if (openCount > 1) {
        // Post-bounce: unreachable. Reject so the loop iterates and the
        // top-of-loop `checkGiveUp` sees the re-armed anchor.
        return Promise.reject(new Error("refused post-bounce"));
      }
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
      handlers.open(sock);
      await done;
      return sock;
    };

    const giveUpPolicy: GiveUpPolicy = { deadlineMs: 2_000 };
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-giveup-rearm",
      onSnapshot: () => {
        /* ignore */
      },
      onFatal: (err) => fatals.push(err),
      connect: factory,
      giveUpPolicy,
      now: () => clock.ms,
    });

    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }

    // (1) First paint: ANY collection's first `result` clears the anchor.
    sock.deliver([emptyResult("epics", "test-giveup-rearm-epics")]);
    // Advance WELL past the deadline while painted — give-up must NOT fire.
    clock.ms += 10_000;
    // Drain any scheduled backoff (none expected on the painted path).
    expect(fatals).toHaveLength(0);

    // (2) Post-paint drop: re-arms a FRESH anchor at the current clock.
    sock.closeFromServer();
    // The reconnect loop now rejects forever (openCount > 1). Drive a few
    // backoff iterations, advancing the clock past the fresh deadline so the
    // top-of-loop check trips.
    clock.ms += 2_500;
    // Flush the rejected-connect microtask chain + the swallowed backoff
    // callbacks so the loop re-iterates and runs `checkGiveUp`.
    return (async () => {
      for (let i = 0; i < 8 && fatals.length === 0; i++) {
        // Fire any swallowed backoff callbacks to advance the loop.
        const pending = scheduled.splice(0);
        for (const cb of pending) {
          cb();
        }
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(fatals).toHaveLength(1);
      expect(fatals[0]?.code).toBe("unreachable");
      handle.dispose();
    })();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("give-up: no policy (default) — reconnect-forever, onFatal never fires even past any deadline", async () => {
  // Regression: the board/TUI contract. With NO `giveUpPolicy`, the helper
  // reconnects forever; an injected clock advanced arbitrarily far never
  // produces a give-up. (The capped-backoff sequence + no-onFatal assertion
  // for the no-policy case is covered by the dedicated capped-backoff test
  // above; this asserts the give-up arm specifically stays inert.)
  const clock = { ms: 1_000_000 };
  const advancer = installBackoffClockAdvancer(clock);
  try {
    let calls = 0;
    let resolveAfterN: (() => void) | null = null;
    const observedEnough = new Promise<void>((resolve) => {
      resolveAfterN = resolve;
    });
    const factory: ConnectFactory = (_path, _handlers) => {
      calls += 1;
      if (calls >= 12) {
        // Plenty of reject iterations (clock now far past any plausible
        // deadline). Hand back a never-resolving promise to idle the loop.
        resolveAfterN?.();
        resolveAfterN = null;
        return new Promise<ReadinessSocket>(() => {
          /* never resolves — held until dispose() */
        });
      }
      return Promise.reject(new Error(`refused #${calls}`));
    };

    const fatals: FatalError[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-noinpolicy",
      onSnapshot: () => {
        throw new Error("onSnapshot must not fire");
      },
      onFatal: (err) => fatals.push(err),
      connect: factory,
      // No giveUpPolicy. Inject `now` to prove the give-up arm stays inert
      // even with a controllable clock advanced far past any deadline.
      now: () => clock.ms,
    });

    await observedEnough;
    await Promise.resolve();

    // Clock has advanced by the full backoff sum (>> any deadline), yet
    // give-up never fired — default is reconnect-forever.
    expect(fatals).toHaveLength(0);
    expect(clock.ms).toBeGreaterThan(1_000_000 + 10_000);

    handle.dispose();
  } finally {
    advancer.restore();
  }
});

// ---------------------------------------------------------------------------
// Slow-flight + hard-deadline reconnect coverage (fn-622.3)
//
// The helper's `pollAll` walks every state on each `POLL_MS` tick and
// compares `Date.now() - queryInFlightSince` against `SLOW_FLIGHT_MS`
// (1 s) and `QUERY_TIMEOUT_MS` (5 s). To stay deterministic and
// millisecond-fast we mock `Date.now()` plus capture the `setInterval`
// handler the helper installs in `open` so the test can fire `pollAll`
// manually at chosen wall-clock points. No real time elapses.
// ---------------------------------------------------------------------------
//
// Shared scaffolding: install `Date.now` + `setInterval` spies, return
// a `tick(ms)` advancer that bumps the mocked clock and runs the
// captured poll handler. `restore()` unwinds both.
// ---------------------------------------------------------------------------

interface TimerHarness {
  setNow(ms: number): void;
  advance(ms: number): void;
  pollHandler(): () => void;
  pollIntervalMs(): number;
  restore(): void;
}

function installTimerHarness(startMs = 1_000_000): TimerHarness {
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let now = startMs;
  let captured: (() => void) | null = null;
  let capturedInterval = 0;
  let realId: ReturnType<typeof realSetInterval> | null = null;
  Date.now = () => now;
  globalThis.setInterval = ((
    handler: Parameters<typeof realSetInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    // Capture the first positive-interval handler — that's the helper's
    // poll loop. Any other timers (Bun internals) fall through to the
    // real implementation untouched. The captured handler is invoked
    // manually by `pollHandler()`; we still register a real interval
    // with a huge delay so the spy's return id is a valid timer the
    // helper can `clearInterval` without complaint.
    if (captured === null && typeof timeout === "number" && timeout > 0) {
      captured = handler as () => void;
      capturedInterval = timeout;
      realId = realSetInterval(() => {
        /* never fires in test horizon */
      }, 86_400_000);
      return realId;
    }
    return realSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined && id === realId) {
      realClearInterval(realId);
      realId = null;
      captured = null;
      return;
    }
    realClearInterval(id);
  }) as typeof clearInterval;
  return {
    setNow(ms: number): void {
      now = ms;
    },
    advance(ms: number): void {
      now += ms;
    },
    pollHandler(): () => void {
      if (captured === null) {
        throw new Error("poll handler never captured");
      }
      return captured;
    },
    pollIntervalMs(): number {
      return capturedInterval;
    },
    restore(): void {
      Date.now = realNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      if (realId !== null) {
        realClearInterval(realId);
      }
    },
  };
}

test("subscribeReadiness: Path A (<1 s) — result arrives before slow-flight threshold, no events", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-patha",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire on the happy path");
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // Advance to t=500 ms and deliver a result for one collection.
    harness.advance(500);
    sock.deliver([emptyResult("epics", "test-patha-epics")]);

    // Run the poll — no state should be stuck (epics resolved at 500 ms,
    // jobs + subagent still in flight but only at 500 ms in-flight age).
    harness.pollHandler()();

    expect(
      lifecycle.filter((e) => e.event === "query_slow_flight"),
    ).toHaveLength(0);
    expect(lifecycle.filter((e) => e.event === "query_timeout")).toHaveLength(
      0,
    );

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: Path B (1–5 s) — slow-flight latches once, timeout fires reconnect at 5 s", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-pathb",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire — timeout is not a fatal");
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // t=1000 ms + epsilon: slow-flight should fire exactly once per state.
    harness.advance(1001);
    harness.pollHandler()();

    const slowAt1s = lifecycle.filter((e) => e.event === "query_slow_flight");
    // Eleven collections all in flight, all crossed 1 s — eleven emits (fn-626
    // added `git`; fn-637.4 deleted the completed-epics resolver-only sub;
    // fn-643.5 added `dead_letters`; fn-721 added `pending_dispatches`;
    // fn-770 added `autopilot_state` + `armed_epics`; fn-813 added
    // `scheduled_tasks`; fn-941 added `block_escalations`; fn-952 added
    // `tmux_client_focus`).
    expect(slowAt1s).toHaveLength(11);
    expect(slowAt1s.map((e) => e.detail?.collection).sort()).toEqual([
      "armed_epics",
      "autopilot_state",
      "block_escalations",
      "dead_letters",
      "epics",
      "git",
      "jobs",
      "pending_dispatches",
      "scheduled_tasks",
      "subagent_invocations",
      "tmux_client_focus",
    ]);

    // t=2500 ms: another poll, latch must hold — no NEW slow-flight events.
    harness.advance(1499);
    harness.pollHandler()();
    expect(
      lifecycle.filter((e) => e.event === "query_slow_flight"),
    ).toHaveLength(11);

    // t=5001 ms: timeout fires. Single-flight `reconnecting` guard means
    // exactly one `query_timeout` event for the FIRST stuck state.
    harness.advance(2501);
    harness.pollHandler()();
    const timeouts = lifecycle.filter((e) => e.event === "query_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.detail?.collection).toBe("epics");
    expect(typeof timeouts[0]?.detail?.age_ms).toBe("number");
    expect((timeouts[0]?.detail?.age_ms as number) >= 5000).toBe(true);

    // Socket was end()'d to kick the reconnect loop.
    expect(sock.ended).toBe(true);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: Path C — reconnect clears slow-flight state, fresh window emits cleanly", async () => {
  const harness = installTimerHarness();
  try {
    let connectCount = 0;
    const socketRefs: { current: MockSocket | null }[] = [];
    const factory: ConnectFactory = async (_path, handlers) => {
      connectCount += 1;
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
      const ref: { current: MockSocket | null } = { current: sock };
      socketRefs.push(ref);
      handlers.open(sock);
      await done;
      return sock;
    };

    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-pathc",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire");
      },
      connect: factory,
    });

    // First connection: trigger a timeout to force reconnect.
    const sock1 = socketRefs[0]?.current;
    if (!sock1) {
      throw new Error("mock socket #1 never installed");
    }
    sock1.takeOutbound();
    harness.advance(5001);
    harness.pollHandler()();
    expect(lifecycle.filter((e) => e.event === "query_timeout")).toHaveLength(
      1,
    );
    expect(sock1.ended).toBe(true);

    // Simulate the close-from-network that follows our `end()` call. The
    // helper's `close` handler runs `teardownConnection()` + kicks
    // `connectWithRetry`, which synchronously re-invokes the factory
    // (the rejection branch is skipped because we return a real
    // resolved promise).
    sock1.closeFromServer();
    // Yield so the awaited connect() resolves and the next `connectOnce`
    // can run.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(connectCount).toBe(2);
    const sock2 = socketRefs[1]?.current;
    if (!sock2) {
      throw new Error("mock socket #2 never installed");
    }
    sock2.takeOutbound();

    // Fresh window: advance another 1001 ms and poll — slow-flight
    // latch must have been cleared by `teardownConnection`, so we
    // get a brand-new emit per state.
    const slowCountBefore = lifecycle.filter(
      (e) => e.event === "query_slow_flight",
    ).length;
    harness.advance(1001);
    harness.pollHandler()();
    const slowCountAfter = lifecycle.filter(
      (e) => e.event === "query_slow_flight",
    ).length;
    // Eleven collections in the new window, eleven fresh emits (fn-626 added
    // `git`; fn-637.4 deleted the completed-epics resolver-only sub;
    // fn-643.5 added `dead_letters`; fn-721 added `pending_dispatches`;
    // fn-770 added `autopilot_state` + `armed_epics`; fn-813 added
    // `scheduled_tasks`; fn-941 added `block_escalations`; fn-952 added
    // `tmux_client_focus`).
    expect(slowCountAfter - slowCountBefore).toBe(11);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: single-flight — two stuck collections produce ONE reconnect at the 5 s deadline", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-singleflight",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire");
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // All six collections are still in flight (no `result` delivered).
    // At t=5001 ms all six cross the deadline on the same poll tick.
    harness.advance(5001);
    harness.pollHandler()();

    // Exactly ONE `query_timeout` event, named after the FIRST state
    // (`epics` — the order in `states[]` matches the makeState calls in
    // `subscribeReadiness`: epics, jobs, subagent_invocations, git,
    // dead_letters, pending_dispatches).
    const timeouts = lifecycle.filter((e) => e.event === "query_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.detail?.collection).toBe("epics");

    // ONE socket end() call (also implies one reconnect kick).
    expect(sock.ended).toBe(true);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: non-terminal error (one collection already has a result) does NOT invoke onFatal", () => {
  // Companion-of-(d): pin the gating contract. A `result` from any one
  // collection means the query shape is valid; a subsequent error is
  // likely transient and the next refetch can recover. `onFatal` MUST
  // NOT fire in that branch.
  const { factory, socketRef } = makeMockConnect();
  let fatalCalls = 0;
  const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-non-fatal",
    onSnapshot: () => {
      /* ignore — gate stays closed (only one collection has a result) */
    },
    onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
    onFatal: () => {
      fatalCalls += 1;
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // One collection succeeds…
  sock.deliver([emptyResult("epics", "test-non-fatal-epics")]);
  // …then an error arrives. Gate gating: at least one `gotResult` =
  // true → NOT terminal → no `onFatal`.
  sock.deliver([errorFrame("bad_frame", "transient", 1)]);

  expect(fatalCalls).toBe(0);
  // Lifecycle still saw the error (the helper always surfaces it).
  expect(lifecycle.filter((e) => e.event === "error")).toHaveLength(1);
  // Socket NOT torn down by the error branch — reconnect loop untouched.
  expect(sock.ended).toBe(false);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// Multi-sub routing + 500ms-refetch-removal coverage (fn-632.2)
//
// The server-side multi-sub refactor (fn-632.1) added `id?: string` to
// `patch`/`meta` frames so a connection carrying N concurrent subs can
// route each frame back to the originating sub. The client-side change
// here is two-part: (1) id-first routing on result/patch/meta with a
// fall-through to collection lookup (legacy server compat), (2) drop
// the 500ms steady-poll refetch backstop — patch/meta drive freshness
// now, the poll loop is slow-flight detection only.
// ---------------------------------------------------------------------------

function patchFrame(
  collection: string,
  id: string | undefined,
  rev = 2,
): ServerFrame {
  return {
    type: "patch",
    ...(id === undefined ? {} : { id }),
    collection,
    rev,
    row: { epic_id: "irrelevant" },
  };
}

function metaFrameWithId(
  collection: string,
  id: string | undefined,
  rev = 2,
): ServerFrame {
  return {
    type: "meta",
    ...(id === undefined ? {} : { id }),
    collection,
    rev,
    total: 0,
  };
}

test("subscribeReadiness: id-first routing — patch{id} triggers a refetch on the matching sub", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-idroute",
    onSnapshot: () => {
      /* ignore */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Resolve the eight initial queries so subsequent in-flight tracking
  // is clean — refetch coalesce is exercised here, not first-paint.
  expect(sock.takeOutbound()).toHaveLength(11);
  sock.deliver([
    emptyResult("epics", "test-idroute-epics"),
    emptyResult("jobs", "test-idroute-jobs"),
    emptyResult("subagent_invocations", "test-idroute-subagent-invocations"),
    emptyResult("git", "test-idroute-git"),
    emptyResult("dead_letters", "test-idroute-dead-letters"),
    emptyResult("pending_dispatches", "test-idroute-pending-dispatches"),
    emptyResult("autopilot_state", "test-idroute-autopilot-state"),
    emptyResult("scheduled_tasks", "test-idroute-scheduled-tasks"),
    emptyResult("armed_epics", "test-idroute-armed-epics"),
    emptyResult("block_escalations", "test-idroute-block-escalations"),
    emptyResult("tmux_client_focus", "test-idroute-tmux-client-focus"),
  ]);
  sock.takeOutbound();

  // A `patch` carrying ONLY the sub id (no collection match needed) is
  // routed via bySubId to the epics state. Verify by asserting exactly
  // ONE follow-up query is emitted, and it targets the `epics`
  // collection.
  sock.deliver([patchFrame("epics", "test-idroute-epics", 3)]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("epics");
  expect((follow[0] as { id: string }).id).toBe("test-idroute-epics");

  handle.dispose();
});

test("subscribeReadiness: legacy server compat — patch with no id falls back to byCollection routing", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-legacy",
    onSnapshot: () => {
      /* ignore */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  expect(sock.takeOutbound()).toHaveLength(11);
  sock.deliver([
    emptyResult("epics", "test-legacy-epics"),
    emptyResult("jobs", "test-legacy-jobs"),
    emptyResult("subagent_invocations", "test-legacy-subagent-invocations"),
    emptyResult("git", "test-legacy-git"),
    emptyResult("dead_letters", "test-legacy-dead-letters"),
    emptyResult("pending_dispatches", "test-legacy-pending-dispatches"),
    emptyResult("autopilot_state", "test-legacy-autopilot-state"),
    emptyResult("scheduled_tasks", "test-legacy-scheduled-tasks"),
    emptyResult("armed_epics", "test-legacy-armed-epics"),
    emptyResult("block_escalations", "test-legacy-block-escalations"),
    emptyResult("tmux_client_focus", "test-legacy-tmux-client-focus"),
  ]);
  sock.takeOutbound();

  // A `patch` WITHOUT `id` (legacy single-sub server) is routed by
  // collection — `frame.id === undefined` short-circuits the bySubId
  // lookup, then byCollection.get("jobs") resolves the jobs state.
  sock.deliver([patchFrame("jobs", undefined, 4)]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("jobs");

  // Same for `meta` — legacy servers emit neither id, and the
  // collection lookup is the only routable signal.
  sock.deliver([metaFrameWithId("git", undefined, 5)]);
  const follow2 = sock.takeOutbound();
  expect(follow2).toHaveLength(1);
  expect((follow2[0] as { collection: string }).collection).toBe("git");

  handle.dispose();
});

test("subscribeReadiness: reconnect re-issues queries with the same stable subIds", async () => {
  // Build a multi-connect factory so the helper's reconnect loop can
  // hand a second mock socket on the second `connectOnce()` pass.
  let connectCount = 0;
  const socketRefs: { current: MockSocket | null }[] = [];
  const factory: ConnectFactory = async (_path, handlers) => {
    connectCount += 1;
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
    const ref: { current: MockSocket | null } = { current: sock };
    socketRefs.push(ref);
    handlers.open(sock);
    await done;
    return sock;
  };

  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-reconnect",
    onSnapshot: () => {
      /* ignore — first-paint isn't reached, no results delivered */
    },
    connect: factory,
  });

  const sock1 = socketRefs[0]?.current;
  if (!sock1) {
    throw new Error("mock socket #1 never installed");
  }
  const initial1 = sock1.takeOutbound();
  expect(initial1).toHaveLength(11);
  const initialIds1 = initial1.map((f) => (f as { id: string }).id).sort();
  // fn-770: the reconnect re-primes the two new armed-mode subscriptions
  // (`autopilot_state` + `armed_epics`) with the SAME stable subIds — they're
  // constants in subscribeReadiness, built once into the `states[]` list and
  // re-issued verbatim on every reconnect.
  expect(initialIds1).toEqual([
    "test-reconnect-armed-epics",
    "test-reconnect-autopilot-state",
    "test-reconnect-block-escalations",
    "test-reconnect-dead-letters",
    "test-reconnect-epics",
    "test-reconnect-git",
    "test-reconnect-jobs",
    "test-reconnect-pending-dispatches",
    "test-reconnect-scheduled-tasks",
    "test-reconnect-subagent-invocations",
    "test-reconnect-tmux-client-focus",
  ]);

  // Force a close so `connectWithRetry` re-runs `connectOnce` and
  // re-fires the open handler against a fresh socket.
  sock1.closeFromServer();
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(connectCount).toBe(2);
  const sock2 = socketRefs[1]?.current;
  if (!sock2) {
    throw new Error("mock socket #2 never installed");
  }
  const initial2 = sock2.takeOutbound();
  expect(initial2).toHaveLength(11);
  const initialIds2 = initial2.map((f) => (f as { id: string }).id).sort();
  // EXACT same subIds — they're constants in subscribeReadiness, and the
  // states[] list is built once at the top of the helper and reused
  // verbatim across reconnects. This is the invariant that lets the
  // server rebuild the same subs by id post-reconnect.
  expect(initialIds2).toEqual(initialIds1);

  handle.dispose();
});

test("subscribeReadiness: pollAll no longer schedules per-state refetches — freshness is patch-driven only", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-no-poll-refetch",
      onSnapshot: () => {
        /* ignore */
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // Resolve all initial queries so every state has gotResult and
    // queryInFlight cleared. With the second-pass refetch removed,
    // pollAll over a fully-resolved state list should fire ZERO new
    // outbound writes.
    sock.deliver([
      emptyResult("epics", "test-no-poll-refetch-epics"),
      emptyResult("epics", "test-no-poll-refetch-completed-epics"),
      emptyResult("jobs", "test-no-poll-refetch-jobs"),
      emptyResult(
        "subagent_invocations",
        "test-no-poll-refetch-subagent-invocations",
      ),
      emptyResult("git", "test-no-poll-refetch-git"),
      emptyResult("dead_letters", "test-no-poll-refetch-dead-letters"),
      emptyResult(
        "pending_dispatches",
        "test-no-poll-refetch-pending-dispatches",
      ),
    ]);
    sock.takeOutbound();

    // Advance well past POLL_MS (500) and fire the poll handler several
    // times. If the legacy second pass still existed it would write 4
    // refetch queries per tick — assert zero writes across multiple
    // poll ticks.
    harness.advance(600);
    harness.pollHandler()();
    harness.advance(600);
    harness.pollHandler()();
    harness.advance(600);
    harness.pollHandler()();
    expect(sock.outbound).toHaveLength(0);

    // …but a patch arrival STILL drives a refetch (the legitimate
    // freshness path the poll-loop refetch used to backstop).
    sock.deliver([patchFrame("epics", "test-no-poll-refetch-epics", 2)]);
    expect(sock.takeOutbound()).toHaveLength(1);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// subscribeCollection direct-merge (Lever A1, fn-694.1)
//
// A `patch` frame on a sidecar subscription renders its row DIRECTLY via
// `onRows` with NO refetch round-trip; `meta` still refetches; stale/equal-
// version and pre-`gotResult` patches are dropped; `onRows` hands back a
// fresh array copy.
// ---------------------------------------------------------------------------

/** A `result` for `jobs` carrying real versioned rows (pk `job_id`). */
function jobsResult(
  id: string,
  rows: Record<string, unknown>[],
  rev = 1,
): ServerFrame {
  return {
    type: "result",
    id,
    collection: "jobs",
    rev,
    total: rows.length,
    rows,
  };
}

/** A `patch` for `jobs` carrying one full versioned row. */
function jobsPatch(
  id: string | undefined,
  row: Record<string, unknown>,
  rev = 2,
): ServerFrame {
  return {
    type: "patch",
    ...(id === undefined ? {} : { id }),
    collection: "jobs",
    rev,
    row,
  };
}

function makeJobsSidecar(idPrefix: string): {
  sock: MockSocket;
  rowsLog: Record<string, unknown>[][];
  handle: ReturnType<typeof subscribeCollection>;
} {
  const { factory, socketRef } = makeMockConnect();
  const rowsLog: Record<string, unknown>[][] = [];
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    collection: "jobs",
    onRows: (rows) => rowsLog.push(rows),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  return { sock, rowsLog, handle };
}

test("subscribeCollection: patch merges the row and renders via onRows with NO refetch", () => {
  const { sock, rowsLog, handle } = makeJobsSidecar("test-merge");
  const subId = "test-merge-jobs";

  // Seed the page.
  expect(sock.takeOutbound()).toHaveLength(1);
  sock.deliver([
    jobsResult(subId, [
      { job_id: "j1", state: "working", last_event_id: 10 },
      { job_id: "j2", state: "stopped", last_event_id: 11 },
    ]),
  ]);
  expect(rowsLog).toHaveLength(1);
  expect(rowsLog[0]).toHaveLength(2);
  sock.takeOutbound();

  // A patch on j1 with a strictly-newer version merges + renders directly.
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "stopped", last_event_id: 20 }),
  ]);
  // NO refetch query went out.
  expect(sock.takeOutbound()).toHaveLength(0);
  // onRows fired again with the merged row in wire/page order.
  expect(rowsLog).toHaveLength(2);
  const merged = rowsLog[1] as Record<string, unknown>[];
  expect(merged).toHaveLength(2);
  expect(merged[0]).toEqual({
    job_id: "j1",
    state: "stopped",
    last_event_id: 20,
  });
  // j2 untouched, order preserved.
  expect(merged[1]).toEqual({
    job_id: "j2",
    state: "stopped",
    last_event_id: 11,
  });

  handle.dispose();
});

test("subscribeCollection: meta still triggers a refetch", () => {
  const { sock, rowsLog, handle } = makeJobsSidecar("test-meta");
  const subId = "test-meta-jobs";

  expect(sock.takeOutbound()).toHaveLength(1);
  sock.deliver([
    jobsResult(subId, [{ job_id: "j1", state: "working", last_event_id: 10 }]),
  ]);
  expect(rowsLog).toHaveLength(1);
  sock.takeOutbound();

  // A `meta` (membership change) is unmergeable from one row → refetch.
  sock.deliver([
    { type: "meta", id: subId, collection: "jobs", rev: 3, total: 2 },
  ]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("jobs");
  // No new render yet — the refetch result hasn't arrived.
  expect(rowsLog).toHaveLength(1);

  handle.dispose();
});

test("subscribeCollection: a stale / equal-version patch is dropped", () => {
  const { sock, rowsLog, handle } = makeJobsSidecar("test-stale");
  const subId = "test-stale-jobs";

  expect(sock.takeOutbound()).toHaveLength(1);
  sock.deliver([
    jobsResult(subId, [{ job_id: "j1", state: "working", last_event_id: 30 }]),
  ]);
  expect(rowsLog).toHaveLength(1);
  sock.takeOutbound();

  // Equal version → dropped (not strictly newer).
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "stopped", last_event_id: 30 }),
  ]);
  // Older version → dropped.
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "stopped", last_event_id: 5 }),
  ]);
  // Neither rendered nor refetched.
  expect(sock.takeOutbound()).toHaveLength(0);
  expect(rowsLog).toHaveLength(1);

  // …but a strictly-newer one still merges.
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "ended", last_event_id: 31 }),
  ]);
  expect(sock.takeOutbound()).toHaveLength(0);
  expect(rowsLog).toHaveLength(2);
  expect((rowsLog[1] as Record<string, unknown>[])[0]).toEqual({
    job_id: "j1",
    state: "ended",
    last_event_id: 31,
  });

  handle.dispose();
});

test("subscribeCollection: a patch before the first result is dropped (gotResult guard)", () => {
  const { sock, rowsLog, handle } = makeJobsSidecar("test-preseed");
  const subId = "test-preseed-jobs";

  // Initial query is out, but NO result has landed yet.
  expect(sock.takeOutbound()).toHaveLength(1);

  // A patch arriving pre-seed has no page to merge into → dropped, and
  // (since gotResult is false) it falls through to scheduleRefetchFor. The
  // initial query is still in flight, so the refetch coalesces into
  // refetchDirty rather than writing a second query immediately.
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "working", last_event_id: 10 }),
  ]);
  // No render — gotResult guard held.
  expect(rowsLog).toHaveLength(0);
  // No second query yet (coalesced behind the in-flight initial query).
  expect(sock.takeOutbound()).toHaveLength(0);

  // When the initial result lands, the coalesced refetchDirty fires exactly
  // one follow-up query (the standard scheduleRefetchFor recovery path).
  sock.deliver([
    jobsResult(subId, [{ job_id: "j1", state: "working", last_event_id: 10 }]),
  ]);
  expect(rowsLog).toHaveLength(1);
  expect(sock.takeOutbound()).toHaveLength(1);

  handle.dispose();
});

test("subscribeCollection: a patch for an off-page row is dropped (membership guard)", () => {
  const { sock, rowsLog, handle } = makeJobsSidecar("test-offpage");
  const subId = "test-offpage-jobs";

  expect(sock.takeOutbound()).toHaveLength(1);
  sock.deliver([
    jobsResult(subId, [{ job_id: "j1", state: "working", last_event_id: 10 }]),
  ]);
  expect(rowsLog).toHaveLength(1);
  sock.takeOutbound();

  // A patch for an id NOT in the current page is dropped (membership change
  // arrives as `meta`, not a blind-appended patch).
  sock.deliver([
    jobsPatch(subId, { job_id: "j99", state: "working", last_event_id: 99 }),
  ]);
  expect(sock.takeOutbound()).toHaveLength(0);
  expect(rowsLog).toHaveLength(1);

  handle.dispose();
});

test("subscribeCollection: onRows hands back a fresh array copy per render", () => {
  const { sock, rowsLog, handle } = makeJobsSidecar("test-copy");
  const subId = "test-copy-jobs";

  expect(sock.takeOutbound()).toHaveLength(1);
  sock.deliver([
    jobsResult(subId, [{ job_id: "j1", state: "working", last_event_id: 10 }]),
  ]);
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "stopped", last_event_id: 20 }),
  ]);
  expect(rowsLog).toHaveLength(2);
  // Distinct array instances — a retained earlier slice is not mutated by a
  // later in-place patch merge.
  expect(rowsLog[0]).not.toBe(rowsLog[1]);
  // The retained first slice still shows the ORIGINAL row, not the patched one.
  expect((rowsLog[0] as Record<string, unknown>[])[0]).toEqual({
    job_id: "j1",
    state: "working",
    last_event_id: 10,
  });

  handle.dispose();
});

// ---------------------------------------------------------------------------
// fn-770: armed-mode eligibility — the board/CLI readiness view agrees with
// the reconciler. The client subscribes to `autopilot_state` + `armed_epics`,
// computes the eligible set (mirroring `loadReconcileSnapshot`, default
// `'yolo'`), and threads it into `computeReadiness` so the displayed per-root
// winner matches what the daemon dispatches. The pure two-pass mutex logic is
// covered in `test/readiness.test.ts`; these tests prove the CLIENT plumbing —
// wire rows → eligible set → `computeReadiness` param — closes the
// board≠dispatch divergence the server-side fix (task .1) leaves on the read
// path.
// ---------------------------------------------------------------------------

/**
 * A wire `epics` row carrying ONE ready task on `project_dir`. Mirrors the
 * `makeEpic`/`makeTask` defaults in `test/readiness.test.ts` (status open,
 * worker_phase open, runtime todo, no deps/jobs) so the pure readiness pass
 * yields a `ready` task — the substrate for the per-root tiebreak.
 */
function readyEpicRow(
  epicId: string,
  epicNumber: number,
  projectDir: string,
): Record<string, unknown> {
  return {
    epic_id: epicId,
    epic_number: epicNumber,
    title: "epic",
    project_dir: projectDir,
    status: "open",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [
      {
        task_id: `${epicId}.1`,
        epic_id: epicId,
        task_number: 1,
        title: "task",
        target_repo: null,
        tier: null,
        worker_phase: "open",
        runtime_status: "todo",
        depends_on: [],
        jobs: [],
      },
    ],
    jobs: [],
    job_links: [],
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
  };
}

// Two open epics sharing `/repo`; fn-1 sorts first (would win the legacy
// single-pass per-root slot), fn-2 sorts second.
function sharedRootEpicRows(): Record<string, unknown>[] {
  return [
    readyEpicRow("fn-1-foo", 1, "/repo"),
    readyEpicRow("fn-2-bar", 2, "/repo"),
  ];
}

test("subscribeReadiness: armed mode — the eligible epic wins the shared-root slot the board displays (matches the reconciler)", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-armed",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  sock.takeOutbound();
  // Deliver the full first-paint frame: the shared-root pair, an
  // `autopilot_state` row in `armed` mode, and an `armed_epics` row arming
  // ONLY fn-2 (the later-sorted epic). Empty results for the other four
  // collections clear the gate.
  sock.deliver([
    rowsResult("epics", "test-armed-epics", sharedRootEpicRows()),
    emptyResult("jobs", "test-armed-jobs"),
    emptyResult("subagent_invocations", "test-armed-subagent-invocations"),
    emptyResult("git", "test-armed-git"),
    emptyResult("dead_letters", "test-armed-dead-letters"),
    emptyResult("pending_dispatches", "test-armed-pending-dispatches"),
    rowsResult("autopilot_state", "test-armed-autopilot-state", [
      { id: 1, mode: "armed", last_event_id: 5 },
    ]),
    emptyResult("scheduled_tasks", "test-armed-scheduled-tasks"),
    rowsResult("armed_epics", "test-armed-armed-epics", [
      { epic_id: "fn-2-bar", last_event_id: 6 },
    ]),
    emptyResult("block_escalations", "test-armed-block-escalations"),
    emptyResult("tmux_client_focus", "test-armed-tmux-client-focus"),
  ]);

  expect(snapshots).toHaveLength(1);
  const readiness = snapshots[0]?.readiness;
  if (!readiness) {
    throw new Error("no readiness snapshot");
  }
  // The eligible (armed) fn-2 wins the per-root slot; the earlier-sorted
  // ineligible fn-1 is demoted to `single-task-per-root`. This is the same
  // winner the reconciler dispatches — board≠dispatch divergence closed.
  expect(readiness.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  expect(readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-root" },
  });

  handle.dispose();
});

test("subscribeReadiness: empty autopilot_state defaults to yolo — no eligibility filtering (earliest-sorted ready wins)", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-yolo",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  sock.takeOutbound();
  // Same shared-root pair, but `autopilot_state` is EMPTY (no row) → the
  // client defaults `mode` to `'yolo'` and passes `undefined` (no eligible
  // set), so `computeReadiness` takes the legacy single-pass. `armed_epics`
  // arms fn-2 — but in yolo that's IGNORED (eligibility isn't consulted), so
  // the earlier-sorted fn-1 still wins, byte-for-byte the pre-fn-770 board.
  sock.deliver([
    rowsResult("epics", "test-yolo-epics", sharedRootEpicRows()),
    emptyResult("jobs", "test-yolo-jobs"),
    emptyResult("subagent_invocations", "test-yolo-subagent-invocations"),
    emptyResult("git", "test-yolo-git"),
    emptyResult("dead_letters", "test-yolo-dead-letters"),
    emptyResult("pending_dispatches", "test-yolo-pending-dispatches"),
    emptyResult("autopilot_state", "test-yolo-autopilot-state"),
    emptyResult("scheduled_tasks", "test-yolo-scheduled-tasks"),
    rowsResult("armed_epics", "test-yolo-armed-epics", [
      { epic_id: "fn-2-bar", last_event_id: 6 },
    ]),
    emptyResult("block_escalations", "test-yolo-block-escalations"),
    emptyResult("tmux_client_focus", "test-yolo-tmux-client-focus"),
  ]);

  expect(snapshots).toHaveLength(1);
  const readiness = snapshots[0]?.readiness;
  if (!readiness) {
    throw new Error("no readiness snapshot");
  }
  // yolo single-pass: the earliest-sorted ready row (fn-1) claims `/repo`,
  // fn-2 is demoted — arming is not consulted.
  expect(readiness.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(readiness.perTask.get("fn-2-bar.1")).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-root" },
  });

  handle.dispose();
});

// ---------------------------------------------------------------------------
// fn-775 — cap-reject (`max_connections`) is RETRYABLE, not terminal.
//
// A `max_connections` error frame is a CAPACITY-TRANSIENT reject: keeperd
// ACCEPTS the connection, serves the error frame, then `socket.end()`s. The
// pre-fix terminal gate (`!gotResult` pre-paint) classified this as a
// malformed-query terminal and fired `onFatal` (rendered `reason=connect`).
// The fix: route a `TRANSIENT_SERVER_CODES` code to teardown + capped-backoff
// reconnect, never `onFatal`. The reset is keyed off SERVED (first result),
// not ACCEPTED (open), so an accept-then-cap-reject cycle GROWS the backoff.
// ---------------------------------------------------------------------------

/**
 * A multi-connect factory: each `connect()` mints a fresh `MockSocket`, fires
 * `open` synchronously, and records the socket in `sockets`. Mirrors
 * `makeMockConnect` but keeps EVERY socket (one per reconnect) so the
 * cap-reject reconnect chain is inspectable. `connectCount` tracks attempts.
 */
function makeMultiConnect(): {
  factory: ConnectFactory;
  sockets: MockSocket[];
  connectCount: () => number;
} {
  const sockets: MockSocket[] = [];
  let count = 0;
  const factory: ConnectFactory = async (_path, handlers) => {
    count += 1;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const sock: MockSocket = {
      outbound: [],
      ended: false,
      terminated: 0,
      handlers,
      write(data: string): void {
        sock.outbound.push(data);
      },
      end(): void {
        sock.ended = true;
        resolveDone?.();
        resolveDone = null;
      },
      terminate(): void {
        sock.terminated = (sock.terminated ?? 0) + 1;
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
    sockets.push(sock);
    handlers.open(sock);
    await done;
    return sock;
  };
  return { factory, sockets, connectCount: () => count };
}

test("fn-775: TRANSIENT_SERVER_CODES contains max_connections (the retryable allowlist)", () => {
  // The named allowlist documents the retryable contract in one place. A
  // capacity reject is in it; a malformed-query code is NOT.
  expect(TRANSIENT_SERVER_CODES.has("max_connections")).toBe(true);
  expect(TRANSIENT_SERVER_CODES.has("bad_frame")).toBe(false);
  expect(TRANSIENT_SERVER_CODES.has("unknown_collection")).toBe(false);
});

test("fn-775: pre-paint max_connections frame → reconnect, never onFatal (no reason=connect)", async () => {
  // Mirrors the connect-rejections-are-not-terminal contract (the
  // capped-backoff test's `onFatal must not fire`) for a CAP reject delivered
  // as a pre-paint error frame. The server serves the frame then closes; the
  // close-driven reconnect must re-enter, and `onFatal` must never fire.
  // Stub Math.random → 0 so the cap-reject full-jitter backoff resolves to a
  // 0ms delay; the reconnect then fires on the next timer tick deterministically
  // (no multi-second wait on the real 2500ms base).
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const { factory, sockets, connectCount } = makeMultiConnect();
    let fatalCalls = 0;
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-cap-reject",
      onSnapshot: () => {
        throw new Error("onSnapshot must not fire — no result ever delivered");
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        fatalCalls += 1;
      },
      connect: factory,
    });

    const sock1 = sockets[0];
    if (!sock1) {
      throw new Error("mock socket #1 never installed");
    }
    expect(sock1.takeOutbound()).toHaveLength(11);

    // Deliver the cap reject BEFORE any collection produced a result, then the
    // server `socket.end()`s — simulate that with `closeFromServer()`.
    sock1.deliver([errorFrame("max_connections", "server full", 0)]);
    // The transient branch did NOT consult isTerminal / onFatal.
    expect(fatalCalls).toBe(0);
    sock1.closeFromServer();

    // Drain the close-driven reconnect: it schedules ONE cap-reject backoff
    // sleep (0ms here), then re-attempts. Flush the timer + the connect.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    // A fresh connection was opened — the reconnect-forever contract held.
    expect(connectCount()).toBeGreaterThanOrEqual(2);
    // onFatal never fired (no `reason=connect` would be rendered downstream).
    expect(fatalCalls).toBe(0);
    // The lifecycle saw the error (always surfaced) AND a `waiting` backoff.
    expect(lifecycle.filter((e) => e.event === "error")).toHaveLength(1);
    expect(
      lifecycle.filter((e) => e.event === "waiting").length,
    ).toBeGreaterThanOrEqual(1);

    handle.dispose();
  } finally {
    Math.random = realRandom;
  }
});

test("fn-775/fn-778: accept-then-cap-reject cycles GROW the backoff (no 250ms pin) up to the ~30s cap", async () => {
  // The reset moved from `open` to first `result`. An accept-then-cap-reject
  // server never serves a result, so `attempt` must climb across cycles —
  // the cap-reject regime (base 2500ms, full jitter) grows then caps at
  // TRANSIENT_BACKOFF_CAP_MS (~30s, fn-778). Stub Math.random to 0.5 so each
  // delay is a deterministic half of its window: floor(0.5 * min(2500*2^(n-1),
  // 30000)) → 1250, 2500, 5000, 10000 (window 2500, 5000, 10000, 20000). The
  // exponential growth proves no 250ms / no-backoff pin AND the new higher cap.
  const observed: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;
  Math.random = () => 0.5;
  globalThis.setTimeout = ((
    handler: Parameters<typeof realSetTimeout>[0],
    timeout?: number,
    ...rest: unknown[]
  ) => {
    if (typeof timeout === "number" && timeout > 0) {
      observed.push(timeout);
      queueMicrotask(() => {
        (handler as () => void)();
      });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as () => void, timeout, ...rest);
  }) as typeof setTimeout;

  try {
    // A factory that, on EVERY open, synchronously delivers a cap reject and
    // then closes — an accept-then-reject server. After a few cycles we stop
    // delivering (hand back a never-resolving open) so the loop idles.
    const cycles = 4;
    let opened = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const factory: ConnectFactory = async (_path, handlers) => {
      opened += 1;
      const thisOpen = opened;
      let resolveSock: (() => void) | null = null;
      const sockDone = new Promise<void>((resolve) => {
        resolveSock = resolve;
      });
      const sock: MockSocket = {
        outbound: [],
        ended: false,
        handlers,
        write() {
          /* swallow */
        },
        end() {
          sock.ended = true;
          resolveSock?.();
          resolveSock = null;
        },
        deliver(frames: ServerFrame[]): void {
          const payload = frames.map(encodeFrame).join("");
          sock.handlers.data(sock, Buffer.from(payload, "utf8"));
        },
        closeFromServer(): void {
          sock.handlers.close();
          resolveSock?.();
          resolveSock = null;
        },
        takeOutbound(): unknown[] {
          return [];
        },
      };
      handlers.open(sock);
      if (thisOpen <= cycles) {
        // accept-then-reject: serve the cap frame, then close.
        sock.deliver([errorFrame("max_connections", "full", 0)]);
        sock.closeFromServer();
      } else {
        // Signal the test and idle.
        resolveDone?.();
        resolveDone = null;
      }
      await sockDone;
      return sock;
    };

    let fatalCalls = 0;
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-cap-grow",
      onSnapshot: () => {
        throw new Error("no result is ever served");
      },
      onFatal: () => {
        fatalCalls += 1;
      },
      connect: factory,
    });

    await done;
    // Let the final idle open settle.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // onFatal never fired — every cycle was a retryable cap reject.
    expect(fatalCalls).toBe(0);
    // One backoff sleep per cap-reject cycle.
    expect(observed.length).toBe(cycles);
    // Deterministic (Math.random=0.5) exponentially-growing sequence under the
    // ~30s transient cap:
    //   window = min(2500 * 2^(attempt-1), 30000); delay = floor(0.5*window)
    //   attempt 1 → 1250, 2 → 2500, 3 → 5000, 4 → 10000
    expect(observed).toEqual([1250, 2500, 5000, 10000]);
    // The first delay is far above the 250ms socket-level base — proof the
    // cap-reject regime (longer base) is in effect, not the socket ladder and
    // not a no-backoff close-path retry.
    expect(observed[0]).toBeGreaterThan(250);
    // The growth exceeds the 5s socket-level ceiling — proof the transient
    // regime rides its OWN higher cap, not the shared `MAX_BACKOFF_MS`.
    expect(Math.max(...observed)).toBeGreaterThan(5000);
    // Every delay stays under the transient ceiling.
    for (const d of observed) {
      expect(d).toBeLessThanOrEqual(30000);
    }

    handle.dispose();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    Math.random = realRandom;
  }
});

test("fn-775: a malformed-query error frame still terminates (onFatal), cap path is narrow", () => {
  // The narrow-terminal companion: a NON-transient pre-paint error frame
  // (`unknown_collection`) is STILL terminal → `onFatal` fires exactly once.
  // The transient allowlist did not widen the recoverable path.
  const { factory, socketRef } = makeMockConnect();
  const fatals: FatalError[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-malformed-still-terminal",
    onSnapshot: () => {
      throw new Error("onSnapshot must not fire on a pre-handshake error");
    },
    onFatal: (err) => fatals.push(err),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  expect(sock.takeOutbound()).toHaveLength(11);

  sock.deliver([errorFrame("unknown_collection", "no such collection", 0)]);

  expect(fatals).toHaveLength(1);
  expect(fatals[0]?.code).toBe("unknown_collection");
  // The malformed-query branch tore the socket down (terminal path).
  expect(sock.ended).toBe(true);

  handle.dispose();
});

test("fn-775: attempt resets on first RESULT (served), not on socket open (accepted)", async () => {
  // After a cap-reject grows `attempt`, a SERVED first result must reset it
  // so the legitimate daemon-bounce fast-reconnect isn't penalized. Drive:
  // open → cap reject (attempt→1, backoff) → reconnect → open → SERVE all
  // eight collections (attempt resets) → close → reconnect. If the reset
  // keyed off `open` it would already be 0 after the first reconnect's open;
  // we prove it's the RESULT by checking the backoff after a SECOND cap reject
  // restarts from the base, not from a stale higher attempt.
  const observed: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;
  Math.random = () => 0.5;
  globalThis.setTimeout = ((
    handler: Parameters<typeof realSetTimeout>[0],
    timeout?: number,
    ...rest: unknown[]
  ) => {
    if (typeof timeout === "number" && timeout > 0) {
      observed.push(timeout);
      queueMicrotask(() => {
        (handler as () => void)();
      });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as () => void, timeout, ...rest);
  }) as typeof setTimeout;

  try {
    const ids = [
      "epics",
      "jobs",
      "subagent-invocations",
      "git",
      "dead-letters",
      "pending-dispatches",
      "autopilot-state",
      "armed-epics",
    ];
    const collections = [
      "epics",
      "jobs",
      "subagent_invocations",
      "git",
      "dead_letters",
      "pending_dispatches",
      "autopilot_state",
      "armed_epics",
    ];
    const idPrefix = "test-cap-served-reset";
    // Script per open: 1 = cap reject, 2 = serve-all-then-close,
    // 3 = cap reject (attempt should restart from base if reset happened),
    // 4+ = idle.
    let opened = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const factory: ConnectFactory = async (_path, handlers) => {
      opened += 1;
      const thisOpen = opened;
      let resolveSock: (() => void) | null = null;
      const sockDone = new Promise<void>((resolve) => {
        resolveSock = resolve;
      });
      const sock: MockSocket = {
        outbound: [],
        ended: false,
        handlers,
        write() {
          /* swallow */
        },
        end() {
          sock.ended = true;
          resolveSock?.();
          resolveSock = null;
        },
        deliver(frames: ServerFrame[]): void {
          const payload = frames.map(encodeFrame).join("");
          sock.handlers.data(sock, Buffer.from(payload, "utf8"));
        },
        closeFromServer(): void {
          sock.handlers.close();
          resolveSock?.();
          resolveSock = null;
        },
        takeOutbound(): unknown[] {
          return [];
        },
      };
      handlers.open(sock);
      if (thisOpen === 1 || thisOpen === 3) {
        sock.deliver([errorFrame("max_connections", "full", 0)]);
        sock.closeFromServer();
      } else if (thisOpen === 2) {
        // Serve every collection → first-paint → attempt resets to 0.
        sock.deliver(
          ids.map((id, k) =>
            emptyResult(collections[k] as string, `${idPrefix}-${id}`),
          ),
        );
        // Then drop so the loop reconnects into open #3.
        sock.closeFromServer();
      } else {
        resolveDone?.();
        resolveDone = null;
      }
      await sockDone;
      return sock;
    };

    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix,
      onSnapshot: () => {
        /* first-paint fires here; we only care about backoff reset */
      },
      connect: factory,
    });

    await done;
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Two cap rejects → two backoff sleeps (opens #1 and #3). The serve at
    // open #2 produced NO backoff (no reject) and reset attempt. So BOTH
    // sleeps must be the attempt-1 base delay (1250 with Math.random=0.5).
    // If the reset had keyed off `open`, the post-serve cap reject's attempt
    // would still be 1 too — but the discriminating failure is the OTHER
    // direction: WITHOUT any served reset (open-keyed only would NOT reset on
    // the non-painting cap cycles), the second sleep would be the attempt-2
    // delay (2500). Observing 1250 twice proves the served result reset it.
    expect(observed).toEqual([1250, 1250]);

    handle.dispose();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    Math.random = realRandom;
  }
});

// ---------------------------------------------------------------------------
// jobsLimit — the dash caps the jobs fetch at a bounded first page so the
// snapshot's single NDJSON line can never exceed `MAX_LINE_LENGTH`. The four
// readiness CLI callers pass no `jobsLimit` and MUST stay unbounded.
// ---------------------------------------------------------------------------

function jobsQuery(frames: unknown[]): { limit?: number; filter?: unknown } {
  const jobs = frames.find(
    (f) => (f as { collection?: string }).collection === "jobs",
  );
  if (!jobs) {
    throw new Error("no jobs query in outbound frames");
  }
  return jobs as { limit?: number; filter?: unknown };
}

test("jobsLimit threads into the jobs query limit, no filter", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-jobslimit",
    onSnapshot: () => {},
    connect: factory,
    jobsLimit: 50,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  const q = jobsQuery(sock.takeOutbound());
  expect(q.limit).toBe(50);
  // No caller filter → the descriptor's live-only default scope applies.
  expect(q.filter).toBeUndefined();
  handle.dispose();
});

test("absent jobsLimit leaves the jobs query unbounded (limit 0)", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-jobslimit-default",
    onSnapshot: () => {},
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  // `?? JOBS_PAGE_LIMIT` (0 = unbounded), the contract the four CLI callers
  // rely on. A `||` would have coerced a future explicit `0` to the fallback.
  expect(jobsQuery(sock.takeOutbound()).limit).toBe(0);
  handle.dispose();
});

// ---------------------------------------------------------------------------
// fn-1015 — the snapshot un-drops the autopilot mode / caps / worktree / armed
//           eligibility the readiness pass already computes, so every downstream
//           reader orients off ONE snapshot. Pure — driven by the mock socket.
// ---------------------------------------------------------------------------

test("subscribeReadiness: snapshot un-drops autopilot mode/caps/worktree + armed eligibility (fn-1015)", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-ap",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Stamp the boot-status header carrying a DELIBERATELY-WRONG N=3 on the epics
  // frame. The snapshot must IGNORE it: the effective per-root cap derives off the
  // folded autopilot_state (stored 99, worktree on) through effectivePerRootCap, so
  // the header value can never skew the reported cap against the reported stored.
  sock.deliver([
    {
      type: "result",
      id: "test-ap-epics",
      collection: "epics",
      rev: 1,
      total: 0,
      rows: [],
      boot: {
        rev: 1,
        head_event_id: 1,
        catching_up: false,
        git_seed_required: false,
        max_concurrent_per_root: 3,
      },
    },
  ]);
  for (const c of [
    "jobs",
    "subagent_invocations",
    "git",
    "dead_letters",
    "pending_dispatches",
    "scheduled_tasks",
    "block_escalations",
    "tmux_client_focus",
  ]) {
    sock.deliver([emptyResult(c, `test-ap-${c.replace(/_/g, "-")}`)]);
  }
  // A populated autopilot_state singleton: playing, armed mode, jobs cap 8,
  // worktree on, stored per-root 99 — the effective cap derives from THIS row.
  sock.deliver([
    rowsResult("autopilot_state", "test-ap-autopilot-state", [
      {
        id: 1,
        paused: 0,
        mode: "armed",
        max_concurrent_jobs: 8,
        max_concurrent_per_root: 99,
        worktree_mode: 1,
      },
    ]),
  ]);
  // Two armed epics, out of sorted order on the wire, so the eligible set proves
  // the stable sort. armed mode computes the closure — an armed id is seeded by
  // its own membership even with no epic rows folded.
  sock.deliver([
    rowsResult("armed_epics", "test-ap-armed-epics", [
      { epic_id: "fn-2-bar" },
      { epic_id: "fn-1-foo" },
    ]),
  ]);
  expect(snapshots).toHaveLength(1);
  const snap = snapshots[0];
  expect(snap?.autopilotPaused).toBe(false);
  expect(snap?.autopilotMode).toBe("armed");
  expect(snap?.maxConcurrentJobs).toBe(8);
  // The EFFECTIVE cap derives off the folded stored intent (99) + worktree mode
  // (on) through effectivePerRootCap — NOT the boot header (3), which is ignored.
  expect(snap?.maxConcurrentPerRoot).toBe(99);
  // The STORED intent is the raw column (99), projected off the same rows. With
  // worktree ON it equals the effective cap; it diverges (and stays distinctly
  // readable) only while worktree is off, where effective floors to 1.
  expect(snap?.maxConcurrentPerRootStored).toBe(99);
  expect(snap?.worktreeMode).toBe(true);
  expect(snap?.autopilotEligibleEpicIds).toEqual(["fn-1-foo", "fn-2-bar"]);

  handle.dispose();
});

test("subscribeReadiness: empty autopilot_state defaults the autopilot fields to the safe side (fn-1015)", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-ap-default",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // Every collection empty, no boot header — the common pre-edge steady state.
  for (const c of [
    "epics",
    "jobs",
    "subagent_invocations",
    "git",
    "dead_letters",
    "pending_dispatches",
    "autopilot_state",
    "armed_epics",
    "scheduled_tasks",
    "block_escalations",
    "tmux_client_focus",
  ]) {
    sock.deliver([emptyResult(c, `test-ap-default-${c.replace(/_/g, "-")}`)]);
  }
  expect(snapshots).toHaveLength(1);
  const snap = snapshots[0];
  // Safe side: paused, yolo, unlimited jobs (null), per-root default (1 — no
  // autopilot rows, so effectivePerRootCap over a worktree-off default floors to
  // 1), worktree off, and no eligibility filter (undefined — yolo computes none).
  expect(snap?.autopilotPaused).toBe(true);
  expect(snap?.autopilotMode).toBe("yolo");
  expect(snap?.maxConcurrentJobs).toBeNull();
  expect(snap?.maxConcurrentPerRoot).toBe(1);
  // No autopilot rows → the stored intent is OMITTED (undefined), never
  // fabricated from the effective default.
  expect(snap?.maxConcurrentPerRootStored).toBeUndefined();
  expect(snap?.worktreeMode).toBe(false);
  expect(snap?.autopilotEligibleEpicIds).toBeUndefined();

  handle.dispose();
});

test("subscribeReadiness: a malformed autopilot_state row falls back to the safe defaults (fn-1015)", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-ap-bad",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  for (const c of [
    "epics",
    "jobs",
    "subagent_invocations",
    "git",
    "dead_letters",
    "pending_dispatches",
    "armed_epics",
    "scheduled_tasks",
    "block_escalations",
    "tmux_client_focus",
  ]) {
    sock.deliver([emptyResult(c, `test-ap-bad-${c.replace(/_/g, "-")}`)]);
  }
  // A present-but-garbage singleton: every column an illegal value.
  sock.deliver([
    rowsResult("autopilot_state", "test-ap-bad-autopilot-state", [
      {
        id: 1,
        paused: "nope",
        mode: "bananas",
        max_concurrent_jobs: -4,
        max_concurrent_per_root: 0,
        worktree_mode: 7,
      },
    ]),
  ]);
  expect(snapshots).toHaveLength(1);
  const snap = snapshots[0];
  expect(snap?.autopilotPaused).toBe(true); // non-number paused → paused
  expect(snap?.autopilotMode).toBe("yolo"); // unknown mode → yolo
  expect(snap?.maxConcurrentJobs).toBeNull(); // non-positive → unlimited
  expect(snap?.maxConcurrentPerRoot).toBe(1); // worktree off (7 !== 1) → floors to 1
  expect(snap?.worktreeMode).toBe(false); // worktree_mode !== 1 → off
  expect(snap?.autopilotEligibleEpicIds).toBeUndefined(); // yolo computes none

  handle.dispose();
});

// ---------------------------------------------------------------------------
// fn-1197 — the reported EFFECTIVE per-root cap derives off the folded
//   autopilot_state through the ONE seam (`effectivePerRootCap`), IDENTICALLY at
//   boot and in steady state. The incident: after every daemon boot an
//   `autopilot-change` delta flipped per_root 1↔2 while {stored, worktree_mode}
//   held steady — the snapshot latched the effective cap off the boot header (a
//   SECOND source) that lagged the folded stored/worktree by a frame. Now a boot
//   frame (with a deliberately-wrong header value) and a steady frame (no header)
//   with identical folded inputs report a byte-identical effective value, and the
//   stored intent stays distinctly readable when worktree mode floors it to 1.
// ---------------------------------------------------------------------------

// Drive one subscription to first-paint and return its snapshot. `bootHeaderN`,
// when set, stamps a boot-status header carrying that (wrong) effective value on
// the epics frame — the boot-emission path; omitted → the steady path (no header).
function driveFn1197Snapshot(opts: {
  stored: number;
  worktreeOn: boolean;
  bootHeaderN?: number;
}): ReadinessClientSnapshot {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-1197",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();
  sock.deliver([
    {
      type: "result",
      id: "test-1197-epics",
      collection: "epics",
      rev: 1,
      total: 0,
      rows: [],
      ...(opts.bootHeaderN === undefined
        ? {}
        : {
            boot: {
              rev: 1,
              head_event_id: 1,
              catching_up: false,
              git_seed_required: false,
              max_concurrent_per_root: opts.bootHeaderN,
            },
          }),
    },
  ]);
  for (const c of [
    "jobs",
    "subagent_invocations",
    "git",
    "dead_letters",
    "pending_dispatches",
    "scheduled_tasks",
    "block_escalations",
    "tmux_client_focus",
    "armed_epics",
  ]) {
    sock.deliver([emptyResult(c, `test-1197-${c.replace(/_/g, "-")}`)]);
  }
  // The folded autopilot_state carrying the {stored, worktree} under test, delivered
  // last so the first-paint emit fires with it present.
  sock.deliver([
    rowsResult("autopilot_state", "test-1197-autopilot-state", [
      {
        id: 1,
        paused: 0,
        mode: "yolo",
        max_concurrent_per_root: opts.stored,
        worktree_mode: opts.worktreeOn ? 1 : 0,
      },
    ]),
  ]);
  const snap = snapshots.at(-1);
  handle.dispose();
  if (!snap) {
    throw new Error("no snapshot emitted");
  }
  return snap;
}

test("subscribeReadiness: effective per-root cap derives off the folded autopilot_state via the seam — boot == steady, header ignored (fn-1197)", () => {
  const cases: { stored: number; worktreeOn: boolean; bootHeaderN: number }[] =
    [
      // The incident itself: worktree on + stored 2 must report the effective 2 even
      // when a stale boot header carries 1.
      { stored: 2, worktreeOn: true, bootHeaderN: 1 },
      // Worktree off floors the effective cap to 1 though the operator stored 2 — the
      // stored intent must still surface distinctly.
      { stored: 2, worktreeOn: false, bootHeaderN: 2 },
      { stored: 5, worktreeOn: true, bootHeaderN: 99 },
      { stored: 5, worktreeOn: false, bootHeaderN: 5 },
      { stored: 1, worktreeOn: true, bootHeaderN: 7 },
    ];
  for (const { stored, worktreeOn, bootHeaderN } of cases) {
    const expected = effectivePerRootCap(stored, worktreeOn);
    // BOOT-emission path: a (wrong) boot header is stamped. STEADY-state path: none.
    const bootSnap = driveFn1197Snapshot({ stored, worktreeOn, bootHeaderN });
    const steadySnap = driveFn1197Snapshot({ stored, worktreeOn });
    // Both derive the effective cap off the folded {stored, worktree} through the
    // seam — byte-identical, and neither reflects the wrong boot-header value.
    expect(bootSnap.maxConcurrentPerRoot).toBe(expected);
    expect(steadySnap.maxConcurrentPerRoot).toBe(expected);
    expect(bootSnap.maxConcurrentPerRoot).toBe(steadySnap.maxConcurrentPerRoot);
    // The stored intent stays distinctly readable (the raw column) on both — even
    // where worktree mode floors the effective cap below it.
    expect(bootSnap.maxConcurrentPerRootStored).toBe(stored);
    expect(steadySnap.maxConcurrentPerRootStored).toBe(stored);
  }
});

// ===========================================================================
// fn-1180.1 — the catching-up latch + backstop (the TUI readiness gate).
//
// The shared subscribe client owns a per-connection catching-up value-latch and
// surfaces its transitions via `onCatchingUp` so a display harness can gate
// rendering while headless consumers keep receiving data. Contract: starts
// READY; a served `result` carrying a boot header sets it to that header's
// `catching_up` (strict boolean — a malformed value mutates nothing); a
// headerless `result` observed WHILE latched clears it (catch-up stamps EVERY
// served frame, so the memo-path headerless result is positive steady-state
// evidence); `patch`/`meta` never touch it; teardown resets it and the next
// connection re-derives it. While latched, a slow backstop interval refetches
// ONE idle collection so the settling flip is always observed.
// ===========================================================================

/** A minimal catch-up / steady BootStatus header for the latch tests. */
function bootHeader(catchingUp: boolean, rev = 1, head = 9): BootStatus {
  return {
    rev,
    head_event_id: head,
    catching_up: catchingUp,
    git_seed_required: false,
  };
}

/** A `result` for `jobs` carrying an explicit boot header (the catch-up stamp). */
function jobsResultBoot(
  id: string,
  rows: Record<string, unknown>[],
  boot: BootStatus,
  rev = 1,
): ServerFrame {
  return {
    type: "result",
    id,
    collection: "jobs",
    rev,
    total: rows.length,
    rows,
    boot,
  };
}

type CatchLog = { catchingUp: boolean; boot: BootStatus | undefined }[];

/** A single-collection (`jobs`) sidecar wired with an `onCatchingUp` recorder. */
function makeCatchUpSidecar(idPrefix: string): {
  sock: MockSocket;
  rowsLog: Record<string, unknown>[][];
  catchLog: CatchLog;
  handle: ReturnType<typeof subscribeCollection>;
} {
  const { factory, socketRef } = makeMockConnect();
  const rowsLog: Record<string, unknown>[][] = [];
  const catchLog: CatchLog = [];
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix,
    collection: "jobs",
    onRows: (rows) => rowsLog.push(rows),
    onCatchingUp: (catchingUp, boot) => catchLog.push({ catchingUp, boot }),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  return { sock, rowsLog, catchLog, handle };
}

/**
 * A `setInterval` spy keyed by interval duration. The helper installs TWO live
 * intervals — `pollAll` (`POLL_MS`) and the catching-up backstop
 * (`CATCHUP_BACKSTOP_MS`) — and the shared `installTimerHarness` only captures
 * the first. This spy tracks EVERY positive-interval timer by its ms so a test
 * can `fire()` and `count()` the backstop independently. Non-positive timeouts
 * (Bun internals) fall through to the real implementation.
 */
interface IntervalSpy {
  fire(intervalMs: number): void;
  count(intervalMs: number): number;
  restore(): void;
}

function installIntervalSpy(): IntervalSpy {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const live = new Map<number, { handler: () => void; ms: number }>();
  let nextId = 1;
  globalThis.setInterval = ((
    handler: Parameters<typeof realSetInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof timeout === "number" && timeout > 0) {
      const id = nextId++;
      live.set(id, { handler: handler as () => void, ms: timeout });
      return id as unknown as ReturnType<typeof realSetInterval>;
    }
    return realSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (typeof id === "number" && live.has(id)) {
      live.delete(id);
      return;
    }
    realClearInterval(id);
  }) as typeof clearInterval;
  return {
    fire(intervalMs: number): void {
      // Snapshot before firing — a handler may clear an interval mid-iteration.
      const handlers = [...live.values()]
        .filter((e) => e.ms === intervalMs)
        .map((e) => e.handler);
      for (const h of handlers) {
        h();
      }
    },
    count(intervalMs: number): number {
      let n = 0;
      for (const e of live.values()) {
        if (e.ms === intervalMs) {
          n += 1;
        }
      }
      return n;
    },
    restore(): void {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

test("catching-up latch: a catch-up header sets it, a headerless result while latched clears it", () => {
  const { sock, catchLog, handle } = makeCatchUpSidecar("test-latch");
  const subId = "test-latch-jobs";
  sock.takeOutbound();

  // A result carrying `catching_up: true` SETS the latch (first transition).
  sock.deliver([jobsResultBoot(subId, [], bootHeader(true))]);
  expect(catchLog).toEqual([{ catchingUp: true, boot: bootHeader(true) }]);

  // A second catch-up header is NO transition — the callback fires only on flips.
  sock.takeOutbound();
  sock.deliver([jobsResultBoot(subId, [], bootHeader(true, 2))]);
  expect(catchLog).toHaveLength(1);

  // A headerless result observed WHILE latched is positive steady-state evidence
  // → clears, delivering the FRESHEST header seen (rev 2, not the rev-1 setter).
  sock.takeOutbound();
  sock.deliver([jobsResult(subId, [])]);
  expect(catchLog).toHaveLength(2);
  expect(catchLog[1]?.catchingUp).toBe(false);
  expect(catchLog[1]?.boot).toEqual(bootHeader(true, 2));

  // Now READY: a further headerless result is a no-op (no transition).
  sock.deliver([jobsResult(subId, [])]);
  expect(catchLog).toHaveLength(2);

  handle.dispose();
});

test("catching-up latch: a steady-state header (catching_up=false) clears it", () => {
  const { sock, catchLog, handle } = makeCatchUpSidecar("test-steady");
  const subId = "test-steady-jobs";
  sock.takeOutbound();

  sock.deliver([jobsResultBoot(subId, [], bootHeader(true))]);
  expect(catchLog).toEqual([{ catchingUp: true, boot: bootHeader(true) }]);

  // A header reporting steady state clears the latch, handing back that header.
  sock.deliver([jobsResultBoot(subId, [], bootHeader(false))]);
  expect(catchLog).toHaveLength(2);
  expect(catchLog[1]).toEqual({ catchingUp: false, boot: bootHeader(false) });

  handle.dispose();
});

test("catching-up latch: a malformed catching_up mutates nothing (not a headerless clear)", () => {
  const { sock, catchLog, handle } = makeCatchUpSidecar("test-malformed");
  const subId = "test-malformed-jobs";
  sock.takeOutbound();

  sock.deliver([jobsResultBoot(subId, [], bootHeader(true))]);
  expect(catchLog).toHaveLength(1);

  // A header whose `catching_up` is non-boolean is present-but-malformed: a
  // header is NOT a headerless result, so it neither clears nor re-fires.
  const bad = { ...bootHeader(true), catching_up: "yes" as unknown as boolean };
  sock.deliver([jobsResultBoot(subId, [], bad)]);
  expect(catchLog).toHaveLength(1);

  // Prove the latch is STILL set: a headerless result now clears it.
  sock.deliver([jobsResult(subId, [])]);
  expect(catchLog).toHaveLength(2);
  expect(catchLog[1]?.catchingUp).toBe(false);

  handle.dispose();
});

test("catching-up latch: patch and meta frames never mutate it", () => {
  const { sock, catchLog, handle } = makeCatchUpSidecar("test-pm");
  const subId = "test-pm-jobs";
  sock.takeOutbound();

  // Seed a page and set the latch on one catch-up-stamped result.
  sock.deliver([
    jobsResultBoot(
      subId,
      [{ job_id: "j1", state: "working", last_event_id: 10 }],
      bootHeader(true),
    ),
  ]);
  expect(catchLog).toHaveLength(1);
  sock.takeOutbound();

  // A direct-merge patch and a membership `meta` both leave the latch untouched.
  sock.deliver([
    jobsPatch(subId, { job_id: "j1", state: "stopped", last_event_id: 20 }),
  ]);
  sock.deliver([
    { type: "meta", id: subId, collection: "jobs", rev: 3, total: 1 },
  ]);
  expect(catchLog).toHaveLength(1);

  // The latch is STILL set — a headerless result clears it, proving neither
  // patch nor meta cleared it early.
  sock.takeOutbound();
  sock.deliver([
    jobsResult(subId, [{ job_id: "j1", state: "stopped", last_event_id: 30 }]),
  ]);
  expect(catchLog).toHaveLength(2);
  expect(catchLog[1]?.catchingUp).toBe(false);

  handle.dispose();
});

test("catching-up latch: teardown resets it silently and the reconnect re-derives", () => {
  const spy = installIntervalSpy();
  try {
    const { factory, socketRef } = makeMockConnect();
    const catchLog: CatchLog = [];
    const handle = subscribeCollection({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-teardown",
      collection: "jobs",
      onRows: () => {},
      onCatchingUp: (catchingUp, boot) => catchLog.push({ catchingUp, boot }),
      connect: factory,
    });
    const sock1 = socketRef.current;
    if (!sock1) {
      throw new Error("mock socket never installed");
    }
    const subId = "test-teardown-jobs";
    sock1.takeOutbound();

    // Latch catching-up → backstop armed.
    sock1.deliver([jobsResultBoot(subId, [], bootHeader(true))]);
    expect(catchLog).toHaveLength(1);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(1);

    // The daemon drops the connection. Teardown resets the latch to READY and
    // disarms the backstop SILENTLY — a disconnect is a lifecycle signal, not a
    // latch flip, so `onCatchingUp` does NOT fire.
    sock1.closeFromServer();
    expect(catchLog).toHaveLength(1);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(0);

    // The mock fires `open` on a FRESH socket synchronously during reconnect.
    const sock2 = socketRef.current;
    if (!sock2) {
      throw new Error("reconnect socket never installed");
    }
    expect(sock2).not.toBe(sock1);
    sock2.takeOutbound();

    // The fresh connection's first result re-derives the latch: still catching up.
    sock2.deliver([jobsResultBoot(subId, [], bootHeader(true))]);
    expect(catchLog).toHaveLength(2);
    expect(catchLog[1]?.catchingUp).toBe(true);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(1);

    handle.dispose();
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(0);
  } finally {
    spy.restore();
  }
});

test("catching-up backstop: arms while latched, refetches an idle collection, coalesces, disarms on clear", () => {
  const spy = installIntervalSpy();
  try {
    const { sock, catchLog, handle } = makeCatchUpSidecar("test-backstop");
    const subId = "test-backstop-jobs";
    sock.takeOutbound();

    // Latch catching-up → backstop armed.
    sock.deliver([
      jobsResultBoot(
        subId,
        [{ job_id: "j1", state: "working", last_event_id: 10 }],
        bootHeader(true),
      ),
    ]);
    expect(catchLog).toHaveLength(1);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(1);
    sock.takeOutbound();

    // A tick refetches the ONE idle collection through the shared coalescer.
    spy.fire(CATCHUP_BACKSTOP_MS);
    const refetch = sock.takeOutbound();
    expect(refetch).toHaveLength(1);
    expect((refetch[0] as { collection: string }).collection).toBe("jobs");

    // That refetch is now in flight; a second tick finds NO idle collection and
    // coalesces to a no-op — never a duplicate query.
    spy.fire(CATCHUP_BACKSTOP_MS);
    expect(sock.takeOutbound()).toHaveLength(0);

    // The refetch response still carries catch-up → latch stays set, still armed.
    sock.deliver([
      jobsResultBoot(
        subId,
        [{ job_id: "j1", state: "working", last_event_id: 11 }],
        bootHeader(true),
      ),
    ]);
    expect(catchLog).toHaveLength(1);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(1);

    // A steady-state header clears the latch → backstop disarmed the moment it clears.
    sock.deliver([jobsResultBoot(subId, [], bootHeader(false))]);
    expect(catchLog).toHaveLength(2);
    expect(catchLog[1]?.catchingUp).toBe(false);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(0);

    // A tick after disarm is inert.
    spy.fire(CATCHUP_BACKSTOP_MS);
    expect(sock.takeOutbound()).toHaveLength(0);

    handle.dispose();
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(0);
  } finally {
    spy.restore();
  }
});

test("catching-up backstop: dispose while latched clears the interval (no timer leak)", () => {
  const spy = installIntervalSpy();
  try {
    const { sock, handle } = makeCatchUpSidecar("test-backstop-dispose");
    const subId = "test-backstop-dispose-jobs";
    sock.takeOutbound();
    sock.deliver([jobsResultBoot(subId, [], bootHeader(true))]);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(1);

    handle.dispose();
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(0);
  } finally {
    spy.restore();
  }
});

test("subscribeReadiness: catching-up backstop refetches exactly ONE idle collection per tick", () => {
  const spy = installIntervalSpy();
  try {
    const { factory, socketRef } = makeMockConnect();
    const catchLog: boolean[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-rb",
      onSnapshot: () => {},
      onCatchingUp: (c) => catchLog.push(c),
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // During genuine catch-up the server stamps EVERY served frame, so all 11
    // results carry a catch-up header. The latch flips exactly once.
    const collections = [
      "epics",
      "jobs",
      "subagent_invocations",
      "git",
      "dead_letters",
      "pending_dispatches",
      "autopilot_state",
      "armed_epics",
      "scheduled_tasks",
      "block_escalations",
      "tmux_client_focus",
    ];
    for (const c of collections) {
      sock.deliver([
        {
          type: "result",
          id: `test-rb-${c.replace(/_/g, "-")}`,
          collection: c,
          rev: 1,
          total: 0,
          rows: [],
          boot: bootHeader(true),
        },
      ]);
    }
    expect(catchLog).toEqual([true]);
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(1);
    sock.takeOutbound();

    // One tick → exactly ONE refetch (the first idle collection), never 11.
    spy.fire(CATCHUP_BACKSTOP_MS);
    const out = sock.takeOutbound();
    expect(out).toHaveLength(1);
    expect((out[0] as { collection: string }).collection).toBe("epics");

    handle.dispose();
    expect(spy.count(CATCHUP_BACKSTOP_MS)).toBe(0);
  } finally {
    spy.restore();
  }
});

test("subscribeReadiness: bare frames (no boot header) keep painting and never fire onCatchingUp", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const catchLog: boolean[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-bare",
    onSnapshot: (s) => snapshots.push(s),
    onCatchingUp: (c) => catchLog.push(c),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  for (const c of [
    "epics",
    "jobs",
    "subagent_invocations",
    "git",
    "dead_letters",
    "pending_dispatches",
    "autopilot_state",
    "armed_epics",
    "scheduled_tasks",
    "block_escalations",
    "tmux_client_focus",
  ]) {
    sock.deliver([emptyResult(c, `test-bare-${c.replace(/_/g, "-")}`)]);
  }
  // Painted once (first-paint gate cleared) and the latch never left READY, so a
  // headless consumer's data path is byte-identical to the pre-latch behavior.
  expect(snapshots).toHaveLength(1);
  expect(catchLog).toHaveLength(0);

  handle.dispose();
});

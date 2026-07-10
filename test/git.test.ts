/**
 * Lifecycle + renderer tests for `cli/git.ts` and the
 * `subscribeCollection` helper it composes onto. Two surfaces under test:
 *
 *   1. `subscribeCollection` — the single-collection subscribe helper
 *      extracted from `subscribeReadiness`. Drive it with an in-memory
 *      mock socket injected via the `connect` option (same pattern as
 *      `test/readiness-client.test.ts`), assert the wire shape of the
 *      query frame (collection / id / limit / sort / filter), the
 *      single-collection first-paint gate (no `onRows` until the first
 *      `result`), and the per-collection coalesce (a `meta` while in
 *      flight folds into one follow-up query).
 *
 *   2. `renderRowBlocks` from `cli/git.ts` — the empty-row drop policy
 *      (rows with `ahead === 0 && dirty === 0 && orphaned === 0` are
 *      skipped) plus the per-row block shape that the live-shell wrapper
 *      in task 2 will consume.
 *
 * Why a mock socket. The helper's load-bearing invariants are sequencing
 * (first-paint gate, per-collection coalesce, idempotent `dispose()`,
 * terminal-error → `onFatal`); a real socket would force the test to
 * boot the daemon for facts unrelated to the helper itself.
 * `test/integration.test.ts` already covers the end-to-end wire.
 *
 * The mock contract mirrors `test/readiness-client.test.ts`: `connectMock`
 * returns a `MockSocket` whose `write` pushes onto an `outbound` array
 * and which exposes the helper's `data` / `close` / `error` handlers so
 * the test can synthesise frames mid-test. `open` fires synchronously
 * inside `connect` so the helper sends its initial query before
 * `subscribeCollection` returns the handle.
 */

import { expect, test } from "bun:test";
import { renderRowBlocks, renderRowLines } from "../cli/git";
import { encodeFrame, type ServerFrame } from "../src/protocol";
import {
  type ConnectFactory,
  type ReadinessSocket,
  type SocketHandlers,
  subscribeCollection,
} from "../src/readiness-client";

// ---------------------------------------------------------------------------
// Mock socket / connect factory — byte-identical shape to
// `test/readiness-client.test.ts:makeMockConnect`. Kept inline (not
// extracted) because each test file owns its mock surface explicitly,
// matching the keeper test style.
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
}

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
  return { factory, socketRef };
}

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

function metaFrame(collection: string, rev = 2): ServerFrame {
  return {
    type: "meta",
    collection,
    rev,
    total: 0,
  };
}

// ---------------------------------------------------------------------------
// subscribeCollection: wire shape — query frame carries collection + id +
// limit + sort + filter as the caller passed them.
// ---------------------------------------------------------------------------

test("subscribeCollection: initial query frame carries collection / id / limit / sort / filter", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "git",
    collection: "git",
    limit: 0,
    sort: { column: "project_dir", dir: "asc" },
    filter: { project_dir: "/some/repo" },
    onRows: () => {
      /* not exercised here */
    },
    connect: factory,
  });

  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");
  const initial = sock.takeOutbound();
  expect(initial).toHaveLength(1);
  expect(initial[0]).toEqual({
    type: "query",
    id: "git-git",
    collection: "git",
    limit: 0,
    sort: { column: "project_dir", dir: "asc" },
    filter: { project_dir: "/some/repo" },
  });

  handle.dispose();
});

// ---------------------------------------------------------------------------
// subscribeCollection: result frame produces the expected wire-order rows.
// ---------------------------------------------------------------------------

test("subscribeCollection: result frame fires onRows with the expected string[] shape from renderRowBlocks", () => {
  const { factory, socketRef } = makeMockConnect();
  const rowSnapshots: Record<string, unknown>[][] = [];
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "git",
    collection: "git",
    limit: 0,
    onRows: (rows) => rowSnapshots.push(rows),
    connect: factory,
  });

  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");
  sock.takeOutbound();

  // Deliver a `result` with one non-empty row + one all-zero row.
  sock.deliver([
    resultFrame("git", "git-git", [
      {
        project_dir: "/repo/a",
        branch: "main",
        ahead: 2,
        behind: 0,
        dirty_count: 0,
        orphaned_count: 0,
        orphaned_files: [],
        jobs: [],
      },
      {
        project_dir: "/repo/b",
        branch: "main",
        ahead: 0,
        behind: 0,
        dirty_count: 0,
        orphaned_count: 0,
        orphaned_files: [],
        jobs: [],
      },
    ]),
  ]);

  // The helper fires once with the wire-order rows.
  expect(rowSnapshots).toHaveLength(1);
  expect(rowSnapshots[0]).toHaveLength(2);

  // The renderer drops the all-zero row and keeps the non-empty one —
  // smoke test the public string[] surface the live-shell will consume.
  const rows = rowSnapshots[0];
  if (!rows) throw new Error("missing rows snapshot");
  const blocks = renderRowBlocks(rows);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatch(/^\(a\) \[main \+2\]/);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// subscribeCollection: first-paint gate withholds onRows until the first
// result frame.
// ---------------------------------------------------------------------------

test("subscribeCollection: first-paint gate — onRows does not fire until first result", () => {
  const { factory, socketRef } = makeMockConnect();
  let calls = 0;
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "git",
    collection: "git",
    onRows: () => {
      calls += 1;
    },
    connect: factory,
  });

  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");
  sock.takeOutbound();

  // A `meta` nudge before any `result` cannot fire `onRows` — gate held.
  sock.deliver([metaFrame("git", 5)]);
  expect(calls).toBe(0);

  // First `result` lands → exactly one `onRows`.
  sock.deliver([resultFrame("git", "git-git", [])]);
  expect(calls).toBe(1);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// subscribeCollection: per-collection coalesce — meta frame while
// queryInFlight is true folds into one follow-up query after the result.
// ---------------------------------------------------------------------------

test("subscribeCollection: meta during in-flight query coalesces into one follow-up", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "git",
    collection: "git",
    onRows: () => {
      /* ignore — coalesce assertions are wire-level */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");

  // Burn the initial query (queryInFlight = true on the helper now).
  expect(sock.takeOutbound()).toHaveLength(1);

  // Two `meta` nudges before the first result both fold into one
  // pending refetch via `refetchDirty`.
  sock.deliver([metaFrame("git", 2)]);
  sock.deliver([metaFrame("git", 3)]);
  expect(sock.takeOutbound()).toHaveLength(0);

  // The `result` clears `queryInFlight` and triggers exactly ONE
  // follow-up query because `refetchDirty` was set.
  sock.deliver([resultFrame("git", "git-git", [])]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("git");
  expect((follow[0] as { type: string }).type).toBe("query");

  handle.dispose();
});

// ---------------------------------------------------------------------------
// subscribeCollection: idempotent dispose() — second call is a no-op,
// matches the SIGINT-safe contract autopilot/board/git all share.
// ---------------------------------------------------------------------------

test("subscribeCollection: dispose() is idempotent and writes one unsubscribe frame", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeCollection({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "git",
    collection: "git",
    onRows: () => {
      /* not exercised */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) throw new Error("mock socket never installed");
  sock.takeOutbound();

  // Reach first-paint so the helper is in steady state.
  sock.deliver([resultFrame("git", "git-git", [])]);

  // First dispose sends one `unsubscribe` and calls `end()`.
  handle.dispose();
  const out1 = sock.takeOutbound();
  expect(out1).toHaveLength(1);
  expect((out1[0] as { type: string }).type).toBe("unsubscribe");
  expect(sock.ended).toBe(true);

  // Second dispose is inert — no further outbound frames.
  handle.dispose();
  expect(sock.outbound).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// renderRowBlocks: pure-function coverage — empty-row drop, per-row block
// shape, nested job/dirty/plan lines.
// ---------------------------------------------------------------------------

test("renderRowBlocks: drops all-zero rows and emits one block per non-empty row", () => {
  const blocks = renderRowBlocks([
    {
      project_dir: "/repo/zero",
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty_count: 0,
      orphaned_count: 0,
      unattributed_to_live_count: 0,
      dirty_files: [],
    },
    {
      project_dir: "/repo/dirty",
      branch: "feat",
      ahead: 0,
      behind: 1,
      dirty_count: 1,
      orphaned_count: 0,
      unattributed_to_live_count: 0,
      dirty_files: [
        {
          xy: " M",
          path: "src/foo.ts",
          attributions: [
            {
              session_id: "sess-a",
              title: "do thing",
              state: "working",
              last_touch_at: 1000,
              op: "Write",
              source: "tool",
            },
          ],
        },
      ],
    },
  ]);

  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (!block) throw new Error("missing block");
  // First line: header with file-centric counts (dirty/orphan/unattributed).
  expect(block).toMatch(
    /^\(dirty\) \[feat -1\] dirty=1 orphan=0 unattributed=0\n/,
  );
  // File line: path + xy + source-badged attribution (`tool@<title>`).
  expect(block).toContain("  src/foo.ts [ M] tool@do thing");
});

test("renderRowBlocks: ahead-only row shows +N on the project line, no unpushed line", () => {
  const blocks = renderRowBlocks([
    {
      project_dir: "/repo/ahead",
      branch: "main",
      ahead: 3,
      behind: 0,
      dirty_count: 0,
      orphaned_count: 0,
      unattributed_to_live_count: 0,
      dirty_files: [],
    },
  ]);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (!block) throw new Error("missing block");
  expect(block).toMatch(/^\(ahead\) \[main \+3\]/);
  expect(block).not.toContain("unpushed");
});

// ---------------------------------------------------------------------------
// renderRowBlocks: keeper lane header shortening — the dir basename restates
// the branch and a rib branch restates the epic id, so lane rows collapse to
// `(repo) [lane <id>]`; non-lane rows render untouched.
// ---------------------------------------------------------------------------

const LANE_EPIC = "fn-1230-launch-triples-over-preset-catalog";

function laneRow(
  projectDir: string,
  branch: string | null,
): Record<string, unknown> {
  return {
    project_dir: projectDir,
    branch,
    ahead: 0,
    behind: 0,
    dirty_count: 1,
    orphaned_count: 0,
    unattributed_to_live_count: 0,
    dirty_files: [{ xy: ".M", path: "src/foo.ts", attributions: [] }],
  };
}

test("renderRowBlocks: epic base lane header collapses to (repo) [lane <epic_id>]", () => {
  const blocks = renderRowBlocks([
    laneRow(
      `/wt/keeper-qzvs8i--keeper-epic-${LANE_EPIC}`,
      `keeper/epic/${LANE_EPIC}`,
    ),
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatch(
    /^\(keeper\) \[lane fn-1230-launch-triples-over-preset-catalog\] dirty=1/,
  );
});

test("renderRowBlocks: rib lane header collapses to (repo) [lane <task_id>]", () => {
  const blocks = renderRowBlocks([
    laneRow(
      `/wt/keeper-qzvs8i--keeper-epic-${LANE_EPIC}--${LANE_EPIC}.3`,
      `keeper/epic/${LANE_EPIC}--${LANE_EPIC}.3`,
    ),
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatch(
    /^\(keeper\) \[lane fn-1230-launch-triples-over-preset-catalog\.3\] dirty=1/,
  );
});

test("renderRowBlocks: lane branch with an off-scheme basename keeps the full dir name", () => {
  const blocks = renderRowBlocks([
    laneRow("/repo/keeper", `keeper/epic/${LANE_EPIC}`),
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatch(/^\(keeper\) \[lane fn-1230-/);
});

test("renderRowBlocks: non-lane and detached rows render their raw name and branch", () => {
  const blocks = renderRowBlocks([
    laneRow("/wt/keeper-baseline--qzvs8i-abc123", null),
    laneRow("/repo/keeper", "main"),
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatch(/^\(keeper-baseline--qzvs8i-abc123\) \[detached\]/);
  expect(blocks[1]).toMatch(/^\(keeper\) \[main\]/);
});

test("renderRowLines: adjacent worktree blocks are separated by a blank line", () => {
  const lines = renderRowLines([
    laneRow("/repo/a", "main"),
    laneRow("/repo/b", "main"),
  ]);
  expect(lines).toEqual([
    "(a) [main] dirty=1 orphan=0 unattributed=0",
    "  src/foo.ts [.M] <orphan>",
    "",
    "(b) [main] dirty=1 orphan=0 unattributed=0",
    "  src/foo.ts [.M] <orphan>",
  ]);
});

// ---------------------------------------------------------------------------
// renderRowBlocks: file-centric layout — multi-attribution, truly-orphan,
// rename continuation line, and the source-badged sort order
// (last_touch_at desc, most-recent first).
// ---------------------------------------------------------------------------

test("renderRowBlocks: file-centric layout — multi-attribution, orphan, rename, sort order", () => {
  const blocks = renderRowBlocks([
    {
      project_dir: "/repo/multi",
      branch: "main",
      ahead: 0,
      behind: 0,
      // 4 dirty files: one multi-attribution, one truly-orphan, one
      // single-attribution stopped (counts as unattributed-to-live),
      // one rename-with-attribution.
      dirty_count: 4,
      orphaned_count: 1,
      // Two files are unattributed-to-live (the truly-orphan file plus the
      // ended-session file) — the exact reducer-pass-4 scalar, not re-derived
      // from `dirty_files[]`.
      unattributed_to_live_count: 2,
      dirty_files: [
        // multi-attribution: tool + bash + inferred, three sessions, with
        // mixed last_touch_at to verify desc sort (bash@new should appear
        // first, then tool@mid, then inferred@old).
        {
          xy: " M",
          path: "src/foo.ts",
          attributions: [
            {
              session_id: "sess-mid",
              title: "mid",
              state: "working",
              last_touch_at: 2000,
              op: "Edit",
              source: "tool",
            },
            {
              session_id: "sess-new",
              title: "new",
              state: "working",
              last_touch_at: 3000,
              op: "rm",
              source: "bash",
            },
            {
              session_id: "sess-old",
              title: "old",
              state: "stopped",
              last_touch_at: 1000,
              op: "inferred",
              source: "inferred",
            },
          ],
        },
        // truly-orphan: no attributions at all → renders as `<orphan>`.
        {
          xy: "??",
          path: "tmp/mystery.bin",
          attributions: [],
        },
        // single attribution but session is ended → counts toward
        // unattributed-to-live (no live state in {working, stopped}).
        {
          xy: " M",
          path: "src/legacy.ts",
          attributions: [
            {
              session_id: "sess-dead",
              title: "ended thing",
              state: "ended",
              last_touch_at: 500,
              op: "Write",
              source: "tool",
            },
          ],
        },
        // rename: orig_path present and different → continuation line.
        {
          xy: "R ",
          path: "src/new-name.ts",
          orig_path: "src/old-name.ts",
          attributions: [
            {
              session_id: "sess-renamer",
              title: "renamer",
              state: "working",
              last_touch_at: 4000,
              op: "mv",
              source: "bash",
            },
          ],
        },
      ],
    },
  ]);

  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (!block) throw new Error("missing block");

  // Header: file-centric counts. Two files are unattributed-to-live —
  // the truly-orphan tmp/mystery.bin and the ended-session legacy.ts.
  expect(block).toMatch(
    /^\(multi\) \[main\] dirty=4 orphan=1 unattributed=2\n/,
  );

  // Multi-attribution sorted last_touch_at desc.
  expect(block).toContain("  src/foo.ts [ M] bash@new, tool@mid, inferred@old");

  // Truly-orphan file renders as `<orphan>`.
  expect(block).toContain("  tmp/mystery.bin [??] <orphan>");

  // Single-attribution ended session.
  expect(block).toContain("  src/legacy.ts [ M] tool@ended thing");

  // Rename: primary line + continuation.
  expect(block).toContain("  src/new-name.ts [R ] bash@renamer");
  expect(block).toContain("    ↳ renamed from src/old-name.ts");
});

test("renderRowBlocks: attribution truncation appends `+N more` for dense lines", () => {
  // 10 attributions on one file — at least one must drop into `+N more`
  // under the 100-char line cap.
  const manyAttributions = Array.from({ length: 10 }, (_, i) => ({
    session_id: `sess-${i}`,
    title: `verbose-session-title-${i}`,
    state: "working",
    last_touch_at: 10 * (10 - i), // descending, so source order is preserved
    op: "Edit",
    source: "tool" as const,
  }));
  const blocks = renderRowBlocks([
    {
      project_dir: "/repo/dense",
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty_count: 1,
      orphaned_count: 0,
      unattributed_to_live_count: 0,
      dirty_files: [
        {
          xy: " M",
          path: "src/hot.ts",
          attributions: manyAttributions,
        },
      ],
    },
  ]);

  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (!block) throw new Error("missing block");
  // Find the file line and assert it carries a `+N more` suffix.
  const fileLine = block
    .split("\n")
    .find((l) => l.startsWith("  src/hot.ts ["));
  if (fileLine == null) throw new Error("missing file line");
  expect(fileLine).toMatch(/\+\d+ more$/);
});

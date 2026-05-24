#!/usr/bin/env bun
/**
 * keeper-epics — a primitive "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`). It renders a *page of epics as a frame* and
 * reprints a fresh frame every time the visible projection changes.
 *
 * It `query`s the `epics` collection and renders it as a stream of simple text
 * blocks. Each frame is a `---`-led document; each epic is one block:
 *
 *   {basename(project_dir)} {epic_number} {title}{deps}
 *     {task_number}. {title}{deps} [{status}] [{approval}]
 *        [{task_id}]
 *     ...
 *     {N+1}. Quality audit and close [{status}] [{approval}]
 *        [{epic_id}]
 *
 * `{deps}` is ` [#A,#B]` from `depends_on_epics` for the header and from
 * `depends_on` on each embedded task; both are omitted when empty. In default
 * mode (no `--status`/`--status-ne`/`--show-approved` flag) the epic-header
 * `{deps}` list is filtered to deps still "on the board" — i.e. present in
 * the current page, which IS the server's default-scope set `(status = open
 * OR approval != approved)` because `PAGE_LIMIT = 0` fetches every row in
 * scope. Deps that have fallen off the board (done AND approved) drop out
 * of the pill. Under any explicit filter the page is not the on-board set
 * so the legacy "show all deps" behavior stands. The
 * `[{approval}]` pill comes from the planctl-native `approval` field
 * (top-level on the epic row, top-level on each embedded task element — schema
 * v13); a missing / off-enum value coerces to `pending`. The epic header
 * carries NO pills — both `[status]` and `[approval]` ride the trailing
 * virtual task, so all status/approval pills line up under one column.
 * Every epic ends with a "Quality audit and close" virtual task
 * (real-task-count + 1 as its number, the epic's `[status] [approval]`
 * as its pill pair, the epic_id as its slug line) — appended even when
 * the epic has no real tasks, since the slug needs a home. Task
 * lines are indented 2 spaces; slug lines 5 spaces (lining up with the task
 * title for single-digit task numbers). Blocks are separated by a single blank
 * line. No YAML — just plain bracket text.
 *
 * The query optionally carries a server-side filter built from `--status` /
 * `--status-ne` (status equality / `{ ne }` operator) and `--show-approved`
 * (drops the descriptor's `approval != approved` default by asserting an
 * all-values `approval: { in: [...] }`). Default (no flag): send NO `filter`
 * key so the server's default scope (`status: "open", approval: { ne:
 * "approved" }`) applies — open, not-yet-approved epics. When a filter is in
 * effect it runs in SQL, so LIMIT counts only matching rows and `total` /
 * `meta` track exactly that set. Membership is frozen WITHIN a fetched page
 * (the server never reflows a live page), but the script REFETCHES the page —
 * on every `patch`/`meta` change signal AND on a steady poll — so each fresh
 * `result` reflects the current top-N. A NEW frame prints whenever the
 * RENDERED page changes; the rendered output — not internal row churn — is the
 * sole frame trigger, enforced by routing every emit through
 * `emitFrameIfChanged`.
 *
 * The script renders ONLY from `result` frames. `patch` and `meta` are treated
 * purely as "refetch" hints (their payloads are never rendered directly), so
 * the displayed page is always a true top-N snapshot — never a half-patched mix
 * of fresh cells over stale membership. Refetches coalesce: at most one `query`
 * is in flight, and a signal arriving while one is pending queues exactly one
 * more, so a burst can't become a query storm.
 *
 * Why a poll and not pure push: the server can't signal a re-sort of a row that
 * is OFF the current page — it isn't in the watched set (no `patch`) and the
 * filtered SET membership is unchanged (no `meta`). An event-only client would
 * never learn that such a row sorted into the top-N. The steady poll is the
 * client's "always show the latest top-N" backstop; `patch`/`meta` just make
 * on-page changes reflect faster than the poll interval.
 *
 * After every emitted frame a second `...`-fenced note prints two per-pid /tmp
 * paths: the full JSON state the frame was built from (the ordered page rows)
 * and the rendered frame text itself. Both are overwritten each frame (always
 * the most recently printed frame) so a frame can be inspected out-of-band.
 *
 * Connection is resilient. There is no socket-level readiness handshake —
 * keeperd binds the UDS only after boot-drain completes, so "data ready"
 * reduces to "the socket accepts a connection". On first launch the client
 * therefore RETRIES connecting (capped backoff) until keeperd is up and
 * accepting, and on a dropped connection (e.g. a keeperd restart) it RECONNECTS
 * the same way instead of exiting. Every connection-lifecycle transition prints
 * a `...`-fenced note (`event: connecting|connected|waiting|disconnected`, the
 * initial connection included) — the same out-of-band "meta message" channel as
 * the sidecar note, distinct from the server's `meta` staleness frame. Only
 * Ctrl-C (SIGINT) or a terminal query error (`bad_frame` / `unknown_collection`
 * on our own `query`, which a reconnect can't fix) exits.
 *
 * It reuses `src/protocol.ts` (`encodeFrame` to write, `LineBuffer` to
 * de-frame) and `resolveSockPath()` so it stays a faithful mirror of the
 * contract, and it honors the read-only fence: it only ever sends
 * `query` / `unsubscribe`. The connection/coalescing logic mirrors the
 * sibling `scripts/jobs.ts`; extract a shared module once the duplication
 * starts costing more than the copy.
 *
 * Usage:
 *   bun scripts/epics.ts [--sock <path>] [--status <s> | --status-ne <s>]
 *                        [--show-approved]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --status <s>     Filter to epics whose status equals <s> (e.g. done).
 *   --status-ne <s>  Filter to epics whose status is NOT <s>.
 *   --show-approved  Drop the descriptor's approval default; approved epics
 *                    reappear in the page.
 *   --help           Show this help.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  encodeFrame,
  type FilterValue,
  LineBuffer,
  type QueryFrame,
  type ServerFrame,
} from "../src/protocol";

/**
 * `0` is the wire "no limit" sentinel — the server returns the full
 * filtered set with no row cap (see `QueryFrame.limit` in
 * `src/protocol.ts`). epics.ts is a single-view full-collection reader, not
 * a paginated list, so we always ask for everything that matches the
 * scope. The realtime diff fan-out grows with watched-set size; the
 * tradeoff is acceptable at today's volume (~640 epics total, ~5 in the
 * default scope after approval cleanup).
 */
const PAGE_LIMIT = 0;

/**
 * How often (ms) the client refetches the page. The server can't signal an
 * off-page re-sort (see file header), so this steady beat is what guarantees we
 * eventually show the current top-N. The server's own `data_version` poll is
 * ~50ms; this is the client's coarser "always show the latest page" cadence.
 */
const POLL_MS = 500;

/**
 * Reconnect/connect-wait backoff. The first (re)connect attempt fires
 * immediately; each subsequent failed attempt waits
 * `min(INITIAL_BACKOFF_MS * 2**(attempt-1), MAX_BACKOFF_MS)` before retrying, so
 * a not-yet-up daemon is polled gently and a restart is picked up fast.
 */
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

const HELP = `keeper-epics — primitive list UI over the keeper subscribe server

Usage: bun scripts/epics.ts [--sock <path>] [--status <s> | --status-ne <s>]
                            [--show-approved]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --status <s>     Filter to epics whose status equals <s> (e.g. done)
  --status-ne <s>  Filter to epics whose status is NOT <s>
                   (--status and --status-ne are mutually exclusive)
                   (default: no status flag → the server's default scope shows
                   only open, not-yet-approved epics; pass a flag to widen)
  --show-approved  Drop the server's approval default; approved epics reappear
                   in the page. The status default still applies.
  --help           Show this help

Renders the epics page as a stream of simple text blocks: one frame per change,
each frame led by '---'. Each epic is one block —
  {basename(project_dir)} {epic_number} {title} [#A,#B]
    {task_number}. {title} [#X,#Y] [{status}] [{approval}]
       [{task_id}]
    ...
    {N+1}. Quality audit and close [{status}] [{approval}]
       [{epic_id}]
Blocks are separated by a single blank line. The [#…] segment lists the epic
or task numbers a row depends on (omitted when empty); in default mode the
epic-header [#…] hides deps that have fallen off the board. The epic header
carries NO pills — every epic ends with a "Quality audit and close" virtual
task whose [{status}] and [{approval}] pills are the epic's, with the
epic_id on its slug line. On real task lines those two pills carry the
task's. A missing / off-enum approval coerces to 'pending'.

The page is refetched on every change signal and on a steady poll, so it always
shows the current top-N; a new frame prints only when the rendered output
changes. Every emitted frame is also mirrored to two /tmp sidecar files (full
JSON state + rendered frame), whose paths print in a ...-fenced note.

The client waits for keeperd to come up and reconnects across restarts instead
of exiting; each connection-lifecycle change prints a ...-fenced note
(event: connecting|connected|waiting|disconnected). Ctrl-C exits cleanly.
`;

/** The hardcoded collection and its primary key. */
const COLLECTION = "epics";
const pk = "epic_id";

/** Approval enum vocabulary, mirrored from `src/plan-worker.ts:Approval`. */
const APPROVAL_VALUES = new Set(["approved", "rejected", "pending"]);

/**
 * Coerce a row's `approval` cell to the enum's display value. The plan-worker
 * pre-coerces so a value off the enum at this layer would be a bug; we coerce
 * defensively anyway (CLAUDE.md "safe value" invariant) so a typo never breaks
 * the render.
 */
function approvalPill(v: unknown): string {
  if (typeof v === "string" && APPROVAL_VALUES.has(v)) {
    return v;
  }
  return "pending";
}

/**
 * Parse the leading `fn-N-…` epic number from a planctl epic id (mirrors the
 * daemon's `epicNumberFromId`), or null for a non-matching id.
 */
function epicNumFromId(id: string): number | null {
  const m = /^[a-z]+-(\d+)-/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Parse the trailing `.M` task number from a planctl task id (`fn-N-slug.M` →
 * M; mirrors the daemon's `taskNumberFromId`), or null for a non-matching id.
 */
function taskNumFromId(id: string): number | null {
  const m = /\.(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

function die(message: string): never {
  process.stderr.write(`keeper-epics: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      status: { type: "string" },
      "status-ne": { type: "string" },
      "show-approved": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (values.status !== undefined && values["status-ne"] !== undefined) {
    die("--status and --status-ne are mutually exclusive");
  }

  // True when NO filter flag was passed — i.e. the wire query carries no
  // `filter` key and the server applies its default scope `(status = 'open' OR
  // approval != 'approved')`. With `PAGE_LIMIT = 0` the page IS that on-board
  // set, so `byId.has(dep)` answers "is this dep still on the board?" exactly.
  // Read by `renderEpicBlock` to filter the epic-header `{deps}` pill.
  const onBoardOnly =
    values.status === undefined &&
    values["status-ne"] === undefined &&
    !values["show-approved"];

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);

  // DEBUG: timing instrumentation for the "epics frame takes 5s" bug.
  // Gated behind `KEEPER_DEBUG_TS=1` so steady-state runs stay quiet; opt in
  // when reproducing. Every line is `[epics-ts] T=<epochMs> +<elapsedMs>
  // <event>` on stderr so a same-wall-clock `[srv-ts]` log from
  // src/server-worker.ts can be diffed against it. Remove once the bug is
  // understood.
  const _epicsT0 = Date.now();
  const _epicsTsEnabled = process.env.KEEPER_DEBUG_TS === "1";
  const ts = _epicsTsEnabled
    ? (msg: string): void => {
        process.stderr.write(
          `[epics-ts] T=${Date.now()} +${Date.now() - _epicsT0}ms ${msg}\n`,
        );
      }
    : (_msg: string): void => {};

  // The current page, in server-sent order, plus a by-id index. Both are
  // rebuilt wholesale on every `result` (each refetch replaces the page); the
  // render reads only from them, never from `patch` payloads.
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  // The last frame's body, so a byte-identical re-send prints nothing.
  let lastBody: string | null = null;
  let gotResult = false;

  // Refetch coalescing. Membership is frozen WITHIN a page, but we re-issue the
  // query so a fresh `result` always carries the current top-N. At most one
  // query is in flight (`queryInFlight`); a change signal arriving while one is
  // pending sets `refetchDirty` so we refetch exactly once more when the result
  // lands — a burst collapses to one in-flight + one queued, never a storm.
  let queryInFlight = false;
  let refetchDirty = false;
  // The steady-poll timer handle, cleared on close / SIGINT.
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Connection state. `currentSock` is the live socket (null between
  // connections, so writes route to the current one, never a closed one);
  // `attempt` counts consecutive failed (re)connect tries for backoff (reset on
  // a successful `open`); `shuttingDown` makes SIGINT win the race against the
  // reconnect loop. The socket type is whatever `Bun.connect` resolves to.
  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let currentSock: Sock | null = null;
  let attempt = 0;
  let shuttingDown = false;

  const seg = (v: unknown) => (v == null ? "" : String(v));

  /**
   * Render one epic as a small text block:
   *   {basename(project_dir)} {epic_number} {title}{deps}
   *     {task_number}. {title}{deps} [{status}] [{approval}]
   *        [{task_id}]
   *     ...
   *     {N+1}. Quality audit and close [{status}] [{approval}]
   *        [{epic_id}]
   * `{deps}` is ` [#A,#B]` joined from `depends_on_epics` (epic header) or
   * `depends_on` (task line); omitted when empty. In default mode the epic-
   * header `{deps}` is filtered to deps still on the board (present in the
   * current page). The epic header carries NO pills — both `[status]` and
   * `[approval]` ride the trailing "Quality audit and close" virtual task,
   * which is appended to every epic (real-task count + 1 as its number),
   * with the epic_id on its slug line. A non-array `tasks` cell still
   * renders the virtual task. Together these projections define which
   * column moves can reframe the page — read alongside `emitFrameIfChanged`.
   */
  function renderEpicBlock(row: Record<string, unknown>): string {
    const dir =
      row.project_dir == null ? "" : basename(String(row.project_dir));
    const epicDeps = Array.isArray(row.depends_on_epics)
      ? row.depends_on_epics
      : [];
    // In default mode the current page is the on-board set, so a dep absent
    // from `byId` is done-AND-approved (off the board) and should drop out of
    // the pill. Under any explicit filter the page is not the on-board set,
    // so we can't answer the question — show every dep.
    const epicDepsForRender = onBoardOnly
      ? epicDeps.filter((d) => byId.has(String(d)))
      : epicDeps;
    const epicDepNums = epicDepsForRender
      .map((d) => epicNumFromId(String(d)))
      .filter((n): n is number => n != null);
    const epicDepsSeg =
      epicDepNums.length === 0
        ? ""
        : ` [${epicDepNums.map((n) => `#${n}`).join(",")}]`;
    const epicId = seg(row[pk]);
    const epicApproval = approvalPill(row.approval);
    const lines: string[] = [
      `${dir} ${seg(row.epic_number)} ${seg(row.title)}${epicDepsSeg}`,
    ];
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    for (const task of tasks) {
      const t = task as Record<string, unknown>;
      const tdeps = Array.isArray(t.depends_on) ? t.depends_on : [];
      const tnums = tdeps
        .map((d) => taskNumFromId(String(d)))
        .filter((n): n is number => n != null);
      const taskDepsSeg =
        tnums.length === 0 ? "" : ` [${tnums.map((n) => `#${n}`).join(",")}]`;
      const taskApproval = approvalPill(t.approval);
      const taskId = seg(t.task_id);
      lines.push(
        `  ${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg} [${seg(t.status)}] [${taskApproval}]`,
        `     [${taskId}]`,
      );
    }
    // Virtual "Quality audit and close" task — appended to every epic so the
    // status pill, approval pill, and epic_id slug all sit in the same
    // column as the real-task lines. Number is `tasks.length + 1` so it
    // slots in after the last real task (or becomes `1.` for a task-less
    // epic). The two pills are the EPIC's own `[status] [approval]`: there
    // is no underlying planctl row to take state from, but reusing the
    // epic's pair keeps the virtual line shape consistent with real tasks
    // even though conceptually this is a closing card.
    lines.push(
      `  ${tasks.length + 1}. Quality audit and close [${seg(row.status)}] [${epicApproval}]`,
      `     [${epicId}]`,
    );
    return lines.join("\n");
  }

  /**
   * Project the frozen page into the rendered body (no leading `---`), in
   * server-sent order. Renders as one `renderEpicBlock` per epic, blocks
   * separated by a single blank line so the eye can pick one epic from the
   * next.
   */
  function renderBody(): string {
    if (order.length === 0) {
      return "(no epics)";
    }
    return order
      .map((id) => renderEpicBlock(byId.get(id) ?? { [pk]: id }))
      .join("\n\n");
  }

  // Per-frame sidecar files: the latest emitted frame is mirrored to /tmp so it
  // can be inspected out-of-band. Per-pid so concurrent runs don't collide;
  // overwritten each frame (always the most recently printed frame).
  const stateSidecar = `/tmp/keeper-epics.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-epics.${process.pid}.frame.txt`;

  /**
   * Mirror the just-emitted frame to its two sidecar files and print a
   * `...`-fenced note with their paths (a "meta message", distinct from the
   * server `meta` staleness frame). `stateSidecar` gets the full JSON state the
   * frame was built from — the ordered page rows; `frameSidecar` gets the
   * rendered frame text itself. Best-effort: a /tmp write failure logs a warning
   * and never wedges the stream.
   */
  function writeSidecars(frameText: string): void {
    const state = order.map((id) => byId.get(id) ?? { [pk]: id });
    try {
      writeFileSync(stateSidecar, `${JSON.stringify(state, null, 2)}\n`);
      writeFileSync(frameSidecar, `${frameText}\n`);
    } catch (err) {
      log(`# warn: sidecar write failed: ${(err as Error).message}`);
    }
    log("...");
    log(`state: ${stateSidecar}`);
    log(`frame: ${frameSidecar}`);
    log("...");
  }

  /**
   * Print a new epic frame iff the rendered projection moved. This byte-compare
   * on `renderBody()` output is the CONTRACT: a frame is emitted only when the
   * rendered text changes — internal row churn that doesn't surface in
   * `projectRow` is invisible by design, and stays so as the projection grows.
   * Every emit routes through here; nothing prints an epic frame directly. Each
   * emitted frame is mirrored to its sidecar files (see `writeSidecars`).
   */
  function emitFrameIfChanged(): void {
    const body = renderBody();
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    const frameText = `---\n${body}`;
    ts(`frame-emit bytes=${frameText.length}`);
    log(frameText);
    writeSidecars(frameText);
  }

  /**
   * Re-issue the page query, coalesced (see `queryInFlight` / `refetchDirty`).
   * The server replaces the subscription and replies with a fresh `result`;
   * rendering happens only there, so we always draw the freshly fetched top-N.
   */
  function scheduleRefetch(): void {
    if (!currentSock) {
      // Disconnected — a reconnect is in flight; the fresh `open` re-queries.
      return;
    }
    if (queryInFlight) {
      refetchDirty = true;
      return;
    }
    queryInFlight = true;
    currentSock.write(encodeFrame(query));
  }

  /**
   * Print a connection-lifecycle "meta message": a `...`-fenced doc naming the
   * `event` and any detail keys. This is the SAME out-of-band channel as the
   * sidecar note (`writeSidecars`), distinct from the server's `meta`
   * staleness frame — it narrates connect/disconnect/wait so a long-lived
   * viewer's stream is self-describing across keeperd restarts. Detail values
   * are rendered as plain `String(v)`; the note is meant for humans, not a
   * YAML parser, and lifecycle details (sock path, error message, attempt
   * count) carry no characters that need escaping for legibility.
   */
  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    log("...");
    log(`event: ${event}`);
    for (const [k, v] of Object.entries(detail)) {
      log(`${k}: ${String(v)}`);
    }
    log("...");
  }

  function handleFrame(frame: ServerFrame): void {
    ts(`frame kind=${frame.type}`);
    if (frame.type === "result") {
      queryInFlight = false;
      order.length = 0;
      byId.clear();
      for (const row of frame.rows) {
        const id = String(row[pk]);
        order.push(id);
        byId.set(id, row);
      }
      gotResult = true;
      emitFrameIfChanged();
      // If a change arrived while this query was in flight, refetch once more so
      // we converge on the latest page.
      if (refetchDirty) {
        refetchDirty = false;
        scheduleRefetch();
      }
    } else if (frame.type === "patch" || frame.type === "meta") {
      // A watched row advanced (`patch`) or the filtered set changed (`meta`):
      // the page may be stale. We never render these payloads directly —
      // refetch and re-render from the fresh `result`, so the displayed page is
      // always a true top-N snapshot, never a half-patched mix.
      scheduleRefetch();
    } else if (frame.type === "error") {
      log(`# error ${frame.code} (rev ${frame.rev}): ${frame.message}`);
      if (!gotResult) {
        // A bad_frame / unknown_collection on our own query is terminal — a
        // reconnect can't fix a malformed query, so don't loop on it.
        shuttingDown = true;
        currentSock?.end();
        process.exit(1);
      }
    }
  }

  // Build the epics filter from the CLI flags. Filtering in SQL — not after
  // the fetch — keeps LIMIT counting matching rows (so the page is a true
  // top-N of the filtered set, never short) and makes `result.total` / `meta`
  // describe exactly the set we render. Per-key wire override drops the
  // descriptor default for that key only; an unmentioned key keeps its
  // default. So:
  //
  //   - no flags          → wire `filter` absent → both descriptor defaults
  //                         apply (open + not-yet-approved epics).
  //   - --status <s>      → wire `filter: { status: <s> }`           → status
  //                         default dropped; approval default still applies.
  //   - --status-ne <s>   → wire `filter: { status: { ne: <s> } }`   → status
  //                         default dropped; approval default still applies.
  //   - --show-approved   → wire `filter: { approval: { in: [...all] } }` →
  //                         drops the approval default by routing the
  //                         `approval` key into the wire payload, while
  //                         asserting an `in`-list that names every legal
  //                         approval value (so no real value is excluded).
  //                         The status default still applies.
  //
  // The flags compose: `--show-approved --status done` sends both the
  // explicit `status` override AND the approval-default override.
  const filterParts: Record<string, FilterValue> = {};
  if (values.status !== undefined) {
    filterParts.status = values.status;
  } else if (values["status-ne"] !== undefined) {
    filterParts.status = { ne: values["status-ne"] };
  }
  if (values["show-approved"]) {
    filterParts.approval = { in: ["approved", "rejected", "pending"] };
  }
  const filter: { filter?: Record<string, FilterValue> } =
    Object.keys(filterParts).length > 0 ? { filter: filterParts } : {};
  const query: QueryFrame = {
    type: "query",
    collection: COLLECTION,
    id: "frames",
    limit: PAGE_LIMIT,
    ...filter,
  };

  /**
   * Tear down the just-dropped connection's per-connection state so the next
   * `open` starts clean: stop the poll, forget the live socket, and reset the
   * page + coalescing flags. `lastBody` is cleared too, so the first frame after
   * a reconnect always reprints (the reader sees data resume even if the page is
   * byte-identical to the pre-disconnect one). `gotResult` is NOT reset — it is
   * the sticky "we've seen a good page" flag the terminal-error guard reads.
   */
  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentSock = null;
    order.length = 0;
    byId.clear();
    lastBody = null;
    queryInFlight = false;
    refetchDirty = false;
  }

  /**
   * Open one connection and wire its handlers. Resolves as soon as the socket
   * connects (the `open` handler then drives queries); rejects if the connect
   * fails (daemon not up yet) so `connectWithRetry` can back off. Each
   * connection gets its OWN `LineBuffer` — a partial line from a dropped socket
   * must never bleed into the next one.
   */
  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          ts("open");
          // Connected: reset backoff, adopt the socket, announce, then fetch +
          // start the steady-poll backstop (both via the coalescing path so the
          // poll never races a pending query).
          attempt = 0;
          currentSock = sock;
          emitLifecycle("connected", { sock: sockPath });
          queryInFlight = true;
          const encoded = encodeFrame(query);
          sock.write(encoded);
          ts(`query-write bytes=${encoded.length}`);
          pollTimer = setInterval(scheduleRefetch, POLL_MS);
        },
        data(_sock, chunk) {
          ts(`data bytes=${chunk.length}`);
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            die(`protocol error: ${(err as Error).message}`);
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            handleFrame(JSON.parse(line) as ServerFrame);
          }
        },
        close() {
          ts("close");
          // The server closed (or keeperd restarted). Unless we're exiting,
          // tear down and reconnect through the same backoff loop — never exit.
          if (shuttingDown) {
            return;
          }
          teardownConnection();
          emitLifecycle("disconnected", {});
          void connectWithRetry();
        },
        error(_sock, err) {
          // A transport error on a live socket; `close` follows and drives the
          // reconnect. Just narrate it here (don't double-schedule).
          emitLifecycle("error", { message: err.message });
        },
      },
    });
  }

  /**
   * (Re)establish the connection, retrying with capped backoff until it
   * succeeds or we're shutting down. This single loop serves BOTH first-launch
   * "wait for keeperd to come up" and post-disconnect reconnect — there's no
   * socket-level readiness signal, so an accepted connection IS "data ready".
   */
  async function connectWithRetry(): Promise<void> {
    emitLifecycle("connecting", { sock: sockPath });
    while (!shuttingDown) {
      try {
        await connectOnce();
        return; // connected — `open` took over; `close` re-drives this loop
      } catch (err) {
        attempt += 1;
        const delay = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        emitLifecycle("waiting", {
          attempt,
          retry_in_ms: delay,
          reason: (err as Error).message,
        });
        await Bun.sleep(delay);
      }
    }
  }

  // Clean unsubscribe + exit on Ctrl-C, so the server drops our subscription.
  process.on("SIGINT", () => {
    shuttingDown = true;
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    try {
      currentSock?.write(encodeFrame({ type: "unsubscribe", id: "frames" }));
      currentSock?.end();
    } catch {
      // socket already gone — nothing to release
    }
    process.exit(0);
  });

  await connectWithRetry();
}

await main();

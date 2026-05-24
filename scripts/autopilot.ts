#!/usr/bin/env bun
/**
 * autopilot — live epic-block view with per-task approval pills, over the
 * read-only NDJSON-over-UDS subscribe server (`src/server-worker.ts`). One
 * `Bun.connect` socket; one subscription to the `epics` collection. Each
 * epic row carries its planctl-native `approval` field as a top-level
 * column (schema v13 — see `fn-592-approval-as-planctl-field`), and each
 * embedded task element inside `epic.tasks` carries its own `approval`
 * field. No sidecar table, no second subscription, no virtual close-row.
 *
 * Render shape (YAML block sequence, one entry per epic in newest-first
 * `epics` order):
 *
 *   ---
 *   - epic: <epic_id> [<approval>]
 *     tasks:
 *       - <task_id> [<approval>]
 *       - <task_id> [<approval>]
 *   - epic: <epic_id> [<approval>]
 *     tasks: []
 *
 * Each task line shows the slug only (no titles, no `project_dir`, no
 * `[<status>]`); the trailing approval pill comes from the embedded task
 * element's `approval` field. A missing / unknown value coerces to
 * `pending` (a defensive guard — the plan-worker pre-coerces, so a value
 * off the enum at this layer would be a bug).
 *
 * Default scope. The server's `epics` descriptor carries
 * `defaultFilter: { status: "open", approval: { ne: "approved" } }`, so a
 * bare query hides approved epics by default. autopilot's CLI flags
 * compose on top of that:
 *
 *   --show-approved   drop ONLY the `approval` default (status default
 *                     stays); approved epics reappear.
 *   --status <s>      pin the status default to a specific value (e.g.
 *                     `done`).
 *   --status-ne <s>   exclude one status value (overrides the default
 *                     `status: "open"` scope).
 *
 * Server filter composition. Per-key wire override drops the matching
 * descriptor default; an unmentioned key keeps its default. So
 * `--show-approved` sends `filter: { approval: { in: [<every enum
 * value>] } }` — an `in`-list naming the full approval vocabulary. The
 * presence of the `approval` key drops the descriptor default for that
 * key; the all-values `in` payload asserts no real constraint, so every
 * approval value passes. See `epicsFilter` below for the exact wire
 * payload.
 *
 * Single shared sidecar. The per-pid `/tmp/autopilot.<pid>.state.json`
 * and `/tmp/autopilot.<pid>.frame.yaml` files mirror the epics page,
 * written at most once per emitted frame.
 *
 * Reuse with sibling clients: `src/protocol.ts` (`encodeFrame`,
 * `LineBuffer`), `resolveSockPath()`, the connection / coalescing /
 * reconnect-with-backoff loop cloned from `scripts/jobs.ts` /
 * `scripts/epics.ts`.
 *
 * Usage:
 *   bun scripts/autopilot.ts [--sock <path>] [--status <s> | --status-ne <s>]
 *                            [--show-approved]
 *
 *   --sock <path>      Socket path override (else $KEEPER_SOCK, else the
 *                      ~/.local/state/keeper/keeperd.sock default).
 *   --status <s>       Filter the epics subscription to epics whose status
 *                      equals <s> (e.g. done).
 *   --status-ne <s>    Filter the epics subscription to epics whose status
 *                      is NOT <s>. Default: server applies the open-epic
 *                      scope.
 *   --show-approved    Drop the descriptor's approval default; approved
 *                      epics reappear. The status default still applies.
 *   --help             Show this help.
 */

import { writeFileSync } from "node:fs";
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
 * `src/protocol.ts`). autopilot is a single-view full-collection reader,
 * not a paginated list, so we always ask for everything that matches the
 * scope. The realtime diff fan-out grows with watched-set size; the
 * tradeoff is acceptable at today's volume (~640 epics total, ~5 in the
 * default scope after approval cleanup).
 */
const PAGE_LIMIT = 0;

/**
 * How often (ms) the worker refetches its page. The server can't signal
 * an off-page re-sort, so this steady beat is what guarantees we
 * eventually show the current top-N. The server's own `data_version`
 * poll is ~50ms; this is the client's coarser "always show the latest
 * page" cadence.
 */
const POLL_MS = 500;

/**
 * Reconnect/connect-wait backoff. The first (re)connect attempt fires
 * immediately; each subsequent failed attempt waits
 * `min(INITIAL_BACKOFF_MS * 2**(attempt-1), MAX_BACKOFF_MS)` before retrying,
 * so a not-yet-up daemon is polled gently and a restart is picked up fast.
 */
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

const HELP = `autopilot — epic-block stream with approval pills over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>]
       [--status <s> | --status-ne <s>] [--show-approved]

  --sock <path>     Socket path override ($KEEPER_SOCK / default otherwise)
  --status <s>      Filter the epics subscription to epics whose status
                    equals <s> (e.g. done)
  --status-ne <s>   Filter the epics subscription to epics whose status
                    is NOT <s>
                    (--status and --status-ne are mutually exclusive)
                    (default: no status flag → the server's default scope
                    shows only OPEN epics; pass a flag to see other statuses)
  --show-approved   Drop the server's approval default; approved epics
                    reappear in the page. The status default still applies.
  --help            Show this help

Renders one block per epic (newest-first) — \`- epic: <epic_id> [<approval>]\`
over either \`tasks: []\` or \`tasks:\` + nested \`- <task_id> [<approval>]\`
lines. Approval pills come from the planctl-native \`approval\` field on
each epic / embedded task element (schema v13). A new frame prints only
when the rendered output changes; pill flips reframe, task title edits /
status flips do not. Every emitted frame is mirrored to two /tmp sidecar
files (full JSON state + rendered frame), whose paths print in a
...-fenced note.

One \`Bun.connect\` socket carries the subscription; \`patch\` / \`meta\`
frames trigger a refetch + re-render. Lifecycle notes carry an
\`event_source: epics\` detail key for parity with multi-source viewers.
The connection reconnects across keeperd restarts; Ctrl-C exits cleanly.
`;

/** The collection name this client streams. */
const EPICS_COLLECTION = "epics";
/** Primary key of the collection (for `row[pk]` lookups). */
const EPIC_PK = "epic_id";

/** Approval enum vocabulary, mirrored from `src/plan-worker.ts:Approval`. */
const APPROVAL_VALUES = new Set(["approved", "rejected", "pending"]);

/**
 * Coerce a row's `approval` cell to the enum's display value. The plan-
 * worker pre-coerces so a value off the enum at this layer would be a
 * bug; we coerce defensively anyway (CLAUDE.md "safe value" invariant)
 * so a typo never breaks the render.
 */
function approvalPill(v: unknown): string {
  if (typeof v === "string" && APPROVAL_VALUES.has(v)) {
    return v;
  }
  return "pending";
}

/**
 * Render one value as YAML. Scalars are bare when safe, else single-quoted;
 * arrays and objects (any future decoded JSON-TEXT column) render as flow
 * sequences / mappings with each element recursed through this same function,
 * so a list column shows as `[a, b]` rather than a comma-flattened string.
 */
function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) {
    return "null";
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(yamlScalar).join(", ")}]`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{${entries.map(([k, val]) => `${k}: ${yamlScalar(val)}`).join(", ")}}`;
  }
  const s = String(v);
  // Emit a bare (plain) scalar whenever YAML permits one — a plain scalar
  // legally carries spaces and most characters (incl. `·`), so a value like
  // `keeper · my task · working` needs no quotes. Quote (single-quote, doubling
  // embedded quotes — the YAML escape for `'`) only for the cases that would
  // otherwise be invalid or restructure the node:
  //   - the empty string, or leading/trailing whitespace;
  //   - a leading flow/indicator char (`![]{},|>@\`"'%` or `&*#`);
  //   - a leading `-`/`?`/`:` that is followed by a space or ends the string
  //     (those three are indicators only in that position);
  //   - an embedded `": "` or trailing `:` (would start a mapping);
  //   - an embedded `" #"` (would start a comment).
  const needsQuote =
    s === "" ||
    /^\s|\s$/.test(s) ||
    /^[![\]{},|>@`"'%&*#]/.test(s) ||
    /^[-?:](\s|$)/.test(s) ||
    /:(\s|$)/.test(s) ||
    /\s#/.test(s);
  if (!needsQuote) {
    return s;
  }
  return `'${s.replace(/'/g, "''")}'`;
}

function die(message: string): never {
  process.stderr.write(`autopilot: ${message}\n`);
  process.exit(2);
}

/**
 * A live subscription against ONE collection on ONE `Bun.connect` socket.
 * Owns its own connection lifecycle (open / data / close / error +
 * reconnect-with-backoff), its own coalescing flags, its own page state.
 * Returned API:
 *
 *   start()    — drive the first connect; resolves once the loop has been
 *                kicked off (the loop itself runs forever until `stop`).
 *   stop()     — release all resources owned by this worker: clear poll
 *                timer, unsubscribe + end the live socket. Idempotent.
 *   getRows()  — return the current page snapshot in server-sent order:
 *                an array of decoded rows. Wholesale rebuilt on every
 *                `result`; never mutated outside the `handleFrame` path.
 *
 * Kept as a closure factory (rather than collapsed inline) for two
 * reasons: (a) a future sibling subscription could re-use the same
 * machinery by instantiating a second worker, and (b) the per-connection
 * state stays cleanly scoped — no module-level mutables.
 */
type ConnectionWorker = {
  start: () => Promise<void>;
  stop: () => void;
  getRows: () => Map<string, Record<string, unknown>>;
};

function createConnectionWorker(params: {
  name: string;
  pk: string;
  query: QueryFrame;
  sockPath: string;
  isShuttingDown: () => boolean;
  onChange: () => void;
  emitLifecycle: (
    event: string,
    detail: Record<string, unknown>,
    source: string,
  ) => void;
  isTerminalError: boolean;
}): ConnectionWorker {
  const {
    name,
    pk,
    query,
    sockPath,
    isShuttingDown,
    onChange,
    emitLifecycle,
    isTerminalError,
  } = params;

  // Per-worker page state, rebuilt wholesale on every `result`. The renderer
  // reads `byId` via `getRows()`; `order` is kept for any future ordered
  // access (the epics renderer iterates the page in server-sent order, so
  // we surface it as well).
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();

  // Refetch coalescing: at most one `query` in flight; a signal arriving
  // while one is pending sets `refetchDirty` so we refetch exactly once
  // more when the result lands.
  let queryInFlight = false;
  let refetchDirty = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Sticky "we've seen a good page" flag, the terminal-error guard reads it.
  let gotResult = false;

  // Live socket — null between connections so writes route to the current
  // one, never to a closed one.
  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let currentSock: Sock | null = null;
  let attempt = 0;

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

  function handleFrame(frame: ServerFrame): void {
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
      onChange();
      if (refetchDirty) {
        refetchDirty = false;
        scheduleRefetch();
      }
    } else if (frame.type === "patch" || frame.type === "meta") {
      // A watched row advanced (`patch`) or the filtered set changed
      // (`meta`): the page may be stale. We never render these payloads
      // directly — refetch and re-render from the fresh `result`.
      scheduleRefetch();
    } else if (frame.type === "error") {
      const where = `(${name}, rev ${frame.rev})`;
      process.stdout.write(
        `# error ${frame.code} ${where}: ${frame.message}\n`,
      );
      if (!gotResult && isTerminalError) {
        // A bad_frame / unknown_collection on the EPICS worker is
        // terminal — a reconnect can't fix a malformed query, and
        // there's no useful render without epics.
        try {
          currentSock?.end();
        } catch {
          // socket already gone
        }
        process.exit(1);
      } else if (!gotResult) {
        emitLifecycle(
          "warn",
          { code: frame.code, message: frame.message },
          name,
        );
      }
    }
  }

  /**
   * Tear down the just-dropped connection's per-connection state so the
   * next `open` starts clean. `gotResult` is NOT reset — it is the
   * sticky "we've seen a good page" flag the terminal-error guard reads.
   */
  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentSock = null;
    order.length = 0;
    byId.clear();
    queryInFlight = false;
    refetchDirty = false;
    // Notify the shared renderer that this worker's page just dropped,
    // so a stale view doesn't linger after a disconnect.
    onChange();
  }

  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          attempt = 0;
          currentSock = sock;
          emitLifecycle("connected", { sock: sockPath }, name);
          queryInFlight = true;
          sock.write(encodeFrame(query));
          pollTimer = setInterval(scheduleRefetch, POLL_MS);
        },
        data(_sock, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            die(`protocol error (${name}): ${(err as Error).message}`);
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            handleFrame(JSON.parse(line) as ServerFrame);
          }
        },
        close() {
          if (isShuttingDown()) {
            return;
          }
          teardownConnection();
          emitLifecycle("disconnected", {}, name);
          void connectWithRetry();
        },
        error(_sock, err) {
          emitLifecycle("error", { message: err.message }, name);
        },
      },
    });
  }

  async function connectWithRetry(): Promise<void> {
    emitLifecycle("connecting", { sock: sockPath }, name);
    while (!isShuttingDown()) {
      try {
        await connectOnce();
        return; // connected — `open` took over; `close` re-drives the loop
      } catch (err) {
        attempt += 1;
        const delay = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        emitLifecycle(
          "waiting",
          {
            attempt,
            retry_in_ms: delay,
            reason: (err as Error).message,
          },
          name,
        );
        await Bun.sleep(delay);
      }
    }
  }

  let stopped = false;
  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      currentSock?.write(encodeFrame({ type: "unsubscribe", id: query.id }));
      currentSock?.end();
    } catch {
      // socket already gone — nothing to release
    }
    currentSock = null;
  }

  return {
    start: connectWithRetry,
    stop,
    getRows: () => byId,
  };
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

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);

  // The last frame's body, so a byte-identical re-send prints nothing.
  let lastBody: string | null = null;

  let shuttingDown = false;

  const seg = (v: unknown) => (v == null ? "" : String(v));

  /**
   * Project the epics page into a YAML document body (no leading `---`).
   * Walks each epic in the epics worker's order (server-sent —
   * newest-first per the default sort); for each epic emits
   * `- epic: <epic_id> [<approval>]` followed by `tasks: []` or
   * `tasks:` + nested `- <task_id> [<approval>]` lines per embedded
   * task. Both pills come from the planctl-native `approval` field
   * (top-level on the epic row, top-level on each embedded task
   * element) — no second subscription, no virtual close-row.
   *
   * Empty epics page (no rows yet, or all epics filtered out) renders
   * `"[]"` — an empty YAML sequence — so the frame is always a valid
   * single-document YAML stream.
   */
  function renderBody(): string {
    const epicsRows = epicsWorker.getRows();

    // Use the epics worker's order for newest-first iteration. The
    // worker rebuilds it wholesale on every `result`, so it's already
    // in server-sent order at render time.
    const epicIdsInOrder: string[] = [];
    for (const id of epicsRows.keys()) {
      epicIdsInOrder.push(id);
    }

    if (epicIdsInOrder.length === 0) {
      return "[]"; // empty page → an empty YAML sequence
    }

    const lines: string[] = [];
    for (const epic_id of epicIdsInOrder) {
      const epic = epicsRows.get(epic_id) ?? { [EPIC_PK]: epic_id };
      const epicPill = approvalPill(epic.approval);
      lines.push(`- epic: ${yamlScalar(`${epic_id} [${epicPill}]`)}`);
      const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
      if (tasks.length === 0) {
        lines.push("  tasks: []");
      } else {
        lines.push("  tasks:");
        for (const task of tasks) {
          const t = task as Record<string, unknown>;
          const task_id = seg(t.task_id);
          const pill = approvalPill(t.approval);
          lines.push(`    - ${yamlScalar(`${task_id} [${pill}]`)}`);
        }
      }
    }
    return lines.join("\n");
  }

  // Per-frame sidecar files: the latest emitted frame is mirrored to /tmp so
  // it can be inspected out-of-band. Per-pid so concurrent runs don't
  // collide; overwritten each frame (always the most recently printed
  // frame).
  const stateSidecar = `/tmp/autopilot.${process.pid}.state.json`;
  const frameSidecar = `/tmp/autopilot.${process.pid}.frame.yaml`;

  /**
   * Mirror the just-emitted frame to its two sidecar files and print a
   * `...`-fenced note with their paths. The state file carries the
   * epics page (in server-sent order) — approval rides as the
   * top-level `approval` column on the epic row and on each embedded
   * task element, so a reader sees the full input the frame was built
   * from without a second collection. Best-effort: a /tmp write
   * failure logs a warning and never wedges the stream.
   */
  function writeSidecars(frameText: string): void {
    const epicsRows = epicsWorker.getRows();
    const state = {
      epics: Array.from(epicsRows.values()),
    };
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
   * Print a new frame iff the rendered projection moved. This byte-compare
   * on `renderBody()` output is the CONTRACT: a frame is emitted only when
   * the rendered text changes — internal row churn that doesn't surface in
   * the rendered text (task title edits, status flips that aren't shown
   * in the new render shape) is invisible by design. Every emit routes
   * through here; nothing prints a frame directly.
   */
  function emitFrameIfChanged(): void {
    const body = renderBody();
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    const frameText = `---\n${body}`;
    log(frameText);
    writeSidecars(frameText);
  }

  /**
   * Print a connection-lifecycle "meta message": a `...`-fenced YAML doc
   * naming the `event`, an `event_source` (`"epics"`) detail key, and
   * any other detail keys. This is the SAME out-of-band channel as the
   * sidecar note (`writeSidecars`), distinct from the server's `meta`
   * staleness frame — it narrates connect/disconnect/wait so a
   * long-lived viewer's stream is self-describing across keeperd
   * restarts. Detail values route through `yamlScalar` so a path or
   * message quotes correctly.
   */
  function emitLifecycle(
    event: string,
    detail: Record<string, unknown>,
    source: string,
  ): void {
    log("...");
    log(`event: ${event}`);
    log(`event_source: ${yamlScalar(source)}`);
    for (const [k, v] of Object.entries(detail)) {
      log(`${k}: ${yamlScalar(v)}`);
    }
    log("...");
  }

  // Build the epics-subscription filter. The server's `epics` descriptor
  // carries `defaultFilter: { status: "open", approval: { ne: "approved" } }`,
  // and per-key wire overrides drop the matching default for that key only
  // (an unmentioned key keeps its default). So:
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
    // Name every legal approval value. The wire goal is "present the
    // `approval` key so the descriptor default for it drops, but assert
    // no constraint that excludes a real value" — the all-values `in`
    // list does that and reads as obvious intent.
    filterParts.approval = { in: ["approved", "rejected", "pending"] };
  }
  const epicsFilter: { filter?: Record<string, FilterValue> } =
    Object.keys(filterParts).length > 0 ? { filter: filterParts } : {};
  const epicsQuery: QueryFrame = {
    type: "query",
    collection: EPICS_COLLECTION,
    id: "frames-epics",
    limit: PAGE_LIMIT,
    ...epicsFilter,
  };

  // Construct the single worker. It owns the connection lifecycle; the
  // shared shutdown flag is read via a getter so a SIGINT after
  // construction is honored.
  const epicsWorker = createConnectionWorker({
    name: "epics",
    pk: EPIC_PK,
    query: epicsQuery,
    sockPath,
    isShuttingDown: () => shuttingDown,
    onChange: emitFrameIfChanged,
    emitLifecycle,
    isTerminalError: true,
  });

  // SIGINT handler — stop the worker (releases its socket + clears its
  // poll timer; `stop()` is idempotent so re-firing is harmless) then
  // exit once.
  process.on("SIGINT", () => {
    shuttingDown = true;
    try {
      epicsWorker.stop();
    } catch {
      // best-effort
    }
    process.exit(0);
  });

  await epicsWorker.start();
}

await main();

#!/usr/bin/env bun
/**
 * autopilot — live epic-block view with per-task approval pills, over the
 * read-only NDJSON-over-UDS subscribe server (`src/server-worker.ts`). It is
 * the first example client to ride TWO simultaneous `Bun.connect` sockets:
 * one subscribes to the `epics` collection (the render skeleton), one
 * subscribes to the `approvals` sidecar (schema v12 — the pill state). Two
 * connections are necessary because `dispatchLine` REPLACES the active
 * subscription on every `query` (server-worker's one-subscription-per-
 * connection contract — see `src/server-worker.ts:537-549`); multi-sub per
 * connection would require a protocol change beyond this epic's scope.
 *
 * Render shape (YAML block sequence, one entry per epic in newest-first
 * `epics` order):
 *
 *   ---
 *   - epic: <epic_id>
 *     tasks:
 *       - <task_id> [<pill>]
 *       - <task_id> [<pill>]
 *     - close:<epic_id> [<pill>]
 *   - epic: <epic_id>
 *     tasks: []
 *     - close:<epic_id> [<pill>]
 *
 * Each task line shows the slug only (no titles, no `project_dir`, no
 * `[<status>]` — those were the old flat-line shape). The trailing
 * `close:<epic_id>` row is virtual — there is no task in `epic.tasks` for
 * it; it's a per-epic approval slot the planning workflow uses to gate
 * closing the whole epic, surfaced here so an operator can `approve`/
 * `reject` it via `scripts/approve.ts`. The pill is `[pending]`,
 * `[approved]`, or `[rejected]`, sourced from the approvals worker's
 * `approvalsByKey` map (key = `epic_id + ':' + task_key`); a missing row
 * renders as `[pending]` — the schema-v12 invariant (absent row =
 * pending).
 *
 * Two-connection design. `ConnectionWorker` is a closure factory: one call
 * returns `{ start, stop, getRows }`, each instance owning ITS OWN
 * `currentSock` / `attempt` / `pollTimer` / `queryInFlight` /
 * `refetchDirty` / `gotResult` / `order` / `byId` / `LineBuffer` + the
 * full reconnect-with-backoff loop. The renderer reads from both workers'
 * state via `getRows()`. Two singletons in `main()` — `epicsWorker` and
 * `approvalsWorker` — share one `lastBody` and one `emitFrameIfChanged`:
 * either worker's `result` or `patch`/`meta` triggers a re-eval, but the
 * byte-compare emit-gate fires only when the rendered text moves (a pill
 * flip reframes; a task title edit or status flip alone does NOT, since
 * neither is in the rendered surface).
 *
 * Lifecycle narration is SHARED. `emitLifecycle` carries an
 * `event_source: epics|approvals` detail key so a long-lived viewer can
 * tell which loop changed. SIGINT cleanly stops BOTH workers (unsubscribe
 * + end socket on each, clear both poll timers) before a single
 * `process.exit(0)` — no double-exit, no orphaned timers.
 *
 * Tolerance for an old daemon. On first connect against a daemon that
 * predates Task .2's schema-v12 (no `approvals` collection), the
 * approvals worker's first frame can be an `error` with code
 * `unknown_collection`. That is NOT terminal — the per-worker
 * `gotResult` guard means a not-yet-seen-good-page error on the
 * approvals socket warns and leaves `approvalsByKey` empty; the
 * renderer treats every task as `[pending]` and epics keeps flowing.
 * A `bad_frame` / `unknown_collection` on the EPICS worker remains
 * terminal — a reconnect can't fix a malformed query and there's no
 * useful render without epics.
 *
 * Single shared sidecar. The per-pid `/tmp/autopilot.<pid>.state.json`
 * and `/tmp/autopilot.<pid>.frame.yaml` files mirror the COMBINED view
 * (epics page + approvals map), written at most once per emitted frame.
 *
 * Reuse with sibling clients: `src/protocol.ts` (`encodeFrame`,
 * `LineBuffer`), `resolveSockPath()`, the connection/coalescing logic
 * cloned from `scripts/jobs.ts` / `scripts/epics.ts`. The "extract a
 * shared module if a third client appears" comment at the original
 * autopilot.ts:55-58 is now formally triggering; this rewrite
 * closure-factors the per-connection plumbing inside autopilot.ts (not
 * a separate `scripts/lib/keeper-client.ts`) so two `ConnectionWorker`s
 * co-exist cleanly. A future task can extract once a fourth use appears.
 *
 * Usage:
 *   bun scripts/autopilot.ts [--sock <path>] [--status <s> | --status-ne <s>]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --status <s>     Filter the EPICS subscription to epics whose status
 *                    equals <s> (e.g. done). Does NOT filter approvals.
 *   --status-ne <s>  Filter the EPICS subscription to epics whose status
 *                    is NOT <s>. Default: no filter → server applies
 *                    open-epic scope.
 *   --help           Show this help.
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

/** The page size each worker pages. Fixed for now. */
const PAGE_LIMIT = 10;

/**
 * How often (ms) each worker refetches its page. The server can't signal an
 * off-page re-sort (see file header), so this steady beat is what guarantees
 * we eventually show the current top-N. The server's own `data_version`
 * poll is ~50ms; this is the client's coarser "always show the latest page"
 * cadence.
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
       [--status <s> | --status-ne <s>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --status <s>     Filter the epics subscription to epics whose status
                   equals <s> (e.g. done)
  --status-ne <s>  Filter the epics subscription to epics whose status
                   is NOT <s>
                   (--status and --status-ne are mutually exclusive)
                   (default: no status flag → the server's default scope
                   shows only OPEN epics; pass a flag to see other statuses)
  --help           Show this help

Renders one block per epic (newest-first) — \`- epic: <epic_id>\` over
either \`tasks: []\` or \`tasks:\` + nested \`- <task_id> [<pill>]\`
lines — and one trailing virtual \`- close:<epic_id> [<pill>]\` row per
epic. Pills are sourced from a SECOND \`approvals\` subscription that runs
in parallel; missing row = \`[pending]\` (the schema-v12 invariant). A new
frame prints only when the rendered output changes; pill flips reframe,
task title edits / status flips do not. Every emitted frame is mirrored
to two /tmp sidecar files (full JSON state + rendered frame), whose paths
print in a ...-fenced note.

Two parallel \`Bun.connect\` sockets keep the subscriptions alive; either
worker's \`patch\` / \`meta\` triggers a refetch + re-render. Lifecycle
notes carry \`event_source: epics|approvals\` so a long-lived viewer can
tell which loop changed. Both reconnect across keeperd restarts; Ctrl-C
exits cleanly.
`;

/** The two collection names this client streams. */
const EPICS_COLLECTION = "epics";
const APPROVALS_COLLECTION = "approvals";
/** Primary keys of each collection (for `row[pk]` lookups). */
const EPIC_PK = "epic_id";
const APPROVAL_PK = "approval_id";

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
 * Constructor params:
 *   - `name`             — `"epics"` / `"approvals"`, used as the
 *                          `event_source` tag in lifecycle notes and the
 *                          subscription id (also doubles as a debug label).
 *   - `pk`               — primary-key column of the collection, for the
 *                          `byId` index.
 *   - `query`            — the `QueryFrame` to (re)send on every connect
 *                          and every coalesced refetch. Stable for the
 *                          life of the worker.
 *   - `sockPath`         — UDS path to connect to. Resolved once in
 *                          `main()` and passed in.
 *   - `isShuttingDown`   — closure-shared "we're exiting" flag. Reading
 *                          a getter (not capturing a `let`) keeps the
 *                          worker honest about a flag flipped by SIGINT
 *                          AFTER this worker was constructed.
 *   - `onChange`         — invoked from `handleFrame` whenever the
 *                          worker's state may have moved (any `result`
 *                          completion or any `patch`/`meta` that
 *                          triggers a refetch). The shared renderer +
 *                          emit-gate runs here.
 *   - `emitLifecycle`    — shared lifecycle channel; the worker passes
 *                          its own `name` as `event_source`.
 *   - `isTerminalError`  — `true` if an `error` frame BEFORE the first
 *                          `result` should exit the process. The epics
 *                          worker passes `true` (no useful render
 *                          without epics); the approvals worker passes
 *                          `false` (an old daemon's
 *                          `unknown_collection` warns and renders
 *                          everything as `[pending]`).
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
        // there's no useful render without epics. The approvals worker
        // passes `isTerminalError: false`, so an old daemon's
        // `unknown_collection` just leaves `approvalsByKey` empty
        // (every task renders as `[pending]`) and epics keeps flowing.
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
    // so a stale view (e.g. an approval pill snapshot from a previous
    // daemon process) doesn't linger after a disconnect.
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
  // Shared across both workers — either worker's update walks back through
  // `emitFrameIfChanged` and a render-text-stable update is silently
  // swallowed.
  let lastBody: string | null = null;

  let shuttingDown = false;

  const seg = (v: unknown) => (v == null ? "" : String(v));

  /**
   * Project the epics + approvals pages into a YAML document body (no
   * leading `---`). Walks each epic in the epics worker's order
   * (server-sent — newest-first per the default sort); for each epic emits
   * `- epic: <epic_id>` followed by `tasks: []` or `tasks:` + nested
   * `- <task_id> [<pill>]` lines per embedded task, then one trailing
   * `- close:<epic_id> [<pill>]` virtual row. Pills are sourced from the
   * approvals worker's keyed map (`approvalsByKey.get(epic_id + ':' +
   * task_key)`); a missing row renders as `[pending]` — the schema-v12
   * invariant.
   *
   * Empty epics page (no rows yet, or all epics filtered out) renders
   * `"[]"` — an empty YAML sequence — so the frame is always a valid
   * single-document YAML stream.
   */
  function renderBody(): string {
    const epicsRows = epicsWorker.getRows();
    const approvalsRows = approvalsWorker.getRows();

    // Build the lookup once per render. Approval rows arrive on the
    // sidecar subscription as `{ approval_id, epic_id, task_key, status,
    // updated_at }`; we key by `epic_id:task_key` to match the spec.
    const approvalsByKey = new Map<string, string>();
    for (const row of approvalsRows.values()) {
      const epic_id = seg(row.epic_id);
      const task_key = seg(row.task_key);
      const status = seg(row.status);
      if (epic_id.length === 0 || task_key.length === 0) {
        continue;
      }
      approvalsByKey.set(`${epic_id}:${task_key}`, status);
    }

    const pillFor = (epic_id: string, task_key: string): string => {
      const status = approvalsByKey.get(`${epic_id}:${task_key}`);
      // Schema-v12 invariant: absent row = "pending".
      return status && status.length > 0 ? status : "pending";
    };

    // Use the epics worker's `order` for newest-first iteration. The
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
      lines.push(`- epic: ${yamlScalar(epic_id)}`);
      const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
      if (tasks.length === 0) {
        lines.push("  tasks: []");
      } else {
        lines.push("  tasks:");
        for (const task of tasks) {
          const t = task as Record<string, unknown>;
          const task_id = seg(t.task_id);
          const pill = pillFor(epic_id, task_id);
          lines.push(`    - ${yamlScalar(`${task_id} [${pill}]`)}`);
        }
      }
      // Virtual per-epic close-approval row. There is no task in
      // `epic.tasks` for it — `task_key` is the literal `close:<epic_id>`
      // string the planning workflow uses. Emitted UNDER the same epic
      // mapping (consistent indent with the tasks list) so a reader sees
      // it grouped with that epic.
      const closeKey = `close:${epic_id}`;
      const closePill = pillFor(epic_id, closeKey);
      lines.push(`  - ${yamlScalar(`${closeKey} [${closePill}]`)}`);
    }
    return lines.join("\n");
  }

  // Per-frame sidecar files: the latest emitted frame is mirrored to /tmp so
  // it can be inspected out-of-band. Per-pid so concurrent runs don't
  // collide; overwritten each frame (always the most recently printed
  // frame). The state snapshot includes BOTH workers' pages so a reader
  // sees the full input the frame was built from.
  const stateSidecar = `/tmp/autopilot.${process.pid}.state.json`;
  const frameSidecar = `/tmp/autopilot.${process.pid}.frame.yaml`;

  /**
   * Mirror the just-emitted frame to its two sidecar files and print a
   * `...`-fenced note with their paths. The combined state file carries
   * both the epics page (in server-sent order) and the approvals map (as
   * an array of rows). Best-effort: a /tmp write failure logs a warning
   * and never wedges the stream.
   */
  function writeSidecars(frameText: string): void {
    const epicsRows = epicsWorker.getRows();
    const approvalsRows = approvalsWorker.getRows();
    const state = {
      epics: Array.from(epicsRows.values()),
      approvals: Array.from(approvalsRows.values()),
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
   * naming the `event`, an `event_source` (`"epics"` / `"approvals"`)
   * detail key, and any other detail keys. This is the SAME out-of-band
   * channel as the sidecar note (`writeSidecars`), distinct from the
   * server's `meta` staleness frame — it narrates connect/disconnect/wait
   * so a long-lived viewer's stream is self-describing across keeperd
   * restarts AND across which worker changed. Detail values route through
   * `yamlScalar` so a path or message quotes correctly.
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

  // Build the optional epic-status filter from the CLI flags. Filtering in
  // SQL — not after the fetch — keeps LIMIT counting matching rows (so the
  // page is a true top-N of the filtered set, never short) and makes
  // `result.total` / `meta` describe exactly the set we render. With NO
  // flag set we send NO `filter` key (the `{}` spread path, not
  // `filter: {}`) so the server's default scope (`status: "open"`) applies
  // and the page is the open-epic set. The filter applies ONLY to the
  // epics subscription — the approvals subscription is always unfiltered
  // (an approval row belongs to an epic that may or may not be on the
  // current epics page; rendering tolerates orphans by simply not looking
  // them up).
  const epicsFilter: { filter?: Record<string, FilterValue> } =
    values.status !== undefined
      ? { filter: { status: values.status } }
      : values["status-ne"] !== undefined
        ? { filter: { status: { ne: values["status-ne"] } } }
        : {};
  const epicsQuery: QueryFrame = {
    type: "query",
    collection: EPICS_COLLECTION,
    id: "frames-epics",
    limit: PAGE_LIMIT,
    ...epicsFilter,
  };
  const approvalsQuery: QueryFrame = {
    type: "query",
    collection: APPROVALS_COLLECTION,
    id: "frames-approvals",
    limit: PAGE_LIMIT,
  };

  // Construct both workers. They share the shutdown flag (via a getter so
  // a flip in SIGINT is seen by both) and the lifecycle / change channels.
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
  const approvalsWorker = createConnectionWorker({
    name: "approvals",
    pk: APPROVAL_PK,
    query: approvalsQuery,
    sockPath,
    isShuttingDown: () => shuttingDown,
    onChange: emitFrameIfChanged,
    emitLifecycle,
    // An `unknown_collection` from an old daemon on the approvals socket
    // is NOT terminal — warn, leave `approvalsByKey` empty, render every
    // task as `[pending]`, and let epics keep flowing.
    isTerminalError: false,
  });

  // Single shared SIGINT handler — registering twice would queue handlers
  // and double-exit. Stops both workers (each releases its socket + clears
  // its poll timer; `stop()` is idempotent so re-firing is harmless) then
  // exits once.
  process.on("SIGINT", () => {
    shuttingDown = true;
    try {
      epicsWorker.stop();
    } catch {
      // best-effort
    }
    try {
      approvalsWorker.stop();
    } catch {
      // best-effort
    }
    process.exit(0);
  });

  // Start both workers in parallel. Each runs its own connect-with-retry
  // loop; the lifecycle / change channels into `main` synchronize the
  // shared render.
  await Promise.all([epicsWorker.start(), approvalsWorker.start()]);
}

await main();

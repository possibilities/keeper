#!/usr/bin/env bun
/**
 * keeper-frames — a primitive "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`). It renders a *page of jobs as a frame* and
 * reprints a fresh frame every time the visible projection changes.
 *
 * It `query`s a 10-row page of `jobs` and renders it as a YAML stream: each
 * frame is a YAML document (leading `---`) listing every job as a single
 * collapsed string — `{basename(cwd)} · {title} · {state}`. The query optionally
 * carries a server-side `state` filter built from `--state` / `--state-ne`
 * (the bare-value equality form and the `{ ne }` operator form, respectively;
 * default is no filter and every job pages through). When a filter is in
 * effect it runs in SQL, so LIMIT counts only matching rows and `total` /
 * `meta` track exactly that set. Membership is frozen
 * WITHIN a fetched page (the server never reflows a live page), but the script
 * REFETCHES the page — on every `patch`/`meta` change signal AND on a steady
 * poll — so each fresh `result` reflects the current top-N. A NEW frame prints
 * whenever the RENDERED page changes; the rendered output — not internal row
 * churn — is the sole frame trigger, enforced by routing every emit through
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
 * a `...`-fenced YAML note (`event: connecting|connected|waiting|disconnected`,
 * the initial connection included) — the same out-of-band "meta message"
 * channel as the sidecar note, distinct from the server's `meta` staleness
 * frame. Only Ctrl-C (SIGINT) or a terminal query error (`bad_frame` /
 * `unknown_collection` on our own `query`, which a reconnect can't fix) exits.
 *
 * It reuses `src/protocol.ts` (`encodeFrame` to write, `LineBuffer` to
 * de-frame) and `resolveSockPath()` so it stays a faithful mirror of the
 * contract, and it honors the read-only fence: it only ever sends
 * `query` / `unsubscribe`.
 *
 * Usage:
 *   bun scripts/keeper-frames.ts [--collection <name>] [--sock <path>]
 *
 *   --collection <name>  Collection to page (jobs|epics; default jobs).
 *   --sock <path>        Socket path override (else $KEEPER_SOCK, else the
 *                        ~/.local/state/keeper/keeperd.sock default).
 *   --help               Show this help.
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

/** The page size this primitive UI pages. Fixed for now. */
const PAGE_LIMIT = 10;

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

const HELP = `keeper-frames — primitive list UI over the keeper subscribe server

Usage: bun scripts/keeper-frames.ts [--collection <name>] [--sock <path>]
       [--state <s> | --state-ne <s>] [--status <s> | --status-ne <s>]

  --collection <n> Collection to page (jobs|epics; default jobs)
  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --state <s>      Filter to jobs whose state equals <s> (e.g. working)
  --state-ne <s>   Filter to jobs whose state is NOT <s> (e.g. ended)
                   (--state and --state-ne are mutually exclusive)
                   (--state/--state-ne are jobs-only; ignored for epics)
                   (default: no state flag → the server's default scope shows
                   only LIVE jobs (working + stopped); pass --state ended to see
                   ended jobs)
  --status <s>     Filter to epics whose status equals <s> (e.g. done)
  --status-ne <s>  Filter to epics whose status is NOT <s>
                   (--status and --status-ne are mutually exclusive)
                   (--status/--status-ne are epics-only; ignored for jobs)
                   (default: no status flag → the server's default scope shows
                   only OPEN epics; pass a flag to see other statuses)
  --help           Show this help

Renders a 10-row page of the chosen collection as a YAML stream: one frame per
change, each frame a YAML document (--- separated). The render is
collection-appropriate:
  jobs  → a flat sequence of: {basename(cwd)} · {title} · {state}
  epics → a sequence of epic:/tasks: mapping blocks, where each epic line is
          {basename(project_dir)} #{epic_number} {title} (deps #A, #B) [{status}]
          and its embedded tasks list under tasks: as
          {task_number}) {title} (dep #N) [{status}]
          The (deps …) segment lists the epic numbers an epic depends on; the
          (dep #N) segment names only the highest task a task depends on. Both
          are omitted when there are no dependencies.
The page is refetched on every change signal and on a steady poll, so it always
shows the current top-N; a new frame prints only when the rendered output
changes. Every emitted frame is also mirrored to two /tmp sidecar files (full
JSON state + rendered frame), whose paths print in a ...-fenced note.

The client waits for keeperd to come up and reconnects across restarts instead
of exiting; each connection-lifecycle change prints a ...-fenced note
(event: connecting|connected|waiting|disconnected). Ctrl-C exits cleanly.
`;

/** Per-collection primary-key column used as the page index key. */
const PK_BY_COLLECTION: Record<string, string> = {
  jobs: "job_id",
  epics: "epic_id",
};

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
  process.stderr.write(`keeper-frames: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      collection: { type: "string", default: "jobs" },
      sock: { type: "string" },
      state: { type: "string" },
      "state-ne": { type: "string" },
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

  if (values.state !== undefined && values["state-ne"] !== undefined) {
    die("--state and --state-ne are mutually exclusive");
  }
  if (values.status !== undefined && values["status-ne"] !== undefined) {
    die("--status and --status-ne are mutually exclusive");
  }

  const collection = values.collection ?? "jobs";
  // The pk column the page indexes by. Unknown collections fall back to the
  // jobs pk (the server will reject the query with unknown_collection anyway).
  const pk = PK_BY_COLLECTION[collection] ?? "job_id";

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);

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
   * Collapse one full row to its display string, collection-aware:
   *   jobs  → `{basename(cwd)} · {title} · {state}`
   *   epics → `{basename(project_dir)} #{epic_number} {title}{deps} [{status}]`
   * A null/absent segment projects to empty (no basename of nothing). `{deps}`
   * is a ` (deps #3, #5)` segment from `depends_on_epics` (the epic numbers it
   * depends on), omitted when there are none. The epic line drops the task
   * count — the embedded tasks render as their own nested sequence (see
   * `projectTask` / `renderBody`). Together with `projectTask`, this defines
   * which column moves can reframe the page (see `emitFrameIfChanged`).
   */
  function projectRow(row: Record<string, unknown>): string {
    const title = seg(row.title);
    if (collection === "epics") {
      const dir =
        row.project_dir == null ? "" : basename(String(row.project_dir));
      const deps = Array.isArray(row.depends_on_epics)
        ? row.depends_on_epics
        : [];
      const depsSeg =
        deps.length === 0
          ? ""
          : ` (deps ${deps
              .map((d) => {
                const n = epicNumFromId(String(d));
                return n == null ? String(d) : `#${n}`;
              })
              .join(", ")})`;
      return `${dir} #${seg(row.epic_number)} ${title}${depsSeg} [${seg(row.status)}]`;
    }
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    return `${cwd} · ${title} · ${seg(row.state)}`;
  }

  /**
   * Collapse one embedded epic task to its display string:
   * `{task_number}) {title}{dep} [{status}]`. A null/absent segment projects to
   * empty. `{dep}` is a ` (dep #N)` segment naming the HIGHEST task it depends
   * on (max `depends_on` task number) — only the highest is shown even when it
   * depends on several — omitted when there are none. The task's `target_repo`
   * is omitted — it's redundant with the parent epic's `project_dir` already
   * shown on the epic line. Read alongside `projectRow` so a task
   * title/status/dep/membership move surfaces in the frame and reframes.
   */
  function projectTask(task: Record<string, unknown>): string {
    const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
    const nums = deps
      .map((d) => taskNumFromId(String(d)))
      .filter((n): n is number => n != null);
    const depSeg = nums.length === 0 ? "" : ` (dep #${Math.max(...nums)})`;
    return `${seg(task.task_number)}) ${seg(task.title)}${depSeg} [${seg(task.status)}]`;
  }

  /**
   * Render one epic as a YAML mapping block: the collapsed epic line under an
   * `epic:` key, then its embedded tasks as a nested block sequence under
   * `tasks:` (or `tasks: []` when empty). `tasks` is a decoded array on the wire
   * (see `decodeRow`); a non-array (malformed) cell renders as no tasks.
   */
  function renderEpicItem(row: Record<string, unknown>): string {
    const lines = [`- epic: ${yamlScalar(projectRow(row))}`];
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    if (tasks.length === 0) {
      lines.push("  tasks: []");
    } else {
      lines.push("  tasks:");
      for (const task of tasks) {
        lines.push(
          `    - ${yamlScalar(projectTask(task as Record<string, unknown>))}`,
        );
      }
    }
    return lines.join("\n");
  }

  /**
   * Project the frozen page into a YAML document body (no leading `---`), in
   * server-sent order. Jobs render as a flat sequence of one collapsed string
   * per row; epics render as a sequence of `epic:`/`tasks:` mapping blocks (see
   * `renderEpicItem`) so each epic's embedded tasks are listed. Strings carrying
   * `·` auto-single-quote through `yamlScalar`.
   */
  function renderBody(): string {
    if (order.length === 0) {
      return "[]"; // empty page → an empty YAML sequence
    }
    if (collection === "epics") {
      return order
        .map((id) => renderEpicItem(byId.get(id) ?? { [pk]: id }))
        .join("\n");
    }
    return order
      .map((id) => `- ${yamlScalar(projectRow(byId.get(id) ?? { [pk]: id }))}`)
      .join("\n");
  }

  // Per-frame sidecar files: the latest emitted frame is mirrored to /tmp so it
  // can be inspected out-of-band. Per-pid so concurrent runs don't collide;
  // overwritten each frame (always the most recently printed frame).
  const stateSidecar = `/tmp/keeper-frames.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-frames.${process.pid}.frame.yaml`;

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
   * Print a new job frame iff the rendered projection moved. This byte-compare
   * on `renderBody()` output is the CONTRACT: a frame is emitted only when the
   * rendered text changes — internal row churn that doesn't surface in
   * `projectRow` is invisible by design, and stays so as the projection grows.
   * Every emit routes through here; nothing prints a job frame directly. Each
   * emitted frame is mirrored to its sidecar files (see `writeSidecars`).
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
   * Print a connection-lifecycle "meta message": a `...`-fenced YAML doc naming
   * the `event` and any detail keys. This is the SAME out-of-band channel as the
   * sidecar note (`writeSidecars`), distinct from the server's `meta` staleness
   * frame — it narrates connect/disconnect/wait so a long-lived viewer's stream
   * is self-describing across keeperd restarts. Detail values route through
   * `yamlScalar` so a path or message quotes correctly.
   */
  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    log("...");
    log(`event: ${event}`);
    for (const [k, v] of Object.entries(detail)) {
      log(`${k}: ${yamlScalar(v)}`);
    }
    log("...");
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

  // Build the optional collection-appropriate filter from the CLI flags.
  // Filtering in SQL — not after the fetch — keeps LIMIT counting matching rows
  // (so the page is a true top-N of the filtered set, never short) and makes
  // `result.total` / `meta` describe exactly the set we render.
  //   jobs  → `--state` / `--state-ne` on the `state` column (default: no filter,
  //           every job). Jobs-only — epics have no `state` column.
  //   epics → `--status` / `--status-ne` on the `status` column. Epics-only.
  //           Default (no flag): send NO status filter, so the server's default
  //           scope applies and the page shows only OPEN epics; pass `--status
  //           <s>` (e.g. done) or `--status-ne <s>` to see other statuses.
  const filter: { filter?: Record<string, FilterValue> } =
    collection === "jobs"
      ? values.state !== undefined
        ? { filter: { state: values.state } }
        : values["state-ne"] !== undefined
          ? { filter: { state: { ne: values["state-ne"] } } }
          : {}
      : collection === "epics"
        ? values.status !== undefined
          ? { filter: { status: values.status } }
          : values["status-ne"] !== undefined
            ? { filter: { status: { ne: values["status-ne"] } } }
            : {}
        : {};
  const query: QueryFrame = {
    type: "query",
    collection,
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
          // Connected: reset backoff, adopt the socket, announce, then fetch +
          // start the steady-poll backstop (both via the coalescing path so the
          // poll never races a pending query).
          attempt = 0;
          currentSock = sock;
          emitLifecycle("connected", { sock: sockPath });
          queryInFlight = true;
          sock.write(encodeFrame(query));
          pollTimer = setInterval(scheduleRefetch, POLL_MS);
        },
        data(_sock, chunk) {
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

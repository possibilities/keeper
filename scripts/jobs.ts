#!/usr/bin/env bun
/**
 * keeper-jobs — a primitive "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`). It renders a *page of jobs as a frame* and
 * reprints a fresh frame every time the visible projection changes.
 *
 * It `query`s a 10-row page of `jobs` and renders it as a `---`-led document
 * of one job per line in plain bracket form:
 *
 *   ({basename(cwd)}) {title} [{role}] [{state}]
 *
 * The `(...)` cwd segment is omitted when `cwd` is null/empty so the line
 * doesn't lead with empty parens. The `[{role}]` pill is the
 * `Job.plan_verb` noun-form (work → worker, plan → planner, close → closer;
 * off-whitelist verb falls through to the bare verb) and is omitted when
 * `plan_verb` is NULL — i.e. for jobs whose spawn name didn't match the
 * canonical `{verb}::<ref>` shape, so the line stays a clean
 * `({cwd}) {title} [{state}]` for non-planctl sessions. Same role
 * vocabulary and pill placement as the embedded-job lines in
 * `scripts/epics.ts`. The query optionally carries a server-side
 * `state` filter built from `--state` / `--state-ne` (the bare-value equality
 * form and the `{ ne }` operator form, respectively; default is no filter
 * and every job pages through). When a filter is in effect it runs in SQL,
 * so LIMIT counts only matching rows and `total` / `meta` track exactly that
 * set. Membership is frozen WITHIN a fetched page (the server never reflows
 * a live page), but the script REFETCHES the page — on every `patch`/`meta`
 * change signal AND on a steady poll — so each fresh `result` reflects the
 * current top-N. A NEW frame prints whenever the RENDERED page changes; the
 * rendered output — not internal row churn — is the sole frame trigger,
 * enforced by routing every emit through `emitFrameIfChanged`.
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
 * After every emitted frame a second `...`-fenced note prints three per-pid
 * /tmp paths: the full JSON state the frame was built from (the ordered page
 * rows), the rendered frame text itself, and a per-frame unified diff (`diff
 * -u prev current`) against the previous emit. All three are overwritten each
 * frame so a frame can be inspected out-of-band; the first frame's diff file
 * holds a sentinel since there's no prior to diff.
 *
 * Connection is resilient. There is no socket-level readiness handshake —
 * keeperd binds the UDS only after boot-drain completes, so "data ready"
 * reduces to "the socket accepts a connection". On first launch the client
 * therefore RETRIES connecting (capped backoff) until keeperd is up and
 * accepting, and on a dropped connection (e.g. a keeperd restart) it RECONNECTS
 * the same way instead of exiting. Every connection-lifecycle transition prints
 * a `...`-fenced note (`event: connecting|connected|waiting|disconnected`,
 * the initial connection included) — the same out-of-band "meta message"
 * channel as the sidecar note, distinct from the server's `meta` staleness
 * frame. Only Ctrl-C (SIGINT) or a terminal query error (`bad_frame` /
 * `unknown_collection` on our own `query`, which a reconnect can't fix) exits.
 *
 * It reuses `src/protocol.ts` (`encodeFrame` to write, `LineBuffer` to
 * de-frame) and `resolveSockPath()` so it stays a faithful mirror of the
 * contract, and it honors the read-only fence: it only ever sends
 * `query` / `unsubscribe`. The connection/coalescing logic mirrors the
 * sibling `scripts/epics.ts`; extract a shared module once the duplication
 * starts costing more than the copy.
 *
 * Usage:
 *   bun scripts/jobs.ts [--sock <path>] [--state <s> | --state-ne <s>]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --state <s>      Filter to jobs whose state equals <s> (e.g. working).
 *   --state-ne <s>   Filter to jobs whose state is NOT <s> (e.g. ended).
 *   --help           Show this help.
 */

import { appendFileSync, writeFileSync } from "node:fs";
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

const HELP = `keeper-jobs — primitive list UI over the keeper subscribe server

Usage: bun scripts/jobs.ts [--sock <path>] [--state <s> | --state-ne <s>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --state <s>      Filter to jobs whose state equals <s> (e.g. working)
  --state-ne <s>   Filter to jobs whose state is NOT <s> (e.g. ended)
                   (--state and --state-ne are mutually exclusive)
                   (default: no state flag → the server's default scope shows
                   only LIVE jobs (working + stopped) and hides BOTH terminal
                   states (ended + killed); pass --state ended or
                   --state killed to see them explicitly)
  --clear          Clear the terminal before each frame (live-panel mode).
                   Each frame's sidecars are written to indexed paths
                   instead of overwriting, and a session meta file at
                   /tmp/keeper-jobs.<pid>.meta.txt accumulates the full
                   index (tab-separated: frame# state frame diff).
  --help           Show this help

Renders a 10-row page of jobs as a stream of plain bracket-form lines: one
frame per change, each frame led by '---'. One job per line:
  ({basename(cwd)}) {title} [{role}] [{state}]
The (...) cwd segment is omitted when cwd is null/empty. The [{role}] pill
is the job's plan_verb noun-form (work → worker, plan → planner, close →
closer); it is omitted entirely when plan_verb is NULL (non-planctl
sessions), so those lines stay ({cwd}) {title} [{state}]. The page is
refetched on every change signal and on a steady poll, so it always shows
the current top-N; a new frame prints only when the rendered output changes.
Every emitted frame is also mirrored to three /tmp sidecar files (full JSON
state, rendered frame, unified diff vs. the previous emit), whose paths
print in a ...-fenced note.

The client waits for keeperd to come up and reconnects across restarts instead
of exiting; each connection-lifecycle change prints a ...-fenced note
(event: connecting|connected|waiting|disconnected). Ctrl-C exits cleanly.
`;

/** The hardcoded collection and its primary key. */
const COLLECTION = "jobs";
const pk = "job_id";

/**
 * Map a `Job.plan_verb` to its noun-form actor label for the `[{role}]` pill
 * on a job line (`{title} [worker] [working]`). Mirrors the whitelist in
 * `src/derivers.ts:planVerbRefFromSpawnName`, and the sibling helper in
 * `scripts/epics.ts`. An off-whitelist or non-string value falls through to
 * the bare verb — defensive "safe value" so a future fourth verb still
 * renders. Returns `null` when `plan_verb` itself is null so the caller can
 * omit the pill for non-planctl sessions (those jobs have no role to name).
 */
const PLAN_VERB_LABELS: Record<string, string> = {
  plan: "planner",
  work: "worker",
  close: "closer",
};

function planVerbLabel(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  const s = typeof v === "string" ? v : "";
  return PLAN_VERB_LABELS[s] ?? s;
}

function die(message: string): never {
  process.stderr.write(`keeper-jobs: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      state: { type: "string" },
      "state-ne": { type: "string" },
      clear: { type: "boolean", default: false },
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

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const clearMode = values.clear;
  let frameCount = 0;

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
   * Collapse one full row to its display line:
   * `({basename(cwd)}) {title} [{role}] [{state}]`. A null/empty `cwd`
   * drops the `(...)` segment entirely (no empty parens). The `[{role}]`
   * pill is dropped when `plan_verb` is NULL (non-planctl session), so
   * the line falls back to `({cwd}) {title} [{state}]`. This — together
   * with `emitFrameIfChanged` — defines which column moves can reframe
   * the page.
   */
  function projectRow(row: Record<string, unknown>): string {
    const title = seg(row.title);
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
    const role = planVerbLabel(row.plan_verb);
    const roleSeg = role == null ? "" : ` [${role}]`;
    return `${cwdSeg}${title}${roleSeg} [${seg(row.state)}]`;
  }

  /**
   * Project the frozen page into the rendered body (no leading `---`), in
   * server-sent order. Renders as one `projectRow` line per row, joined by
   * newlines. No quoting — plain bracket text, mirroring `scripts/epics.ts`.
   */
  function renderBody(): string {
    if (order.length === 0) {
      return "";
    }
    return order
      .map((id) => projectRow(byId.get(id) ?? { [pk]: id }))
      .join("\n");
  }

  // Per-frame sidecar files: the latest emitted frame is mirrored to /tmp so it
  // can be inspected out-of-band. Per-pid so concurrent runs don't collide;
  // overwritten each frame (always the most recently printed frame).
  const stateSidecar = `/tmp/keeper-jobs.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-jobs.${process.pid}.frame.txt`;
  const diffSidecar = `/tmp/keeper-jobs.${process.pid}.diff.txt`;
  // Internal scratch path for the previous frame text — fed to `diff -u` as
  // its "before" file. Overwritten each tick; not surfaced in the meta note.
  const prevFrameTmp = `/tmp/keeper-jobs.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame (index +
  // per-frame sidecar paths). Only written in `--clear` mode; accumulates
  // across the session so every past frame remains inspectable.
  const metaSidecar = `/tmp/keeper-jobs.${process.pid}.meta.txt`;
  // In-memory copy of the last emitted frame text, used as the "before" side
  // of the per-frame unified diff. `null` until the first frame lands
  // (sentinel written instead).
  let lastFrameText: string | null = null;

  /**
   * Mirror the just-emitted frame to its three sidecar files and print a
   * `...`-fenced note with their paths (a "meta message", distinct from the
   * server `meta` staleness frame). `stateSidecar` gets the full JSON state
   * the frame was built from — the ordered page rows; `frameSidecar` gets
   * the rendered frame text itself; `diffSidecar` gets `diff -u prev current`
   * against the previous emit (or a sentinel on the first frame). The system
   * `diff -u` exits 1 when files differ — expected here (we only get here
   * when the body changed), so we ignore the exit code and take stdout.
   * Best-effort: a /tmp write failure logs a warning and never wedges the
   * stream.
   */
  function writeSidecars(frameText: string): void {
    // In --clear mode each frame's sidecars are indexed so past frames persist;
    // in default mode the three static paths are overwritten each frame.
    const sState = clearMode
      ? `/tmp/keeper-jobs.${process.pid}.state.${frameCount}.json`
      : stateSidecar;
    const sFrame = clearMode
      ? `/tmp/keeper-jobs.${process.pid}.frame.${frameCount}.txt`
      : frameSidecar;
    const sDiff = clearMode
      ? `/tmp/keeper-jobs.${process.pid}.diff.${frameCount}.txt`
      : diffSidecar;
    const state = order.map((id) => byId.get(id) ?? { [pk]: id });
    try {
      writeFileSync(sState, `${JSON.stringify(state, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      log(`# warn: sidecar write failed: ${(err as Error).message}`);
    }
    let diffText: string;
    if (lastFrameText == null) {
      diffText = "# first frame — no previous to diff against\n";
    } else {
      try {
        writeFileSync(prevFrameTmp, `${lastFrameText}\n`);
        const proc = Bun.spawnSync({
          cmd: ["diff", "-u", prevFrameTmp, sFrame],
        });
        diffText = proc.stdout.toString();
        if (diffText.length === 0) {
          diffText = "# diff: no textual difference\n";
        }
      } catch (err) {
        diffText = `# diff failed: ${(err as Error).message}\n`;
      }
    }
    try {
      writeFileSync(sDiff, diffText);
    } catch (err) {
      log(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    if (clearMode) {
      try {
        appendFileSync(
          metaSidecar,
          `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
        );
      } catch (err) {
        log(`# warn: meta write failed: ${(err as Error).message}`);
      }
    }
    lastFrameText = frameText;
    log("...");
    log(`state: ${sState}`);
    log(`frame: ${sFrame}`);
    log(`diff: ${sDiff}`);
    if (clearMode) {
      log(`meta: ${metaSidecar}`);
    }
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
    frameCount += 1;
    if (clearMode) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
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

  // Build the optional jobs-state filter from the CLI flags. Filtering in SQL
  // — not after the fetch — keeps LIMIT counting matching rows (so the page is
  // a true top-N of the filtered set, never short) and makes `result.total` /
  // `meta` describe exactly the set we render. Default (no flag): send NO
  // state filter, so the server's default scope applies and the page shows
  // only LIVE jobs (working + stopped); pass `--state <s>` (e.g. ended) or
  // `--state-ne <s>` to see terminal states.
  const filter: { filter?: Record<string, FilterValue> } =
    values.state !== undefined
      ? { filter: { state: values.state } }
      : values["state-ne"] !== undefined
        ? { filter: { state: { ne: values["state-ne"] } } }
        : {};
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

#!/usr/bin/env bun
/**
 * keeper-frames — a primitive "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`). Where `keeper-subscribe.ts` is a raw frame
 * tap, this script renders a *page of jobs as a frame* and reprints a fresh
 * frame every time the visible projection changes.
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
 * Like its sibling it reuses `src/protocol.ts` (`encodeFrame` to write,
 * `LineBuffer` to de-frame) and `resolveSockPath()` so it stays a faithful
 * mirror of the contract, and it honors the read-only fence: it only ever sends
 * `query` / `unsubscribe`.
 *
 * Usage:
 *   bun scripts/keeper-frames.ts [--collection <name>] [--sock <path>]
 *
 *   --collection <name>  Collection to page (jobs|epics|tasks; default jobs).
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

const HELP = `keeper-frames — primitive list UI over the keeper subscribe server

Usage: bun scripts/keeper-frames.ts [--collection <name>] [--sock <path>] [--state <s> | --state-ne <s>]

  --collection <n> Collection to page (jobs|epics|tasks; default jobs)
  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --state <s>      Filter to jobs whose state equals <s> (e.g. working)
  --state-ne <s>   Filter to jobs whose state is NOT <s> (e.g. ended)
                   (--state and --state-ne are mutually exclusive; default: no filter)
                   (--state/--state-ne are jobs-only; ignored for epics/tasks)
  --help           Show this help

Renders a 10-row page of the chosen collection as a YAML stream: one frame per
change, each frame a YAML document (--- separated) of collapsed row strings. The
render is collection-appropriate:
  jobs  → {basename(cwd)} · {title} · {state}
  epics → {basename(project_dir)} · #{epic_number} · {title} · {status}
  tasks → {epic_id} · #{task_number} · {title} · {status}
The page is refetched on every change signal and on a steady poll, so it always
shows the current top-N; a new frame prints only when the rendered output
changes. Every emitted frame is also mirrored to two /tmp sidecar files (full
JSON state + rendered frame), whose paths print in a ...-fenced note.
`;

/** Per-collection primary-key column used as the page index key. */
const PK_BY_COLLECTION: Record<string, string> = {
  jobs: "job_id",
  epics: "epic_id",
  tasks: "task_id",
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

  /**
   * Collapse one full row to its display string, collection-aware:
   *   jobs  → `{basename(cwd)} · {title} · {state}`
   *   epics → `{basename(project_dir)} · #{epic_number} · {title} · {status}`
   *   tasks → `{epic_id} · #{task_number} · {title} · {status}`
   * A null/absent segment projects to empty (no basename of nothing). This is
   * the SOLE place a row's columns are read for display — so it alone defines
   * which column moves can reframe (see `emitFrameIfChanged`).
   */
  function projectRow(row: Record<string, unknown>): string {
    const seg = (v: unknown) => (v == null ? "" : String(v));
    const title = seg(row.title);
    if (collection === "epics") {
      const dir =
        row.project_dir == null ? "" : basename(String(row.project_dir));
      return `${dir} · #${seg(row.epic_number)} · ${title} · ${seg(row.status)}`;
    }
    if (collection === "tasks") {
      return `${seg(row.epic_id)} · #${seg(row.task_number)} · ${title} · ${seg(row.status)}`;
    }
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    return `${cwd} · ${title} · ${seg(row.state)}`;
  }

  /**
   * Project the frozen page into a YAML document body (no leading `---`): a flat
   * sequence of one collapsed string per row (see `projectRow`), in server-sent
   * order. Strings carrying `·` auto-single-quote through `yamlScalar`.
   */
  function renderBody(): string {
    if (order.length === 0) {
      return "[]"; // empty page → an empty YAML sequence
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
    if (queryInFlight) {
      refetchDirty = true;
      return;
    }
    queryInFlight = true;
    socket.write(encodeFrame(query));
  }

  const buffer = new LineBuffer();

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
        // A bad_frame / unknown_collection on our own query is terminal.
        socket.end();
        process.exit(1);
      }
    }
  }

  // Build the optional `state` filter from the CLI flags. Filtering in SQL —
  // not after the fetch — keeps LIMIT counting matching rows (so the page is a
  // true top-N of the filtered set, never short) and makes `result.total` /
  // `meta` describe exactly the set we render. Default: no filter (every job).
  // The `state` filter is jobs-only — epics/tasks have no `state` column, so a
  // state filter would be a no-op key server-side; only attach it for jobs.
  const stateFilter =
    collection === "jobs"
      ? values.state !== undefined
        ? { filter: { state: values.state } }
        : values["state-ne"] !== undefined
          ? { filter: { state: { ne: values["state-ne"] } } }
          : {}
      : {};
  const query: QueryFrame = {
    type: "query",
    collection,
    id: "frames",
    limit: PAGE_LIMIT,
    ...stateFilter,
  };

  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      open(sock) {
        // First fetch, then start the steady-poll backstop. Both go through the
        // same coalescing path so the poll never races a pending query.
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
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        process.exit(gotResult ? 0 : 1);
      },
      error(_sock, err) {
        die(`socket error: ${err.message}`);
      },
    },
  }).catch((err: Error) => {
    die(
      `could not connect to ${sockPath}: ${err.message}\n` +
        `  is keeperd running? (KEEPER_SOCK overrides the path)`,
    );
  });

  // Clean unsubscribe + exit on Ctrl-C, so the server drops our subscription.
  process.on("SIGINT", () => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    try {
      socket.write(encodeFrame({ type: "unsubscribe", id: "frames" }));
      socket.end();
    } catch {
      // socket already gone — nothing to release
    }
    process.exit(0);
  });
}

await main();

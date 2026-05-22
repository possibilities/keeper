#!/usr/bin/env bun
/**
 * keeper-subscribe — a hand client for the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`). Exercises the IPC API end to end: connect to
 * the socket, send one `query` frame, print the `result` page (with its
 * filtered-set `total`), then stream the `patch` frames that arrive as the
 * watched rows advance plus the `meta` frames that signal the filtered set's
 * count/membership moved — until you Ctrl-C.
 *
 * This is the FIRST out-of-test consumer of the wire protocol. It deliberately
 * reuses the same `src/protocol.ts` codec the server and the integration test
 * use (`encodeFrame` to write, `LineBuffer` to de-frame), and the same
 * `resolveSockPath()` / `KEEPER_SOCK` precedence as the daemon — so it stays a
 * faithful mirror of the contract rather than a parallel reimplementation.
 *
 * It honors the read-only fence: it only ever sends `query` / `unsubscribe`
 * frames. There is no write path through the socket and this script adds none.
 *
 * Usage:
 *   bun scripts/keeper-subscribe.ts [options]
 *
 * Options:
 *   --collection <name>   Collection to page: jobs (default), epics, or tasks.
 *   --filter <key=value>  Exact-match filter; repeatable. Unknown keys are
 *                         ignored server-side (forward-compat).
 *                           jobs:  state, cwd, job_id
 *                           epics: status, project_dir, epic_id
 *                           tasks: status, target_repo, epic_id, task_id
 *   --sort <col[:dir]>    Sort column and direction (asc|desc).
 *                         Default server-side: updated_at desc.
 *                           jobs:  updated_at, created_at, last_event_id,
 *                                  job_id, state
 *                           epics: updated_at, last_event_id, epic_id,
 *                                  epic_number, status
 *                           tasks: updated_at, last_event_id, task_id,
 *                                  task_number, status
 *   --limit <n>           Page size.
 *   --offset <n>          Page offset.
 *   --sock <path>         Socket path override (else $KEEPER_SOCK, else the
 *                         ~/.local/state/keeper/keeperd.sock default).
 *   --once                Print the result page and exit; skip the live watch.
 *   --json                Emit raw frames as NDJSON instead of the table view.
 *   --help                Show this help.
 *
 * Examples:
 *   bun scripts/keeper-subscribe.ts
 *   bun scripts/keeper-subscribe.ts --filter state=working --sort created_at:asc
 *   bun scripts/keeper-subscribe.ts --filter job_id=sess-123 --once
 *   bun scripts/keeper-subscribe.ts --json | jq .
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type QuerySort,
  type ServerFrame,
} from "../src/protocol";

const HELP = `keeper-subscribe — client for the keeper UDS subscribe server

Usage: bun scripts/keeper-subscribe.ts [options]

  --collection <name>   Collection to page: jobs (default), epics, or tasks
  --filter <key=value>  Exact-match filter; repeatable
                          jobs:  state, cwd, job_id
                          epics: status, project_dir, epic_id
                          tasks: status, target_repo, epic_id, task_id
  --sort <col[:dir]>    Sort column and direction (asc|desc); default updated_at desc
                          jobs:  updated_at, created_at, last_event_id, job_id, state
                          epics: updated_at, last_event_id, epic_id, epic_number, status
                          tasks: updated_at, last_event_id, task_id, task_number, status
  --limit <n>           Page size
  --offset <n>          Page offset
  --sock <path>         Socket path override ($KEEPER_SOCK / default otherwise)
  --once                Print the result page and exit; skip the live watch
  --json                Emit raw frames as NDJSON instead of the table view
  --help                Show this help

Examples:
  bun scripts/keeper-subscribe.ts --collection epics --once
  bun scripts/keeper-subscribe.ts --collection tasks --filter epic_id=fn-1 --sort task_number:asc
`;

function die(message: string): never {
  process.stderr.write(`keeper-subscribe: ${message}\n`);
  process.exit(2);
}

/** Parse a `--sort col[:dir]` value into a QuerySort, validating `dir`. */
function parseSort(raw: string): QuerySort {
  const [column, dir] = raw.split(":", 2);
  if (!column) {
    die(`--sort needs a column (got "${raw}")`);
  }
  if (dir !== undefined && dir !== "asc" && dir !== "desc") {
    die(`--sort dir must be "asc" or "desc" (got "${dir}")`);
  }
  return dir ? { column, dir } : { column };
}

/** Parse repeatable `--filter key=value` flags into the wire filter map. */
function parseFilters(raw: string[]): Record<string, string | number> {
  const filter: Record<string, string | number> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      die(`--filter must be key=value (got "${entry}")`);
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    // Numeric-looking values bind as numbers; everything else as a string.
    // (The protocol allows `string | number`; an exact int match wants a number.)
    const asNum = Number(value);
    filter[key] = value !== "" && Number.isFinite(asNum) ? asNum : value;
  }
  return filter;
}

/** Render a row as `key=value` pairs on one line, in column order if known. */
function formatRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${v ?? "∅"}`)
    .join("  ");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      collection: { type: "string", default: "jobs" },
      filter: { type: "string", multiple: true, default: [] },
      sort: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      sock: { type: "string" },
      once: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();

  const query: QueryFrame = {
    type: "query",
    collection: values.collection ?? "jobs",
    id: "sub1",
  };
  if (values.sort) {
    query.sort = parseSort(values.sort);
  }
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 0) {
      die(`--limit must be a non-negative integer (got "${values.limit}")`);
    }
    query.limit = n;
  }
  if (values.offset !== undefined) {
    const n = Number(values.offset);
    if (!Number.isInteger(n) || n < 0) {
      die(`--offset must be a non-negative integer (got "${values.offset}")`);
    }
    query.offset = n;
  }
  const filters = parseFilters(values.filter ?? []);
  if (Object.keys(filters).length > 0) {
    query.filter = filters;
  }

  const json = values.json ?? false;
  const once = values.once ?? false;
  const log = (s: string) => process.stdout.write(`${s}\n`);

  // De-frame inbound NDJSON with the SAME LineBuffer the server uses, so
  // arbitrary chunk boundaries reassemble into whole frames.
  const buffer = new LineBuffer();
  let gotResult = false;

  function handleFrame(frame: ServerFrame): void {
    if (json) {
      // Raw passthrough: one frame per line, exactly as received.
      log(JSON.stringify(frame));
    } else if (frame.type === "result") {
      log(
        `── result  collection=${frame.collection}  rev=${frame.rev}  rows=${frame.rows.length} of ${frame.total}` +
          (frame.id ? `  id=${frame.id}` : ""),
      );
      for (const row of frame.rows) {
        log(`  ${formatRow(row)}`);
      }
      if (!once) {
        log(`── watching for patches + meta (Ctrl-C to stop) ──`);
      }
    } else if (frame.type === "patch") {
      log(`◆ patch  rev=${frame.rev}  ${formatRow(frame.row)}`);
    } else if (frame.type === "meta") {
      log(`▲ meta  rev=${frame.rev}  total=${frame.total}`);
    } else if (frame.type === "error") {
      log(
        `✗ error  code=${frame.code}  rev=${frame.rev}` +
          (frame.collection ? `  collection=${frame.collection}` : "") +
          `\n  ${frame.message}`,
      );
    }

    if (frame.type === "result") {
      gotResult = true;
      if (once) {
        socket.end();
        process.exit(0);
      }
    }
    // A `bad_frame` / `unknown_collection` error on our own query is terminal —
    // there's nothing to watch. Exit non-zero so callers/CI notice.
    if (frame.type === "error" && !gotResult) {
      socket.end();
      process.exit(1);
    }
  }

  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      open(sock) {
        if (!json) {
          log(`connected: ${sockPath}`);
        }
        sock.write(encodeFrame(query));
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
        if (!json) {
          log("── server closed the connection ──");
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

  // Clean unsubscribe + exit on Ctrl-C, so the server drops our subscription
  // instead of discovering the dead socket on its next write.
  process.on("SIGINT", () => {
    try {
      socket.write(encodeFrame({ type: "unsubscribe", id: "sub1" }));
      socket.end();
    } catch {
      // socket already gone — nothing to release
    }
    process.exit(0);
  });
}

// Top-level await is fine under Bun; the `await Bun.connect` above lives inside
// `main`, so mark main async and run it.
await main();

#!/usr/bin/env bun
/**
 * keeper-frames — a primitive "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`). Where `keeper-subscribe.ts` is a raw frame
 * tap, this script renders a *page of jobs as a frame* and reprints a fresh
 * frame every time the visible projection changes.
 *
 * It opens one `query` for a 10-row page of `jobs`, holds that page's row SET
 * (frozen membership — rows never enter/leave a live page), and renders it as a
 * YAML stream: each frame is a YAML document (leading `---`) listing every job
 * as `{ name, state }`. As `patch` frames advance individual rows, the page is
 * updated in place and a NEW frame is printed — but ONLY when the rendered
 * name/state projection actually changed, so a `last_event_id`-only bump (no
 * visible delta) prints nothing.
 *
 * The `meta` (total/membership-staleness) signal is rendered as a SEPARATE
 * "temporary frame": a `...`-fenced comment block, distinct from the `---` job
 * frames, that just notes the set changed underneath the frozen page. It is not
 * folded into the list — frozen membership means the page does not reflow.
 *
 * Like its sibling it reuses `src/protocol.ts` (`encodeFrame` to write,
 * `LineBuffer` to de-frame) and `resolveSockPath()` so it stays a faithful
 * mirror of the contract, and it honors the read-only fence: it only ever sends
 * `query` / `unsubscribe`.
 *
 * NOTE: the `jobs` collection has no `name` column; "name" is the `job_id`
 * (the Claude Code session id), which is the page's primary key.
 *
 * Usage:
 *   bun scripts/keeper-frames.ts [--sock <path>]
 *
 *   --sock <path>   Socket path override (else $KEEPER_SOCK, else the
 *                   ~/.local/state/keeper/keeperd.sock default).
 *   --help          Show this help.
 */

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

const HELP = `keeper-frames — primitive jobs-list UI over the keeper subscribe server

Usage: bun scripts/keeper-frames.ts [--sock <path>]

  --sock <path>   Socket path override ($KEEPER_SOCK / default otherwise)
  --help          Show this help

Renders a 10-row page of jobs as a YAML stream: one frame per change, each frame
a YAML document (--- separated) of { name, state } objects. The total/membership
"meta" signal prints as a separate ...-fenced note (the frozen page never reflows).
`;

function die(message: string): never {
  process.stderr.write(`keeper-frames: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);

  // The frozen page, in server-sent order, plus a by-id index. The order array
  // fixes render order at result time; the map holds the live cells that
  // `patch` frames advance. `name` is the pk (`job_id`); `state` is the cell we
  // render and diff frames on.
  const order: string[] = [];
  const byId = new Map<string, { name: string; state: string }>();
  // The last main frame's body, so a patch that doesn't move any rendered
  // name/state prints nothing (dedupe `last_event_id`-only bumps).
  let lastBody: string | null = null;
  let gotResult = false;

  /** Project the frozen page into a YAML document body (no leading `---`). */
  function renderBody(): string {
    if (order.length === 0) {
      return "[]"; // empty page → an empty YAML sequence
    }
    return order
      .map((id) => {
        const row = byId.get(id);
        return `- name: ${row?.name ?? id}\n  state: ${row?.state ?? "?"}`;
      })
      .join("\n");
  }

  /** Print a new job frame iff the rendered projection moved. */
  function emitFrameIfChanged(): void {
    const body = renderBody();
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    log("---");
    log(body);
  }

  const buffer = new LineBuffer();

  function handleFrame(frame: ServerFrame): void {
    if (frame.type === "result") {
      order.length = 0;
      byId.clear();
      for (const row of frame.rows) {
        const id = String(row.job_id);
        order.push(id);
        byId.set(id, { name: id, state: String(row.state ?? "?") });
      }
      gotResult = true;
      // Force the first frame even if the page is empty.
      lastBody = null;
      emitFrameIfChanged();
    } else if (frame.type === "patch") {
      const id = String(frame.row.job_id);
      const existing = byId.get(id);
      // Frozen membership: a patch only ever updates a row already in the page.
      if (existing) {
        byId.set(id, { name: id, state: String(frame.row.state ?? "?") });
        emitFrameIfChanged();
      }
    } else if (frame.type === "meta") {
      // Temporary frame: a separate ...-fenced note, NOT a job frame. The set
      // changed underneath the frozen page (total/membership moved); the list
      // above is intentionally not reflowed.
      log("...");
      log(
        `# meta: filtered set changed — now ${frame.total} job(s) match` +
          ` (page shows ${order.length}), rev ${frame.rev}`,
      );
      log("...");
    } else if (frame.type === "error") {
      log(`# error ${frame.code} (rev ${frame.rev}): ${frame.message}`);
      if (!gotResult) {
        // A bad_frame / unknown_collection on our own query is terminal.
        socket.end();
        process.exit(1);
      }
    }
  }

  const query: QueryFrame = {
    type: "query",
    collection: "jobs",
    id: "frames",
    limit: PAGE_LIMIT,
  };

  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      open(sock) {
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

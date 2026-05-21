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
 * as a single collapsed string — `{basename(cwd)}·{title}·{state}`. As `patch`
 * frames advance individual rows, the page is updated in place and a NEW frame
 * is printed whenever the RENDERED page changes. A patch carries the full row,
 * but only the columns that surface in the projection reframe: a move in
 * `last_event_id` / `pid` / `updated_at` re-renders to the same string and emits
 * nothing. The rendered output — not internal row churn — is the sole frame
 * trigger, enforced by routing every emit through `emitFrameIfChanged`.
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
 * Usage:
 *   bun scripts/keeper-frames.ts [--sock <path>]
 *
 *   --sock <path>   Socket path override (else $KEEPER_SOCK, else the
 *                   ~/.local/state/keeper/keeperd.sock default).
 *   --help          Show this help.
 */

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

const HELP = `keeper-frames — primitive jobs-list UI over the keeper subscribe server

Usage: bun scripts/keeper-frames.ts [--sock <path>]

  --sock <path>   Socket path override ($KEEPER_SOCK / default otherwise)
  --help          Show this help

Renders a 10-row page of jobs as a YAML stream: one frame per change, each frame
a YAML document (--- separated) of collapsed job strings ({basename(cwd)}·{title}
·{state}). A new frame prints only when the rendered output changes. The total/
membership "meta" signal prints as a separate ...-fenced note (the frozen page
never reflows).
`;

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
  // Bare scalar only when it can't be mistaken for YAML syntax; otherwise quote
  // (single-quote, doubling embedded quotes — the YAML escape for `'`).
  if (s !== "" && /^[A-Za-z0-9_./@:+-]+$/.test(s) && !/^[-:?]/.test(s)) {
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
  // fixes render order at result time; the map holds the full live rows that
  // `patch` frames advance, keyed by pk (`job_id`).
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  // The last frame's body, so a byte-identical re-send prints nothing.
  let lastBody: string | null = null;
  let gotResult = false;

  /**
   * Collapse one full job row to its display string: `{basename(cwd)}·{title}·
   * {state}`. A null/absent `cwd` or `title` projects to an empty segment (no
   * basename of nothing). This is the SOLE place a row's columns are read for
   * display — so it alone defines which column moves can reframe (see
   * `emitFrameIfChanged`).
   */
  function projectRow(row: Record<string, unknown>): string {
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    const title = row.title == null ? "" : String(row.title);
    const state = row.state == null ? "" : String(row.state);
    return `${cwd}·${title}·${state}`;
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
      .map((id) => `- ${yamlScalar(projectRow(byId.get(id) ?? { job_id: id }))}`)
      .join("\n");
  }

  /**
   * Print a new job frame iff the rendered projection moved. This byte-compare
   * on `renderBody()` output is the CONTRACT: a frame is emitted only when the
   * rendered text changes — internal row churn that doesn't surface in
   * `projectRow` is invisible by design, and stays so as the projection grows.
   * Every emit routes through here; nothing prints a job frame directly.
   */
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
        byId.set(id, row);
      }
      gotResult = true;
      // Force the first frame even if the page is empty.
      lastBody = null;
      emitFrameIfChanged();
    } else if (frame.type === "patch") {
      const id = String(frame.row.job_id);
      // Frozen membership: a patch only ever updates a row already in the page.
      // The full row is stored, but emitFrameIfChanged reframes only if the
      // projected string moved — an unprojected column change prints nothing.
      if (byId.has(id)) {
        byId.set(id, frame.row);
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

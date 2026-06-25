/**
 * Shared one-shot UDS client helpers for the keeper CLI surfaces that need a
 * read-then-exit round-trip against the daemon's subscribe socket — distinct
 * from the never-exiting `subscribeCollection` loop (`src/readiness-client.ts`),
 * which reconnects forever and is built for live sidecar UIs.
 *
 * `roundTrip` opens one fresh `Bun.connect` UDS connection, writes a single
 * frame, awaits the server frame whose `id` matches, and closes. `queryCollection`
 * wraps it for the common case (one `query` frame → decoded rows). `sendControlRpc`
 * wraps it for the control-RPC case (one `rpc` frame → print value + exit).
 *
 * Transport-only: no bun:sqlite, no fold, no synthetic events. Consumers
 * (`cli/autopilot.ts` control subcommands, `cli/dispatch.ts` collection reads)
 * import from here rather than hand-rolling their own connect loop.
 */

import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ResultFrame,
  type Row,
  type ServerFrame,
} from "../src/protocol";

/**
 * Hard upper bound on how long a one-shot round-trip waits for the matching
 * server frame after a successful connect. 5s is generous; a healthy daemon
 * answers in sub-ms on local UDS.
 */
export const RESPONSE_TIMEOUT_MS = 5000;

/**
 * Conservative ceiling (bytes) on an encoded control frame written in one shot.
 * The macOS UDS socket-send buffer (`SO_SNDBUF`) is ~8 KiB; a frame over it leans
 * on Bun's partial-write path (oven-sh/bun#32087) and silently HANGS — the worst
 * possible failure mode for a control RPC. We reject above this bound BEFORE
 * writing so an oversized frame fails LOUDLY and actionably instead. Bulk payloads
 * (e.g. a handoff brief) must ride through the filesystem, not the wire — see
 * `cli/handoff.ts`'s doc-spill.
 */
export const MAX_CONTROL_FRAME_BYTES = 7 * 1024;

/**
 * One round-trip on a fresh UDS connection. Opens, writes the frame, awaits
 * the server frame whose `id === matchId`, closes. Resolves with the matching
 * frame; rejects on connect-fail, transport error, malformed frame, server
 * close before reply, or `RESPONSE_TIMEOUT_MS` elapsing post-connect.
 */
export async function roundTrip(
  sockPath: string,
  send: ClientFrame,
  matchId: string,
): Promise<ServerFrame> {
  // Encode once and reject an oversized frame BEFORE opening the connection:
  // a frame over the smallest common `SO_SNDBUF` would silently hang on write
  // (oven-sh/bun#32087). Converting that into a loud, actionable error is the
  // whole point of the guard — bulk payloads must ride a file, not the wire.
  const encoded = encodeFrame(send);
  const encodedBytes = Buffer.byteLength(encoded, "utf8");
  if (encodedBytes > MAX_CONTROL_FRAME_BYTES) {
    return Promise.reject(
      new Error(
        `control frame too large: ${encodedBytes} bytes exceeds the ${MAX_CONTROL_FRAME_BYTES}-byte safe send-buffer limit (id ${matchId}); pass bulk payloads via a file, not inline in the frame`,
      ),
    );
  }

  return new Promise<ServerFrame>((resolve, reject) => {
    const buffer = new LineBuffer();
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    const settle = (err: Error | null, frame: ServerFrame | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      if (err) {
        reject(err);
      } else if (frame) {
        resolve(frame);
      } else {
        reject(new Error("internal: settle called with neither err nor frame"));
      }
    };

    const timeout = setTimeout(() => {
      settle(
        new Error(
          `no response from daemon within ${RESPONSE_TIMEOUT_MS}ms (id ${matchId})`,
        ),
        null,
      );
    }, RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          s.write(encoded);
        },
        data(_s, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            settle(
              new Error(`protocol error: ${(err as Error).message}`),
              null,
            );
            return;
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            let frame: ServerFrame;
            try {
              frame = JSON.parse(line) as ServerFrame;
            } catch (err) {
              settle(
                new Error(`malformed server frame: ${(err as Error).message}`),
                null,
              );
              return;
            }
            if ((frame as { id?: string }).id !== matchId) {
              continue;
            }
            settle(null, frame);
            return;
          }
        },
        close() {
          settle(
            new Error(
              `daemon closed connection before responding (id ${matchId})`,
            ),
            null,
          );
        },
        error(_s, err) {
          settle(new Error(`socket error: ${err.message}`), null);
        },
      },
    }).catch((err: Error) => {
      settle(
        new Error(`failed to connect to ${sockPath}: ${err.message}`),
        null,
      );
    });
  });
}

/**
 * One-shot read of a collection: send a single `query` frame and resolve with
 * the decoded rows, then close (no lingering subscription). `filter` resolves
 * against the collection's declared filters server-side. Rejects (via
 * `roundTrip`) on transport failure, or throws when the daemon answers with an
 * `error` frame / an unexpected frame type.
 *
 * Use this — never `subscribeCollection` — when a CLI needs read-then-exit
 * semantics: `subscribeCollection` reconnects forever and never settles.
 */
export async function queryCollection<R extends Row = Row>(
  sockPath: string,
  collection: string,
  filter?: QueryFrame["filter"],
): Promise<R[]> {
  const matchId = crypto.randomUUID();
  const frame: QueryFrame = {
    type: "query",
    id: matchId,
    collection,
    // `limit: 0` is the explicit "no row cap" sentinel — a one-shot read wants
    // the full filtered set, not the server's default page.
    limit: 0,
    ...(filter === undefined ? {} : { filter }),
  };
  const response = await roundTrip(sockPath, frame, matchId);
  if (response.type === "result") {
    return (response as ResultFrame<R>).rows;
  }
  if (response.type === "error") {
    throw new Error(
      `daemon error querying '${collection}': ${response.code}: ${response.message}`,
    );
  }
  throw new Error(
    `unexpected frame type querying '${collection}': ${response.type}`,
  );
}

/**
 * Send one control RPC and exit. On `rpc_result` writes the value as one
 * JSON line to stdout and exits 0; on `error` / connect-fail / timeout
 * surfaces the reason via `die` (exit 1).
 *
 * `die` is injectable so each CLI surface keeps its own error prefix; it
 * defaults to a generic `keeper:`-prefixed exit-1 sink.
 */
export async function sendControlRpc(
  sockPath: string,
  frame: ClientFrame,
  matchId: string,
  die: (message: string) => never = defaultDie,
): Promise<void> {
  let response: ServerFrame;
  try {
    response = await roundTrip(sockPath, frame, matchId);
  } catch (err) {
    die((err as Error).message);
  }
  if (response.type === "rpc_result") {
    process.stdout.write(`${JSON.stringify(response.value)}\n`);
    process.exit(0);
  }
  if (response.type === "error") {
    die(`server error ${response.code}: ${response.message}`);
  }
  die(`unexpected frame type: ${response.type}`);
}

function defaultDie(message: string): never {
  process.stderr.write(`keeper: ${message}\n`);
  process.exit(1);
}

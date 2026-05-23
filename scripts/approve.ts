#!/usr/bin/env bun
/**
 * approve — thin RPC client over the keeper subscribe socket. Lands one
 * `set_approval` call and exits. The FIRST concrete RPC client; the
 * connection / framing / id-correlation pattern here is the template for
 * future single-shot CLIs.
 *
 * Unlike the example `scripts/autopilot.ts` / `scripts/epics.ts` /
 * `scripts/jobs.ts` clients, this CLI is short-lived and read/write-mixed:
 * it opens one `Bun.connect`, sends ONE `rpc` frame, awaits the matching
 * `rpc_result` or `error` by `id`, prints the result, and exits. No
 * subscription, no poll, no reconnect — if the daemon is down, the
 * `Bun.connect` rejects (typically ECONNREFUSED) and the CLI fails fast
 * (`exit 1`). A user-visible "daemon not running" message is more useful
 * than a backoff loop for a one-shot mutation.
 *
 * Wire round-trip (mirrors `RpcFrame` / `RpcResultFrame` / `ErrorFrame` in
 * `src/protocol.ts`):
 *
 *   client → server: { type: "rpc", id, method: "set_approval", params: ... }
 *   server → client: { type: "rpc_result", id, rev, value }   on success
 *                  | { type: "error",      id, rev, code, message }  on failure
 *
 * The `id` is a fresh `crypto.randomUUID()` per invocation — a single-shot
 * client doesn't multiplex, but echoing the id on the response is part of
 * the protocol contract and the dispatcher's defensive checks rely on it.
 *
 * Usage:
 *   bun scripts/approve.ts <epic_id> <task_key> approve|reject|clear
 *   bun scripts/approve.ts --sock <path> <epic_id> <task_key> approve
 *
 *   <epic_id>    Planctl epic id (e.g. `fn-581-server-mutation-rpcs-and-autopilot`).
 *   <task_key>   Task key — usually a task slug (`<epic_id>.<n>`) or the
 *                virtual `close:<epic_id>` row used by the autopilot for
 *                the per-epic close-approval pill. Opaque text to the RPC.
 *   approve|reject|clear
 *                Maps to the wire `status` field. `clear` DELETEs the row
 *                (absent row = "pending" per the schema-v12 invariant).
 *
 *   --sock <path>  Socket path override (else $KEEPER_SOCK, else the
 *                  ~/.local/state/keeper/keeperd.sock default).
 *   --help         Show this help.
 *
 * Exit codes:
 *   0 — `rpc_result` arrived; the result row (or `{ cleared: true, ... }`) is
 *       printed to stdout as a single line of JSON.
 *   1 — the daemon is down (connect failed), the server returned `error`,
 *       the response frame never arrived before the deadline, or the
 *       arguments are malformed. The human-readable reason goes to stderr.
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { encodeFrame, LineBuffer, type ServerFrame } from "../src/protocol";

/**
 * Hard upper bound on how long the CLI waits for the `rpc_result` /
 * `error` frame after a successful connect. A healthy daemon answers in
 * well under a millisecond on local UDS; 5s is generous and avoids a
 * blocked client wedging forever if the server is wedged. On timeout the
 * CLI surfaces a clear stderr message and exits 1 — never hangs silently.
 */
const RESPONSE_TIMEOUT_MS = 5000;

const HELP = `approve — thin RPC client for the keeper subscribe server's set_approval

Usage: bun scripts/approve.ts [--sock <path>] <epic_id> <task_key> <verb>

  <epic_id>    Planctl epic id
  <task_key>   Task slug (\`<epic_id>.<n>\`) or \`close:<epic_id>\` (the
               virtual per-epic close-approval row)
  <verb>       One of: approve, reject, clear

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

Examples:
  bun scripts/approve.ts fn-581-server-mutation-rpcs-and-autopilot fn-581-server-mutation-rpcs-and-autopilot.3 approve
  bun scripts/approve.ts fn-581 close:fn-581 reject
  bun scripts/approve.ts fn-581 fn-581.3 clear

On success: prints the resulting row (or { cleared: true, ... }) as JSON to
stdout and exits 0. On failure (daemon down, validation error, unknown
method, timeout): prints the reason to stderr and exits 1.
`;

function die(message: string): never {
  process.stderr.write(`approve: ${message}\n`);
  process.exit(1);
}

/** Map the CLI's user-facing verbs to the RPC's wire `status` field. */
function statusFromVerb(verb: string): "approved" | "rejected" | "clear" {
  switch (verb) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "clear":
      return "clear";
    default:
      die(`unknown verb '${verb}' (expected approve|reject|clear)`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const positionals = parsed.positionals;
  if (positionals.length !== 3) {
    die(
      `expected 3 positional args (<epic_id> <task_key> approve|reject|clear); got ${positionals.length}. Pass --help for usage.`,
    );
  }
  const [epic_id, task_key, verb] = positionals as [string, string, string];
  if (epic_id.length === 0 || task_key.length === 0) {
    die("epic_id and task_key must be non-empty");
  }
  const status = statusFromVerb(verb);

  const sockPath = parsed.values.sock ?? resolveSockPath();
  // One fresh id per invocation. The CLI is single-shot — it never
  // multiplexes — but the protocol requires a non-empty string id, and the
  // dispatcher echoes it back so we can match the response defensively.
  const rpcId = crypto.randomUUID();

  // The frame buffer + response sink are connection-scoped — a partial line
  // from a torn connection must never bleed into a follow-up read (which we
  // never do here, but the discipline matches sibling clients).
  const buffer = new LineBuffer();
  let resolved = false;
  let exitCode = 1;
  let stdoutPayload: string | null = null;

  // The single round-trip is modeled as a Promise the connect handlers settle.
  // `done` resolves on EITHER the matching response OR a transport error OR a
  // timeout — never both, and never after `resolved` flips.
  const done = new Promise<void>((resolve) => {
    const finish = (
      code: number,
      out: { stdout?: string; stderr?: string },
    ): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      exitCode = code;
      if (out.stdout) {
        stdoutPayload = out.stdout;
      }
      if (out.stderr) {
        process.stderr.write(out.stderr);
      }
      resolve();
    };

    // Hard ceiling on "we connected, but no response came". 5s is generous
    // for a local UDS round-trip; a wedged server is more useful as an
    // error message than a hang.
    const timeout = setTimeout(() => {
      finish(1, {
        stderr: `no response from daemon within ${RESPONSE_TIMEOUT_MS}ms (id ${rpcId})\n`,
      });
      try {
        sock?.end();
      } catch {
        // best-effort
      }
    }, RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          // One frame, one wait. Send and let `data` handle the response.
          s.write(
            encodeFrame({
              type: "rpc",
              id: rpcId,
              method: "set_approval",
              params: { epic_id, task_key, status },
            }),
          );
        },
        data(_s, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            finish(1, {
              stderr: `protocol error: ${(err as Error).message}\n`,
            });
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
              finish(1, {
                stderr: `malformed server frame: ${(err as Error).message}\n`,
              });
              return;
            }
            // Only the matching response settles this. A stray frame (the
            // server today never sends one without `id`-correlation in the
            // RPC path, but stay defensive) is ignored. Errors and results
            // both carry our `id`; mismatched ids are protocol violations.
            const fid = (frame as { id?: string }).id;
            if (fid !== rpcId) {
              continue;
            }
            if (frame.type === "rpc_result") {
              // Print the handler's `value` — for set_approval that's the
              // upserted row or `{ cleared: true, ... }`. One JSON line so
              // a caller pipes it cleanly into `jq` or another consumer.
              finish(0, { stdout: `${JSON.stringify(frame.value)}\n` });
              clearTimeout(timeout);
              try {
                _s.end();
              } catch {
                // best-effort
              }
              return;
            }
            if (frame.type === "error") {
              finish(1, {
                stderr: `server error ${frame.code}: ${frame.message}\n`,
              });
              clearTimeout(timeout);
              try {
                _s.end();
              } catch {
                // best-effort
              }
              return;
            }
            // Any other frame type for our id is a server bug; surface it.
            finish(1, {
              stderr: `unexpected frame type for id ${rpcId}: ${frame.type}\n`,
            });
            clearTimeout(timeout);
            try {
              _s.end();
            } catch {
              // best-effort
            }
            return;
          }
        },
        close() {
          // The server closed before we got a matching response (or after, in
          // which case `resolved` is already true and `finish` is a no-op).
          finish(1, {
            stderr: `daemon closed connection before responding (id ${rpcId})\n`,
          });
          clearTimeout(timeout);
        },
        error(_s, err) {
          finish(1, { stderr: `socket error: ${err.message}\n` });
          clearTimeout(timeout);
        },
      },
    }).catch((err: Error) => {
      // Bun.connect rejection — the most common path is "daemon not up"
      // (ECONNREFUSED on the UDS path, or ENOENT on a missing socket file).
      // Either way: fail fast with a clear stderr message.
      finish(1, {
        stderr: `failed to connect to ${sockPath}: ${err.message}\n`,
      });
      clearTimeout(timeout);
    });
  });

  await done;
  if (stdoutPayload !== null) {
    process.stdout.write(stdoutPayload);
  }
  process.exit(exitCode);
}

await main();

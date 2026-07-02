#!/usr/bin/env bun
/**
 * `keeper query <collection> [--filter k=v]... [--json]` — a thin one-shot
 * read of an allowlisted daemon collection. The agent-facing escape hatch for
 * "give me the raw rows" without the snapshot-mode TUI dance.
 *
 * Transport is `queryCollection` (`cli/control-rpc.ts`) — one `query` frame,
 * decoded rows, close. It NEVER routes through `sendControlRpc` (the write
 * path): `query` only reads.
 *
 * The collection name is validated against `QUERY_READ_ALLOWLIST`
 * (`src/collections.ts`) at PARSE time — an off-allowlist name is a usage error
 * (exit 1) that never opens a socket. `--filter k=v` (repeatable) builds the
 * server-resolved exact-match filter map; keys resolve against the collection's
 * declared filters server-side (an unknown key is ignored for forward-compat),
 * values are bound — no free-form eval, so no injection surface.
 *
 * Output (success): one `{schema_version, ok, error, data}` JSON envelope on
 * stdout where `data` is the row array; exit 0. A daemon `error` frame (or any
 * transport failure) surfaces as the SAME envelope with `ok:false` and
 * `error.{code,message,recovery}` on stdout, exit 1 (mirrors `keeper status`) —
 * never a stack trace, and never empty stdout + stderr prose.
 */

import { parseArgs } from "node:util";
import { isQueryAllowed, QUERY_READ_ALLOWLIST } from "../src/collections";
import { resolveSockPath } from "../src/db";
import type { FilterValue } from "../src/protocol";
import { queryCollection } from "./control-rpc";
import {
  emitEnvelope,
  errorEnvelope,
  RECOVERY_DAEMON_DOWN,
  successEnvelope,
} from "./envelope";

/** Envelope schema version for `keeper query`. */
export const QUERY_SCHEMA_VERSION = 1;

const ALLOWLIST_SORTED = [...QUERY_READ_ALLOWLIST].sort();

export const HELP = `keeper query — one-shot read of an allowlisted daemon collection

Usage:
  keeper query <collection> [--filter k=v]... [--json] [--sock <path>]

Reads the named collection over the daemon's subscribe socket and prints one
JSON envelope ({schema_version, ok, error, data}) where data is the row array.
A read-only round-trip — never a write.

Arguments:
  <collection>   One of the allowlisted collections (below)

Flags:
  --filter k=v   Exact-match filter (repeatable; ANDed). Keys resolve against
                 the collection's declared filters server-side
  --json         Emit JSON (default; accepted for symmetry with the viewers)
  --sock <path>  Socket override ($KEEPER_SOCK / default)
  --help         Show this help

Allowlisted collections:
  ${ALLOWLIST_SORTED.join(", ")}

Examples:
  keeper query epics --json | jq '.data[].epic_id'
  keeper query jobs --filter state=working
  keeper query dispatch_failures
`;

export interface ParsedQueryArgs {
  collection: string;
  filter: Record<string, FilterValue>;
  sock: string;
}

interface ParseFailure {
  ok: false;
  message: string;
}

interface ParseSuccess {
  ok: true;
  args: ParsedQueryArgs;
}

/**
 * Parse + validate the `keeper query` argv. The collection-name allowlist check
 * lives HERE (parse time) so an off-allowlist name fails as a usage error
 * before any socket is opened. A bare `--filter` value must be `key=value`;
 * the key may not be empty (the value may, for an exact empty-string match).
 */
export function parseQueryArgs(argv: string[]): ParseFailure | ParseSuccess {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        filter: { type: "string", multiple: true },
        sock: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (values.help === true) {
    return { ok: false, message: "__help__" };
  }

  if (positionals.length === 0) {
    return { ok: false, message: "expected a collection name" };
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      message: `expected exactly one collection (got ${positionals.length}: ${positionals.join(" ")})`,
    };
  }
  const collection = positionals[0] ?? "";
  if (!isQueryAllowed(collection)) {
    return {
      ok: false,
      message: `collection '${collection}' is not readable via 'keeper query' (allowed: ${ALLOWLIST_SORTED.join(", ")})`,
    };
  }

  const filter: Record<string, FilterValue> = {};
  const rawFilters = Array.isArray(values.filter)
    ? (values.filter as string[])
    : [];
  for (const raw of rawFilters) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      return {
        ok: false,
        message: `invalid --filter '${raw}' (expected key=value with a non-empty key)`,
      };
    }
    const key = raw.slice(0, eq);
    const val = raw.slice(eq + 1);
    filter[key] = val;
  }

  const sock =
    typeof values.sock === "string"
      ? (values.sock as string)
      : resolveSockPath();

  return { ok: true, args: { collection, filter, sock } };
}

export interface RunQueryDeps {
  /** Read a collection over the socket (injected for tests; defaults to the real transport). */
  query: (
    sock: string,
    collection: string,
    filter?: Record<string, FilterValue>,
  ) => Promise<Record<string, unknown>[]>;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  exit: (code: number) => never;
}

/**
 * Execute one query and print the JSON envelope. A `queryCollection` throw
 * (daemon `error` frame, connect-fail, timeout, malformed frame) maps to an
 * `ok:false` envelope on stdout, exit 1 — never a stack trace, never empty
 * stdout + stderr prose.
 */
export async function runQueryCommand(
  args: ParsedQueryArgs,
  deps: RunQueryDeps,
): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = await deps.query(
      args.sock,
      args.collection,
      Object.keys(args.filter).length > 0 ? args.filter : undefined,
    );
  } catch (err) {
    emitEnvelope(
      errorEnvelope(QUERY_SCHEMA_VERSION, {
        code: "query_failed",
        message: err instanceof Error ? err.message : String(err),
        recovery: RECOVERY_DAEMON_DOWN,
      }),
      deps,
    );
    return;
  }
  emitEnvelope(successEnvelope(QUERY_SCHEMA_VERSION, rows), deps);
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseQueryArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    process.stderr.write(`keeper query: ${parsed.message}\n\n`);
    process.stderr.write(HELP);
    process.exit(1);
  }

  await runQueryCommand(parsed.args, {
    query: (sock, collection, filter) =>
      queryCollection(sock, collection, filter),
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  });
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry.

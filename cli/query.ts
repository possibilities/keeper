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
import { formatPill } from "../src/readiness";
import {
  type ReadinessClientHandle,
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { queryCollection } from "./control-rpc";
import { parseOptions } from "./descriptor";
import {
  emitEnvelope,
  errorEnvelope,
  RECOVERY_DAEMON_DOWN,
  successEnvelope,
} from "./envelope";

/** Envelope schema version for `keeper query`. */
export const QUERY_SCHEMA_VERSION = 1;

/**
 * DERIVED collections `keeper query` serves that are NOT raw daemon tables: a
 * `tasks` view flattens every open epic's tasks into one row-per-task carrying
 * the plan fields PLUS the live readiness verdict (reusing `computeReadiness`
 * via the readiness subscribe, never re-derived). These bypass the
 * {@link QUERY_READ_ALLOWLIST} registry gate (they have no descriptor) but ride
 * the SAME envelope + exit model.
 */
export const VIRTUAL_QUERY_COLLECTIONS: ReadonlySet<string> = new Set([
  "tasks",
]);

/** Bounded connect deadline for the derived `tasks` readiness subscribe — a
 *  one-shot read must give up rather than reconnect forever on a down daemon. */
const TASKS_CONNECT_DEADLINE_MS = 10_000;

const ALLOWLIST_SORTED = [
  ...QUERY_READ_ALLOWLIST,
  ...VIRTUAL_QUERY_COLLECTIONS,
].sort();

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

Derived views (not raw tables):
  tasks   One row per open-epic task — epic_id, task_id, title, tier, model,
          depends_on, runtime_status, and the live readiness verdict + pill.
          Retires the 'query epics --json | jq .data[]' per-task pipeline.

Examples:
  keeper query tasks --json | jq '.data[] | {task_id, verdict}'
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
      // Derived from the pure-data descriptor (ADR 0008).
      options: parseOptions("query"),
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
  if (
    !isQueryAllowed(collection) &&
    !VIRTUAL_QUERY_COLLECTIONS.has(collection)
  ) {
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

// ---------------------------------------------------------------------------
// Derived `tasks` view — flat task rows + live readiness verdict.
// ---------------------------------------------------------------------------

/** One flat task row of the derived `tasks` view. `depends_on` is the plan
 *  dependency id list; `verdict`/`pill` are the live readiness verdict (a miss
 *  renders the inert `[blocked:unknown]`, matching the board). */
export interface TaskRow {
  epic_id: string;
  task_id: string;
  title: string | null;
  tier: string | null;
  model: string | null;
  depends_on: string[];
  runtime_status: string;
  verdict: string;
  pill: string;
}

/** The scalar `tasks` fields a `--filter k=v` may exact-match against;
 *  array/derived fields and unknown keys are ignored (forward-compat, mirroring
 *  the server-side filter gate). */
const TASK_FILTER_FIELDS: ReadonlySet<string> = new Set([
  "epic_id",
  "task_id",
  "tier",
  "model",
  "runtime_status",
  "verdict",
]);

/** Apply the query `--filter` map to the flat task rows: each scalar-field
 *  string value ANDs an exact match; non-string values and non-scalar/unknown
 *  keys are skipped. */
function applyTaskFilter(
  rows: TaskRow[],
  filter: Record<string, FilterValue>,
): TaskRow[] {
  const entries = Object.entries(filter).filter(
    (e): e is [string, string] =>
      TASK_FILTER_FIELDS.has(e[0]) && typeof e[1] === "string",
  );
  if (entries.length === 0) {
    return rows;
  }
  return rows.filter((row) =>
    entries.every(
      ([k, v]) =>
        String((row as unknown as Record<string, unknown>)[k] ?? "") === v,
    ),
  );
}

/**
 * Flatten a readiness snapshot into the `tasks` view: one row per task across
 * every (open) epic, in the snapshot's deterministic epic/task order, carrying
 * the plan fields plus the live readiness verdict from `snap.readiness.perTask`
 * (reused, NEVER re-derived). PURE — a fixture pins the shape.
 */
export function flattenTaskRows(
  snap: ReadinessClientSnapshot,
  filter: Record<string, FilterValue> = {},
): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const epic of snap.epics) {
    for (const task of epic.tasks) {
      const v = snap.readiness.perTask.get(task.task_id);
      rows.push({
        epic_id: task.epic_id ?? epic.epic_id,
        task_id: task.task_id,
        title: task.title,
        tier: task.tier,
        model: task.model,
        depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
        runtime_status: task.runtime_status,
        verdict: v?.tag ?? "unknown",
        pill: v === undefined ? "[blocked:unknown]" : formatPill(v),
      });
    }
  }
  return applyTaskFilter(rows, filter);
}

export interface RunTasksDeps {
  /** Resolve the first readiness snapshot (injected for tests). */
  fetchSnapshot: (sock: string) => Promise<ReadinessClientSnapshot>;
  writeStdout: (s: string) => void;
  exit: (code: number) => never;
}

/**
 * Execute the derived `tasks` query: resolve one readiness snapshot, flatten to
 * task rows, print the envelope. A `fetchSnapshot` throw (down daemon / fatal
 * pre-paint frame) maps to an `ok:false` envelope on stdout, exit 1 — the SAME
 * shape + exit model as the raw `runQueryCommand` path.
 */
export async function runTasksCommand(
  args: ParsedQueryArgs,
  deps: RunTasksDeps,
): Promise<void> {
  let snap: ReadinessClientSnapshot;
  try {
    snap = await deps.fetchSnapshot(args.sock);
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
  emitEnvelope(
    successEnvelope(QUERY_SCHEMA_VERSION, flattenTaskRows(snap, args.filter)),
    deps,
  );
}

/**
 * Real `fetchSnapshot`: open a bounded readiness subscribe, resolve on the FIRST
 * composite snapshot, then dispose. A pre-paint fatal (`unreachable`/`connect`)
 * rejects. A single `done` latch guards the snapshot↔fatal race. Mirrors
 * `keeper status`'s one-shot orient.
 */
function fetchFirstReadinessSnapshot(
  sock: string,
): Promise<ReadinessClientSnapshot> {
  return new Promise((resolve, reject) => {
    let done = false;
    let handle: ReadinessClientHandle | null = null;
    const dispose = (): void => {
      if (handle !== null) {
        try {
          handle.dispose();
        } catch {
          // dispose is idempotent
        }
        handle = null;
      }
    };
    handle = subscribeReadiness({
      sockPath: sock,
      idPrefix: `query-tasks-${process.pid}`,
      onSnapshot: (snap) => {
        if (done) {
          return;
        }
        done = true;
        dispose();
        resolve(snap);
      },
      onFatal: (err) => {
        if (done) {
          return;
        }
        done = true;
        dispose();
        reject(new Error(`${err.code}: ${err.message}`));
      },
      giveUpPolicy: { deadlineMs: TASKS_CONNECT_DEADLINE_MS },
    });
  });
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

  if (VIRTUAL_QUERY_COLLECTIONS.has(parsed.args.collection)) {
    await runTasksCommand(parsed.args, {
      fetchSnapshot: fetchFirstReadinessSnapshot,
      writeStdout: (s) => process.stdout.write(s),
      exit: (code) => process.exit(code),
    });
    return;
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

#!/usr/bin/env bun
/**
 * `keeper reclaim` — OFFLINE size-reclaim of the live `keeper.db` (fn-847).
 *
 * Wraps the existing `reclaimDb` (src/backup.ts: VACUUM INTO a defragmented copy
 * with `auto_vacuum=INCREMENTAL` baked + `quick_check` gate) into a single
 * guarded operator command. The live ~1.2 GB file carries the freed pages of the
 * retention shed on its freelist (an in-place online VACUUM is deliberately never
 * run — it rewrites the whole multi-GB DB under the writer lock), so this rebuild
 * is the physical reclaim, run with the daemon STOPPED.
 *
 * The op, in order:
 *   1. HARD-GUARD daemon-down — read the keeperd ownership lock (`<sock>.lock`)
 *      and, if its pid is still alive (the daemon holds the DB), REFUSE. A live
 *      daemon's open connection + the atomic swap = corruption; a concurrent
 *      writer corrupts the VACUUM INTO copy. The guard is load-bearing.
 *   2. Keep a pre-reclaim SNAPSHOT (verified `VACUUM INTO` copy) as the rollback.
 *   3. `reclaimDb` → the defragmented output (`<db>.reclaim`).
 *   4. SELF-VERIFY the output vs the source BEFORE the swap: opens clean, same
 *      schema_version, auto_vacuum=2, identical per-table row counts. A failure
 *      leaves the original DB untouched and the rollback snapshot in place.
 *   5. Atomic same-fs `mv` of the verified output over the live DB + drop the
 *      stale `-wal`/`-shm` sidecars (they belong to the OLD file).
 *
 * Producer-side: reads the source over a dedicated read-only connection, writes
 * only the output/snapshot files + the final atomic rename. Never opens a writer
 * on the live DB, mints no event, touches no projection. Re-fold determinism is
 * untouched — the rebuilt file folds byte-identical projections from the same
 * immutable `events` rows.
 *
 * NOT wired for autopilot/automation: it is an explicit operator step (the full
 * runbook — pause autopilot, bootout daemon, reclaim, bootstrap, await server-up
 * — is in `keeper reclaim --agent-help`).
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { parseArgs } from "node:util";
import {
  backupDb,
  reclaimDb,
  reclaimInstructions,
  verifyReclaim,
} from "../src/backup";
import { resolveDbPath, resolveSockPath } from "../src/db";
import { isPidAlive } from "../src/server-worker";
import { parseOptions } from "./descriptor";

export const HELP = `keeper reclaim — OFFLINE size-reclaim of the live keeper.db

Usage:
  keeper reclaim [flags]

Rebuilds keeper.db into a freelist-compacted copy (VACUUM INTO, auto_vacuum=
INCREMENTAL baked) and atomically swaps it in. The daemon MUST be stopped — a
live daemon connection racing the swap corrupts the DB, so this REFUSES while
keeperd holds the ownership lock. Keeps a pre-reclaim snapshot and self-verifies
the rebuild (opens clean, schema_version unchanged, auto_vacuum=2, identical
row counts) BEFORE the swap; on any mismatch the original DB is left untouched.

Flags:
  --db <path>          Live DB path override ($KEEPER_DB / default)
  --sock <path>        Socket path override ($KEEPER_SOCK / default) — the
                       daemon-up guard reads its '<sock>.lock'
  --dry-run            Print the operator runbook only; no snapshot, no swap
  --agent-help         Print the full operator runbook and exit
  --help, -h           Show this help

Exit codes:
  0  reclaim verified and swapped in (or --dry-run / --help / --agent-help)
  1  daemon up (refused), reclaim failed, or self-verify failed (DB untouched)
`;

export interface ParsedReclaimArgs {
  dbPath: string;
  sockPath: string;
  dryRun: boolean;
  help: boolean;
  agentHelp: boolean;
}

interface ParseFailure {
  ok: false;
  message: string;
}
interface ParseSuccess {
  ok: true;
  args: ParsedReclaimArgs;
}

export function parseReclaimArgs(argv: string[]): ParseFailure | ParseSuccess {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: argv,
      // Derived from the pure-data descriptor (ADR 0008).
      options: parseOptions("reclaim"),
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    args: {
      dbPath: typeof values.db === "string" ? values.db : resolveDbPath(),
      sockPath:
        typeof values.sock === "string" ? values.sock : resolveSockPath(),
      dryRun: values["dry-run"] === true,
      help: values.help === true,
      agentHelp: values["agent-help"] === true,
    },
  };
}

/**
 * The daemon-up guard. Mirrors {@link import("../src/server-worker").acquireLock}
 * IN REVERSE: read the keeperd ownership lock at `<sockPath>.lock`, and if its
 * recorded pid is still ALIVE, the daemon holds the DB → refuse. A missing /
 * empty / unparseable lock, or a lock whose pid is dead (stale), reads as
 * daemon-down → safe to reclaim. `isPidAlive` treats `EPERM` (a live pid owned
 * by another user) as alive, so a foreign-owned daemon still blocks.
 *
 * Returns `{ up, pid }`: `up` true means refuse; `pid` is the live holder (for
 * the refusal message) or `null`.
 */
export function daemonUp(sockPath: string): {
  up: boolean;
  pid: number | null;
} {
  const lockPath = `${sockPath}.lock`;
  if (!existsSync(lockPath)) {
    return { up: false, pid: null };
  }
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch {
    // Lock unreadable — conservatively treat as not-held (matches acquireLock's
    // unparseable-is-stale stance) so a permission quirk doesn't wedge the op.
    return { up: false, pid: null };
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { up: false, pid: null };
  }
  return isPidAlive(pid) ? { up: true, pid } : { up: false, pid: null };
}

/** Drop the stale `-wal`/`-shm` sidecars of the OLD file post-swap. */
function dropSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

interface RunDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  exit: (code: number) => never;
}

export function run(args: ParsedReclaimArgs, deps: RunDeps): void {
  const { dbPath, sockPath } = args;
  const outputPath = `${dbPath}.reclaim`;

  if (args.dryRun) {
    deps.stdout(`${reclaimInstructions(outputPath, dbPath)}\n`);
    return;
  }

  // 1. HARD-GUARD: refuse while the daemon holds the DB.
  const daemon = daemonUp(sockPath);
  if (daemon.up) {
    deps.stderr(
      `keeper reclaim: REFUSING — keeperd is up (pid ${daemon.pid} holds ${sockPath}.lock).\n` +
        "The live daemon connection racing the atomic swap would corrupt the DB.\n" +
        "Stop it first (see 'keeper reclaim --agent-help'):\n" +
        "  keeper autopilot pause && launchctl bootout gui/$(id -u)/arthack.keeperd\n",
    );
    deps.exit(1);
  }

  if (!existsSync(dbPath)) {
    deps.stderr(`keeper reclaim: source DB not found: ${dbPath}\n`);
    deps.exit(1);
  }

  let sourceBytes = 0;
  try {
    sourceBytes = statSync(dbPath).size;
  } catch {
    /* informational */
  }
  deps.stdout(`[reclaim] source: ${dbPath} (${fmtBytes(sourceBytes)})\n`);

  // 2. Pre-reclaim snapshot — the rollback until self-verify passes.
  deps.stdout("[reclaim] taking pre-reclaim snapshot (rollback) …\n");
  const snap = backupDb(dbPath);
  if (!snap.verified || snap.snapshotPath === null) {
    deps.stderr(
      `keeper reclaim: pre-reclaim snapshot FAILED (${snap.error ?? "unknown"}) — refusing to proceed without a rollback.\n`,
    );
    deps.exit(1);
  }
  deps.stdout(`[reclaim] snapshot: ${snap.snapshotPath}\n`);

  // 3. Reclaim into the output file (VACUUM INTO + auto_vacuum bake + quick_check).
  deps.stdout("[reclaim] reclaiming (VACUUM INTO + quick_check) …\n");
  const result = reclaimDb(dbPath, outputPath);
  if (!result.ok || result.outputPath === null) {
    deps.stderr(
      `keeper reclaim: reclaim FAILED (${result.error ?? "unknown"}) — DB untouched, snapshot kept at ${snap.snapshotPath}.\n`,
    );
    deps.exit(1);
  }
  deps.stdout(
    `[reclaim] output: ${result.outputPath} (${fmtBytes(result.outputBytes)}, was ${fmtBytes(result.sourceBytes)})\n`,
  );

  // 4. SELF-VERIFY before the swap — schema_version, auto_vacuum, row counts.
  deps.stdout("[reclaim] self-verifying reclaimed DB vs source …\n");
  const verify = verifyReclaim(dbPath, outputPath);
  if (!verify.ok) {
    // Leave the original DB untouched and the snapshot in place; delete the
    // unverified output so a later run isn't fooled by a stale reclaim.
    try {
      rmSync(outputPath, { force: true });
    } catch {
      /* best-effort */
    }
    deps.stderr(
      `keeper reclaim: self-verify FAILED (${verify.error ?? "unknown"}) — DB untouched, snapshot kept at ${snap.snapshotPath}.\n`,
    );
    deps.exit(1);
  }
  deps.stdout(
    `[reclaim] verify OK — schema_version=${verify.outputSchemaVersion}, auto_vacuum=${verify.outputAutoVacuum}, row counts identical.\n`,
  );

  // 5. Atomic same-fs swap + drop the stale sidecars of the OLD file.
  try {
    // Preserve the source's permission bits across the swap (reclaimDb already
    // chmod'd the output to match, but re-assert defensively).
    try {
      chmodSync(outputPath, statSync(dbPath).mode & 0o777);
    } catch {
      /* best-effort */
    }
    renameSync(outputPath, dbPath);
  } catch (err) {
    deps.stderr(
      `keeper reclaim: atomic swap FAILED (${err instanceof Error ? err.message : String(err)}) — verified output left at ${outputPath}, original DB still in place; snapshot at ${snap.snapshotPath}.\n`,
    );
    deps.exit(1);
  }
  dropSidecars(dbPath);

  const saved = sourceBytes - result.outputBytes;
  deps.stdout(
    `[reclaim] DONE — swapped in ${fmtBytes(result.outputBytes)} (reclaimed ${fmtBytes(saved > 0 ? saved : 0)}). Snapshot kept at ${snap.snapshotPath}.\n` +
      "[reclaim] Restart the daemon, then 'keeper await server-up' and verify before discarding the snapshot (see --agent-help).\n",
  );
}

/** Human-friendly byte size (informational logging only). */
function fmtBytes(n: number): string {
  if (n <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function main(argv: string[]): void {
  const parsed = parseReclaimArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`keeper reclaim: ${parsed.message}\n\n`);
    process.stderr.write(HELP);
    process.exit(1);
  }
  if (parsed.args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.args.agentHelp) {
    const outputPath = `${parsed.args.dbPath}.reclaim`;
    process.stdout.write(
      `${reclaimInstructions(outputPath, parsed.args.dbPath)}\n`,
    );
    return;
  }
  run(parsed.args, {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  });
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}

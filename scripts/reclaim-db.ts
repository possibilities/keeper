#!/usr/bin/env bun
/**
 * Operator catch-up drain + offline reclaim runbook (fn-837.2) — drive the
 * widened retention shed-set to completion, then print the daemon-stopped
 * offline-VACUUM procedure.
 *
 * The steady-state 300s retention timer (≤20 batches/pass) would take 5+ hours
 * to drain the ~600k-row historical backlog the fn-837 predicate widening made
 * eligible, and per-batch `incremental_vacuum` lags so the FILE won't shrink
 * without a full `VACUUM INTO`. This util does the prompt catch-up drain (the
 * SAME paced ≤500-row/tx pass, elevated per-pass batch cap, NEVER one giant
 * UPDATE) and then prints the offline reclaim runbook.
 *
 * Two modes:
 *   bun scripts/reclaim-db.ts            # DRAIN the cold backlog, then print
 *                                        # the offline reclaim runbook
 *   bun scripts/reclaim-db.ts --dry-run  # print the runbook ONLY (no writes)
 *
 * The DRAIN is safe to run while keeperd is UP — it is the same paced retention
 * the daemon itself runs on its slack timer, just driven to completion; every tx
 * is ≤500 rows so a concurrent hook INSERT is never starved. The offline VACUUM
 * (the runbook's `reclaimDb` step) is operator-driven with the daemon STOPPED.
 */
import { reclaimInstructions } from "../src/backup";
import {
  DEFAULT_DRAIN_MAX_BATCHES,
  DEFAULT_RETENTION_BATCH_SIZE,
  drainColdPayloads,
} from "../src/compaction";
import { openDb, resolveDbPath } from "../src/db";

const dryRun = process.argv.includes("--dry-run");
const dbPath = resolveDbPath();
const outputPath = `${dbPath}.reclaim`;

console.log(`[reclaim] source: ${dbPath}`);

if (!dryRun) {
  // Writable connection, daemon is the SOLE migrator (migrate:false) and the
  // drain prepares its own statements (prepareStmts:false). Same paced pass the
  // daemon runs — ≤500-row txns, released writer lock between batches.
  const { db } = openDb(dbPath, {
    readonly: false,
    migrate: false,
    prepareStmts: false,
  });
  try {
    console.log(
      `[reclaim] draining cold shed-class backlog (≤${DEFAULT_RETENTION_BATCH_SIZE} rows/tx, ${DEFAULT_DRAIN_MAX_BATCHES} batches/pass) …`,
    );
    const result = drainColdPayloads(db, {
      onPass: (pass, n) => {
        if (pass.shed > 0) {
          console.log(
            `[reclaim]   pass ${n}: shed ${pass.shed} body/bodies in ${pass.batches} batch(es), reclaimed ${pass.reclaimedPages} page(s)`,
          );
        }
      },
    });
    // Checkpoint the WAL space the drain freed — PASSIVE never waits on a writer
    // (TRUNCATE would, starving a contending hook); it checkpoints what it can.
    if (result.shed > 0) {
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (err) {
        console.error(
          `[reclaim] PASSIVE checkpoint threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    console.log(
      `[reclaim] drain done — shed ${result.shed} body/bodies across ${result.passes} pass(es), ${result.batches} batch(es), reclaimed ${result.reclaimedPages} page(s)`,
    );
    if (result.hitPassCap) {
      console.error(
        "[reclaim] WARNING: drain hit its pass cap with rows still shedding — re-run this script to finish (it is idempotent).",
      );
    }
  } finally {
    db.close();
  }
  console.log("");
}

console.log(reclaimInstructions(outputPath, dbPath));

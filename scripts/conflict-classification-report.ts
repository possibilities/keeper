#!/usr/bin/env bun
/**
 * Read-only historical merge-conflict measurement. This deliberately reads the
 * append-only `events` log rather than `dispatch_failures`: cleared failures are
 * removed from that live projection, while their DispatchFailed event remains.
 *
 * Usage:
 *   bun scripts/conflict-classification-report.ts
 *   bun scripts/conflict-classification-report.ts --since <epoch-ms|ISO-8601>
 *
 * `--since` is the known base-freshness-gate cutover. It compares base-drift
 * counts before and after that point; it is a proxy, not proof of prevention,
 * because it is not normalized for work volume or elapsed time.
 */

import { resolveDriftThresholds } from "../src/autopilot-worker";
import { openDb, resolveDbPath } from "../src/db";

export type ConflictClassification =
  | "base-drift"
  | "file-overlap"
  | "other"
  | "not-a-conflict";

/** The decoded, reducer-equivalent subset of a DispatchFailed payload. */
export interface DispatchFailedIncident {
  id: string;
  verb: string;
  reason: string;
  dir: string | null;
  /** `null` means this historical event predates structured file reporting. */
  conflictedFiles: string[] | null;
  ts: number;
}

export interface ConflictBucket {
  count: number;
  /** Percent of conflict incidents; null only when the denominator is zero. */
  percentage: number | null;
}

export interface BeforeAfterBaseDrift {
  sinceMs: number;
  beforeCount: number;
  afterCount: number;
}

export interface ConflictClassificationReport {
  totalConflictIncidents: number;
  baseDrift: ConflictBucket;
  fileOverlap: ConflictBucket;
  other: ConflictBucket;
  /** Incidents carrying the structured `conflictedFiles` payload field. */
  incidentsWithConflictedFiles: number;
  /** Total structured file-path observations across conflict incidents. */
  conflictedFilePaths: number;
  /**
   * `null` when the gate is disabled. When enabled this is only refresh
   * attempts that still conflicted, not total refresh attempts: successful
   * refreshes emit no event and are unobservable in this history.
   */
  refreshConflictCount: number | null;
  /** Null until the operator supplies the gate cutover via `--since`. */
  beforeAfterBaseDrift: BeforeAfterBaseDrift | null;
}

const MERGE_SOURCE_RE = /merging (\S+) into (\S+)/;
const EPIC_BRANCH_PREFIX = "keeper/epic/";

/**
 * Attribute known worktree conflict reasons without probing git or the DB.
 * Non-conflict dispatch failures are intentionally excluded rather than folded
 * into `other`; `other` is only a recognized conflict prefix we cannot parse.
 */
export function classifyConflictIncident(
  reason: string,
): ConflictClassification {
  if (reason.startsWith("worktree-finalize-conflict:")) {
    return "base-drift";
  }
  if (!reason.startsWith("worktree-merge-conflict:")) {
    return "not-a-conflict";
  }
  const merge = MERGE_SOURCE_RE.exec(reason);
  if (merge == null) return "other";
  return merge[1].startsWith(EPIC_BRANCH_PREFIX)
    ? "file-overlap"
    : "base-drift";
}

/** Reducer-equivalent defensive decoder for a historical event body. */
export function decodeDispatchFailedPayload(
  data: string | null,
): DispatchFailedIncident | null {
  if (data == null || data.length === 0) return null;
  try {
    const parsed = JSON.parse(data) as Partial<DispatchFailedIncident>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    if (typeof parsed.verb !== "string" || parsed.verb.length === 0) return null;
    if (typeof parsed.reason !== "string" || parsed.reason.length === 0) {
      return null;
    }
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }
    return {
      id: parsed.id,
      verb: parsed.verb,
      reason: parsed.reason,
      dir:
        typeof parsed.dir === "string" && parsed.dir.length > 0
          ? parsed.dir
          : null,
      conflictedFiles: Array.isArray(parsed.conflictedFiles)
        ? parsed.conflictedFiles.filter(
            (path): path is string => typeof path === "string",
          )
        : null,
      ts: parsed.ts,
    };
  } catch {
    return null;
  }
}

/**
 * Pure aggregation over already-decoded historical payloads. `sinceMs` is an
 * operator-supplied cutover, never inferred from current configuration.
 */
export function buildConflictClassificationReport(
  incidents: readonly DispatchFailedIncident[],
  options: { gateEnabled: boolean; sinceMs?: number } = { gateEnabled: false },
): ConflictClassificationReport {
  let baseDriftCount = 0;
  let fileOverlapCount = 0;
  let otherCount = 0;
  let incidentsWithConflictedFiles = 0;
  let conflictedFilePaths = 0;
  let refreshConflictCount = 0;
  let beforeCount = 0;
  let afterCount = 0;
  const sinceMs = options.sinceMs;

  for (const incident of incidents) {
    const classification = classifyConflictIncident(incident.reason);
    if (classification === "not-a-conflict") continue;

    if (incident.conflictedFiles !== null) {
      incidentsWithConflictedFiles++;
      conflictedFilePaths += incident.conflictedFiles.length;
    }
    switch (classification) {
      case "base-drift":
        baseDriftCount++;
        // A non-keeper source is the default branch refresh direction. This is
        // only a refresh attempt that still conflicted: successful refreshes
        // emit no DispatchFailed event, so total refresh attempts are unknown.
        if (
          options.gateEnabled &&
          incident.reason.startsWith("worktree-merge-conflict:")
        ) {
          const merge = MERGE_SOURCE_RE.exec(incident.reason);
          if (merge != null && !merge[1].startsWith(EPIC_BRANCH_PREFIX)) {
            refreshConflictCount++;
          }
        }
        if (options.gateEnabled && sinceMs !== undefined) {
          // DispatchFailedPayload.ts (and events.ts) are unix seconds, while
          // --since accepts epoch milliseconds or ISO-8601. Normalize before
          // splitting; comparing raw seconds to epoch milliseconds would put
          // every modern incident in the "before" bucket.
          if (incident.ts * 1000 < sinceMs) beforeCount++;
          else afterCount++;
        }
        break;
      case "file-overlap":
        fileOverlapCount++;
        break;
      case "other":
        otherCount++;
        break;
    }
  }

  const total = baseDriftCount + fileOverlapCount + otherCount;
  const bucket = (count: number): ConflictBucket => ({
    count,
    percentage: total === 0 ? null : (count / total) * 100,
  });
  return {
    totalConflictIncidents: total,
    baseDrift: bucket(baseDriftCount),
    fileOverlap: bucket(fileOverlapCount),
    other: bucket(otherCount),
    incidentsWithConflictedFiles,
    conflictedFilePaths,
    refreshConflictCount: options.gateEnabled ? refreshConflictCount : null,
    beforeAfterBaseDrift:
      options.gateEnabled && sinceMs !== undefined
        ? { sinceMs, beforeCount, afterCount }
        : null,
  };
}

function formatBucket(name: string, bucket: ConflictBucket): string {
  const percentage =
    bucket.percentage === null ? "n/a" : `${bucket.percentage.toFixed(1)}%`;
  return `  ${name}: ${bucket.count} (${percentage})`;
}

/** Render the operator-facing, explicitly observational report. */
export function renderConflictClassificationReport(
  report: ConflictClassificationReport,
  gateEnabled: boolean,
): void {
  console.log(`Historical conflict incidents: ${report.totalConflictIncidents}`);
  console.log(formatBucket("base-drift", report.baseDrift));
  console.log(formatBucket("file-overlap", report.fileOverlap));
  console.log(formatBucket("other/unclassified", report.other));
  console.log(
    `Structured conflictedFiles: ${report.incidentsWithConflictedFiles} incident(s), ${report.conflictedFilePaths} path observation(s).`,
  );

  if (!gateEnabled) {
    console.log("Base-freshness gate: disabled.");
    return;
  }

  console.log("Base-freshness gate: enabled.");
  console.log(
    `Refresh attempts that still hit a conflict: ${report.refreshConflictCount}. Successful refreshes emit no event, so total refresh attempts performed are not observable from event history.`,
  );
  if (report.beforeAfterBaseDrift === null) {
    console.log(
      "Conflicts-prevented proxy (base-drift before/after): n/a (pass --since <cutover-ms> to compare).",
    );
    return;
  }
  const comparison = report.beforeAfterBaseDrift;
  console.log(
    `Conflicts-prevented proxy (base-drift before/after) at ${comparison.sinceMs}: ${comparison.beforeCount} before, ${comparison.afterCount} after. Counts are not exposure-normalized, so this is a proxy rather than a measured prevention rate.`,
  );
}

function parseSince(args: string[]): number | undefined {
  const index = args.indexOf("--since");
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (raw == null || index + 2 !== args.length) {
    throw new Error("usage: --since <epoch-ms|ISO-8601>");
  }
  const numeric = Number(raw);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("--since must be an epoch-ms number or ISO-8601 timestamp");
  }
  return parsed;
}

function hasEventBlobsTable(db: { query(sql: string): { get(): unknown } }): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_blobs'",
      )
      .get() !== null
  );
}

function readHistoricalIncidents(): {
  incidents: DispatchFailedIncident[];
  gateEnabled: boolean;
} {
  const { db } = openDb(resolveDbPath(), {
    readonly: true,
    migrate: false,
    prepareStmts: false,
  });
  try {
    // Old databases may still carry compacted bodies in event_blobs; current
    // schemas shed that table after restoring bodies inline. Keep the required
    // COALESCE read whenever it exists, while remaining read-only against both.
    const rows = hasEventBlobsTable(db)
      ? (db
          .query(
            `SELECT events.id AS id, events.ts AS ts,
                    COALESCE(events.data, event_blobs.data) AS data
               FROM events
               LEFT JOIN event_blobs ON event_blobs.event_id = events.id
              WHERE hook_event = 'DispatchFailed'
              ORDER BY events.id ASC`,
          )
          .all() as { id: number; ts: number; data: string | null }[])
      : (db
          .query(
            `SELECT events.id AS id, events.ts AS ts, events.data AS data
               FROM events
              WHERE hook_event = 'DispatchFailed'
              ORDER BY events.id ASC`,
          )
          .all() as { id: number; ts: number; data: string | null }[]);
    const incidents = rows.flatMap((row) => {
      const incident = decodeDispatchFailedPayload(row.data);
      return incident === null ? [] : [incident];
    });
    const autopilotRow = db
      .query("SELECT * FROM autopilot_state WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    return {
      incidents,
      gateEnabled: resolveDriftThresholds(autopilotRow).behindThreshold !== null,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const sinceMs = parseSince(process.argv.slice(2));
  const { incidents, gateEnabled } = readHistoricalIncidents();
  const report = buildConflictClassificationReport(incidents, {
    gateEnabled,
    sinceMs,
  });
  renderConflictClassificationReport(report, gateEnabled);
}

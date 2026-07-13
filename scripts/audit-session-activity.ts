#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { PENDING_DISPATCH_STALE_CEILING_SEC } from "../src/readiness";
import {
  type DispatchReservation,
  deriveHarnessActivities,
  type HarnessActivity,
} from "../src/session-activity";

export const SESSION_ACTIVITY_AUDIT_SCHEMA_VERSION = 1;
export const SESSION_ACTIVITY_AUDIT_DEFAULT_LIMIT = 200;
export const SESSION_ACTIVITY_AUDIT_MAX_LIMIT = 1_000;
const CHILD_ROWS_PER_JOB = 32;
const CLAIM_TARGETS_PER_JOB = 8;

interface AuditJobRow {
  job_id: string;
  harness: string;
  state: string;
  updated_at: number;
  active_since: number | null;
  monitors: string;
  backend_exec_pane_id: string | null;
}

interface AuditChildRow {
  job_id: string;
  agent_id: string;
  turn_seq: number;
  status: string;
  duration_ms: number | null;
  updated_at: number;
  subagent_type: string | null;
  row_number: number;
}

interface AuditClaimRow {
  verb: string;
  id: string;
  attempt_id: number | null;
  state: string;
  session_id: string | null;
  legacy_unfenced: number;
  updated_at: number;
  row_number: number;
}

interface AuditPendingRow {
  verb: string;
  id: string;
  attempt_id: number | null;
  dispatched_at: number;
}

export interface SessionActivityAuditOptions {
  dbPath: string;
  limit?: number;
  now?: number;
}

export interface SessionActivityAuditReport {
  schema_version: number;
  selected_count: number;
  selected_truncated: boolean;
  child_rows_truncated_for: string[];
  claim_rows_truncated_for: string[];
  aggregate: {
    harness: Record<string, number>;
    activity: Record<string, number>;
    reasons: Record<string, number>;
    reservations: Record<string, number>;
    claim_states: Record<string, number>;
    attempt_evidence: Record<string, number>;
    legacy_deltas: Record<string, number>;
  };
  sessions: Array<{
    job_id: string;
    harness: string;
    activity: HarnessActivity["status"];
    reason: HarnessActivity["reason"];
    reservation: DispatchReservation;
    claim_targets: string[];
    claim_targets_truncated: boolean;
    legacy_activity: HarnessActivity["status"];
  }>;
  stale_attempts: Array<{
    target: string;
    attempt_id: number | null;
    age_seconds: number;
  }>;
  stale_attempts_truncated: boolean;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? SESSION_ACTIVITY_AUDIT_DEFAULT_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SESSION_ACTIVITY_AUDIT_MAX_LIMIT
  ) {
    throw new Error(
      `limit must be an integer from 1 through ${SESSION_ACTIVITY_AUDIT_MAX_LIMIT}`,
    );
  }
  return limit;
}

function legacyActivity(job: AuditJobRow): HarnessActivity["status"] {
  if (job.state === "working") return "active";
  if (job.state === "ended" || job.state === "killed") return "quiescent";
  if (job.state === "stopped" && job.backend_exec_pane_id != null)
    return "active";
  if (job.state === "stopped") return "quiescent";
  return "unknown";
}

function reservationFor(
  job: AuditJobRow,
  claims: readonly AuditClaimRow[],
): DispatchReservation {
  if (claims.some((claim) => claim.state === "resume_requested"))
    return "resume";
  if (
    job.active_since == null &&
    claims.some((claim) => claim.state === "bound")
  ) {
    return "bound";
  }
  return null;
}

export function auditSessionActivity(
  options: SessionActivityAuditOptions,
): SessionActivityAuditReport {
  if (options.dbPath.trim() === "") {
    throw new Error("an explicit database path is required");
  }
  const limit = normalizeLimit(options.limit);
  const now = options.now ?? Date.now() / 1_000;
  if (!Number.isFinite(now)) throw new Error("now must be finite");

  const db = new Database(options.dbPath, { readonly: true });
  try {
    const selected = db
      .query(
        `SELECT job_id, COALESCE(harness, 'claude') AS harness, state,
                updated_at, active_since, monitors, backend_exec_pane_id
           FROM jobs
          WHERE harness IS NULL OR harness IN ('claude', 'pi')
          ORDER BY updated_at DESC, job_id ASC
          LIMIT ?`,
      )
      .all(limit + 1) as AuditJobRow[];
    const selectedTruncated = selected.length > limit;
    const jobs = selected.slice(0, limit);
    const jobIds = jobs.map((job) => job.job_id);

    let childRows: AuditChildRow[] = [];
    let claims: AuditClaimRow[] = [];
    if (jobIds.length > 0) {
      const marks = placeholders(jobIds.length);
      childRows = db
        .query(
          `SELECT job_id, agent_id, turn_seq, status, duration_ms, updated_at,
                  subagent_type, row_number
             FROM (
               SELECT job_id, agent_id, turn_seq, status, duration_ms, updated_at,
                      subagent_type,
                      ROW_NUMBER() OVER (
                        PARTITION BY job_id
                        ORDER BY turn_seq DESC, updated_at DESC, agent_id DESC
                      ) AS row_number
                 FROM subagent_invocations
                WHERE job_id IN (${marks})
             )
            WHERE row_number <= ?
            ORDER BY job_id ASC, row_number ASC`,
        )
        .all(...jobIds, CHILD_ROWS_PER_JOB + 1) as AuditChildRow[];
      claims = db
        .query(
          `SELECT verb, id, attempt_id, state, session_id, legacy_unfenced,
                  updated_at, row_number
             FROM (
               SELECT verb, id, attempt_id, state, session_id,
                      legacy_unfenced, updated_at,
                      ROW_NUMBER() OVER (
                        PARTITION BY session_id
                        ORDER BY updated_at DESC, verb ASC, id ASC
                      ) AS row_number
                 FROM dispatch_claims
                WHERE session_id IN (${marks})
             )
            WHERE row_number <= ?
            ORDER BY session_id ASC, row_number ASC`,
        )
        .all(...jobIds, CLAIM_TARGETS_PER_JOB + 1) as AuditClaimRow[];
    }

    const childrenTruncated = new Set(
      childRows
        .filter((row) => row.row_number > CHILD_ROWS_PER_JOB)
        .map((row) => row.job_id),
    );
    childRows = childRows.filter((row) => row.row_number <= CHILD_ROWS_PER_JOB);
    const claimsTruncated = new Set(
      claims
        .filter((row) => row.row_number > CLAIM_TARGETS_PER_JOB)
        .flatMap((row) => (row.session_id == null ? [] : [row.session_id])),
    );
    claims = claims.filter((row) => row.row_number <= CLAIM_TARGETS_PER_JOB);

    const claimsBySession = new Map<string, AuditClaimRow[]>();
    for (const claim of claims) {
      if (claim.session_id == null) continue;
      const group = claimsBySession.get(claim.session_id);
      if (group == null) claimsBySession.set(claim.session_id, [claim]);
      else group.push(claim);
    }
    const reservations = new Map<string, Exclude<DispatchReservation, null>>();
    for (const job of jobs) {
      const reservation = reservationFor(
        job,
        claimsBySession.get(job.job_id) ?? [],
      );
      if (reservation != null) reservations.set(job.job_id, reservation);
    }
    const activities = deriveHarnessActivities(
      jobs,
      childRows,
      now,
      reservations,
    );

    const pending = db
      .query(
        `SELECT verb, id, attempt_id, dispatched_at
           FROM pending_dispatches
          ORDER BY dispatched_at ASC, verb ASC, id ASC
          LIMIT ?`,
      )
      .all(limit + 1) as AuditPendingRow[];
    const stalePending = pending.filter(
      (row) => now - row.dispatched_at > PENDING_DISPATCH_STALE_CEILING_SEC,
    );

    const aggregate = {
      harness: {} as Record<string, number>,
      activity: {} as Record<string, number>,
      reasons: {} as Record<string, number>,
      reservations: {} as Record<string, number>,
      claim_states: {} as Record<string, number>,
      attempt_evidence: {} as Record<string, number>,
      legacy_deltas: {} as Record<string, number>,
    };
    for (const claim of claims) {
      increment(aggregate.claim_states, claim.state);
      increment(
        aggregate.attempt_evidence,
        claim.legacy_unfenced === 1 || claim.attempt_id == null
          ? "legacy-unfenced"
          : "exact",
      );
    }
    for (const row of pending.slice(0, limit)) {
      increment(
        aggregate.attempt_evidence,
        now - row.dispatched_at > PENDING_DISPATCH_STALE_CEILING_SEC
          ? "stale-pending"
          : "pending",
      );
    }

    const sessions = jobs.map((job) => {
      const activity = activities.get(job.job_id) ?? {
        status: "unknown" as const,
        reason: "parent-missing" as const,
        reservation: null,
      };
      const legacy = legacyActivity(job);
      const jobClaims = claimsBySession.get(job.job_id) ?? [];
      increment(aggregate.harness, job.harness);
      increment(aggregate.activity, activity.status);
      increment(aggregate.reasons, activity.reason);
      increment(aggregate.reservations, activity.reservation ?? "none");
      increment(aggregate.legacy_deltas, `${legacy}->${activity.status}`);
      return {
        job_id: job.job_id,
        harness: job.harness,
        activity: activity.status,
        reason: activity.reason,
        reservation: activity.reservation,
        claim_targets: jobClaims.map((claim) => `${claim.verb}::${claim.id}`),
        claim_targets_truncated: claimsTruncated.has(job.job_id),
        legacy_activity: legacy,
      };
    });

    return {
      schema_version: SESSION_ACTIVITY_AUDIT_SCHEMA_VERSION,
      selected_count: sessions.length,
      selected_truncated: selectedTruncated,
      child_rows_truncated_for: [...childrenTruncated].sort(),
      claim_rows_truncated_for: [...claimsTruncated].sort(),
      aggregate,
      sessions,
      stale_attempts: stalePending.slice(0, limit).map((row) => ({
        target: `${row.verb}::${row.id}`,
        attempt_id: row.attempt_id,
        age_seconds: Math.max(0, Math.floor(now - row.dispatched_at)),
      })),
      stale_attempts_truncated:
        pending.length > limit || stalePending.length > limit,
    };
  } finally {
    db.close();
  }
}

export function parseSessionActivityAuditArgs(
  argv: string[],
): SessionActivityAuditOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      limit: { type: "string" },
      now: { type: "string" },
      readonly: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.db == null || parsed.values.db.trim() === "") {
    throw new Error("--db <snapshot-path> is required");
  }
  const limit =
    parsed.values.limit == null ? undefined : Number(parsed.values.limit);
  const now = parsed.values.now == null ? undefined : Number(parsed.values.now);
  return { dbPath: parsed.values.db, limit, now };
}

export function main(argv: string[] = Bun.argv.slice(2)): void {
  const report = auditSessionActivity(parseSessionActivityAuditArgs(argv));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "audit failed";
    process.stderr.write(`audit-session-activity: ${message}\n`);
    process.exitCode = 1;
  }
}

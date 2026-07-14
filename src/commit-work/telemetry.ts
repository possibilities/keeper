import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serializeEventLogRecord } from "../dead-letter";

export interface CommitWorkTelemetryDeps {
  eventsLogDir?: () => string;
  append?: (path: string, line: string) => void;
  ensureDir?: (path: string) => void;
}

/** Hard cap on the JSON carried in one ingestion-compatible outcome event. */
export const COMMIT_WORK_TELEMETRY_DATA_LIMIT = 64 * 1024;

export function resolveCommitWorkEventsLogDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.KEEPER_EVENTS_LOG;
  return override && override.length > 0
    ? override
    : join(homedir(), ".local", "state", "keeper", "events-log");
}

function boundedOutcome(result: Record<string, unknown>): string {
  const full = JSON.stringify(result);
  if (Buffer.byteLength(full) <= COMMIT_WORK_TELEMETRY_DATA_LIMIT) return full;
  const compact: Record<string, unknown> = {
    schema_version: result.schema_version,
    kind: result.kind,
    outcome: result.outcome,
    success: result.success,
    identity: result.identity,
    commit_sha: result.commit_sha,
    telemetry_truncated: true,
  };
  const encoded = JSON.stringify(compact);
  return Buffer.byteLength(encoded) <= COMMIT_WORK_TELEMETRY_DATA_LIMIT
    ? encoded
    : '{"telemetry_truncated":true}';
}

/** Best-effort per-PID events-log append. Never writes stdout/stderr or the DB. */
export function emitCommitWorkOutcome(
  result: Record<string, unknown>,
  identity: string | null,
  deps: CommitWorkTelemetryDeps = {},
): void {
  try {
    const dir = (deps.eventsLogDir ?? resolveCommitWorkEventsLogDir)();
    const ensure =
      deps.ensureDir ??
      ((path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }));
    const append =
      deps.append ??
      ((path: string, line: string) =>
        appendFileSync(path, line, { mode: 0o600 }));
    ensure(dir);
    const path = join(dir, `${process.pid}.ndjson`);
    // Tighten a pre-existing per-PID leaf before appending sensitive outcome
    // detail. ENOENT is the normal first-write case; creation below uses 0600.
    try {
      chmodSync(path, 0o600);
    } catch {
      // absent or unreadable; the append path remains fail-open
    }
    const line = serializeEventLogRecord({
      bindings: {
        ts: Date.now() / 1000,
        session_id: identity ?? "",
        pid: process.pid,
        hook_event: "commit_work_outcome",
        event_type: "commit_work_outcome",
        tool_name: "commit-work",
        data: boundedOutcome(result),
      },
    });
    append(path, line);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Append durability is the success criterion; chmod is best effort.
    }
  } catch {
    // Telemetry is fail-open and must never perturb the terminal result.
  }
}

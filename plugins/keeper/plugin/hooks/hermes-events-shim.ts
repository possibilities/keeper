#!/usr/bin/env bun
/**
 * Keeper hermes events shim — hermes's M3b live-state channel.
 *
 * Hermes fires this script as a shell hook (registered in `~/.hermes/config.yaml`
 * by `src/hermes-trust.ts`) once per lifecycle event, piping the event payload on
 * stdin. The shim translates that payload into keeper's events-log NDJSON contract
 * — the SAME per-pid `<pid>.ndjson` file the claude events-writer appends to — so
 * the existing daemon-side ingester + jobs fold turn hermes activity into live
 * working/stopped churn with ZERO reducer work. It is a second per-pid writer on
 * the events-log channel (file-per-writer, offsets are per-(path,inode)), never a
 * DB writer.
 *
 * Hook discipline (inherited from the keeper hook rules, CLAUDE.md):
 * - **Always exit 0** — a throwing / slow shim must never crash or stall the
 *   human's hermes turn. Every failure is swallowed to a private log.
 * - **Never write stdout** — stdout is hermes's hook CONTROL channel (it parses
 *   stdout back as a block/continue/context JSON directive). The shim is an
 *   OBSERVER: it emits nothing on stdout, so hermes reads an empty no-op response.
 * - **No bun:sqlite / no third-party deps** — only `node:*` and the dep-free
 *   `src/dead-letter` serializer, so cold start stays inside hermes's hook timeout.
 * - **Attacker-influenced payload** — `tool_input` and friends are model/tool
 *   output. The whole record is emitted as ONE `JSON.stringify` line, so quotes /
 *   newlines / shell metacharacters round-trip as data (no NDJSON injection, no
 *   shell interpretation). The raw payload stored in `data` is size-bounded.
 *
 * Identity: `session_id` (the events-log join key → `jobs.job_id`) is the keeper
 * job id carried in `KEEPER_JOB_ID` — the launcher exports it into the hermes
 * child, and hermes spawns hooks with an inherited env, so it reaches this
 * subprocess. Absent job id ⇒ NO row (a silent no-op): presence is already owned
 * by the birth record, and minting a row under a synthesized id would orphan it.
 * The shim NEVER sets `pid`/`start_time`: the birth record owns the recycle-safe
 * `(pid, start_time)` identity, and the SessionStart fold COALESCE-preserves it.
 *
 * The hermes NATIVE session id (the payload's own `session_id`) rides the
 * SessionStart row's `resume_target` column, back-filling the keeper-minted job so
 * a `--resume` reuses it. Turn-end degrade: hermes emits no per-turn Stop, so the
 * jobs row reads `working` from the first `pre_llm_call` until `on_session_end`
 * flips it to stopped/ended — the acceptable initial floor for M3b.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DeadLetterBindings,
  EventLogRecord,
} from "../../../../src/dead-letter";
import { serializeEventLogRecord } from "../../../../src/dead-letter";

/**
 * Map a hermes lifecycle event name onto keeper's `(hook_event, event_type)`
 * columns. The reducer switches on `hook_event` (the PascalCase keeper name), so
 * these MUST match the claude events-writer's canonical values (`event_type`
 * mirrors its TYPE_MAP / snake_case output) for the shared fold to apply
 * unchanged. An event outside this table is dropped (no row) — hermes may add
 * events keeper does not model, and an unmapped event must never fold as poison.
 *
 * `pre_llm_call` → UserPromptSubmit drives the `working` transition; there is no
 * hermes per-turn Stop, so nothing here maps to Stop — session end is the only
 * `working → stopped` edge (see the module doc's turn-end degrade). `api_request_error`
 * → ApiError lands the error pill (its `data.kind` folds to "unknown", which is
 * the correct degrade); `pre_approval_request` → the permission-prompt Notification.
 */
const HERMES_EVENT_MAP: Record<
  string,
  { hookEvent: string; eventType: string }
> = {
  on_session_start: { hookEvent: "SessionStart", eventType: "session_start" },
  on_session_end: { hookEvent: "SessionEnd", eventType: "session_end" },
  pre_llm_call: {
    hookEvent: "UserPromptSubmit",
    eventType: "user_prompt_submit",
  },
  pre_tool_call: { hookEvent: "PreToolUse", eventType: "pre_tool_use" },
  post_tool_call: { hookEvent: "PostToolUse", eventType: "tool_use" },
  subagent_start: { hookEvent: "SubagentStart", eventType: "subagent_start" },
  subagent_stop: { hookEvent: "SubagentStop", eventType: "subagent_stop" },
  api_request_error: { hookEvent: "ApiError", eventType: "api_error" },
  pre_approval_request: {
    hookEvent: "Notification",
    eventType: "permission_prompt",
  },
};

/** The lifecycle events the shim handles — the seeder registers exactly this set
 *  in hermes's `hooks:` block so hermes only ever invokes the shim for a mapped
 *  event. Exported so `src/hermes-trust.ts` (via the launch wiring) and this shim
 *  share ONE source of truth. */
export const HERMES_SHIM_EVENTS: readonly string[] =
  Object.keys(HERMES_EVENT_MAP);

/** Managed-block version for the seeder's sentinel. Bump when the registered
 *  event set or the shim's config contract changes, so the seeder re-seeds an
 *  older block on the next launch (hooks bind at hermes startup). */
export const HERMES_SHIM_VERSION = 1;

/** Upper bound on the raw payload stored in `data` (opaque triage bytes). A
 *  runaway `tool_input` must not balloon a single NDJSON line; the reducer arms
 *  that parse `data` (ApiError) already fold a malformed/truncated body to a safe
 *  default, so a hard slice is lossless for state. */
const MAX_DATA_CHARS = 64 * 1024;

/** Pull a non-empty string field, else null (defensive against non-string /
 *  missing values in an attacker-influenced payload). */
function strField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build the one events-log NDJSON line for a hermes payload, or null to skip (no
 * job id, unparseable payload, or an unmapped event). Pure + exported: the golden
 * fixtures pin the exact line, so this is unit-testable with zero fs / fork.
 *
 * Emits only the columns hermes populates; every other `events` column is omitted
 * and the ingester lands it NULL (it binds the intersection of the record's keys
 * and the live columns — a subset is the documented lossless degrade). The whole
 * record is one `JSON.stringify`, so any metacharacter in the payload is escaped
 * as data.
 */
export function buildHermesEventLine(
  raw: string,
  env: Record<string, string | undefined>,
  ts: number,
): string | null {
  const jobId = (env.KEEPER_JOB_ID ?? "").trim();
  if (jobId === "") {
    // No keeper job identity — presence is the birth record's job; a row under a
    // synthesized id would orphan. Degrade to nothing (presence-only floor).
    return null;
  }

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const hermesEvent = strField(data, "hook_event_name");
  if (hermesEvent === null) {
    return null;
  }
  const mapped = HERMES_EVENT_MAP[hermesEvent];
  if (mapped === undefined) {
    return null;
  }

  const bindings: DeadLetterBindings = {
    ts,
    session_id: jobId,
    hook_event: mapped.hookEvent,
    event_type: mapped.eventType,
    // The verbatim payload for triage, size-bounded. JSON.stringify of the whole
    // record escapes every quote / newline inside it — no line tearing.
    data: raw.length > MAX_DATA_CHARS ? raw.slice(0, MAX_DATA_CHARS) : raw,
  };

  // Tool name on the tool events so the board / subagent projection can read it.
  const toolName = strField(data, "tool_name");
  if (toolName !== null) {
    bindings.tool_name = toolName;
  }
  const cwd = strField(data, "cwd");
  if (cwd !== null) {
    bindings.cwd = cwd;
  }

  // SessionStart only: stamp the launching harness and back-fill the resume
  // target with hermes's OWN session id (the payload's `session_id`), so a
  // `--resume` reuses it. The fold COALESCE-folds both onto the birth-seeded row.
  if (mapped.hookEvent === "SessionStart") {
    bindings.harness = "hermes";
    const nativeSessionId = strField(data, "session_id");
    if (nativeSessionId !== null) {
      bindings.resume_target = nativeSessionId;
    }
  }

  const record: EventLogRecord = { bindings };
  return serializeEventLogRecord(record);
}

/**
 * Resolve the keeper events-log directory. MUST match the claude events-writer's
 * `resolveEventsLogDir` (and `src/db.ts`) byte-for-byte — the shim keeps its own
 * copy because it is forbidden `bun:sqlite`. `KEEPER_EVENTS_LOG` wins (tests point
 * it at a tmp dir); else `~/.local/state/keeper/events-log`.
 */
function resolveEventsLogDir(env: Record<string, string | undefined>): string {
  const override = env.KEEPER_EVENTS_LOG;
  if (override != null && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "events-log");
}

/** Private diagnostic log — NEVER stdout (hermes's control channel). Best-effort;
 *  a logging failure is itself swallowed. */
function logPrivate(
  env: Record<string, string | undefined>,
  line: string,
): void {
  try {
    const logPath = (env.KEEPER_HERMES_SHIM_LOG ?? "").trim();
    if (logPath === "") {
      return;
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, {
      mode: 0o600,
    });
  } catch {
    // best-effort.
  }
}

/**
 * Append one events-log line to the per-pid file. A single `appendFileSync` per
 * `\n`-terminated line; one ENOENT retry after re-mkdir (a dir-reaped race). A
 * lost line is acceptable (presence-only floor holds), so — unlike the claude
 * events-writer — there is no dead-letter path; a hard failure logs privately.
 */
function appendEventLine(
  env: Record<string, string | undefined>,
  line: string,
): void {
  const dir = resolveEventsLogDir(env);
  const file = join(dir, `${process.pid}.ndjson`);
  const ensureDir = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // idempotent mkdir; an existing dir throws harmlessly.
    }
  };
  try {
    ensureDir();
    appendFileSync(file, line);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      try {
        ensureDir();
        appendFileSync(file, line);
        return;
      } catch (retryErr) {
        logPrivate(env, `events-log append failed (ENOENT retry): ${retryErr}`);
        return;
      }
    }
    logPrivate(env, `events-log append failed: ${err}`);
  }
}

/** Read all of stdin (the hermes payload) as UTF-8. */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const line = buildHermesEventLine(raw, process.env, Date.now() / 1000);
  if (line === null) {
    return;
  }
  appendEventLine(process.env, line);
}

// Outer guard: ANY failure exits 0 (never crash the human's hermes turn) and
// writes NOTHING to stdout (hermes's control channel). `import.meta.main` keeps a
// plain import (the pure `buildHermesEventLine` under test) inert.
if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logPrivate(process.env, `fatal: ${err}`);
      process.exit(0);
    });
}

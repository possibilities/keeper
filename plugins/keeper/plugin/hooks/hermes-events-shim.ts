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
 * - **No bun:sqlite / no third-party deps** — only `node:*`, the dep-free
 *   `src/dead-letter` serializer, and the dep-free `src/exec-backend` env-name
 *   helper, so cold start stays inside hermes's hook timeout.
 * - **Attacker-influenced payload** — `tool_input` and friends are model/tool
 *   output, AND (on the self-seed path) the harness-native `session_id` is
 *   user-writable. The whole record is emitted as ONE `JSON.stringify` line, so
 *   quotes / newlines / shell metacharacters round-trip as data (no NDJSON
 *   injection, no shell interpretation). The raw payload stored in `data` is
 *   size-bounded; the native id is charset-whitelisted + length-bounded on the RAW
 *   value BEFORE it becomes a job_id (reject-to-null, never sanitize-and-continue).
 *
 * Identity — launcher-owned XOR self-seed:
 * - **Launcher-owned** (`KEEPER_JOB_ID` present): behavior is byte-identical to a
 *   claude-launched session. `session_id` (the events-log join key → `jobs.job_id`)
 *   is `KEEPER_JOB_ID`; presence + the recycle-safe `(pid, start_time)` identity are
 *   owned by the birth record, so the shim stamps NEITHER pid NOR adoption fields.
 *   The hermes NATIVE session id rides the SessionStart `resume_target` so a
 *   `--resume` reuses it.
 * - **Self-seed** (`KEEPER_JOB_ID` absent): a HAND-STARTED hermes is ADOPTED. The
 *   validated native session id becomes the job id, and every line carries the
 *   adopted marker, the SESSION pid (the shim's PARENT — hermes itself, never the
 *   short-lived shim pid), full backend-exec coordinates, and (on SessionStart) the
 *   `(pid, start_time)` recycle witness + `resume_target`. This mints a tracked,
 *   reap-safe, resume-able jobs row for a session the human started outside keeper.
 *   A local opt-out env (`KEEPER_HERMES_NO_ADOPT`) disables self-seeding ONLY
 *   (launcher-owned lines are unaffected), checked fail-open — the consent posture
 *   for capturing outside-keeper sessions.
 *
 * Accepted v1 limitations (stated so a surprised reader finds them here):
 * - **Lost line before SessionStart.** A self-seeded line lost before the session's
 *   first SessionStart leaves it untracked until its next SessionStart-bearing
 *   lifecycle event re-seeds the row.
 * - **Rollout lag.** A persistently-seeded OLD shim keeps firing for hand-started
 *   sessions until a keeper-launched hermes re-seeds the config block (on the next
 *   HERMES_SHIM_VERSION bump) AND the hand session restarts. Self-seeded lines carry
 *   {@link HERMES_SHIM_VERSION}; the ingest surface keeps accepting version-less
 *   lines from stale shims (additive-only evolution).
 * - **Turn-end degrade.** Hermes emits no per-turn Stop, so the jobs row reads
 *   `working` from the first `pre_llm_call` until `on_session_end` flips it to
 *   stopped/ended — the acceptable initial floor for M3b. A clean exit stops an
 *   adopted row through this same lifecycle; the pid+witness story is for hard-kill
 *   reaping only.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DeadLetterBindings,
  EventLogRecord,
} from "../../../../src/dead-letter";
import { serializeEventLogRecord } from "../../../../src/dead-letter";
import { execBackendEnvMeta } from "../../../../src/exec-backend";

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
 *  event set or the shim's config/line contract changes, so the seeder re-seeds an
 *  older block on the next launch (hooks bind at hermes startup). Stamped on
 *  self-seeded lines (`shim_version`) so the daemon can branch on old-shim records;
 *  the ingest surface keeps accepting version-less lines (additive-only). */
export const HERMES_SHIM_VERSION = 2;

/** Upper bound on the raw payload stored in `data` (opaque triage bytes). A
 *  runaway `tool_input` must not balloon a single NDJSON line; the reducer arms
 *  that parse `data` (ApiError) already fold a malformed/truncated body to a safe
 *  default, so a hard slice is lossless for state. */
const MAX_DATA_CHARS = 64 * 1024;

/** Env var the human sets (any non-empty value) to opt a hand-started hermes OUT
 *  of self-seed adoption. Presence-gated + fail-open: it disables ONLY the
 *  self-seed path (a launcher-owned session ignores it), and a bare env read never
 *  throws, so the exit-0 contract is unaffected. */
export const HERMES_ADOPT_OPT_OUT_ENV = "KEEPER_HERMES_NO_ADOPT";

/** Upper length bound on the RAW native session id before it may become a job_id.
 *  Session ids are short (UUID-ish); anything longer is rejected, not truncated. */
const NATIVE_SESSION_ID_MAX_LEN = 128;

/** True when the human has opted this machine out of hand-started hermes adoption. */
function selfSeedOptedOut(env: Record<string, string | undefined>): boolean {
  return (env[HERMES_ADOPT_OPT_OUT_ENV] ?? "").trim() !== "";
}

/**
 * Whitelist + length gate for the harness-native session id on the SELF-SEED path.
 * The native id is attacker-influenceable input that becomes a `jobs.job_id`
 * flowing into path-bearing / resume-argv surfaces, so it is validated on the RAW
 * value: only `[A-Za-z0-9._-]` (rejects path separators, NUL, whitespace, shell
 * metacharacters), 1..{@link NATIVE_SESSION_ID_MAX_LEN} chars, and never a pure-dots
 * traversal token (`.` / `..`). Reject → null (the caller degrades to today's
 * presence-only floor); NEVER sanitize-and-continue. Pure + exported for tests.
 */
export function validateNativeSessionId(raw: string | null): string | null {
  if (
    raw === null ||
    raw.length === 0 ||
    raw.length > NATIVE_SESSION_ID_MAX_LEN
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    return null;
  }
  if (/^\.+$/.test(raw)) {
    return null;
  }
  return raw;
}

/** Backend-exec coordinates resolved from the launch env — mirrors the hook's
 *  {@link BackendExecCoords} shape (type/session/pane). */
interface HermesBackendCoords {
  type: string | null;
  sessionId: string | null;
  paneId: string | null;
}

/**
 * Resolve tmux backend-exec coordinates from `env` for a self-seeded line.
 *
 * DRIFT GUARD: this two-arm read is replicated INLINE from the claude hook's
 * `backendExecCoordsFromEnv` (plugins/keeper/plugin/hooks/events-writer.ts) and
 * `birthBackendCoordsFromEnv` (src/birth-record.ts) — the shim is a dep-free island
 * and cannot import the hook's helper. The env-var NAMES funnel through
 * `execBackendEnvMeta` so they live in ONE place; the LOGIC is copied and the
 * matching comment on all three sites is the agreed drift guard.
 *
 * Native arm: under a real tmux pane (`TMUX` set) stamp type + pane id; the session
 * name stamps ONLY when the keeper carrier `KEEPER_TMUX_SESSION` is present — a
 * HAND-STARTED hermes carries none, so session stays NULL and the snapshot poller
 * fills it later. Carrier arm: `TMUX` stripped but `KEEPER_TMUX_PANE` present →
 * stamp from it. No sentinel + no carrier → all-NULL (never a `type=tmux` row with
 * a NULL pane — the renamer filter requires a non-null pane id).
 */
function hermesBackendCoordsFromEnv(
  env: Record<string, string | undefined>,
): HermesBackendCoords {
  const meta = execBackendEnvMeta("tmux");
  const collapse = (v: string | undefined): string | null =>
    v === undefined || v === "" ? null : v;

  const tmuxSentinel = env.TMUX;
  if (tmuxSentinel !== undefined && tmuxSentinel !== "") {
    return {
      type: meta.backendType,
      sessionId: collapse(env[meta.sessionIdEnvVar]),
      paneId: collapse(env[meta.paneIdEnvVar]),
    };
  }
  const carrierPane = collapse(env[meta.paneIdCarrierEnvVar]);
  if (carrierPane !== null) {
    return {
      type: meta.backendType,
      sessionId: collapse(env[meta.sessionIdEnvVar]),
      paneId: carrierPane,
    };
  }
  return { type: null, sessionId: null, paneId: null };
}

/**
 * Parse the platform-tagged start_time from a darwin `ps -o lstart=` stdout, or
 * null. DRIFT GUARD: byte-identical to `birthRecord`'s `darwinLstartToStartTime`
 * and seed-sweep's `readOsStartTime` — the 24-char fixed-width ctime(3)
 * `Day Mon DD HH:MM:SS YYYY` shape MUST match so the exit-watcher's verbatim
 * recycle compare holds.
 */
export function darwinLstartToStartTime(psStdout: string): string | null {
  const trimmed = psStdout.replace(/^\s+|\s+$/g, "");
  if (trimmed.length < 24) {
    return null;
  }
  const lstart = trimmed.slice(0, 24);
  if (
    !/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(
      lstart,
    )
  ) {
    return null;
  }
  return `darwin:${lstart}`;
}

/**
 * Parse the platform-tagged start_time from a linux `/proc/<pid>/stat` body, or
 * null. Field 22 (`starttime`, clock ticks since boot); field 2 (`comm`) may hold
 * spaces/parens, so bracket on the LAST `)` then split. DRIFT GUARD: mirrors
 * `birthRecord`'s `linuxStatToStartTime` byte-for-byte.
 */
export function linuxStatToStartTime(statText: string): string | null {
  const close = statText.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const rest = statText
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const raw = rest[19];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return `linux:${raw}`;
}

/**
 * Probe the SESSION (parent — hermes) pid's platform-tagged start_time, or null on
 * any failure (unknown platform, ps error, /proc unreadable). The one non-pure
 * step, gated by the caller to SELF-SEED SessionStart only (a `ps` fork per event
 * would risk the hook timeout). Never throws — every failure lands as null.
 */
export function probeParentStartTime(pid: number): string | null {
  try {
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(pid), "-o", "lstart=,args="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) {
        return null;
      }
      return darwinLstartToStartTime(result.stdout?.toString() ?? "");
    }
    if (process.platform === "linux") {
      return linuxStatToStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull a non-empty string field, else null (defensive against non-string /
 * missing values in an attacker-influenced payload).
 */
function strField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build the one events-log NDJSON line for a hermes payload, or null to skip
 * (opted out, unparseable payload, unmapped event, or a hostile/absent native id
 * on the self-seed path). Pure + exported: the golden fixtures pin the exact line,
 * so this is unit-testable with zero fs / fork.
 *
 * `sessionPid` is the SESSION process pid (the shim's PARENT — hermes; `main`
 * passes `process.ppid`), stamped on every self-seeded line. `probeStartTime` is a
 * LAZY thunk `main` injects (`() => probeParentStartTime(process.ppid)`); the
 * builder calls it AT MOST once — only when minting a self-seeded SessionStart — so
 * a launcher-owned or non-SessionStart line forks no `ps`. Both are unused on the
 * launcher-owned path, keeping it byte-identical.
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
  sessionPid: number | null = null,
  probeStartTime: () => string | null = () => null,
): string | null {
  const launcherJobId = (env.KEEPER_JOB_ID ?? "").trim();
  const selfSeed = launcherJobId === "";

  // Self-seed consent gate — a hand-started hermes is adopted by default, but the
  // human can opt out per-machine. Checked ONLY on the self-seed path; a
  // launcher-owned session ignores it (byte-identical). A bare env read never
  // throws (fail-open).
  if (selfSeed && selfSeedOptedOut(env)) {
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

  // Resolve the keeper job id. Launcher-owned: the exported KEEPER_JOB_ID.
  // Self-seed: the hermes-native session id, charset-whitelisted + length-bounded
  // on the RAW value before it becomes a job_id (reject → today's presence-only
  // floor, never sanitize-and-continue).
  let jobId: string;
  if (selfSeed) {
    const validated = validateNativeSessionId(strField(data, "session_id"));
    if (validated === null) {
      return null;
    }
    jobId = validated;
  } else {
    jobId = launcherJobId;
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
  // `--resume` reuses it. The fold COALESCE-folds both onto the row. On the
  // self-seed path this native id equals `jobId` (validation is reject-or-passthrough).
  if (mapped.hookEvent === "SessionStart") {
    bindings.harness = "hermes";
    const nativeSessionId = strField(data, "session_id");
    if (nativeSessionId !== null) {
      bindings.resume_target = nativeSessionId;
    }
  }

  // Self-seed enrichment — the adoption fields a hand-started session needs to fold
  // into a tracked, reap-safe, resume-able jobs row. Omitted entirely on the
  // launcher-owned path (byte-identical to today; the birth record owns identity).
  if (selfSeed) {
    // The adopted marker (set-once via the SessionStart COALESCE arm). `1` = a
    // non-launcher mint; a racing launcher re-mint carries NULL and never clobbers it.
    bindings.adopted = 1;
    // The SESSION pid (hermes), never the short-lived shim pid. Rides EVERY line so
    // an out-of-order pre-SessionStart line mints a WATCHABLE fork-seed row (the
    // reducer's UserPromptSubmit arm needs a non-null pid), never a pidless row the
    // exit-watcher reaps on sight.
    if (sessionPid !== null) {
      bindings.pid = sessionPid;
    }
    // The (pid, start_time) recycle witness — SessionStart only (mirrors claude:
    // UserPromptSubmit carries no start_time). It lets the exit-watcher re-probe
    // tell a live session from a recycled pid, so a hard-killed adopted row is
    // reaped and never resurrected onto a stranger's pid.
    if (mapped.hookEvent === "SessionStart") {
      const startTime = probeStartTime();
      if (startTime !== null) {
        bindings.start_time = startTime;
      }
    }
    // Full backend-exec coordinates on EVERY line — restore folds coords from the
    // every-event arm, so a coord only on SessionStart would not survive. Each
    // sub-var collapses absent → omitted so the reducer's COALESCE arm cannot be
    // clobbered by a partial capture.
    const coords = hermesBackendCoordsFromEnv(env);
    if (coords.type !== null) {
      bindings.backend_exec_type = coords.type;
    }
    if (coords.sessionId !== null) {
      bindings.backend_exec_session_id = coords.sessionId;
    }
    if (coords.paneId !== null) {
      bindings.backend_exec_pane_id = coords.paneId;
    }
    // Stamp the shim version so the daemon can branch on old-shim records. Rides as
    // an events binding the ingester DROPS (no such column) — version-less lines
    // from a stale seeded shim keep ingesting unchanged (additive-only evolution).
    bindings.shim_version = HERMES_SHIM_VERSION;
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
  // The SESSION pid is the shim's PARENT (hermes), never the short-lived shim
  // process. The start_time probe is a LAZY thunk — the pure builder calls it at
  // most once, only when minting a self-seeded SessionStart (so a launcher-owned
  // or non-SessionStart line forks no `ps`).
  const line = buildHermesEventLine(
    raw,
    process.env,
    Date.now() / 1000,
    process.ppid,
    () => probeParentStartTime(process.ppid),
  );
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

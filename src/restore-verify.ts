/**
 * restore-verify — the per-tab VERIFIED restore transaction.
 *
 * Restore is not "the window was created" — it is "the harness re-attached to its
 * exact prior conversation, proven from on-disk attach evidence". This module owns
 * that proof plus the durable intent artifact that makes a failed restore visible
 * and idempotently retryable:
 *
 *  - INTENT ARTIFACT. A schema-versioned, 0600, fsync+atomic side file written
 *    BEFORE each launch (state dir, `KEEPER_RESTORE_INTENT_DIR`-overridable),
 *    carrying everything a human rerun needs — generation, job id, harness, native
 *    target, resolved cwd, argv, the exact rerun command, attempt count, state,
 *    reason. A `verified` write drops the tab off the resurface list (verified ∉
 *    the OPEN states) and doubles as the live-UUID no-op marker; GC reaps it past
 *    the idle cutoff. A `failed` / `launched-unverified` / `preflight_failed`
 *    artifact survives so the tab resurfaces in `keeper tabs list` until it verifies.
 *
 *  - VERIFICATION. Daemon-down-safe, reads on-disk EVIDENCE only (never a socket,
 *    never a launch exit code): a claude attach is a `SessionStart` for the EXACT
 *    requested session id in the per-pid events-log NDJSON (complete-line reads via
 *    the shared {@link parseEventLogLine}); a non-claude attach is the birth record
 *    carrying the resumed job id. A bounded wait (injected clock/sleep/retry seam)
 *    then disambiguates by pane liveness — a dead pane is `failed`, a live pane
 *    with no evidence is `launched-unverified` (a warn, NEVER a false `verified`).
 *
 *  - IDEMPOTENCY. A retry re-derives resolution from scratch, no-ops when the
 *    session UUID is already live, holds a per-apply advisory flock (a concurrent
 *    live holder is an idempotent success), and honors the crash-loop bound (two
 *    auto-attempts per tab per generation, then on-demand only).
 *
 * Pure logic + injected seams throughout so the full state matrix is unit-tested
 * with zero tmux / daemon. This module reads the events-log + births trees but
 * never writes keeper.db.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseBirthRecord } from "./birth-record";
import { parseEventLogLine } from "./dead-letter";
import { FileLock } from "./usage-flock";

// ---------------------------------------------------------------------------
// The durable per-tab intent artifact
// ---------------------------------------------------------------------------

/** Bumped only on an incompatible intent-artifact shape change; a reader rejects
 *  an unknown version rather than mis-folding a stale generation's intent. */
export const RESTORE_INTENT_SCHEMA_VERSION = 1;

/**
 * The lifecycle of one restored tab:
 *  - `planned` — intent written, launch not yet attempted (a crash here leaves a
 *    resumable artifact).
 *  - `preflight_failed` — resolution could not anchor a launch (never launched).
 *  - `launched` — the launch transport returned OK; verification pending.
 *  - `verified` — attach evidence observed; the marker leaves the resurface list
 *    (GC reaps it later) and gates the live-UUID no-op.
 *  - `failed` — the launch transport failed, OR the pane died with no evidence.
 *  - `launched-unverified` — launched, no evidence inside the bound, pane still
 *    alive: unconfirmed, surfaced as a warn (never a false `verified`/`failed`).
 */
export type RestoreIntentState =
  | "planned"
  | "preflight_failed"
  | "launched"
  | "verified"
  | "failed"
  | "launched-unverified";

/** The states whose artifact SURVIVES (resurfaces in `keeper tabs list` until the
 *  tab verifies). `verified` clears; `planned`/`launched` are transient in-flight. */
export const OPEN_INTENT_STATES: ReadonlySet<RestoreIntentState> = new Set([
  "preflight_failed",
  "failed",
  "launched-unverified",
]);

/** One restored tab's durable intent. Everything a human (or an idempotent retry)
 *  needs to re-run the exact restore, plus the attach-verification state machine. */
export interface RestoreIntent {
  schema_version: number;
  /** The dead generation this restore targets; "" on the killed-cohort fallback. */
  generation_id: string;
  /** Keeper job identity carried into the resume (the non-claude evidence key). */
  job_id: string;
  /** The harness-native resume key / claude session id — the live-UUID no-op key. */
  session_uuid: string;
  harness: string;
  resume_target: string;
  /** Disk-anchored launch cwd. */
  cwd: string;
  backend_exec_session_id: string;
  /** The launch argv, recorded verbatim for forensics. */
  argv: string[];
  /** The exact one-command idempotent rerun. */
  rerun_command: string;
  /** Auto-attempt count for this tab in this generation (crash-loop bound). */
  attempt: number;
  state: RestoreIntentState;
  /** Failure / unverified diagnosis; "" when none. */
  reason: string;
  created_at: string;
  updated_at: string;
}

/** `KEEPER_RESTORE_INTENT_DIR` wins; else `~/.local/state/keeper/restore-intents`. */
export function resolveRestoreIntentDir(env: NodeJS.ProcessEnv): string {
  const override = (env.KEEPER_RESTORE_INTENT_DIR ?? "").trim();
  if (override !== "") {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "restore-intents");
}

/** `KEEPER_RESTORE_APPLY_LOCK` wins; else a fixed leaf under the intent dir. The
 *  per-apply advisory flock file (identity content is diagnostic only — flock
 *  locks the open-file-description, not the bytes). */
export function resolveRestoreApplyLockPath(env: NodeJS.ProcessEnv): string {
  const override = (env.KEEPER_RESTORE_APPLY_LOCK ?? "").trim();
  if (override !== "") {
    return override;
  }
  return join(resolveRestoreIntentDir(env), "apply.lock");
}

/** Filesystem-safe token for a key segment. Collapses every non-alnum run to `-`
 *  so a session uuid / generation id keys a stable, injection-free filename. */
function fsToken(value: string): string {
  const t = value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t === "" ? "none" : t;
}

/** The per-tab artifact filename, keyed on (generation, session-uuid|job-id) so a
 *  stale prior generation's intent never collides with the just-lost one. */
export function restoreIntentFileName(intent: {
  generation_id: string;
  session_uuid: string;
  job_id: string;
}): string {
  const id = intent.session_uuid !== "" ? intent.session_uuid : intent.job_id;
  return `${fsToken(intent.generation_id)}.${fsToken(id)}.json`;
}

/**
 * Validate + normalize one parsed intent, or `null` for a torn / malformed /
 * wrong-version record (skip, never fold a poison value). Mirrors the birth /
 * event record parse discipline: every typed field is checked.
 */
export function parseRestoreIntent(text: string): RestoreIntent | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const isStr = (v: unknown): v is string => typeof v === "string";
  if (
    o.schema_version !== RESTORE_INTENT_SCHEMA_VERSION ||
    !isStr(o.generation_id) ||
    !isStr(o.job_id) ||
    !isStr(o.session_uuid) ||
    !isStr(o.harness) ||
    !isStr(o.resume_target) ||
    !isStr(o.cwd) ||
    !isStr(o.backend_exec_session_id) ||
    !Array.isArray(o.argv) ||
    !o.argv.every((a) => typeof a === "string") ||
    !isStr(o.rerun_command) ||
    typeof o.attempt !== "number" ||
    !Number.isInteger(o.attempt) ||
    !isValidState(o.state) ||
    !isStr(o.reason) ||
    !isStr(o.created_at) ||
    !isStr(o.updated_at)
  ) {
    return null;
  }
  return {
    schema_version: RESTORE_INTENT_SCHEMA_VERSION,
    generation_id: o.generation_id,
    job_id: o.job_id,
    session_uuid: o.session_uuid,
    harness: o.harness,
    resume_target: o.resume_target,
    cwd: o.cwd,
    backend_exec_session_id: o.backend_exec_session_id,
    argv: o.argv as string[],
    rerun_command: o.rerun_command,
    attempt: o.attempt,
    state: o.state,
    reason: o.reason,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

function isValidState(v: unknown): v is RestoreIntentState {
  return (
    v === "planned" ||
    v === "preflight_failed" ||
    v === "launched" ||
    v === "verified" ||
    v === "failed" ||
    v === "launched-unverified"
  );
}

/**
 * Atomically write one intent (0600, fsync, tmp→rename) so a launcher killed
 * mid-write never leaves a half-record the reader folds. The `intent` is the
 * source of truth for a rerun — it is fsynced BEFORE the launch it describes.
 */
export function writeRestoreIntent(dir: string, intent: RestoreIntent): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = restoreIntentFileName(intent);
  const tmpPath = join(dir, `.${name}.tmp.${process.pid}`);
  const finalPath = join(dir, name);
  const content = `${JSON.stringify(intent)}\n`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}

/** Read one intent by key, or `null` when absent / unparseable. */
export function readRestoreIntent(
  dir: string,
  key: { generation_id: string; session_uuid: string; job_id: string },
): RestoreIntent | null {
  const path = join(dir, restoreIntentFileName(key));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseRestoreIntent(text);
}

/**
 * Read every intent artifact in the dir, newest-`updated_at`-first. A malformed /
 * torn file is skipped (never crashes the list). Directory-absent → empty.
 */
export function listRestoreIntents(dir: string): RestoreIntent[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RestoreIntent[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const intent = parseRestoreIntent(text);
    if (intent !== null) {
      out.push(intent);
    }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

/** The OPEN (unverified, resurface-worthy) intents — the `keeper tabs list`
 *  retry surface. A `verified` artifact is already cleared; a transient
 *  `planned`/`launched` one is filtered here so only actionable failures show. */
export function listOpenRestoreIntents(dir: string): RestoreIntent[] {
  return listRestoreIntents(dir).filter((i) => OPEN_INTENT_STATES.has(i.state));
}

/** The idle cutoff past which a stale intent is GC'd (never re-offered). 7 days,
 *  in milliseconds. */
export const RESTORE_INTENT_IDLE_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sweep intents whose file mtime is older than the idle cutoff so a stale prior
 * generation's artifact never resurfaces forever. Best-effort per file (a
 * vanished/locked file is skipped). Returns the count swept. `nowMs` injected for
 * tests.
 */
export function gcRestoreIntents(
  dir: string,
  nowMs: number,
  cutoffMs: number = RESTORE_INTENT_IDLE_CUTOFF_MS,
): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (nowMs - st.mtimeMs > cutoffMs) {
        unlinkSync(path);
        swept++;
      }
    } catch {
      // vanished / unreadable — skip.
    }
  }
  return swept;
}

// ---------------------------------------------------------------------------
// Crash-loop bound — browsers cap auto-restore attempts per tab
// ---------------------------------------------------------------------------

/** Auto-restore attempts per tab per generation before restore falls back to
 *  on-demand only (a human `keeper tabs restore --apply` past the bound). */
export const RESTORE_AUTO_ATTEMPT_CAP = 2;

/**
 * Whether an AUTO restore may attempt this tab again, given its prior intent (or
 * `null` for a never-attempted tab). At/over the cap, auto is refused — a human
 * rerun is still allowed (the caller passes `auto=false`). Pure.
 */
export function mayAttemptRestore(
  prior: RestoreIntent | null,
  auto: boolean,
): boolean {
  if (!auto) {
    return true;
  }
  const attempts = prior?.attempt ?? 0;
  return attempts < RESTORE_AUTO_ATTEMPT_CAP;
}

/** The on-demand hint surfaced when an auto attempt is refused at the bound. */
export function crashLoopHint(intent: {
  generation_id: string;
  backend_exec_session_id: string;
}): string {
  const genArg =
    intent.generation_id !== "" ? ` --generation ${intent.generation_id}` : "";
  return (
    `auto-restore bound reached (${RESTORE_AUTO_ATTEMPT_CAP} attempts) — ` +
    `rerun on demand: keeper tabs restore --apply${genArg} ` +
    `--session ${intent.backend_exec_session_id}`
  );
}

// ---------------------------------------------------------------------------
// Attach evidence — daemon-down, on-disk only
// ---------------------------------------------------------------------------

/**
 * Read the complete `\n`-terminated lines of one text body, dropping any trailing
 * partial (a torn tail a killed writer left mid-line). The evidence read never
 * consumes a partial record — mirrors the ingester's complete-line contract.
 */
export function completeLines(text: string): string[] {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) {
    return [];
  }
  return text.slice(0, lastNl).split("\n");
}

/** True when an event/record timestamp (ms) satisfies the recency gate. `sinceMs
 *  <= 0` is an ungated match (any timestamp, incl. an unparseable one); a positive
 *  gate requires a finite timestamp at or after it — so a STALE pre-crash record
 *  can never prove a fresh post-relaunch attach. Pure. */
function tsSatisfies(tsMs: number, sinceMs: number): boolean {
  if (sinceMs <= 0) {
    return true;
  }
  return Number.isFinite(tsMs) && tsMs >= sinceMs;
}

/**
 * True iff the per-pid events-log NDJSON carries a `SessionStart` for the EXACT
 * requested claude session id AT OR AFTER `sinceMs` — the sole claude attach
 * proof. Reads every `<pid>.ndjson` in `dir`, parses only complete lines via the
 * shared {@link parseEventLogLine}, and matches on `bindings.session_id` +
 * `bindings.hook_event === "SessionStart"`. The `sinceMs` gate (a wall-clock ms,
 * default 0 = ungated) is load-bearing: a resume re-fires SessionStart under the
 * SAME id, so a post-launch verify passes `sinceMs = launchStart` to reject the
 * stale pre-crash record; a live-check passes `now - recency`. Directory-absent /
 * unreadable → false. Pure over the fs read.
 */
export function claudeAttachEvidence(
  dir: string,
  sessionId: string,
  sinceMs = 0,
): boolean {
  if (sessionId === "") {
    return false;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".ndjson")) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of completeLines(text)) {
      const record = parseEventLogLine(line);
      if (record === null) {
        continue;
      }
      const b = record.bindings;
      if (b.session_id === sessionId && b.hook_event === "SessionStart") {
        const tsMs = typeof b.ts === "number" ? b.ts * 1000 : Number.NaN;
        if (tsSatisfies(tsMs, sinceMs)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * True iff a birth record in the births `new/` tree carries the resumed job id
 * with a `launch_ts` AT OR AFTER `sinceMs` — the non-claude attach proof
 * (codex/pi/hermes fire no SessionStart hook). Reads every `*.json`, parses via
 * the shared {@link parseBirthRecord}, matches on `session_id`. The `sinceMs` gate
 * (default 0 = ungated) rejects a stale pre-crash birth the daemon-down restore
 * never retired. Directory-absent → false.
 */
export function nonClaudeAttachEvidence(
  birthDir: string,
  jobId: string,
  sinceMs = 0,
): boolean {
  if (jobId === "") {
    return false;
  }
  const newDir = join(birthDir, "new");
  let names: string[];
  try {
    names = readdirSync(newDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(newDir, name), "utf8");
    } catch {
      continue;
    }
    const record = parseBirthRecord(text);
    if (record !== null && record.session_id === jobId) {
      const tsMs = Date.parse(record.launch_ts);
      if (tsSatisfies(tsMs, sinceMs)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pane liveness — the timeout disambiguator
// ---------------------------------------------------------------------------

/** A pane's harness-liveness verdict. `unknown` never grants `verified`/`failed`. */
export type PaneLiveness = "alive" | "dead" | "unknown";

/** Foreground commands that mean the harness process is GONE — the pane has fallen
 *  back to the wrapper's login shell (`exec "$0" -l -i`). A pane running one of
 *  these has no live harness, so a no-evidence timeout is a `failed`, not merely
 *  `unverified`. */
const SHELL_TAIL_COMMANDS: ReadonlySet<string> = new Set([
  "bash",
  "-bash",
  "sh",
  "-sh",
  "zsh",
  "-zsh",
  "fish",
  "-fish",
  "dash",
  "-dash",
]);

/**
 * Classify a pane's harness liveness from tmux's `#{pane_dead}` +
 * `#{pane_current_command}`. A dead pane (`pane_dead == "1"`) is `dead`; a live
 * pane running the wrapper's login-shell tail is also `dead` (the harness exited
 * and dropped to the shell); a live pane running any other command is `alive`; an
 * empty/unreadable command is `unknown`. Pure.
 */
export function classifyPaneLiveness(
  paneDead: string,
  currentCommand: string,
): PaneLiveness {
  if (paneDead.trim() === "1") {
    return "dead";
  }
  const cmd = currentCommand.trim();
  if (cmd === "") {
    return "unknown";
  }
  return SHELL_TAIL_COMMANDS.has(cmd) ? "dead" : "alive";
}

// ---------------------------------------------------------------------------
// The bounded verification loop
// ---------------------------------------------------------------------------

/** The terminal attach verdict. */
export type AttachVerdict = "verified" | "failed" | "launched-unverified";

/** Default bounded wait for attach evidence (~20s) and the poll interval. */
export const RESTORE_VERIFY_TIMEOUT_MS = 20_000;
export const RESTORE_VERIFY_POLL_MS = 500;

/** Injected seams for {@link verifyAttach} — every non-pure dependency, so the
 *  full state matrix is unit-tested with zero fs / tmux / real clock. */
export interface VerifyAttachDeps {
  /** Reads on-disk attach evidence (claude NDJSON or non-claude birth record). */
  hasEvidence: () => boolean;
  /** Probes the pane's harness liveness — consulted ONLY on the no-evidence
   *  timeout, to split `failed` (dead) from `launched-unverified` (alive/unknown). */
  paneLiveness: () => PaneLiveness;
  /** Monotonic clock (ms). */
  now: () => number;
  /** Poll sleep. */
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Poll for attach evidence up to the bound, then disambiguate. `verified` the
 * instant evidence is observed. On a no-evidence timeout: a DEAD pane is `failed`
 * (the resume died), a live/unknown pane is `launched-unverified` (a warn — never
 * a false `verified`, and a launch exit code alone never reaches here). The clock
 * and sleep are injected so tests drive the timeout deterministically.
 */
export async function verifyAttach(
  deps: VerifyAttachDeps,
): Promise<AttachVerdict> {
  const timeoutMs = deps.timeoutMs ?? RESTORE_VERIFY_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? RESTORE_VERIFY_POLL_MS;
  const start = deps.now();
  if (deps.hasEvidence()) {
    return "verified";
  }
  while (deps.now() - start < timeoutMs) {
    await deps.sleep(pollMs);
    if (deps.hasEvidence()) {
      return "verified";
    }
  }
  return deps.paneLiveness() === "dead" ? "failed" : "launched-unverified";
}

// ---------------------------------------------------------------------------
// Per-apply advisory flock — identity-carrying, concurrent-holder-is-success
// ---------------------------------------------------------------------------

/** The identity written into the lock file (diagnostic only — flock guards the
 *  open-file-description, not the bytes). {pid, start-ts, uuid} disambiguates the
 *  holder under macOS PID reuse. */
export interface ApplyLockIdentity {
  pid: number;
  startTs: string;
  uuid: string;
}

/**
 * Try to take the per-apply advisory flock without blocking. Returns the held
 * {@link FileLock} (release it when the apply completes) or `null` when another
 * LIVE apply already holds it — a concurrent holder is an IDEMPOTENT SUCCESS (the
 * caller no-ops, never double-spawns), not an error. The identity is best-effort
 * stamped into the file for diagnostics. Never throws on the identity write.
 */
export function tryAcquireApplyLock(
  lockPath: string,
  identity: ApplyLockIdentity,
): FileLock | null {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = FileLock.tryAcquire(lockPath);
  if (lock === null) {
    return null;
  }
  try {
    const fd = openSync(lockPath, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(identity)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Identity stamp is diagnostic only — never fail the lock over it.
  }
  return lock;
}

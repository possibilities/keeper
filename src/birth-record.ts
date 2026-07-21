/**
 * Birth records — the non-hook presence channel for Pi.
 *
 * The `keeper agent` launcher cannot write keeper.db (it is a db-free cold-start
 * path), and a claude session announces its own presence through the SessionStart
 * hook. Pi fires no such hook, so the launcher instead drops a BIRTH
 * RECORD the moment it spawns the harness child: a maildir-style file the
 * birth-ingest worker reacts to and turns into a MAIN-minted synthetic
 * SessionStart. This module is that record's contract — the shape, the
 * serialize/parse round-trip, the atomic maildir write, and the child start_time
 * probe — nothing else.
 *
 * SCOPE: PI only. claude's hook SessionStart is authoritative for both
 * presence and resume identity; a second birth seed would double-fire the fold's
 * revive arm.
 *
 * DEP-FREE ISLAND: `node:*` plus the pure `./exec-backend` env-name helper only —
 * never `./db` / `bun:sqlite`. It rides the cold-start launcher path (pinned
 * db-free), so it must never drag the daemon's DB graph. Pure data + fs io.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DISPATCH_ATTEMPT_ENV,
  parseDispatchAttemptCarrier,
} from "./dispatch-command";
import { execBackendEnvMeta, isDefaultTmuxEnvValue } from "./exec-backend";

/** The current birth-record protocol version the launcher emits. Bumped on an
 *  incompatible shape change; the ingest worker rejects an UNKNOWN version
 *  (outside {@link SUPPORTED_BIRTH_RECORD_VERSIONS}) rather than mis-folding it. */
export const BIRTH_RECORD_SCHEMA_VERSION = 2;

/**
 * The protocol version at which a birth record may carry the durable wrapper→leg
 * owner tuple (ADR 0071). A record BELOW this version is legacy and is never
 * enrolled into `provider_leg_ownership`; the classification is by protocol
 * version alone, never inferred from which owner fields happen to be null.
 */
export const OWNED_LEG_BIRTH_PROTOCOL_VERSION = 2;

/**
 * Every birth-record protocol version the ingest worker still accepts. Legacy v1
 * records remain ingestible (they mint the presence SessionStart and drain via
 * the old autoclose path) but classify as ownerless; the current-cohort v2 adds
 * the owner tuple. A version outside this set is rejected, not mis-folded.
 */
export const SUPPORTED_BIRTH_RECORD_VERSIONS: ReadonlySet<number> = new Set([
  1,
  OWNED_LEG_BIRTH_PROTOCOL_VERSION,
]);

/**
 * One harness birth: the launcher's snapshot of a freshly-spawned Pi
 * session, complete enough for the ingest worker to mint a synthetic
 * SessionStart WITHOUT re-reading any live process or env.
 *
 * `session_id` is the keeper job identity (becomes `jobs.job_id`): Pi pins it at
 * launch. `resume_target` is the harness-native id a resume reuses. `pid` +
 * `start_time` are the recycle-safe identity
 * (the child's, never the launcher wrapper's).
 */
export interface BirthRecord {
  schema_version: number;
  /** Keeper job identity — folds to `jobs.job_id`. */
  session_id: string;
  /** Harness name (`pi`; never `claude`). */
  harness: "pi";
  /** The spawned harness CHILD's pid (not the launcher wrapper's). */
  pid: number;
  /** Platform-tagged child start_time (`darwin:<lstart>` / `linux:<jiffies>`),
   *  or null when the probe could not read it. */
  start_time: string | null;
  cwd: string;
  /** Session display name / title, or null when none was resolved. */
  spawn_name: string | null;
  /** Harness config/profile dir, or null. */
  config_dir: string | null;
  /** tmux backend coordinates (absent-tolerated; a launch outside tmux records
   *  all-null, never a fabricated `type`). */
  backend_exec_type: string | null;
  backend_exec_session_id: string | null;
  backend_exec_pane_id: string | null;
  /** Worktree-lane git ref, or null. */
  worktree: string | null;
  /** Launch wall-clock (ISO 8601). */
  launch_ts: string;
  /** Harness-native resume id, or null when back-filled later. */
  resume_target: string | null;
  /** Exact Dispatch attempt carried by a capable lifecycle adapter, or null for
   *  manual, legacy, malformed, and capability-absent launches. */
  dispatch_attempt_id: number | null;
  /**
   * Immutable identity of this Provider-leg launch (ADR 0071). Present only on a
   * v2 owned-leg birth; the ownership registry's idempotency key core. ABSENT
   * (not null) on a legacy v1 record and on a non-wrapped v2 launch — a legacy
   * record is classified by protocol version, never by this field's presence.
   */
  leg_launch_id?: string;
  /** Owner tuple part 1: the keeper job id of the wrapper attempt that launched
   *  this leg. Present only alongside {@link leg_launch_id} on a v2 owned leg. */
  wrapper_job_id?: string;
  /** Owner tuple part 2: the wrapper's exact Dispatch-attempt id. Present only
   *  alongside {@link leg_launch_id} on a v2 owned leg. */
  wrapper_dispatch_attempt_id?: number;
  /** The launcher process's own pid (distinct from the spawned leg's {@link pid}).
   *  Present only on a v2 owned-leg birth. */
  launcher_pid?: number;
  /** The launcher process's platform-tagged start_time (recycle-safe identity of
   *  the launcher, distinct from the leg's {@link start_time}). v2 owned legs. */
  launcher_start_time?: string;
}

/** The record MINUS the two post-spawn fields the launcher cannot know until it
 *  has the child: everything the launcher assembles up front. */
export type BirthRecordDraft = Omit<BirthRecord, "pid" | "start_time">;

export const BIRTH_INTENT_SCHEMA_VERSION = 1;

export const PROVIDER_LEG_GATE_ENV = "KEEPER_AGENT_PROVIDER_LEG_GATE";
export const PROVIDER_LEG_LAUNCH_ID_ENV = "KEEPER_AGENT_PROVIDER_LEG_LAUNCH_ID";
export const PROVIDER_LEG_WRAPPER_JOB_ID_ENV =
  "KEEPER_AGENT_PROVIDER_LEG_WRAPPER_JOB_ID";
export const PROVIDER_LEG_WRAPPER_ATTEMPT_ENV =
  "KEEPER_AGENT_PROVIDER_LEG_WRAPPER_ATTEMPT_ID";
export const PROVIDER_LEG_LAUNCHER_PID_ENV =
  "KEEPER_AGENT_PROVIDER_LEG_LAUNCHER_PID";
export const PROVIDER_LEG_LAUNCHER_START_TIME_ENV =
  "KEEPER_AGENT_PROVIDER_LEG_LAUNCHER_START_TIME";
export const PROVIDER_LEG_SHIM_PROCESS_TITLE = "keeper-provider-leg-shim";
export const PROVIDER_LEG_GRANT_TIMEOUT_MS = 30_000;
export const PROVIDER_LEG_GRANT_POLL_MS = 50;

export interface ProviderLegLaunchCarrier extends BirthOwnerTuple {
  launcher_pid: number;
  launcher_start_time: string;
}

export type ProviderLegLaunchCarrierResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; carrier: ProviderLegLaunchCarrier };

/** Parse the complete, bounded shim carrier. A gate marker is fail-closed: once
 * present, every identity field must be valid before a provider may execute. */
export function parseProviderLegLaunchCarrier(
  env: NodeJS.ProcessEnv,
): ProviderLegLaunchCarrierResult {
  if ((env[PROVIDER_LEG_GATE_ENV] ?? "") === "") {
    return { kind: "absent" };
  }
  const legLaunchId = (env[PROVIDER_LEG_LAUNCH_ID_ENV] ?? "").trim();
  const wrapperJobId = (env[PROVIDER_LEG_WRAPPER_JOB_ID_ENV] ?? "").trim();
  const wrapperAttemptId = parseDispatchAttemptCarrier(
    env[PROVIDER_LEG_WRAPPER_ATTEMPT_ENV],
  );
  const launcherPidRaw = env[PROVIDER_LEG_LAUNCHER_PID_ENV];
  const launcherPid =
    launcherPidRaw !== undefined && /^[1-9]\d{0,15}$/.test(launcherPidRaw)
      ? Number(launcherPidRaw)
      : null;
  const launcherStartTime = (
    env[PROVIDER_LEG_LAUNCHER_START_TIME_ENV] ?? ""
  ).trim();
  if (
    legLaunchId === "" ||
    legLaunchId.length > 256 ||
    wrapperJobId === "" ||
    wrapperJobId.length > 256 ||
    wrapperAttemptId === null ||
    launcherPid === null ||
    !Number.isSafeInteger(launcherPid) ||
    launcherStartTime === "" ||
    launcherStartTime.length > 256
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    carrier: {
      leg_launch_id: legLaunchId,
      wrapper_job_id: wrapperJobId,
      wrapper_dispatch_attempt_id: wrapperAttemptId,
      launcher_pid: launcherPid,
      launcher_start_time: launcherStartTime,
    },
  };
}

/** Pre-spawn presence marker. It is published before a Pi child can exist. */
export interface BirthIntent {
  schema_version: number;
  session_id: string;
  harness: "pi";
  launcher_pid: number;
  launch_ts: string;
}

export function serializeBirthIntent(intent: BirthIntent): string {
  return `${JSON.stringify(intent)}\n`;
}

export function parseBirthIntent(body: string): BirthIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.schema_version !== BIRTH_INTENT_SCHEMA_VERSION ||
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    value.harness !== "pi" ||
    typeof value.launcher_pid !== "number" ||
    !Number.isSafeInteger(value.launcher_pid) ||
    value.launcher_pid <= 0 ||
    typeof value.launch_ts !== "string" ||
    value.launch_ts.length === 0
  ) {
    return null;
  }
  return {
    schema_version: BIRTH_INTENT_SCHEMA_VERSION,
    session_id: value.session_id,
    harness: "pi",
    launcher_pid: value.launcher_pid,
    launch_ts: value.launch_ts,
  };
}

/**
 * Serialize one record to a single NDJSON line terminated by `\n`. Pure: same
 * input → same output. One record per file, so the trailing newline is a
 * courtesy delimiter (the reader parses the whole file body), not load-bearing.
 */
export function serializeBirthRecord(record: BirthRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse one record body, or return `null` for a torn / partial / malformed
 * record. The ingest worker treats `null` as "skip, do not fold" — a launcher
 * killed mid-write (before the atomic rename) must never surface a half-record,
 * and every typed field is validated so a corrupt file can never fold a poison
 * value onto a jobs row. The `\n` terminator is optional on input.
 */
export function parseBirthRecord(line: string): BirthRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
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
  const isStrOrNull = (v: unknown): v is string | null =>
    v === null || typeof v === "string";
  if (
    typeof o.schema_version !== "number" ||
    !Number.isInteger(o.schema_version) ||
    !SUPPORTED_BIRTH_RECORD_VERSIONS.has(o.schema_version) ||
    !isStr(o.session_id) ||
    o.session_id === "" ||
    o.harness !== "pi" ||
    typeof o.pid !== "number" ||
    !Number.isSafeInteger(o.pid) ||
    o.pid <= 0 ||
    !isStrOrNull(o.start_time) ||
    !isStr(o.cwd) ||
    !isStrOrNull(o.spawn_name) ||
    !isStrOrNull(o.config_dir) ||
    !isStrOrNull(o.backend_exec_type) ||
    !isStrOrNull(o.backend_exec_session_id) ||
    !isStrOrNull(o.backend_exec_pane_id) ||
    !isStrOrNull(o.worktree) ||
    !isStr(o.launch_ts) ||
    !isStrOrNull(o.resume_target)
  ) {
    return null;
  }
  const record: BirthRecord = {
    // Preserve the PARSED version, not the current constant: a legacy v1 record
    // stays v1 so the ownership classifier can key on protocol version.
    schema_version: o.schema_version,
    session_id: o.session_id,
    harness: o.harness,
    pid: o.pid,
    start_time: o.start_time,
    cwd: o.cwd,
    spawn_name: o.spawn_name,
    config_dir: o.config_dir,
    backend_exec_type: o.backend_exec_type,
    backend_exec_session_id: o.backend_exec_session_id,
    backend_exec_pane_id: o.backend_exec_pane_id,
    worktree: o.worktree,
    launch_ts: o.launch_ts,
    resume_target: o.resume_target,
    // Additive compatibility: records from a producer without this carrier
    // remain valid and fold as unfenced evidence.
    dispatch_attempt_id:
      typeof o.dispatch_attempt_id === "number" &&
      Number.isSafeInteger(o.dispatch_attempt_id) &&
      o.dispatch_attempt_id > 0
        ? o.dispatch_attempt_id
        : null,
  };
  // Owner tuple + launcher identity (ADR 0071) is read ONLY at the owned-leg
  // protocol version. A legacy record never carries it — the leg-ownership
  // classification is by version, never by a field being present, so a v1 body
  // that happens to include these keys is still treated as legacy/ownerless.
  if (o.schema_version >= OWNED_LEG_BIRTH_PROTOCOL_VERSION) {
    if (isStr(o.leg_launch_id) && o.leg_launch_id.length > 0) {
      record.leg_launch_id = o.leg_launch_id;
    }
    if (isStr(o.wrapper_job_id) && o.wrapper_job_id.length > 0) {
      record.wrapper_job_id = o.wrapper_job_id;
    }
    if (
      typeof o.wrapper_dispatch_attempt_id === "number" &&
      Number.isSafeInteger(o.wrapper_dispatch_attempt_id) &&
      o.wrapper_dispatch_attempt_id > 0
    ) {
      record.wrapper_dispatch_attempt_id = o.wrapper_dispatch_attempt_id;
    }
    if (
      typeof o.launcher_pid === "number" &&
      Number.isSafeInteger(o.launcher_pid) &&
      o.launcher_pid > 0
    ) {
      record.launcher_pid = o.launcher_pid;
    }
    if (isStr(o.launcher_start_time) && o.launcher_start_time.length > 0) {
      record.launcher_start_time = o.launcher_start_time;
    }
  }
  return record;
}

/**
 * The durable owner tuple (ADR 0071) — the exact wrapper Dispatch attempt that
 * launched a Provider leg, plus that leg's immutable launch id. Returned only for
 * a fully-formed OWNED-leg birth; a legacy or ownerless record yields null and is
 * never enrolled into the ownership registry.
 */
export interface BirthOwnerTuple {
  leg_launch_id: string;
  wrapper_job_id: string;
  wrapper_dispatch_attempt_id: number;
}

/**
 * True when `record` is a legacy (pre-owned-leg) protocol birth. Classified by
 * protocol version ALONE — the ADR 0071 rule that legacy is never inferred from
 * null owner fields.
 */
export function birthRecordIsLegacyProtocol(record: BirthRecord): boolean {
  return record.schema_version < OWNED_LEG_BIRTH_PROTOCOL_VERSION;
}

/**
 * The owner tuple to enroll for `record`, or null. Non-null ONLY for a v2 record
 * carrying a complete tuple: a legacy v1 record, or a v2 non-wrapped launch with
 * no tuple, both yield null and stay off the cascade.
 */
export function ownerTupleFromBirthRecord(
  record: BirthRecord,
): BirthOwnerTuple | null {
  if (
    record.schema_version < OWNED_LEG_BIRTH_PROTOCOL_VERSION ||
    record.leg_launch_id === undefined ||
    record.wrapper_job_id === undefined ||
    record.wrapper_dispatch_attempt_id === undefined
  ) {
    return null;
  }
  return {
    leg_launch_id: record.leg_launch_id,
    wrapper_job_id: record.wrapper_job_id,
    wrapper_dispatch_attempt_id: record.wrapper_dispatch_attempt_id,
  };
}

/** Fixed per-user birth tree used by production launch, ingest, and authority reads. */
export function defaultBirthDir(): string {
  return join(userInfo().homedir, ".local", "state", "keeper", "births");
}

/** Explicit configuration/test resolver; authority-sensitive callers use the fixed default. */
export function resolveBirthDir(env: NodeJS.ProcessEnv): string {
  const override = (env.KEEPER_BIRTH_DIR ?? "").trim();
  return override !== "" ? override : defaultBirthDir();
}

/** Filesystem-safe token for the (pid, start_time) idempotency key. */
function startTimeToken(startTime: string | null): string {
  return (startTime ?? "unknown").replace(/[^A-Za-z0-9]+/g, "-");
}

/**
 * Maildir-style atomic write: stage the WHOLE record into `<dir>/tmp/<name>`
 * with one `write(2)` + `fsync`, then `rename` it into `<dir>/new/<name>` (a
 * same-filesystem atomic move-in the consumer reacts to — it never sees a
 * create-then-fill file, so a killed launcher leaves no partial in `new/`).
 * Idempotent on `(pid, start_time)`: the filename keys on both, so a re-announce
 * of the same session overwrites rather than duplicates.
 */
export function writeBirthRecord(dir: string, record: BirthRecord): void {
  const tmpDir = join(dir, "tmp");
  const newDir = join(dir, "new");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const name = `${record.pid}.${startTimeToken(record.start_time)}.json`;
  const tmpPath = join(tmpDir, name);
  const content = serializeBirthRecord(record);
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, join(newDir, name));
}

/**
 * Publish a pre-spawn marker before the Pi child can exist. A stale intent is
 * deliberately fail-closed: only successful birth publication consumes it.
 */
export function writeBirthIntent(
  dir: string,
  draft: BirthRecordDraft,
  launcherPid: number = process.pid,
): string {
  const pendingDir = join(dir, "pending");
  mkdirSync(pendingDir, { recursive: true });
  const name = `${launcherPid}.${randomUUID()}.json`;
  const staged = join(pendingDir, `.${name}.tmp`);
  const published = join(pendingDir, name);
  const content = serializeBirthIntent({
    schema_version: BIRTH_INTENT_SCHEMA_VERSION,
    session_id: draft.session_id,
    harness: "pi",
    launcher_pid: launcherPid,
    launch_ts: draft.launch_ts,
  });
  const fd = openSync(staged, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // best effort; the non-.json stage is never authority-visible
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(staged, published);
  return published;
}

/** Atomically replace an intent with its complete promoted birth in pending/. */
export function promoteBirthIntent(
  intentPath: string,
  record: BirthRecord,
): void {
  const pendingDir = dirname(intentPath);
  const staged = join(
    pendingDir,
    `.${basename(intentPath)}.${randomUUID()}.tmp`,
  );
  const fd = openSync(staged, "wx", 0o600);
  try {
    writeSync(fd, serializeBirthRecord(record));
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // best effort; the original intent remains authoritative
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(staged, intentPath);
}

/** Replace an intent atomically with the complete birth, then publish to new/. */
export function publishBirthIntent(
  intentPath: string,
  record: BirthRecord,
): void {
  const pendingDir = dirname(intentPath);
  const root = dirname(pendingDir);
  const newDir = join(root, "new");
  mkdirSync(newDir, { recursive: true });
  // Every crash point remains visible: intent before the first rename, a full
  // birth under pending/ between renames, then the consumer-owned new/ record.
  promoteBirthIntent(intentPath, record);
  renameSync(intentPath, join(newDir, basename(intentPath)));
}

export interface ProviderLegGrant extends BirthOwnerTuple {
  schema_version: 1;
}

function providerLegGrantPath(dir: string, legLaunchId: string): string {
  const token = Buffer.from(legLaunchId, "utf8").toString("base64url");
  return join(dir, "grants", `${token}.json`);
}

/** Publish a one-use pre-exec grant after daemon-side owner revalidation. */
export function writeProviderLegGrant(
  dir: string,
  owner: BirthOwnerTuple,
): void {
  const grantDir = join(dir, "grants");
  mkdirSync(grantDir, { recursive: true });
  const target = providerLegGrantPath(dir, owner.leg_launch_id);
  const staged = join(grantDir, `.${basename(target)}.${randomUUID()}.tmp`);
  const fd = openSync(staged, "wx", 0o600);
  try {
    writeSync(
      fd,
      `${JSON.stringify({ schema_version: 1, ...owner } satisfies ProviderLegGrant)}\n`,
    );
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // best effort
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(staged, target);
}

/** Consume only a grant matching the exact immutable owner tuple. */
export function consumeProviderLegGrant(
  dir: string,
  owner: BirthOwnerTuple,
): boolean {
  const path = providerLegGrantPath(dir, owner.leg_launch_id);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const grant = parsed as Record<string, unknown>;
  if (
    grant.schema_version !== 1 ||
    grant.leg_launch_id !== owner.leg_launch_id ||
    grant.wrapper_job_id !== owner.wrapper_job_id ||
    grant.wrapper_dispatch_attempt_id !== owner.wrapper_dispatch_attempt_id
  ) {
    return false;
  }
  try {
    unlinkSync(path);
  } catch {
    return false;
  }
  return true;
}

/**
 * The bounded gate wait's cause-split outcome:
 *  - `granted` — the exact one-use grant appeared and was consumed; exec.
 *  - `refused` — the daemon cleared the promoted birth record without granting
 *    (a terminal deny: a superseded/foreign/ended owner). Structural — no claim
 *    will ever bind, so the shim stops early instead of burning the whole timeout.
 *  - `timeout` — the deadline elapsed while the birth record was still present (a
 *    lag state — `wrapper-unfolded`/`claim-absent`/`claim-unbound` — that never
 *    resolved before the shim's own life ran out).
 */
export type ProviderLegGateOutcome = "granted" | "refused" | "timeout";

export interface ProviderLegGrantWaitDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  consume: () => boolean;
  /**
   * Whether this leg's own promoted birth record is still on disk. The daemon
   * retires it on EVERY terminal settle (grant retires it too, but a grant is
   * consumed above first), so `false` here with no grant is a positive terminal
   * DENY signal — the shim need not wait out the timeout. Optional: when absent,
   * the wait degrades to the pre-split bounded poll (timeout-or-grant only).
   */
  birthPresent?: () => boolean;
}

/**
 * Hold the inert shim until one exact grant appears, the daemon terminally denies
 * it (its birth record cleared), or the bounded timeout ends. Re-waits the SAME
 * handle for every transient lag; stops early ONLY on a positively terminal deny.
 */
export async function awaitProviderLegGrant(
  deps: ProviderLegGrantWaitDeps,
  timeoutMs = PROVIDER_LEG_GRANT_TIMEOUT_MS,
): Promise<ProviderLegGateOutcome> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (deps.consume()) {
      return "granted";
    }
    // consume() is checked first, so a grant (which the daemon writes BEFORE
    // retiring the birth) is never misread as a deny in the retire window.
    if (deps.birthPresent !== undefined && !deps.birthPresent()) {
      return "refused";
    }
    await deps.sleep(PROVIDER_LEG_GRANT_POLL_MS);
  }
  return deps.consume() ? "granted" : "timeout";
}

/**
 * Retire a leg's own promoted birth record — an idempotent, ENOENT-tolerant
 * unlink. A shim that observed a terminal gate death (deny or timeout) settles its
 * record immediately so no `~5min` stuck-birth GC fossil is minted for an already
 * attributed, explained death (a grant/deny already unlinked it daemon-side, so
 * the common case is a benign no-op). NEVER throws.
 */
export function retireBirthRecord(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone (daemon-cleared, or never promoted) — nothing to settle.
  }
}

export function birthRootFromIntentPath(intentPath: string): string {
  return dirname(dirname(intentPath));
}

// ---------------------------------------------------------------------------
// tmux backend coordinates
// ---------------------------------------------------------------------------

/** tmux backend coords resolved from the launch env. */
export interface BirthBackendCoords {
  type: string | null;
  sessionId: string | null;
  paneId: string | null;
}

/**
 * Resolve tmux backend coordinates from the launch env, mirroring the hook's
 * `backendExecCoordsFromEnv` (plugins/keeper/plugin/hooks/events-writer.ts). The
 * env-var NAMES come from `execBackendEnvMeta` so they live in one place; the
 * two-arm logic is replicated here (no shared module spans the launcher and the
 * hook — the matching comment on both sides is the drift guard).
 *
 * Native arm: under the default tmux socket (`TMUX` set) stamp type + pane id;
 * foreign `tmux -L <name>` sockets are ignored because pane ids are server-local.
 * The session name stamps only when the keeper carrier `KEEPER_TMUX_SESSION` is
 * present. Carrier arm: `TMUX` stripped but `KEEPER_TMUX_PANE` present → stamp
 * from it. No sentinel and no carrier → all-null (never a `type=tmux` row with a
 * null pane — the renamer requires a non-null pane).
 */
export function birthBackendCoordsFromEnv(
  env: NodeJS.ProcessEnv,
): BirthBackendCoords {
  const meta = execBackendEnvMeta("tmux");
  const collapse = (v: string | undefined): string | null =>
    v === undefined || v === "" ? null : v;

  const tmuxSentinel = env.TMUX;
  if (tmuxSentinel !== undefined && tmuxSentinel !== "") {
    if (!isDefaultTmuxEnvValue(tmuxSentinel)) {
      return { type: null, sessionId: null, paneId: null };
    }
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

/** Worktree-lane git ref from `KEEPER_PLAN_WORKTREE_BRANCH`; empty/whitespace →
 *  null. Mirrors the hook's `worktreeBranchFromEnv` (drift-guarded by comment). */
export function birthWorktreeFromEnv(env: NodeJS.ProcessEnv): string | null {
  return (env.KEEPER_PLAN_WORKTREE_BRANCH ?? "").trim() || null;
}

/** Inputs the launcher assembles up front, before it has the child. */
export interface BirthDraftInputs {
  session_id: string;
  harness: "pi";
  cwd: string;
  spawn_name: string | null;
  config_dir: string | null;
  resume_target: string | null;
  launch_ts: string;
}

/**
 * Assemble a {@link BirthRecordDraft} from launcher-known inputs plus the
 * env-derived tmux coords + worktree. The launcher fills pid + start_time
 * post-spawn via {@link emitBirthRecord}.
 */
export function buildBirthDraft(
  env: NodeJS.ProcessEnv,
  inputs: BirthDraftInputs,
): BirthRecordDraft {
  const coords = birthBackendCoordsFromEnv(env);
  const draft: BirthRecordDraft = {
    schema_version: BIRTH_RECORD_SCHEMA_VERSION,
    session_id: inputs.session_id,
    harness: inputs.harness,
    cwd: inputs.cwd,
    spawn_name: inputs.spawn_name,
    config_dir: inputs.config_dir,
    backend_exec_type: coords.type,
    backend_exec_session_id: coords.sessionId,
    backend_exec_pane_id: coords.paneId,
    worktree: birthWorktreeFromEnv(env),
    launch_ts: inputs.launch_ts,
    resume_target: inputs.resume_target,
    dispatch_attempt_id: parseDispatchAttemptCarrier(env[DISPATCH_ATTEMPT_ENV]),
  };
  const gate = parseProviderLegLaunchCarrier(env);
  if (gate.kind === "valid") {
    // The wrapper's Dispatch claim owns this leg. The provider SessionStart must
    // not independently bind or discharge that same claim.
    draft.dispatch_attempt_id = null;
    Object.assign(draft, gate.carrier);
  }
  return draft;
}

// ---------------------------------------------------------------------------
// child start_time probe
// ---------------------------------------------------------------------------

/**
 * Parse the platform-tagged start_time from a darwin `ps -o lstart=` stdout, or
 * null. Copied from `src/proc-starttime.ts`'s `splitArgsLstart` slice (the leaf
 * must stay db-free, and seed-sweep's `readOsStartTime` drags `bun:sqlite`).
 * The 24-char fixed-width ctime(3) `Day Mon DD HH:MM:SS YYYY` shape MUST stay
 * byte-identical to `src/proc-starttime.ts`'s so seed-sweep's verbatim recycle
 * compare holds.
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
 * null. Field 22 (`starttime`, clock ticks since boot). Field 2 (`comm`) may hold
 * spaces/parens, so bracket on the LAST `)` then split. Mirrors
 * `src/proc-starttime.ts`'s `parseLinuxStarttime` (drift-guarded by comment).
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
 * Probe a live child pid's platform-tagged start_time (`darwin:<lstart>` /
 * `linux:<jiffies>`), or null on any failure (unknown platform, ps error,
 * /proc unreadable). Called immediately post-spawn so the recorded start_time
 * pairs with the recorded pid as the recycle-safe `(pid, start_time)` identity.
 * Never throws — every failure lands as null.
 */
export function probeChildStartTime(pid: number): string | null {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "ps",
        ["-ww", "-p", String(pid), "-o", "lstart=,args="],
        { timeout: 500, encoding: "utf8" },
      );
      if (result.status !== 0 || typeof result.stdout !== "string") {
        return null;
      }
      return darwinLstartToStartTime(result.stdout);
    }
    if (process.platform === "linux") {
      const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
      return linuxStatToStartTime(statText);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The production birth-record emit: probe the child's start_time and atomically
 * write the maildir record. Ordinary presence records fail open; an owned-leg
 * promotion throws so the inert shim exits before paid work. The launcher
 * injects this behind a seam so its wiring is testable without real fs or ps.
 */
export function emitBirthRecord(
  env: NodeJS.ProcessEnv,
  draft: BirthRecordDraft,
  pid: number,
  intentPath?: string,
): void {
  const owned =
    draft.leg_launch_id !== undefined &&
    draft.wrapper_job_id !== undefined &&
    draft.wrapper_dispatch_attempt_id !== undefined;
  try {
    const dir = resolveBirthDir(env);
    const startTime = probeChildStartTime(pid);
    if (owned && startTime === null) {
      throw new Error("provider-leg shim start time is unavailable");
    }
    const record = { ...draft, pid, start_time: startTime };
    if (intentPath === undefined) {
      writeBirthRecord(dir, record);
    } else if (owned) {
      // The promoted shim identity remains pending until the daemon validates
      // its owner and issues the one-use pre-exec grant.
      promoteBirthIntent(intentPath, record);
    } else {
      publishBirthIntent(intentPath, record);
    }
  } catch (error) {
    if (owned) {
      throw error;
    }
    // Presence-only degrade. A pre-spawn intent, when armed, remains visible and
    // keeps terminal adoption fail-closed until an operator resolves it.
  }
}

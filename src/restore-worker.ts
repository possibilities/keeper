/**
 * Restore-snapshot worker (epic fn-677 task .3). keeperd's tenth Bun Worker
 * thread, joining the producer / consumer fleet (`wake-worker`, `server-worker`,
 * `transcript-worker`, `plan-worker`, `exit-watcher`, `git-worker`,
 * `usage-worker`, `dead-letter-worker`, `autopilot-worker`, `backend-worker`,
 * `tab-namer-worker`).
 *
 * On every `PRAGMA data_version` change (the same change-detection primitive
 * the wake worker and autopilot worker use), the worker reads the `jobs` +
 * `epics` projections off its own read-only connection via the shared
 * {@link runQuery} server-worker read seam, builds a pure
 * {@link buildRestoreTier} snapshot of the live jobs grouped by zellij
 * `backend_exec_session_id`, stable-serializes it (sorted keys, ASCII-escaped
 * — same shape `serializePlanctlJson` produces), hashes the serialized bytes,
 * and rewrites `~/.local/state/keeper/restore.json` via `atomicWriteFile`.
 *
 * **Two-tier model (epic fn-702, schema v2).** The file carries
 * `{ schema_version: 2, last_session, current }` where each tier is a
 * `{ captured_at, sessions }` snapshot:
 *  - `current` — the continuous live mirror. Rewritten on every content
 *    change (MAY be empty: the fn-689 last-non-empty empty-skip floor is
 *    RETIRED). NOT the restore source.
 *  - `last_session` — the frozen restore source, written ONLY at two discrete
 *    seams: BOOT-PROMOTE (the first pulse lifts the persisted file's
 *    populated tier forward — `current ‖ last_session ‖` v1-legacy `sessions`
 *    — because the worker's own DB read at boot already sees the
 *    `seedKilledSweep`-emptied set, so the FILE is the only pre-crash
 *    evidence) and the `>0→0` COLLAPSE EDGE (the live set drains to empty,
 *    freezing the high-water peak since the set was last empty — the full
 *    pre-collapse count, not the last survivor). The write gate is an
 *    in-memory `lastHash` over the WHOLE two-tier file (sans per-tier
 *    `captured_at`), so a `last_session` freeze forces a write even when
 *    `current` is byte-stable.
 *
 * This is the browser "restore previous session" model (Chrome "Current
 * Session" / "Last Session"): the live mirror is decoupled from the frozen
 * restore source, so a reboot that reseeds a smaller set (the observed 8→2
 * incident) offers the full pre-crash 8 from `last_session`. A partial
 * collapse (survivors remain, never reaching 0) freezes nothing by design —
 * it relies on the next boot-promote to capture the survivors.
 *
 * The restore file is a derived side-file, NOT an event-log projection: it
 * sidesteps the event-sourcing invariants entirely (no schema bump, no
 * `keeper/api.py` whitelist change, no reducer arm). The worker is a PURE
 * CONSUMER — it never posts to main, never writes the DB, and never feeds the
 * event log. The `scripts/restore-agents.ts` util (T4) is the sole reader.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection — `applyPragmas` runs inside `openDb`
 *    so `busy_timeout` is set on this connection too.
 *  - Typed message protocol: nothing worker→main (the worker carries no
 *    message kind — it has nothing to post), `{type:"shutdown"}` main→worker.
 *    Exit 0 clean / 1 crash.
 *  - Subsystem-style teardown: the read-only DB connection is closed in the
 *    shutdown handler before `process.exit(0)`.
 *
 * Write failure policy: any throw from `atomicWriteFile` (full disk, ENOTDIR
 * on the parent, EACCES on a parent the user removed) is SWALLOWED to stderr
 * and the worker keeps running. The restore file is purely informational; the
 * next data_version pulse will rewrite it. We do NOT fatalExit on a write
 * error — that would crash the daemon over a side-file concern, which violates
 * the "single recovery path" invariant for a non-critical surface.
 *
 * Hash stability: `captured_at` is INCLUDED in the serialized output (so the
 * restore-agents util can show a wall-clock timestamp) but EXCLUDED from the
 * hashed shape — otherwise every tick would churn the file. Same trick the
 * autopilot's snapshot does with its own informational timestamps.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  atomicWriteFile,
  openDb,
  resolveRestorePath,
  serializePlanctlJson,
  sortObjectKeys,
} from "./db";
import { resumeTarget, tierForJobFromEpics } from "./resume-descriptor";
import { runQuery } from "./server-worker";
import type { Epic, Job } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the DB
 * path crosses the boundary — the read-only connection is opened on the
 * worker thread, not handed across (handles are thread-affine).
 */
export interface RestoreWorkerData {
  dbPath: string;
  /**
   * Poll cadence in ms for the underlying `data_version` watch. Optional;
   * defaults to {@link watchLoop}'s default. Threaded through workerData
   * for parity with the other consumer workers.
   */
  pollMs?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Schema version of the restore-snapshot side-file. INDEPENDENT of the DB
 * `events`/projections schema version — see the epic spec's "Best practices"
 * block: a top-level `schema_version` on the side-file itself lets the
 * restore-agents util refuse to act on a future-version file rather than
 * trust garbage. Bump only when the on-disk descriptor shape changes in a
 * way restore-agents must adapt to.
 *
 * **v2 (epic fn-702): two-tier shape.** The descriptor splits into a frozen
 * `last_session` restore source and a continuously-mirrored `current`. The
 * schema bump is the load-bearing coupling — the moment the worker writes
 * `schema_version: 2`, the OLD reader's `classifySchemaVersion` treats it as
 * "future" and refuses, so the v2 writer and the v2 reader MUST ship in the
 * same commit. No DB `SCHEMA_VERSION` bump and no `keeper/api.py` change: the
 * restore file is a non-projection side-file with its own version.
 */
export const RESTORE_SCHEMA_VERSION = 2;

/**
 * Per-agent record under a session bucket. One per live (`working` / `stopped`)
 * job that carries a non-NULL `backend_exec_session_id`. The fields are the
 * exact substrate the `scripts/restore-agents.ts` util needs to rebuild the
 * `claude --resume` command via `buildResumeCommand`:
 *
 *  - `job_id` — the Claude session id, also the dedup key against live jobs at
 *    restore time.
 *  - `cwd` — directory to `cd` into before `claude --resume`; `null` when the
 *    SessionStart event never carried one.
 *  - `resume_target` — pre-resolved via {@link resumeTarget} (the latest
 *    session name, falling back to job_id). Pre-resolved at producer time so
 *    the restore-agents util doesn't have to know the rule.
 *  - `tier` — pre-resolved via {@link tierForJobFromEpics} against the
 *    epicsById map built once per pulse. `null` for non-work jobs or jobs
 *    whose epic isn't in the projection.
 *  - `plan_verb` / `plan_ref` — informational (the restore-agents util surfaces
 *    these in the dry-run label); ride straight off the jobs row.
 */
export interface RestoreAgent {
  job_id: string;
  cwd: string | null;
  resume_target: string;
  tier: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
}

/**
 * One session bucket in the restore descriptor. Agents are sorted by
 * `job_id` for stable serialization (so the hash gate doesn't false-positive
 * on a row-order shuffle from the underlying SELECT).
 */
export interface RestoreSession {
  agents: RestoreAgent[];
}

/**
 * One tier of the two-tier descriptor (epic fn-702). A snapshot of the live
 * jobs at a moment in time: the `sessions` map plus the `captured_at`
 * timestamp of when it was taken. `captured_at` is INCLUDED in the serialized
 * file (informational — the util surfaces it in the dry-run header) but
 * EXCLUDED from the hashed shape (or every tick would churn the file). The
 * `sessions` field is an object keyed by zellij session name; alpha key sort
 * happens at serialize time via `sortObjectKeys`.
 */
export interface RestoreTier {
  captured_at: number;
  sessions: Record<string, RestoreSession>;
}

/**
 * The full on-disk descriptor (epic fn-702, schema v2). Two tiers, mirroring
 * a browser's "restore previous session" model:
 *
 *  - `current` — the continuous live mirror. Rewritten on every content
 *    change of the live set (MAY be empty: the fn-689 empty-skip floor is
 *    retired here). It is NOT the restore source.
 *  - `last_session` — the frozen restore source. Written ONLY at two discrete
 *    seams: boot-promote (the worker's first pulse lifts the persisted file's
 *    populated tier forward) and the `>0→0` collapse edge (the live set
 *    drains to empty, freezing the high-water peak since the set was last
 *    empty). NEVER mirrored on every shrink — freezing on each shrink would
 *    restore agents the human deliberately stopped (the Chrome/Firefox model).
 *
 * Either tier MAY be `null` (no snapshot yet). `scripts/restore-agents.ts`
 * resolves the restore source as `last_session ‖ current ‖` (v1) legacy
 * top-level `sessions`.
 */
export interface RestoreDescriptor {
  schema_version: number;
  last_session: RestoreTier | null;
  current: RestoreTier | null;
}

/**
 * Build one restore TIER (the `current` snapshot) from the projection rows.
 * PURE — no I/O, no Date.now() (the `capturedAt` value is threaded in by the
 * caller), no env reads. Exported for unit reach: the tests drive this
 * directly off a seeded writer DB.
 *
 * Filtering:
 *  - Only `working` and `stopped` jobs survive — the same "live" cutoff
 *    `scripts/resume.ts` uses (and the broader set the restore-agents util
 *    deduplicates against).
 *  - Jobs whose `backend_exec_session_id` is NULL are OMITTED entirely.
 *    They aren't restorable into a backend session (nowhere to drop the
 *    `claude --resume` tab), and a sentinel bucket would muddle the
 *    descriptor for no consumer benefit.
 *  - `job_id` empty / unset jobs are dropped defensively (the producer
 *    invariant says this never happens, but a malformed row is folded to
 *    a safe value per CLAUDE.md's reducer policy — we mirror that here).
 *
 * Grouping: by `backend_exec_session_id`. Each bucket's `agents` array is
 * sorted ASCENDING by `job_id` so the serialized output is byte-stable
 * across SELECTs that may return rows in different order.
 *
 * Pre-resolution: `tierForJobFromEpics` runs once per agent against the
 * provided `epicsById` map, so the restore-agents util doesn't need to
 * re-fetch epics to rebuild the resume command — the tier rides the file.
 *
 * The returned tier MAY be empty (`sessions: {}`) — the fn-689 empty-skip
 * floor is retired (epic fn-702); an empty live set yields an empty `current`
 * tier without losing `last_session`.
 */
export function buildRestoreTier(
  jobs: Job[],
  epicsById: Map<string, Epic>,
  capturedAt: number,
): RestoreTier {
  const sessions: Record<string, RestoreSession> = {};
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_session_id == null) {
      continue;
    }
    if (typeof job.job_id !== "string" || job.job_id === "") {
      continue;
    }
    const sessionId = job.backend_exec_session_id;
    const tier = tierForJobFromEpics(job, epicsById);
    const agent: RestoreAgent = {
      job_id: job.job_id,
      cwd: job.cwd,
      resume_target: resumeTarget(job),
      tier,
      plan_verb: job.plan_verb,
      plan_ref: job.plan_ref,
    };
    let bucket = sessions[sessionId];
    if (!bucket) {
      bucket = { agents: [] };
      sessions[sessionId] = bucket;
    }
    bucket.agents.push(agent);
  }
  for (const bucket of Object.values(sessions)) {
    bucket.agents.sort((a, b) =>
      a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0,
    );
  }
  return { captured_at: capturedAt, sessions };
}

/** Count the agents across every session bucket in a tier (the high-water
 * comparison metric). A `null` tier counts as 0. */
export function tierAgentCount(tier: RestoreTier | null): number {
  if (tier == null) {
    return 0;
  }
  let n = 0;
  for (const bucket of Object.values(tier.sessions)) {
    n += bucket.agents.length;
  }
  return n;
}

/** True when a tier carries at least one session bucket (the
 * `buildRestoreTier` invariant means a present bucket is always non-empty,
 * so an empty `sessions` object is the exact emptiness test). */
export function tierIsPopulated(tier: RestoreTier | null): boolean {
  return tier != null && Object.keys(tier.sessions).length > 0;
}

/** Strip a tier's `captured_at` for hashing (or `null` passes through). The
 * informational timestamp must not churn the hash on every pulse. */
function tierForHash(
  tier: RestoreTier | null,
): { sessions: Record<string, RestoreSession> } | null {
  if (tier == null) {
    return null;
  }
  const { captured_at: _capturedAt, ...rest } = tier;
  return rest;
}

/**
 * Stable-serialize the WHOLE two-tier descriptor for HASHING. Strips each
 * tier's `captured_at` so the informational timestamps don't churn the hash
 * on every pulse, then runs the same `sortObjectKeys` → `JSON.stringify(_,
 * null, 2)` → ASCII-escape → trailing-`\n` pipeline `serializePlanctlJson`
 * uses for `.planctl` files. Exported for unit reach (the tests drive the
 * "did content change" gate directly).
 *
 * The hash scope covers the ENTIRE file (both tiers + `schema_version`, sans
 * per-tier `captured_at`) — so a `last_session` freeze forces a write even
 * when `current` is byte-stable. The disk write itself goes through
 * {@link serializeForWrite} (with the timestamps intact); only the hash
 * input strips them.
 */
export function serializeForHash(descriptor: RestoreDescriptor): string {
  return serializePlanctlJson({
    schema_version: descriptor.schema_version,
    last_session: tierForHash(descriptor.last_session),
    current: tierForHash(descriptor.current),
  });
}

/**
 * Stable-serialize the descriptor for DISK. Same pipeline as
 * {@link serializeForHash} but keeps each tier's `captured_at` so a human
 * (or the restore-agents util) can see when the snapshot was last written.
 * The `sortObjectKeys` pass in `serializePlanctlJson` alpha-sorts every
 * nested object's keys, including the `sessions` map's session-name keys, so
 * the output is byte-stable across SELECT order shuffles.
 */
export function serializeForWrite(descriptor: RestoreDescriptor): string {
  // Run the descriptor through sortObjectKeys explicitly so the test suite
  // can compare against the exact byte sequence the writer emits.
  // `serializePlanctlJson` does the same sort internally; the redundant call
  // is a no-op (sortObjectKeys is idempotent on already-sorted input).
  return serializePlanctlJson(sortObjectKeys(descriptor));
}

/**
 * Coerce an arbitrary parsed value to a {@link RestoreTier}, or `null` on any
 * garbage / wrong shape. Mirrors {@link parseZellijWatermarks}'s defensive
 * coercion: never throws, always returns either a well-formed tier or `null`.
 * The agent records themselves are NOT deep-validated — the reader
 * (`scripts/restore-agents.ts`) only reads them, and a malformed agent is the
 * producer's invariant violation, not the boot-read's concern.
 */
function coerceTier(raw: unknown): RestoreTier | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const sessionsRaw = rec.sessions;
  if (
    sessionsRaw === null ||
    typeof sessionsRaw !== "object" ||
    Array.isArray(sessionsRaw)
  ) {
    return null;
  }
  const captured_at =
    typeof rec.captured_at === "number" && Number.isFinite(rec.captured_at)
      ? rec.captured_at
      : 0;
  return {
    captured_at,
    sessions: sessionsRaw as Record<string, RestoreSession>,
  };
}

/**
 * The persisted-file view the boot-promote read resolves to. Carries the two
 * v2 tiers PLUS the v1 legacy top-level `sessions` block (frozen under the
 * fn-689 last-non-empty-wins policy — so it is treated as a `last_session`
 * source, not as `current`).
 */
export interface PersistedRestore {
  last_session: RestoreTier | null;
  current: RestoreTier | null;
  /** v1 legacy top-level `sessions` as a tier, else `null`. */
  legacy: RestoreTier | null;
}

/**
 * Parse the persisted `restore.json` text for boot-promote. SYNCHRONOUS,
 * never throws — mirrors {@link parseZellijWatermarks} + the daemon's boot
 * read at `src/daemon.ts:676-689`. Any garbage / non-object / wrong shape
 * coerces each tier to `null`. Exported for unit reach.
 *
 * Reads three sources so boot-promote can apply the precedence chain:
 *  - v2 `current` / `last_session` tiers.
 *  - v1 legacy top-level `sessions` (a pre-fn-702 file frozen under
 *    last-non-empty-wins) lifted into a `legacy` tier — treated as a
 *    `last_session` source so a single empty post-upgrade pulse cannot
 *    clobber it.
 */
export function parsePersistedRestore(text: string): PersistedRestore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { last_session: null, current: null, legacy: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { last_session: null, current: null, legacy: null };
  }
  const rec = parsed as Record<string, unknown>;
  const last_session = coerceTier(rec.last_session);
  const current = coerceTier(rec.current);
  // v1 legacy: a top-level `sessions` block with no tier wrapper. Synthesize
  // a tier (captured_at falls back to the legacy file's top-level value, else
  // 0). Only present in pre-fn-702 files; a v2 file has no top-level
  // `sessions`, so `legacy` is null there.
  const legacy = coerceTier({
    captured_at: rec.captured_at,
    sessions: rec.sessions,
  });
  return { last_session, current, legacy };
}

/**
 * Read + parse the persisted `restore.json` off disk for boot-promote.
 * SYNCHRONOUS, never throws — `existsSync` → `readFileSync` → safe parse.
 * Returns all-`null` tiers on a missing file or any read/parse failure (the
 * first-ever-boot path). Exported for unit reach.
 */
export function readPersistedRestore(restorePath: string): PersistedRestore {
  if (!existsSync(restorePath)) {
    return { last_session: null, current: null, legacy: null };
  }
  let text: string;
  try {
    text = readFileSync(restorePath, "utf8");
  } catch (err) {
    console.error(
      `[restore-worker] boot read of ${restorePath} failed (degrading to empty): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { last_session: null, current: null, legacy: null };
  }
  return parsePersistedRestore(text);
}

/**
 * One restore pulse's mutable state. Two-tier model (epic fn-702):
 *
 *  - `lastHash` — the in-memory write-dedup gate over the WHOLE two-tier file
 *    (sans per-tier `captured_at`); a `last_session` freeze flips the file
 *    shape so the hash changes and forces a write.
 *  - `parentDirEnsured` — once-flag for the parent-dir mkdir.
 *  - `epochHighWater` — the full descriptor TIER of the peak live set since it
 *    was last empty (a SNAPSHOT, not a count). Captured so a `>0→0` collapse
 *    freezes the richest snapshot, not the last survivor. Reset to `null` once
 *    a freeze succeeds (a new epoch begins).
 *  - `lastSession` — the frozen restore source tier (or `null`). Written ONLY
 *    at boot-promote and the collapse-freeze edge.
 *  - `bootPromoted` — once-flag; the first pulse reads the persisted FILE and
 *    seeds `lastSession` before mirroring `current`.
 */
interface PulseState {
  lastHash: string | null;
  parentDirEnsured: boolean;
  epochHighWater: RestoreTier | null;
  lastSession: RestoreTier | null;
  bootPromoted: boolean;
}

/**
 * Drive one restore pulse against the worker's read-only connection. PURE-ish
 * in the same shape as `loadReconcileSnapshot`: reads the projections via the
 * `read(collection)` helper (identical frame shape to the autopilot worker's),
 * builds the `current` tier, tracks the high-water peak, freezes `last_session`
 * on the `>0→0` collapse edge, hashes the WHOLE two-tier file, writes on change.
 *
 * Two-tier write semantics (epic fn-702):
 *  - First pulse (`!bootPromoted`): read the persisted FILE (NOT the
 *    seed-swept jobs table — at boot the live set is already empty) and seed
 *    `lastSession` from `current ‖ last_session ‖` (v1) legacy `sessions ‖`
 *    nothing. This survives today's 8→2 reboot incident: `last_session`
 *    becomes the pre-crash 8, not the reseeded 2.
 *  - `current` is the continuous live mirror (may be empty — the fn-689
 *    empty-skip floor is RETIRED).
 *  - `epochHighWater` tracks the larger (by agent count) of itself and a
 *    populated `current`.
 *  - On the `>0→0` collapse edge (empty `current` AND populated high-water),
 *    FREEZE: `lastSession = epochHighWater`, reset `epochHighWater = null`.
 *    If the freeze write throws, `epochHighWater` is NOT reset, so the freeze
 *    retries on the next empty pulse.
 *  - Always assemble `{ schema_version: 2, last_session, current }` and write
 *    on a whole-file hash change.
 *
 * Exported for unit reach: tests drive this directly against a seeded writer
 * DB (re-opened read-only for the pulse).
 */
export function restorePulse(
  db: Parameters<typeof runQuery>[0],
  restorePath: string,
  state: PulseState,
  now: () => number = () => Date.now() / 1000,
): void {
  const read = (collection: string): Record<string, unknown>[] => {
    const frame = {
      type: "query" as const,
      collection,
      id: `restore-${collection}`,
      limit: 0,
    };
    const res = runQuery(db, 0, frame);
    return res.type === "result" ? (res.rows as Record<string, unknown>[]) : [];
  };

  // Boot-promote: ONCE, on the first pulse, seed `lastSession` from the
  // persisted FILE before building `current`. The worker's DB read at boot
  // sees the post-`seedKilledSweep` empty set, so the persisted file is the
  // only pre-crash evidence (see CLAUDE.md autopilot/boot ordering). Precedence:
  // a populated `current` (the live mirror at the moment of the last write)
  // wins over a `last_session` (which may be stale), then v1 legacy
  // top-level `sessions`, else nothing.
  if (!state.bootPromoted) {
    const persisted = readPersistedRestore(restorePath);
    if (tierIsPopulated(persisted.current)) {
      state.lastSession = persisted.current;
    } else if (tierIsPopulated(persisted.last_session)) {
      state.lastSession = persisted.last_session;
    } else if (tierIsPopulated(persisted.legacy)) {
      state.lastSession = persisted.legacy;
    }
    // else: leave state.lastSession as-is (null on first-ever boot).
    state.bootPromoted = true;
  }

  const jobs = read("jobs") as unknown as Job[];
  const epics = read("epics") as unknown as Epic[];
  const epicsById = new Map<string, Epic>();
  for (const epic of epics) {
    epicsById.set(epic.epic_id, epic);
  }

  const current = buildRestoreTier(jobs, epicsById, now());

  // Track the high-water peak (by agent count) of the live set since it was
  // last empty. A populated `current` that exceeds the recorded peak replaces
  // it — so the collapse-freeze captures the RICHEST snapshot, not the last
  // survivor before the drain to zero.
  if (
    tierIsPopulated(current) &&
    tierAgentCount(current) > tierAgentCount(state.epochHighWater)
  ) {
    state.epochHighWater = current;
  }

  // Collapse-freeze: the `>0→0` edge. When `current` drained to empty AND we
  // have a populated high-water peak, FREEZE the peak into `last_session`.
  // The reset of `epochHighWater` is GATED on a successful write below — if
  // the freeze write throws, the peak survives and the freeze retries on the
  // next empty pulse (the set stays empty, so the edge won't re-fire on its
  // own). A populated `current` does NOT freeze — `last_session` is written
  // only at boot-promote and this discrete collapse seam, never on each
  // shrink (the Chrome/Firefox "Last Session" model).
  const freezing =
    !tierIsPopulated(current) && tierIsPopulated(state.epochHighWater);
  if (freezing) {
    state.lastSession = state.epochHighWater;
  }

  const descriptor: RestoreDescriptor = {
    schema_version: RESTORE_SCHEMA_VERSION,
    last_session: state.lastSession,
    current,
  };

  const hashed = serializeForHash(descriptor);
  // `Bun.hash` returns a number — fine for an in-memory dedup key (we never
  // compare across daemon boots). Stringify so the equality check is by
  // value, not by Number coercion edge cases.
  const hash = String(Bun.hash(hashed));
  if (state.lastHash === hash) {
    // No content change → no write. If a freeze was pending but the file is
    // already byte-stable, `last_session` on disk ALREADY reflects the
    // high-water peak (the descriptor we hashed carries the frozen tier and
    // it matched the gate), so the freeze is durable — reset the epoch so the
    // next peak starts clean. A normal no-op pulse (not freezing) leaves the
    // peak untouched.
    if (freezing) {
      state.epochHighWater = null;
    }
    return;
  }

  const serialized = serializeForWrite(descriptor);
  if (!state.parentDirEnsured) {
    try {
      mkdirSync(dirname(restorePath), { recursive: true });
      state.parentDirEnsured = true;
    } catch (err) {
      // mkdir is best-effort; the atomicWriteFile below will surface the
      // real failure (ENOENT/EACCES) if the dir really doesn't exist.
      console.error(
        `[restore-worker] mkdir parent dir failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  try {
    atomicWriteFile(restorePath, serialized);
    state.lastHash = hash;
    // The freeze landed durably — start a new epoch. GATED on the write
    // succeeding: if `atomicWriteFile` throws below, `epochHighWater` is NOT
    // reset, so the freeze retries on the next empty pulse (the live set
    // stays empty, so the `>0→0` edge won't re-fire on its own).
    if (freezing) {
      state.epochHighWater = null;
    }
  } catch (err) {
    // Per design contract: write failure is SWALLOWED to stderr. The next
    // data_version pulse re-runs this; lastHash stays unchanged so we
    // retry the write rather than silently skipping it forever.
    console.error(
      `[restore-worker] write failed (will retry next pulse): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, runs an initial pulse to seed the file, then drives the watch
 * loop until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[restore-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as RestoreWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[restore-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, { readonly: true });
  const restorePath = resolveRestorePath();
  const state: PulseState = {
    lastHash: null,
    parentDirEnsured: false,
    epochHighWater: null,
    lastSession: null,
    bootPromoted: false,
  };
  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  // Initial pulse before the watch loop's first sleep so a freshly-spawned
  // worker writes a settled `restore.json` immediately rather than after
  // the first data_version change. Mirrors the backend-worker's "one
  // immediate tick" pattern.
  try {
    restorePulse(db, restorePath, state);
  } catch (err) {
    // Defense-in-depth: restorePulse's internal try/catch already swallows
    // write errors, but a projection-read throw would escape here. Log +
    // continue — the next pulse re-tries.
    console.error(
      `[restore-worker] initial pulse threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  watchLoop(
    db,
    () => {
      try {
        restorePulse(db, restorePath, state);
      } catch (err) {
        // Same defense-in-depth as the initial pulse.
        console.error(
          `[restore-worker] pulse threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    () => shutdown,
    data.pollMs,
  )
    .then(() => {
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[restore-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure descriptor builder / pulse) is inert.
if (!isMainThread) {
  main();
}

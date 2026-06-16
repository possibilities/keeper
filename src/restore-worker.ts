/**
 * Restore-snapshot worker (epic fn-677 task .3; freeze machinery RETIRED in
 * fn-817 T4). keeperd's tenth Bun Worker thread, joining the producer / consumer
 * fleet (`wake-worker`, `server-worker`, `transcript-worker`, `plan-worker`,
 * `exit-watcher`, `git-worker`, `usage-worker`, `dead-letter-worker`,
 * `autopilot-worker`).
 *
 * On every `PRAGMA data_version` change (the same change-detection primitive
 * the wake worker and autopilot worker use), the worker reads the `jobs` +
 * `epics` projections off its own read-only connection via the shared
 * {@link runQuery} server-worker read seam, builds a pure
 * {@link buildRestoreTier} snapshot of the live jobs grouped by
 * `backend_exec_session_id`, stable-serializes it (sorted keys, ASCII-escaped
 * — same shape `serializePlanctlJson` produces), hashes the serialized bytes,
 * and rewrites `~/.local/state/keeper/restore.json` via `atomicWriteFile`.
 *
 * **DUMB CURRENT MIRROR (epic fn-817).** The file is a single-tier
 * `{ schema_version, current }` continuous live mirror — rewritten on every
 * content change of the live set (MAY be empty), each session bucket carrying a
 * `backend` tag (v3). It is the DISASTER FALLBACK only: the live, retrospective
 * restore set is now derived at read time from `keeper.db`'s producer-stamped
 * `close_kind` / `window_index` columns (`src/restore-set.ts`), not from this
 * file. The two-tier `last_session` freeze model (boot-promote + the `>0→0`
 * collapse edge + high-water peak) is GONE — `close_kind` per-row membership
 * replaces "which set was live before the crash" with no frozen snapshot to
 * maintain. The write gate is an in-memory `lastHash` over the file (sans
 * `current.captured_at`).
 *
 * The restore file is a derived side-file, NOT an event-log projection: it
 * sidesteps the event-sourcing invariants entirely (no schema bump, no
 * `keeper/api.py` whitelist change, no restore-file reducer arm). It is still
 * read by `scripts/restore-agents.ts --snapshot-current` (the runnable-script
 * escape hatch over the live mirror).
 *
 * **Tmux poll arm (epic fn-789; window order epic fn-681).** Riding the SAME
 * data_version pulse, the worker self-gates on ANY live tmux job (resolved or
 * not) and spawns ONE `tmux list-panes` probe whose output feeds two
 * independent consumers:
 *  - the WINDOW-ORDER cache (`job_id → #{window_index}`), refreshed every pulse
 *    a live tmux job exists — the original tmux server is dead at restore time,
 *    so each agent's left-to-right window POSITION must be captured here and
 *    stamped onto its `RestoreAgent` so the restore-agents util replays windows
 *    in visual order; and
 *  - the PANE-FILL post: when a live tmux job carries a NULL
 *    `backend_exec_session_id`, the worker posts ONE
 *    `{kind:"tmux-pane-snapshot"}` message to main, which mints the sole
 *    `TmuxPaneSnapshot` synthetic event the reducer folds (fill-only).
 * Two more posts ride the same pulse (the pulse→event→fold family): the
 * `{kind:"window-index-snapshot"}` window-order channel (epic fn-817), and the
 * `{kind:"backend-exec-start"}` generation boundary (epic fn-819) — the latter
 * UNGATED by a live tmux job, since a post-crash respawn must be recorded when
 * no job is live. The restore-file write path stays a pure consumer side-file.
 * The pane/window arms are quiescent when no live tmux job exists; a
 * producer-side dedup hash per arm (the fill hash DELIBERATELY excludes
 * `window_index`) stops re-posting an unchanged payload, so a pure window
 * reorder never re-fires the fill post and an unchanged generation is silent.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection — `applyPragmas` runs inside `openDb`
 *    so `busy_timeout` is set on this connection too.
 *  - Typed message protocol: `{kind:"tmux-pane-snapshot"}` /
 *    `{kind:"window-index-snapshot"}` / `{kind:"backend-exec-start"}`
 *    worker→main, `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
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

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  atomicWriteFile,
  openDb,
  resolveRestorePath,
  serializePlanctlJson,
  sortObjectKeys,
} from "./db";
import {
  buildTmuxServerPidArgs,
  DEFAULT_EXEC_BACKEND,
  localeDefaultedEnv,
} from "./exec-backend";
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
 * One `(pane_id, window_index, session_name)` row the tmux snapshot probe
 * observed. `pane_id` is the `%N` id (the durable handle the COALESCE fold
 * stamped `jobs.backend_exec_pane_id` from `TMUX_PANE`), `session_name` the
 * `#{session_name}` the reducer fills onto a NULL-session tmux job.
 * `window_index` is the `#{window_index}` (the window's left-to-right POSITION,
 * not its `@N` identity) the producer caches per job so the restore-agents util
 * can replay windows in original visual order; `null` when the field was
 * absent/non-numeric (degraded probe). NOT part of the pane-fill snapshot hash.
 */
export interface TmuxPanePair {
  pane_id: string;
  session_name: string;
  window_index: number | null;
}

/**
 * Worker→main message: the live tmux pane topology, posted ONLY when a live
 * tmux job carries a NULL `backend_exec_session_id` (the gate) AND the probed
 * pairs differ from the last post (the dedup hash). Main — the sole synthetic
 * event writer — mints ONE `TmuxPaneSnapshot` event carrying `pairs`; the
 * reducer fills the session name onto each matching NULL-session tmux job
 * (fill-only, never overwrite). NEVER reuses the retired `BackendExecSnapshot`
 * name (its no-op fold arm must stay untouched for re-fold determinism).
 */
export interface TmuxPaneSnapshotMessage {
  kind: "tmux-pane-snapshot";
  pairs: TmuxPanePair[];
}

/**
 * One `(job_id, window_index)` entry of a window-layout snapshot — the live
 * tmux `#{window_index}` (a window's left-to-right VISUAL position) keyed by the
 * agent's stable Claude session id. `window_index` is always a finite integer
 * here (a `null` index never enters the cache this is built from).
 */
export interface WindowIndexEntry {
  job_id: string;
  window_index: number;
}

/**
 * Worker→main message: the live `job_id → window_index` map, posted ONLY when it
 * CHANGES (a layout hash dedups, so a steady topology doesn't re-post every
 * pulse — and, unlike {@link TmuxPaneSnapshotMessage}, a pure window REORDER DOES
 * re-fire because window order is exactly what this carries). Main — the sole
 * synthetic event writer — mints ONE `WindowIndexSnapshot` event carrying
 * `entries`; the reducer folds each `window_index` onto the matching `jobs` row
 * keyed by `job_id` (a pure integer copy, no probe in the fold). The DB-only
 * crash-restore derivation then replays original visual order without reading
 * restore.json. A NEW event name — never reuses a retired one.
 */
export interface WindowIndexSnapshotMessage {
  kind: "window-index-snapshot";
  entries: WindowIndexEntry[];
}

/**
 * Worker→main message: a backend "generation" boundary, posted ONLY when the
 * probed server generation CHANGES (the dedup hash differs from the last post,
 * or the first observation after boot once the boot-seed is compared). Unlike
 * the two snapshot posts above, this is NOT gated on any live tmux job — the
 * post-crash state has no live job, yet that is exactly when a new generation
 * (the freshly-respawned server) must be recorded. Main — the sole synthetic
 * event writer — mints ONE `BackendExecStart` event carrying `backend_type` +
 * `generation_id`; the reducer folds it via an explicit NO-OP dispatcher arm
 * (the boundary lives in the event log's `id` order, not a projection column).
 * `generation_id` is the backend's stable generation handle (the tmux server
 * pid); `backend_type` is {@link DEFAULT_EXEC_BACKEND} (the seam other backends
 * extend). A NEW event name — never reuses the retired `BackendExecSnapshot`.
 */
export interface BackendExecStartMessage {
  kind: "backend-exec-start";
  backend_type: string;
  generation_id: string;
}

/**
 * `Bun.spawnSync`-shaped subset the tmux pane probe needs; injectable so tests
 * drive the gate / parse / dedup without a real tmux server. Mirrors the
 * git-worker's `gitOutput` spawnSync shape: `success` + `exitCode` + a
 * stdout `Buffer`.
 */
export type SpawnSyncFn = (cmd: string[]) => {
  success: boolean;
  exitCode: number | null;
  stdout: Buffer;
};

const defaultSpawnSync: SpawnSyncFn = (cmd) =>
  Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "ignore",
    timeout: TMUX_PROBE_TIMEOUT_MS,
    // LOAD-BEARING locale default: the extended `-F` format emits TAB
    // delimiters, and a daemon-side tmux CLIENT under the C locale (the
    // LaunchAgent env carries no LANG/LC_*) sanitizes those TABs to `_`,
    // dropping every line — every window_index would silently read as absent.
    env: localeDefaultedEnv(process.env as Record<string, string | undefined>),
  });

/** Upper bound on the `tmux list-panes` probe. A wedged tmux server degrades to
 *  "no pairs" (skip) rather than freezing the restore pulse. */
const TMUX_PROBE_TIMEOUT_MS = 5000;

/**
 * Schema version of the restore-snapshot side-file. INDEPENDENT of the DB
 * `events`/projections schema version — see the epic spec's "Best practices"
 * block: a top-level `schema_version` on the side-file itself lets the
 * restore-agents util refuse to act on a future-version file rather than
 * trust garbage. Bump only when the on-disk descriptor shape changes in a
 * way restore-agents must adapt to.
 *
 * **v2 (epic fn-702): two-tier shape (RETIRED in fn-817).** The descriptor
 * once split into a frozen `last_session` restore source and a `current` live
 * mirror. fn-817 retired the freeze model — the file is now the single-tier
 * `current` mirror alone (`{ schema_version, current }`). The version is NOT
 * bumped: the `current` tier's on-disk shape is byte-identical to v3's
 * `current`, and the only consumer that still parses the file
 * (`restore-agents --snapshot-current`) reads only `current`, so a dropped
 * top-level `last_session` is a no-op for it.
 *
 * **v3 (epic fn-789): per-bucket backend type.** Each session bucket gains a
 * `backend` field stamped from its jobs' `backend_exec_type`. The bump landed
 * with the side-file's own `RESTORE_SCHEMA_VERSION` only — the DB
 * `SCHEMA_VERSION` and `keeper/api.py` do NOT move. A bucket without `backend`
 * coerces to `DEFAULT_EXEC_BACKEND`.
 */
export const RESTORE_SCHEMA_VERSION = 3;

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
 *  - `resume_target` — pre-resolved via {@link resumeTarget} (the latest session
 *    name, `job_id` fallback — resume by the name keeper currently knows).
 *    Pre-resolved at producer time so the restore-agents util doesn't re-derive it.
 *  - `tier` — pre-resolved via {@link tierForJobFromEpics} against the
 *    epicsById map built once per pulse. `null` for non-work jobs or jobs
 *    whose epic isn't in the projection.
 *  - `plan_verb` / `plan_ref` — informational (the restore-agents util surfaces
 *    these in the dry-run label); ride straight off the jobs row.
 *  - `window_index` — the live tmux `#{window_index}` (left-to-right POSITION)
 *    captured at pulse time from a `list-panes` probe correlated by
 *    `backend_exec_pane_id` (session-name cross-checked). The restore-agents
 *    util sorts restored windows by it so they come back in original visual
 *    order. `null` when the probe couldn't stamp it (no match, recycled pane,
 *    degraded probe, or a legacy file with no field) — those agents sink to the
 *    tail by `created_at` then `job_id`.
 *  - `created_at` — the job's `jobs.created_at` (Claude session birth). The
 *    restore-agents util uses it as the tail tiebreaker for unknown-order
 *    agents, before `job_id`.
 */
export interface RestoreAgent {
  job_id: string;
  cwd: string | null;
  resume_target: string;
  tier: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
  window_index: number | null;
  created_at: number;
}

/**
 * One session bucket in the restore descriptor. Agents are sorted by
 * `job_id` for stable serialization (so the hash gate doesn't false-positive
 * on a row-order shuffle from the underlying SELECT).
 *
 * `backend` (schema v3, epic fn-789) is the exec-backend tag the bucketed jobs
 * ran under, recorded so `scripts/restore-agents.ts` can route the bucket
 * through the matching backend. A session name is backend-unique in practice; a
 * mixed bucket is an invariant violation the producer asserts on rather than
 * engineers around. OPTIONAL on the wire: a bucket without `backend` (a
 * v2/legacy file) coerces to `DEFAULT_EXEC_BACKEND`.
 */
export interface RestoreSession {
  agents: RestoreAgent[];
  backend?: string;
}

/**
 * The `current` live-mirror snapshot: the `sessions` map plus the `captured_at`
 * timestamp of when it was taken. `captured_at` is INCLUDED in the serialized
 * file (informational — the util surfaces it in the dry-run header) but
 * EXCLUDED from the hashed shape (or every tick would churn the file). The
 * `sessions` field is an object keyed by backend session name; alpha key sort
 * happens at serialize time via `sortObjectKeys`.
 */
export interface RestoreTier {
  captured_at: number;
  sessions: Record<string, RestoreSession>;
}

/**
 * The full on-disk descriptor (epic fn-817 single-tier reshape). One tier:
 *
 *  - `current` — the continuous live mirror. Rewritten on every content change
 *    of the live set (MAY be empty). It is the DISASTER FALLBACK only — the
 *    live restore set is derived at read time from `keeper.db` (`restore-set.ts`),
 *    not from this file. `null` when there is no snapshot yet.
 *
 * The two-tier `last_session` freeze field is GONE (fn-817): per-row `close_kind`
 * membership replaced "which set was live before the crash" with no frozen
 * snapshot to maintain.
 */
export interface RestoreDescriptor {
  schema_version: number;
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
 * sorted ASCENDING by `job_id` purely for byte-stable serialization (so the
 * hash gate doesn't false-positive on a row-order shuffle from the SELECT) —
 * this on-disk sort is NOT visual order. Restored windows are reordered by
 * `window_index` at restore time, a concern entirely for the restore-agents
 * util; the file stays `job_id`-sorted.
 *
 * Pre-resolution: `tierForJobFromEpics` runs once per agent against the
 * provided `epicsById` map, so the restore-agents util doesn't need to
 * re-fetch epics to rebuild the resume command — the tier rides the file.
 *
 * The returned tier MAY be empty (`sessions: {}`); an empty live set yields an
 * empty `current` tier.
 */
export function buildRestoreTier(
  jobs: Job[],
  epicsById: Map<string, Epic>,
  capturedAt: number,
  windowIndexByJobId: Map<string, number> = new Map(),
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
    const windowIndex = windowIndexByJobId.get(job.job_id);
    const agent: RestoreAgent = {
      job_id: job.job_id,
      cwd: job.cwd,
      resume_target: resumeTarget(job),
      tier,
      plan_verb: job.plan_verb,
      plan_ref: job.plan_ref,
      window_index: windowIndex ?? null,
      created_at: job.created_at,
    };
    // Backend tag for the bucket (schema v3): the job's `backend_exec_type`,
    // defaulting to `DEFAULT_EXEC_BACKEND` when NULL. A session name
    // is backend-unique in practice, so the first job's backend defines the
    // bucket; a later job under the same session with a DIFFERENT backend is an
    // invariant violation — assert rather than silently last-write-wins.
    const backend = job.backend_exec_type ?? DEFAULT_EXEC_BACKEND;
    let bucket = sessions[sessionId];
    if (!bucket) {
      bucket = { agents: [], backend };
      sessions[sessionId] = bucket;
    } else if (bucket.backend !== backend) {
      throw new Error(
        `restore bucket "${sessionId}" mixes exec backends ` +
          `(${bucket.backend} vs ${backend}); session names must be ` +
          `backend-unique`,
      );
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

/** Strip the `current` tier's `captured_at` for hashing (or `null` passes
 * through). The informational timestamp must not churn the hash on every pulse. */
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
 * Stable-serialize the descriptor for HASHING. Strips the `current` tier's
 * `captured_at` so the informational timestamp doesn't churn the hash on every
 * pulse, then runs the same `sortObjectKeys` → `JSON.stringify(_, null, 2)` →
 * ASCII-escape → trailing-`\n` pipeline `serializePlanctlJson` uses for
 * `.planctl` files. Exported for unit reach (the tests drive the "did content
 * change" gate directly).
 *
 * The hash scope covers the whole file (`current` + `schema_version`, sans
 * `captured_at`). The disk write itself goes through {@link serializeForWrite}
 * (with the timestamp intact); only the hash input strips it.
 */
export function serializeForHash(descriptor: RestoreDescriptor): string {
  return serializePlanctlJson({
    schema_version: descriptor.schema_version,
    current: tierForHash(descriptor.current),
  });
}

/**
 * Stable-serialize the descriptor for DISK. Same pipeline as
 * {@link serializeForHash} but keeps the `current` tier's `captured_at` so a
 * human (or the restore-agents util) can see when the snapshot was last
 * written. The `sortObjectKeys` pass in `serializePlanctlJson` alpha-sorts
 * every nested object's keys, including the `sessions` map's session-name keys,
 * so the output is byte-stable across SELECT order shuffles.
 */
export function serializeForWrite(descriptor: RestoreDescriptor): string {
  // Run the descriptor through sortObjectKeys explicitly so the test suite
  // can compare against the exact byte sequence the writer emits.
  // `serializePlanctlJson` does the same sort internally; the redundant call
  // is a no-op (sortObjectKeys is idempotent on already-sorted input).
  return serializePlanctlJson(sortObjectKeys(descriptor));
}

/**
 * One restore pulse's mutable state (epic fn-817 single-tier model):
 *
 *  - `lastHash` — the in-memory write-dedup gate over the file (sans
 *    `current.captured_at`); a content change flips the hash and forces a write.
 *  - `parentDirEnsured` — once-flag for the parent-dir mkdir.
 *
 * The two-tier freeze fields (`epochHighWater`, `lastSession`, `bootPromoted`)
 * are GONE (fn-817): there is no frozen restore source to maintain — the live
 * restore set is derived from `keeper.db` at read time.
 */
interface PulseState {
  lastHash: string | null;
  parentDirEnsured: boolean;
  /**
   * Producer-side dedup for the tmux pane-snapshot post (mirrors `lastHash`).
   * Hash of the last posted `pairs` set, so an unchanged tmux topology does NOT
   * re-post every pulse while a pane the server can't resolve keeps a job NULL
   * forever. `null` until the first post. Reset semantics: we only ever advance
   * it on a post, so a transient "no pairs" pulse leaves it intact.
   */
  lastSnapshotHash: string | null;
  /**
   * Live-tmux window POSITION cache: `job_id → #{window_index}`. Populated each
   * pulse from the single `list-panes` probe (the pane-id match cross-checked
   * against the job's `backend_exec_session_id`) and pruned to the live job ids.
   * At restore time the original tmux server is dead, so order MUST be captured
   * here at pulse time; `buildRestoreTier` stamps each agent's `window_index`
   * from this map and the `WindowIndexSnapshot` post folds it onto the DB column.
   * job_ids are unique Claude session ids, so an entry is never re-keyed.
   */
  lastWindowIndexByJobId: Map<string, number>;
  /**
   * Producer-side dedup for the `WindowIndexSnapshot` post (mirrors
   * `lastSnapshotHash`). Hash of the last posted `job_id → window_index` layout
   * (via {@link hashWindowIndexCache}, which INCLUDES the index), so an unchanged
   * layout doesn't re-post every pulse but a reorder does. `null` until the first
   * post; advanced only on a post.
   */
  lastWindowIndexHash: string | null;
  /**
   * Producer-side dedup for the `BackendExecStart` generation-boundary post. The
   * hash of the last posted generation id, so an unchanged server generation
   * does NOT re-post every pulse. Seeded ONCE at the first pulse from the last
   * logged `BackendExecStart` payload (see {@link seedLastGenerationHash}) so a
   * keeperd restart against an UNCHANGED server does not mint a spurious
   * boundary. `null` until seeded/posted; advanced only on a post. A `null` here
   * after boot-seed means no prior generation was ever recorded — the next
   * non-empty probe is the first boundary and DOES post.
   */
  lastGenerationHash: string | null;
}

/**
 * True when at least one LIVE (`working`/`stopped`) tmux job carries a NULL
 * `backend_exec_session_id` — the gate that arms the tmux pane probe. When
 * false the poller is fully quiescent (no spawn, no post). Reads only the
 * projection rows; pure.
 */
/**
 * True when at least one LIVE (`working`/`stopped`) tmux job exists, regardless
 * of whether its session is resolved. This is the gate that arms the per-pulse
 * tmux probe: a NULL-session-only gate would go false once every session
 * resolves, yet visual window order keeps shifting after that, so order capture
 * (and the one probe both arms share) must keep running. Reads only the
 * projection rows; pure.
 */
function hasLiveTmuxJob(jobs: Job[]): boolean {
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_type === "tmux") {
      return true;
    }
  }
  return false;
}

/**
 * Spawn `tmux list-panes -a -F '#{pane_id}\t#{window_index}\t#{session_name}'`
 * and parse the `(pane_id, window_index, session_name)` rows. NEVER throws: an
 * ENOENT (no tmux binary), a non-zero exit (no server / no panes), or a
 * malformed line degrades to `[]` (skip silently — no server means nothing to
 * resolve). The numeric `window_index` is the SECOND field (variable-length
 * `session_name` last) so a session name with spaces/tabs can't bleed into the
 * numeric field; the parse uses a two-tab slice and reads the name to end. A
 * line missing either tab, or with an empty `pane_id`/`session_name`, is
 * dropped; a non-numeric/empty `window_index` coerces to `null` (the pair still
 * counts — only the index is absent). Default-spawn env is locale-defaulted so
 * a C-locale TAB mangle can't drop every row. Pure relative to the injected
 * `spawnSync`.
 */
export function probeTmuxPanes(spawnSync: SpawnSyncFn): TmuxPanePair[] {
  let res: ReturnType<SpawnSyncFn>;
  try {
    res = spawnSync([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{window_index}\t#{session_name}",
    ]);
  } catch {
    return [];
  }
  if (!res.success || res.exitCode !== 0) {
    return [];
  }
  const text = res.stdout.toString();
  const pairs: TmuxPanePair[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) {
      continue;
    }
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) {
      continue;
    }
    const paneId = line.slice(0, firstTab);
    const indexRaw = line.slice(firstTab + 1, secondTab);
    const sessionName = line.slice(secondTab + 1);
    if (paneId === "" || sessionName === "") {
      continue;
    }
    // A non-numeric / empty index coerces to absent (not a dropped pair) — the
    // agent simply sinks to the tail at restore time rather than being lost.
    const parsed = Number(indexRaw);
    const windowIndex =
      indexRaw !== "" && Number.isInteger(parsed) ? parsed : null;
    pairs.push({
      pane_id: paneId,
      session_name: sessionName,
      window_index: windowIndex,
    });
  }
  return pairs;
}

/**
 * Filter the probed pairs to those that would actually FILL a live NULL-session
 * tmux job (pane id matches AND session still NULL). Posting only fillable
 * pairs keeps the event from spamming when the tmux topology carries panes
 * keeper never launched. The reducer re-applies the same fill-only predicate, so
 * this is a producer-side narrowing, not the authority.
 */
function fillablePairs(jobs: Job[], pairs: TmuxPanePair[]): TmuxPanePair[] {
  const unresolved = new Set<string>();
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (
      job.backend_exec_type === "tmux" &&
      job.backend_exec_session_id == null &&
      job.backend_exec_pane_id != null
    ) {
      unresolved.add(job.backend_exec_pane_id);
    }
  }
  return pairs.filter((p) => unresolved.has(p.pane_id));
}

/**
 * Stamp the live-tmux window-index cache IN PLACE from one probe. For each live
 * tmux job, match `job.backend_exec_pane_id` to a probed pane and store its
 * `window_index` under `job_id` — but ONLY when the probe's `session_name`
 * equals the job's `backend_exec_session_id` (the recycled-`%N` guard: a pane id
 * is reused across kill/create, so a hit whose session differs belongs to a
 * different agent and must NOT stamp). A pane match with a `null` index, a
 * recycled hit, or no match leaves the prior entry untouched (a transient
 * degraded probe shouldn't wipe a good index). job_ids are unique Claude session
 * ids, so an entry is never silently re-keyed to another agent. Pruning of dead
 * job ids is a SEPARATE per-pulse step ({@link pruneWindowIndexCache}) so it
 * runs even when the probe gate is closed (all tmux jobs ended).
 */
function stampWindowIndexCache(
  jobs: Job[],
  pairs: TmuxPanePair[],
  cache: Map<string, number>,
): void {
  const byPaneId = new Map<string, TmuxPanePair>();
  for (const p of pairs) {
    byPaneId.set(p.pane_id, p);
  }
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_type !== "tmux") {
      continue;
    }
    if (typeof job.job_id !== "string" || job.job_id === "") {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (paneId == null) {
      continue;
    }
    const probe = byPaneId.get(paneId);
    if (probe == null || probe.window_index == null) {
      continue;
    }
    // Recycled-`%N` cross-check: only stamp when the probed session matches the
    // job's resolved session. A NULL-session job (not yet filled) can't be
    // cross-checked, so it simply doesn't stamp this pulse.
    if (probe.session_name !== job.backend_exec_session_id) {
      continue;
    }
    cache.set(job.job_id, probe.window_index);
  }
}

/**
 * Prune window-index cache entries for jobs no longer live, IN PLACE. Runs on
 * EVERY pulse (not gated on the probe) so a long-lived daemon doesn't accumulate
 * stale indices once every tmux job ends — the gated stamp arm can't reach this
 * because its gate closes the moment no live tmux job remains. Reads only the
 * projection rows; pure relative to the cache mutation.
 */
function pruneWindowIndexCache(jobs: Job[], cache: Map<string, number>): void {
  const liveIds = new Set<string>();
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (typeof job.job_id === "string" && job.job_id !== "") {
      liveIds.add(job.job_id);
    }
  }
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) {
      cache.delete(id);
    }
  }
}

/**
 * Stable hash of a pairs set for the producer-side dedup gate. Sorts by
 * `(pane_id, session_name)` so SELECT / probe order doesn't churn the hash, then
 * hashes the joined string. A `null` / empty set is the empty-string hash.
 *
 * DELIBERATELY EXCLUDES `window_index`: this hash dedups the pane-fill snapshot
 * POST (which fills NULL sessions onto live jobs), and a pure window reorder
 * must NOT re-fire it. The window order lives in the restore FILE hash
 * (`serializeForHash`) instead, where a reorder rightly forces a rewrite.
 */
function hashPairs(pairs: TmuxPanePair[]): string {
  const sorted = [...pairs].sort((a, b) =>
    a.pane_id < b.pane_id
      ? -1
      : a.pane_id > b.pane_id
        ? 1
        : a.session_name < b.session_name
          ? -1
          : a.session_name > b.session_name
            ? 1
            : 0,
  );
  return String(
    Bun.hash(sorted.map((p) => `${p.pane_id}\t${p.session_name}`).join("\n")),
  );
}

/**
 * Stable layout hash of a `job_id → window_index` map for the window-index post
 * dedup gate. Sorts by `job_id` so map iteration order doesn't churn the hash,
 * then hashes the `job_id\twindow_index` join. INCLUDES `window_index` (the
 * whole point: a reorder MUST re-fire the post so the DB column tracks visual
 * order), unlike {@link hashPairs} which deliberately excludes it. An empty map
 * is the empty-string hash.
 */
function hashWindowIndexCache(cache: Map<string, number>): string {
  const entries = [...cache.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  return String(
    Bun.hash(entries.map(([id, idx]) => `${id}\t${idx}`).join("\n")),
  );
}

/**
 * The tmux poll arm, run on each restore pulse. ONE `list-panes` probe feeds
 * TWO independent consumers (never two `list-panes` calls):
 *
 *  - the WINDOW-ORDER cache (`state.lastWindowIndexByJobId`) — refreshed
 *    whenever any live tmux job exists, regardless of session resolution, so
 *    order capture keeps running after every session resolves; and
 *  - the PANE-FILL snapshot post — minted only when a fillable NULL-session
 *    pair exists and the topology changed since the last post.
 *
 * Gate: `hasLiveTmuxJob` (the WIDER gate). When no live tmux job exists the
 * poller is fully quiescent (no spawn, no cache touch, no post). With a live
 * job, after the single probe:
 *  - the cache refresh runs unconditionally (correlate + prune);
 *  - the fill arm narrows to fillable pairs and posts on a topology change,
 *    deduped via `state.lastSnapshotHash` (which excludes `window_index`, so a
 *    pure reorder never re-fires the fill post).
 *
 * On a post, advances `state.lastSnapshotHash`. PURE relative to its injected
 * `spawnSync` + `post` — no I/O of its own beyond the probe, no env, no DB.
 */
function tmuxSnapshotPulse(
  jobs: Job[],
  state: PulseState,
  spawnSync: SpawnSyncFn,
  post: (msg: TmuxPaneSnapshotMessage) => void,
): void {
  if (!hasLiveTmuxJob(jobs)) {
    return;
  }
  const probed = probeTmuxPanes(spawnSync);
  // Always refresh the window-order cache — order keeps shifting after every
  // session resolves, which the NULL-session-only fill gate below would miss.
  // (The dead-id prune is a separate per-pulse step in `restorePulse`, so it
  // still runs once this gate closes on the last tmux job ending.)
  stampWindowIndexCache(jobs, probed, state.lastWindowIndexByJobId);

  const pairs = fillablePairs(jobs, probed);
  if (pairs.length === 0) {
    return;
  }
  const hash = hashPairs(pairs);
  if (state.lastSnapshotHash === hash) {
    return;
  }
  post({ kind: "tmux-pane-snapshot", pairs });
  state.lastSnapshotHash = hash;
}

/**
 * Emit a `WindowIndexSnapshot` to main when the settled `job_id → window_index`
 * layout CHANGED since the last post. Runs AFTER the per-pulse stamp + prune so
 * the cache it reads is final for the pulse: a reorder, a newly-stamped index, or
 * a prune-driven removal all shift the layout hash and re-fire. The fold keys on
 * `job_id` and overwrites only the entries carried, so a job that just left the
 * cache (ended) keeps its last-folded DB value — the killed-job survival the
 * crash-restore derivation needs. PURE relative to its injected `post`: reads
 * only the cache, mutates only `state.lastWindowIndexHash` on a post.
 */
function windowIndexSnapshotPulse(
  state: PulseState,
  post: (msg: WindowIndexSnapshotMessage) => void,
): void {
  const hash = hashWindowIndexCache(state.lastWindowIndexByJobId);
  if (state.lastWindowIndexHash === hash) {
    return;
  }
  const entries: WindowIndexEntry[] = [];
  for (const [jobId, windowIndex] of state.lastWindowIndexByJobId) {
    entries.push({ job_id: jobId, window_index: windowIndex });
  }
  post({ kind: "window-index-snapshot", entries });
  state.lastWindowIndexHash = hash;
}

/**
 * Probe the backend's current generation handle (the tmux SERVER pid) via the
 * injected `spawnSync`. Returns the pid STRING when the probe yields a single
 * positive integer; `null` for every degraded case — ENOENT (no tmux binary),
 * a non-zero exit (no running server), or output that does not parse to a
 * positive integer (garbage / empty). NEVER throws. A `null` means "no
 * generation observed this pulse" and the caller emits nothing — a degraded
 * probe must NOT fire a spurious boundary. Pure relative to the injected
 * `spawnSync`.
 */
export function probeServerGeneration(spawnSync: SpawnSyncFn): string | null {
  let res: ReturnType<SpawnSyncFn>;
  try {
    res = spawnSync(buildTmuxServerPidArgs());
  } catch {
    return null;
  }
  if (!res.success || res.exitCode !== 0) {
    return null;
  }
  const raw = res.stdout.toString().trim();
  if (raw === "") {
    return null;
  }
  // A positive integer ONLY: a pid is `> 0` and all-digits. `Number` would
  // accept `"12.5"`, `"0x1f"`, `" 12 "`, or scientific notation, any of which
  // would hash as a "generation" and fire a bogus boundary, so gate on a strict
  // digit string then on `> 0`.
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return raw;
}

/**
 * Hash a generation id for the `BackendExecStart` post-dedup gate. A thin
 * wrapper over {@link Bun.hash} so the gate compares by a stable scalar key and
 * the seed path (which reads the prior `generation_id` off the last logged
 * event) shares one hashing rule with the live probe. Pure.
 */
function hashGenerationId(generationId: string): string {
  return String(Bun.hash(generationId));
}

/**
 * Mint a `BackendExecStart` generation-boundary post when the probed server
 * generation CHANGED since the last post (or is the first one recorded). Run
 * UNGATED by {@link hasLiveTmuxJob}: the post-crash state has no live tmux job,
 * yet the freshly-respawned server is precisely the generation that must be
 * recorded so crash-restore can scope to "the session you just lost".
 *
 * A degraded probe ({@link probeServerGeneration} returning `null` — no binary,
 * no server, garbage) emits NOTHING and leaves `state.lastGenerationHash`
 * intact (a transient "no server" pulse must not look like a boundary). On a
 * real change, posts `{backend_type, generation_id}` and advances the dedup
 * hash. The boot-seed ({@link seedLastGenerationHash}) primes the hash before
 * the first pulse so a keeperd restart against an UNCHANGED server is silent.
 * PURE relative to its injected `spawnSync` + `post`.
 */
function backendExecStartPulse(
  state: PulseState,
  spawnSync: SpawnSyncFn,
  post: (msg: BackendExecStartMessage) => void,
): void {
  const generationId = probeServerGeneration(spawnSync);
  if (generationId == null) {
    return;
  }
  const hash = hashGenerationId(generationId);
  if (state.lastGenerationHash === hash) {
    return;
  }
  post({
    kind: "backend-exec-start",
    backend_type: DEFAULT_EXEC_BACKEND,
    generation_id: generationId,
  });
  state.lastGenerationHash = hash;
}

/**
 * Seed {@link PulseState.lastGenerationHash} from the last logged
 * `BackendExecStart` payload so a keeperd restart against an UNCHANGED server
 * does NOT re-emit a spurious boundary. Reads the single most recent event by
 * `id` (the rowid total order — never `ts`), parses its `generation_id`, and
 * hashes it with the SAME rule the live probe uses. NEVER throws: an absent
 * event, a malformed payload, or any read error leaves the hash `null` (the
 * next probe is then treated as the first boundary and DOES post). Idempotent —
 * the caller runs it ONCE, before the first generation pulse. Reads only the
 * read-only `events` table; no projection, no env, no wall-clock.
 */
export function seedLastGenerationHash(
  db: ReturnType<typeof openDb>["db"],
  state: PulseState,
): void {
  try {
    const row = db
      .query(
        "SELECT data FROM events WHERE hook_event = 'BackendExecStart' ORDER BY id DESC LIMIT 1",
      )
      .get() as { data: string | null } | null;
    if (row == null || row.data == null) {
      return;
    }
    const parsed = JSON.parse(row.data) as { generation_id?: unknown };
    const generationId = parsed.generation_id;
    if (typeof generationId !== "string" || generationId === "") {
      return;
    }
    state.lastGenerationHash = hashGenerationId(generationId);
  } catch {
    // Malformed payload / read error → leave the hash null. The first live
    // probe then posts (treated as the first observation), which is benign: at
    // worst one boundary event is recorded that a perfect seed would have
    // suppressed. Never wedge the pulse over a seed read.
  }
}

/**
 * Drive one restore pulse against the worker's read-only connection. Reads the
 * projections via the `read(collection)` helper (identical frame shape to the
 * autopilot worker's), refreshes the window-order cache from the tmux probe,
 * emits the two worker→main posts, builds the single-tier `current` mirror,
 * hashes the file, and writes on a content change.
 *
 * Single-tier write semantics (epic fn-817): `current` is the DUMB continuous
 * live mirror — rebuilt every pulse and written whenever the hashed content
 * changes (it MAY be empty). There is no boot-promote, no high-water tracking,
 * and no collapse-freeze: the live restore set is derived from `keeper.db` at
 * read time (`restore-set.ts`), so the file no longer needs a frozen
 * `last_session` source.
 *
 * Exported for unit reach: tests drive this directly against a seeded writer
 * DB (re-opened read-only for the pulse).
 */
export function restorePulse(
  db: Parameters<typeof runQuery>[0],
  restorePath: string,
  state: PulseState,
  now: () => number = () => Date.now() / 1000,
  snapshot?: {
    /** Inject the tmux pane probe; omit to use {@link defaultSpawnSync}. */
    spawnSync?: SpawnSyncFn;
    /** Post a `TmuxPaneSnapshot` to main; omit to disable the poll arm entirely
     *  (the pure-pulse test path — no parentPort). */
    post?: (msg: TmuxPaneSnapshotMessage) => void;
    /** Post a `WindowIndexSnapshot` to main (the window-order DB channel). Omit
     *  to disable the window-index post arm — the cache still refreshes for the
     *  restore.json mirror, but no DB event is minted (the pure-pulse test
     *  path, or a path that wants only the fill post). */
    postWindowIndex?: (msg: WindowIndexSnapshotMessage) => void;
    /** Post a `BackendExecStart` generation boundary to main. Omit to disable
     *  the generation pulse arm (the pure-pulse test path). UNGATED by live
     *  tmux jobs — wired whenever a real worker runs so a post-crash respawn is
     *  recorded. */
    postBackendExecStart?: (msg: BackendExecStartMessage) => void;
  },
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

  const jobs = read("jobs") as unknown as Job[];
  const epics = read("epics") as unknown as Epic[];
  const epicsById = new Map<string, Epic>();
  for (const epic of epics) {
    epicsById.set(epic.epic_id, epic);
  }

  // Tmux poll arm — runs on EVERY pulse (before the restore-file write's own
  // dedup early-return), self-gated so it is quiescent unless a live tmux job
  // exists. The single probe refreshes the window-order cache AND feeds the
  // NULL-session pane-fill post. Disabled entirely when no `post` is wired (the
  // pure-pulse test path that never spawns a Worker) — the cache then stays at
  // whatever a prior pulse's probe left it.
  if (snapshot?.post) {
    tmuxSnapshotPulse(
      jobs,
      state,
      snapshot.spawnSync ?? defaultSpawnSync,
      snapshot.post,
    );
  }

  // Prune dead job ids from the window-order cache on EVERY pulse, regardless of
  // the probe gate above — the gate closes when no live tmux job remains, but
  // the cache must still shed entries for jobs that just ended.
  pruneWindowIndexCache(jobs, state.lastWindowIndexByJobId);

  // Window-index DB channel — emit AFTER the stamp + prune so the cache is final
  // for the pulse. Change-gated (layout hash) so a steady topology is silent but
  // a reorder / new index / prune re-fires. Disabled when no `postWindowIndex`
  // is wired (the pure-pulse test path) — the restore.json mirror below still
  // carries window_index from the same cache regardless.
  if (snapshot?.postWindowIndex) {
    windowIndexSnapshotPulse(state, snapshot.postWindowIndex);
  }

  // Generation-boundary arm — runs UNGATED by `hasLiveTmuxJob` (unlike the two
  // arms above): the post-crash state carries no live tmux job, yet the
  // freshly-respawned server is exactly the generation crash-restore scopes to.
  // Change-gated on `state.lastGenerationHash` (boot-seeded so an unchanged
  // server across a keeperd restart is silent). A degraded probe (no server /
  // garbage) emits nothing. Disabled when no `postBackendExecStart` is wired
  // (the pure-pulse test path).
  if (snapshot?.postBackendExecStart) {
    backendExecStartPulse(
      state,
      snapshot.spawnSync ?? defaultSpawnSync,
      snapshot.postBackendExecStart,
    );
  }

  const current = buildRestoreTier(
    jobs,
    epicsById,
    now(),
    state.lastWindowIndexByJobId,
  );

  const descriptor: RestoreDescriptor = {
    schema_version: RESTORE_SCHEMA_VERSION,
    current,
  };

  const hashed = serializeForHash(descriptor);
  // `Bun.hash` returns a number — fine for an in-memory dedup key (we never
  // compare across daemon boots). Stringify so the equality check is by
  // value, not by Number coercion edge cases.
  const hash = String(Bun.hash(hashed));
  if (state.lastHash === hash) {
    return; // No content change → no write.
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

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const restorePath = resolveRestorePath();
  const state: PulseState = {
    lastHash: null,
    parentDirEnsured: false,
    lastSnapshotHash: null,
    lastWindowIndexByJobId: new Map(),
    lastWindowIndexHash: null,
    lastGenerationHash: null,
  };
  // Boot-seed the generation gate from the last logged BackendExecStart BEFORE
  // the first pulse so a keeperd restart against an UNCHANGED server emits no
  // spurious boundary. Runs once; never throws.
  seedLastGenerationHash(db, state);
  let shutdown = false;

  // Worker→main posts (main is the sole synthetic-event writer). The worker is
  // otherwise a pure consumer; these two `postMessage` calls are its ONLY
  // worker→main channels: the pane-fill `TmuxPaneSnapshot` and the window-order
  // `WindowIndexSnapshot`. Both ride the same parentPort; main discriminates on
  // `msg.kind`.
  const port = parentPort;
  const snapshot = {
    post: (msg: TmuxPaneSnapshotMessage): void => {
      port.postMessage(msg);
    },
    postWindowIndex: (msg: WindowIndexSnapshotMessage): void => {
      port.postMessage(msg);
    },
    postBackendExecStart: (msg: BackendExecStartMessage): void => {
      port.postMessage(msg);
    },
  };

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
  // the first data_version change.
  try {
    restorePulse(db, restorePath, state, undefined, snapshot);
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
        restorePulse(db, restorePath, state, undefined, snapshot);
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

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
 * — same shape `serializePlanJson` produces), hashes the serialized bytes,
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
 * **DURABLE REVIVE SCRIPT (`revive.sh`).** On the SAME pulse, the worker also
 * maintains a runnable `revive.sh` next to `restore.json` (via the shared
 * {@link renderSnapshotScript}), so a human always has an up-to-date replay
 * script on disk without a socket round-trip. It renders from the SAME live set
 * as the JSON mirror with ONE intentional membership divergence: reconciler-
 * managed workers (`plan_verb === 'work'`) are EXCLUDED — the script is a human
 * replay surface where the reconciler's own re-dispatch would double-spawn them
 * (the rendered header names the excluded count; the JSON mirror keeps them).
 * The sibling is INDEPENDENT: its OWN content-hash gate suppresses no-op
 * rewrites, its OWN `try/catch` swallows a write failure to stderr, and neither
 * file's failed write skips the other's. It is written mode `0600` (agent titles
 * and cwds ride in it) and is DUMP-ONLY — nothing reads it back; crash-restore
 * still derives from `keeper.db`.
 *
 * **Generation-boundary probe (epic fn-819).** Riding the SAME data_version
 * pulse (plus a ~1s idle wake so a post-crash respawn is caught even when
 * keeper's DB is idle), the worker runs ONE cheap
 * `display-message -p '#{pid}:#{start_time}'` server-generation probe — UNGATED
 * by any live tmux job, since a post-crash
 * respawn must be recorded precisely when no job is live. On a generation
 * CHANGE it posts `{kind:"backend-exec-start"}` to main, which mints the
 * `BackendExecStart` synthetic event (folded via an explicit no-op arm — the
 * boundary lives in the event-log `id` order, not a projection column). A
 * producer-side dedup hash (boot-seeded from the last logged boundary) keeps an
 * unchanged generation silent. The restore-file write path stays a pure
 * consumer side-file.
 *
 * The whole-server topology (`jobs.backend_exec_session_id` + `window_index`)
 * is NO LONGER produced here: the persistent tmux control-mode worker emits
 * `TmuxTopologySnapshot` from its existing over-the-connection re-read (epic
 * fn-968), so this worker spawns no `tmux list-panes -a` and re-sources
 * `restore.json`'s `window_index` from the live `jobs` projection (kept fresh
 * by that fold). The cheap generation probe stays here because its ungated
 * post-crash semantics can't move to the control-worker's live-job-gated path.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection — `applyPragmas` runs inside `openDb`
 *    so `busy_timeout` is set on this connection too.
 *  - Typed message protocol: `{kind:"backend-exec-start"}` worker→main,
 *    `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
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
import { harnessOrClaude } from "./agent/harness";
import {
  atomicWriteFile,
  openDb,
  resolveRestorePath,
  resolveRevivePath,
  serializePlanJson,
  sortObjectKeys,
} from "./db";
import {
  buildTmuxServerGenerationArgs,
  DEFAULT_EXEC_BACKEND,
  localeDefaultedEnv,
} from "./exec-backend";
import { compareCandidates, type RestoreCandidate } from "./restore-set";
import { resumeTarget, tierForJobFromEpics } from "./resume-descriptor";
import { runQuery } from "./server-worker";
import { defaultLauncherPrefix, renderSnapshotScript } from "./tabs-core";
import type { TmuxTopologyPane } from "./tmux-focus-derive";
import { keeperTmuxSessionCwd } from "./tmux-session-cwd";
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
 * One `(pane_id, window_index, session_name)` row a tmux `list-panes` probe
 * observed. `pane_id` is the `%N` id, `session_name` the `#{session_name}`, and
 * `window_index` the `#{window_index}` (left-to-right POSITION, not the `@N`
 * identity); `null` when the field was absent/non-numeric (degraded probe). The
 * parse output of {@link probeTmuxTopology}'s shared {@link parsePaneLines} — the
 * topology probe stays here for the boot-seed, which imports it.
 */
export interface TmuxPanePair {
  pane_id: string;
  session_name: string;
  window_index: number | null;
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
 * `generation_id` is the backend's stable generation handle (for tmux, the
 * server pid plus server start time); `backend_type` is {@link
 * DEFAULT_EXEC_BACKEND} (the seam other backends extend). A NEW event name —
 * never reuses the retired `BackendExecSnapshot`.
 */
export interface BackendExecStartMessage {
  kind: "backend-exec-start";
  backend_type: string;
  generation_id: string;
}

/**
 * One pane of a whole-server topology snapshot — the `(pane_id, session_name,
 * window_index, job_id?)` shape. Defined in the pure focus-derive seam so BOTH
 * the boot-seed AND the control-worker feed map their rows through the SAME shape.
 * Re-exported here for existing importers (the boot-seed + its test) that reach
 * the shape alongside {@link probeTmuxTopology}.
 */
export type { TmuxTopologyPane };

/**
 * `Bun.spawnSync`-shaped subset the tmux probes need; injectable so tests drive
 * the parse / classify without a real tmux server. Mirrors the git-worker's
 * `gitOutput` spawnSync shape: `success` + `exitCode` + a stdout `Buffer`.
 * `stderr` is OPTIONAL — {@link probeServerGeneration} collapses every non-zero
 * exit to a degraded-skip and never reads it, but the whole-server topology probe
 * ({@link probeTmuxTopology}, retained for the boot-seed) needs it to tell
 * SERVER-GONE (`no server running` / `failed to connect`) from a TRANSIENT
 * failure (timeout / SIGKILL / EPIPE).
 */
export type SpawnSyncFn = (cmd: string[]) => {
  success: boolean;
  exitCode: number | null;
  stdout: Buffer;
  stderr?: Buffer;
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

/** Upper bound on the `tmux` probe spawns. A wedged tmux server degrades to a
 *  skip rather than freezing the restore pulse. */
const TMUX_PROBE_TIMEOUT_MS = 5000;

/**
 * Idle-wake cadence (ms) for the restore-worker's `watchLoop`. The generation
 * boundary probe ({@link backendExecStartPulse}) must catch a post-crash tmux
 * respawn even when keeper's `data_version` is idle (a crash + respawn writes
 * nothing to keeper.db), so the loop pulses on a ~1s cadence regardless,
 * coalesced with the data_version wake (one probe per loop turn). The probe is a
 * single cheap `display-message -p '#{pid}:#{start_time}'`, dedup-suppressed when
 * unchanged.
 */
const RESTORE_GENERATION_IDLE_MS = 1000;

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
 *
 * **v4 (epic fn-1102): resume_target is the session UUID.** Each agent's
 * `resume_target` flips from the latest session name to the job's `job_id` (the
 * Claude session UUID), so a consumer runs `claude --resume <uuid>` and
 * re-attaches to the EXACT session instead of fuzzy-matching a name. The on-disk
 * field NAME is unchanged; only its meaning (and now-always-UUID value) moved, so
 * a restore-agents util reading a v3 file would resume by name — bump so it can
 * tell the two apart. Side-file version only; the DB `SCHEMA_VERSION` and
 * `keeper/api.py` do NOT move.
 *
 * **v5 (epic fn-1103): resume_target is HARNESS-NATIVE + a `harness` tag rides.**
 * Each agent gains a `harness` field, and `resume_target` is now the harness's own
 * resume token — the session UUID for claude/pi, the back-filled native id for
 * codex/hermes (EMPTY when keeper never resolved one ⇒ not-resumable). A v4 reader
 * assumed `resume_target` was always the claude UUID, so bump. Side-file version
 * only; the DB `SCHEMA_VERSION` and `keeper/api.py` do NOT move.
 */
export const RESTORE_SCHEMA_VERSION = 5;

/**
 * Per-agent record under a session bucket. One per live (`working` / `stopped`)
 * job that carries a non-NULL `backend_exec_session_id`. The fields are the
 * exact substrate the `scripts/restore-agents.ts` util needs to resume each
 * candidate via `keeperAgentLaunch` in resume mode:
 *
 *  - `job_id` — the Claude session id, also the dedup key against live jobs at
 *    restore time.
 *  - `cwd` — the directory the resumed window opens in (set on the
 *    `keeperAgentLaunch` spawn); `null` when the SessionStart event never carried one.
 *  - `resume_target` — pre-resolved via {@link resumeTarget} to the job's session
 *    UUID (`job_id`), so a consumer runs `claude --resume <uuid>` and re-attaches
 *    to the EXACT session. Pre-resolved at producer time so the restore-agents
 *    util doesn't re-derive it.
 *  - `tier` — pre-resolved via {@link tierForJobFromEpics} against the
 *    epicsById map built once per pulse. `null` for non-work jobs or jobs
 *    whose epic isn't in the projection.
 *  - `plan_verb` / `plan_ref` — informational (the restore-agents util surfaces
 *    these in the dry-run label); ride straight off the jobs row.
 *  - `window_index` — the live tmux `#{window_index}` (left-to-right POSITION)
 *    read straight off the `jobs` projection, which the control-worker's
 *    `TmuxTopologySnapshot` fold keeps fresh (epic fn-968). The restore-agents
 *    util sorts restored windows by it so they come back in original visual
 *    order. `null` when the projection has no position yet (not-yet-probed,
 *    recycled pane, non-tmux job, or a legacy file with no field) — those agents
 *    sink to the tail by `created_at` then `job_id`. Bounded staleness during a
 *    control-worker reconnect gap is accepted (restore.json is a periodically
 *    rewritten mirror; crash-restore re-derives from keeper.db).
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
  /** Launching harness (`"claude"`/`"codex"`/`"pi"`/`"hermes"`). ABSENT ⇒ claude
   *  (a NULL `jobs.harness` reads as claude), so a legacy/claude-only file stays
   *  byte-stable. `resume_target` is this harness's own resume token. */
  harness?: string;
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
 * `window_index` is read straight off each job's projection row — the
 * control-worker's `TmuxTopologySnapshot` fold (epic fn-968) keeps that column
 * fresh, so the restore-worker no longer caches it from a poll of its own.
 *
 * The returned tier MAY be empty (`sessions: {}`); an empty live set yields an
 * empty `current` tier.
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
    const harness = harnessOrClaude(job.harness);
    const agent: RestoreAgent = {
      job_id: job.job_id,
      cwd: job.cwd,
      // Per-harness (see resumeTarget): the session UUID for claude/pi, the
      // back-filled native id for codex/hermes, "" when not-resumable.
      resume_target: resumeTarget(job),
      tier,
      plan_verb: job.plan_verb,
      plan_ref: job.plan_ref,
      // Read live off the projection (kept fresh by the control-worker's
      // TmuxTopologySnapshot fold); a number|null already.
      window_index: job.window_index ?? null,
      created_at: job.created_at,
      // Tag ONLY a non-claude harness so a claude-only file stays byte-identical
      // (ABSENT ⇒ claude); the hash gate then never churns on the common case.
      ...(harness !== "claude" ? { harness } : {}),
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

/** Permission bits for the revive-script side-file. It rides agent titles and
 *  cwds (an untrusted-data-to-code surface) and is human-owned, so `0600`. */
const REVIVE_SCRIPT_MODE = 0o600;

/**
 * Build the candidate set for the durable revive-script sibling (`revive.sh`)
 * from the SAME live `jobs` the JSON mirror ({@link buildRestoreTier}) reads —
 * one INTENTIONAL membership divergence: reconciler-managed workers
 * (`plan_verb === 'work'`) are EXCLUDED, because the script is a human replay
 * surface and the reconciler already re-dispatches those panes (a re-run would
 * double-spawn them). The excluded count rides back so the rendered header can
 * surface it (never a silent drop).
 *
 * Applies the identical liveness filters as {@link buildRestoreTier} (`working`/
 * `stopped`, non-NULL `backend_exec_session_id`, non-empty `job_id`) so the only
 * difference from the JSON set is the managed-worker exclusion. Each surviving
 * job maps to a {@link RestoreCandidate}: `resume_target` is the session UUID
 * (`job_id`) for an exact `claude --resume`, `label` the latest `title` (falling
 * back to `job_id`). Candidates are sorted by {@link compareCandidates} (visual
 * window order) so the rendered script is byte-stable across SELECT-order
 * shuffles — the sibling's own hash gate depends on it. PURE.
 */
export function buildReviveScriptCandidates(jobs: Job[]): {
  candidates: RestoreCandidate[];
  excludedManagedCount: number;
} {
  const candidates: RestoreCandidate[] = [];
  let excludedManagedCount = 0;
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
    // The sole divergence from the JSON mirror's membership: a reconciler-managed
    // worker is dropped from the human replay script (it would double-spawn), but
    // its count is surfaced in the rendered header.
    if (job.plan_verb === "work") {
      excludedManagedCount++;
      continue;
    }
    const label =
      typeof job.title === "string" && job.title !== ""
        ? job.title
        : job.job_id;
    const harness = harnessOrClaude(job.harness);
    candidates.push({
      job_id: job.job_id,
      resume_target: resumeTarget(job),
      label,
      window_index: job.window_index ?? null,
      cwd: job.cwd != null && job.cwd !== "" ? job.cwd : null,
      backend_exec_session_id: job.backend_exec_session_id,
      created_at: job.created_at,
      // ABSENT ⇒ claude: tag only a non-claude harness so the claude revive
      // script stays byte-identical (renderSnapshotScript reads harnessOrClaude).
      ...(harness !== "claude" ? { harness } : {}),
    });
  }
  candidates.sort(compareCandidates);
  return { candidates, excludedManagedCount };
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
 * ASCII-escape → trailing-`\n` pipeline `serializePlanJson` uses for
 * `.keeper` files. Exported for unit reach (the tests drive the "did content
 * change" gate directly).
 *
 * The hash scope covers the whole file (`current` + `schema_version`, sans
 * `captured_at`). The disk write itself goes through {@link serializeForWrite}
 * (with the timestamp intact); only the hash input strips it.
 */
export function serializeForHash(descriptor: RestoreDescriptor): string {
  return serializePlanJson({
    schema_version: descriptor.schema_version,
    current: tierForHash(descriptor.current),
  });
}

/**
 * Stable-serialize the descriptor for DISK. Same pipeline as
 * {@link serializeForHash} but keeps the `current` tier's `captured_at` so a
 * human (or the restore-agents util) can see when the snapshot was last
 * written. The `sortObjectKeys` pass in `serializePlanJson` alpha-sorts
 * every nested object's keys, including the `sessions` map's session-name keys,
 * so the output is byte-stable across SELECT order shuffles.
 */
export function serializeForWrite(descriptor: RestoreDescriptor): string {
  // Run the descriptor through sortObjectKeys explicitly so the test suite
  // can compare against the exact byte sequence the writer emits.
  // `serializePlanJson` does the same sort internally; the redundant call
  // is a no-op (sortObjectKeys is idempotent on already-sorted input).
  return serializePlanJson(sortObjectKeys(descriptor));
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
  /**
   * In-memory write-dedup gate for the durable `revive.sh` sibling — INDEPENDENT
   * of {@link PulseState.lastHash} so an unchanged live set rewrites neither file
   * and one file's failed write never advances the other's gate. Hashed over the
   * full rendered script (no timestamp to strip — the script header carries none).
   */
  lastScriptHash: string | null;
  parentDirEnsured: boolean;
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

/** The `tmux list-panes -a` argv the whole-server topology probe runs (retained
 *  for the boot-seed, which imports {@link probeTmuxTopology}). The `-F` format
 *  puts the variable-length `session_name` LAST (after the numeric
 *  `window_index`) so a name with spaces/tabs can't bleed into the numeric
 *  field. */
const TMUX_LIST_PANES_ARGS = [
  "tmux",
  "list-panes",
  "-a",
  "-F",
  "#{pane_id}\t#{window_index}\t#{session_name}",
];

/**
 * Pure parse of the `tmux list-panes -a` stdout into
 * `(pane_id, window_index, session_name)` triples. A malformed line (missing a
 * tab, empty `pane_id`/`session_name`) is dropped; a non-numeric/empty
 * `window_index` coerces to `null` (the pair still counts — only the index is
 * absent). The two-tab slice reads the name to end-of-line, so a trailing-tab
 * name survives; an embedded NEWLINE in a name would split a row (a documented
 * tolerated limit — full `\x01`-delimiter hardening is a Nice-to-Clarify, not
 * required here). Pure — no spawn, no env.
 */
function parsePaneLines(text: string): TmuxPanePair[] {
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
 * Discriminated outcome of {@link probeTmuxTopology}. The producer acts on the
 * kind so a degraded probe never wipes live state:
 *  - `panes`   — a SUCCESSFUL probe (server up). `panes` MAY be empty (server
 *                up with no panes) — the caller treats an empty success as "no
 *                topology change to assert" and does NOT post a wiping snapshot.
 *  - `gone`    — server confirmed down (`no server running`/`failed to
 *                connect`). No live location to assert; the caller skips.
 *  - `transient` — any other non-zero / timeout / SIGKILL / EPIPE / thrown
 *                spawn / non-Buffer parse. KEEP last state — the caller skips.
 */
export type TmuxTopologyProbe =
  | { kind: "panes"; panes: TmuxTopologyPane[] }
  | { kind: "gone" }
  | { kind: "transient" };

/** Substrings that mark a tmux non-zero exit as SERVER-GONE (vs transient).
 *  Matched case-insensitively against the probe's stderr. */
const TMUX_SERVER_GONE_STDERR = ["no server running", "failed to connect"];

/**
 * Whole-server tmux topology probe (epic fn-907). Runs `tmux list-panes -a`
 * (via {@link TMUX_LIST_PANES_ARGS}) and CLASSIFIES the result so a degraded
 * probe can't post a wiping empty topology:
 *
 *  - exit 0                    → `{kind:"panes", panes}` (panes MAY be empty).
 *  - non-zero + gone stderr    → `{kind:"gone"}` (server confirmed down).
 *  - any other non-zero        → `{kind:"transient"}` (timeout/EPIPE/SIGKILL).
 *  - thrown spawn (ENOENT)     → `{kind:"transient"}` (no binary — keep state).
 *
 * The stderr classification is the load-bearing distinction the pane probe
 * lacks (it collapses every non-zero to `[]`): a transient blip must keep the
 * last-known topology, not assert "no panes". Pure relative to the injected
 * `spawnSync`. NEVER throws.
 */
export function probeTmuxTopology(spawnSync: SpawnSyncFn): TmuxTopologyProbe {
  let res: ReturnType<SpawnSyncFn>;
  try {
    res = spawnSync(TMUX_LIST_PANES_ARGS);
  } catch {
    // ENOENT (no tmux binary) / a thrown spawn — indistinguishable from a
    // transient host hiccup here, so keep last state rather than wipe.
    return { kind: "transient" };
  }
  if (res.success && res.exitCode === 0) {
    return { kind: "panes", panes: parsePaneLines(res.stdout.toString()) };
  }
  const stderr = res.stderr?.toString().toLowerCase() ?? "";
  if (TMUX_SERVER_GONE_STDERR.some((s) => stderr.includes(s))) {
    return { kind: "gone" };
  }
  return { kind: "transient" };
}

/**
 * Probe the backend's current generation handle via the injected `spawnSync`.
 * Returns the generation STRING when the probe yields `pid:start_time` with both
 * sides positive integers; `null` for every degraded case — ENOENT (no tmux
 * binary), a non-zero exit (no running server), or output that does not parse to
 * the expected shape (garbage / empty). NEVER throws. A `null` means "no
 * generation observed this pulse" and the caller emits nothing — a degraded
 * probe must NOT fire a spurious boundary. Pure relative to the injected
 * `spawnSync`.
 */
export function probeServerGeneration(spawnSync: SpawnSyncFn): string | null {
  let res: ReturnType<SpawnSyncFn>;
  try {
    res = spawnSync(buildTmuxServerGenerationArgs());
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
  const parts = raw.split(":");
  if (parts.length !== 2) {
    return null;
  }
  const [pid, startTime] = parts;
  for (const part of [pid, startTime]) {
    if (part == null || !/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0) {
      return null;
    }
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
 * UNGATED by any live tmux job: the post-crash state has no live tmux job, yet
 * the freshly-respawned server is precisely the generation that must be recorded
 * so crash-restore can scope to "the session you just lost".
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
 * autopilot worker's), runs the ungated generation-boundary probe, builds the
 * single-tier `current` mirror (window_index read straight off the projection),
 * hashes the file, and writes on a content change.
 *
 * The whole-server topology is NO LONGER probed here — the control-worker emits
 * `TmuxTopologySnapshot` (epic fn-968), and its fold keeps each tmux job's
 * `window_index` fresh on the `jobs` projection, which `buildRestoreTier` reads
 * directly. The ONLY tmux shell-out this pulse retains is the cheap
 * `display-message -p '#{pid}:#{start_time}'` generation probe.
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
    /** Inject the generation probe's spawnSync; omit to use
     *  {@link defaultSpawnSync}. */
    spawnSync?: SpawnSyncFn;
    /** Post a `BackendExecStart` generation boundary to main. Omit to disable
     *  the generation pulse arm (the pure-pulse test path). UNGATED by live
     *  tmux jobs — wired whenever a real worker runs so a post-crash respawn is
     *  recorded. */
    postBackendExecStart?: (msg: BackendExecStartMessage) => void;
    /**
     * Durable revive-script sibling config. When present, the pulse renders +
     * hash-gates + writes `revive.sh` (mode 0600) alongside restore.json,
     * INDEPENDENT of the JSON write (own hash gate, own try/catch). Omit on the
     * pure-JSON test path. `path` is the on-disk revive-script path, `sourcePath`
     * the keeper.db provenance printed in the header, `prefix` the absolute
     * `keeper agent` launcher argv prefix.
     */
    script?: { path: string; sourcePath: string; prefix: string[] };
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

  // Generation-boundary arm — runs UNGATED by any live tmux job: the post-crash
  // state carries no live tmux job, yet the freshly-respawned server is exactly
  // the generation crash-restore scopes to. Change-gated on
  // `state.lastGenerationHash` (boot-seeded so an unchanged server across a
  // keeperd restart is silent). A degraded probe (no server / garbage) emits
  // nothing. Disabled when no `postBackendExecStart` is wired (the pure-pulse
  // test path). This is the SOLE tmux shell-out the restore pulse retains — the
  // whole-server topology is produced by the control-worker (epic fn-968).
  if (snapshot?.postBackendExecStart) {
    backendExecStartPulse(
      state,
      snapshot.spawnSync ?? defaultSpawnSync,
      snapshot.postBackendExecStart,
    );
  }

  // window_index rides straight off each job's projection row (kept fresh by the
  // control-worker's TmuxTopologySnapshot fold), so no cache is threaded here.
  const current = buildRestoreTier(jobs, epicsById, now());

  const descriptor: RestoreDescriptor = {
    schema_version: RESTORE_SCHEMA_VERSION,
    current,
  };

  // Parent-dir mkdir is shared by both side-files (they live in ONE directory);
  // best-effort, once per pulse-worker lifetime. atomicWriteFile surfaces a real
  // ENOENT/EACCES if the dir genuinely can't be made.
  const ensureParentDir = (dir: string): void => {
    if (state.parentDirEnsured) {
      return;
    }
    try {
      mkdirSync(dir, { recursive: true });
      state.parentDirEnsured = true;
    } catch (err) {
      console.error(
        `[restore-worker] mkdir parent dir failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // --- restore.json (the JSON disaster-fallback mirror) ---------------------
  // Hash-gated on its own content (sans captured_at). `Bun.hash` returns a
  // number — stringified so the equality check is by value, not Number-coercion
  // edge cases. A write failure is SWALLOWED to stderr with lastHash left intact
  // (retry next pulse); it NEVER skips the revive.sh write below — the two
  // side-files are INDEPENDENT.
  const jsonHash = String(Bun.hash(serializeForHash(descriptor)));
  if (state.lastHash !== jsonHash) {
    ensureParentDir(dirname(restorePath));
    try {
      atomicWriteFile(restorePath, serializeForWrite(descriptor));
      state.lastHash = jsonHash;
    } catch (err) {
      console.error(
        `[restore-worker] restore.json write failed (will retry next pulse): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // --- revive.sh (the durable runnable revive-script sibling) ---------------
  // Rendered from the SAME live set with reconciler-managed workers excluded (an
  // intentional membership divergence — see buildReviveScriptCandidates). Its
  // OWN hash gate + OWN try/catch keep it INDEPENDENT of restore.json: an
  // unchanged live set rewrites nothing, and either file's failed write never
  // blocks the other. Written mode 0600 (agent titles/cwds ride in it). The
  // script header carries no timestamp, so the whole rendered body is the hash
  // input. Disabled when no `script` config is wired (the pure-JSON test path).
  if (snapshot?.script) {
    const { path: scriptPath, sourcePath, prefix } = snapshot.script;
    const { candidates, excludedManagedCount } =
      buildReviveScriptCandidates(jobs);
    const script = renderSnapshotScript(candidates, {
      prefix,
      tmuxSessionCwd: keeperTmuxSessionCwd(process.env),
      sourcePath,
      excludedManagedCount,
    });
    const scriptHash = String(Bun.hash(script));
    if (state.lastScriptHash !== scriptHash) {
      ensureParentDir(dirname(scriptPath));
      try {
        atomicWriteFile(scriptPath, script, REVIVE_SCRIPT_MODE);
        state.lastScriptHash = scriptHash;
      } catch (err) {
        console.error(
          `[restore-worker] revive.sh write failed (will retry next pulse): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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
  const revivePath = resolveRevivePath();
  // The absolute `keeper agent` launcher prefix + the db provenance path are
  // stable for the worker's lifetime — resolve ONCE, not per pulse.
  const launcherPrefix = defaultLauncherPrefix();
  const state: PulseState = {
    lastHash: null,
    lastScriptHash: null,
    parentDirEnsured: false,
    lastGenerationHash: null,
  };
  // Boot-seed the generation gate from the last logged BackendExecStart BEFORE
  // the first pulse so a keeperd restart against an UNCHANGED server emits no
  // spurious boundary. Runs once; never throws.
  seedLastGenerationHash(db, state);
  let shutdown = false;

  // Worker→main post (main is the sole synthetic-event writer). The worker is
  // otherwise a pure consumer; this `postMessage` is its ONLY worker→main
  // channel: the generation-boundary `BackendExecStart`. (The topology channel
  // moved to the control-worker in epic fn-968.)
  const port = parentPort;
  const snapshot = {
    postBackendExecStart: (msg: BackendExecStartMessage): void => {
      port.postMessage(msg);
    },
    // Durable revive-script sibling: rendered + written 0600 next to
    // restore.json on the same pulse (reconciler-managed workers excluded).
    script: {
      path: revivePath,
      sourcePath: data.dbPath,
      prefix: launcherPrefix,
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
    // Idle-wake the pulse ~1s so the generation-boundary probe catches a
    // post-crash tmux respawn even when keeper's data_version is idle —
    // coalesced with the data_version wake (one probe per loop turn).
    RESTORE_GENERATION_IDLE_MS,
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

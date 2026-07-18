/**
 * Resume-by-name policy (ADR 0034) — the thin decision layer
 * pairing's resume surfaces (`keeper agent resume`, `agent run --resume`) sit
 * on. Resolution itself is NOT reimplemented here: {@link resolveResumeDecision}
 * calls the Agent Bus's `resolveTarget` (`src/bus-identity.ts`) with an EMPTY
 * live-channel set, so a name/former-name/id/prefix/substring match runs
 * through the one keystone resolver keeper has. This module adds the policy a
 * bus lookup doesn't carry:
 *
 *  - **Refuse-live.** A target whose newest match is currently live (pid +
 *    start-time recycle identity, mirroring `isLiveIdentity` in
 *    `src/bus-worker.ts`) is never re-attached. The live decision carries the
 *    exact identity a response-bearing caller may message once over the Bus.
 *    A recycled pid is NOT live.
 *  - **Newest-non-live wins, ties error.** `resolveTarget`'s own ambiguity
 *    collapse prefers a CONNECTED live channel, which never applies here (the
 *    channel set is always empty), so this module implements its OWN collapse:
 *    every candidate `resolveTarget` matched at its tier is re-read for
 *    `updated_at`, the newest wins, and an exact tie is `ambiguous`.
 *  - **A name is a lookup, never a resume key.** `resolveTarget`'s identity
 *    carries neither `harness` nor `resume_target` — this module re-reads the
 *    matched `job_id` row (bound param, never a re-resolve) for those plus
 *    `cwd` / `updated_at` / `created_at`. `NULL` harness normalizes to claude
 *    (`harnessOrClaude`).
 *  - **`NULL` resume_target.** Non-Claude harnesses error `no-target`; their
 *    targets are pinned at birth or filled post-stop, so `NULL` means genuinely
 *    not-resumable.
 *
 * The database handle is READ-ONLY input — every query here is a `SELECT`; the
 * module never writes. Rows with a `NULL` pid or start_time cannot run the
 * recycle check (they are unreachable over the bus either way) and are treated
 * as not-live.
 */

import type { Database } from "bun:sqlite";
import { type LiveChannel, resolveTarget } from "../bus-identity";
import { readOsStartTime } from "../seed-sweep";
import { isPidAlive } from "../server-worker";
import { type HarnessName, harnessOrClaude } from "./harness";

/** No live channels ever feed the resolver here — resume policy is decided
 *  entirely from `jobs`, never the live bus registry. */
const NO_LIVE_CHANNELS: LiveChannel[] = [];

/** One candidate row surfaced in an `ambiguous` result, or named by `live` /
 *  `harness-mismatch`. */
export interface ResumeCandidate {
  job_id: string;
  harness: HarnessName;
  title: string | null;
  updated_at: number;
}

export type ResumeDecision =
  | {
      kind: "ok";
      job_id: string;
      harness: HarnessName;
      resume_target: string;
      cwd: string | null;
      title: string | null;
    }
  /** Refused for re-attach — the newest match is currently live. */
  | {
      kind: "live";
      job_id: string;
      harness: HarnessName;
      title: string | null;
      resume_target: string | null;
      cwd: string | null;
      pid: number;
      start_time: string;
    }
  /** An exact tie for newest among the matched candidates. */
  | { kind: "ambiguous"; candidates: ResumeCandidate[] }
  /** No jobs row and no live channel matched the target at any tier. */
  | { kind: "unknown"; target: string }
  /** A matched row whose resume_target is unusable (NULL or empty). */
  | {
      kind: "no-target";
      job_id: string;
      harness: HarnessName;
      title: string | null;
    }
  /** The resolved match exists but none of the matched candidates carry the
   *  required harness; names the newest wrong-harness match found. */
  | {
      kind: "harness-mismatch";
      job_id: string;
      harness: HarnessName;
      require_harness: HarnessName;
      title: string | null;
    };

/** Injectable I/O seams — default to the real probes; a test overrides them to
 *  stay off real pids/subprocesses/filesystem per the fast-suite discipline. */
export interface ResumePolicyDeps {
  /** Defaults to `server-worker.ts`'s `isPidAlive`. */
  isPidAlive?: (pid: number) => boolean;
  /** Defaults to `seed-sweep.ts`'s `readOsStartTime` (the same sync probe
   *  `bus-worker.ts`'s boot-time `isLiveIdentity` mirrors). */
  readStartTime?: (pid: number) => string | null;
}

interface JobsSecondLookup {
  harness: string | null;
  resume_target: string | null;
  cwd: string | null;
  updated_at: number;
  created_at: number;
}

/** The second read-only `jobs` lookup by resolved `job_id` — never a re-resolve. */
function lookupJobsRow(db: Database, jobId: string): JobsSecondLookup | null {
  const row = db
    .query(
      `SELECT harness, resume_target, cwd, updated_at, created_at
         FROM jobs WHERE job_id = ?`,
    )
    .get(jobId) as JobsSecondLookup | null;
  return row;
}

/** One fully joined candidate — the identity `resolveTarget` matched, plus the
 *  second-lookup jobs columns policy needs. */
interface FullCandidate {
  job_id: string;
  pid: number | null;
  start_time: string | null;
  title: string | null;
  harness: HarnessName;
  resume_target: string | null;
  cwd: string | null;
  updated_at: number;
  created_at: number;
}

/** The recycle-identity liveness check — mirrors `bus-worker.ts`'s
 *  `isLiveIdentity` exactly. A NULL pid or start_time cannot be probed and is
 *  treated as not-live (unreachable over the bus either way). */
function isLive(
  pid: number | null,
  startTime: string | null,
  deps: Required<Pick<ResumePolicyDeps, "isPidAlive" | "readStartTime">>,
): boolean {
  if (pid == null || startTime == null) return false;
  return deps.isPidAlive(pid) && deps.readStartTime(pid) === startTime;
}

function toCandidateSummary(c: FullCandidate): ResumeCandidate {
  return {
    job_id: c.job_id,
    harness: c.harness,
    title: c.title,
    updated_at: c.updated_at,
  };
}

/**
 * Resolve `target` to a resume decision. Reuses the bus's `resolveTarget` with
 * an empty live-channel set for the raw match, then applies resume policy on
 * top — see the module doc comment for the full decision tree.
 *
 * @param target          a current name, former name, session id, id prefix,
 *                         or current-title substring.
 * @param db               read-only `keeper.db` handle (caller-opened).
 * @param requireHarness   when set, only a match carrying this harness may
 *                          resolve `ok`/`no-target`/`live`; a resolved-but-
 *                          wrong-harness match returns `harness-mismatch`.
 */
export function resolveResumeDecision(
  target: string,
  db: Database,
  requireHarness?: HarnessName,
  deps: ResumePolicyDeps = {},
): ResumeDecision {
  const liveDeps = {
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    readStartTime: deps.readStartTime ?? readOsStartTime,
  };
  const resolved = resolveTarget(NO_LIVE_CHANNELS, db, target);
  if (resolved.kind === "unknown") {
    return { kind: "unknown", target };
  }
  const identities =
    resolved.kind === "ok" ? [resolved.identity] : resolved.identities;

  const candidates: FullCandidate[] = [];
  for (const identity of identities) {
    if (identity == null) continue;
    const row = lookupJobsRow(db, identity.job_id);
    if (row == null) continue;
    candidates.push({
      job_id: identity.job_id,
      pid: identity.pid,
      start_time: identity.start_time,
      title: identity.title,
      harness: harnessOrClaude(row.harness),
      resume_target: row.resume_target,
      cwd: row.cwd,
      updated_at: row.updated_at,
      created_at: row.created_at,
    });
  }
  if (candidates.length === 0) {
    return { kind: "unknown", target };
  }

  let pool = candidates;
  if (requireHarness != null) {
    pool = candidates.filter((c) => c.harness === requireHarness);
    if (pool.length === 0) {
      const named = newestOf(candidates)[0];
      return {
        kind: "harness-mismatch",
        job_id: named.job_id,
        harness: named.harness,
        require_harness: requireHarness,
        title: named.title,
      };
    }
  }

  const sorted = newestOf(pool);
  const top = sorted[0];
  const tiedForNewest = sorted.filter((c) => c.updated_at === top.updated_at);
  if (tiedForNewest.length > 1) {
    return {
      kind: "ambiguous",
      candidates: tiedForNewest.map(toCandidateSummary),
    };
  }

  if (isLive(top.pid, top.start_time, liveDeps)) {
    return {
      kind: "live",
      job_id: top.job_id,
      harness: top.harness,
      title: top.title,
      resume_target: top.resume_target,
      cwd: top.cwd,
      pid: top.pid as number,
      start_time: top.start_time as string,
    };
  }

  if (top.resume_target != null && top.resume_target !== "") {
    return {
      kind: "ok",
      job_id: top.job_id,
      harness: top.harness,
      resume_target: top.resume_target,
      cwd: top.cwd,
      title: top.title,
    };
  }

  return {
    kind: "no-target",
    job_id: top.job_id,
    harness: top.harness,
    title: top.title,
  };
}

/** Sort candidates newest-first by `updated_at`, `job_id` ascending as the
 *  deterministic tie-break for stable ordering (mirrors bus-identity's
 *  `LIVE_PREFER_ORDER`). Does not itself resolve a tie — the caller checks
 *  whether `sorted[0]`'s `updated_at` repeats. */
function newestOf(candidates: FullCandidate[]): FullCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;
  });
}

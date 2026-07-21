// Per-session marker files — the writer side of the guard contract. claim
// writes a work marker on its success path; done/block clear it (only when it
// names their task).
//
// One JSON file per session at `~/.local/state/keeper/sessions/<sid>.json`,
// schema_version 2: {schema_version, session_id, kind, task_id|epic_id,
// created_at, pid, start_time}. The TS hook dispatchers (plugin/hooks/lib.ts)
// read these files; the field names + `kind` values are the contract.
//
// Fail OPEN: an absent tracked harness identity makes every helper a silent
// no-op. All filesystem errors are swallowed: marker IO
// never fails the verb. Callers invoke these strictly on the success path (a
// marker for an unclaimed task would lock out commits).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseLinuxStarttime,
  splitArgsLstart,
} from "../../../src/proc-starttime.ts";
import { resolvePlanSessionId } from "./session_id.ts";
import { nowIso } from "./store.ts";

const SCHEMA_VERSION = 2;

// This is only a backstop for un-probeable markers; recycle-safe holders are
// retained while live and discarded as soon as their process identity is dead.
const CLOSE_CLAIM_STALE_MS = 24 * 60 * 60 * 1000;
const ABANDONED_LOG_MAX_BYTES = 512;

export type CloseClaimHolderLiveness = "alive" | "dead" | "unknown";

export interface SessionMarkerProcessProbe {
  readStartTime(pid: number): string | null;
  holderLiveness(pid: number, startTime: string): CloseClaimHolderLiveness;
}

function readProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "ps",
        ["-ww", "-p", String(pid), "-o", "lstart=,args="],
        { encoding: "utf8", timeout: 500, maxBuffer: 4096 },
      );
      if (result.error !== undefined || result.status !== 0) {
        return null;
      }
      const split = splitArgsLstart(result.stdout ?? "");
      return split === null ? null : `darwin:${split.lstart}`;
    }
    if (process.platform === "linux") {
      const raw = parseLinuxStarttime(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
      );
      return raw === null ? null : `linux:${raw}`;
    }
    return null;
  } catch {
    return null;
  }
}

function probeHolderLiveness(
  pid: number,
  expectedStartTime: string,
): CloseClaimHolderLiveness {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  const currentStartTime = readProcessStartTime(pid);
  if (currentStartTime === null) {
    return "unknown";
  }
  return currentStartTime === expectedStartTime ? "alive" : "dead";
}

const realProcessProbe: SessionMarkerProcessProbe = {
  readStartTime: readProcessStartTime,
  holderLiveness: probeHolderLiveness,
};

let installedProcessProbe = realProcessProbe;

export function setSessionMarkerProcessProbe(
  probe: SessionMarkerProcessProbe,
): void {
  installedProcessProbe = probe;
}

export function resetSessionMarkerProcessProbe(): void {
  installedProcessProbe = realProcessProbe;
}

/** Resolve the session id from the env, fail-open (empty/absent → null). */
function sessionId(): string | null {
  return resolvePlanSessionId();
}

/** `~/.local/state/keeper/sessions` honoring a mutated $HOME (tests). Mirrors
 * lib.ts sessionsDir + the home-expansion semantics. */
function sessionsDir(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "keeper", "sessions");
}

function markerPath(sid: string): string {
  return join(sessionsDir(), `${sid}.json`);
}

/** Write the marker for the current session, returning its `created_at` stamp
 * (the value the exclusivity scan compares) — or null when there is no session
 * id or the write failed. All filesystem errors are swallowed. */
function writeMarker(
  kind: string,
  idField: string,
  targetId: string,
  processProbe: SessionMarkerProcessProbe = installedProcessProbe,
): string | null {
  const sid = sessionId();
  if (sid === null) {
    return null;
  }
  const createdAt = nowIso();
  let startTime: string | null = null;
  try {
    startTime = processProbe.readStartTime(process.pid);
  } catch {
    // An unprobeable writer still leaves a stale-bounded marker.
  }
  const record: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    session_id: sid,
    kind,
    [idField]: targetId,
    created_at: createdAt,
    pid: process.pid,
    start_time: startTime,
  };
  try {
    const path = markerPath(sid);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
    return createdAt;
  } catch {
    // Marker IO must never fail the verb.
    return null;
  }
}

/** Unlink the current session's marker only when its `idField` matches
 * `targetId`. A mismatched marker is left intact; all errors swallowed. */
function clearIfMatches(idField: string, targetId: string): void {
  const sid = sessionId();
  if (sid === null) {
    return;
  }
  const path = markerPath(sid);
  let record: unknown;
  try {
    if (!existsSync(path)) {
      return;
    }
    record = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return;
  }
  if (record === null || typeof record !== "object") {
    return;
  }
  if ((record as Record<string, unknown>)[idField] !== targetId) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** Mark this session as actively working `taskId` (kind="work"). Called on the
 * success path of claim. */
export function writeWorkMarker(taskId: string): void {
  writeMarker("work", "task_id", taskId);
}

/** Mark this session as closing `epicId` (kind="close"). Called on the success
 * path of close-preflight. */
export function writeCloseMarker(epicId: string): void {
  writeMarker("close", "epic_id", epicId);
}

/** Clear the work marker, but only if it names `taskId`. Called by done/block. */
export function clearWorkMarker(taskId: string): void {
  clearIfMatches("task_id", taskId);
}

/** Clear the close marker, but only if it names `epicId`. Called by
 * close-finalize on every terminal outcome — success outcomes AND typed errors —
 * so a failed close attempt releases its claim for a clean re-run. */
export function clearCloseMarker(epicId: string): void {
  clearIfMatches("epic_id", epicId);
}

/** One close claim discovered on disk. */
interface CloseClaim {
  sessionId: string;
  createdAt: string;
}

function logAbandonedCloseClaim(sessionId: string, pid: number): void {
  const boundedSessionId = sessionId
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 128);
  const line = JSON.stringify({
    level: "warn",
    event: "abandoned_close_claim_removed",
    session_id: boundedSessionId,
    pid,
  });
  try {
    process.stderr.write(`${line.slice(0, ABANDONED_LOG_MAX_BYTES - 1)}\n`);
  } catch {
    // Logging must not affect close arbitration.
  }
}

function removeAbandonedCloseClaim(
  path: string,
  sessionId: string,
  pid: number,
): void {
  try {
    unlinkSync(path);
  } catch {
    // The dead holder still loses when best-effort cleanup cannot unlink it.
  }
  logAbandonedCloseClaim(sessionId, pid);
}

/** Read every other session's close claim on `epicId`, excluding `selfSid`.
 * Recycle-safe live holders remain rivals regardless of age. Dead holders are
 * removed immediately; un-probeable holders retain the stale-bound behavior.
 * All filesystem errors are swallowed (fail-open → no competitor seen). */
function readRivalCloseClaims(
  epicId: string,
  selfSid: string,
  probeHolder: (pid: number, startTime: string) => CloseClaimHolderLiveness,
): CloseClaim[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const now = Date.now();
  const out: CloseClaim[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const path = join(sessionsDir(), file);
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") {
      continue;
    }
    const r = record as Record<string, unknown>;
    if (
      r.kind !== "close" ||
      r.epic_id !== epicId ||
      typeof r.session_id !== "string" ||
      r.session_id === selfSid ||
      typeof r.created_at !== "string"
    ) {
      continue;
    }
    const ts = Date.parse(r.created_at);
    if (Number.isNaN(ts)) {
      continue;
    }

    const pid = r.pid;
    const startTime = r.start_time;
    let liveness: CloseClaimHolderLiveness = "unknown";
    if (
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof startTime === "string" &&
      startTime.length > 0
    ) {
      try {
        liveness = probeHolder(pid, startTime);
      } catch {
        liveness = "unknown";
      }
    }
    if (liveness === "dead") {
      removeAbandonedCloseClaim(path, r.session_id, pid as number);
      continue;
    }
    if (liveness === "unknown" && now - ts > CLOSE_CLAIM_STALE_MS) {
      continue;
    }
    out.push({ sessionId: r.session_id, createdAt: r.created_at });
  }
  return out;
}

/** Claim the close of `epicId` for the current session, asserting exclusivity.
 *
 * Writes this session's close marker FIRST, then scans for a rival live close
 * claim. Writing before scanning makes the loser deterministic: a later claimant
 * always observes the earlier one's marker, so the second closer backs off and
 * the first proceeds. The winner is the claim with the lowest
 * `(created_at, session_id)`; on a lost race this session unlinks its own marker
 * and returns the holder, so the caller fails loud with the loser message.
 *
 * Returns `{ heldBy }` when THIS session lost (a rival holds the claim), or null
 * when this session holds it. Fail-open: no session id / write failure → null
 * (claim uncontested — marker IO never blocks the verb). This is best-effort by
 * design: the narrow boot-window where two closers scan before either writes is
 * an accepted wasted boot (there is no sanctioned pre-announce write path), and
 * close-finalize is idempotent, so a slipped duplicate never corrupts. */
export function claimCloseExclusive(
  epicId: string,
  processProbe: SessionMarkerProcessProbe = installedProcessProbe,
): { heldBy: string } | null {
  const sid = sessionId();
  if (sid === null) {
    return null;
  }
  const myCreatedAt = writeMarker("close", "epic_id", epicId, processProbe);
  if (myCreatedAt === null) {
    return null;
  }
  let winnerSid = sid;
  let winnerCreatedAt = myCreatedAt;
  for (const rival of readRivalCloseClaims(
    epicId,
    sid,
    processProbe.holderLiveness,
  )) {
    if (
      rival.createdAt < winnerCreatedAt ||
      (rival.createdAt === winnerCreatedAt && rival.sessionId < winnerSid)
    ) {
      winnerSid = rival.sessionId;
      winnerCreatedAt = rival.createdAt;
    }
  }
  if (winnerSid !== sid) {
    // Lost the race — release our own marker so it never masquerades as a live
    // rival to a third claimant, then report the holder.
    clearCloseMarker(epicId);
    return { heldBy: winnerSid };
  }
  return null;
}

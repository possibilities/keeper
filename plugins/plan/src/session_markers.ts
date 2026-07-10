// Per-session marker files — the writer side of the guard contract. claim
// writes a work marker on its success path; done/block clear it (only when it
// names their task).
//
// One JSON file per session at `~/.local/state/keeper/sessions/<sid>.json`,
// schema_version 1: {schema_version, session_id, kind, task_id|epic_id,
// created_at}. The TS hook dispatchers (plugin/hooks/lib.ts) read these files;
// the field names + `kind` values are the contract.
//
// Fail OPEN: an absent tracked harness identity makes every helper a silent
// no-op. All filesystem errors are swallowed: marker IO
// never fails the verb. Callers invoke these strictly on the success path (a
// marker for an unclaimed task would lock out commits).

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

import { resolvePlanSessionId } from "./session_id.ts";
import { nowIso } from "./store.ts";

const SCHEMA_VERSION = 1;

/** A close claim older than this is treated as abandoned (a hard-killed session
 * that never cleared its marker) so a re-close is never blocked forever. Matches
 * the hook reader's staleness window (plugin/hooks/lib.ts) — one contract. A
 * genuinely-longer close (a closer paused on a planner QUESTION) stays within it,
 * and a clean termination clears the marker outright, so this only ever bounds a
 * true crash leak. */
const CLOSE_CLAIM_STALE_MS = 7 * 24 * 60 * 60 * 1000;

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
): string | null {
  const sid = sessionId();
  if (sid === null) {
    return null;
  }
  const createdAt = nowIso();
  const record: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    session_id: sid,
    kind,
    [idField]: targetId,
    created_at: createdAt,
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

/** Read every OTHER session's LIVE close claim on `epicId` — a fresh close
 * marker naming this epic, excluding `selfSid`. Stale (crash-leaked) and
 * unparseable markers are skipped so a dead claim never blocks a re-close. All
 * filesystem errors are swallowed (fail-open → no competitor seen). */
function readRivalCloseClaims(epicId: string, selfSid: string): CloseClaim[] {
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
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
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
    if (Number.isNaN(ts) || now - ts > CLOSE_CLAIM_STALE_MS) {
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
export function claimCloseExclusive(epicId: string): { heldBy: string } | null {
  const sid = sessionId();
  if (sid === null) {
    return null;
  }
  const myCreatedAt = writeMarker("close", "epic_id", epicId);
  if (myCreatedAt === null) {
    return null;
  }
  let winnerSid = sid;
  let winnerCreatedAt = myCreatedAt;
  for (const rival of readRivalCloseClaims(epicId, sid)) {
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

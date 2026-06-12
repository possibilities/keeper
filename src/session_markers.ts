// Per-session marker files — the writer side of the cross-language guard
// contract (planctl/session_markers.py). claim writes a work marker on its
// success path; done/block clear it (only when it names their task).
//
// One JSON file per session at `~/.local/state/planctl/sessions/<sid>.json`,
// schema_version 1: {schema_version, session_id, kind, task_id|epic_id,
// created_at}. The TS hook dispatchers (plugin/hooks/lib.ts) read these files;
// the field names + `kind` values are the contract.
//
// Fail OPEN: the session id comes from CLAUDE_CODE_SESSION_ID — absent makes
// every helper a silent no-op. All filesystem errors are swallowed: marker IO
// never fails the verb. Callers invoke these strictly on the success path (a
// marker for an unclaimed task would lock out commits).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { nowIso } from "./store.ts";

const SCHEMA_VERSION = 1;

/** Resolve the session id from the env, fail-open (empty/absent → null). */
function sessionId(): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

/** `~/.local/state/planctl/sessions` honoring a mutated $HOME (tests). Mirrors
 * lib.ts sessionsDir + the Python expanduser semantics. */
function sessionsDir(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "planctl", "sessions");
}

function markerPath(sid: string): string {
  return join(sessionsDir(), `${sid}.json`);
}

/** Write the marker for the current session. Silent no-op when no session id;
 * all filesystem errors swallowed. */
function writeMarker(kind: string, idField: string, targetId: string): void {
  const sid = sessionId();
  if (sid === null) {
    return;
  }
  const record: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    session_id: sid,
    kind,
    [idField]: targetId,
    created_at: nowIso(),
  };
  try {
    const path = markerPath(sid);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
  } catch {
    // Marker IO must never fail the verb.
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
 * success path of claim. Mirrors write_work_marker. */
export function writeWorkMarker(taskId: string): void {
  writeMarker("work", "task_id", taskId);
}

/** Clear the work marker, but only if it names `taskId`. Called by done/block.
 * Mirrors clear_work_marker. */
export function clearWorkMarker(taskId: string): void {
  clearIfMatches("task_id", taskId);
}

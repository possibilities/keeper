// State-store spine — the byte-parity port of planctl/store.py's read paths and
// timestamp/actor utilities.
//
// Every read is read-never-creates: an absent or corrupt sidecar yields null,
// never a freshly-written empty file, so the cold-start hot path stays
// side-effect free (loadJsonSafe + LocalFileStateStore.loadRuntime).
//
// nowIso / getActor are spine utilities the read-only verbs never invoke (they
// never stamp), but they land here with bun:test units pinning the
// cross-implementation contracts: PLANCTL_NOW returned verbatim after a strict
// shape check, the wall-clock field padded to 6 fractional digits, and the
// actor-resolution precedence (PLANCTL_ACTOR -> git user.email -> user.name ->
// USER -> unknown).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parse JSON at `path`; null on missing OR corrupt (never throws). Mirrors
 * load_json_safe — the silent-on-corrupt read every verb relies on. */
export function loadJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** File-based runtime-state store — the read side of LocalFileStateStore.
 *
 * Runtime sidecars live at `<stateDir>/tasks/<task_id>.state.json` (per-task)
 * and `<stateDir>/epics/<epic_id>.state.json` (per-epic). loadRuntime is
 * read-never-creates: an absent or corrupt sidecar returns null. */
export class LocalFileStateStore {
  private readonly tasksDir: string;
  private readonly epicsDir: string;

  constructor(stateDir: string) {
    this.tasksDir = join(stateDir, "tasks");
    this.epicsDir = join(stateDir, "epics");
  }

  private statePath(taskId: string): string {
    return join(this.tasksDir, `${taskId}.state.json`);
  }

  private epicStatePath(epicId: string): string {
    return join(this.epicsDir, `${epicId}.state.json`);
  }

  /** Runtime overlay for a task, or null when absent/corrupt. Reading never
   * creates the file or dirties the tree. */
  loadRuntime(taskId: string): Record<string, unknown> | null {
    const path = this.statePath(taskId);
    if (!existsSync(path)) {
      return null;
    }
    return loadJsonSafe(path);
  }

  /** Runtime overlay for an epic, or null when absent/corrupt. */
  loadEpicRuntime(epicId: string): Record<string, unknown> | null {
    const path = this.epicStatePath(epicId);
    if (!existsSync(path)) {
      return null;
    }
    return loadJsonSafe(path);
  }
}

// The PLANCTL_NOW / now_iso wire format: %Y-%m-%dT%H:%M:%S.%fZ — a 6-digit
// fractional-second field. Matched against the override and produced for the
// wall-clock path.
const NOW_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Strict-shape check on a PLANCTL_NOW override: the exact strptime round-trip
 * Python applies (every field two-digit, a literal-Z 6-digit fraction). A
 * value that matches the regex but is calendar-nonsense (month 13) still fails
 * the round-trip in Python; we validate the calendar fields too so a malformed
 * value is a hard error, never a silent wall-clock fallback. */
function isValidNowIso(value: string): boolean {
  if (!NOW_ISO_REGEX.test(value)) {
    return false;
  }
  // Calendar-validate via Date round-trip on the second-precision prefix
  // (Date cannot represent microseconds, so check only Y-M-D H:M:S here; the
  // regex already pinned the 6-digit fraction).
  const isoMs = `${value.slice(0, 19)}Z`;
  const parsed = new Date(isoMs);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  // Reject values JS's lenient parser would normalize (e.g. month 13 -> next
  // year): re-serialize and compare the second-precision prefix.
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Current UTC timestamp in `%Y-%m-%dT%H:%M:%S.%fZ` with microsecond
 * precision. PLANCTL_NOW overrides the clock and is returned VERBATIM after a
 * strict shape check (no Date round-trip) — a malformed value is a hard error,
 * matching the Python contract that holds every implementation to one format.
 *
 * JS Date is millisecond-native; the wall-clock path pads the 3-digit
 * millisecond fraction out to the 6-digit field. */
export function nowIso(): string {
  const override = process.env.PLANCTL_NOW;
  if (override !== undefined) {
    if (!isValidNowIso(override)) {
      throw new Error(
        `PLANCTL_NOW must match '%Y-%m-%dT%H:%M:%S.%fZ' (got '${override}')`,
      );
    }
    return override;
  }
  // toISOString -> 2026-06-12T08:44:14.300Z; widen .300Z to .300000Z.
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Run a git config lookup, returning the trimmed value or null on any failure
 * (non-zero exit, git absent). Mirrors get_actor's subprocess.run + except. */
function gitConfig(key: string): string | null {
  const proc = Bun.spawnSync(["git", "config", key]);
  if (proc.exitCode !== 0) {
    return null;
  }
  const value = proc.stdout.toString().trim();
  return value ? value : null;
}

/** Current actor identity: PLANCTL_ACTOR -> git user.email -> git user.name ->
 * USER -> "unknown". Mirrors get_actor's precedence exactly. */
export function getActor(): string {
  const actor = process.env.PLANCTL_ACTOR;
  if (actor) {
    return actor.trim();
  }
  return (
    gitConfig("user.email") ??
    gitConfig("user.name") ??
    process.env.USER ??
    "unknown"
  );
}

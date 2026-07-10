// State-store spine — the byte-parity port of planctl/store.py.
//
// Reads are read-never-creates: an absent or corrupt sidecar yields null, never
// a freshly-written empty file, so the cold-start hot path stays side-effect
// free (loadJsonSafe + LocalFileStateStore.loadRuntime).
//
// Writes go through atomicWrite/atomicWriteJson: tmp file in the target's
// directory, fsync, rename, parent-dir fsync, tmp unlinked on any throw — and
// each records a touched-path under the current tracked session log
// (fail-OPEN when no supported harness identity exists). atomicWriteJson
// serializes with a recursive key sort + indent 2 +
// trailing newline, byte-identical to Python json.dumps(indent=2,
// sort_keys=True)+newline (JSON.stringify does not sort, so sortKeysDeep does).
//
// LocalFileStateStore.saveRuntime lands per-task runtime sidecars; lockTask
// takes a real flock(2) (via src/flock.ts) that interops with Python's
// fcntl.flock across engines.
//
// nowIso / getActor are spine utilities pinning the cross-implementation
// contracts: KEEPER_PLAN_NOW returned verbatim after a strict shape check, the
// wall-clock field padded to 6 fractional digits, and the actor-resolution
// precedence (KEEPER_PLAN_ACTOR -> git user.email -> user.name -> USER ->
// unknown).

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { getExec } from "./exec.ts";
import { flockOrThrow, LOCK_EX, LOCK_UN } from "./flock.ts";
import { resolvePlanSessionId } from "./session_id.ts";
import { resolveDataDir } from "./state_path.ts";
import { readStdinText } from "./stdin.ts";

/** Parse JSON at `path`; null on missing OR corrupt (never throws). Mirrors
 * load_json_safe — the silent-on-corrupt read every verb relies on. */
export function loadJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse JSON at `path`, RAISING on a missing or malformed file (the strict
 * counterpart of loadJsonSafe). Mirrors load_json — the verb-level error path
 * surfaces the throw as Python's emit_error envelope, so the caller must catch
 * it where Python catches FileNotFoundError / JSONDecodeError. */
export function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** Read a payload from `fileArg` (a path), or from stdin when it is null or
 * `"-"`. Mirrors read_file_or_stdin: stdin is read via the stdin-provider seam
 * (fd 0 in a compiled run; the harness override in-process) so a piped or
 * heredoc body works the same across engines. */
export function readFileOrStdin(fileArg: string | null): string {
  if (fileArg === null || fileArg === "-") {
    return readStdinText();
  }
  return readFileSync(fileArg, "utf-8");
}

/** Resolve a user-supplied path the way the repo setters persist it: expand a
 * leading `~`, make it absolute against cwd, then resolve symlinks. A path that
 * does not exist on disk still normalizes to its absolute form (never throws) —
 * the `str(Path(p).expanduser().resolve())` contract. */
export function resolveUserPath(pathArg: string): string {
  let expanded = pathArg;
  if (pathArg === "~" || pathArg.startsWith("~/")) {
    expanded = (process.env.HOME ?? "") + pathArg.slice(1);
  }
  const abs = resolve(expanded);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// JSON value shape we serialize — mirrors what Python's json.dumps accepts for
// state files (objects, arrays, strings, numbers, bool, null).
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Recursively sort every object's keys (arrays keep order). JSON.stringify
 * does NOT sort; this reproduces Python json.dumps(sort_keys=True), which sorts
 * at all depths. Lexicographic by code unit — matches Python's str ordering for
 * the ASCII/identifier keys planctl state uses. */
function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key] as JsonValue);
    }
    return sorted;
  }
  return value;
}

/** Escape every non-ASCII code unit to \uXXXX (lowercase hex), reproducing
 * Python json.dumps's default ensure_ascii=True. JSON.stringify emits raw UTF-8
 * and the short escapes (\n, \", \\, control chars < 0x20), but leaves every
 * code point >= 0x7F raw — including DEL (0x7F), which Python escapes. Escaping
 * per UTF-16 code unit reproduces Python's per-surrogate emission for astral
 * chars (😀 -> \ud83d\ude00) exactly. */
function ensureAscii(serialized: string): string {
  let out = "";
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    if (code >= 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += serialized[i];
    }
  }
  return out;
}

/** Serialize `data` byte-identical to Python json.dumps(indent=2,
 * sort_keys=True) + "\n": recursive key sort, 2-space indent, ensure_ascii
 * \uXXXX escaping, single trailing newline. The recursive sort, the
 * ensure_ascii escaping, and the trailing newline are the three facts a naive
 * JSON.stringify(data, null, 2) gets wrong. */
export function serializeStateJson(data: Record<string, unknown>): string {
  return `${ensureAscii(JSON.stringify(sortKeysDeep(data as JsonValue), null, 2))}\n`;
}

/** Write `content` to `path` atomically: a tmp file in the same directory
 * (pid+random suffix), fsync, rename, parent-dir fsync; the tmp file is unlinked
 * on any throw. Mirrors planctl/_util.py atomic_write — same-dir tmp keeps the
 * rename on one filesystem; the parent fsync makes the directory entry durable.
 * Bun.write is NOT atomic, so this uses node:fs primitives throughout. */
export function atomicWriteRaw(path: string, content: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmpPath = join(
    parent,
    `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w");
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
    // fsync the parent dir so the rename's directory entry is durable.
    const parentFd = openSync(parent, "r");
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed / unusable — nothing to recover
      }
    }
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup; surface the original error below
      }
    }
    throw err;
  }
}

/** Append `path` to the current session's touched-paths log, then return.
 * Layout: `<data-dir>/state/sessions/<sid>/touched/<uuid4hex>.txt`, content =
 * the repo-relative POSIX path + newline. Mirrors planctl/store.py _record_touched:
 * session identity fail-OPEN (no sid -> silent skip), walk up <=20 levels
 * for a data dir, all exceptions swallowed — a recorder failure never surfaces to
 * a caller (it degrades to wildcard staging at commit, which the hook rejects). */
export function recordTouched(path: string, dataDir?: string): void {
  try {
    const sid = resolvePlanSessionId();
    if (sid === null) {
      return;
    }

    // Resolve dataDir: walk up from path's parent to find a `.keeper/` data dir.
    let resolvedDataDir = dataDir;
    if (resolvedDataDir === undefined) {
      let check = dirname(resolve(path));
      for (let i = 0; i < 20; i += 1) {
        const candidate = resolveDataDir(check);
        if (candidate !== null) {
          resolvedDataDir = candidate;
          break;
        }
        const parent = dirname(check);
        if (parent === check) {
          return; // reached fs root, no data dir
        }
        check = parent;
      }
      if (resolvedDataDir === undefined) {
        return;
      }
    }

    const touchedDir = join(
      resolvedDataDir,
      "state",
      "sessions",
      sid,
      "touched",
    );
    mkdirSync(touchedDir, { recursive: true });

    // Repo root = the data-dir parent; record the path relative to it, POSIX.
    const repoRoot = dirname(resolvedDataDir);
    const relPath = relative(realpathSync(repoRoot), realpathSync(path));
    // A path outside the repo root yields a leading "..": skip silently (Python
    // raises ValueError on relative_to and skips).
    if (relPath.startsWith("..")) {
      return;
    }
    const posixRel = relPath.split(sep).join("/");

    const touchFile = join(
      touchedDir,
      `${randomBytes(16).toString("hex")}.txt`,
    );
    writeFileSync(touchFile, `${posixRel}\n`);
  } catch {
    // Never let recorder failures surface to callers (Python swallows all).
  }
}

/** Atomic write + touched-path record — the drop-in planctl uses everywhere a
 * state file is rewritten (planctl/store.py atomic_write). `dataDir` is the
 * data dir; auto-detected from `path` when omitted. */
export function atomicWrite(
  path: string,
  content: string,
  dataDir?: string,
): void {
  atomicWriteRaw(path, content);
  recordTouched(path, dataDir);
}

/** Write `data` as state JSON atomically with sorted keys (atomic_write_json).
 * The serialization is byte-identical to Python's. */
export function atomicWriteJson(
  path: string,
  data: Record<string, unknown>,
  dataDir?: string,
): void {
  atomicWrite(path, serializeStateJson(data), dataDir);
}

/** File-based runtime-state store — the read side of LocalFileStateStore.
 *
 * Runtime sidecars live at `<stateDir>/tasks/<task_id>.state.json` (per-task)
 * and `<stateDir>/epics/<epic_id>.state.json` (per-epic). loadRuntime is
 * read-never-creates: an absent or corrupt sidecar returns null. */
export class LocalFileStateStore {
  private readonly tasksDir: string;
  private readonly epicsDir: string;
  private readonly locksDir: string;

  constructor(stateDir: string) {
    this.tasksDir = join(stateDir, "tasks");
    this.epicsDir = join(stateDir, "epics");
    this.locksDir = join(stateDir, "locks");
  }

  private statePath(taskId: string): string {
    return join(this.tasksDir, `${taskId}.state.json`);
  }

  private epicStatePath(epicId: string): string {
    return join(this.epicsDir, `${epicId}.state.json`);
  }

  private lockPath(taskId: string): string {
    return join(this.locksDir, `${taskId}.lock`);
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

  /** Write per-task runtime state (gitignored sidecar) atomically with sorted
   * keys. Mirrors save_runtime: mkdir tasks/, then atomic_write_json. */
  saveRuntime(taskId: string, data: Record<string, unknown>): void {
    mkdirSync(this.tasksDir, { recursive: true });
    atomicWriteJson(this.statePath(taskId), data);
  }

  /** Write per-epic runtime state (gitignored sidecar) atomically with sorted
   * keys — the epic mirror of {@link saveRuntime}. mkdir epics/, then
   * atomic_write_json. The daemon plan-worker folds this overlay into the
   * `epics` projection (the epic-level parked-question board surface). */
  saveEpicRuntime(epicId: string, data: Record<string, unknown>): void {
    mkdirSync(this.epicsDir, { recursive: true });
    atomicWriteJson(this.epicStatePath(epicId), data);
  }

  /** Hold an exclusive flock(2) on `<data-dir>/state/locks/<task_id>.lock` for
   * the duration of `fn`, then release. Mirrors lock_task: a real advisory
   * whole-file lock (LOCK_EX) that a Python fcntl peer also blocks on; the fd is
   * held for the lock lifetime and released (LOCK_UN) + closed in finally. */
  withTaskLock<T>(taskId: string, fn: () => T): T {
    mkdirSync(this.locksDir, { recursive: true });
    const lockPath = this.lockPath(taskId);
    const fd = openSync(lockPath, "w");
    try {
      flockOrThrow(fd, LOCK_EX);
      return fn();
    } finally {
      try {
        flockOrThrow(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    }
  }

  /** Hold an exclusive flock(2) on `<data-dir>/state/locks/<epic_id>.lock` for
   * the duration of `fn`, then release — the epic mirror of {@link withTaskLock}.
   * Epic ids (`fn-N-slug`) and task ids (`fn-N-slug.M`) never collide, so the
   * shared locks dir is safe. */
  withEpicLock<T>(epicId: string, fn: () => T): T {
    mkdirSync(this.locksDir, { recursive: true });
    const lockPath = this.lockPath(epicId);
    const fd = openSync(lockPath, "w");
    try {
      flockOrThrow(fd, LOCK_EX);
      return fn();
    } finally {
      try {
        flockOrThrow(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    }
  }
}

// The now_iso wire format: %Y-%m-%dT%H:%M:%S.%fZ — a 6-digit fractional-second
// field. Matched against the KEEPER_PLAN_NOW override and produced for the
// wall-clock path.
const NOW_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The clock override: KEEPER_PLAN_NOW. Undefined when unset. */
function clockOverride(): string | undefined {
  return process.env.KEEPER_PLAN_NOW;
}

/** Strict-shape check on a clock override: the exact strptime round-trip Python
 * applies (every field two-digit, a literal-Z 6-digit fraction). A value that
 * matches the regex but is calendar-nonsense (month 13) still fails the
 * round-trip in Python; we validate the calendar fields too so a malformed
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
 * precision. KEEPER_PLAN_NOW overrides the clock
 * and is returned VERBATIM after a strict shape check (no Date round-trip) — a
 * malformed value is a hard error, matching the Python contract that holds every
 * implementation to one format.
 *
 * JS Date is millisecond-native; the wall-clock path pads the 3-digit
 * millisecond fraction out to the 6-digit field. */
export function nowIso(): string {
  const override = clockOverride();
  if (override !== undefined) {
    if (!isValidNowIso(override)) {
      throw new Error(
        `KEEPER_PLAN_NOW must match '%Y-%m-%dT%H:%M:%S.%fZ' (got '${override}')`,
      );
    }
    return override;
  }
  // toISOString -> 2026-06-12T08:44:14.300Z; widen .300Z to .300000Z.
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Run a git config lookup through the external-command facade, returning the
 * trimmed value or null on any failure (non-zero exit, git absent). Mirrors
 * get_actor's subprocess.run + except. Production runs verbatim git; the test
 * harness drives a faked result so getActor's precedence is git-free. */
function gitConfig(key: string): string | null {
  const proc = getExec().run("git", ["config", key]);
  if (proc.exitCode !== 0) {
    return null;
  }
  const value = proc.stdout.trim();
  return value ? value : null;
}

/** Current actor identity: KEEPER_PLAN_ACTOR ->
 * git user.email -> git user.name -> USER -> "unknown". Mirrors get_actor's
 * precedence exactly. */
export function getActor(): string {
  const actor = process.env.KEEPER_PLAN_ACTOR;
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

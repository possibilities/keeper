/**
 * Monotonic per-cwd ordinal for the `{dir}-NNN` fallback session name. Keeps a
 * flock-guarded JSON counter under `~/.local/state/keeper-agent/cwd-ordinals.json`,
 * keyed by cwd basename; each launch increments and returns the new value.
 *
 * Unlike the vendored picker (which locks a SIDECAR and atomically renames),
 * Python here flocks the DATA FILE directly and rewrites it in place — open
 * append-read, flock, read, truncate, rewrite, release. We replicate exactly
 * using the raw flock exports on a NON-truncating open (`FileLock.acquire`
 * opens `"w"`, which would truncate the counter). Fail-open: any IO/parse
 * error returns ordinal 1.
 *
 * The state dir resolves through the single XDG-honoring source
 * (`defaultKeeperAgentStateDir`) that the tmux launcher also uses, so the counter
 * and the launcher's `tmux-runs/` artifacts never split across two dirs.
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FLOCK_CONSTANTS, flockFd, loadLibc, setCloexec } from "../usage-flock";
import { defaultKeeperAgentStateDir } from "./tmux-launch";

function stateDir(): string {
  return defaultKeeperAgentStateDir(process.env);
}

/**
 * The pre-relocation `~/.local/state/agentwrap/` state dir, resolved with the
 * SAME XDG logic as the new path so there is exactly one old→new mapping (an
 * intra-filesystem rename). In the real XDG-unset world this is
 * `~/.local/state/agentwrap`, where the flock-guarded counter actually lived.
 */
function legacyAgentStateDir(): string {
  const xdgStateHome = (process.env.XDG_STATE_HOME ?? "").trim();
  if (xdgStateHome !== "") {
    return join(xdgStateHome, "agentwrap");
  }
  return join(homedir(), ".local", "state", "agentwrap");
}

/**
 * One-time guarded relocation of the legacy state dir to the keeper-agent path
 * via an INODE-PRESERVING atomic `rename(2)` — never a copy-forward (flock binds
 * the inode; a copy would fork the lock and silently diverge the cwd-ordinals
 * counter). Runs BEFORE any new-path mkdir/flock at every state-dir entry surface
 * (here, and `realDeps()` before the launcher's `tmux-runs/` mkdir). Idempotent +
 * fail-open so a launch never blocks on it:
 *   - new dir already present  → nothing to do (already migrated, or fresh state)
 *   - old dir absent           → nothing to do (fresh install)
 *   - else rename(old, new); tolerate ENOENT (a racing launch migrated first),
 *     EEXIST/ENOTEMPTY (the new dir appeared mid-flight — new wins, never
 *     unlink+recreate the lock file), and any other error (fail-open: a fresh
 *     counter is a cosmetic reset of the {dir}-NNN ordinal, never a blocker).
 */
export function migrateLegacyAgentStateDir(): void {
  const newDir = defaultKeeperAgentStateDir(process.env);
  if (existsSync(newDir)) {
    return;
  }
  const oldDir = legacyAgentStateDir();
  if (!existsSync(oldDir)) {
    return;
  }
  try {
    renameSync(oldDir, newDir);
  } catch {
    // Fail-open — see the doc comment's tolerated-error list.
  }
}

function counterPath(): string {
  return join(stateDir(), "cwd-ordinals.json");
}

/**
 * Return the next ordinal for `dirName`, incrementing the on-disk counter under
 * an exclusive flock held on the data file itself. Fail-open: any error returns
 * 1 rather than blocking the launch.
 */
export function nextCwdOrdinal(dirName: string): number {
  let fd: number | null = null;
  let lib: ReturnType<typeof loadLibc>["lib"] | null = null;
  let locked = false;
  let syms: ReturnType<typeof loadLibc>["syms"] | null = null;
  try {
    // Chokepoint: relocate the legacy dir BEFORE the new-path mkdir, else a
    // fresh empty new dir strands the old counter and the rename hits ENOTEMPTY.
    migrateLegacyAgentStateDir();
    mkdirSync(stateDir(), { recursive: true });
    // Python's "a+": create-if-absent, read+append, no truncate. "a+" here
    // matches — the file is created when missing and existing content survives.
    fd = openSync(counterPath(), "a+");
    const loaded = loadLibc();
    lib = loaded.lib;
    syms = loaded.syms;
    // FD_CLOEXEC BEFORE the blocking flock (hazard 2): a child spawned by a
    // concurrent waiter must never inherit a half-armed lock.
    setCloexec(syms, fd);
    flockFd(syms, fd, FLOCK_CONSTANTS.LOCK_EX);
    locked = true;

    const raw = readAll(fd);
    let counters: Record<string, unknown>;
    try {
      counters = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (!isRecord(counters)) {
        counters = {};
      }
    } catch {
      counters = {};
    }
    const current = counters[dirName];
    const nxt =
      typeof current === "number" && Number.isInteger(current) && current > 0
        ? current + 1
        : 1;
    counters[dirName] = nxt;

    // Rewrite in place: truncate to zero, then write from the start.
    ftruncateSync(fd, 0);
    writeAt(fd, 0, `${JSON.stringify(counters, null, 2)}\n`);
    return nxt;
  } catch {
    return 1;
  } finally {
    if (locked && syms && fd !== null) {
      try {
        flockFd(syms, fd, FLOCK_CONSTANTS.LOCK_UN);
      } catch {
        // releasing on a closed/invalid fd is harmless here
      }
    }
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    if (lib) {
      lib.close();
    }
  }
}

/** Read the entire file from offset 0 as UTF-8. */
function readAll(fd: number): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  let pos = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n === 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
    pos += n;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Write `text` at byte offset `offset`. */
function writeAt(fd: number, offset: number, text: string): void {
  const data = Buffer.from(text, "utf8");
  let written = 0;
  while (written < data.length) {
    written += writeSync(
      fd,
      data,
      written,
      data.length - written,
      offset + written,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Dep-free hermes shell-hook trust seeder — the ONLY keeper surface that writes
// hermes's own config dir. The `keeper agent` launch path calls
// ensureHermesShimTrust best-effort BEFORE launching hermes, so hermes fires the
// keeper events-shim (M3b live churn) WITHOUT an interactive first-use consent
// prompt: it registers the shim in `<hermes-home>/config.yaml` `hooks:` and
// pre-approves each (event, command) pair in `<hermes-home>/shell-hooks-allowlist.json`.
//
// Dep-free by contract: node:fs/node:os/node:path only — NO bun:sqlite, NO
// src/db.ts, NO third-party deps (NO YAML parser), NO subprocess. A leaf module
// with a locking / fail-open / idempotency shape this
// mirrors.
//
// FAIL-OPEN by contract: every path is wrapped so the function NEVER throws and
// NEVER blocks the launch. On lock-timeout / unwritable config / a human's own
// pre-existing hooks it returns a status token and the caller launches regardless;
// hermes then simply skips the shim and the session degrades to presence-only
// tracking (the birth record still owns presence) — never worse than today.
//
// CONSERVATIVE, NEVER DESTRUCTIVE (the load-bearing safety property): keeper edits
// the user's real config. Without a YAML parser it CANNOT safely merge into a
// human-authored `hooks:` mapping, so it only ever manages its OWN sentinel-
// delimited block, appended as a fresh top-level `hooks:` key when the config has
// none. A pre-existing foreign top-level `hooks:` key is left UNTOUCHED (status
// "manual-hooks-present") — keeper degrades rather than risk corrupting it. The
// managed block is idempotent (re-seed only on a content/version change) and every
// write is a backup + atomic temp-rename under an O_EXCL lock.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Staleness threshold for an orphaned lock — mirrors the docs-pusher
// LOCK_STALE_MS. The only way a lock outlives its holder is a hard kill between
// acquire and release; a healthy holder holds it for a single read + write.
const LOCK_STALE_MS = 60_000;
// Bounded wait-and-retry for the lock (NOT skip-on-contention): a concurrent
// keeper launch holds it only for one read + write, so a short budget is ample.
const LOCK_WAIT_TOTAL_MS = 2_000;
const LOCK_RETRY_SLEEP_MS = 25;

/** Timeout (seconds) hermes applies to each shim subprocess. The shim is
 *  sub-second; 10s is generous headroom while still bounding a wedged shim. */
const SHIM_TIMEOUT_SECONDS = 10;

/** Outcome token — purely informational for the caller's log; the launch never
 *  gates on it. */
export type HermesTrustStatus =
  | "already-seeded"
  | "seeded"
  | "reseeded"
  | "manual-hooks-present"
  | "lock-timeout"
  | "error";

export interface EnsureHermesShimTrustOptions {
  /** The environment to read HERMES_HOME / KEEPER_HERMES_TRUST_LOG from. */
  env: Record<string, string | undefined>;
  /** The home directory `~/.hermes` falls back to. Injectable for tests. */
  home?: string;
  /** The EXACT command hermes runs for the shim — registered IDENTICALLY in the
   *  config `hooks:` block and the allowlist `approvals[]` (hermes matches the
   *  command string exactly). e.g. `"/abs/bun /abs/hermes-events-shim.ts"`. */
  shimCommand: string;
  /** The hermes lifecycle events to register the shim for (the shim's own event
   *  set). Injected so the single source of truth stays in the shim. */
  events: readonly string[];
  /** Managed-block version stamp; a bump forces a re-seed. */
  version: number;
}

/** Resolve the hermes home dir the same way hermes does: an explicit non-empty
 *  HERMES_HOME wins, else `<home>/.hermes`. */
function resolveHermesHome(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return (env.HERMES_HOME ?? "").trim() || join(home, ".hermes");
}

/** The sentinel prefix that marks keeper's managed region — version-agnostic so a
 *  stale (older-version) block is still located for replacement. */
const SENTINEL_START = "# >>> keeper-hermes-shim";
const SENTINEL_END = "# <<< keeper-hermes-shim";

/** Locate keeper's managed block (any version) for replace, or null. Matches from
 *  the start sentinel through the end sentinel line inclusive. */
const MANAGED_BLOCK_RE = new RegExp(
  `${SENTINEL_START}\\b[\\s\\S]*?${SENTINEL_END}\\b[^\\n]*\\n?`,
);

/** A foreign top-level `hooks:` key (column 0). Used ONLY when no managed block is
 *  present — its existence blocks the append (never merge-without-a-parser). */
const FOREIGN_HOOKS_RE = /^hooks:/m;

/**
 * Build the deterministic managed YAML block (both sentinels + a `hooks:` mapping
 * of each event → the shim command). Deterministic in `events` order so the
 * idempotency `includes` check is exact. The command is JSON-encoded — valid YAML
 * double-quoted-scalar escaping for the path characters that occur in practice.
 */
export function buildHermesHooksBlock(opts: {
  shimCommand: string;
  events: readonly string[];
  version: number;
}): string {
  const cmd = JSON.stringify(opts.shimCommand);
  const lines: string[] = [
    `${SENTINEL_START} v${opts.version} >>>  (managed by keeper — do not edit; keeper re-seeds this block)`,
    "hooks:",
  ];
  for (const event of opts.events) {
    lines.push(`  ${event}:`);
    lines.push(`    - command: ${cmd}`);
    lines.push(`      timeout: ${SHIM_TIMEOUT_SECONDS}`);
  }
  lines.push(`${SENTINEL_END} v${opts.version} <<<`);
  return lines.join("\n");
}

/** Best-effort append to the trust log; a logging failure is itself swallowed. */
function logTrust(env: Record<string, string | undefined>, line: string): void {
  try {
    const logPath = (env.KEEPER_HERMES_TRUST_LOG ?? "").trim();
    if (logPath === "") {
      return;
    }
    writeFileSync(logPath, `${new Date().toISOString()} ${line}\n`, {
      flag: "a",
    });
  } catch {
    // best-effort — a logging failure is never fatal.
  }
}

// --- Lock primitives -------------------------------------------------------------

function stampLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function isLockStale(lockPath: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS) {
    return true;
  }
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function tryAcquireLock(lockPath: string): boolean {
  if (stampLock(lockPath)) {
    return true;
  }
  if (!isLockStale(lockPath)) {
    return false;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    return false;
  }
  return stampLock(lockPath);
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort.
  }
}

function sleepMs(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin — the lock is held for a single read + write, so contention is tiny.
  }
}

/** Write `content` to `path` durably: snapshot a one-level `.keeper-bak` backup of
 *  any prior file, then atomic temp-write + rename (a crash mid-write never leaves
 *  a torn config). */
function atomicWriteWithBackup(path: string, content: string): void {
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.keeper-bak`);
    } catch {
      // A missing backup is non-fatal — the atomic rename below is the real guard.
    }
  }
  const tmp = `${path}.keeper.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Register the managed block in config.yaml. Returns the config-side status. Never
 * merges into a foreign `hooks:` key (returns "manual-hooks-present" instead).
 */
function seedConfig(
  configPath: string,
  block: string,
): Exclude<HermesTrustStatus, "lock-timeout" | "error"> {
  const existing = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";

  // Idempotent: the exact block (same version + events + command) is already there.
  if (existing.includes(block)) {
    return "already-seeded";
  }

  // A stale managed block (different version / events / command) → replace in place.
  if (MANAGED_BLOCK_RE.test(existing)) {
    const next = existing.replace(MANAGED_BLOCK_RE, `${block}\n`);
    atomicWriteWithBackup(configPath, next);
    return "reseeded";
  }

  // No managed block. A foreign top-level `hooks:` key means a human authored
  // hooks we cannot safely merge into without a parser — defer, never touch it.
  if (FOREIGN_HOOKS_RE.test(existing)) {
    return "manual-hooks-present";
  }

  // Fresh append as a new top-level block. Guarantee a separating newline.
  const base =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  atomicWriteWithBackup(configPath, `${base}\n${block}\n`);
  return "seeded";
}

/**
 * Pre-approve each (event, shimCommand) pair in the allowlist, preserving any
 * pre-existing approvals. Tolerant of an absent / corrupt file (treated as an
 * empty skeleton, mirroring hermes's own loader). Best-effort — a failure here
 * does not change the config-side status (the HERMES_ACCEPT_HOOKS env belt still
 * covers a keeper-launched session).
 */
function seedAllowlist(
  allowlistPath: string,
  shimCommand: string,
  events: readonly string[],
): void {
  let approvals: Array<{ event: string; command: string }> = [];
  if (existsSync(allowlistPath)) {
    try {
      const parsed = JSON.parse(readFileSync(allowlistPath, "utf8")) as unknown;
      const raw =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { approvals?: unknown }).approvals
          : undefined;
      if (Array.isArray(raw)) {
        approvals = raw.filter(
          (e): e is { event: string; command: string } =>
            e !== null &&
            typeof e === "object" &&
            typeof (e as { event?: unknown }).event === "string" &&
            typeof (e as { command?: unknown }).command === "string",
        );
      }
    } catch {
      // Corrupt file → treat as empty skeleton (mirrors hermes's load_allowlist).
      approvals = [];
    }
  }

  const has = (event: string): boolean =>
    approvals.some((e) => e.event === event && e.command === shimCommand);
  let changed = false;
  for (const event of events) {
    if (!has(event)) {
      approvals.push({ event, command: shimCommand });
      changed = true;
    }
  }
  if (changed) {
    atomicWriteWithBackup(
      allowlistPath,
      `${JSON.stringify({ approvals }, null, 2)}\n`,
    );
  }
}

/**
 * Seed hermes shell-hook trust for the keeper events-shim so a keeper-launched
 * hermes session fires it without an interactive consent prompt. Idempotent,
 * concurrency-safe, fail-open — see the module doc. Returns a status token (never
 * throws). The caller launches regardless of the outcome.
 */
export function ensureHermesShimTrust(
  opts: EnsureHermesShimTrustOptions,
): HermesTrustStatus {
  const home = opts.home ?? homedir();
  try {
    const hermesHome = resolveHermesHome(opts.env, home);
    const configPath = join(hermesHome, "config.yaml");
    const allowlistPath = join(hermesHome, "shell-hooks-allowlist.json");
    const lockPath = join(hermesHome, ".keeper-hermes-shim.lock");
    const block = buildHermesHooksBlock({
      shimCommand: opts.shimCommand,
      events: opts.events,
      version: opts.version,
    });

    // Ensure the home dir exists BEFORE the lock loop (the lock lives beside the
    // config). A failure here (e.g. HERMES_HOME is a file) throws to the outer
    // catch and fails open immediately rather than spinning the lock budget.
    mkdirSync(hermesHome, { recursive: true });

    const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
    let acquired = false;
    while (Date.now() < deadline) {
      if (tryAcquireLock(lockPath)) {
        acquired = true;
        break;
      }
      sleepMs(LOCK_RETRY_SLEEP_MS);
    }
    if (!acquired) {
      logTrust(opts.env, `lock-timeout home=${hermesHome} lock=${lockPath}`);
      return "lock-timeout";
    }

    try {
      const status = seedConfig(configPath, block);
      // Only pre-approve the allowlist when we actually registered the hook — a
      // deferred (manual-hooks-present) config means the command is never in the
      // config, so an allowlist entry for it would be inert clutter in the human's
      // file.
      if (status !== "manual-hooks-present") {
        seedAllowlist(allowlistPath, opts.shimCommand, opts.events);
      }
      logTrust(opts.env, `${status} home=${hermesHome}`);
      return status;
    } finally {
      releaseLock(lockPath);
    }
  } catch (err) {
    logTrust(
      opts.env,
      `error home=${home}: ${(err as Error).message ?? String(err)}`,
    );
    return "error";
  }
}

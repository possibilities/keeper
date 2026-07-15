#!/usr/bin/env bun
/**
 * Keeper events writer hook. Invoked by Claude Code once per hook event with
 * the payload on stdin. Appends a single per-pid NDJSON line under the keeper
 * events-log dir and exits; the daemon-side ingester tails those files and
 * lands each line as a real `events` row.
 *
 * Hard guarantees:
 * - **Always exit 0** — even on parse failure, append failure, or any thrown
 *   exception: a hook MUST NOT block Claude. Losing one event row is
 *   acceptable; wedging the agent is not. Errors log to stderr.
 * - **Minimal import graph** — only `node:fs`/`node:os`/`node:path`, the local
 *   dep-free `src/dead-letter.ts` serializers, and the pure `src/derivers.ts` /
 *   `src/exec-backend.ts` / `src/proc-starttime.ts` helpers. NO `bun:sqlite`,
 *   NO `src/db.ts`: every import is borrowed from the cold-start budget
 *   against the SessionEnd hook's 1.5s timeout cap, and `src/db.ts` is the
 *   single biggest line item.
 * - **`pid = process.ppid`** pairs with `start_time` (SessionStart only) as a
 *   recycle-safe `(pid, start_time)` identity: the bare pid is unsafe on macOS
 *   where pid space is small, so the seed sweep and exit-watcher probe BOTH
 *   fields before folding a row to `killed`. `start_time` is a platform-tagged
 *   opaque string (`darwin:<lstart-text>` / `linux:<jiffies>`) — never
 *   interpreted cross-platform; the matcher does string equality.
 */

import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  DeadLetterBindings,
  DeadLetterRecord,
  EventLogRecord,
} from "../../../../src/dead-letter";
import {
  serializeDeadLetterRecord,
  serializeEventLogRecord,
} from "../../../../src/dead-letter";
import {
  extractBackgroundTaskId,
  extractBashMutation,
  extractMutationPath,
  extractPlanInvocation,
  extractSkillName,
  extractToolUseId,
  slashCommandFromPrompt,
} from "../../../../src/derivers";
import {
  execBackendEnvMeta,
  isDefaultTmuxEnvValue,
} from "../../../../src/exec-backend";
import {
  parseLinuxStarttime,
  splitArgsLstart,
} from "../../../../src/proc-starttime";

export { parseLinuxStarttime, splitArgsLstart };

/**
 * Hook event names that get renamed when stored as `event_type`. Everything
 * else falls through to snake_case (`PreToolUse` → `pre_tool_use`, etc).
 */
const TYPE_MAP: Record<string, string> = {
  SessionStart: "session_start",
  PostToolUse: "tool_use",
  Stop: "stop",
};

/**
 * Convert PascalCase / camelCase to snake_case. Insert an underscore between
 * any lowercase/digit and following uppercase, then lowercase the whole thing.
 */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Read all of stdin as a UTF-8 string. Bun's `Bun.stdin` is a readable stream;
 * the hook payload is small (kilobytes), so we await the whole body before
 * parsing. A truncated/empty payload throws on `JSON.parse` and is caught by
 * the outer try-catch.
 */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Filesystem seam for stable producer-side mutation-path canonicalization. */
export interface CanonicalMutationPathFs {
  lstat: typeof lstatSync;
  stat: typeof statSync;
  realpath: typeof realpathSync;
}

function sameFsIdentity(
  left: { dev: number | bigint; ino: number | bigint; mode: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; mode: number | bigint },
): boolean {
  return (
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino) &&
    (BigInt(left.mode) & 0o170000n) === (BigInt(right.mode) & 0o170000n)
  );
}

/** Canonical producer identity for exact mutation paths (folds stay I/O-free). */
export function canonicalMutationPathForEvent(
  path: string | null,
  cwd: string | null,
  fs: CanonicalMutationPathFs = {
    lstat: lstatSync,
    stat: statSync,
    realpath: realpathSync,
  },
): string | null {
  if (path === null || path.includes("\0")) return null;
  const absolute = isAbsolute(path)
    ? path
    : resolve(cwd ?? process.cwd(), path);
  try {
    const before = fs.lstat(absolute);
    if (!before.isSymbolicLink()) {
      const followedBefore = fs.stat(absolute);
      const canonical = fs.realpath(absolute);
      const canonicalIdentity = fs.stat(canonical);
      const after = fs.lstat(absolute);
      const followedAfter = fs.stat(absolute);
      if (
        !after.isSymbolicLink() &&
        sameFsIdentity(before, after) &&
        sameFsIdentity(followedBefore, followedAfter) &&
        sameFsIdentity(followedBefore, canonicalIdentity) &&
        fs.realpath(absolute) === canonical
      ) {
        return canonical;
      }
      // A leaf swap makes the followed target untrustworthy. Preserve the Git
      // leaf identity through the stable-parent path below instead.
    }
  } catch {
    // New/deleted/swapped leaf: canonicalize the nearest existing parent below.
  }
  let parent = dirname(absolute);
  const suffix: string[] = [basename(absolute)];
  for (;;) {
    try {
      const before = fs.lstat(parent);
      const followedBefore = fs.stat(parent);
      const canonical = fs.realpath(parent);
      const canonicalIdentity = fs.stat(canonical);
      const after = fs.lstat(parent);
      const followedAfter = fs.stat(parent);
      if (
        sameFsIdentity(before, after) &&
        sameFsIdentity(followedBefore, followedAfter) &&
        sameFsIdentity(followedBefore, canonicalIdentity) &&
        fs.realpath(parent) === canonical
      ) {
        return join(canonical, ...suffix.reverse());
      }
    } catch {
      // Keep walking to a stable existing ancestor.
    }
    const next = dirname(parent);
    // No stable ancestor means there is no trustworthy filesystem identity to
    // persist. Returning the unchecked lexical absolute here would turn an I/O
    // failure into positive ownership evidence.
    if (next === parent) return null;
    suffix.push(basename(parent));
    parent = next;
  }
}

/**
 * Pull a string field from the payload, or null. Defensive against
 * non-string values (Claude Code occasionally puts objects in fields that
 * are documented as strings — never blow up).
 */
function strField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" ? v : null;
}

/**
 * PostToolUse:Agent rows carry the spawned subagent's canonical id at
 * `data.tool_response.agentId`. Persist it so the reducer can join Pre/Post-
 * Agent (tool_use_id-keyed) to SubagentStart/Stop (agent_id-keyed) without
 * heuristics. NULL on all other rows. camelCase on the wire — `agentId`.
 */
function extractSubagentAgentId(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): string | null {
  if (hookEvent !== "PostToolUse" || toolName !== "Agent") {
    return null;
  }
  const toolResponse = data.tool_response;
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return null;
  }
  const candidate = (toolResponse as Record<string, unknown>).agentId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

/**
 * Parse the session spawn name out of a parent-process command line — the
 * single whitespace-delimited token following `--name=`, `--name `, or `-n `.
 * Pure + exported so it is unit-testable independent of the `ps` probe.
 *
 * The flag must sit on a flag boundary (`(?:^|\s)`) so `--rename foo` /
 * `--username foo` can't false-match. SINGLE-TOKEN by design: macOS
 * `ps -o args=` space-joins argv and drops shell quoting, so a multi-word
 * `--name "a b"` is indistinguishable from `--name a` plus a trailing arg —
 * capturing only the first token is the only unambiguous read. Returns null
 * when no flag is present or the captured token is empty.
 */
export function nameFromArgs(args: string): string | null {
  const m = args.match(/(?:^|\s)(?:--name[= ]|-n )(\S+)/);
  const token = m?.[1];
  return token && token.length > 0 ? token : null;
}

/**
 * Normalize the `CLAUDE_CONFIG_DIR` env value as observed by the hook at
 * `SessionStart`. Pure + exported so the normalization is unit-testable
 * without spawning a real hook process.
 *
 * Rules (locked):
 * - `undefined` / `""` → `null` (collapse the two "absent" shapes to one);
 * - strip exactly one trailing `/` so `/path/foo/` and `/path/foo` project
 *   to the same string (Claude Code's launcher and dotfiles disagree on the
 *   trailing slash; the projection is the canonical form).
 *
 * Everything else passes through verbatim — we don't resolve symlinks,
 * don't expand `~`, don't enforce absoluteness. The column is display /
 * attribution only; it never drives a filesystem read.
 */
export function configDirFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env.CLAUDE_CONFIG_DIR;
  if (raw === undefined || raw === "") {
    return null;
  }
  return raw.endsWith("/") && raw.length > 1 ? raw.slice(0, -1) : raw;
}

/**
 * Capture the worktree-lane BRANCH from `KEEPER_PLAN_WORKTREE_BRANCH` — the
 * durable per-job lane marker the producer injects (`keeper/epic/<id>[--<task>]`).
 * SessionStart-gated by the caller, exactly like {@link configDirFromEnv}.
 *
 * Rules (locked):
 * - `undefined` / empty / whitespace-only → `null` (the always-emitted `-e`
 *   carries an EMPTY value on serial / OFF launches, which must collapse to the
 *   same absent shape COALESCE treats uniformly — never an empty-bracket pill);
 * - NO trailing-slash normalization — the value is a canonical git ref, recorded
 *   verbatim so the fold reads back exactly what launch context froze (the
 *   re-fold determinism guarantee).
 *
 * Stays pure (`process.env` read only) — no git, no fs, no `bun:sqlite`.
 */
export function worktreeBranchFromEnv(env: NodeJS.ProcessEnv): string | null {
  return (env.KEEPER_PLAN_WORKTREE_BRANCH ?? "").trim() || null;
}

/**
 * Capture the PII-free account ROUTE from `KEEPER_ACCOUNT_ROUTE` — the launch
 * carrier the Claude account router injects on every unpinned start / resume /
 * restore (`default` for the native ambient account, `claude-swap:<slot>` for a
 * managed route). SessionStart-gated by the caller, exactly like
 * {@link configDirFromEnv} / {@link worktreeBranchFromEnv}.
 *
 * The value is environment- and hook-sourced, so it is UNTRUSTED: it is size-
 * and shape-bounded HERE, at capture, never in the fold (the fold copies it
 * verbatim). Only the two known PII-free shapes survive —
 * - `default` (the native route id), or
 * - `claude-swap:<digits>` (a claude-swap slot number, which carries no PII).
 * Anything else — unset/empty, over-long, or an unrecognized shape — collapses
 * to `null`, so a malformed or hostile env can never persist an unbounded or
 * identity-bearing string, and a launcher that supplied no route folds NULL.
 * Recording only the bounded route id keeps attribution observational and
 * PII-free, and never claims a durable human identity (a slot is time-local and
 * reusable). The literals mirror `src/account-routing-config.ts`
 * (NATIVE_ROUTE_ID / managedRouteId), inlined because a hook may not import the
 * routing config (dependency-free island).
 *
 * Stays pure (`process.env` read only) — no git, no fs, no `bun:sqlite`.
 */
export function accountRouteFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env.KEEPER_ACCOUNT_ROUTE;
  if (raw == null || raw.length === 0 || raw.length > 64) {
    return null;
  }
  if (raw === "default") {
    return raw;
  }
  return /^claude-swap:\d{1,10}$/.test(raw) ? raw : null;
}

/** Parse the bounded exact-attempt carrier injected by the generic dispatcher.
 * Kept local because this hook's dependency-free island cannot import launch
 * configuration. Malformed or missing metadata is unfenced evidence. */
export function dispatchAttemptFromEnv(env: NodeJS.ProcessEnv): number | null {
  const raw = env.KEEPER_DISPATCH_ATTEMPT_ID;
  if (raw === undefined || !/^[1-9]\d{0,15}$/.test(raw)) {
    return null;
  }
  const attemptId = Number(raw);
  return Number.isSafeInteger(attemptId) ? attemptId : null;
}

/**
 * Three-tuple of backend-exec coordinates captured on EVERY hook event
 * (not SessionStart-gated like {@link configDirFromEnv}). Each field is
 * an independent `string | null` so the reducer's COALESCE
 * latest-non-NULL-wins fold can layer them onto `jobs` cleanly: a hook
 * event firing inside a tmux pane but with one sub-var absent stamps
 * that one as NULL and never clobbers a prior captured value.
 */
export interface BackendExecCoords {
  readonly type: string | null;
  readonly sessionId: string | null;
  readonly paneId: string | null;
}

/**
 * Capture the terminal-multiplexer ("backend-exec") coordinates from `env`.
 * Called on EVERY hook event — a synchronous `process.env` read (no
 * fork/fs/PPID-walk), cheap enough for the cold-start budget on every fire.
 *
 * Sentinel gating:
 *  - tmux stamps `TMUX` + `TMUX_PANE` into every pane. Type and pane id stamp
 *    only for the default tmux socket keeper observes; foreign `tmux -L <name>`
 *    sockets are ignored because pane ids are server-local. The session name
 *    stamps ONLY when `KEEPER_TMUX_SESSION` is present (keeper-managed launches
 *    inject it via `-e`). A human-created tmux session carries no
 *    `KEEPER_TMUX_SESSION`, so the session stays NULL and the snapshot poller
 *    fills it later.
 *  - native `TMUX` absent but the carrier `KEEPER_TMUX_PANE` present → the
 *    fallback arm stamps coord-identical tmux rows from the carrier. keeper agent
 *    strips `TMUX`/`TMUX_PANE` (so Claude emits truecolor) after copying the
 *    pane id into the carrier; this arm keeps window renaming alive across the
 *    strip. The carrier is a hint, not proof of a live pane: an empty/absent
 *    carrier collapses to all-NULL (never a `type=tmux` row with a NULL pane).
 *  - no sentinel and no carrier → all-NULL; never stamp a bogus `type` for a
 *    session launched outside the multiplexer.
 *
 * Each sub-var collapses absent/empty to NULL independently so the reducer's
 * COALESCE arm cannot be clobbered by a partial capture. The env-var NAMES are
 * funneled through `execBackendEnvMeta(backendType)` so the hook learns no keys.
 *
 * Re-fold determinism: the captured values are frozen onto the events row at
 * hook time, so the fold NEVER re-reads env.
 */
export function backendExecCoordsFromEnv(
  env: NodeJS.ProcessEnv,
): BackendExecCoords {
  // tmux sentinel: `TMUX` is set in every tmux pane. Stamp type + pane id only
  // for the default socket; the session name stamps only when
  // `KEEPER_TMUX_SESSION` is present (managed launches inject it) — human
  // sessions stay NULL until the poller fills them.
  const tmuxSentinel = env.TMUX;
  if (tmuxSentinel !== undefined && tmuxSentinel !== "") {
    if (!isDefaultTmuxEnvValue(tmuxSentinel)) {
      return { type: null, sessionId: null, paneId: null };
    }
    const meta = execBackendEnvMeta("tmux");
    const rawSession = env[meta.sessionIdEnvVar];
    const rawPane = env[meta.paneIdEnvVar];
    return {
      type: meta.backendType,
      sessionId:
        rawSession === undefined || rawSession === "" ? null : rawSession,
      paneId: rawPane === undefined || rawPane === "" ? null : rawPane,
    };
  }
  // Fallback arm: native `TMUX` is absent (keeper agent strips it so Claude emits
  // truecolor), but the keeper-owned carrier `KEEPER_TMUX_PANE` rides through
  // and holds the pane id. Stamp coord-identical tmux rows from it so window
  // renaming survives the strip. Same empty→NULL collapse the native arm uses,
  // applied independently per sub-var. The carrier is a hint, not proof of a
  // live pane: if it collapses to NULL, fall through to all-NULL — never a
  // `type=tmux` row with a NULL pane (the renamer filter requires a non-null
  // pane id). Pure synchronous read — no fs/fork (hook cold-start budget).
  const meta = execBackendEnvMeta("tmux");
  const rawCarrier = env[meta.paneIdCarrierEnvVar];
  const carrierPane =
    rawCarrier === undefined || rawCarrier === "" ? null : rawCarrier;
  if (carrierPane !== null) {
    const rawSession = env[meta.sessionIdEnvVar];
    return {
      type: meta.backendType,
      sessionId:
        rawSession === undefined || rawSession === "" ? null : rawSession,
      paneId: carrierPane,
    };
  }
  // Not under tmux, no carrier — `type` would be a lie; every coord stays NULL.
  return { type: null, sessionId: null, paneId: null };
}

/**
 * Captured parent-process identity for a SessionStart event: the `--name`
 * token (when the launcher set one) and a platform-tagged `start_time` string
 * (`darwin:<lstart-text>` / `linux:<jiffies>`). Either field may be null
 * independently — name absent means the parent didn't carry `--name`, while
 * start_time absent means the platform probe failed (unknown OS, ps error,
 * /proc unreadable). The hook MUST stay exit-0, so every failure path lands
 * here as `null` rather than throwing.
 */
export type SpawnInfo = { name: string | null; startTime: string | null };

/**
 * Scrape the spawn name AND start_time from the parent process via a single
 * platform-specific probe. SessionStart only — a `ps` fork on every hook would
 * blow the cold-start/SessionEnd-timeout budget. Single-level `process.ppid`
 * is correct: the launcher injects `--name <session>` into the immediate
 * parent claude argv.
 *
 * Darwin: ONE `ps -o lstart=,args=` fork captures both fields. Linux: read
 * `/proc/$PPID/stat` field 22 (no fork). Unknown platforms return both null.
 *
 * The ENTIRE body is wrapped in try/catch returning `{null, null}` because
 * `Bun.spawnSync` THROWS (ENOENT) when `ps` is missing — a bare `success`
 * check is insufficient. The explicit 500ms timeout means a wedged `ps` can
 * never threaten the exit-0 contract. Only the parsed name + opaque
 * start_time are returned — the raw `args=` blob (which can carry secrets like
 * `--token=...`) is discarded.
 */
async function scrapeSpawnInfo(): Promise<SpawnInfo> {
  try {
    if (process.platform === "darwin") {
      // `lstart=,args=` — args MUST come last so macOS ps doesn't truncate it
      // mid-string (see `splitArgsLstart` for the column-order rationale).
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(process.ppid), "-o", "lstart=,args="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) {
        return { name: null, startTime: null };
      }
      const out = result.stdout?.toString() ?? "";
      const split = splitArgsLstart(out);
      if (!split) {
        return { name: null, startTime: null };
      }
      return {
        name: nameFromArgs(split.args),
        startTime: `darwin:${split.lstart}`,
      };
    }
    if (process.platform === "linux") {
      // Two reads (stat for start_time, cmdline for argv) — both /proc reads
      // are filesystem-cheap (no fork). `Bun.file().text()` rejects on
      // missing/unreadable files; the outer try/catch lands those as null.
      const statText = await Bun.file(`/proc/${process.ppid}/stat`).text();
      const startTime = parseLinuxStarttime(statText);
      // /proc/<pid>/cmdline is NUL-separated argv — join on space to feed the
      // existing `nameFromArgs` matcher.
      let name: string | null = null;
      try {
        const cmdlineRaw = await Bun.file(
          `/proc/${process.ppid}/cmdline`,
        ).text();
        const argv = cmdlineRaw.split("\0").filter((s) => s.length > 0);
        name = nameFromArgs(argv.join(" "));
      } catch {
        // cmdline unreadable but stat succeeded — keep the start_time we have
      }
      return {
        name,
        startTime: startTime !== null ? `linux:${startTime}` : null,
      };
    }
    return { name: null, startTime: null };
  } catch {
    return { name: null, startTime: null };
  }
}

/** Authority-producing hook records always land in the fixed OS-user store.
 * Caller-controlled environment overrides are daemon/test configuration, not a
 * capability to divert a live session's mutation evidence. */
function resolveDeadLetterDir(): string {
  return join(userInfo().homedir, ".local", "state", "keeper", "dead-letters");
}

/** Fixed OS-user events-log tree. This isolated hook cannot import `src/db.ts`;
 * keep the default byte-identical to `defaultEventsLogDir()` there. */
function resolveEventsLogDir(): string {
  return join(userInfo().homedir, ".local", "state", "keeper", "events-log");
}

/**
 * Best-effort append-one-line write of a dead-letter record to the per-pid
 * NDJSON file. The hook MUST never throw past this helper — every failure mode
 * is swallowed to stderr so the exit-0 contract holds. The chmod is
 * best-effort 0o600 because the serialized bindings can carry prompt text and
 * file paths the user reasonably considers private.
 *
 * The per-pid filename (`<pid>.ndjson`) keeps concurrent same-process hook
 * writes from interleaving: different pids never share a file, so a >PIPE_BUF
 * (512 B on macOS) line can't tear across two hooks' appends.
 */
function writeDeadLetter(record: DeadLetterRecord): void {
  try {
    const dir = resolveDeadLetterDir();
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Directory may already exist with different mode; recursive mkdir is
      // idempotent on absence, so a failure here is informational only.
    }
    const file = join(dir, `${process.pid}.ndjson`);
    appendFileSync(file, serializeDeadLetterRecord(record));
    try {
      chmodSync(file, 0o600);
    } catch {
      // chmod best-effort — the file may have been written by a prior hook
      // whose process can't chmod it now; the data is still on disk.
    }
  } catch (err) {
    process.stderr.write(`keeper events-writer: dead-letter failed: ${err}\n`);
  }
}

/**
 * Append-one-line write of an events-log record to the per-pid NDJSON file.
 * Returns `true` on a durable append, `false` on hard failure (the caller then
 * dead-letters so the event is not silently lost).
 *
 * A single `appendFileSync` (one `write(2)`) per complete `\n`-terminated
 * line, best-effort 0o600 chmod, NO fsync — SQLite WAL is the durability
 * boundary and the ingester re-reads from a durable byte-offset, so a
 * lost-buffer crash is lag-not-loss. The per-pid filename (`<pid>.ndjson`) is
 * the interleave guard: events-log lines CAN exceed the ~256 B APFS O_APPEND
 * non-interleave window (a Stop event's `data` blob is large), and exactly one
 * writer per file makes that safe.
 *
 * Failure handling: a first `appendFileSync` ENOENT is almost always a mkdir
 * race — re-mkdir once and retry the single append. Any OTHER errno
 * (EACCES/ENOSPC/EROFS/…) or a still-failing ENOENT retry returns `false`; the
 * caller routes the event to the dead-letter recovery path. The hook never
 * throws past this helper — the exit-0 contract holds regardless.
 */
function writeEventLog(record: EventLogRecord): boolean {
  const dir = resolveEventsLogDir();
  const file = join(dir, `${process.pid}.ndjson`);
  const line = serializeEventLogRecord(record);
  const ensureDir = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Recursive mkdir is idempotent on absence; an existing dir with a
      // different mode throws harmlessly here. The append below is the real
      // success signal.
    }
  };
  try {
    ensureDir();
    appendFileSync(file, line);
  } catch (err) {
    // ENOENT after our mkdir is a dir-reaped-mid-write race — re-create the
    // dir and retry the single append exactly once. Every other errno
    // (EACCES / ENOSPC / EROFS / …) is a hard failure: fall through to the
    // dead-letter path below.
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") {
      try {
        ensureDir();
        appendFileSync(file, line);
      } catch (retryErr) {
        process.stderr.write(
          `keeper events-writer: events-log append failed (ENOENT retry): ${retryErr}\n`,
        );
        return false;
      }
    } else {
      process.stderr.write(
        `keeper events-writer: events-log append failed: ${err}\n`,
      );
      return false;
    }
  }
  // chmod best-effort 0o600 — the serialized bindings can carry prompt text and
  // file paths the user reasonably considers private. A failure here does NOT
  // un-write the line, so it does not flip the success return.
  try {
    chmodSync(file, 0o600);
  } catch {
    // The file may have been created by a prior hook whose process can't chmod
    // it now; the data is still on disk and ingestible.
  }
  return true;
}

/**
 * The full set of `events`-column names the hook knows how to populate.
 * MUST stay in lockstep with the canonical `CREATE TABLE events` literal in
 * `src/db.ts` and with the `insertBindings` map below — every key here is the
 * bare column name (no `$` prefix); every value in `insertBindings` is
 * prefixed `$col`.
 *
 * The daemon-side ingester (`scanEventsLogDir`) intersects the NDJSON record's
 * bindings with the live DB's `events` columns (post-migrate, race-free) and
 * binds only the survivors. A column the live DB lacks — the daemon hasn't
 * applied a fresh `ALTER TABLE` yet — is omitted from the INSERT and lands
 * NULL after migration, identical to the deriver's zero-event value: the
 * schema-bump-deploy-skew window degrades losslessly rather than dropping the
 * whole feed.
 *
 * Adding a new column means TWO local edits: this Set + the corresponding
 * `insertBindings` entry below.
 */
export const KNOWN_EVENT_COLUMNS: ReadonlySet<string> = new Set([
  "ts",
  "session_id",
  "pid",
  "hook_event",
  "event_type",
  "tool_name",
  "matcher",
  "cwd",
  "permission_mode",
  "agent_id",
  "agent_type",
  "stop_hook_active",
  "data",
  "subagent_agent_id",
  "spawn_name",
  "start_time",
  "slash_command",
  "skill_name",
  "plan_op",
  "plan_target",
  "plan_epic_id",
  "plan_task_id",
  "plan_subject_present",
  "tool_use_id",
  "config_dir",
  "bash_mutation_kind",
  "bash_mutation_targets",
  "plan_files",
  "backend_exec_type",
  "backend_exec_session_id",
  "backend_exec_pane_id",
  "background_task_id",
  "mutation_path",
  "worktree",
  "harness",
  "resume_target",
  "adopted",
  "account_route",
]);

/**
 * Diagnostic drop-log path. One NDJSON line per dead-lettered INSERT —
 * SEPARATE from the dead-letter recovery records (those drive replay; this is
 * pure instrumentation to attribute drop bursts: error code, attempts, wait).
 * Append-only, never consumed. `KEEPER_DROP_LOG` overrides for tests.
 */
function dropLogPath(): string {
  const env = process.env.KEEPER_DROP_LOG;
  if (env != null && env.length > 0) return env;
  return join(
    userInfo().homedir,
    ".local",
    "state",
    "keeper",
    "hook-drops.ndjson",
  );
}

/**
 * Best-effort append of one diagnostic line to the drop-log. Mirrors
 * {@link writeDeadLetter}'s swallow-everything contract: instrumentation must
 * NEVER affect the hook's exit-0 outcome. A single small (<512 B) append is
 * atomic per `write(2)`, so concurrent same/cross-pid hooks don't tear lines.
 */
function writeDropLog(line: string): void {
  try {
    appendFileSync(dropLogPath(), line, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`keeper events-writer: drop-log failed: ${err}\n`);
  }
}

/**
 * Build the full bare-column `events` binding map from a parsed hook payload —
 * the pure record builder the hook appends as one NDJSON line. Returns null for
 * a keepalive-shaped payload with an empty `hook_event_name` (no row written).
 *
 * Every non-pure input is INJECTED so this is unit-testable with zero fork / fs:
 *  - `raw` is the verbatim stdin string (stored as the `data` column);
 *  - `pid` is `process.ppid` (the recycle-safe identity's pid half);
 *  - `env` feeds `configDirFromEnv` + `backendExecCoordsFromEnv` (pure reads);
 *  - `spawnInfo` is the already-scraped parent identity — `main` forks `ps`
 *    ONLY on SessionStart, and this builder re-applies the SessionStart gate
 *    purely so a non-SessionStart payload can never carry spawn fields;
 *  - `ts` is the event timestamp (seconds).
 *
 * The returned key set MUST equal {@link KNOWN_EVENT_COLUMNS} (the LOCKSTEP
 * test pins all three of: this map, that Set, and the live `events` columns).
 */
export function buildEventBindings(
  data: Record<string, unknown>,
  raw: string,
  pid: number,
  env: NodeJS.ProcessEnv,
  spawnInfo: SpawnInfo,
  ts: number,
): DeadLetterBindings | null {
  const hookEvent = strField(data, "hook_event_name") ?? "";
  if (!hookEvent) {
    // Empty hook_event_name matches the python reference's silent skip
    // behavior — Claude Code occasionally sends keepalive-shaped payloads
    // that aren't real events. Don't write a row for them.
    return null;
  }

  // Notification events carry the notification subtype in `notification_type`;
  // surface it as the event_type so consumers can filter without parsing the
  // raw `data` JSON. Other named events use the TYPE_MAP rename; everything
  // else snake_cases the hook name.
  let eventType: string;
  if (hookEvent === "Notification") {
    eventType = strField(data, "notification_type") ?? "";
  } else if (TYPE_MAP[hookEvent]) {
    // biome-ignore lint/style/noNonNullAssertion: presence checked above
    eventType = TYPE_MAP[hookEvent]!;
  } else {
    eventType = snakeCase(hookEvent);
  }

  const sessionId = strField(data, "session_id") ?? "unknown";
  const toolName = strField(data, "tool_name");
  const matcher = strField(data, "matcher");
  const cwd = strField(data, "cwd");
  const permissionMode = strField(data, "permission_mode");
  const agentId = strField(data, "agent_id");
  const agentType = strField(data, "agent_type");

  // stop_hook_active is only meaningful on the Stop event; null elsewhere so
  // the column doesn't masquerade as a bool on unrelated rows.
  const stopHookActive =
    hookEvent === "Stop" ? (data.stop_hook_active ? 1 : 0) : null;

  const subagentAgentId = extractSubagentAgentId(hookEvent, toolName, data);

  // Index the slash-command on UserPromptSubmit and the Skill-tool name on
  // Pre/PostToolUse-on-Skill. Both derivers are pure, gated, and return null on
  // anything that doesn't match the canonical shape.
  const slashCommand =
    hookEvent === "UserPromptSubmit"
      ? slashCommandFromPrompt(data.prompt)
      : null;
  const skillName = extractSkillName(hookEvent, toolName, data);

  // Index the plan-CLI invocation footprint on PostToolUse:Bash by parsing
  // the `plan_invocation` envelope the plan CLI writes on every mutating call's
  // stdout. The deriver is pure, gated on hook event + tool name, and
  // defensive against any malformed `data.tool_response` shape — a null return
  // collapses to all the params bound NULL.
  const planInvocation = extractPlanInvocation(hookEvent, toolName, data);
  const planOp = planInvocation?.op ?? null;
  const planTarget = planInvocation?.target ?? null;
  const planEpicId = planInvocation?.epic_id ?? null;
  const planTaskId = planInvocation?.task_id ?? null;
  // `subject_present` is 0/1 on disk to match the INTEGER column; NULL when
  // the event is not a plan invocation at all.
  const planSubjectPresent =
    planInvocation === null ? null : planInvocation.subject_present ? 1 : 0;
  // The envelope's repo-relative `files[]` array, JSON-encoded for the SQLite
  // TEXT column. NULL when the deriver couldn't lift a non-empty string array
  // (non-plan events, read-only ops, or runaway-size payloads). Sparse
  // JSON-or-NULL so a `WHERE plan_files IS NOT NULL` partial index stays
  // selective.
  const planFiles =
    planInvocation?.files == null ? null : JSON.stringify(planInvocation.files);

  // Index the Anthropic tool_use_id correlator on every event payload carrying
  // it. NOT gated on hook event or tool name — Pre/PostToolUse +
  // PostToolUseFailure on every tool carry `data.tool_use_id`. A
  // `WHERE tool_use_id IS NOT NULL` partial index keeps it small. Bridges the
  // SubagentStart/Stop folds to their matching PreToolUse:Agent payload.
  const toolUseId = extractToolUseId(data);

  // Index the bash mutation footprint on PostToolUse:Bash by tokenizing
  // `tool_input.command` against a hardcoded pattern table (package managers,
  // fs verbs, git tree-mutators). The deriver is pure, gated on hook event +
  // tool name, and defensive against a malformed `tool_input` shape — a null
  // return collapses to both params bound NULL. Deriver purity is the re-fold-
  // determinism contract: a future bugfix would need a schema-bump-with-rewind
  // to re-backfill stored rows.
  const bashMutation = extractBashMutation(hookEvent, toolName, data, cwd);
  const bashMutationKind = bashMutation?.kind ?? null;
  // Serialize the targets array as JSON. NULL when no mutation matched, so
  // the partial index (`WHERE bash_mutation_kind IS NOT NULL`) stays
  // selective and the column shape stays the standard sparse-text pattern.
  const bashMutationTargets =
    bashMutation === null ? null : JSON.stringify(bashMutation.targets);

  // SessionStart only: the parent claude argv `--name`/`-n` token AND the
  // process start_time, so the reducer can seed `jobs.title` from the first
  // event AND store the recycle-safe `(pid, start_time)` identity. `main` does
  // the actual `ps` probe (the one non-pure step, SessionStart-gated for the
  // cold-start budget); this builder re-applies the gate so a non-SessionStart
  // payload can never carry an injected spawn field.
  const spawnName = hookEvent === "SessionStart" ? spawnInfo.name : null;
  const startTime = hookEvent === "SessionStart" ? spawnInfo.startTime : null;

  // SessionStart only: capture `CLAUDE_CONFIG_DIR` from the injected env (the
  // parent claude env propagates into the hook subprocess). Every other hook
  // event sends NULL, so `events.config_dir` is set-once per SessionStart and
  // the reducer's `COALESCE(excluded, jobs)` handles latest-non-NULL-wins for
  // resume. `configDirFromEnv` normalizes.
  const configDir = hookEvent === "SessionStart" ? configDirFromEnv(env) : null;

  // SessionStart only: capture the worktree-lane BRANCH from the producer-injected
  // `KEEPER_PLAN_WORKTREE_BRANCH` env (the durable per-job marker). Set-once on the
  // reducer's COALESCE arm, so a resume sends NULL → the first-launch branch holds.
  // `worktreeBranchFromEnv` collapses empty/whitespace/unset → NULL.
  const worktree =
    hookEvent === "SessionStart" ? worktreeBranchFromEnv(env) : null;

  // SessionStart only: stamp the launching harness. THIS hook only ever fires
  // for claude (other harnesses get their harness tag from a birth-ingest
  // synthetic SessionStart minted daemon-side), so it is a constant "claude"
  // going forward — NULL on every non-SessionStart row, mirroring `worktree`.
  // The fold folds it verbatim and never synthesizes a value; a legacy
  // NULL-harness row therefore reads as claude at every consumer. `resume_target`
  // stays NULL from this hook — claude resumes by its session id (== job_id)
  // already; the column is the back-fill channel for older producers, populated by
  // the daemon's ResumeTargetResolved producer, not here.
  const harness = hookEvent === "SessionStart" ? "claude" : null;
  const resumeTarget: string | null = null;

  // The ADOPTED marker is ALWAYS NULL from this hook — claude sessions this hook
  // fires for are launcher-owned (or claude-native), never "adopted". The marker
  // is set only by NON-launcher adoption paths, so the fold copies it verbatim
  // and this claude
  // producer carries NULL. Present-as-a-key to satisfy the KNOWN_EVENT_COLUMNS
  // lockstep (a bare-NULL binding, mirroring resume_target).
  const adopted: number | null = null;

  // SessionStart only: enrich the hook payload with the exact Dispatch attempt.
  // The carrier is parsed and bounded before persistence; missing or malformed
  // metadata leaves the original payload byte-for-byte unchanged.
  const dispatchAttemptId =
    hookEvent === "SessionStart" ? dispatchAttemptFromEnv(env) : null;
  const eventData =
    dispatchAttemptId == null
      ? raw
      : JSON.stringify({ ...data, dispatch_attempt_id: dispatchAttemptId });

  // SessionStart only: capture the PII-free account ROUTE from the launcher-
  // injected `KEEPER_ACCOUNT_ROUTE` env (mirrors config_dir / worktree). NULL on
  // every non-SessionStart row and whenever the launcher supplied no route, so
  // `events.account_route` is set-once per SessionStart and the reducer's
  // COALESCE arm carries latest-non-NULL-wins per-process attribution across a
  // resume. `accountRouteFromEnv` size/shape-bounds the untrusted value.
  const accountRoute =
    hookEvent === "SessionStart" ? accountRouteFromEnv(env) : null;

  // Backend-exec coordinates: captured on EVERY hook event, not SessionStart-
  // gated. A pure synchronous `process.env` read (no fork/fs/PPID-walk), so it
  // stays inside the cold-start budget on every fire. Absent sentinel
  // (`TMUX` unset/empty) ⇒ all three NULL — never a bogus `type` on a session
  // launched outside tmux. See {@link backendExecCoordsFromEnv}.
  const backendExecCoords = backendExecCoordsFromEnv(env);

  // The launched background-task id on PostToolUse:Monitor
  // (`tool_response.taskId`) and PostToolUse:Bash with `run_in_background`
  // (`tool_response.backgroundTaskId`). NULL on every other row so a
  // `WHERE background_task_id IS NOT NULL` partial index stays selective. The
  // reducer's Stop arm reads it via an in-fold scan to resolve three-way
  // provenance ('monitor'/'bash-bg'/'ambient') for the Stop's
  // `background_tasks` snapshot.
  const backgroundTaskId = extractBackgroundTaskId(hookEvent, toolName, data);

  // Promote the git-attribution fold's lone cross-event field
  // (`tool_input.file_path`) to `events.mutation_path`. Gated on
  // (PostToolUse, Write/Edit/MultiEdit/NotebookEdit); null on every other row,
  // so a `WHERE mutation_path IS NOT NULL` partial index stays selective. The
  // producer canonicalizes directory/root aliases and regular-file casing here;
  // the deterministic fold consumes only this persisted identity and performs
  // no filesystem reads. Legacy pre-deriver lines retain their lexical fallback.
  const mutationPath = canonicalMutationPathForEvent(
    extractMutationPath(hookEvent, toolName, data),
    cwd,
  );

  // The canonical bare-column binding map — the on-disk NDJSON shape is bare
  // column names (no `$` prefix). The daemon's ingester (`scanEventsLogDir`)
  // intersects these with the live `events` columns at ingest time, so the
  // column-skew degrade lives entirely daemon-side (post-migrate, race-free).
  // It is ALSO the canonical source the dead-letter record reads on failure, so
  // the on-disk record carries every column the hook would have produced —
  // including SessionStart-scraped fields (`spawn_name`, `start_time`,
  // `config_dir`) that are NOT in stdin and unrecoverable later. Key set MUST
  // equal KNOWN_EVENT_COLUMNS (LOCKSTEP test pins it).
  const bindings: DeadLetterBindings = {
    ts,
    session_id: sessionId,
    pid,
    hook_event: hookEvent,
    event_type: eventType,
    tool_name: toolName,
    matcher,
    cwd,
    permission_mode: permissionMode,
    agent_id: agentId,
    agent_type: agentType,
    stop_hook_active: stopHookActive,
    // The ORIGINAL stdin payload, verbatim. Claude Code hands every PreToolUse
    // hook the pre-rewrite tool_input, so a Bash command stored here is the one
    // TYPED, not the one EXECUTED — arthack's PreToolUse dispatcher independently
    // returns an updatedInput (python3→uv run, npm→pnpm, …) that changes what
    // runs. Miners must not read `data`'s command as the executed process; see
    // docs/plugin-composition-map.md (logged-vs-executed skew).
    data: eventData,
    subagent_agent_id: subagentAgentId,
    spawn_name: spawnName,
    start_time: startTime,
    slash_command: slashCommand,
    skill_name: skillName,
    plan_op: planOp,
    plan_target: planTarget,
    plan_epic_id: planEpicId,
    plan_task_id: planTaskId,
    plan_subject_present: planSubjectPresent,
    tool_use_id: toolUseId,
    config_dir: configDir,
    bash_mutation_kind: bashMutationKind,
    bash_mutation_targets: bashMutationTargets,
    plan_files: planFiles,
    backend_exec_type: backendExecCoords.type,
    backend_exec_session_id: backendExecCoords.sessionId,
    backend_exec_pane_id: backendExecCoords.paneId,
    background_task_id: backgroundTaskId,
    mutation_path: mutationPath,
    worktree,
    harness,
    resume_target: resumeTarget,
    adopted,
    account_route: accountRoute,
  };
  return bindings;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const data = JSON.parse(raw) as Record<string, unknown>;

  const hookEvent = strField(data, "hook_event_name") ?? "";
  if (!hookEvent) {
    return;
  }

  const ts = Date.now() / 1000;
  const pid = process.ppid;
  const sessionId = strField(data, "session_id") ?? "unknown";

  // SessionStart only: scrape the parent claude argv `--name`/`-n` AND the
  // process start_time in one probe. This is the SOLE non-pure step (it forks
  // `ps` / reads `/proc`), gated here to stay inside the cold-start budget;
  // `scrapeSpawnInfo` swallows every failure to `{null, null}`. The pure
  // `buildEventBindings` re-applies the SessionStart gate over the result.
  const spawnInfo: SpawnInfo =
    hookEvent === "SessionStart"
      ? await scrapeSpawnInfo()
      : { name: null, startTime: null };

  const bindings = buildEventBindings(
    data,
    raw,
    pid,
    process.env,
    spawnInfo,
    ts,
  );
  if (bindings === null) {
    return;
  }

  // Dead-letter on events-log APPEND failure. When `writeEventLog` fails hard
  // (EACCES/ENOSPC/EROFS/ENOENT-after-retry), this closure routes the event to
  // the dead-letter recovery file so the daemon recovers it — never silently
  // lost. Closes over the resolved bindings so the on-disk record carries every
  // column the hook would have produced.
  const deadLetter = (lastError: unknown): void => {
    const record: DeadLetterRecord = {
      dl_id: crypto.randomUUID(),
      session_id: sessionId,
      hook_event: hookEvent,
      ts,
      dl_written_at: Date.now() / 1000,
      pid,
      bindings,
    };
    writeDeadLetter(record);
    // Diagnostic drop-log (instrumentation, SEPARATE from the recovery record
    // above): capture WHY the append failed, so drop bursts can be attributed
    // to a cause (ENOSPC / EACCES / other) and time-correlated with the
    // daemon's traces. Best-effort — never affects the hook outcome.
    try {
      const e = lastError as { code?: unknown; message?: unknown } | null;
      writeDropLog(
        `${JSON.stringify({
          ts: Date.now() / 1000,
          hook_event: hookEvent,
          session_id: sessionId,
          pid,
          phase: "events_log_append",
          error_code: typeof e?.code === "string" ? e.code : null,
          error_message: (typeof e?.message === "string"
            ? e.message
            : String(lastError)
          ).slice(0, 300),
        })}\n`,
      );
    } catch {
      // instrumentation is best-effort; never affect the hook outcome
    }
    // Surface the underlying cause to stderr too — useful in
    // `claude --debug` output for diagnosing recurring drops.
    process.stderr.write(
      `keeper events-writer: events-log append failed (dead-lettered): ${lastError}\n`,
    );
  };

  const appended = writeEventLog({ bindings });
  if (!appended) {
    // Hard append failure (ENOSPC / EACCES / EROFS / ENOENT-after-retry): route
    // the event to the dead-letter recovery path so the daemon recovers it.
    // `writeEventLog` already logged the underlying errno to stderr; pass a
    // marker so the drop-log records the append-failure phase.
    deadLetter(new Error("events-log append returned failure"));
  }
}

// Outer guard: ANY failure here exits 0 with a stderr log. The hook contract
// is "never block Claude" — a stuck or wedged events-writer that propagates a
// non-zero exit can fail-closed the user's session, which is far worse than a
// missing event row.
//
// `import.meta.main` gates the run so a plain `import` (tests pulling in the
// pure, exported `nameFromArgs`) is inert — only direct invocation
// (`bun plugin/hooks/events-writer.ts`, how Claude Code runs it) executes main.
if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`keeper events-writer: ${err}\n`);
      process.exit(0);
    });
}

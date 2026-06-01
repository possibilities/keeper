#!/usr/bin/env bun
/**
 * Keeper events writer hook. Invoked by Claude Code once per hook event with
 * the payload on stdin. Writes a single row to the `events` table and exits.
 *
 * Hard guarantees:
 * - **Always exit 0** — even on parse failure, DB failure, or any thrown
 *   exception. Per the epic's locked decision: a hook MUST NOT block Claude.
 *   Losing one event row is acceptable; wedging the agent is not. Errors log
 *   to stderr so they surface in `claude --debug` output.
 * - **Minimal import graph** — only `bun:sqlite` (via `src/db.ts`) and the
 *   local resolver. Bun cold start is ~30ms and the SessionEnd hook has a
 *   1.5s timeout cap; every extra import is borrowed from that budget.
 * - **`pid = process.ppid`** — matches `os.getppid()` semantics in the
 *   reference python hook. Pairs with `start_time` (captured on SessionStart
 *   only) as a recycle-safe `(pid, start_time)` two-field identity: the bare
 *   pid is unsafe on macOS where pid space is small and recycle can happen
 *   within hours, so the seed sweep and exit-watcher both probe BOTH fields
 *   before folding a row to `killed`. `start_time` is a platform-tagged opaque
 *   string (`darwin:<lstart-text>` / `linux:<jiffies>`) — never interpreted
 *   cross-platform; the matcher just does string equality.
 *
 * Schema parity with the python reference is intentional — the reducer reads
 * the same shape regardless of which writer landed the row.
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, resolveDbPath } from "../../src/db";
import type {
  DeadLetterBindings,
  DeadLetterRecord,
} from "../../src/dead-letter";
import { serializeDeadLetterRecord } from "../../src/dead-letter";
import {
  extractBashMutation,
  extractPlanctlInvocation,
  extractSkillName,
  extractToolUseId,
  slashCommandFromPrompt,
} from "../../src/derivers";

/**
 * Hook event names that get renamed when stored as `event_type`. Matches
 * `_TYPE_MAP` in hooks-tracker.py:60-64. Everything else falls through to
 * snake_case (`PreToolUse` → `pre_tool_use`, etc).
 */
const TYPE_MAP: Record<string, string> = {
  SessionStart: "session_start",
  PostToolUse: "tool_use",
  Stop: "stop",
};

/**
 * Convert PascalCase / camelCase to snake_case. Mirrors the python regex at
 * `_snake_case` (hooks-tracker.py:293-294). Insert an underscore between any
 * lowercase/digit and following uppercase, then lowercase the whole thing.
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
 * fn-390 bridge column: PostToolUse:Agent rows carry the spawned subagent's
 * canonical id at `data.tool_response.agentId`. Persist it so the reducer can
 * join Pre/Post-Agent (tool_use_id-keyed) to SubagentStart/Stop
 * (agent_id-keyed) without heuristics. NULL on all other rows. camelCase on
 * the wire — `agentId`, not `agent_id`.
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
 * `--username foo` can't false-match. SINGLE-TOKEN by design (locked decision):
 * macOS `ps -o args=` space-joins argv and drops shell quoting, so a multi-word
 * `--name "a b"` is indistinguishable from `--name a` plus a trailing arg —
 * capturing only the first token is the only unambiguous read. Session names
 * are compound-word single tokens by convention, so this never bites in
 * practice. Returns null when no flag is present or the captured token is empty.
 */
export function nameFromArgs(args: string): string | null {
  const m = args.match(/(?:^|\s)(?:--name[= ]|-n )(\S+)/);
  const token = m?.[1];
  return token && token.length > 0 ? token : null;
}

/**
 * Pure splitter for the macOS `ps -o lstart=,args=` combined output. The
 * COLUMN ORDER MATTERS: `args=` must come LAST so macOS ps doesn't width-
 * truncate it. With `-o args=,lstart=` (args first), the `-ww` flag's "no
 * truncation" promise only applies to the FINAL output line — the args column
 * itself still gets truncated to a hardcoded width and the trailing characters
 * vanish, including any `--name <token>` flag past the column boundary.
 * Putting `lstart=` first sidesteps this: lstart is fixed-width 24 chars, args
 * trails to the end and gets the full `-ww` widening.
 *
 * Output shape is `<24-char-lstart><≥1-space-padding><args>` — lstart is the
 * libc `ctime(3)`-style `Day Mon DD HH:MM:SS YYYY`. Strategy: trim leading/
 * trailing whitespace, peel the leading 24 chars as lstart, validate the
 * shape, the remainder (left-trimmed) is `args`. Pure + exported for unit
 * tests so the column-split logic is verifiable without shelling out to ps.
 */
export function splitArgsLstart(
  out: string,
): { args: string; lstart: string } | null {
  const trimmed = out.replace(/^\s+|\s+$/g, "");
  if (trimmed.length < 24) {
    return null;
  }
  const lstart = trimmed.slice(0, 24);
  // ctime(3) shape: `Xxx Xxx D? HH:MM:SS YYYY` — 3-letter day, space,
  // 3-letter month, space, 1-or-2-digit day padded to width 2 with leading
  // space, space, HH:MM:SS, space, 4-digit year.
  if (
    !/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(
      lstart,
    )
  ) {
    return null;
  }
  const args = trimmed.slice(24).replace(/^\s+/, "");
  return { args, lstart };
}

/**
 * Linux `/proc/$pid/stat` field-22 reader (`starttime` in clock ticks since
 * boot — see proc(5)). Field-2 is `(comm)`, which may itself contain spaces
 * and parens, so a naive whitespace split is unsafe; bracket on the LAST `)`
 * then split the remainder. Returns the raw integer string or null.
 *
 * Pure + exported: callers pass the stat-file body so the parser is testable
 * without a real /proc mount (mock the file content).
 */
export function parseLinuxStarttime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  // After `(comm)` the fields are space-separated: state, ppid, pgrp, session,
  // tty_nr, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime,
  // cutime, cstime, priority, nice, num_threads, itrealvalue, starttime, ...
  // That's 19 fields after `comm` to reach `starttime` (which is the 22nd
  // overall: comm + state(3) ... starttime(22) → indices 0..19 after the `)`).
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // starttime is field 22 overall; comm is field 2; so it's the (22 - 2 - 1)th
  // index of `rest` = index 19.
  const raw = rest[19];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return raw;
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
 * Captured parent-process identity for a SessionStart event: the `--name`
 * token (when the launcher set one) and a platform-tagged `start_time` string
 * (`darwin:<lstart-text>` / `linux:<jiffies>`). Either field may be null
 * independently — name absent means the parent didn't carry `--name`, while
 * start_time absent means the platform probe failed (unknown OS, ps error,
 * /proc unreadable). The hook MUST stay exit-0, so every failure path lands
 * here as `null` rather than throwing.
 */
type SpawnInfo = { name: string | null; startTime: string | null };

/**
 * Scrape the spawn name AND start_time from the parent process via a single
 * platform-specific probe. SessionStart only — a `ps` fork on every hook
 * would blow the cold-start/SessionEnd-timeout budget. Single-level
 * `process.ppid` is correct: the arthack-claude launcher injects
 * `--name <session>` directly into the immediate parent claude argv.
 *
 * Darwin: ONE `ps -o lstart=,args=` fork captures both fields (lstart is
 * the 24-char fixed-width PREFIX; see `splitArgsLstart` and the
 * column-order comment below). Linux: read
 * `/proc/$PPID/stat` field 22 (no fork; `Bun.file` is just an open+read).
 * Unknown platforms return both fields null.
 *
 * The ENTIRE body is wrapped in try/catch returning `{null, null}` because
 * `Bun.spawnSync` THROWS (ENOENT) when `ps` is missing — a bare `success`
 * check is insufficient. `-ww` defeats width truncation; an explicit 500ms
 * timeout means a wedged `ps` can never threaten the hook's exit-0 contract.
 * Only the parsed name + opaque start_time string are returned — the raw
 * `args=` blob (which can carry secrets like `--token=...`) is discarded.
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

/**
 * Resolve the keeper dead-letter directory. `KEEPER_DEAD_LETTER_DIR` env wins
 * (hermetic tests point it at a tmpdir); otherwise default to
 * `~/.local/state/keeper/dead-letters/`, a sibling of the DB. The directory is
 * created best-effort 0o700-ish by {@link writeDeadLetter} on demand — the
 * helper is pure + does no I/O.
 */
function resolveDeadLetterDir(): string {
  const override = process.env.KEEPER_DEAD_LETTER_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "dead-letters");
}

/**
 * `SQLITE_BUSY` / `SQLITE_LOCKED` predicate. The bun:sqlite error carries
 * BOTH `.code` (e.g. `"SQLITE_BUSY"`) and a libsqlite-style `.message`
 * containing `"database is locked"`. Check both — the message text is the
 * stable cross-binding shape and `.code` may shift across bun versions.
 * `SQLITE_BUSY_SNAPSHOT` and every other error are NOT retriable: the
 * `BEGIN IMMEDIATE` already avoids the lock-upgrade snapshot path and the
 * caller goes straight to dead-letter on anything else.
 */
function isRetriableLockError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  // `SQLITE_BUSY_SNAPSHOT` is NOT retriable (the BEGIN IMMEDIATE path avoids
  // it; if it surfaces anyway, dead-letter immediately).
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  return message.includes("database is locked");
}

/**
 * Synchronous sleep for `ms` milliseconds. The hook runs without an event
 * loop after `main()` returns control, so `setTimeout` is unavailable inside
 * the retry path. `Atomics.wait` on a fresh, zero-initialized SharedArrayBuffer
 * blocks the current thread for up to the timeout — no event loop required.
 * The wait always returns `"timed-out"` since nothing else holds a handle to
 * the buffer to notify.
 */
function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Best-effort append-one-line write of a dead-letter record to the per-pid
 * NDJSON file. The hook MUST never throw past this helper — every failure
 * mode (mkdir fail, append fail, chmod fail) is swallowed to stderr so the
 * exit-0 contract holds. The chmod is best-effort 0o600 because the
 * serialized bindings can carry prompt text and file paths the user
 * reasonably considers private.
 *
 * The per-pid filename (`<pid>.ndjson`) keeps concurrent same-process hook
 * writes (e.g. a late PostToolUse overlapping SessionEnd) from interleaving
 * with each other: different pids never share a file, so an >PIPE_BUF (512 B
 * on macOS) line can't tear across two hooks' appends.
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
 * Hook-local `busy_timeout` (ms). Lower than the shared 5s `applyPragmas`
 * value because the hook lives inside Claude's SessionEnd 1.5s budget. Named
 * so the diagnostic drop-log can report the value the hook actually waited on.
 */
const HOOK_BUSY_TIMEOUT_MS = 1200;

/**
 * Diagnostic drop-log path. One NDJSON line per dead-lettered INSERT —
 * SEPARATE from the dead-letter recovery records (those drive replay; this is
 * pure instrumentation to attribute drop bursts: error code, attempts, wait).
 * Append-only, never consumed. `KEEPER_DROP_LOG` overrides for tests.
 */
function dropLogPath(): string {
  const env = process.env.KEEPER_DROP_LOG;
  if (env != null && env.length > 0) return env;
  return join(homedir(), ".local", "state", "keeper", "hook-drops.ndjson");
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

async function main(): Promise<void> {
  const raw = await readStdin();
  const data = JSON.parse(raw) as Record<string, unknown>;

  const hookEvent = strField(data, "hook_event_name") ?? "";
  if (!hookEvent) {
    // Empty hook_event_name matches the python reference's silent skip
    // behavior — Claude Code occasionally sends keepalive-shaped payloads
    // that aren't real events. Don't write a row for them.
    return;
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

  const ts = Date.now() / 1000;
  const pid = process.ppid;
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

  // v10: index the slash-command on UserPromptSubmit and the Skill-tool name
  // on Pre/PostToolUse-on-Skill. Both derivers are pure, gated, and return
  // null on anything that doesn't match the canonical shape — see
  // `src/derivers.ts` for the regex anchoring + defensive shape checks.
  // Module-scope derivers (compile-once regex) share one source of truth
  // with the v9→v10 migration backfill and the reducer.
  const slashCommand =
    hookEvent === "UserPromptSubmit"
      ? slashCommandFromPrompt(data.prompt)
      : null;
  const skillName = extractSkillName(hookEvent, toolName, data);

  // v14: index the planctl-CLI invocation footprint on PostToolUse:Bash by
  // parsing the authoritative `planctl_invocation` envelope planctl writes
  // on every mutating call's stdout (top-level `planctl_invocation` key
  // inside `data.tool_response.stdout`). The deriver is pure, gated on
  // hook event + tool name, and defensive against any malformed
  // `data.tool_response` shape — a null return collapses to all five params
  // bound NULL on the prepared statement. The v19→v20 migration backfill
  // reuses this exact function so live + historical rows derive
  // byte-identically.
  const planctlInvocation = extractPlanctlInvocation(hookEvent, toolName, data);
  const planctlOp = planctlInvocation?.op ?? null;
  const planctlTarget = planctlInvocation?.target ?? null;
  const planctlEpicId = planctlInvocation?.epic_id ?? null;
  const planctlTaskId = planctlInvocation?.task_id ?? null;
  // `subject_present` is 0/1 on disk to match the INTEGER column; NULL when
  // the event is not a planctl invocation at all.
  const planctlSubjectPresent =
    planctlInvocation === null
      ? null
      : planctlInvocation.subject_present
        ? 1
        : 0;
  // v30: `queue_jump` mirrors the `subject_present` 0/1/null convention —
  // INTEGER on disk, NULL when the event isn't a planctl invocation at all.
  // Lifted from the envelope's `queue_jump` boolean by the deriver's
  // `=== true` defensive check (legacy / non-boolean / absent → `false`),
  // so a re-fold from cursor=0 reproduces the column byte-identically.
  const planctlQueueJump =
    planctlInvocation === null ? null : planctlInvocation.queue_jump ? 1 : 0;
  // v46 (fn-666): the envelope's repo-relative `files[]` array, JSON-encoded
  // for the SQLite TEXT column. NULL when the deriver couldn't lift a
  // non-empty string array (non-planctl events, read-only ops with `files:
  // null`/`[]`, or runaway-size payloads). Mirrors `bash_mutation_targets`'s
  // sparse JSON-or-NULL convention; the partial-index `WHERE planctl_files
  // IS NOT NULL` predicate (when one is added) would stay selective.
  const planctlFiles =
    planctlInvocation?.files == null
      ? null
      : JSON.stringify(planctlInvocation.files);

  // v17: index the Anthropic tool_use_id correlator on every event payload
  // carrying it. Unlike `slashCommandFromPrompt` / `extractSkillName` /
  // `extractPlanctlInvocation`, the deriver is NOT gated on hook event or
  // tool name — Pre/PostToolUse + PostToolUseFailure on every tool (Bash,
  // Read, Edit, Agent, …) carry `data.tool_use_id` and all populate the
  // column. The partial-index `WHERE tool_use_id IS NOT NULL` predicate
  // keeps the index small. Bridges the SubagentStart/Stop folds to their
  // matching PreToolUse:Agent payload in the `subagent_invocations`
  // projection (task .3 — this task only ships the column + the hook
  // wiring; no reducer cases yet).
  const toolUseId = extractToolUseId(data);

  // v31: index the bash mutation footprint on PostToolUse:Bash by tokenizing
  // the authoritative `tool_input.command` string and matching against a
  // hardcoded pattern table (package managers, explicit fs verbs, git tree-
  // mutators). The deriver is pure, gated on hook event + tool name, and
  // defensive against any malformed `tool_input` shape — a null return
  // collapses to both params bound NULL on the prepared statement. The
  // v30→v31 migration backfill reuses this exact function so live +
  // historical rows derive byte-identically. Pure-function purity is the
  // re-fold-determinism contract: a future bugfix to `extractBashMutation`
  // would require a schema-bump-with-rewind to re-backfill stored rows.
  const bashMutation = extractBashMutation(hookEvent, toolName, data, cwd);
  const bashMutationKind = bashMutation?.kind ?? null;
  // Serialize the targets array as JSON. NULL when no mutation matched, so
  // the partial index (`WHERE bash_mutation_kind IS NOT NULL`) stays
  // selective and the column shape stays the standard sparse-text pattern.
  const bashMutationTargets =
    bashMutation === null ? null : JSON.stringify(bashMutation.targets);

  // SessionStart only: scrape the parent claude argv `--name`/`-n` AND the
  // process start_time in a single platform-specific probe, so the reducer can
  // seed `jobs.title` from the very first event AND store the recycle-safe
  // `(pid, start_time)` identity used downstream by the seed sweep + exit-
  // watcher. The probe is gated here (not run on every hook) to stay inside
  // the cold-start budget; `scrapeSpawnInfo` swallows every failure to
  // `{null, null}` so it can never break the exit-0 contract.
  const spawnInfo: SpawnInfo =
    hookEvent === "SessionStart"
      ? await scrapeSpawnInfo()
      : { name: null, startTime: null };

  // SessionStart only: capture `CLAUDE_CONFIG_DIR` from the hook process's
  // own env (Bun.spawn inherits env by default, so the parent claude
  // process's env propagates into the hook subprocess — see the fn-614
  // task .1 probe). Mirrors the `spawnInfo` SessionStart gate: every other
  // hook event sends NULL, so a row's `events.config_dir` is set-once per
  // SessionStart and the reducer's `COALESCE(excluded, jobs)` ON CONFLICT
  // SET handles the latest-non-NULL-wins semantics for resume. The pure
  // `configDirFromEnv` helper normalizes (undefined/'' → null; strip one
  // trailing '/'); see its doc for the locked rules.
  const configDir =
    hookEvent === "SessionStart" ? configDirFromEnv(process.env) : null;

  // Resolve the full named-bindings map ONCE up front, outside the open/
  // retry block. The same object is reused for every retry attempt and is
  // the canonical source the dead-letter record reads from on final failure —
  // so the on-disk record carries every column the hook would have
  // produced, including SessionStart-scraped fields (`spawn_name`,
  // `start_time`, `config_dir`) that are NOT in stdin and unrecoverable
  // later. Each `$`-prefixed key strips its prefix when projected into the
  // dead-letter `bindings` map (the schema-shared form is bare column
  // names — see `DeadLetterBindings` in `src/dead-letter.ts`).
  const insertBindings = {
    $ts: ts,
    $session_id: sessionId,
    $pid: pid,
    $hook_event: hookEvent,
    $event_type: eventType,
    $tool_name: toolName,
    $matcher: matcher,
    $cwd: cwd,
    $permission_mode: permissionMode,
    $agent_id: agentId,
    $agent_type: agentType,
    $stop_hook_active: stopHookActive,
    $data: raw,
    $subagent_agent_id: subagentAgentId,
    $spawn_name: spawnInfo.name,
    $start_time: spawnInfo.startTime,
    $slash_command: slashCommand,
    $skill_name: skillName,
    $planctl_op: planctlOp,
    $planctl_target: planctlTarget,
    $planctl_epic_id: planctlEpicId,
    $planctl_task_id: planctlTaskId,
    $planctl_subject_present: planctlSubjectPresent,
    $tool_use_id: toolUseId,
    $config_dir: configDir,
    $planctl_queue_jump: planctlQueueJump,
    $bash_mutation_kind: bashMutationKind,
    $bash_mutation_targets: bashMutationTargets,
    $planctl_files: planctlFiles,
    // Schema v48 / fn-668: backend-exec coordinates land NULL until T3 wires
    // the pure-env capture (`ZELLIJ`/`ZELLIJ_SESSION_NAME`/`ZELLIJ_PANE_ID`
    // reads). The bindings exist now so the prepared statement compiles
    // against the v48 events column set; T3 just swaps in the real values.
    $backend_exec_type: null,
    $backend_exec_session_id: null,
    $backend_exec_pane_id: null,
  };

  // Dead-letter on FINAL INSERT failure (fn-643 task .2). The closure
  // captures the resolved `insertBindings` + envelope fields once; the call
  // site fires it after `openDb` failure OR after the bounded retry has
  // exhausted. The hook ALWAYS reaches one of those two call sites
  // post-bindings, never both, so the on-disk dl_id is unique per dropped
  // INSERT. Inline (not an outer helper) so it closes over the resolved
  // bindings and the SessionStart-scraped fields without re-plumbing them
  // through a long argument list.
  const deadLetter = (
    lastError: unknown,
    diag?: { attempts: number; wait_ms: number },
  ): void => {
    // Bare-column bindings (strip the `$` prefix the prepared-statement
    // uses) so the daemon-side import (task .3) can map it 1:1 to the
    // `events` columns on a future replay.
    const bindings: DeadLetterBindings = {};
    for (const [key, value] of Object.entries(insertBindings)) {
      const column = key.startsWith("$") ? key.slice(1) : key;
      bindings[column] = value;
    }
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
    // above): capture WHY the INSERT failed and how long the hook waited, so
    // drop bursts can be attributed to a cause (SQLITE_BUSY contention vs
    // schema-mismatch vs other) and time-correlated with the daemon's
    // `[fold-slow]` trace. Best-effort — never affects the hook outcome.
    try {
      const e = lastError as { code?: unknown; message?: unknown } | null;
      writeDropLog(
        `${JSON.stringify({
          ts: Date.now() / 1000,
          hook_event: hookEvent,
          session_id: sessionId,
          pid,
          phase: diag != null ? "insert" : "open",
          error_code: typeof e?.code === "string" ? e.code : null,
          error_message: (typeof e?.message === "string"
            ? e.message
            : String(lastError)
          ).slice(0, 300),
          attempts: diag?.attempts ?? 0,
          wait_ms: diag?.wait_ms ?? 0,
          busy_timeout_ms: HOOK_BUSY_TIMEOUT_MS,
        })}\n`,
      );
    } catch {
      // instrumentation is best-effort; never affect the hook outcome
    }
    // Surface the underlying cause to stderr too — useful in
    // `claude --debug` output for diagnosing recurring drops.
    process.stderr.write(
      `keeper events-writer: INSERT failed (dead-lettered): ${lastError}\n`,
    );
  };

  // `migrate: false` — the daemon is the sole migrator (see CLAUDE.md
  // "Migrations are forward-only"). A fresh install must boot the daemon
  // at least once before the hook can write; the LaunchAgent handles this
  // on login. A hook arriving against a missing/stale schema fails inside
  // `openDb` at `prepareStmts` time (the prepared INSERT names a column
  // that doesn't yet exist) — that throw is a post-binding failure too, so
  // the dead-letter path captures it. The exit-0 contract still holds.
  let opened: ReturnType<typeof openDb>;
  try {
    opened = openDb(resolveDbPath(), {
      migrate: false,
      // Pass the hook's tight budget so `applyPragmas` sets busy_timeout BEFORE
      // the `journal_mode = WAL` switch — otherwise that switch fails instantly
      // under contention (the `open:SQLITE_BUSY` drops). No later override
      // needed: this value rides every statement on the connection.
      busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS,
    });
  } catch (err) {
    deadLetter(err);
    return;
  }
  const { db, stmts } = opened;
  try {
    // busy_timeout is already HOOK_BUSY_TIMEOUT_MS — `openDb` set it FIRST in
    // applyPragmas (before the journal_mode=WAL switch), so the hook stays
    // inside Claude's SessionEnd 1.5s budget AND the WAL switch no longer fails
    // instantly under contention. No re-set needed here.

    // BEGIN IMMEDIATE avoids the lock-upgrade SQLITE_BUSY path: a plain BEGIN
    // would start read-only and need to upgrade to write on INSERT, which
    // bypasses busy_timeout and errors immediately on contention. IMMEDIATE
    // grabs the reserved lock up front and waits per busy_timeout for any
    // in-flight writer.
    //
    // Bounded retry (fn-643 task .2): on `SQLITE_BUSY`/`SQLITE_LOCKED`
    // (either `.code` match or `"database is locked"` in `.message`), sleep
    // ~30ms synchronously and retry exactly ONCE. Every other error
    // (`SQLITE_BUSY_SNAPSHOT`, schema mismatch, constraint violation, etc.)
    // is non-retriable → straight to dead-letter. The retry budget is
    // bounded (1 attempt + 1 short sleep + 1 retry) so the hook stays
    // safely inside the SessionEnd 1.5s budget even on contention.
    const insert = db.transaction(() => {
      // Named bindings: a missed column on a future ALTER no longer silently
      // shifts data into the next slot. `start_time` is captured on
      // SessionStart only as a platform-tagged opaque string — null on every
      // other event by design.
      stmts.insertEvent.run(insertBindings);
    });

    const insertStartedAt = Date.now();
    let lastError: unknown = null;
    let succeeded = false;
    let attemptsMade = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      attemptsMade = attempt + 1;
      try {
        insert();
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempt === 0 && isRetriableLockError(err)) {
          sleepSync(30);
          continue;
        }
        break;
      }
    }

    if (!succeeded) {
      deadLetter(lastError, {
        attempts: attemptsMade,
        wait_ms: Date.now() - insertStartedAt,
      });
    }
  } finally {
    db.close();
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

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

import { openDb, resolveDbPath } from "../../src/db";

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
 * Darwin: ONE `ps -o args=,lstart=` fork captures both fields (lstart is
 * 24-char fixed-width at the end; see `splitArgsLstart`). Linux: read
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

  const { db, stmts } = openDb(resolveDbPath());
  try {
    // BEGIN IMMEDIATE avoids the lock-upgrade SQLITE_BUSY path: a plain BEGIN
    // would start read-only and need to upgrade to write on INSERT, which
    // bypasses busy_timeout and errors immediately on contention. IMMEDIATE
    // grabs the reserved lock up front and waits per busy_timeout (5s) for
    // any in-flight writer.
    db.transaction(() => {
      // Named bindings: a missed column on a future ALTER no longer silently
      // shifts data into the next slot. `start_time` is captured on
      // SessionStart only as a platform-tagged opaque string — null on every
      // other event by design.
      stmts.insertEvent.run({
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
      });
    })();
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

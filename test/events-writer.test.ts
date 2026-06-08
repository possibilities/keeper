/**
 * Tests for the events-writer hook's spawn-name capture (fn-545) and the
 * lock-free NDJSON write path (fn-736).
 *
 * fn-736 flipped the hook from a direct SQLite `INSERT INTO events` to a per-pid
 * NDJSON append under the events-log dir (`KEEPER_EVENTS_LOG`). The hook no
 * longer touches SQLite at all; the daemon-side ingester (`scanEventsLogDir`)
 * tails those files and lands each line as a real `events` row. So the
 * integration assertions here read the APPENDED NDJSON line (via
 * `readEventBinding`, which parses the per-pid file with the SAME
 * `parseEventLogLine` the ingester uses) instead of SELECTing from the DB —
 * a byte-identical-round-trip check that the binding the hook produced is the
 * one the ingester will INSERT.
 *
 * Two layers:
 * - `nameFromArgs` unit cases — the pure, exported flag parser. All flag forms
 *   (`--name=X` / `--name X` / `-n X`) parse to a single token; flag-boundary
 *   anchoring rejects `--rename`/`--username`; absent/empty → null.
 * - Hook-process integration — drive the real hook as a spawned process whose
 *   PARENT argv carries `--name <session>`, and assert via the appended NDJSON
 *   line: SessionStart populates `spawn_name`; a non-SessionStart event leaves
 *   it NULL; the hook always exits 0 even when the `ps` scrape can't find a
 *   name; an append failure still exits 0 and dead-letters.
 *
 * The parent-argv carrier is a tiny launcher script (`spawn-launcher.ts`)
 * written into the tmpdir: when run as `bun run spawn-launcher.ts --name <X>`,
 * IT becomes the hook's parent (`process.ppid`), so the hook's
 * `ps -p <ppid> -o args=` scrape sees the `--name` flag exactly as it would
 * under the real arthack-claude launcher.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendExecCoordsFromEnv,
  configDirFromEnv,
  KNOWN_EVENT_COLUMNS,
  nameFromArgs,
  parseLinuxStarttime,
  splitArgsLstart,
} from "../plugin/hooks/events-writer";
import { openDb } from "../src/db";
import {
  type DeadLetterBindings,
  parseDeadLetterLine,
  parseEventLogLine,
} from "../src/dead-letter";
import {
  extractPlanctlInvocation,
  extractSkillName,
  extractToolUseId,
  planVerbRefFromSpawnName,
  slashCommandFromPrompt,
} from "../src/derivers";
import { sandboxEnv } from "./helpers/sandbox-env";

const ROOT = join(import.meta.dir, "..");
const HOOK_ENTRY = join(ROOT, "plugin", "hooks", "events-writer.ts");

let tmpDir: string;
let dbPath: string;
let launcherPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-events-writer-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // The hook opens with `{ migrate: false }` — the daemon is the sole
  // migrator (see CLAUDE.md "Migrations are forward-only"). These tests
  // simulate "daemon has already booted at least once" by pre-migrating
  // the schema here. Without this, the hook's `prepareStmts` would throw
  // on the missing `events` table — the intentional fresh-install failure
  // mode that the outer try/catch swallows to stderr.
  openDb(dbPath).db.close();
  launcherPath = join(tmpDir, "spawn-launcher.ts");
  // The launcher pipes a payload (its first non-flag arg after the marker) into
  // the hook on stdin and exits with the hook's code. Its OWN argv carries the
  // `--name <session>` flag, so the hook's parent (= this launcher process)
  // exposes the flag to `ps`.
  writeFileSync(
    launcherPath,
    `
const HOOK = ${JSON.stringify(HOOK_ENTRY)};
// Everything after "--payload" is the JSON payload to pipe to the hook.
const idx = process.argv.indexOf("--payload");
const payload = idx >= 0 ? process.argv[idx + 1] : "{}";
const proc = Bun.spawn(["bun", HOOK], {
  env: process.env,
  stdin: new TextEncoder().encode(payload),
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
process.exit(code);
`,
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Shared sandboxed base env for every test spawn that fires the real hook.
 *
 * The hook honors three state-bearing env vars: `KEEPER_DB` (events DB),
 * `KEEPER_DEAD_LETTER_DIR` (per-pid NDJSON recovery files), and
 * `KEEPER_DROP_LOG` (the diagnostic drop-log append). The daemon (not
 * the hook directly, but spawned indirectly) also honors
 * `KEEPER_ZELLIJ_EVENTS_DIR` (fn-684 task .3 — per-session zellij
 * plugin NDJSON files) and `KEEPER_BACKSTOP_LOG` (fn-720 — the
 * backstop-telemetry sidecar main is the sole writer of). If any of these falls through to its
 * production default, a test run pollutes the user's real
 * `~/.local/state/keeper/` paths — the drop-log leak that fn-657
 * exists to close. Centralize them here so a new spawn site can't
 * forget one.
 *
 * Computed from the LIVE per-test `tmpDir` (re-created each `beforeEach`),
 * never frozen at module scope.
 */
function sandboxedBaseEnv(): Record<string, string> & {
  KEEPER_DB: string;
  KEEPER_DEAD_LETTER_DIR: string;
  KEEPER_DROP_LOG: string;
  KEEPER_ZELLIJ_EVENTS_DIR: string;
  KEEPER_BACKSTOP_LOG: string;
} {
  // Family B (hook-spawn): keep ambient ids, include the zellij feed. The
  // shared core (test/helpers/sandbox-env.ts) guarantees the SIX state paths
  // are set; the cast pins the keys this file's callers read by name.
  return sandboxEnv({
    tmpDir,
    dbPath,
    clearAmbientIds: false,
    includeZellij: true,
  }) as Record<string, string> & {
    KEEPER_DB: string;
    KEEPER_DEAD_LETTER_DIR: string;
    KEEPER_DROP_LOG: string;
    KEEPER_ZELLIJ_EVENTS_DIR: string;
    KEEPER_BACKSTOP_LOG: string;
  };
}

/** Run the launcher with a given session name + payload; resolve its exit code. */
async function fireViaLauncher(
  sessionName: string | null,
  payload: Record<string, unknown>,
): Promise<number> {
  const args = ["bun", "run", launcherPath];
  if (sessionName !== null) {
    args.push("--name", sessionName);
  }
  args.push("--payload", JSON.stringify(payload));
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env: sandboxedBaseEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

/**
 * Read every per-pid `<pid>.ndjson` file under the sandboxed events-log dir,
 * parse each line with the SAME `parseEventLogLine` the daemon ingester uses,
 * and return the FIRST record whose bindings match `session_id` (and
 * `hook_event`, when given). Returns `null` if no matching record was appended.
 *
 * This replaces the old `SELECT ... FROM events` DB read: post-fn-736 the hook
 * only appends NDJSON (no daemon runs in these tests to ingest it), so the
 * appended line IS the assertion surface — and asserting on the parsed bindings
 * proves the byte-identical round-trip the ingester relies on.
 */
function readEventBinding(
  sessionId: string,
  hookEvent?: string,
): DeadLetterBindings | null {
  const dir = join(tmpDir, "events-log");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((s) => s.length > 0);
    for (const line of lines) {
      const record = parseEventLogLine(line);
      if (record === null) continue;
      const b = record.bindings;
      if (b.session_id !== sessionId) continue;
      if (hookEvent !== undefined && b.hook_event !== hookEvent) continue;
      return b;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// nameFromArgs unit
// ---------------------------------------------------------------------------

test("nameFromArgs parses --name=foo", () => {
  expect(nameFromArgs("/path/to/claude --name=foo --other")).toBe("foo");
});

test("nameFromArgs parses --name foo", () => {
  expect(nameFromArgs("/path/to/claude --name foo --other")).toBe("foo");
});

test("nameFromArgs parses -n foo", () => {
  expect(nameFromArgs("/path/to/claude -n foo --other")).toBe("foo");
});

test("nameFromArgs captures a single token (multi-word truncates)", () => {
  // `ps` space-joins argv; a multi-word name is indistinguishable from trailing
  // args, so only the first token is captured (locked single-token policy).
  expect(nameFromArgs("claude --name foo bar baz")).toBe("foo");
});

test("nameFromArgs does not false-match --rename or --username", () => {
  expect(nameFromArgs("claude --rename foo")).toBeNull();
  expect(nameFromArgs("claude --username foo")).toBeNull();
});

test("nameFromArgs returns null when no name flag is present", () => {
  expect(nameFromArgs("/path/to/claude --resume --model opus")).toBeNull();
});

test("nameFromArgs returns null on an empty string", () => {
  expect(nameFromArgs("")).toBeNull();
});

test("nameFromArgs matches a --name flag at the very start of the string", () => {
  expect(nameFromArgs("--name foo")).toBe("foo");
});

// ---------------------------------------------------------------------------
// Hook process integration
// ---------------------------------------------------------------------------

test("SessionStart populates events.spawn_name from the parent argv --name", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "SessionStart",
    session_id: "sess-spawn",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-spawn", "SessionStart");
  expect(b?.spawn_name).toBe("my-session");
});

test("SessionStart populates events.start_time platform-tagged", async () => {
  // The ps/proc probe runs against this test process's launcher — so the
  // captured start_time is a real, live value. We don't assert the exact text
  // (it's opaque), only that it is populated and carries the platform prefix
  // matching the current OS.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "SessionStart",
    session_id: "sess-stime",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-stime", "SessionStart");
  const startTime = b?.start_time as string | null | undefined;
  expect(startTime).not.toBeNull();
  const expectedPrefix =
    process.platform === "darwin"
      ? "darwin:"
      : process.platform === "linux"
        ? "linux:"
        : null;
  if (expectedPrefix !== null) {
    expect(startTime?.startsWith(expectedPrefix)).toBe(true);
    // Body after the prefix is non-empty (24-char lstart / digit jiffies).
    expect(
      (startTime?.slice(expectedPrefix.length) ?? "").length,
    ).toBeGreaterThan(0);
  }
});

test("a non-SessionStart event leaves spawn_name AND start_time NULL", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-ups",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-ups", "UserPromptSubmit");
  expect(b?.spawn_name).toBeNull();
  expect(b?.start_time).toBeNull();
});

test("hook exits 0 and writes a row even when the parent argv has no name", async () => {
  // No --name on the launcher argv: the scrape returns null (not a throw), the
  // hook still writes the SessionStart row, and exits 0. start_time still
  // comes back populated — the same single probe captures it, --name absence
  // doesn't break the lstart half.
  const code = await fireViaLauncher(null, {
    hook_event_name: "SessionStart",
    session_id: "sess-noname",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-noname");
  expect(b).not.toBeNull();
  expect(b?.spawn_name).toBeNull();
  // start_time should still populate on supported platforms; we don't strand
  // it on the no-name path.
  if (process.platform === "darwin" || process.platform === "linux") {
    expect(b?.start_time).not.toBeNull();
  }
});

test("hook exits 0 with NULL start_time when the ps probe is force-broken", async () => {
  // Force-failure path: prepend a tmpdir to PATH that shadows `ps` with a
  // bash script exiting 1 (mimics a wedged/missing ps without removing
  // /bin/sh). The hook MUST swallow the failure, exit 0, and write the row
  // with start_time = NULL (and spawn_name = NULL on darwin since the same
  // probe yields both fields). On linux this won't break the /proc reads, so
  // the assertion only requires that the hook exits 0 and the row exists.
  const shadowDir = join(tmpDir, "shadow-bin");
  mkdirSync(shadowDir, { recursive: true });
  const fakePs = join(shadowDir, "ps");
  writeFileSync(fakePs, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  // Reuse the launcher but inject the shadowed PATH via a wrapper env on the
  // spawn. We do it inline instead of through fireViaLauncher so this test
  // controls env without touching the shared helper.
  const args = [
    "bun",
    "run",
    launcherPath,
    "--name",
    "shadowed",
    "--payload",
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-broken-ps",
      cwd: "/tmp/work",
    }),
  ];
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env: {
      ...sandboxedBaseEnv(),
      PATH: `${shadowDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(0);

  const b = readEventBinding("sess-broken-ps");
  expect(b).not.toBeNull();
  if (process.platform === "darwin") {
    // Darwin path: the single ps probe yields BOTH fields, so a broken ps
    // strands both as NULL.
    expect(b?.spawn_name).toBeNull();
    expect(b?.start_time).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// splitArgsLstart unit (Darwin column-split)
// ---------------------------------------------------------------------------

test("splitArgsLstart peels a 24-char lstart off the leading edge", () => {
  // Real-shape sample: 24-char lstart + ≥1 space padding + args.
  const sample = "Sat May 23 10:46:29 2026     /bin/zsh -c source\n";
  const got = splitArgsLstart(sample);
  expect(got).not.toBeNull();
  expect(got?.args).toBe("/bin/zsh -c source");
  expect(got?.lstart).toBe("Sat May 23 10:46:29 2026");
});

test("splitArgsLstart handles single-digit day padding (space-padded)", () => {
  // ctime(3) left-pads single-digit days with a leading space: ` 7` not `07`.
  const sample = "Mon Jan  7 03:04:05 2025     /usr/bin/foo\n";
  const got = splitArgsLstart(sample);
  expect(got).not.toBeNull();
  expect(got?.lstart).toBe("Mon Jan  7 03:04:05 2025");
  expect(got?.args).toBe("/usr/bin/foo");
});

test("splitArgsLstart preserves args verbatim including --name flag", () => {
  // The whole point of putting lstart FIRST: macOS ps doesn't truncate args
  // when it's the last column, so the launcher's --name <token> survives even
  // for long argv lines that would have been clipped under `args=,lstart=`.
  const sample =
    "Sat May 23 10:46:29 2026     bun run /tmp/spawn-launcher.ts --name my-session --payload xxx";
  const got = splitArgsLstart(sample);
  expect(got).not.toBeNull();
  expect(got?.args).toBe(
    "bun run /tmp/spawn-launcher.ts --name my-session --payload xxx",
  );
});

test("splitArgsLstart rejects a malformed leading field", () => {
  // Leading 24 chars don't match the ctime(3) shape — return null rather than
  // feeding garbage downstream.
  expect(splitArgsLstart("not a real lstart here /some/proc")).toBeNull();
});

test("splitArgsLstart rejects a string shorter than the lstart width", () => {
  expect(splitArgsLstart("short")).toBeNull();
  expect(splitArgsLstart("")).toBeNull();
});

// ---------------------------------------------------------------------------
// parseLinuxStarttime unit (Linux /proc/PID/stat field 22)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic /proc/PID/stat where fields after `(comm)` are
 * `state, ppid, pgrp, ..., itrealvalue, starttime, ...` — placing
 * `starttime` (overall field 22, 20th field after comm) at index 19 of
 * the post-comm split. The helper accepts a starttime token so a test
 * can inject a non-numeric value to exercise the validation branch.
 */
function buildStat(
  comm: string,
  starttime: string,
  trailing = "999 888",
): string {
  const beforeStarttime: string[] = [];
  // 19 placeholder fields: state, ppid, pgrp, session, tty_nr, tpgid, flags,
  // minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority,
  // nice, num_threads, itrealvalue. Values don't matter to the parser; they
  // just hold positions.
  beforeStarttime.push("S"); // state
  for (let i = 1; i < 19; i++) {
    beforeStarttime.push(String(i));
  }
  return `42 (${comm}) ${beforeStarttime.join(" ")} ${starttime} ${trailing}\n`;
}

test("parseLinuxStarttime extracts field 22 from a real-shape stat line", () => {
  expect(parseLinuxStarttime(buildStat("my-proc", "12345"))).toBe("12345");
});

test("parseLinuxStarttime handles a comm with spaces and parens", () => {
  // comm field can contain anything including `(` `)` ` ` — proc(5) says the
  // canonical parser brackets on the LAST `)`. Use a comm that embeds both.
  expect(parseLinuxStarttime(buildStat("some (nested) comm", "77777"))).toBe(
    "77777",
  );
});

test("parseLinuxStarttime returns null on a malformed stat line (no closing paren)", () => {
  expect(parseLinuxStarttime("42 some comm no parens here")).toBeNull();
});

test("parseLinuxStarttime returns null when field 22 is non-numeric", () => {
  expect(parseLinuxStarttime(buildStat("proc", "not-a-number"))).toBeNull();
});

// ---------------------------------------------------------------------------
// slashCommandFromPrompt unit (v10 deriver)
// ---------------------------------------------------------------------------

test("slashCommandFromPrompt extracts a bare /command at start", () => {
  expect(slashCommandFromPrompt("/foo")).toBe("/foo");
});

test("slashCommandFromPrompt extracts /plugin:command", () => {
  expect(slashCommandFromPrompt("/plan:work fn-575-foo")).toBe("/plan:work");
});

test("slashCommandFromPrompt extracts /command-with-kebab", () => {
  expect(slashCommandFromPrompt("/some-command and args")).toBe(
    "/some-command",
  );
});

test("slashCommandFromPrompt allows underscore and digits in body", () => {
  expect(slashCommandFromPrompt("/foo_bar2 args")).toBe("/foo_bar2");
});

test("slashCommandFromPrompt stops at first non-class character", () => {
  // The body class is `[\w:-]`; a space, `.`, `/`, `!`, etc. all stop it.
  expect(slashCommandFromPrompt("/foo bar")).toBe("/foo");
  expect(slashCommandFromPrompt("/foo!")).toBe("/foo");
  expect(slashCommandFromPrompt("/foo.bar")).toBe("/foo");
  expect(slashCommandFromPrompt("/foo/bar")).toBe("/foo");
});

test("slashCommandFromPrompt rejects /Uppercase (paths like /Users/...)", () => {
  // Strict: requires a lowercase letter immediately after `/` so file paths
  // can never false-match.
  expect(slashCommandFromPrompt("/Users/mike/code/keeper")).toBeNull();
  expect(slashCommandFromPrompt("/Library/Caches")).toBeNull();
});

test("slashCommandFromPrompt rejects a non-leading /command", () => {
  // Anchored to start-of-string: an inline mention never matches.
  expect(slashCommandFromPrompt("hello /plan:work fn-575")).toBeNull();
  expect(slashCommandFromPrompt("  /foo")).toBeNull();
});

test("slashCommandFromPrompt rejects a bare slash or empty", () => {
  expect(slashCommandFromPrompt("/")).toBeNull();
  expect(slashCommandFromPrompt("")).toBeNull();
});

test("slashCommandFromPrompt rejects a digit-led command (/1foo)", () => {
  // The first body char must be `[a-z]` — `/1foo` rejects (matches no path
  // shape we want to index anyway).
  expect(slashCommandFromPrompt("/1foo")).toBeNull();
});

test("slashCommandFromPrompt returns null on non-string input", () => {
  // Defensive against Claude Code shape drift — see CLAUDE.md "always exit 0".
  expect(slashCommandFromPrompt(null)).toBeNull();
  expect(slashCommandFromPrompt(undefined)).toBeNull();
  expect(slashCommandFromPrompt(42)).toBeNull();
  expect(slashCommandFromPrompt({})).toBeNull();
  expect(slashCommandFromPrompt(["/foo"])).toBeNull();
});

// ---------------------------------------------------------------------------
// extractSkillName unit (v10 deriver)
// ---------------------------------------------------------------------------

test("extractSkillName: PreToolUse + Skill + string skill → returns skill", () => {
  expect(
    extractSkillName("PreToolUse", "Skill", {
      tool_input: { skill: "plan:plan" },
    }),
  ).toBe("plan:plan");
});

test("extractSkillName: PostToolUse + Skill + string skill → returns skill", () => {
  expect(
    extractSkillName("PostToolUse", "Skill", {
      tool_input: { skill: "arthack:check" },
    }),
  ).toBe("arthack:check");
});

test("extractSkillName: non-Pre/PostToolUse hook returns null", () => {
  // Every other hook (SessionStart, Stop, Notification, etc.) is gated out.
  expect(
    extractSkillName("SessionStart", "Skill", {
      tool_input: { skill: "plan:plan" },
    }),
  ).toBeNull();
  expect(
    extractSkillName("UserPromptSubmit", "Skill", {
      tool_input: { skill: "plan:plan" },
    }),
  ).toBeNull();
});

test("extractSkillName: PreToolUse on a non-Skill tool returns null", () => {
  // Even with a `tool_input.skill` populated, the tool gate keeps it out —
  // only Skill tool invocations populate the column.
  expect(
    extractSkillName("PreToolUse", "Bash", {
      tool_input: { skill: "plan:plan" },
    }),
  ).toBeNull();
  expect(
    extractSkillName("PreToolUse", "Read", {
      tool_input: { skill: "plan:plan" },
    }),
  ).toBeNull();
});

test("extractSkillName: missing tool_input returns null", () => {
  expect(extractSkillName("PreToolUse", "Skill", {})).toBeNull();
});

test("extractSkillName: non-object tool_input returns null (defensive)", () => {
  expect(
    extractSkillName("PreToolUse", "Skill", { tool_input: "not an object" }),
  ).toBeNull();
  expect(
    extractSkillName("PreToolUse", "Skill", { tool_input: 42 }),
  ).toBeNull();
  expect(
    extractSkillName("PreToolUse", "Skill", { tool_input: null }),
  ).toBeNull();
});

test("extractSkillName: non-string skill returns null (defensive)", () => {
  expect(
    extractSkillName("PreToolUse", "Skill", { tool_input: { skill: 42 } }),
  ).toBeNull();
  expect(
    extractSkillName("PreToolUse", "Skill", {
      tool_input: { skill: { name: "plan:plan" } },
    }),
  ).toBeNull();
});

test("extractSkillName: empty-string skill returns null", () => {
  expect(
    extractSkillName("PreToolUse", "Skill", { tool_input: { skill: "" } }),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// planVerbRefFromSpawnName unit (v10 deriver)
// ---------------------------------------------------------------------------

test("planVerbRefFromSpawnName: work::<epic-task> → {work, ref}", () => {
  expect(planVerbRefFromSpawnName("work::fn-575-osc-parser.3")).toEqual({
    plan_verb: "work",
    plan_ref: "fn-575-osc-parser.3",
  });
});

test("planVerbRefFromSpawnName: close::<epic> → {close, epic-id}", () => {
  expect(planVerbRefFromSpawnName("close::fn-575-osc-parser")).toEqual({
    plan_verb: "close",
    plan_ref: "fn-575-osc-parser",
  });
});

test("planVerbRefFromSpawnName: plan::<ref> → {plan, ref}", () => {
  expect(planVerbRefFromSpawnName("plan::fn-100-new-thing")).toEqual({
    plan_verb: "plan",
    plan_ref: "fn-100-new-thing",
  });
});

test("planVerbRefFromSpawnName: approve::<epic-task> → {approve, ref}", () => {
  expect(planVerbRefFromSpawnName("approve::fn-619-pin-foo.1")).toEqual({
    plan_verb: "approve",
    plan_ref: "fn-619-pin-foo.1",
  });
});

test("planVerbRefFromSpawnName: approve::<epic> → {approve, epic-id}", () => {
  expect(planVerbRefFromSpawnName("approve::fn-619-pin-foo")).toEqual({
    plan_verb: "approve",
    plan_ref: "fn-619-pin-foo",
  });
});

test("planVerbRefFromSpawnName: audit::<ref> → {null, null} (whitelist)", () => {
  // audit is NOT in the locked whitelist — adding it requires editing the
  // regex deliberately, never silent fall-through.
  expect(planVerbRefFromSpawnName("audit::fn-1-foo")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: develop::<ref> → {null, null} (whitelist)", () => {
  expect(planVerbRefFromSpawnName("develop::fn-1-foo")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: extra ::segment rejected (no partial match)", () => {
  // The `$` anchor rejects trailing data — a typo never partial-matches and
  // lands wrong data in the projection.
  expect(planVerbRefFromSpawnName("work::fn-1-foo::extra")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: malformed ref (non-fn-shaped) rejected", () => {
  expect(planVerbRefFromSpawnName("work::not-an-fn-ref")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
  expect(planVerbRefFromSpawnName("work::fn-no-number-here")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: NULL or empty → {null, null}", () => {
  expect(planVerbRefFromSpawnName(null)).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
  expect(planVerbRefFromSpawnName("")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: free-text (no ::) rejected", () => {
  // A bare session name like `my-job` (no `verb::ref` shape) gets both NULL.
  expect(planVerbRefFromSpawnName("my-job")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
  expect(planVerbRefFromSpawnName("fix-osc")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: case-sensitive verb (Work::... rejected)", () => {
  // The verb is lowercase-only; a casing typo never lands wrong data.
  expect(planVerbRefFromSpawnName("Work::fn-1-foo")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

// ---------------------------------------------------------------------------
// Hook process integration (v10): slash_command + skill_name end-to-end
// ---------------------------------------------------------------------------

test("hook writes slash_command on UserPromptSubmit with /plan:work prompt", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-slash",
    cwd: "/tmp/work",
    prompt: "/plan:work fn-575-osc-parser.3",
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-slash");
  expect(b?.slash_command).toBe("/plan:work");
  expect(b?.skill_name).toBeNull();
});

// The slash_command NULL cases below are deriver-input mappings, not wiring:
// the hook lifts `data.prompt` straight into `slashCommandFromPrompt` on
// UserPromptSubmit (the wiring itself is proven by the kept spawn above).
// Re-proving the deriver's null-on-non-command behavior through a subprocess
// "tests nothing" the in-process call doesn't — convert to a direct deriver
// assertion on the exact field the hook reads (fn-722 task .5 thinning).
test("slash_command stays NULL for a free-text UserPromptSubmit prompt", () => {
  expect(
    slashCommandFromPrompt("just a free-text prompt without a leading slash"),
  ).toBeNull();
});

test("slash_command stays NULL for a /Users/... path-shaped prompt", () => {
  expect(slashCommandFromPrompt("/Users/mike/code/keeper")).toBeNull();
});

test("hook writes skill_name on PreToolUse + Skill", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-skill",
    cwd: "/tmp/work",
    tool_name: "Skill",
    tool_input: { skill: "plan:plan", args: "..." },
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-skill");
  expect(b?.slash_command).toBeNull();
  expect(b?.skill_name).toBe("plan:plan");
});

// The non-Skill negative is a deriver gate, not wiring (the PreToolUse:Skill
// wiring is proven by the kept spawn above). `extractSkillName` already gates
// on the tool name in-process — assert it directly on the same fields the hook
// reads rather than paying a subprocess to re-prove the null path.
test("skill_name stays NULL on a PreToolUse non-Skill tool", () => {
  expect(
    extractSkillName("PreToolUse", "Bash", { tool_input: { command: "ls" } }),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// Hook process integration (v14): planctl_* columns end-to-end
// ---------------------------------------------------------------------------

test("hook writes planctl_* columns on PostToolUse:Bash with a planctl envelope on stdout", async () => {
  // Mutation verb on an epic id: subject_present=1, epic_id stamped,
  // task_id NULL (epic-form ref). The envelope (top-level
  // `planctl_invocation` key in tool_response.stdout) is the authoritative
  // source — what `planctl epic-create fn-N-foo "subject"` actually emits.
  const stdout = JSON.stringify({
    planctl_invocation: {
      op: "epic-create",
      target: "fn-42-foo",
      subject: "the subject",
    },
  });
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PostToolUse",
    session_id: "sess-planctl-create",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: 'planctl epic-create fn-42-foo "the subject"' },
    tool_response: { stdout },
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-planctl-create");
  expect(b?.planctl_op).toBe("epic-create");
  expect(b?.planctl_target).toBe("fn-42-foo");
  expect(b?.planctl_epic_id).toBe("fn-42-foo");
  expect(b?.planctl_task_id).toBeNull();
  expect(b?.planctl_subject_present).toBe(1);
});

// The deriver-shape cases below (task-ref split, no-envelope, PreToolUse gate)
// exercise `extractPlanctlInvocation` directly — the kept epic-create spawn
// above proves the PostToolUse:Bash → columns wiring end-to-end, so re-spawning
// per shape only re-runs the deriver inside a subprocess. Convert to in-process
// calls of the exported deriver over the exact payload shapes the hook lifts
// (fn-722 task .5 thinning; deriver internals also covered by derivers.test.ts).
test("extractPlanctlInvocation splits a read-only verb on a task-form ref", () => {
  // subject_present=false, epic_id + task_id both stamped via parsePlanRef.
  const stdout = JSON.stringify({
    planctl_invocation: { op: "cat", target: "fn-42-foo.3", subject: null },
  });
  const got = extractPlanctlInvocation("PostToolUse", "Bash", {
    tool_response: { stdout },
  });
  expect(got).not.toBeNull();
  expect(got?.op).toBe("cat");
  expect(got?.target).toBe("fn-42-foo.3");
  expect(got?.epic_id).toBe("fn-42-foo");
  expect(got?.task_id).toBe("fn-42-foo.3");
  expect(got?.subject_present).toBe(false);
});

test("extractPlanctlInvocation returns null when stdout carries no envelope", () => {
  // Plain-text Bash stdout → all planctl_* columns stay NULL (selective index).
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", {
      tool_response: { stdout: "drwxr-xr-x  ... /tmp\n" },
    }),
  ).toBeNull();
});

test("extractPlanctlInvocation is gated to PostToolUse (PreToolUse → null)", () => {
  // PreToolUse:Bash carries no tool_response envelope — the gate keeps the
  // columns NULL even on a planctl command.
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", {
      tool_input: { command: "planctl epic-create fn-1-bar" },
    }),
  ).toBeNull();
});

test("hook exits 0 on PostToolUse:Bash with a malformed tool_response.stdout (defensive)", async () => {
  // Non-string `stdout` field: the deriver returns null defensively (the
  // hook never throws, exit-0 contract preserved). Asserts via exit code +
  // that the row landed with planctl_op NULL.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PostToolUse",
    session_id: "sess-planctl-malformed",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: "planctl epic-create fn-1-bar" },
    tool_response: { stdout: { not: "a string" } },
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-planctl-malformed");
  expect(b).not.toBeNull();
  expect(b?.planctl_op).toBeNull();
});

test("end-to-end: hook append → ingester → events row → fold derives jobs.plan_verb/plan_ref", async () => {
  // The full fn-736 path: fire SessionStart whose parent argv carries the
  // canonical spawn name — the hook APPENDS the NDJSON line (no SQLite). The
  // daemon-side ingester (`scanEventsLogDir`) then lands it as a real `events`
  // row, and the existing fold derives plan_verb/plan_ref. Proves the lock-free
  // ingest path round-trips byte-identically into the unchanged reducer.
  const code = await fireViaLauncher("close::fn-575-osc-parser", {
    hook_event_name: "SessionStart",
    session_id: "sess-close",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  // Ingest the appended NDJSON into `events`, then drain via the same code
  // paths the daemon uses.
  const { db } = openDb(dbPath);
  try {
    const { drainToCompletion, scanEventsLogDir } = await import(
      "../src/daemon"
    );
    scanEventsLogDir(db, join(tmpDir, "events-log"));
    drainToCompletion(db);
    const row = db
      .prepare(
        "SELECT plan_verb, plan_ref FROM jobs WHERE job_id = 'sess-close'",
      )
      .get() as { plan_verb: string | null; plan_ref: string | null };
    expect(row.plan_verb).toBe("close");
    expect(row.plan_ref).toBe("fn-575-osc-parser");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Hook process integration — events.tool_use_id capture (v17)
// ---------------------------------------------------------------------------

test("PreToolUse:Bash with tool_use_id populates events.tool_use_id", async () => {
  // The hook stamps `events.tool_use_id` for every event whose `data`
  // carries the field — no event-name / tool-name gate. PreToolUse:Bash is
  // representative; the field rides through verbatim via extractToolUseId.
  const code = await fireViaLauncher("any-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-bash-tuid",
    tool_name: "Bash",
    tool_use_id: "toolu_01ABCDEF",
    tool_input: { command: "echo hello" },
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-bash-tuid", "PreToolUse");
  expect(b?.tool_use_id).toBe("toolu_01ABCDEF");
});

test("PostToolUse:Agent with tool_use_id populates events.tool_use_id", async () => {
  // Agent (Task tool) PostToolUse carries tool_use_id too — the field is
  // load-bearing for the SubagentStart/Stop ↔ Pre/Post-Agent bridge in
  // task .3's reducer.
  const code = await fireViaLauncher("any-session", {
    hook_event_name: "PostToolUse",
    session_id: "sess-agent-tuid",
    tool_name: "Agent",
    tool_use_id: "toolu_AGENT_42",
    tool_response: { agentId: "agent-xyz" },
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-agent-tuid", "PostToolUse");
  expect(b?.tool_use_id).toBe("toolu_AGENT_42");
  // Cross-check: extractSubagentAgentId still stamps the existing bridge
  // column on the same row (the two derivers are independent).
  expect(b?.subagent_agent_id).toBe("agent-xyz");
});

// The kept PreToolUse:Bash + PostToolUse:Agent spawns above prove the
// tool_use_id wiring (and the subagent_agent_id bridge cross-stamp). The
// no-field case is a pure `extractToolUseId` shape check — a payload without
// the field yields null so the partial-index stays selective. Convert to an
// in-process deriver call (fn-722 task .5 thinning).
test("extractToolUseId returns null on a payload without tool_use_id", () => {
  expect(extractToolUseId({ prompt: "hi" })).toBeNull();
});

// ---------------------------------------------------------------------------
// configDirFromEnv unit (v22 — CLAUDE_CONFIG_DIR capture)
// ---------------------------------------------------------------------------

test("configDirFromEnv: a populated env value passes through", () => {
  expect(configDirFromEnv({ CLAUDE_CONFIG_DIR: "/path/to/profile" })).toBe(
    "/path/to/profile",
  );
});

test("configDirFromEnv: undefined collapses to null", () => {
  expect(configDirFromEnv({})).toBeNull();
});

test("configDirFromEnv: empty string collapses to null", () => {
  expect(configDirFromEnv({ CLAUDE_CONFIG_DIR: "" })).toBeNull();
});

test("configDirFromEnv: a single trailing slash is stripped", () => {
  expect(configDirFromEnv({ CLAUDE_CONFIG_DIR: "/path/to/profile/" })).toBe(
    "/path/to/profile",
  );
});

test("configDirFromEnv: a bare '/' value passes through unchanged", () => {
  // Edge case: stripping a trailing slash from '/' would yield empty string,
  // which collides with the absent shape. The helper guards on length > 1.
  expect(configDirFromEnv({ CLAUDE_CONFIG_DIR: "/" })).toBe("/");
});

// ---------------------------------------------------------------------------
// backendExecCoordsFromEnv unit (schema v48 / fn-668 — every-event capture)
// ---------------------------------------------------------------------------

test("backendExecCoordsFromEnv: absent ZELLIJ sentinel returns all-NULL", () => {
  // Outside a zellij pane (the typical case for any Claude session not
  // launched under zellij) every coord stays NULL — never stamp a
  // bogus `type='zellij'` per the task acceptance.
  expect(backendExecCoordsFromEnv({})).toEqual({
    type: null,
    sessionId: null,
    paneId: null,
  });
});

test("backendExecCoordsFromEnv: empty ZELLIJ sentinel collapses to all-NULL", () => {
  // Empty-string env is the same shape as absent — both collapse so the
  // reducer's COALESCE arm can't be clobbered by an empty stamp.
  expect(
    backendExecCoordsFromEnv({
      ZELLIJ: "",
      ZELLIJ_SESSION_NAME: "mike-main",
      ZELLIJ_PANE_ID: "7",
    }),
  ).toEqual({ type: null, sessionId: null, paneId: null });
});

test("backendExecCoordsFromEnv: ZELLIJ sentinel set stamps type + both sub-vars verbatim", () => {
  expect(
    backendExecCoordsFromEnv({
      ZELLIJ: "0",
      ZELLIJ_SESSION_NAME: "mike-main",
      ZELLIJ_PANE_ID: "11",
    }),
  ).toEqual({ type: "zellij", sessionId: "mike-main", paneId: "11" });
});

test("backendExecCoordsFromEnv: empty sub-var collapses to NULL while sentinel + the other sub-var stay populated", () => {
  // Partial capture: type fires (so the reducer's gate triggers the
  // COALESCE) but the NULL sub-var preserves the prior captured value.
  expect(
    backendExecCoordsFromEnv({
      ZELLIJ: "0",
      ZELLIJ_SESSION_NAME: "",
      ZELLIJ_PANE_ID: "7",
    }),
  ).toEqual({ type: "zellij", sessionId: null, paneId: "7" });
});

test("backendExecCoordsFromEnv: pane id passes through as raw TEXT (no numeric coercion)", () => {
  // The T4 tab resolver joins on string-equality against `list-panes`'
  // numeric `id`, but the env stamp is always TEXT — we preserve the
  // raw env string verbatim so the join lands.
  const got = backendExecCoordsFromEnv({
    ZELLIJ: "0",
    ZELLIJ_SESSION_NAME: "mike-main",
    ZELLIJ_PANE_ID: "42",
  });
  expect(got.paneId).toBe("42");
  expect(typeof got.paneId).toBe("string");
});

// ---------------------------------------------------------------------------
// CLAUDE_CONFIG_DIR hook-process integration
// ---------------------------------------------------------------------------

/**
 * Fire the launcher with an explicit env override (vs the shared
 * `fireViaLauncher` which always inherits process.env wholesale). Lets us
 * set / unset `CLAUDE_CONFIG_DIR` for the SessionStart capture test.
 */
async function fireViaLauncherWithEnv(
  sessionName: string | null,
  payload: Record<string, unknown>,
  envOverlay: Record<string, string | undefined>,
): Promise<number> {
  const args = ["bun", "run", launcherPath];
  if (sessionName !== null) {
    args.push("--name", sessionName);
  }
  args.push("--payload", JSON.stringify(payload));
  // Merge process.env + KEEPER_DB + overlay. An undefined value in the overlay
  // explicitly clears the key (the launcher's `env: process.env` would
  // otherwise re-inherit the test runner's own CLAUDE_CONFIG_DIR if set).
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEEPER_DB: dbPath,
  };
  for (const [k, v] of Object.entries(envOverlay)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  // Apply the sandboxed state-bearing keys AFTER the overlay-clear loop so a
  // caller overlay (which uses `undefined` to delete keys) can NEVER strand
  // KEEPER_DROP_LOG / KEEPER_DEAD_LETTER_DIR / KEEPER_EVENTS_LOG back at their
  // production defaults. fn-657: the drop-log leak class lived precisely in the
  // gap a caller could open by clearing a state key on an inherited base. The
  // events-log dir (fn-736) is now the hook's HAPPY-path write target — leaking
  // it pollutes the user's real feed, so it must be sandboxed too.
  const sandbox = sandboxedBaseEnv();
  env.KEEPER_DB = sandbox.KEEPER_DB;
  env.KEEPER_DEAD_LETTER_DIR = sandbox.KEEPER_DEAD_LETTER_DIR;
  env.KEEPER_DROP_LOG = sandbox.KEEPER_DROP_LOG;
  env.KEEPER_EVENTS_LOG = sandbox.KEEPER_EVENTS_LOG;
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

test("SessionStart stamps events.config_dir from CLAUDE_CONFIG_DIR env", async () => {
  const code = await fireViaLauncherWithEnv(
    "my-session",
    {
      hook_event_name: "SessionStart",
      session_id: "sess-cfg-set",
      cwd: "/tmp/work",
    },
    { CLAUDE_CONFIG_DIR: "/Users/x/.claude-profiles/profile-a" },
  );
  expect(code).toBe(0);

  const b = readEventBinding("sess-cfg-set", "SessionStart");
  expect(b?.config_dir).toBe("/Users/x/.claude-profiles/profile-a");
});

// The trailing-slash / unset / empty cases are pure `configDirFromEnv`
// value-normalizations — the kept "stamps from env" spawn above proves the
// SessionStart → config_dir wiring, and the "non-SessionStart leaves NULL"
// spawn below proves the gate. Spawning a subprocess per value variant just
// re-runs the deriver, so assert it directly via the shared sandbox-env helper
// (state paths sandboxed even though configDirFromEnv reads only
// CLAUDE_CONFIG_DIR) over the LIVE per-test env (fn-722 task .5 thinning).
test("configDirFromEnv normalizes the SessionStart-captured CLAUDE_CONFIG_DIR", () => {
  const trailing = sandboxEnv({
    tmpDir,
    dbPath,
    clearAmbientIds: false,
    includeZellij: true,
    extra: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-profiles/profile-b/" },
  });
  expect(configDirFromEnv(trailing)).toBe(
    "/Users/x/.claude-profiles/profile-b",
  );

  const unset = sandboxEnv({
    tmpDir,
    dbPath,
    clearAmbientIds: false,
    includeZellij: true,
    extra: { CLAUDE_CONFIG_DIR: undefined },
  });
  expect(configDirFromEnv(unset)).toBeNull();

  const empty = sandboxEnv({
    tmpDir,
    dbPath,
    clearAmbientIds: false,
    includeZellij: true,
    extra: { CLAUDE_CONFIG_DIR: "" },
  });
  expect(configDirFromEnv(empty)).toBeNull();
});

test("a non-SessionStart event leaves config_dir NULL even when CLAUDE_CONFIG_DIR is set", async () => {
  // Locked design: env-capture is SessionStart-gated, same as spawn_name /
  // start_time. A UserPromptSubmit row never carries the env value, even when
  // it is set in the hook process.
  const code = await fireViaLauncherWithEnv(
    "my-session",
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-cfg-ups",
      cwd: "/tmp/work",
    },
    { CLAUDE_CONFIG_DIR: "/Users/x/.claude-profiles/profile-c" },
  );
  expect(code).toBe(0);

  const b = readEventBinding("sess-cfg-ups", "UserPromptSubmit");
  expect(b?.config_dir).toBeNull();
});

// ---------------------------------------------------------------------------
// Dead-letter path (fn-643 task .2)
// ---------------------------------------------------------------------------

/**
 * Fire the launcher with an explicit `KEEPER_DEAD_LETTER_DIR` override so
 * the test can inspect the per-pid NDJSON dead-letter file without touching
 * the user's real `~/.local/state/keeper/dead-letters/` directory. Also
 * accepts an `extraEnv` overlay so a single test can FORCE an events-log
 * APPEND failure (point `KEEPER_EVENTS_LOG` at an un-mkdir-able path — fn-736)
 * without mutating the shared `fireViaLauncher` helper.
 *
 * Returns both the launcher exit code AND the resolved dead-letter dir so
 * callers can scan the directory for the pid-keyed NDJSON file. The
 * launcher's PID is the writer pid — the spawned bun-hook process's parent.
 */
async function fireViaLauncherWithDeadLetter(
  sessionName: string | null,
  payload: Record<string, unknown>,
  deadLetterDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number; deadLetterDir: string; launcherPid: number }> {
  const args = ["bun", "run", launcherPath];
  if (sessionName !== null) {
    args.push("--name", sessionName);
  }
  args.push("--payload", JSON.stringify(payload));
  const env: Record<string, string> = {
    ...sandboxedBaseEnv(),
    // Caller's deadLetterDir is the whole point of this helper — it overrides
    // the sandbox default so the test can inspect the per-pid NDJSON file.
    KEEPER_DEAD_LETTER_DIR: deadLetterDir,
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  // KEEPER_DROP_LOG is never a legitimate extraEnv target for these tests
  // (the only state keys callers manipulate are KEEPER_EVENTS_LOG and the
  // dead-letter dir). Re-apply the sandbox value after the overlay loop so a
  // future caller can't accidentally re-leak it. fn-657.
  env.KEEPER_DROP_LOG = sandboxedBaseEnv().KEEPER_DROP_LOG;
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, deadLetterDir, launcherPid: proc.pid ?? -1 };
}

/**
 * Build an events-log path that makes the hook's `appendFileSync` fail HARD
 * (fn-736): point `KEEPER_EVENTS_LOG` at a sub-path UNDER a regular file. The
 * hook's `mkdirSync(dir, {recursive})` throws `ENOTDIR` (a path component is a
 * file, not a dir) — not the ENOENT-retry case — so the append falls straight
 * to the dead-letter fallback. Returns the poisoned dir path.
 */
function poisonedEventsLogDir(): string {
  const blocker = join(tmpDir, "events-log-blocker");
  // A regular file where a directory is expected.
  writeFileSync(blocker, "not a directory");
  return join(blocker, "events-log");
}

test("a forced events-log append failure writes a per-pid NDJSON dead-letter and exits 0", async () => {
  // fn-736: the happy path is a per-pid events-log append. Force it to fail by
  // pointing KEEPER_EVENTS_LOG under a regular file (mkdir → ENOTDIR), the
  // canonical "ENOSPC/EACCES/EROFS hard-failure" class. The repurposed
  // dead-letter fallback captures the resolved bindings to disk and the hook
  // still exits 0.
  const dlDir = join(tmpDir, "dead-letters");

  const { code } = await fireViaLauncherWithDeadLetter(
    "my-session",
    {
      hook_event_name: "SessionStart",
      session_id: "sess-deadletter-ss",
      cwd: "/tmp/work",
    },
    dlDir,
    { KEEPER_EVENTS_LOG: poisonedEventsLogDir() },
  );
  // Exit-0 contract holds even when the append side fails — the hook must
  // never wedge Claude's session.
  expect(code).toBe(0);

  // The per-pid NDJSON file lands in the override dir. We don't know the
  // hook subprocess's pid, but it's the only file in the dir.
  expect(existsSync(dlDir)).toBe(true);
  const files = readdirSync(dlDir).filter((f) => f.endsWith(".ndjson"));
  expect(files.length).toBe(1);
  const [fileName] = files;
  if (fileName === undefined) throw new Error("expected one dead-letter file");
  // Filename is <pid>.ndjson.
  expect(/^\d+\.ndjson$/.test(fileName)).toBe(true);

  const lines = readFileSync(join(dlDir, fileName), "utf-8")
    .split("\n")
    .filter((s) => s.length > 0);
  expect(lines.length).toBe(1);
  const [line] = lines;
  if (line === undefined) throw new Error("expected one dead-letter line");
  const record = parseDeadLetterLine(line);
  expect(record).not.toBeNull();
  if (record === null) throw new Error("expected a parsed dead-letter record");
  expect(record.dl_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(record.session_id).toBe("sess-deadletter-ss");
  expect(record.hook_event).toBe("SessionStart");
  expect(typeof record.ts).toBe("number");
  expect(typeof record.dl_written_at).toBe("number");
  expect(typeof record.pid).toBe("number");

  // SessionStart-scraped fields MUST round-trip into the dead-letter
  // record — they're not in stdin and are unrecoverable later. The launcher
  // passes `--name my-session`, so the ps probe captures it on macOS/linux.
  // On darwin the ps probe captures both spawn_name AND start_time
  // simultaneously; on linux they're independent /proc reads. Assert
  // structurally regardless of platform.
  expect(record.bindings.session_id).toBe("sess-deadletter-ss");
  expect(record.bindings.hook_event).toBe("SessionStart");
  expect(record.bindings.event_type).toBe("session_start");
  expect("spawn_name" in record.bindings).toBe(true);
  expect("start_time" in record.bindings).toBe(true);
  expect("config_dir" in record.bindings).toBe(true);
  if (process.platform === "darwin" || process.platform === "linux") {
    // The launcher (the hook's parent) DOES carry `--name my-session` on its
    // argv, so the spawn_name capture lands.
    expect(record.bindings.spawn_name).toBe("my-session");
  }
});

test("events-log append file is mode 0o600 (private — bindings can carry secrets)", async () => {
  // fn-736: the happy-path events-log file (like the dead-letter file before
  // it) carries prompt text / file paths the user reasonably considers
  // private — assert the per-pid file is chmod 0o600.
  const code = await fireViaLauncher("any", {
    hook_event_name: "SessionStart",
    session_id: "sess-mode",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const dir = join(tmpDir, "events-log");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  expect(files.length).toBe(1);
  const [fileName] = files;
  if (fileName === undefined) throw new Error("expected one events-log file");
  const path = join(dir, fileName);
  // Stat: file mode masked to permission bits = 0o600 on platforms that
  // honor chmod (everywhere bun runs except Windows, which we don't ship).
  const { statSync } = await import("node:fs");
  const mode = statSync(path).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("steady-state success appends events-log line and writes NO dead-letter file", async () => {
  // Normal happy path (fn-736): the events-log append succeeds, so the
  // dead-letter fallback is never invoked. The dead-letter override dir stays
  // empty / absent; the events-log dir carries exactly one per-pid line.
  const dlDir = join(tmpDir, "dead-letters-happy");
  const { code } = await fireViaLauncherWithDeadLetter(
    "my-session",
    {
      hook_event_name: "SessionStart",
      session_id: "sess-happy",
      cwd: "/tmp/work",
    },
    dlDir,
  );
  expect(code).toBe(0);

  // Either the dir doesn't exist at all (writeDeadLetter never ran, so
  // mkdir never ran), or it's empty. Both shapes are valid.
  if (existsSync(dlDir)) {
    const files = readdirSync(dlDir);
    expect(files.length).toBe(0);
  }

  // And the event landed as an appended NDJSON line (the happy path).
  const b = readEventBinding("sess-happy", "SessionStart");
  expect(b).not.toBeNull();
});

test("A non-string tool_use_id (defensive path) lands NULL, hook still exits 0", async () => {
  // Claude Code shape drift: a non-string `tool_use_id` falls through
  // extractToolUseId's defensive return and the column stays NULL. The
  // exit-0 contract is preserved.
  const code = await fireViaLauncher("any-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-bad-tuid",
    tool_name: "Read",
    tool_use_id: 42, // wrong shape
    tool_input: { file_path: "/x" },
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-bad-tuid");
  expect(b?.tool_use_id).toBeNull();
});

// ---------------------------------------------------------------------------
// Full-column round-trip (fn-736)
// ---------------------------------------------------------------------------
//
// The pre-fn-736 hook OPENED the DB and ran an adaptive `PRAGMA table_info` ∩
// known INSERT — the schema-bump deploy race lived there (fn-669). fn-736 flips
// the hook to a per-pid NDJSON append and moves the column-intersection degrade
// daemon-side (the ingester `scanEventsLogDir` intersects bindings ∩ live
// columns post-migrate, race-free; covered by `test/events-ingest-worker.test.ts`).
// So the hook-side fn-669 SKEW / NEGATIVE-broken-DB / HAPPY tests retired with
// the SQLite path. What stays is the appended-line full-column round-trip below
// + the LOCKSTEP triple-pin.

test("fn-736 FULL-COLUMN: the appended NDJSON line carries every known column binding", async () => {
  // The hook builds the events-log record from the same `insertBindings` map
  // that the deleted INSERT used. Assert the appended line's bindings carry
  // EVERY `KNOWN_EVENT_COLUMNS` key — so a future regression that drops a
  // legitimate column from the record (and would silently never reach the
  // ingester's INSERT) shows up here. SessionStart-attributable columns carry
  // real values; sibling columns are present-with-NULL.
  const code = await fireViaLauncher("happy-session", {
    hook_event_name: "SessionStart",
    session_id: "sess-fullcols",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const b = readEventBinding("sess-fullcols", "SessionStart");
  expect(b).not.toBeNull();
  if (b === null) throw new Error("expected an appended events-log binding");
  // Every known column is present as a binding key (NULL-valued where not
  // lifted on SessionStart). The ingester binds the intersection of these with
  // the live `events` columns, so a missing key here is a permanent drop.
  for (const col of KNOWN_EVENT_COLUMNS) {
    expect(col in b).toBe(true);
  }
  expect(b.hook_event).toBe("SessionStart");
  expect(b.event_type).toBe("session_start");
  expect(b.spawn_name).toBe("happy-session");
});

test("fn-672 LOCKSTEP: KNOWN_EVENT_COLUMNS == events table columns == insertBindings keys", async () => {
  // F1 from the fn-669 audit: three hand-maintained lists must stay in
  // lockstep — `KNOWN_EVENT_COLUMNS` (events-writer.ts), `insertBindings`
  // (same file), and `CREATE_EVENTS` (src/db.ts). The pre-fn-672 happy
  // test SELECTs a literal column list — catches removal (SQL won't
  // compile) but a NEW column added to `CREATE_EVENTS` without a matching
  // `KNOWN_EVENT_COLUMNS` entry silently drops from every hook INSERT
  // permanently. This test pins all three to the same set.

  // Axis 1: live migrated DB's `events` columns (minus the auto-`id` PK)
  // == `KNOWN_EVENT_COLUMNS`. `beforeEach` already migrated `dbPath`.
  const { db } = openDb(dbPath, { readonly: true });
  let liveCols: Set<string>;
  try {
    const rows = db.prepare("PRAGMA table_info('events')").all() as {
      name: string;
    }[];
    liveCols = new Set(rows.map((r) => r.name).filter((n) => n !== "id"));
  } finally {
    db.close();
  }
  // Symmetric set-equality: every live column is in KNOWN, every KNOWN
  // is in live. Sorting + deep-equality gives a readable diff on failure.
  expect([...liveCols].sort()).toEqual([...KNOWN_EVENT_COLUMNS].sort());

  // Axis 2: `KNOWN_EVENT_COLUMNS` == bare-column key set of the
  // `insertBindings` literal in events-writer.ts. The literal is local to
  // `main()` and built from live values, so we parse the source text:
  // grab the `const insertBindings = { ... };` block, strip the `$`
  // prefix from each key, and compare. A new column added to KNOWN that
  // forgets the bindings entry (or vice-versa) lights up here.
  const writerSrc = readFileSync(
    join(ROOT, "plugin", "hooks", "events-writer.ts"),
    "utf8",
  );
  const literalMatch = writerSrc.match(
    /const insertBindings = \{([\s\S]*?)\n {2}\};/,
  );
  expect(literalMatch).not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted above
  const literalBody = literalMatch![1]!;
  // Each binding line looks like `    $col_name: someValue,` (possibly
  // preceded by comments). Match the `$ident:` shape only.
  const bindingKeys = new Set<string>();
  for (const m of literalBody.matchAll(/^\s*\$([a-z_][a-z0-9_]*):/gim)) {
    // biome-ignore lint/style/noNonNullAssertion: capture group always present on match
    bindingKeys.add(m[1]!);
  }
  // Sanity: parser found the expected order-of-magnitude number of keys.
  // Guards against a future refactor that re-shapes the literal in a way
  // the regex no longer recognizes — better to fail loud here than to
  // silently pass with an empty set on both sides.
  expect(bindingKeys.size).toBeGreaterThan(20);
  expect([...bindingKeys].sort()).toEqual([...KNOWN_EVENT_COLUMNS].sort());
});

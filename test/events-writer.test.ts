/**
 * Tests for the events-writer hook's spawn-name capture (fn-545).
 *
 * Two layers:
 * - `nameFromArgs` unit cases — the pure, exported flag parser. All flag forms
 *   (`--name=X` / `--name X` / `-n X`) parse to a single token; flag-boundary
 *   anchoring rejects `--rename`/`--username`; absent/empty → null.
 * - Hook-process integration — drive the real hook as a spawned process whose
 *   PARENT argv carries `--name <session>`, and assert: SessionStart populates
 *   `events.spawn_name`; a non-SessionStart event leaves it NULL; the hook
 *   always exits 0 even when the `ps` scrape can't find a name.
 *
 * The parent-argv carrier is a tiny launcher script (`spawn-launcher.ts`)
 * written into the tmpdir: when run as `bun run spawn-launcher.ts --name <X>`,
 * IT becomes the hook's parent (`process.ppid`), so the hook's
 * `ps -p <ppid> -o args=` scrape sees the `--name` flag exactly as it would
 * under the real arthack-claude launcher.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nameFromArgs,
  parseLinuxStarttime,
  splitArgsLstart,
} from "../plugin/hooks/events-writer";
import { openDb } from "../src/db";
import {
  extractSkillName,
  planVerbRefFromSpawnName,
  slashCommandFromPrompt,
} from "../src/derivers";

const ROOT = join(import.meta.dir, "..");
const HOOK_ENTRY = join(ROOT, "plugin", "hooks", "events-writer.ts");

let tmpDir: string;
let dbPath: string;
let launcherPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-events-writer-test-"));
  dbPath = join(tmpDir, "keeper.db");
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
    env: { ...process.env, KEEPER_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name FROM events WHERE session_id = 'sess-spawn' AND hook_event = 'SessionStart'",
      )
      .get() as { spawn_name: string | null } | null;
    expect(row?.spawn_name).toBe("my-session");
  } finally {
    db.close();
  }
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT start_time FROM events WHERE session_id = 'sess-stime' AND hook_event = 'SessionStart'",
      )
      .get() as { start_time: string | null } | null;
    expect(row?.start_time).not.toBeNull();
    const expectedPrefix =
      process.platform === "darwin"
        ? "darwin:"
        : process.platform === "linux"
          ? "linux:"
          : null;
    if (expectedPrefix !== null) {
      expect(row?.start_time?.startsWith(expectedPrefix)).toBe(true);
      // Body after the prefix is non-empty (24-char lstart / digit jiffies).
      expect(
        (row?.start_time?.slice(expectedPrefix.length) ?? "").length,
      ).toBeGreaterThan(0);
    }
  } finally {
    db.close();
  }
});

test("a non-SessionStart event leaves spawn_name AND start_time NULL", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-ups",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess-ups' AND hook_event = 'UserPromptSubmit'",
      )
      .get() as { spawn_name: string | null; start_time: string | null } | null;
    expect(row?.spawn_name).toBeNull();
    expect(row?.start_time).toBeNull();
  } finally {
    db.close();
  }
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess-noname'",
      )
      .get() as { spawn_name: string | null; start_time: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.spawn_name).toBeNull();
    // start_time should still populate on supported platforms; we don't strand
    // it on the no-name path.
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(row?.start_time).not.toBeNull();
    }
  } finally {
    db.close();
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
      ...process.env,
      KEEPER_DB: dbPath,
      PATH: `${shadowDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess-broken-ps'",
      )
      .get() as { spawn_name: string | null; start_time: string | null } | null;
    expect(row).not.toBeNull();
    if (process.platform === "darwin") {
      // Darwin path: the single ps probe yields BOTH fields, so a broken ps
      // strands both as NULL.
      expect(row?.spawn_name).toBeNull();
      expect(row?.start_time).toBeNull();
    }
  } finally {
    db.close();
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT slash_command, skill_name FROM events WHERE session_id = 'sess-slash'",
      )
      .get() as { slash_command: string | null; skill_name: string | null };
    expect(row.slash_command).toBe("/plan:work");
    expect(row.skill_name).toBeNull();
  } finally {
    db.close();
  }
});

test("hook leaves slash_command NULL on UserPromptSubmit with free-text prompt", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-plain",
    cwd: "/tmp/work",
    prompt: "just a free-text prompt without a leading slash",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT slash_command FROM events WHERE session_id = 'sess-plain'",
      )
      .get() as { slash_command: string | null };
    expect(row.slash_command).toBeNull();
  } finally {
    db.close();
  }
});

test("hook leaves slash_command NULL on UserPromptSubmit with /Users/... path prompt", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-path",
    cwd: "/tmp/work",
    prompt: "/Users/mike/code/keeper",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT slash_command FROM events WHERE session_id = 'sess-path'",
      )
      .get() as { slash_command: string | null };
    expect(row.slash_command).toBeNull();
  } finally {
    db.close();
  }
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT slash_command, skill_name FROM events WHERE session_id = 'sess-skill'",
      )
      .get() as { slash_command: string | null; skill_name: string | null };
    expect(row.slash_command).toBeNull();
    expect(row.skill_name).toBe("plan:plan");
  } finally {
    db.close();
  }
});

test("hook leaves skill_name NULL on PreToolUse + non-Skill tool", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-bash",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT skill_name FROM events WHERE session_id = 'sess-bash'")
      .get() as { skill_name: string | null };
    expect(row.skill_name).toBeNull();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Hook process integration (v14): planctl_* columns end-to-end
// ---------------------------------------------------------------------------

test("hook writes planctl_* columns on PreToolUse:Bash with a planctl mutation command", async () => {
  // Mutation verb on an epic id: subject_present=1, epic_id stamped,
  // task_id NULL (epic-form ref). Mirrors the canonical creator-side
  // invocation shape (`planctl epic-create fn-N-foo "subject"`).
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-planctl-create",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: 'planctl epic-create fn-42-foo "the subject"' },
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
                planctl_subject_present
           FROM events WHERE session_id = 'sess-planctl-create'`,
      )
      .get() as {
      planctl_op: string | null;
      planctl_target: string | null;
      planctl_epic_id: string | null;
      planctl_task_id: string | null;
      planctl_subject_present: number | null;
    };
    expect(row.planctl_op).toBe("epic-create");
    expect(row.planctl_target).toBe("fn-42-foo");
    expect(row.planctl_epic_id).toBe("fn-42-foo");
    expect(row.planctl_task_id).toBeNull();
    expect(row.planctl_subject_present).toBe(1);
  } finally {
    db.close();
  }
});

test("hook writes planctl_* columns on PreToolUse:Bash with a planctl read-only verb on a task ref", async () => {
  // Read-only verb on a task-form ref: subject_present=0, epic_id + task_id
  // both stamped. Exercises the `parsePlanRef` task-form split and the
  // PLANCTL_READONLY_VERBS membership check.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-planctl-cat",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: "planctl cat fn-42-foo.3" },
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
                planctl_subject_present
           FROM events WHERE session_id = 'sess-planctl-cat'`,
      )
      .get() as {
      planctl_op: string | null;
      planctl_target: string | null;
      planctl_epic_id: string | null;
      planctl_task_id: string | null;
      planctl_subject_present: number | null;
    };
    expect(row.planctl_op).toBe("cat");
    expect(row.planctl_target).toBe("fn-42-foo.3");
    expect(row.planctl_epic_id).toBe("fn-42-foo");
    expect(row.planctl_task_id).toBe("fn-42-foo.3");
    expect(row.planctl_subject_present).toBe(0);
  } finally {
    db.close();
  }
});

test("hook leaves planctl_* columns NULL on PreToolUse:Bash with a non-planctl command", async () => {
  // Bash command that is not a planctl invocation — all five planctl_*
  // columns must stay NULL so the partial-index predicate keeps the
  // index small.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-bash-ls",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: "ls -la /tmp" },
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
                planctl_subject_present
           FROM events WHERE session_id = 'sess-bash-ls'`,
      )
      .get() as {
      planctl_op: string | null;
      planctl_target: string | null;
      planctl_epic_id: string | null;
      planctl_task_id: string | null;
      planctl_subject_present: number | null;
    };
    expect(row.planctl_op).toBeNull();
    expect(row.planctl_target).toBeNull();
    expect(row.planctl_epic_id).toBeNull();
    expect(row.planctl_task_id).toBeNull();
    expect(row.planctl_subject_present).toBeNull();
  } finally {
    db.close();
  }
});

test("hook leaves planctl_* columns NULL on non-PreToolUse / non-Bash events", async () => {
  // PostToolUse:Bash with a planctl command still leaves the columns NULL —
  // the deriver is gated on `hookEvent === 'PreToolUse'`.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PostToolUse",
    session_id: "sess-planctl-post",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: "planctl epic-create fn-1-bar" },
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT planctl_op FROM events WHERE session_id = 'sess-planctl-post'",
      )
      .get() as { planctl_op: string | null };
    expect(row.planctl_op).toBeNull();
  } finally {
    db.close();
  }
});

test("hook exits 0 on PreToolUse:Bash with a malformed tool_input.command (defensive)", async () => {
  // Non-string `command` field: the deriver returns null defensively (the
  // hook never throws, exit-0 contract preserved). Asserts via exit code +
  // that the row landed with planctl_op NULL.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "PreToolUse",
    session_id: "sess-planctl-malformed",
    cwd: "/tmp/work",
    tool_name: "Bash",
    tool_input: { command: { not: "a string" } },
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT planctl_op FROM events WHERE session_id = 'sess-planctl-malformed'",
      )
      .get() as { planctl_op: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.planctl_op).toBeNull();
  } finally {
    db.close();
  }
});

test("hook writes jobs.plan_verb/plan_ref via reducer when SessionStart spawn_name matches", async () => {
  // Fire SessionStart whose parent argv carries the canonical spawn name —
  // the hook captures `spawn_name`, the reducer derives plan_verb/plan_ref.
  // We open the writer DB to drive the drain (the readonly handle the other
  // tests use doesn't include the reducer).
  const code = await fireViaLauncher("close::fn-575-osc-parser", {
    hook_event_name: "SessionStart",
    session_id: "sess-close",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  // Drain via the same code path the daemon uses.
  const { db } = openDb(dbPath);
  try {
    const { drainToCompletion } = await import("../src/daemon");
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT tool_use_id FROM events WHERE session_id = 'sess-bash-tuid' AND hook_event = 'PreToolUse'",
      )
      .get() as { tool_use_id: string | null } | null;
    expect(row?.tool_use_id).toBe("toolu_01ABCDEF");
  } finally {
    db.close();
  }
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT tool_use_id, subagent_agent_id FROM events WHERE session_id = 'sess-agent-tuid' AND hook_event = 'PostToolUse'",
      )
      .get() as {
      tool_use_id: string | null;
      subagent_agent_id: string | null;
    } | null;
    expect(row?.tool_use_id).toBe("toolu_AGENT_42");
    // Cross-check: extractSubagentAgentId still stamps the existing bridge
    // column on the same row (the two derivers are independent).
    expect(row?.subagent_agent_id).toBe("agent-xyz");
  } finally {
    db.close();
  }
});

test("An event without tool_use_id leaves events.tool_use_id NULL", async () => {
  // SessionStart / UserPromptSubmit / Notification payloads don't carry
  // tool_use_id; the column stays NULL so the partial-index
  // `WHERE tool_use_id IS NOT NULL` predicate keeps the index selective.
  const code = await fireViaLauncher("any-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-ups-notuid",
    cwd: "/tmp",
    prompt: "hi",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT tool_use_id FROM events WHERE session_id = 'sess-ups-notuid'",
      )
      .get() as { tool_use_id: string | null } | null;
    expect(row?.tool_use_id).toBeNull();
  } finally {
    db.close();
  }
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

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT tool_use_id FROM events WHERE session_id = 'sess-bad-tuid'",
      )
      .get() as { tool_use_id: string | null } | null;
    expect(row?.tool_use_id).toBeNull();
  } finally {
    db.close();
  }
});

/**
 * Tests for the events-writer hook — fully pure, in-process, no subprocess.
 *
 * fn-736 made the hook a per-pid NDJSON appender (no SQLite open). Its only
 * non-pure step is the SessionStart `ps`/`/proc` spawn-info scrape, which `main`
 * does and INJECTS into the pure `buildEventBindings` record builder. So the
 * whole record-build + exit-0-contract surface is exercised by calling
 * `buildEventBindings` directly over constructed payloads — the gating
 * (event_type rename, SessionStart-only spawn/config capture), the deriver
 * wiring (slash_command / skill_name / plan_* / tool_use_id / subagent_agent_id
 * / backend_exec_*), the full-column round-trip, and totality on malformed
 * input (the in-process proxy for "the hook can never throw past its outer
 * exit-0 guard").
 *
 * Two layers:
 * - the pure exported derivers / flag parsers (`nameFromArgs`,
 *   `splitArgsLstart`, `parseLinuxStarttime`, `configDirFromEnv`,
 *   `backendExecCoordsFromEnv`, plus the `src/derivers` helpers the hook lifts);
 * - the pure record builder `buildEventBindings` over payload shapes the hook
 *   would receive.
 */

import { expect, test } from "bun:test";
import {
  accountRouteFromEnv,
  backendExecCoordsFromEnv,
  buildEventBindings,
  configDirFromEnv,
  dispatchAttemptFromEnv,
  KNOWN_EVENT_COLUMNS,
  nameFromArgs,
  parseLinuxStarttime,
  type SpawnInfo,
  splitArgsLstart,
  worktreeBranchFromEnv,
} from "../plugins/keeper/plugin/hooks/events-writer";
import type { DeadLetterBindings } from "../src/dead-letter";
import {
  extractSkillName,
  extractToolUseId,
  planVerbRefFromSpawnName,
  slashCommandFromPrompt,
} from "../src/derivers";
import { freshMemDb } from "./helpers/template-db";

const NO_SPAWN: SpawnInfo = { name: null, startTime: null };
const TS = 1_700_000_000;
const PID = 4242;

/**
 * Call `buildEventBindings` with sensible defaults, asserting a non-null
 * result. Inject `raw` / `env` / `spawnInfo` / `ts` / `pid` as needed; `raw`
 * defaults to the JSON encoding of `data` (the hook stores stdin verbatim).
 */
function build(
  data: Record<string, unknown>,
  opts: {
    raw?: string;
    pid?: number;
    env?: NodeJS.ProcessEnv;
    spawnInfo?: SpawnInfo;
    ts?: number;
  } = {},
): DeadLetterBindings {
  const raw = opts.raw ?? JSON.stringify(data);
  const b = buildEventBindings(
    data,
    raw,
    opts.pid ?? PID,
    opts.env ?? {},
    opts.spawnInfo ?? NO_SPAWN,
    opts.ts ?? TS,
  );
  if (b === null) throw new Error("expected bindings, got null");
  return b;
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
// Record build — SessionStart spawn-info gating (buildEventBindings)
// ---------------------------------------------------------------------------

test("SessionStart stamps the injected spawn name + start_time", () => {
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-spawn", cwd: "/w" },
    { spawnInfo: { name: "my-session", startTime: "darwin:Sat May 23 ..." } },
  );
  expect(b.spawn_name).toBe("my-session");
  expect(b.start_time).toBe("darwin:Sat May 23 ...");
});

test("a non-SessionStart event drops spawn_name AND start_time even when scraped", () => {
  // The SessionStart gate is re-applied inside the pure builder: a stray spawn
  // probe result on a non-SessionStart event can never leak onto the row.
  const b = build(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-ups", cwd: "/w" },
    { spawnInfo: { name: "leaked", startTime: "linux:123" } },
  );
  expect(b.spawn_name).toBeNull();
  expect(b.start_time).toBeNull();
});

test("SessionStart with a null spawn probe builds the row with NULL spawn fields", () => {
  // The probe returns `{null, null}` on any failure (no --name, wedged ps);
  // the builder still produces a complete row — never throws, exit-0 proxy.
  const b = build({
    hook_event_name: "SessionStart",
    session_id: "sess-noname",
    cwd: "/w",
  });
  expect(b.spawn_name).toBeNull();
  expect(b.start_time).toBeNull();
  expect(b.event_type).toBe("session_start");
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

test("planVerbRefFromSpawnName: resolve::<epic> → {resolve, epic-id} (fn-1088 merge-resolver key)", () => {
  // The daemon merge-resolver dispatches `resolve::<epic>`; folding its
  // plan_verb/plan_ref makes it a first-class dispatch key so reaps + the
  // instant-death breaker apply to it like any work/close worker.
  expect(
    planVerbRefFromSpawnName("resolve::fn-1088-merge-resolver-worker"),
  ).toEqual({
    plan_verb: "resolve",
    plan_ref: "fn-1088-merge-resolver-worker",
  });
});

test("planVerbRefFromSpawnName: unblock::<task> → {unblock, task-id} (escalation dispatch key)", () => {
  // `unblock::<task>` is one of the two autonomous escalation dispatches; folding
  // its plan_verb/plan_ref makes it a first-class dispatch key so reaps + the
  // instant-death breaker apply to it like any work/close/resolve worker.
  expect(planVerbRefFromSpawnName("unblock::fn-1129-escalate.2")).toEqual({
    plan_verb: "unblock",
    plan_ref: "fn-1129-escalate.2",
  });
});

test("planVerbRefFromSpawnName: deconflict::<epic> → {deconflict, epic-id} (escalation dispatch key)", () => {
  expect(planVerbRefFromSpawnName("deconflict::fn-1129-escalate")).toEqual({
    plan_verb: "deconflict",
    plan_ref: "fn-1129-escalate",
  });
});

test("fn-756: approve::<epic-task> → {null, null} (approve dropped from the whitelist)", () => {
  // fn-756 removed `approve` from the locked verb whitelist along with the
  // verb. A stale `approve::` spawn name (from before the deploy) no longer
  // parses to a `{verb, ref}` pair — it falls through to {null, null} like any
  // other non-whitelisted verb.
  expect(planVerbRefFromSpawnName("approve::fn-619-pin-foo.1")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("fn-756: approve::<epic> → {null, null} (approve dropped from the whitelist)", () => {
  expect(planVerbRefFromSpawnName("approve::fn-619-pin-foo")).toEqual({
    plan_verb: null,
    plan_ref: null,
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
// Record build — event_type rename + deriver wiring (buildEventBindings)
// ---------------------------------------------------------------------------

test("event_type renames the named events and snake-cases the rest", () => {
  expect(build({ hook_event_name: "SessionStart" }).event_type).toBe(
    "session_start",
  );
  expect(build({ hook_event_name: "PostToolUse" }).event_type).toBe("tool_use");
  expect(build({ hook_event_name: "Stop" }).event_type).toBe("stop");
  expect(build({ hook_event_name: "PreToolUse" }).event_type).toBe(
    "pre_tool_use",
  );
  expect(build({ hook_event_name: "UserPromptSubmit" }).event_type).toBe(
    "user_prompt_submit",
  );
});

test("Notification event_type uses the notification_type subtype", () => {
  expect(
    build({ hook_event_name: "Notification", notification_type: "permission" })
      .event_type,
  ).toBe("permission");
});

test("an empty hook_event_name yields no row (null)", () => {
  expect(
    buildEventBindings({ session_id: "x" }, "{}", PID, {}, NO_SPAWN, TS),
  ).toBeNull();
});

test("session_id falls back to 'unknown' when absent; data carries raw verbatim", () => {
  const raw = '{"hook_event_name":"Stop","extra":1}';
  const b = build({ hook_event_name: "Stop" }, { raw });
  expect(b.session_id).toBe("unknown");
  expect(b.data).toBe(raw);
});

test("stop_hook_active is 0/1 on Stop, NULL elsewhere", () => {
  expect(
    build({ hook_event_name: "Stop", stop_hook_active: true }).stop_hook_active,
  ).toBe(1);
  expect(
    build({ hook_event_name: "Stop", stop_hook_active: false })
      .stop_hook_active,
  ).toBe(0);
  expect(
    build({ hook_event_name: "PreToolUse", stop_hook_active: true })
      .stop_hook_active,
  ).toBeNull();
});

test("slash_command stamps on UserPromptSubmit /plan:work; skill_name stays NULL", () => {
  const b = build({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-slash",
    prompt: "/plan:work fn-575-osc-parser.3",
  });
  expect(b.slash_command).toBe("/plan:work");
  expect(b.skill_name).toBeNull();
});

test("slash_command stays NULL for a free-text UserPromptSubmit prompt", () => {
  expect(
    build({ hook_event_name: "UserPromptSubmit", prompt: "no leading slash" })
      .slash_command,
  ).toBeNull();
});

test("skill_name stamps on PreToolUse + Skill; slash_command stays NULL", () => {
  const b = build({
    hook_event_name: "PreToolUse",
    session_id: "sess-skill",
    tool_name: "Skill",
    tool_input: { skill: "plan:plan", args: "..." },
  });
  expect(b.slash_command).toBeNull();
  expect(b.skill_name).toBe("plan:plan");
});

test("skill_name stays NULL on a PreToolUse non-Skill tool", () => {
  expect(
    build({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    }).skill_name,
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// Record build — plan_* columns (buildEventBindings)
// ---------------------------------------------------------------------------

test("plan_* columns stamp on PostToolUse:Bash with an epic-form envelope", () => {
  // Mutation verb on an epic id: subject_present=1, epic_id stamped, task_id
  // NULL (epic-form ref). The envelope (top-level `plan_invocation` key in
  // tool_response.stdout) is what `keeper plan epic-create` actually emits.
  const stdout = JSON.stringify({
    plan_invocation: {
      op: "epic-create",
      target: "fn-42-foo",
      subject: "the subject",
    },
  });
  const b = build({
    hook_event_name: "PostToolUse",
    session_id: "sess-plan-create",
    tool_name: "Bash",
    tool_input: { command: 'keeper plan epic-create fn-42-foo "the subject"' },
    tool_response: { stdout },
  });
  expect(b.plan_op).toBe("epic-create");
  expect(b.plan_target).toBe("fn-42-foo");
  expect(b.plan_epic_id).toBe("fn-42-foo");
  expect(b.plan_task_id).toBeNull();
  expect(b.plan_subject_present).toBe(1);
});

test("plan_* columns split a task-form ref into epic_id + task_id", () => {
  const stdout = JSON.stringify({
    plan_invocation: { op: "cat", target: "fn-42-foo.3", subject: null },
  });
  const b = build({
    hook_event_name: "PostToolUse",
    session_id: "sess-plan-cat",
    tool_name: "Bash",
    tool_input: { command: "keeper plan cat fn-42-foo.3" },
    tool_response: { stdout },
  });
  expect(b.plan_op).toBe("cat");
  expect(b.plan_epic_id).toBe("fn-42-foo");
  expect(b.plan_task_id).toBe("fn-42-foo.3");
  expect(b.plan_subject_present).toBe(0);
});

test("plan_* columns stay NULL when stdout carries no envelope", () => {
  const b = build({
    hook_event_name: "PostToolUse",
    session_id: "sess-plain",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: { stdout: "drwxr-xr-x  ... /tmp\n" },
  });
  expect(b.plan_op).toBeNull();
  expect(b.plan_epic_id).toBeNull();
  expect(b.plan_subject_present).toBeNull();
});

test("a malformed tool_response.stdout builds a complete row (totality / exit-0 proxy)", () => {
  // Non-string `stdout`: the deriver returns null defensively — the builder
  // never throws (the in-process proxy for the hook's exit-0 contract).
  const b = build({
    hook_event_name: "PostToolUse",
    session_id: "sess-plan-malformed",
    tool_name: "Bash",
    tool_input: { command: "keeper plan epic-create fn-1-bar" },
    tool_response: { stdout: { not: "a string" } },
  });
  expect(b.plan_op).toBeNull();
});

// ---------------------------------------------------------------------------
// Record build — tool_use_id + subagent_agent_id (buildEventBindings)
// ---------------------------------------------------------------------------

test("tool_use_id rides through verbatim on any event carrying it", () => {
  // No event-name / tool-name gate: the field is lifted whenever present.
  const b = build({
    hook_event_name: "PreToolUse",
    session_id: "sess-bash-tuid",
    tool_name: "Bash",
    tool_use_id: "toolu_01ABCDEF",
    tool_input: { command: "echo hello" },
  });
  expect(b.tool_use_id).toBe("toolu_01ABCDEF");
});

test("PostToolUse:Agent stamps tool_use_id AND the subagent_agent_id bridge", () => {
  // The two derivers are independent: tool_use_id correlates Pre/Post-Agent,
  // subagent_agent_id bridges to SubagentStart/Stop.
  const b = build({
    hook_event_name: "PostToolUse",
    session_id: "sess-agent-tuid",
    tool_name: "Agent",
    tool_use_id: "toolu_AGENT_42",
    tool_response: { agentId: "agent-xyz" },
  });
  expect(b.tool_use_id).toBe("toolu_AGENT_42");
  expect(b.subagent_agent_id).toBe("agent-xyz");
});

test("a non-string tool_use_id lands NULL (totality / exit-0 proxy)", () => {
  const b = build({
    hook_event_name: "PreToolUse",
    session_id: "sess-bad-tuid",
    tool_name: "Read",
    tool_use_id: 42,
    tool_input: { file_path: "/x" },
  });
  expect(b.tool_use_id).toBeNull();
});

// The pure deriver internals (`extractToolUseId` shape gate) are exhaustively
// covered in derivers.test.ts; this one no-field case pins the selective-index
// contract — a payload without the field yields null.
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
// worktreeBranchFromEnv unit (v94 — KEEPER_PLAN_WORKTREE_BRANCH capture)
// ---------------------------------------------------------------------------

test("worktreeBranchFromEnv: a populated branch passes through verbatim (no normalization)", () => {
  expect(
    worktreeBranchFromEnv({
      KEEPER_PLAN_WORKTREE_BRANCH: "keeper/epic/fn-986--fn-986.2",
    }),
  ).toBe("keeper/epic/fn-986--fn-986.2");
});

test("worktreeBranchFromEnv: undefined / empty / whitespace-only collapse to null", () => {
  // The env is ALWAYS emitted (empty on serial launches), so the empty and
  // whitespace shapes must collapse to the same absent value COALESCE treats
  // uniformly — never an empty-bracket pill.
  expect(worktreeBranchFromEnv({})).toBeNull();
  expect(worktreeBranchFromEnv({ KEEPER_PLAN_WORKTREE_BRANCH: "" })).toBeNull();
  expect(
    worktreeBranchFromEnv({ KEEPER_PLAN_WORKTREE_BRANCH: "   " }),
  ).toBeNull();
});

test("worktreeBranchFromEnv: a trailing slash is NOT stripped (canonical ref, recorded verbatim)", () => {
  // Unlike config_dir, the branch is a canonical git ref — no slash trimming, so
  // the fold reads back exactly what launch context froze (re-fold determinism).
  expect(
    worktreeBranchFromEnv({ KEEPER_PLAN_WORKTREE_BRANCH: "keeper/epic/fn-1/" }),
  ).toBe("keeper/epic/fn-1/");
});

// ---------------------------------------------------------------------------
// accountRouteFromEnv unit (schema v119 / fn-1239.3 — KEEPER_ACCOUNT_ROUTE)
// ---------------------------------------------------------------------------

test("accountRouteFromEnv: the native default route passes through", () => {
  expect(accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: "default" })).toBe(
    "default",
  );
});

test("accountRouteFromEnv: a managed claude-swap slot passes through", () => {
  expect(accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: "claude-swap:7" })).toBe(
    "claude-swap:7",
  );
});

test("accountRouteFromEnv: undefined / empty collapse to null (launcher supplied none)", () => {
  expect(accountRouteFromEnv({})).toBeNull();
  expect(accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: "" })).toBeNull();
});

test("accountRouteFromEnv: an unrecognized shape is rejected to null (PII-free by construction)", () => {
  // The value is untrusted env — only the two known PII-free shapes survive, so
  // a path/email/arbitrary string can never be persisted as a route id.
  expect(
    accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: "user@example.com" }),
  ).toBeNull();
  expect(
    accountRouteFromEnv({
      KEEPER_ACCOUNT_ROUTE: "/Users/x/.claude-profiles/multi-claude-3",
    }),
  ).toBeNull();
  // A slot must be all digits — a non-numeric slot is not a valid route id.
  expect(
    accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: "claude-swap:abc" }),
  ).toBeNull();
  // `default` must match exactly — no leading/trailing decoration.
  expect(accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: "default " })).toBeNull();
});

test("accountRouteFromEnv: an over-long value is rejected to null (size-bounded)", () => {
  const huge = `claude-swap:${"9".repeat(200)}`;
  expect(accountRouteFromEnv({ KEEPER_ACCOUNT_ROUTE: huge })).toBeNull();
});

test("dispatch attempt carrier is bounded and enriches only SessionStart data", () => {
  expect(dispatchAttemptFromEnv({ KEEPER_DISPATCH_ATTEMPT_ID: "42" })).toBe(42);
  for (const raw of ["", "0", "-1", "1;rm", "9".repeat(40)]) {
    expect(
      dispatchAttemptFromEnv({ KEEPER_DISPATCH_ATTEMPT_ID: raw }),
    ).toBeNull();
  }
  const start = build(
    { hook_event_name: "SessionStart", session_id: "s" },
    { env: { KEEPER_DISPATCH_ATTEMPT_ID: "42" } },
  );
  expect(JSON.parse(start.data as string).dispatch_attempt_id).toBe(42);
  const prompt = build(
    { hook_event_name: "UserPromptSubmit", session_id: "s" },
    { env: { KEEPER_DISPATCH_ATTEMPT_ID: "42" } },
  );
  expect(JSON.parse(prompt.data as string).dispatch_attempt_id).toBeUndefined();
});

// ---------------------------------------------------------------------------
// backendExecCoordsFromEnv unit (schema v48 / fn-668 — every-event capture)
// ---------------------------------------------------------------------------

test("backendExecCoordsFromEnv: no sentinel returns all-NULL", () => {
  // Outside tmux (the typical case for any Claude session not launched under
  // the multiplexer) every coord stays NULL — never stamp a bogus `type`.
  expect(backendExecCoordsFromEnv({})).toEqual({
    type: null,
    sessionId: null,
    paneId: null,
  });
});

test("backendExecCoordsFromEnv: empty TMUX sentinel collapses to all-NULL", () => {
  // Empty-string env is the same shape as absent — both collapse so the
  // reducer's COALESCE arm can't be clobbered by an empty stamp.
  expect(
    backendExecCoordsFromEnv({
      TMUX: "",
      TMUX_PANE: "%7",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual({ type: null, sessionId: null, paneId: null });
});

test("backendExecCoordsFromEnv: ZELLIJ env without TMUX is ignored → all-NULL", () => {
  // tmux is the sole backend: the bare `ZELLIJ` sentinel (and its sub-vars) is
  // no longer read, so a Claude in a zellij-only pane stamps no coords.
  expect(
    backendExecCoordsFromEnv({
      ZELLIJ: "0",
      ZELLIJ_SESSION_NAME: "mike-main",
      ZELLIJ_PANE_ID: "11",
    }),
  ).toEqual({ type: null, sessionId: null, paneId: null });
});

test("backendExecCoordsFromEnv: empty sub-var collapses to NULL while sentinel + the other sub-var stay populated", () => {
  // Partial capture: type fires (so the reducer's gate triggers the
  // COALESCE) but the NULL sub-var preserves the prior captured value.
  expect(
    backendExecCoordsFromEnv({
      TMUX: "/tmp/tmux-501/default,12345,0",
      KEEPER_TMUX_SESSION: "",
      TMUX_PANE: "%7",
    }),
  ).toEqual({ type: "tmux", sessionId: null, paneId: "%7" });
});

test("backendExecCoordsFromEnv: TMUX sentinel + KEEPER_TMUX_SESSION stamps type='tmux', session, and pane", () => {
  // Managed launch: keeper injects KEEPER_TMUX_SESSION via `-e`, so the
  // session name stamps alongside type + pane.
  expect(
    backendExecCoordsFromEnv({
      TMUX: "/tmp/tmux-501/default,12345,0",
      TMUX_PANE: "%7",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual({ type: "tmux", sessionId: "autopilot", paneId: "%7" });
});

test("backendExecCoordsFromEnv: TMUX sentinel without KEEPER_TMUX_SESSION → type + pane, NULL session", () => {
  // Human-created tmux session carries no KEEPER_TMUX_SESSION — the session
  // stays NULL (the snapshot poller fills it later) while type + pane stamp.
  expect(
    backendExecCoordsFromEnv({
      TMUX: "/tmp/tmux-501/default,12345,0",
      TMUX_PANE: "%3",
    }),
  ).toEqual({ type: "tmux", sessionId: null, paneId: "%3" });
});

test("backendExecCoordsFromEnv: foreign tmux sockets stamp no coords", () => {
  expect(
    backendExecCoordsFromEnv({
      TMUX: "/tmp/tmux-501/jobsearch,12345,0",
      TMUX_PANE: "%3",
      KEEPER_TMUX_SESSION: "work",
    }),
  ).toEqual({ type: null, sessionId: null, paneId: null });
});

test("backendExecCoordsFromEnv: empty TMUX sentinel collapses to all-NULL", () => {
  // Empty-string sentinel is the absent shape — no tmux stamp.
  expect(
    backendExecCoordsFromEnv({
      TMUX: "",
      TMUX_PANE: "%3",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual({ type: null, sessionId: null, paneId: null });
});

test("backendExecCoordsFromEnv: TMUX governs even when stray ZELLIJ env is present", () => {
  // tmux is the sole backend: a leftover `ZELLIJ` sentinel is ignored entirely,
  // and the tmux coords are the ones stamped.
  expect(
    backendExecCoordsFromEnv({
      ZELLIJ: "0",
      ZELLIJ_SESSION_NAME: "mike-main",
      ZELLIJ_PANE_ID: "11",
      TMUX: "/tmp/tmux-501/default,12345,0",
      TMUX_PANE: "%7",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual({ type: "tmux", sessionId: "autopilot", paneId: "%7" });
});

test("backendExecCoordsFromEnv: tmux pane id passes through as raw TEXT", () => {
  const got = backendExecCoordsFromEnv({
    TMUX: "/tmp/tmux-501/default,12345,0",
    TMUX_PANE: "%42",
    KEEPER_TMUX_SESSION: "autopilot",
  });
  expect(got.paneId).toBe("%42");
  expect(typeof got.paneId).toBe("string");
});

// ---------------------------------------------------------------------------
// backendExecCoordsFromEnv carrier fallback (fn-815 — keeper agent strips TMUX
// to let Claude emit truecolor and copies the pane id into KEEPER_TMUX_PANE; the
// fallback arm stamps coord-identical tmux rows from the carrier).
// ---------------------------------------------------------------------------

test("backendExecCoordsFromEnv: carrier present + TMUX absent stamps coord-identical tmux row", () => {
  // keeper agent deleted TMUX/TMUX_PANE (truecolor) but copied the pane id into
  // KEEPER_TMUX_PANE first. The fallback arm stamps the same {type, paneId,
  // sessionId} the native arm would have, so window renaming survives.
  expect(
    backendExecCoordsFromEnv({
      KEEPER_TMUX_PANE: "%7",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual({ type: "tmux", sessionId: "autopilot", paneId: "%7" });
});

test("backendExecCoordsFromEnv: carrier present without KEEPER_TMUX_SESSION → type + pane, NULL session", () => {
  // Human-created tmux session relaunched under keeper agent: no
  // KEEPER_TMUX_SESSION, so the session stays NULL (poller fills it) while the
  // carrier still supplies type + pane.
  expect(backendExecCoordsFromEnv({ KEEPER_TMUX_PANE: "%3" })).toEqual({
    type: "tmux",
    sessionId: null,
    paneId: "%3",
  });
});

test("backendExecCoordsFromEnv: empty carrier + TMUX absent → all-NULL, no tmux stamp", () => {
  // The carrier is a hint, not proof of a live pane: an empty value collapses
  // to NULL and falls through to all-NULL — never a type=tmux row with a NULL
  // pane (the renamer filter requires a non-null pane id).
  expect(
    backendExecCoordsFromEnv({
      KEEPER_TMUX_PANE: "",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual({ type: null, sessionId: null, paneId: null });
});

test("backendExecCoordsFromEnv: native TMUX wins when both TMUX and carrier present (coord-identical)", () => {
  // Both present (an existing native tmux pane carrying a stray carrier): the
  // native arm fires first and is byte-unchanged, and the result is identical
  // to the carrier-fed fallback for the same coords.
  const both = backendExecCoordsFromEnv({
    TMUX: "/tmp/tmux-501/default,12345,0",
    TMUX_PANE: "%9",
    KEEPER_TMUX_PANE: "%999",
    KEEPER_TMUX_SESSION: "autopilot",
  });
  expect(both).toEqual({ type: "tmux", sessionId: "autopilot", paneId: "%9" });
  // The native value, never the carrier, is the one stamped.
  expect(both.paneId).toBe("%9");
  // Coord-identical to the carrier fallback when the carrier holds the SAME
  // pane id the native arm would have read — the renamer-worker equivalence.
  expect(
    backendExecCoordsFromEnv({
      KEEPER_TMUX_PANE: "%9",
      KEEPER_TMUX_SESSION: "autopilot",
    }),
  ).toEqual(both);
});

// ---------------------------------------------------------------------------
// Record build — config_dir SessionStart capture + gate (buildEventBindings)
// ---------------------------------------------------------------------------

test("SessionStart stamps config_dir from CLAUDE_CONFIG_DIR (normalized)", () => {
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-cfg-set" },
    { env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-profiles/profile-a/" } },
  );
  // The trailing slash is normalized away by `configDirFromEnv`.
  expect(b.config_dir).toBe("/Users/x/.claude-profiles/profile-a");
});

test("a non-SessionStart event leaves config_dir NULL even when the env is set", () => {
  // Locked design: env-capture is SessionStart-gated, same as spawn_name /
  // start_time. A UserPromptSubmit row never carries the env value.
  const b = build(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-cfg-ups" },
    { env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-profiles/profile-c" } },
  );
  expect(b.config_dir).toBeNull();
});

test("SessionStart stamps worktree from KEEPER_PLAN_WORKTREE_BRANCH (verbatim)", () => {
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-wt-set" },
    { env: { KEEPER_PLAN_WORKTREE_BRANCH: "keeper/epic/fn-986--fn-986.2" } },
  );
  expect(b.worktree).toBe("keeper/epic/fn-986--fn-986.2");
});

test("a non-SessionStart event leaves worktree NULL even when the env is set", () => {
  // SessionStart-gated, same as config_dir — a resume's later hook events never
  // re-stamp the durable marker.
  const b = build(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-wt-ups" },
    { env: { KEEPER_PLAN_WORKTREE_BRANCH: "keeper/epic/fn-986" } },
  );
  expect(b.worktree).toBeNull();
});

test("SessionStart with an empty KEEPER_PLAN_WORKTREE_BRANCH (serial launch) folds worktree NULL", () => {
  // The serial / OFF launch always emits the env EMPTY (the stale-leak guard) —
  // it must collapse to NULL, identical to unset, so a serial job carries no marker.
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-wt-serial" },
    { env: { KEEPER_PLAN_WORKTREE_BRANCH: "" } },
  );
  expect(b.worktree).toBeNull();
});

// ---------------------------------------------------------------------------
// Record build — account_route SessionStart capture + gate (buildEventBindings)
// ---------------------------------------------------------------------------

test("SessionStart stamps account_route from KEEPER_ACCOUNT_ROUTE (managed slot)", () => {
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-route-managed" },
    { env: { KEEPER_ACCOUNT_ROUTE: "claude-swap:3" } },
  );
  expect(b.account_route).toBe("claude-swap:3");
});

test("SessionStart with a malformed KEEPER_ACCOUNT_ROUTE folds account_route NULL (bounded at capture)", () => {
  // The untrusted env value is shape-bounded HERE, so a hostile string never
  // reaches the fold — the row carries NULL, not the raw value.
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-route-bad" },
    { env: { KEEPER_ACCOUNT_ROUTE: "notimpossiblemike@gmail.com" } },
  );
  expect(b.account_route).toBeNull();
});

test("SessionStart with no KEEPER_ACCOUNT_ROUTE leaves account_route NULL (launcher supplied none)", () => {
  const b = build({
    hook_event_name: "SessionStart",
    session_id: "sess-route-absent",
  });
  expect(b.account_route).toBeNull();
});

test("a non-SessionStart event leaves account_route NULL even when the env is set (SessionStart-gated, mirrors config_dir)", () => {
  const b = build(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-route-ups" },
    { env: { KEEPER_ACCOUNT_ROUTE: "default" } },
  );
  expect(b.account_route).toBeNull();
});

// ---------------------------------------------------------------------------
// Record build — harness stamp (buildEventBindings) — fn-1103 task .3
// ---------------------------------------------------------------------------

test("SessionStart stamps harness 'claude' (this hook only ever fires for claude)", () => {
  const b = build({ hook_event_name: "SessionStart", session_id: "sess-h" });
  expect(b.harness).toBe("claude");
  // resume_target stays NULL from the hook — claude resumes by session id; the
  // column is an older-producer back-fill channel, populated daemon-side.
  expect(b.resume_target).toBeNull();
});

test("a non-SessionStart event leaves harness NULL (SessionStart-gated, mirrors worktree)", () => {
  const b = build({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-h-ups",
  });
  expect(b.harness).toBeNull();
  expect(b.resume_target).toBeNull();
});

// ---------------------------------------------------------------------------
// Record build — backend-exec coords stamped on EVERY event (buildEventBindings)
// ---------------------------------------------------------------------------

test("backend_exec_* columns stamp from the injected env on a non-SessionStart event", () => {
  // Unlike config_dir/spawn, backend-exec coords are captured on every event.
  const b = build(
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-tmux",
      tool_name: "Bash",
    },
    {
      env: {
        TMUX: "/tmp/tmux-501/default,12345,0",
        TMUX_PANE: "%7",
        KEEPER_TMUX_SESSION: "autopilot",
      },
    },
  );
  expect(b.backend_exec_type).toBe("tmux");
  expect(b.backend_exec_session_id).toBe("autopilot");
  expect(b.backend_exec_pane_id).toBe("%7");
});

// ---------------------------------------------------------------------------
// Record build — full-column round-trip + LOCKSTEP triple-pin
// ---------------------------------------------------------------------------
//
// fn-736 made the hook a per-pid NDJSON appender; the column-intersection
// degrade moved daemon-side (the ingester `scanEventsLogDir` intersects
// bindings ∩ live columns post-migrate, race-free — covered by
// test/events-ingest-worker.test.ts). The hook side owes only: the built record
// carries EVERY known column, and the three hand-maintained column lists stay
// in lockstep. The events-log/dead-letter APPEND-failure routing is a pure I/O
// concern left to production (the hook's outer guard keeps it exit-0).

test("the built record carries every known column binding", () => {
  // A SessionStart row: attributable columns carry real values, siblings are
  // present-with-NULL. A regression dropping a column from the builder (which
  // would silently never reach the ingester's INSERT) shows up here. The
  // dead-letter recovery path reads the SAME map, so the SessionStart-scraped
  // fields (`spawn_name`/`start_time`/`config_dir`) being present-as-keys is
  // what makes a failed append recoverable.
  const b = build(
    { hook_event_name: "SessionStart", session_id: "sess-fullcols" },
    {
      spawnInfo: { name: "happy-session", startTime: "darwin:..." },
      env: { CLAUDE_CONFIG_DIR: "/p" },
    },
  );
  for (const col of KNOWN_EVENT_COLUMNS) {
    expect(col in b).toBe(true);
  }
  expect(b.hook_event).toBe("SessionStart");
  expect(b.event_type).toBe("session_start");
  expect(b.spawn_name).toBe("happy-session");
  expect("start_time" in b).toBe(true);
  expect("config_dir" in b).toBe(true);
});

test("LOCKSTEP: KNOWN_EVENT_COLUMNS == events table columns == built record keys", () => {
  // Three hand-maintained lists must stay in lockstep: `KNOWN_EVENT_COLUMNS`
  // and the `buildEventBindings` map (both in events-writer.ts), and
  // `CREATE_EVENTS` (src/db.ts). A new column added to one without the others
  // lights up here.

  // Axis 1: live migrated DB's `events` columns (minus the auto-`id` PK) ==
  // KNOWN_EVENT_COLUMNS. `freshMemDb()` migrates an in-memory DB in-process —
  // no daemon, no on-disk file.
  const kdb = freshMemDb();
  let liveCols: Set<string>;
  try {
    const rows = kdb.db.prepare("PRAGMA table_info('events')").all() as {
      name: string;
    }[];
    liveCols = new Set(rows.map((r) => r.name).filter((n) => n !== "id"));
  } finally {
    kdb.db.close();
  }
  expect([...liveCols].sort()).toEqual([...KNOWN_EVENT_COLUMNS].sort());

  // Axis 2: the built record's key set == KNOWN_EVENT_COLUMNS. Calling the
  // builder beats parsing source text — the keys ARE the on-disk column names.
  const built = build({ hook_event_name: "SessionStart", session_id: "x" });
  expect(Object.keys(built).sort()).toEqual([...KNOWN_EVENT_COLUMNS].sort());
});

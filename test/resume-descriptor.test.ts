/**
 * Pure-helper tests for `src/resume-descriptor.ts` (epic fn-677, T1). The
 * three exports — `resumeTarget`, `buildResumeCommand`, `tierForJobFromEpics` —
 * are pure: no daemon, no UDS, no fs. We drive each shape directly with
 * fixture `Job` / `Epic` objects shaped to match the real projection types.
 *
 * Also covers `resolveRestorePath` from `src/db.ts`: env-override wins,
 * default is the DB-sibling path, calling it does no I/O.
 */

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRestorePath } from "../src/db";
import {
  buildResumeCommand,
  buildResumeLaunchForm,
  resumeTarget,
  tierForJobFromEpics,
} from "../src/resume-descriptor";
import type { Epic, Job, Task } from "../src/types";

/**
 * Minimal `Job` factory — the resume-descriptor helpers read only `job_id`,
 * `title`, `plan_verb`, `plan_ref`, so we cast a partial fixture rather than
 * fabricate every projection field.
 */
function fixtureJob(overrides: Partial<Job>): Job {
  return overrides as Job;
}

function fixtureEpic(overrides: Partial<Epic>): Epic {
  return overrides as Epic;
}

function fixtureTask(overrides: Partial<Task>): Task {
  return overrides as Task;
}

test("resumeTarget returns the latest session name, preferring the title over the job_id", () => {
  // Resume by the latest name keeper knows: `title` tracks name_history's newest
  // entry, resolved live from the jobs projection at resume time (never a frozen
  // name), so `claude --resume "<name>"` re-attaches to the right session.
  const job = fixtureJob({ job_id: "sess-123", title: "fn-677.1 worker" });
  expect(resumeTarget(job)).toBe("fn-677.1 worker");
});

test("resumeTarget falls back to the job_id when the job has no name", () => {
  const job = fixtureJob({ job_id: "sess-123", title: null });
  expect(resumeTarget(job)).toBe("sess-123");
});

test("resumeTarget coerces a fully-degenerate (no name, no id) job to the empty string", () => {
  // The producer invariant says job_id is always present; a degenerate row with
  // neither name nor id coerces to "" (never NaN/undefined leaking into argv).
  expect(resumeTarget(fixtureJob({ job_id: "", title: null }))).toBe("");
});

test("buildResumeCommand emits cd + claude --resume with a quoted target", () => {
  const cmd = buildResumeCommand("/Users/mike/code/keeper", "fn-677.1", null);
  expect(cmd).toBe(
    'cd /Users/mike/code/keeper && claude --resume "fn-677.1" --agentwrap-no-confirm',
  );
});

test("buildResumeCommand drops cd prefix on an empty cwd", () => {
  const cmd = buildResumeCommand("", "sess-abc", null);
  expect(cmd).toBe('claude --resume "sess-abc" --agentwrap-no-confirm');
});

test("buildResumeCommand never inserts --plugin-dir, even for a non-null tier (fn-10)", () => {
  // fn-10 inverted tier routing: `claude --resume` re-attaches to an existing
  // session whose plugin set is already pinned, so the resume command no
  // longer carries a `--plugin-dir` tier-plugin flag. The tier is still
  // threaded through the signature (board/projection read) but never shapes
  // the argv.
  const cmd = buildResumeCommand("/repo", "fn-1.1", "mint");
  expect(cmd).toBe(
    'cd /repo && claude --resume "fn-1.1" --agentwrap-no-confirm',
  );
  expect(cmd).not.toContain("--plugin-dir");
  expect(cmd).not.toContain("work-plugins");
});

test("buildResumeCommand omits --plugin-dir on an empty tier string", () => {
  const cmd = buildResumeCommand("/repo", "fn-1.1", "");
  expect(cmd).toBe(
    'cd /repo && claude --resume "fn-1.1" --agentwrap-no-confirm',
  );
});

// ---------------------------------------------------------------------------
// buildResumeLaunchForm — the alias-independent, quoting-safe LAUNCH form
// ---------------------------------------------------------------------------

const LAUNCH_PREFIX = ["/abs/bun", "/abs/cli/keeper.ts", "agent"];

test("buildResumeLaunchForm: shell -l -i -c + fixed body + absolute launcher prefix as positionals", () => {
  const argv = buildResumeLaunchForm("/bin/zsh", LAUNCH_PREFIX, "fn-677.1");
  // Login+interactive wrapper.
  expect(argv.slice(0, 4)).toEqual(["/bin/zsh", "-l", "-i", "-c"]);
  // The `-c` body is the FIXED literal — no caller data interpolated, and the
  // command part is NOT exec'd (the trailing `exec "$0"` is the hold-open shell
  // that must survive claude exiting; contrast buildDispatchLaunchArgv).
  expect(argv[4]).toBe(`"$@" ; exec "$0" -l -i`);
  // `$0` slot is the shell repeated so the first prefix token is $1, not eaten.
  expect(argv[5]).toBe("/bin/zsh");
  // Resume tokens ride as positionals: absolute prefix, then the alias-free
  // `claude --resume <target> --agentwrap-no-confirm`.
  expect(argv.slice(6)).toEqual([
    "/abs/bun",
    "/abs/cli/keeper.ts",
    "agent",
    "claude",
    "--resume",
    "fn-677.1",
    "--agentwrap-no-confirm",
  ]);
  // No cd, no --agentwrap-tmux (the launch already runs inside a tmux window).
  expect(argv.join(" ")).not.toContain("cd ");
  expect(argv).not.toContain("--agentwrap-tmux");
});

test("buildResumeLaunchForm: a target with shell metacharacters rides byte-faithful as a positional", () => {
  const nasty = [
    "single ' quote",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the adversarial byte content under test
    "$VAR and ${BRACED}",
    "back`tick`s",
    "$(rm -rf /)",
    "line one\nline two",
    "semis ; and && pipes |",
    "-leading-dash",
  ].join(" :: ");
  const argv = buildResumeLaunchForm("/bin/bash", LAUNCH_PREFIX, nasty);
  // The target is the `--resume` value positional — byte-identical, no quoting,
  // no escaping, no interpolation. The `-c` body never references the target.
  const resumeIdx = argv.indexOf("--resume");
  expect(argv[resumeIdx + 1]).toBe(nasty);
  expect(argv[4]).toBe(`"$@" ; exec "$0" -l -i`);
  expect(argv[4]).not.toContain(nasty);
});

test("buildResumeLaunchForm: bash and zsh emit identical positional mapping", () => {
  // `<shell> -c 'body' a0 a1` assigns $0=a0, $1=a1 in both — the only shell
  // difference is the binary token, so the wake (bash) and restore (zsh)
  // producers share one positional contract.
  const bash = buildResumeLaunchForm("bash", LAUNCH_PREFIX, "t");
  const zsh = buildResumeLaunchForm("zsh", LAUNCH_PREFIX, "t");
  expect(bash.slice(1)).toEqual([
    "-l",
    "-i",
    "-c",
    `"$@" ; exec "$0" -l -i`,
    "bash",
    ...LAUNCH_PREFIX,
    "claude",
    "--resume",
    "t",
    "--agentwrap-no-confirm",
  ]);
  // Same shape, only the two shell-token slots differ.
  expect(zsh[0]).toBe("zsh");
  expect(zsh[5]).toBe("zsh");
  expect(bash.slice(6)).toEqual(zsh.slice(6));
});

test("tierForJobFromEpics resolves the tier for a work job whose epic is in the map", () => {
  const epic = fixtureEpic({
    epic_id: "fn-677-restore-previous-session",
    tasks: [
      fixtureTask({
        task_id: "fn-677-restore-previous-session.1",
        tier: "mint",
      }),
      fixtureTask({
        task_id: "fn-677-restore-previous-session.2",
        tier: "core",
      }),
    ],
  });
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: "fn-677-restore-previous-session.1",
  });
  const map = new Map<string, Epic>([[epic.epic_id, epic]]);
  expect(tierForJobFromEpics(job, map)).toBe("mint");
});

test("tierForJobFromEpics returns null for a non-work job", () => {
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "plan",
    plan_ref: "fn-677-restore-previous-session",
  });
  expect(tierForJobFromEpics(job, new Map())).toBeNull();
});

test("tierForJobFromEpics returns null when plan_ref has no .N task suffix", () => {
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: "fn-677-restore-previous-session",
  });
  expect(tierForJobFromEpics(job, new Map())).toBeNull();
});

test("tierForJobFromEpics returns null when plan_ref is null", () => {
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: null,
  });
  expect(tierForJobFromEpics(job, new Map())).toBeNull();
});

test("tierForJobFromEpics returns null when the epic is not in the map", () => {
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: "fn-677-restore-previous-session.1",
  });
  expect(tierForJobFromEpics(job, new Map<string, Epic>())).toBeNull();
});

test("tierForJobFromEpics returns null when the task isn't in the epic", () => {
  const epic = fixtureEpic({
    epic_id: "fn-677-restore-previous-session",
    tasks: [
      fixtureTask({
        task_id: "fn-677-restore-previous-session.2",
        tier: "core",
      }),
    ],
  });
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: "fn-677-restore-previous-session.1",
  });
  const map = new Map<string, Epic>([[epic.epic_id, epic]]);
  expect(tierForJobFromEpics(job, map)).toBeNull();
});

test("tierForJobFromEpics returns null when the task has no tier", () => {
  const epic = fixtureEpic({
    epic_id: "fn-677-restore-previous-session",
    tasks: [
      fixtureTask({ task_id: "fn-677-restore-previous-session.1", tier: null }),
    ],
  });
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: "fn-677-restore-previous-session.1",
  });
  const map = new Map<string, Epic>([[epic.epic_id, epic]]);
  expect(tierForJobFromEpics(job, map)).toBeNull();
});

test("tierForJobFromEpics returns null on an empty-string tier", () => {
  const epic = fixtureEpic({
    epic_id: "fn-677-restore-previous-session",
    tasks: [
      fixtureTask({ task_id: "fn-677-restore-previous-session.1", tier: "" }),
    ],
  });
  const job = fixtureJob({
    job_id: "sess-1",
    plan_verb: "work",
    plan_ref: "fn-677-restore-previous-session.1",
  });
  const map = new Map<string, Epic>([[epic.epic_id, epic]]);
  expect(tierForJobFromEpics(job, map)).toBeNull();
});

test("resolveRestorePath: KEEPER_RESTORE_FILE wins when set", () => {
  const original = process.env.KEEPER_RESTORE_FILE;
  try {
    process.env.KEEPER_RESTORE_FILE = "/tmp/keeper-restore-test.json";
    expect(resolveRestorePath()).toBe("/tmp/keeper-restore-test.json");
  } finally {
    if (original === undefined) {
      delete process.env.KEEPER_RESTORE_FILE;
    } else {
      process.env.KEEPER_RESTORE_FILE = original;
    }
  }
});

test("resolveRestorePath: default is the DB-sibling restore.json", () => {
  const original = process.env.KEEPER_RESTORE_FILE;
  try {
    delete process.env.KEEPER_RESTORE_FILE;
    expect(resolveRestorePath()).toBe(
      join(homedir(), ".local", "state", "keeper", "restore.json"),
    );
  } finally {
    if (original !== undefined) {
      process.env.KEEPER_RESTORE_FILE = original;
    }
  }
});

test("resolveRestorePath: empty-string env var falls through to the default", () => {
  const original = process.env.KEEPER_RESTORE_FILE;
  try {
    process.env.KEEPER_RESTORE_FILE = "";
    expect(resolveRestorePath()).toBe(
      join(homedir(), ".local", "state", "keeper", "restore.json"),
    );
  } finally {
    if (original === undefined) {
      delete process.env.KEEPER_RESTORE_FILE;
    } else {
      process.env.KEEPER_RESTORE_FILE = original;
    }
  }
});

test("resolveRestorePath does no I/O (does not create the parent dir)", () => {
  // Pure resolver — mirrors the resolveSockPath sibling test.
  const original = process.env.KEEPER_RESTORE_FILE;
  try {
    delete process.env.KEEPER_RESTORE_FILE;
    resolveRestorePath();
  } finally {
    if (original !== undefined) {
      process.env.KEEPER_RESTORE_FILE = original;
    }
  }
});

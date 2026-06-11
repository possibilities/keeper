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

test("resumeTarget returns the title when present", () => {
  const job = fixtureJob({ job_id: "sess-123", title: "fn-677.1 worker" });
  expect(resumeTarget(job)).toBe("fn-677.1 worker");
});

test("resumeTarget falls back to job_id when title is null", () => {
  const job = fixtureJob({ job_id: "sess-123", title: null });
  expect(resumeTarget(job)).toBe("sess-123");
});

test("resumeTarget falls back to job_id on an empty-string title", () => {
  const job = fixtureJob({ job_id: "sess-123", title: "" });
  expect(resumeTarget(job)).toBe("sess-123");
});

test("buildResumeCommand emits cd + claude --resume with a quoted target", () => {
  const cmd = buildResumeCommand("/Users/mike/code/keeper", "fn-677.1", null);
  expect(cmd).toBe(
    'cd /Users/mike/code/keeper && claude --resume "fn-677.1" --arthack-no-confirm',
  );
});

test("buildResumeCommand drops cd prefix on an empty cwd", () => {
  const cmd = buildResumeCommand("", "sess-abc", null);
  expect(cmd).toBe('claude --resume "sess-abc" --arthack-no-confirm');
});

test("buildResumeCommand never inserts --plugin-dir, even for a non-null tier (fn-10)", () => {
  // fn-10 inverted tier routing: `claude --resume` re-attaches to an existing
  // session whose plugin set is already pinned, so the resume command no
  // longer carries a `--plugin-dir` tier-plugin flag. The tier is still
  // threaded through the signature (board/projection read) but never shapes
  // the argv.
  const cmd = buildResumeCommand("/repo", "fn-1.1", "mint");
  expect(cmd).toBe('cd /repo && claude --resume "fn-1.1" --arthack-no-confirm');
  expect(cmd).not.toContain("--plugin-dir");
  expect(cmd).not.toContain("work-plugins");
});

test("buildResumeCommand omits --plugin-dir on an empty tier string", () => {
  const cmd = buildResumeCommand("/repo", "fn-1.1", "");
  expect(cmd).toBe('cd /repo && claude --resume "fn-1.1" --arthack-no-confirm');
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

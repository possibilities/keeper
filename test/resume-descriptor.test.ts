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

test("resumeTarget returns the job_id (the session UUID) for exact resume, ignoring the title", () => {
  // Browser-grade restore keys on the immutable session UUID: `claude --resume
  // <uuid>` re-attaches to the EXACT session, where a name would only fuzzy-filter
  // the /resume picker. The title feeds the display label only, never the key.
  const job = fixtureJob({ job_id: "sess-123", title: "fn-677.1 worker" });
  expect(resumeTarget(job)).toBe("sess-123");
});

test("resumeTarget returns the job_id whether or not the job carries a title", () => {
  // Title presence is irrelevant to the resume key — a never-named job resumes by
  // the same UUID as a named one.
  expect(resumeTarget(fixtureJob({ job_id: "sess-123", title: null }))).toBe(
    "sess-123",
  );
});

test("resumeTarget coerces an empty job_id to the empty string; a title never rescues it", () => {
  // The producer invariant says job_id is always present; a degenerate row with an
  // empty id coerces to "" (never NaN/undefined leaking into argv). A present title
  // does NOT rescue it — a name is not an exact resume key.
  expect(resumeTarget(fixtureJob({ job_id: "", title: null }))).toBe("");
  expect(resumeTarget(fixtureJob({ job_id: "", title: "has-name" }))).toBe("");
});

test("resumeTarget: a codex job resolves to the stored resume_target, not job_id", () => {
  // A non-claude harness resumes via its OWN native id (back-filled into
  // resume_target), never the keeper-minted job_id.
  const job = fixtureJob({
    job_id: "keeper-job-1",
    harness: "codex",
    resume_target: "codex-rollout-uuid",
  });
  expect(resumeTarget(job)).toBe("codex-rollout-uuid");
});

test("resumeTarget: a pi job resolves to its stored session id", () => {
  const job = fixtureJob({
    job_id: "keeper-job-2",
    harness: "pi",
    resume_target: "pi-session-42",
  });
  expect(resumeTarget(job)).toBe("pi-session-42");
});

test("resumeTarget: a non-claude job with no back-filled target is not-resumable (empty)", () => {
  // codex/hermes back-fill resume_target post-stop; before that it is NULL and the
  // agent is not-resumable — resumeTarget returns "" (never the job_id, which is
  // NOT a codex resume key).
  const job = fixtureJob({
    job_id: "keeper-job-3",
    harness: "hermes",
    resume_target: null,
  });
  expect(resumeTarget(job)).toBe("");
});

test("resumeTarget: an explicit claude harness still resolves to job_id", () => {
  const job = fixtureJob({
    job_id: "sess-claude",
    harness: "claude",
    resume_target: null,
  });
  expect(resumeTarget(job)).toBe("sess-claude");
});

test("buildResumeCommand emits cd + claude --resume with a quoted UUID target", () => {
  const uuid = "38c56d06-7378-47e5-a946-0345a26d6201";
  const cmd = buildResumeCommand("/Users/mike/code/keeper", uuid, null);
  expect(cmd).toBe(`cd /Users/mike/code/keeper && claude --resume "${uuid}"`);
});

test("buildResumeCommand drops cd prefix on an empty cwd", () => {
  const cmd = buildResumeCommand("", "sess-abc", null);
  expect(cmd).toBe('claude --resume "sess-abc"');
});

test("buildResumeCommand never inserts --plugin-dir, even for a non-null tier (fn-10)", () => {
  // fn-10 inverted tier routing: `claude --resume` re-attaches to an existing
  // session whose plugin set is already pinned, so the resume command no
  // longer carries a `--plugin-dir` tier-plugin flag. The tier is still
  // threaded through the signature (board/projection read) but never shapes
  // the argv.
  const cmd = buildResumeCommand("/repo", "fn-1.1", "mint");
  expect(cmd).toBe('cd /repo && claude --resume "fn-1.1"');
  expect(cmd).not.toContain("--plugin-dir");
  expect(cmd).not.toContain("work-plugins");
});

test("buildResumeCommand omits --plugin-dir on an empty tier string", () => {
  const cmd = buildResumeCommand("/repo", "fn-1.1", "");
  expect(cmd).toBe('cd /repo && claude --resume "fn-1.1"');
});

test("buildResumeCommand: codex renders the native `codex resume` subcommand form", () => {
  const cmd = buildResumeCommand("/repo", "rollout-uuid", null, "codex");
  expect(cmd).toBe('cd /repo && codex resume "rollout-uuid"');
});

test("buildResumeCommand: pi renders `pi --session`", () => {
  expect(buildResumeCommand("/repo", "pi-42", null, "pi")).toBe(
    'cd /repo && pi --session "pi-42"',
  );
});

test("buildResumeCommand: hermes renders `hermes --resume`", () => {
  expect(buildResumeCommand("", "hx-9", null, "hermes")).toBe(
    'hermes --resume "hx-9"',
  );
});

test("buildResumeCommand: a NULL/absent harness defaults to the claude form", () => {
  // ABSENT ⇒ claude — a legacy candidate (no harness tag) renders byte-identically.
  expect(buildResumeCommand("/repo", "u", null)).toBe(
    'cd /repo && claude --resume "u"',
  );
  expect(buildResumeCommand("/repo", "u", null, null)).toBe(
    'cd /repo && claude --resume "u"',
  );
});

test("buildResumeCommand: the claude arm carries no --x- launcher-alias flag", () => {
  // A human pastes this into whatever shell they have open — no `claude →
  // keeper agent claude` alias guaranteed. A `--x-*` flag here would reach the
  // real claude binary verbatim and be rejected as an unknown option.
  const cmd = buildResumeCommand("/repo", "sess-1", null);
  expect(cmd).not.toMatch(/--x-/);
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

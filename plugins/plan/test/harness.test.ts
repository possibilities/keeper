// Self-tests for test/harness.ts — the harness's own proof. The keystone is
// seedState byte-fidelity (the conftest test_seed_state port): a divergent
// on-disk layout would silently invalidate every translated test, so these tests
// (1) check the skeleton/meta/gitignore bytes match the init contract, (2)
// round-trip every seeded record through the SAME normalize seam the read path
// runs (zero schema drift), and (3) prove the COMPILED binary reads a seeded
// tree back faithfully — the end-to-end byte contract. The env builder, clock
// pin, payload extractors, and git helpers carry their own focused coverage.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { normalizeEpic, normalizeTask, SCHEMA_VERSION } from "../src/models.ts";
import {
  buildEnv,
  FROZEN_CLOCK,
  firstJsonPayload,
  fixedClock,
  gitFilesInHead,
  gitHeadMessage,
  gitInit,
  gitLogCount,
  parseCliOutput,
  runCli,
  seedState,
  setRoots,
  taskSpec,
  withProject,
  withTmpdir,
} from "./harness.ts";

// JSON read-back through the same parse the binary uses (JSON.parse over the
// serialized bytes), so a drift between seed bytes and normalize surfaces here.
function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

// ===========================================================================
// seedState — the keystone fidelity contract (port of test_seed_state.py).
// ===========================================================================

describe("seedState skeleton + meta.json + inner gitignore", () => {
  const getTmp = withTmpdir("planctl-seed-skel-");

  test("skeleton dirs + meta.json + inner gitignore match the init contract", () => {
    const root = getTmp();
    seedState(root, { epicId: "fn-1-seed" });
    const planctlDir = join(root, ".keeper");
    for (const subdir of ["epics", "specs", "tasks", "state"]) {
      expect(statSync(join(planctlDir, subdir)).isDirectory()).toBe(true);
    }
    // meta.json bytes: serializeStateJson({schema_version}) — the init layout.
    expect(loadJson(join(planctlDir, "meta.json"))).toEqual({
      schema_version: SCHEMA_VERSION,
    });
    expect(readFileSync(join(planctlDir, "meta.json"), "utf-8")).toBe(
      `{\n  "schema_version": ${SCHEMA_VERSION}\n}\n`,
    );
    // Inner gitignore is exactly "state/\n".
    expect(readFileSync(join(planctlDir, ".gitignore"), "utf-8")).toBe(
      "state/\n",
    );
  });
});

describe("seedState round-trip zero drift", () => {
  const getTmp = withTmpdir("planctl-seed-rt-");

  test("seeded records equal what normalize* produces (idempotent)", () => {
    const root = getTmp();
    const [epicId, taskIds] = seedState(root, {
      epicId: "fn-2-seed",
      nTasks: 2,
      epicSnippets: ["snippet/a"],
      taskSnippets: { 1: ["snippet/b"] },
      taskDeps: { 2: [1] },
    });
    const planctlDir = join(root, ".keeper");

    // Epic: re-normalizing an already-normalized on-disk record is a no-op, so
    // any field the persisted JSON is missing surfaces as an inequality.
    const epicOnDisk = loadJson(join(planctlDir, "epics", `${epicId}.json`));
    expect(epicOnDisk).toStrictEqual(normalizeEpic({ ...epicOnDisk }));
    expect(epicOnDisk.id).toBe(epicId);
    expect(epicOnDisk.snippets).toEqual(["snippet/a"]);

    // Tasks: same idempotence per task.
    for (const taskId of taskIds) {
      const taskOnDisk = loadJson(join(planctlDir, "tasks", `${taskId}.json`));
      expect(taskOnDisk).toStrictEqual(normalizeTask({ ...taskOnDisk }));
      expect(taskOnDisk.id).toBe(taskId);
      expect(taskOnDisk.epic).toBe(epicId);
    }
    // Dep encoding survived.
    const taskTwo = loadJson(join(planctlDir, "tasks", `${epicId}.2.json`));
    expect(taskTwo.depends_on).toEqual([`${epicId}.1`]);
  });

  test("each task spec carries the four headings; epic spec persists", () => {
    const root = getTmp();
    const [epicId, taskIds] = seedState(root, {
      epicId: "fn-3-seed",
      nTasks: 1,
    });
    const specsDir = join(root, ".keeper", "specs");
    expect(readFileSync(join(specsDir, `${epicId}.md`), "utf-8")).toContain(
      "## Overview",
    );
    const spec = readFileSync(join(specsDir, `${taskIds[0]}.md`), "utf-8");
    for (const heading of [
      "## Description",
      "## Acceptance",
      "## Done summary",
      "## Evidence",
    ]) {
      expect(spec).toContain(heading);
    }
  });

  test("seedState mints no .git side effect", () => {
    const root = getTmp();
    seedState(root, { epicId: "fn-4-seed" });
    // No init happened — withTmpdir does not init, seedState must not either.
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});

describe("seedState on-disk bytes match what the binary reads (end-to-end)", () => {
  const getTmp = withTmpdir("planctl-seed-bin-");

  test("the compiled binary reads a seeded tree's epic + task counts", () => {
    const root = getTmp();
    // The binary needs a .git/ for repo detection; seedState is git-free, so add
    // a real init around it (the translated tests pair seedState with a repo).
    gitInit(root);
    const [epicId] = seedState(root, { epicId: "fn-9-seed", nTasks: 3 });

    const res = runCli(["epics", "--format", "json"], { cwd: root });
    expect(res.code).toBe(0);
    const payload = parseCliOutput(res.output) as {
      success: boolean;
      epics: { id: string; status: string; task_summary: { total: number } }[];
    };
    expect(payload.success).toBe(true);
    const epic = payload.epics.find((e) => e.id === epicId);
    expect(epic).toBeDefined();
    expect(epic?.status).toBe("open");
    expect(epic?.task_summary.total).toBe(3);
  });

  test("the binary surfaces a seeded task spec via cat", () => {
    const root = getTmp();
    gitInit(root);
    const [epicId, taskIds] = seedState(root, {
      epicId: "fn-10-seed",
      nTasks: 1,
    });
    const taskId = taskIds[0];
    expect(taskId).toBeDefined();
    const res = runCli(["cat", taskId as string], { cwd: root });
    expect(res.code).toBe(0);
    // cat is format-free raw markdown — the seeded four-section spec.
    expect(res.stdout).toContain("## Description");
    expect(res.stdout).toContain("seed-1");
    expect(epicId).toBe("fn-10-seed");
  });
});

// ===========================================================================
// buildEnv — the built-from-scratch minimal env (no shell leak).
// ===========================================================================

describe("buildEnv", () => {
  const getTmp = withTmpdir("planctl-env-");

  test("carries exactly the conftest key set, no developer-shell leak", () => {
    const home = getTmp();
    // Set a sentinel env var the builder must NOT forward (proves scratch-built).
    const SENTINEL = "PLANCTL_HARNESS_SENTINEL_SHOULD_NOT_LEAK";
    process.env[SENTINEL] = "leaked";
    try {
      const env = buildEnv(home);
      expect(env.HOME).toBe(home);
      expect(env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
      expect(env.XDG_STATE_HOME).toBe(join(home, ".local", "state"));
      expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(home, "gitconfig"));
      expect(env.KEEPER_PLAN_ACTOR.length).toBeGreaterThan(0);
      // A session id is always present — mutating verbs require it.
      expect(env.CLAUDE_CODE_SESSION_ID.length).toBeGreaterThan(0);
      // No leak of an arbitrary parent-env var.
      expect(SENTINEL in env).toBe(false);
    } finally {
      delete process.env[SENTINEL];
    }
  });

  test("session id: forwards a parent value, defaults when the parent has none", () => {
    const home = getTmp();
    const priorSid = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      process.env.CLAUDE_CODE_SESSION_ID = "parent-sid-xyz";
      expect(buildEnv(home).CLAUDE_CODE_SESSION_ID).toBe("parent-sid-xyz");
      delete process.env.CLAUDE_CODE_SESSION_ID;
      expect(buildEnv(home).CLAUDE_CODE_SESSION_ID).toBe(
        "test-session-fixture",
      );
    } finally {
      if (priorSid === undefined) {
        delete process.env.CLAUDE_CODE_SESSION_ID;
      } else {
        process.env.CLAUDE_CODE_SESSION_ID = priorSid;
      }
    }
  });

  test("the written global gitconfig carries the test identity + gpgsign off", () => {
    const home = getTmp();
    buildEnv(home);
    const cfg = readFileSync(join(home, "gitconfig"), "utf-8");
    expect(cfg).toContain("email = test@example.com");
    expect(cfg).toContain("gpgsign = false");
    expect(cfg).toContain("hooksPath = /dev/null");
  });

  test("per-call override is layered last", () => {
    const home = getTmp();
    const env = buildEnv(home, { KEEPER_PLAN_ACTOR: "override@example.com" });
    expect(env.KEEPER_PLAN_ACTOR).toBe("override@example.com");
  });
});

// ===========================================================================
// fixedClock — KEEPER_PLAN_NOW pin, drives both seedState stamps and the subprocess.
// ===========================================================================

describe("fixedClock pins seed timestamps", () => {
  const getTmp = withTmpdir("planctl-clock-");
  const frozen = fixedClock();

  test("FROZEN_CLOCK is the conftest value and freezes seed stamps", () => {
    expect(frozen).toBe(FROZEN_CLOCK);
    expect(frozen).toBe("2026-06-06T00:00:00.000000Z");
    const root = getTmp();
    const [epicId, taskIds] = seedState(root, { epicId: "fn-5-seed" });
    const epic = loadJson(join(root, ".keeper", "epics", `${epicId}.json`));
    expect(epic.created_at).toBe(frozen);
    expect(epic.updated_at).toBe(frozen);
    const task = loadJson(join(root, ".keeper", "tasks", `${taskIds[0]}.json`));
    expect(task.created_at).toBe(frozen);
  });
});

// ===========================================================================
// Payload extractors — first-line (mutating) + multi-line (read) shapes.
// ===========================================================================

describe("payload extractors", () => {
  test("firstJsonPayload returns the first JSON object, skips invocation line", () => {
    const out =
      'some stderr noise\n{"success": true, "id": "fn-1-x"}\n' +
      '{"plan_invocation": {"op": "done"}}\n';
    expect(firstJsonPayload(out)).toEqual({ success: true, id: "fn-1-x" });
  });

  test("parseCliOutput joins multi-line pretty JSON, drops the trailer", () => {
    const out =
      '{\n  "success": true,\n  "epics": []\n}\n' +
      '{"plan_invocation": {"op": "epics"}}\n';
    expect(parseCliOutput(out)).toEqual({ success: true, epics: [] });
  });

  test("parseCliOutput drops leading non-JSON noise before pretty JSON", () => {
    const out = 'warning: something\n{\n  "ok": 1\n}\n';
    expect(parseCliOutput(out)).toEqual({ ok: 1 });
  });

  test("firstJsonPayload throws on no JSON line", () => {
    expect(() => firstJsonPayload("not json at all\n")).toThrow();
  });
});

// ===========================================================================
// setRoots — writes the roots config the binary reads under HOME.
// ===========================================================================

describe("setRoots", () => {
  const getTmp = withTmpdir("planctl-roots-");

  test("writes <home>/.config/planctl/config.yaml with the roots block", () => {
    const home = getTmp();
    setRoots(home, ["/code/a", "/code/b"]);
    const cfg = readFileSync(
      join(home, ".config", "planctl", "config.yaml"),
      "utf-8",
    );
    expect(cfg).toBe("roots:\n  - /code/a\n  - /code/b\n");
  });
});

// ===========================================================================
// Git helpers + withProject — real-repo assertion surface.
// ===========================================================================

describe("git assertion helpers + withProject", () => {
  const getProject = withProject("planctl-harness-proj-");

  test("withProject yields a git repo + init project; init self-commits once", () => {
    const { root } = getProject();
    // planctl init self-commits its bootstrap files inline.
    expect(gitLogCount(root)).toBeGreaterThanOrEqual(1);
    expect(gitHeadMessage(root)).toContain("chore(plan): init");
    const files = gitFilesInHead(root);
    expect(files.some((f) => f.startsWith(".keeper/"))).toBe(true);
  });

  test("withProject HOME is dedicated and a verb runs green against it", () => {
    const { root, home } = getProject();
    const res = runCli(["status", "--format", "json"], { cwd: root, home });
    expect(res.code).toBe(0);
    const payload = parseCliOutput(res.output) as { success: boolean };
    expect(payload.success).toBe(true);
  });
});

// taskSpec is exercised indirectly via seedState specs above; pin its shape too.
describe("taskSpec", () => {
  test("carries the four headings and the marker", () => {
    const s = taskSpec("mymarker");
    expect(s).toContain("## Description\nmymarker");
    expect(s).toContain("## Acceptance");
    expect(s).toContain("## Done summary");
    expect(s).toContain("## Evidence");
  });
});

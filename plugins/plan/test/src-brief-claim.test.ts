// Unit tests for src/brief.ts (assemble + byte-parity write), the
// workerAgentForTier / isTaskId / epicIdFromTask gate helpers, and end-to-end
// claim/block proofs against the compiled binary: ZERO commits, runtime field
// sets byte-equal to the frozen serialization on disk, and the brief_ref handle.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleBrief,
  BRIEF_SCHEMA_VERSION,
  writeBrief,
} from "../src/brief.ts";
import { epicIdFromTask, isTaskId } from "../src/ids.ts";
import {
  normalizeEpic,
  normalizeTask,
  workerAgentForTier,
} from "../src/models.ts";
import { serializeStateJson } from "../src/store.ts";

const BIN = join(import.meta.dir, "..", "dist", "planctl-bun");
if (!existsSync(BIN)) {
  throw new Error(
    `compiled binary missing at ${BIN}; run \`bun run build\` before \`bun test\``,
  );
}

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("gate helpers", () => {
  test("isTaskId: task ids true, epic / garbage false", () => {
    expect(isTaskId("fn-1-add-auth.3")).toBe(true);
    expect(isTaskId("fn-12-x.10")).toBe(true);
    expect(isTaskId("fn-1-add-auth")).toBe(false); // epic id
    expect(isTaskId("not-a-task")).toBe(false);
  });

  test("epicIdFromTask strips the final segment; throws on a non-task", () => {
    expect(epicIdFromTask("fn-1-add-auth.3")).toBe("fn-1-add-auth");
    expect(epicIdFromTask("fn-30-bun.12")).toBe("fn-30-bun");
    expect(() => epicIdFromTask("fn-1-add-auth")).toThrow();
  });

  test("workerAgentForTier: member -> agent, null -> null, bad -> throw", () => {
    expect(workerAgentForTier("medium")).toBe("plan:worker-medium");
    expect(workerAgentForTier("xhigh")).toBe("plan:worker-xhigh");
    expect(workerAgentForTier(null)).toBeNull();
    expect(() => workerAgentForTier("turbo")).toThrow();
  });
});

describe("brief assemble + write", () => {
  test("assembleBrief carries the stable key set incl. empty snippet_context", () => {
    const dataDir = tmp("planctl-brief-");
    try {
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/repo",
        primaryRepo: "/repo",
        stateRepo: "/repo",
        tier: "high",
        dataDir,
      });
      expect(brief.schema_version).toBe(BRIEF_SCHEMA_VERSION);
      expect(brief.task_id).toBe("fn-1-x.1");
      expect(brief.epic_id).toBe("fn-1-x");
      expect(brief.tier).toBe("high");
      expect(brief.snippet_context).toBe(""); // present, not omitted
      // Missing specs -> empty markdown, never a throw.
      expect(brief.task_spec_md).toBe("");
      expect(brief.epic_spec_md).toBe("");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("assembleBrief reads spec markdown when present", () => {
    const dataDir = tmp("planctl-brief2-");
    try {
      mkdirSync(join(dataDir, "specs"), { recursive: true });
      writeFileSync(join(dataDir, "specs", "fn-1-x.1.md"), "## Task\nbody\n");
      writeFileSync(join(dataDir, "specs", "fn-1-x.md"), "## Epic\nover\n");
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/r",
        primaryRepo: "/r",
        stateRepo: "/r",
        tier: null,
        dataDir,
      });
      expect(brief.task_spec_md).toBe("## Task\nbody\n");
      expect(brief.epic_spec_md).toBe("## Epic\nover\n");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("writeBrief output is byte-identical to the frozen serialization", () => {
    const briefsDir = tmp("planctl-briefw-");
    try {
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/r",
        primaryRepo: "/r",
        stateRepo: "/r",
        tier: "max",
        dataDir: briefsDir,
      });
      const ref = writeBrief(briefsDir, "fn-1-x.1", brief);
      expect(ref).toBe(realpathSync(join(briefsDir, "fn-1-x.1.json")));
      expect(readFileSync(ref, "utf-8")).toBe(serializeStateJson(brief));
    } finally {
      rmSync(briefsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: claim/block against the compiled binary in a real git repo.
// ZERO commits + runtime field sets byte-equal on disk.
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Seed a minimal git-backed planctl project directly in TS (mirrors
 * seed_state's on-disk key set via the shared normalize defaults), then commit a
 * clean git baseline so any later dirty state is the verb's. One todo task,
 * tier=medium. Returns the repo root (realpath-resolved). */
function seedGitProject(epicId: string): string {
  const repo = tmp("planctl-e2e-");
  const planctl = join(repo, ".keeper");
  for (const sub of ["epics", "specs", "tasks", "state"]) {
    mkdirSync(join(planctl, sub), { recursive: true });
  }
  writeFileSync(
    join(planctl, "meta.json"),
    serializeStateJson({ schema_version: 1 }),
  );
  writeFileSync(join(planctl, ".gitignore"), "state/\n");

  const now = "2026-01-01T00:00:00.000000Z";
  const epicDef = normalizeEpic({
    id: epicId,
    title: "Seed epic",
    status: "open",
    primary_repo: null,
    snippets: [],
    bundles: [],
    created_at: now,
    updated_at: now,
  });
  writeFileSync(
    join(planctl, "epics", `${epicId}.json`),
    serializeStateJson(epicDef),
  );
  writeFileSync(join(planctl, "specs", `${epicId}.md`), "## Overview\nseed\n");

  const taskId = `${epicId}.1`;
  const taskDef = normalizeTask({
    id: taskId,
    epic: epicId,
    title: "Task 1",
    depends_on: [],
    tier: "medium",
    target_repo: null,
    snippets: [],
    bundles: [],
    created_at: now,
    updated_at: now,
  });
  writeFileSync(
    join(planctl, "tasks", `${taskId}.json`),
    serializeStateJson(taskDef),
  );
  writeFileSync(
    join(planctl, "specs", `${taskId}.md`),
    "## Description\nseed\n",
  );

  for (const args of [
    ["init"],
    ["add", ".keeper/"],
    ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "seed"],
  ]) {
    const g = Bun.spawnSync(["git", ...args], { cwd: repo });
    if (g.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${g.stderr.toString()}`);
    }
  }
  return repo;
}

function commitCount(repo: string): number {
  const g = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
    cwd: repo,
  });
  return Number.parseInt(g.stdout.toString().trim(), 10);
}

function runBin(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): RunResult {
  const proc = Bun.spawnSync([BIN, ...args], {
    cwd,
    env: {
      HOME: join(cwd, ".home"),
      PATH: process.env.PATH ?? "",
      PLANCTL_ACTOR: "test@example.com",
      CLAUDE_CODE_SESSION_ID: "e2e-session",
      ...env,
    },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function runtimeOnDisk(repo: string, taskId: string): string {
  return readFileSync(
    join(repo, ".keeper", "state", "tasks", `${taskId}.state.json`),
    "utf-8",
  );
}

describe("claim/block end-to-end (compiled binary, real git)", () => {
  test("claim produces ZERO commits and a byte-equal runtime sidecar", () => {
    const repo = seedGitProject("fn-1-claim");
    try {
      const before = commitCount(repo);
      const r = runBin(["claim", "fn-1-claim.1", "--project", repo], repo, {});
      expect(r.code).toBe(0);
      const payload = JSON.parse(r.stdout.trim());
      expect(payload.success).toBe(true);
      expect(payload.task_state.outcome).toBe("CLAIMED");
      expect(payload.brief_ref).toBe(
        join(repo, ".keeper", "state", "briefs", "fn-1-claim.1.json"),
      );
      // Zero commits — claim mutates only gitignored state/.
      expect(commitCount(repo)).toBe(before);

      // Runtime sidecar is byte-identical to the frozen serialization of the same
      // field set (the claimed_at value is dynamic, so re-serialize the parsed
      // dict rather than pinning a literal).
      const onDisk = runtimeOnDisk(repo, "fn-1-claim.1");
      const parsed = JSON.parse(onDisk);
      expect(parsed.status).toBe("in_progress");
      expect(parsed.assignee).toBe("test@example.com");
      expect(parsed.blocked_reason).toBeNull();
      expect(onDisk).toBe(serializeStateJson(parsed));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("block produces ZERO commits and writes blocked + reason byte-equal", () => {
    const repo = seedGitProject("fn-1-block");
    try {
      // Pre-claim so there is an in_progress runtime to block.
      runBin(["claim", "fn-1-block.1", "--project", repo], repo, {});
      const before = commitCount(repo);
      // block resolves cwd-based (no --project), so run from the repo root.
      const r = runBin(
        ["block", "fn-1-block.1", "--reason", "waiting"],
        repo,
        {},
      );
      expect(r.code).toBe(0);
      const payload = JSON.parse(r.stdout.trim());
      expect(payload.status).toBe("blocked");
      expect(payload.blocked_reason).toBe("waiting");
      expect(commitCount(repo)).toBe(before);

      const onDisk = runtimeOnDisk(repo, "fn-1-block.1");
      const parsed = JSON.parse(onDisk);
      expect(parsed.status).toBe("blocked");
      expect(parsed.blocked_reason).toBe("waiting");
      expect(onDisk).toBe(serializeStateJson(parsed));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

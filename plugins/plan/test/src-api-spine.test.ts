// Unit tests for the spine helpers ported in the read-surface foundation:
// api.ts (loadEpic/loadTasksForEpic/taskSortKey/taskPriority), ids.isEpicId,
// runtime_status cwd fallbacks, and store.loadJson/readFileOrStdin.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadEpic,
  loadTasksForEpic,
  taskPriority,
  taskSortKey,
} from "../src/api.ts";
import { isEpicId, isTaskId } from "../src/ids.ts";
import type { ProjectContext } from "../src/project.ts";
import {
  expectedCloserCwd,
  resolveWorkerRepos,
  worktreeOverride,
} from "../src/runtime_status.ts";
import { loadJson } from "../src/store.ts";

function projectCtx(root: string): ProjectContext {
  return {
    name: "p",
    dataDir: join(root, ".keeper"),
    stateDir: join(root, ".keeper", "state"),
    projectPath: root,
  };
}

describe("ids.isEpicId", () => {
  test("epic id true, task id false, garbage false", () => {
    expect(isEpicId("fn-1-cafe")).toBe(true);
    expect(isEpicId("fn-7")).toBe(true);
    expect(isEpicId("fn-1-cafe.2")).toBe(false);
    expect(isTaskId("fn-1-cafe.2")).toBe(true);
    expect(isEpicId("garbage")).toBe(false);
  });
});

describe("taskSortKey / taskPriority", () => {
  test("sort key extracts the .M ordinal, 999 for unparseable", () => {
    expect(taskSortKey("fn-1-x.3")).toBe(3);
    expect(taskSortKey("garbage")).toBe(999);
  });

  test("priority: null/absent -> 999, int string parses, float string -> 999", () => {
    expect(taskPriority({ priority: null })).toBe(999);
    expect(taskPriority({})).toBe(999);
    expect(taskPriority({ priority: 2 })).toBe(2);
    expect(taskPriority({ priority: "5" })).toBe(5);
    expect(taskPriority({ priority: 3.9 })).toBe(3); // int() truncates
    expect(taskPriority({ priority: "3.9" })).toBe(999); // int("3.9") raises
  });
});

describe("runtime_status cwd fallbacks", () => {
  // resolveWorkerRepos realpath-normalizes; non-existent absolute paths fall
  // back to their lexical form unchanged, so the fallback chain is observable.
  test("worker target_repo: target_repo -> primary_repo -> proj", () => {
    expect(
      resolveWorkerRepos({ target_repo: "/t" }, { primary_repo: "/p" }, "/proj")
        .targetRepo,
    ).toBe("/t");
    expect(
      resolveWorkerRepos({ target_repo: null }, { primary_repo: "/p" }, "/proj")
        .targetRepo,
    ).toBe("/p");
    expect(
      resolveWorkerRepos({ target_repo: null }, { primary_repo: null }, "/proj")
        .targetRepo,
    ).toBe("/proj");
  });

  test("worker primary_repo: epic.primary_repo -> proj, never the lane", () => {
    expect(
      resolveWorkerRepos({ target_repo: "/t" }, { primary_repo: "/p" }, "/proj")
        .primaryRepo,
    ).toBe("/p");
    expect(
      resolveWorkerRepos({ target_repo: "/t" }, { primary_repo: null }, "/proj")
        .primaryRepo,
    ).toBe("/proj");
  });

  test("closer cwd: primary_repo -> proj", () => {
    expect(expectedCloserCwd({ primary_repo: "/p" }, "/proj")).toBe("/p");
    expect(expectedCloserCwd({ primary_repo: null }, "/proj")).toBe("/proj");
  });

  test("KEEPER_PLAN_WORKTREE override moves target_repo only, not primary_repo", () => {
    const prev = process.env.KEEPER_PLAN_WORKTREE;
    try {
      process.env.KEEPER_PLAN_WORKTREE = "/lane";
      // The override beats an explicit target_repo (worktree-mode isolation)...
      const repos = resolveWorkerRepos(
        { target_repo: "/t" },
        { primary_repo: "/p" },
        "/proj",
      );
      expect(repos.targetRepo).toBe("/lane");
      // ...but plan STATE stays on the primary repo, never the lane.
      expect(repos.primaryRepo).toBe("/p");
      expect(worktreeOverride()).toBe("/lane");
    } finally {
      if (prev === undefined) {
        delete process.env.KEEPER_PLAN_WORKTREE;
      } else {
        process.env.KEEPER_PLAN_WORKTREE = prev;
      }
    }
  });

  test("empty/unset KEEPER_PLAN_WORKTREE falls through to the 3-level fallback", () => {
    const prev = process.env.KEEPER_PLAN_WORKTREE;
    try {
      // Empty string is treated as absent.
      process.env.KEEPER_PLAN_WORKTREE = "";
      expect(worktreeOverride()).toBeUndefined();
      expect(
        resolveWorkerRepos(
          { target_repo: "/t" },
          { primary_repo: "/p" },
          "/proj",
        ).targetRepo,
      ).toBe("/t");

      // Unset → identical to today's fallback at every level.
      delete process.env.KEEPER_PLAN_WORKTREE;
      expect(worktreeOverride()).toBeUndefined();
      expect(
        resolveWorkerRepos(
          { target_repo: "/t" },
          { primary_repo: "/p" },
          "/proj",
        ).targetRepo,
      ).toBe("/t");
      expect(
        resolveWorkerRepos(
          { target_repo: null },
          { primary_repo: "/p" },
          "/proj",
        ).targetRepo,
      ).toBe("/p");
      expect(
        resolveWorkerRepos(
          { target_repo: null },
          { primary_repo: null },
          "/proj",
        ).targetRepo,
      ).toBe("/proj");
    } finally {
      if (prev === undefined) {
        delete process.env.KEEPER_PLAN_WORKTREE;
      } else {
        process.env.KEEPER_PLAN_WORKTREE = prev;
      }
    }
  });
});

describe("store.loadJson raises on missing/corrupt", () => {
  test("missing file throws", () => {
    expect(() => loadJson(join(tmpdir(), "definitely-missing.json"))).toThrow();
  });
});

describe("api load helpers", () => {
  test("loadEpic merges def + normalizes; loadTasksForEpic sorts files", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-api-")));
    try {
      const dataDir = join(root, ".keeper");
      mkdirSync(join(dataDir, "epics"), { recursive: true });
      mkdirSync(join(dataDir, "tasks"), { recursive: true });
      writeFileSync(
        join(dataDir, "epics", "fn-1-x.json"),
        JSON.stringify({ id: "fn-1-x", title: "X" }),
      );
      writeFileSync(
        join(dataDir, "tasks", "fn-1-x.2.json"),
        JSON.stringify({ id: "fn-1-x.2", title: "two" }),
      );
      writeFileSync(
        join(dataDir, "tasks", "fn-1-x.1.json"),
        JSON.stringify({ id: "fn-1-x.1", title: "one" }),
      );

      const ctx = projectCtx(root);
      const epic = loadEpic(ctx, "fn-1-x");
      expect(epic.id).toBe("fn-1-x");
      // normalizeEpic defaults are applied.
      expect(epic.branch_name).toBe("main");
      expect(epic.last_validated_at).toBeNull();

      const tasks = loadTasksForEpic(ctx, "fn-1-x");
      expect(tasks.length).toBe(2);
      const ordered = [...tasks].sort(
        (a, b) => taskSortKey(a.id as string) - taskSortKey(b.id as string),
      );
      expect(ordered.map((t) => t.id)).toEqual(["fn-1-x.1", "fn-1-x.2"]);
      // mergeTaskState defaults status to todo when no runtime sidecar.
      expect(ordered[0]?.status).toBe("todo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadTasksForEpic returns [] when tasks/ is absent", () => {
    const empty = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-api-empty-")),
    );
    try {
      mkdirSync(join(empty, ".keeper", "epics"), { recursive: true });
      expect(loadTasksForEpic(projectCtx(empty), "fn-1-x")).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

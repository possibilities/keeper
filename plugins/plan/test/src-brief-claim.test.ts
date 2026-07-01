// Unit tests for src/brief.ts (assemble + byte-parity write) and the
// workerAgentFor / isTaskId / epicIdFromTask gate helpers — all in-process.
// The claim/block ZERO-commit guarantee + byte-equal runtime sidecar are owned
// in-process by verbs-worker.test.ts (fake-VCS gitLogCount delta + runtime
// read-back); the brief_ref handle is owned by saga-claim.test.ts.

import { describe, expect, test } from "bun:test";
import {
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
import { workerAgentFor } from "../src/models.ts";
import { serializeStateJson } from "../src/store.ts";

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

  test("workerAgentFor: {tier,model} member -> agent, either null -> null, bad -> throw", () => {
    expect(workerAgentFor("medium", "opus")).toBe("plan:worker-opus-medium");
    expect(workerAgentFor("xhigh", "opus")).toBe("plan:worker-opus-xhigh");
    expect(workerAgentFor(null, "opus")).toBeNull();
    expect(workerAgentFor("medium", null)).toBeNull();
    expect(workerAgentFor(null, null)).toBeNull();
    expect(() => workerAgentFor("turbo", "opus")).toThrow();
    expect(() => workerAgentFor("medium", "gpt")).toThrow();
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
